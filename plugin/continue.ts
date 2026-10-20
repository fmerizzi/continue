import { Plugin } from "@opencode/plugin"

const MARKER = "JOB COMPLETED"
const MAX = 25
const COOLDOWN_MS = 2000

/** Only drive this agent. */
const SCOPED_AGENT = "solver"

/**
 * True when the marker is the LAST non-empty line — so the model can't
 * trip it by mentioning the phrase mid-sentence.
 */
export function isDone(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length > 0 && lines[lines.length - 1] === MARKER
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const CONTINUE_PROMPT =
  `Continue where you left off. When the whole job is finished, ` +
  `end your reply with the exact line: ${MARKER}`

const RECOVER_PROMPT =
  `Continue where you left off. Your previous reply produced no output. ` +
  `If you are stuck, explain the blocker and try a different approach. ` +
  `When the whole job is finished, end your reply with the exact line: ${MARKER}`

type State = {
  iterations: number
  running: boolean
  seen: Set<string>
}

export default Plugin.define({
  id: "continue",
  async setup(ctx) {
    // Per-session state. Model-agnostic: no model fields, so model switching stays free.
    const sessions = new Map<string, State>()
    const state = (id: string) => {
      let s = sessions.get(id)
      if (!s) {
        s = { iterations: 0, running: false, seen: new Set() }
        sessions.set(id, s)
      }
      return s
    }

    const abort = new AbortController()

    const nudge = async (sessionID: string, s: State, prompt: string) => {
      s.running = true
      try {
        s.iterations += 1
        console.log(`[continue] continuation ${s.iterations}/${MAX}`)
        await sleep(COOLDOWN_MS)
        if (abort.signal.aborted) return
        await ctx.session.prompt({ sessionID, text: prompt })
      } finally {
        s.running = false
      }
    }

    const handleCompleted = async (sessionID: string) => {
      const s = state(sessionID)

      if (s.running) return // don't stack prompts
      if (s.iterations >= MAX) return // hard stop

      const session = await ctx.session.get({ sessionID })

      // Global plugins run once per location. Only the instance for the
      // session's project should act, otherwise two instances send two prompts.
      if (session.projectID !== ctx.location.project.id) return

      const messages = await ctx.session.context({ sessionID })
      if (!messages.length) return

      // Never re-prompt an errored or interrupted turn.
      const tail = messages[messages.length - 1]
      if (tail?.type === "idle" && tail.outcome !== "succeeded") return

      // Only reason about the current turn: everything after the last user
      // message. A previous assistant reply must not mask a no-reply turn.
      let lastUserIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === "user") {
          lastUserIndex = i
          break
        }
      }
      if (lastUserIndex < 0) return

      const lastUser = messages[lastUserIndex]
      const last = messages
        .slice(lastUserIndex + 1)
        .reverse()
        .find((m) => m.type === "assistant")

      // Gate: only ever continue inside the solver. Prefer the session's
      // current agent so switching away stops the loop immediately.
      const agent = session.agent ?? last?.agent
      if (agent !== SCOPED_AGENT) return

      if (!last) {
        // The turn completed but produced no assistant message at all.
        const key = `no-reply:${lastUser.id}`
        if (s.seen.has(key)) return
        s.seen.add(key)
        console.log(`[continue] no reply after ${lastUser.id}; nudging`)
        await nudge(sessionID, s, RECOVER_PROMPT)
        return
      }

      if (last.error || last.finish === "error") return // never fight an error/abort
      if (s.seen.has(last.id)) return // de-dup the same turn
      s.seen.add(last.id)

      let text = ""
      let meaningful = false
      for (const part of last.content) {
        if (part.type === "text") {
          text += (text ? "\n" : "") + part.text
          if (part.text.trim()) meaningful = true
        } else if (part.type === "reasoning") {
          if (part.text.trim()) meaningful = true
        } else if (part.type === "tool") {
          meaningful = true
        }
      }

      if (isDone(text)) {
        console.log(`[continue] done after ${s.iterations} continuation(s)`)
        s.iterations = 0
        return
      }

      const prompt = meaningful ? CONTINUE_PROMPT : RECOVER_PROMPT
      if (!meaningful) console.log(`[continue] empty reply from ${last.id}; nudging`)
      await nudge(sessionID, s, prompt)
    }

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === "session.deleted") {
          sessions.delete(event.data.sessionID)
          continue
        }

        // Terminal failures and interruptions are reported for visibility only.
        // We deliberately do not retry provider errors or hangs.
        if (event.type === "session.execution.failed") {
          const error = event.data.error
          console.error(
            `[continue] execution failed session=${event.data.sessionID} ` +
              `type=${error.type}${error.status ? ` status=${error.status}` : ""} message=${error.message}`,
          )
          continue
        }

        if (event.type === "session.execution.interrupted") {
          console.log(
            `[continue] execution interrupted session=${event.data.sessionID} reason=${event.data.reason}`,
          )
          continue
        }

        if (event.type !== "session.execution.succeeded" && event.type !== "session.idle") continue

        try {
          await handleCompleted(event.data.sessionID)
        } catch (error) {
          console.error(`[continue] completion handler failed`, error)
        }
      }
    })().catch((error) => {
      if (!abort.signal.aborted) console.error(`[continue] event stream failed`, error)
    })

    return () => abort.abort()
  },
})
