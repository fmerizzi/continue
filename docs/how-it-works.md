# How it works

A deeper look at the internals of the `continue` plugin.

## Event flow

The plugin subscribes to the OpenCode 2 event stream:

```
session.execution.succeeded ──► the main loop: maybe send a continuation prompt
session.idle ─────────────────► same handler (accepted as a fallback)
session.execution.failed ─────► log the terminal error, no retry
session.execution.interrupted ► log the reason, no retry
session.deleted ──────────────► drop the session's state
```

There is no `chat.params` hook. The agent is read from the session itself when
the completion event arrives.

### Terminal failures

`session.execution.failed` carries a structured error (`type`, `message`,
optional `status` and `response.body`). The plugin logs it and stops; it does
not retry provider errors. `session.execution.interrupted` carries the reason
(`user`, `inactivity`, `shutdown`, `superseded`); those are logged but never
turned into a new prompt. OpenCode already retries transient stream errors
before a turn is reported as failed.

### Agent gate

On a completion event, the plugin reads the session:

```ts
const session = await ctx.session.get({ sessionID })
```

It then reads the stored conversation:

```ts
const messages = await ctx.session.context({ sessionID })
```

The effective agent is `session.agent`, falling back to the `agent` field on the
last assistant message. If it isn't `SCOPED_AGENT`, the plugin returns
immediately. This means switching away from the solver stops the loop at the
next completion event.

Global plugins are instantiated once per location. The plugin also compares the
session's `projectID` with `ctx.location.project.id` so only the instance for
the session's project acts; otherwise two instances would send two prompts.

### Completion handler

The heart of the plugin. When a turn finishes, the plugin walks a series of
gates in order:

1. **Stacking gate** — `s.running` → ignore. A continuation is already in flight.
2. **Cap gate** — `s.iterations >= MAX` → ignore. Hard stop.
3. **Session read** — pull the session; bail if the read fails.
4. **Project gate** — only the plugin instance for the session's project acts.
5. **Outcome gate** — if the trailing idle message reports `failed` or
   `interrupted`, never re-prompt.
6. **Current turn** — find the last `user` message and only look for an
   `assistant` message *after* it. A previous assistant reply must not mask a
   no-reply turn.
7. **Agent gate** — effective agent isn't `solver` → ignore. Only the configured
   agent is ever driven.
8. **No assistant** — if the turn produced no assistant message, send the
   recovery prompt. De-dup by the last user message ID.
9. **Error gate** — if the assistant has an `error` or `finish === "error"`,
   never re-prompt. Fighting an error just loops it.
10. **De-dup gate** — if this assistant message ID was already handled, ignore.
11. **Marker check** — if the reply's last non-empty line is `JOB COMPLETED`, log
    and reset the counter. Done.
12. **Meaningful content** — if the assistant has no non-empty text, reasoning,
    or tool part, use the recovery prompt. Otherwise use the normal continue
    prompt.
13. **Continue** — wait `COOLDOWN_MS`, then send the prompt with
    `ctx.session.prompt({ sessionID, text })`.

Because `session.prompt` does not take an agent, the session keeps the agent it
already has. The agent gate guarantees that is `solver`.

### `session.deleted`

Drops the session's state so the map doesn't grow unbounded.

## Per-session state

```ts
{
  iterations: number      // continuations sent this run (reset on done)
  running: boolean        // a continuation prompt is in flight
  seen: Set<string>       // assistant IDs and no-reply user IDs already handled
}
```

State lives in a `Map<sessionID, …>` inside the plugin closure — no files, no
external storage.

## Marker semantics

`isDone()` splits the reply on newlines, trims each line, drops empties, and
checks whether the **last** remaining line exactly equals `MARKER`.

```
"…all tests pass.\nJOB COMPLETED"      → done
"…JOB COMPLETED, moving on to tests"   → NOT done
"JOB COMPLETED"                        → done
```

Requiring the marker as the final line means the model has to commit to it — a
passing mention mid-sentence can't end the run.

## Why each gate exists

| Gate | Failure mode it prevents |
| --- | --- |
| Agent gate | Driving sessions you didn't intend (e.g. a casual chat) |
| Stacking gate | Two idle events racing → two prompts → context bloat |
| Cap gate | A model that never emits the marker burning tokens forever |
| Outcome/error gate | Re-prompting an aborted/errored turn into a loop |
| Empty-reply recovery | A completed turn that produced no usable output going silent |
| De-dup gate | The same turn triggering multiple continuations |
| Cooldown | Hammering the API the instant idle fires |

## TUI status

The TUI half lives in `plugin/tui.tsx` and is a separate `@opencode/plugin/tui`
entrypoint. It never talks to the server plugin directly; it derives everything
from the session data available to the TUI:

- **Agent gate** — `session.agent`, falling back to the assistant after the last
  user message. Anything other than `solver` renders nothing.
- **Count** — user messages whose text starts with
  `Continue where you left off.`, counted after the most recent real user
  message. That is the same prompt the server plugin sends.
- **Done** — the assistant after the last user message ends with
  `JOB COMPLETED`. A previous turn's marker cannot leak through.
- **Running** — `ctx.data.session.status(sessionID) === "running"`.
- **Cap** — `count >= 25`.
- **Failed** — `execution.failed` sets a live per-session flag;
  `execution.interrupted` sets it only for the `inactivity` reason. Historical
  failures fall back to an assistant `error`, `finish === "error"`, or a failed
  idle outcome, except for `aborted`, so a deliberate user abort stays quiet.
- **Elapsed** — starts at the last real user task's `time.created`. While the
  run is active it counts against `Date.now()` on a 1-second ticker; when done,
  failed, interrupted, or capped it freezes at the last assistant
  `time.completed` or idle `time.created`. The format is `MM:SS`, or
  `H:MM:SS` past an hour.

The component subscribes to execution, idle, inbox, agent, and status events and
bumps a Solid signal so the footer refreshes after each transition. It registers
at `before: "prompt.footer.file"` rather than `after: "prompt.footer.status"`.
The TPS meter is an `after: "prompt.footer.status"` claim, so anchoring before
the next footer sibling puts the continue status to its right without depending
on plugin load order.

There is no stall watchdog. A request that hangs with no events at all is not
interrupted, so a slow model is never cut off.

## Known failure visibility

OpenCode retries transient stream errors internally. Only terminal failures are
reported to the plugin. Those are logged and surfaced in the footer as `● !`;
they are not retried. A session runner that dies without emitting an execution
event is outside what the plugin can observe.

## Extension ideas

- **Custom markers per agent** — make `MARKER` a plugin option read from `ctx.options`.
- **Per-agent scoping** — drive multiple agents, each with its own cap and marker.
- **Progress logging** — emit a `console.log` per continuation with a short summary of the last turn.
- **Stall watchdog** — optionally interrupt a run that produces no activity for N minutes. Omitted by design so slow models are never cut off.
