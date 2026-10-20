# continue

Auto-continues an [OpenCode 2](https://opencode.ai) agent until it declares the job done.

Point a long-running task at a scoped agent, and `continue` keeps nudging it forward one "don't give up, continue where you left off" prompt at a time, until the agent ends its reply with the exact line `JOB COMPLETED`. This is particularly useful to have a single agent work at a problem for long periods of time without interruptions. The plugin was built with Qwen 3.8 27B local models in mind.

## How it works

```
session done ──► is this the solver agent? ──► did the last reply end with JOB COMPLETED?
                     │ no → ignore                       │ yes → reset, stop
                     └──► send "Continue where you left off…"
```

1. **Watches for turn completion** — on `session.execution.succeeded` (or `session.idle` when emitted), the plugin checks the last assistant reply.
2. **Scoped to one agent** — by default only the `solver` agent is driven; every other session is ignored.
3. **Marker detection** — the run ends only when `JOB COMPLETED` is the *last non-empty line* of the reply, so the model can't trip it by mentioning the phrase mid-sentence.
4. **Bounded** — a hard cap of 25 continuations, a 2s cooldown between prompts, and no stacking while a prompt is in flight.

## Safety gates

| Gate | What it does |
| --- | --- |
| `MAX = 25` | Hard stop after 25 continuations per session |
| `COOLDOWN_MS = 2000` | Pause between the completion event and the next prompt |
| `running` flag | Never stacks a prompt on top of an in-flight one |
| `seen` set | De-duplicates the same assistant turn |
| Error/outcome check | Never re-prompts after an errored, aborted, or interrupted turn |
| Empty-reply recovery | A completed turn with no assistant reply / no meaningful content gets one nudge |
| Agent gate | Only drives the configured agent — your other sessions are untouched |

The plugin is deliberately **model-agnostic**: it never touches the model field, so you can switch models mid-session without breaking the loop.

## Footer status

The TUI half shows the active solver run in the prompt footer, immediately to
the right of the TPS meter:

| Display | Meaning |
| --- | --- |
| `● 0/25` | Solver is generating (green dot) |
| `● 3/25` | Waiting between continuations (yellow dot) |
| `● ✓` | `JOB COMPLETED` reached (cyan dot) |
| `● 25/25` | Continuation cap reached (red dot) |
| `● !` | The last execution failed, or timed out from inactivity (red) |

The status is hidden for every session that is not running the `solver` agent.

## Empty replies and failures

If a turn completes successfully but leaves no assistant message after the last
user message, or leaves only empty/whitespace content, the plugin sends a
recovery nudge:

```text
Continue where you left off. Your previous reply produced no output.
If you are stuck, explain the blocker and try a different approach.
When the whole job is finished, end your reply with the exact line: JOB COMPLETED
```

That nudge counts toward the normal 25-attempt cap.

Provider failures and interruptions are **not retried**:

- `session.execution.failed` is logged with the error type, status, and message.
- `session.execution.interrupted` is logged with its reason (`user`, `inactivity`,
  `shutdown`, or `superseded`).
- The footer shows `● !` for failures and inactivity timeouts.
- User aborts leave the normal count in place.
- Transient stream errors are already retried internally by OpenCode before a
  turn is reported as failed.

There is deliberately no stall watchdog, so slow models are never interrupted.
A runner that hangs with no events at all is outside what this plugin can detect.

## Install

OpenCode 2 discovers `.ts` files under `.opencode/plugins/`, and TUI plugins use
the package layout with a `tui` entrypoint. Copy both halves:

```sh
# per project
mkdir -p .opencode/plugins/continue-tui
cp plugin/continue.ts .opencode/plugins/
cp plugin/tui.tsx .opencode/plugins/continue-tui/
cp plugin/tui-package.json .opencode/plugins/continue-tui/package.json
```

Or globally, from this checkout:

```sh
npm run deploy
```

`deploy` installs the server plugin at
`~/.config/opencode/plugins/continue.ts` and the TUI package at
`~/.config/opencode/plugins/continue-tui/`.

## Agent

Add the `solver` agent to your `opencode.json(c)` using the native V2 shape:

```jsonc
{
  "agents": {
    "solver": {
      "description": "Autonomous problem solver for long-running open-ended tasks",
      "model": "llama-local/qwen3.8-27b",
      "mode": "primary",
      "color": "#3fb950",
      "steps": 400,
      "system": "You are a research engineer, work the task step by step and do not stop to ask questions. Decide and proceed.",
      "request": {
        "body": {
          "temperature": 0.3
        }
      },
      "permissions": [
        { "action": "*", "resource": "*", "effect": "allow" },
        { "action": "doom_loop", "resource": "*", "effect": "ask" }
      ]
    }
  }
}
```

Start a session with the `solver` agent and give it your task. It will keep going until it finishes or hits the cap.

## Configuration

All knobs are constants at the top of `plugin/continue.ts`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `SCOPED_AGENT` | `"solver"` | The only agent the plugin will drive |
| `MAX` | `25` | Max continuations per session before a hard stop |
| `COOLDOWN_MS` | `2000` | Delay before each continuation prompt |
| `MARKER` | `"JOB COMPLETED"` | The exact line that ends the loop |

## FAQ

**Why is the marker checked as the last line?**
So the model can't accidentally end the run by mentioning `JOB COMPLETED` in passing — it has to *commit* to it as the final line of the reply.

**Can I switch models mid-session?**
Yes. The plugin only pins the agent, never the model.

**What happens when the cap is hit?**
The plugin stops prompting and the session simply goes idle. The counter resets the next time the agent finishes a job.

**What about model crashes?**
Transient stream errors are retried internally by OpenCode. If those retries are exhausted, the turn is reported as failed: the plugin logs it, and the footer shows `● !`. The plugin does not retry provider errors itself, and it has no stall watchdog, so a runner that hangs with no events at all stays outside its control.

**Does it interfere with my other sessions?**
No. Anything that isn't running under the scoped agent is ignored entirely.

**Does it work on OpenCode 1?**
No. This version targets the OpenCode 2 plugin API (`Plugin.define` with `setup(ctx)` and `ctx.event.subscribe`). Use the previous release for OpenCode 1.

## Docs

- [docs/how-it-works.md](docs/how-it-works.md) — deeper dive into the event flow and design decisions

## License

[MIT](LICENSE)
