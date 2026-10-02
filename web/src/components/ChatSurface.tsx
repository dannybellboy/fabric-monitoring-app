import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, api } from '../api'
import ConfirmDialog from './ConfirmDialog'
import Markdown from './Markdown'

/**
 * Off for v1. Flip back to true to bring the MCP chat back -- everything else
 * in this file and OracleMCPChatDock is left as-is, so that's the only edit
 * this needs. Guarding the agents-list fetch below (not just the dock's
 * render in App.tsx) keeps a disabled v1 from making that call at all.
 */
export const MCP_CHAT_ENABLED = false

type ChatRole = 'user' | 'assistant'

export type DataAgent = {
  id: string
  name: string
  /** The agent's own description in Fabric. Blank for every agent today. */
  description: string
}

export type ChatMessage = {
  role: ChatRole
  content: string
  /** Which agent answered. Absent on the opening greeting and on questions. */
  agent?: string
}

/**
 * The opening line, which names the agent the picker is currently on.
 *
 * Derived rather than stored as the first message, so switching agents updates it
 * instead of leaving a greeting that names an agent you are no longer talking to.
 * The old wording ("workspace, process health, lineage") described the Oracle agent
 * specifically and was simply wrong for the six others.
 */
export function greetingFor(agent: DataAgent | undefined): string {
  if (!agent) return 'Ask a Fabric data agent about the data it covers.'
  return agent.description
    ? `**${agent.name}** — ${agent.description}`
    : `Ask **${agent.name}** about the data it covers.`
}

export type OracleMcpChat = {
  messages: ChatMessage[]
  input: string
  sending: boolean
  error: string | null
  /** Seconds since the in-flight question was sent; 0 when idle. */
  elapsed: number
  /** Replies that have landed since the user last had the conversation on screen. */
  unread: number
  /** Data agents in the workspace; empty if the list could not be read. */
  agents: DataAgent[]
  agentId: string | null
  /** Opening line for the currently selected agent. */
  greeting: string
  /** How many questions have been asked -- 0 means there is nothing to clear. */
  questionCount: number
  setInput: (value: string) => void
  setAgentId: (id: string) => void
  send: () => Promise<void>
  clear: () => void
  markRead: () => void
}

/**
 * One conversation, owned by App and shared by both surfaces that show it: the
 * full MCP chat tab and the docked window pinned to the bottom-right corner.
 *
 * It has to live above both of them. The tab body is a ternary so the tab view
 * unmounts on every tab switch, and the dock collapses -- holding the transcript
 * in either one would lose it (and any answer still in flight) the moment that
 * surface went away. Same reason `env` and `readOnly` are hoisted into App.
 */
export function useOracleMcpChat(): OracleMcpChat {
  // Empty, not seeded with a greeting: the greeting is derived below so it follows
  // the agent picker, and keeping it out of here also keeps it out of the history
  // posted to the server.
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [unread, setUnread] = useState(0)
  const [agents, setAgents] = useState<DataAgent[]>([])
  const [agentId, setAgentId] = useState<string | null>(null)

  /**
   * The workspace's data agents populate the picker on their own -- create one in
   * Fabric and it appears here.
   *
   * A failure is deliberately quiet: this runs on app start, where the most likely
   * cause is simply not being signed in yet, and a red notice in the chat would be
   * the first thing a user saw. With no list the picker hides and the server falls
   * back to its default agent, so the chat still works.
   */
  useEffect(() => {
    if (!MCP_CHAT_ENABLED) return
    let cancelled = false
    api
      .oracleMcpAgents()
      .then((response) => {
        if (cancelled) return
        setAgents(response.agents)
        setAgentId((current) => current ?? response.default)
      })
      .catch((err) => {
        if (!cancelled) console.warn('Could not list Fabric data agents:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * A data agent answer measured 16s for a trivial question and 57s for an
   * analytical one, and Fabric sends nothing until it is completely done -- so the
   * wait needs a clock as well as an animation. Three dots alone read as "hung"
   * by the 40-second mark.
   */
  useEffect(() => {
    if (!sending) {
      setElapsed(0)
      return
    }
    const started = Date.now()
    const id = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000))
    }, 1000)
    return () => window.clearInterval(id)
  }, [sending])

  const markRead = useCallback(() => setUnread(0), [])

  const clear = useCallback(() => {
    setMessages([])
    setInput('')
    setError(null)
    setUnread(0)
    // The chosen agent is a preference, not part of the conversation, so it stays.
  }, [])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return

    const outgoing: ChatMessage = { role: 'user', content: text }
    const history = [...messages, outgoing]
    // Captured now: the picker is disabled mid-flight, but the label on the reply
    // should name the agent that was actually asked either way.
    const askedName = agents.find((agent) => agent.id === agentId)?.name

    setMessages(history)
    setInput('')
    setSending(true)
    setError(null)

    try {
      const response = await api.oracleMcpChat(history, agentId ?? undefined)
      setMessages((prev) => [...prev, { role: 'assistant', content: response.reply, agent: askedName }])
      // Whoever is looking at the conversation clears this again immediately; it
      // only survives if the answer arrived while the chat was out of sight.
      setUnread((n) => n + 1)
    } catch (err) {
      // The question stays in the transcript: it took a minute to ask and the
      // user should be able to see and retype it rather than lose it.
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const questionCount = messages.filter((message) => message.role === 'user').length
  const greeting = greetingFor(agents.find((agent) => agent.id === agentId))

  return {
    messages,
    input,
    sending,
    error,
    elapsed,
    unread,
    agents,
    agentId,
    greeting,
    questionCount,
    setInput,
    setAgentId,
    send,
    clear,
    markRead,
  }
}

/**
 * Agent picker and New chat, shared by both surfaces.
 *
 * Both controls are disabled while a question is in flight: switching agents
 * mid-answer would mislabel the reply, and clearing would drop the transcript that
 * the arriving answer is about to be appended to.
 */
export function ChatToolbar({ chat }: { chat: OracleMcpChat }) {
  const { agents, agentId, sending, questionCount, setAgentId, clear } = chat
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="chat-toolbar">
      {agents.length > 0 && (
        <label className="chat-agent">
          <span>Agent</span>
          <select value={agentId ?? ''} onChange={(event) => setAgentId(event.target.value)} disabled={sending}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        type="button"
        className="link chat-new"
        onClick={() => setConfirming(true)}
        disabled={sending || questionCount === 0}
      >
        New chat
      </button>

      {confirming && (
        <ConfirmDialog
          title="Start a new chat"
          message={`This clears the current conversation (${questionCount} question${
            questionCount === 1 ? '' : 's'
          } and ${questionCount === 1 ? 'its answer' : 'their answers'}).`}
          confirmLabel="New chat"
          onConfirm={() => {
            clear()
            setConfirming(false)
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

/**
 * The transcript. Rendered by both surfaces, and marks the conversation read
 * while it is on screen -- mounting it *is* the user looking at the chat.
 */
export function ChatTranscript({ chat, className = '' }: { chat: OracleMcpChat; className?: string }) {
  const { messages, sending, error, elapsed, unread, agents, greeting, markRead } = chat
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (unread > 0) markRead()
  }, [unread, messages.length, markRead])

  // Pin to the newest message, including on mount -- reopening the dock or coming
  // back to the tab should land where the conversation left off.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, sending])

  return (
    <div className={className ? `chat-log ${className}` : 'chat-log'}>
      {/* Not part of the transcript: it re-renders whenever the picker changes. */}
      <div className="chat-bubble assistant chat-greeting">
        <Markdown>{greeting}</Markdown>
      </div>

      {messages.map((message, index) => (
        <div key={`${message.role}-${index}`} className={`chat-bubble ${message.role}`}>
          {message.role === 'assistant' ? (
            <>
              {/* Only worth naming when there was a choice to make. */}
              {message.agent && agents.length > 1 ? <span className="chat-agent-tag">{message.agent}</span> : null}
              <Markdown>{message.content}</Markdown>
            </>
          ) : (
            <span className="chat-plain">{message.content}</span>
          )}
        </div>
      ))}

      {sending && (
        <div className="chat-bubble assistant chat-pending">
          <ChatDots />
          <span className="chat-elapsed" role="status" aria-live="polite">
            {elapsed > 0 ? `Thinking… ${elapsed}s` : 'Thinking…'}
          </span>
        </div>
      )}

      {error && (
        <div className="notice error">
          <span>{error}</span>
        </div>
      )}

      <div ref={endRef} />
    </div>
  )
}

/**
 * The waiting animation. Fabric returns nothing at all until the answer is
 * complete, so there is no partial text to show and this is the only progress
 * signal available.
 */
export function ChatDots() {
  return (
    <span className="chat-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

/** The composer. `rows` differs between the roomy tab and the compact dock. */
export function ChatComposer({ chat, rows = 3 }: { chat: OracleMcpChat; rows?: number }) {
  const { input, sending, setInput, send } = chat

  return (
    <div className="chat-composer">
      <textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void send()
          }
        }}
        placeholder="Ask MCP a question"
        rows={rows}
      />
      <button className="primary" type="button" onClick={() => void send()} disabled={sending || !input.trim()}>
        Send
      </button>
    </div>
  )
}
