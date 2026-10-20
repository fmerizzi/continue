import type { SessionMessageInfo } from "@opencode/client"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { Show, createMemo, createSignal, onCleanup } from "solid-js"

const MARKER = "JOB COMPLETED"
const MAX = 25
const CONTINUE_PREFIX = "Continue where you left off."
const SCOPED_AGENT = "solver"

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>

type Status = {
  count: number
  done: boolean
  running: boolean
  capped: boolean
  failed: boolean
}

function isDone(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 0 && lines[lines.length - 1] === MARKER
}

function lastUserIndex(messages: SessionMessageInfo[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "user") return i
  }
  return -1
}

function lastAssistant(messages: SessionMessageInfo[]): Assistant | undefined {
  const start = lastUserIndex(messages)
  for (let i = messages.length - 1; i > start; i--) {
    const message = messages[i]
    if (message.type === "assistant") return message
  }
  return
}

function assistantText(message: Assistant | undefined): string {
  if (!message) return ""
  let text = ""
  for (const part of message.content) {
    if (part.type === "text") text += (text ? "\n" : "") + part.text
  }
  return text
}

function continuationCount(messages: SessionMessageInfo[]): number {
  let lastRealUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.type === "user" && !message.text.startsWith(CONTINUE_PREFIX)) {
      lastRealUser = i
      break
    }
  }

  let count = 0
  for (let i = lastRealUser + 1; i < messages.length; i++) {
    const message = messages[i]
    if (message.type === "user" && message.text.startsWith(CONTINUE_PREFIX)) count++
  }
  return count
}

function StatusView(props: { sessionID?: string }) {
  const ctx = usePlugin()
  const [version, setVersion] = createSignal(0)
  const [failures, setFailures] = createSignal<Record<string, true>>({})

  const bump = () => {
    // Let the client-side session store apply the event before we read it.
    setTimeout(() => setVersion((value) => value + 1), 0)
  }

  const setFailure = (sessionID: string, failed: boolean) => {
    setFailures((previous) => {
      if (failed) {
        if (previous[sessionID]) return previous
        return { ...previous, [sessionID]: true }
      }
      if (!previous[sessionID]) return previous
      const next = { ...previous }
      delete next[sessionID]
      return next
    })
  }

  const offs = [
    ctx.data.on("session.execution.started", (event) => {
      setFailure(event.data.sessionID, false)
      bump()
    }),
    ctx.data.on("session.execution.succeeded", (event) => {
      setFailure(event.data.sessionID, false)
      bump()
    }),
    ctx.data.on("session.execution.failed", (event) => {
      setFailure(event.data.sessionID, true)
      bump()
    }),
    ctx.data.on("session.execution.interrupted", (event) => {
      // A user abort stops the loop deliberately; only inactivity counts as a
      // failed run for the footer.
      setFailure(event.data.sessionID, event.data.reason === "inactivity")
      bump()
    }),
    ctx.data.on("session.inbox.enqueued", bump),
    ctx.data.on("session.agent.selected", bump),
    ctx.data.on("session.status", bump),
    ctx.data.on("session.idle", bump),
    ctx.data.on("session.deleted", (event) => {
      setFailure(event.data.sessionID, false)
      bump()
    }),
  ]
  onCleanup(() => offs.forEach((off) => off()))

  const status = createMemo<Status | undefined>(() => {
    version()
    const sessionID = props.sessionID
    if (!sessionID) return

    const session = ctx.data.session.get(sessionID)
    const messages = ctx.data.session.message.list(sessionID)
    const assistant = lastAssistant(messages)
    const agent = session?.agent ?? assistant?.agent
    if (agent !== SCOPED_AGENT) return

    const count = continuationCount(messages)
    const done = isDone(assistantText(assistant))

    // Live failures come from events because a failed turn may not persist an
    // idle message. Historical failures fall back to the assistant record.
    // "aborted" is excluded here so a deliberate user abort stays quiet.
    const historicalFailure =
      assistant?.error !== undefined
        ? assistant.error.type !== "aborted"
        : assistant?.finish === "error"

    return {
      count,
      done,
      running: ctx.data.session.status(sessionID) === "running",
      capped: count >= MAX && !done,
      failed: failures()[sessionID] === true || historicalFailure,
    }
  })

  const errorColor = () => ctx.theme.text.feedback?.error?.base ?? ctx.theme.text.base
  const color = (value: Status) => {
    const feedback = ctx.theme.text.feedback
    if (value.capped) return feedback?.error?.base ?? ctx.theme.text.base
    if (value.done) return feedback?.info?.base ?? ctx.theme.text.base
    if (value.running) return feedback?.success?.base ?? ctx.theme.text.base
    return feedback?.warning?.base ?? ctx.theme.text.muted
  }

  return (
    <Show when={status()} fallback={<box flexShrink={0} />}>
      {(value) => (
        <box flexDirection="row" flexShrink={0} gap={1}>
          <text fg={value().failed ? errorColor() : color(value())}>●</text>
          <text fg={value().failed ? errorColor() : ctx.theme.text.muted}>
            {value().failed ? "!" : value().done ? "✓" : `${value().count}/${MAX}`}
          </text>
        </box>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "continue.tui",
  setup(ctx) {
    return ctx.ui.slot({
      // The TPS meter claims `after: "prompt.footer.status"`. Anchoring
      // before the next sibling puts us to its right without depending on
      // plugin load order.
      before: "prompt.footer.file",
      render: (input) => <StatusView sessionID={input.sessionID} />,
    })
  },
})
