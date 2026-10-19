import type { SessionMessageInfo } from "@opencode/client"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { Show, createMemo, createSignal, onCleanup } from "solid-js"

const MARKER = "JOB COMPLETED"
const MAX = 25
const CONTINUE_PREFIX = "Continue where you left off."
const SCOPED_AGENT = "solver"

const EVENTS = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.agent.selected",
  "session.status",
  "session.deleted",
] as const

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>

type Status = {
  count: number
  done: boolean
  running: boolean
  capped: boolean
}

function isDone(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 0 && lines[lines.length - 1] === MARKER
}

function lastAssistant(messages: SessionMessageInfo[]): Assistant | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
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

  const bump = () => {
    // Let the client-side session store apply the event before we read it.
    setTimeout(() => setVersion((value) => value + 1), 0)
  }
  const offs = EVENTS.map((type) => ctx.data.on(type, bump))
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
    return {
      count,
      done,
      running: ctx.data.session.status(sessionID) === "running",
      capped: count >= MAX && !done,
    }
  })

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
          <text fg={color(value())}>●</text>
          <text fg={ctx.theme.text.muted}>{value().done ? "✓" : `${value().count}/${MAX}`}</text>
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
