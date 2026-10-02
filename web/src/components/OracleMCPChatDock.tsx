import { useEffect, useRef, useState } from 'react'

import { ChatComposer, ChatDots, ChatToolbar, ChatTranscript, type OracleMcpChat } from './ChatSurface'

/**
 * A Messenger-style docked chat, pinned bottom-right on every tab, so the agent
 * can be asked something without leaving whatever you were looking at.
 *
 * Collapsed it is a single labelled bar; open it is a small window over the page.
 * It shares App's one chat hook with the full MCP chat tab, so both surfaces
 * show the same conversation.
 */
export default function OracleMCPChatDock({ chat, hidden = false }: { chat: OracleMcpChat; hidden?: boolean }) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Esc closes the window, matching the modal form's behaviour elsewhere.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Focus the composer on open so a question can just be typed.
  useEffect(() => {
    if (open) panelRef.current?.querySelector('textarea')?.focus()
  }, [open])

  // Nothing passes this today -- there is no full-page chat tab, so the dock is
  // the only surface. It stays for the case where one is registered again: two
  // live copies of one conversation side by side is just noise. Unmounting only
  // collapses the dock; the transcript lives in App and is unaffected.
  if (hidden) return null

  if (!open) {
    return (
      <button
        type="button"
        className="chat-dock-tab"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title="Ask a data agent a question"
      >
        <span>MCP chat</span>
        {/* While a question is in flight the collapsed bar keeps animating, so a
            60-second answer is still visibly coming from anywhere in the app. */}
        {chat.sending ? <ChatDots /> : null}
        {!chat.sending && chat.unread > 0 ? <span className="chat-dock-dot" aria-label="New reply" /> : null}
      </button>
    )
  }

  return (
    <div className="chat-dock" ref={panelRef} role="dialog" aria-label="MCP chat">
      <div className="chat-dock-header">
        <strong>MCP chat</strong>
        <button type="button" className="link chat-dock-close" onClick={() => setOpen(false)} aria-label="Minimise chat">
          ×
        </button>
      </div>

      {/* Same picker and New chat as the tab, on its own row: at 380px wide there
          is no space to put them beside the title. */}
      <div className="chat-dock-toolbar">
        <ChatToolbar chat={chat} />
      </div>

      <ChatTranscript chat={chat} className="chat-dock-log" />

      <div className="chat-dock-composer">
        <ChatComposer chat={chat} rows={2} />
      </div>
    </div>
  )
}
