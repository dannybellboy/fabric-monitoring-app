import { ChatComposer, ChatToolbar, ChatTranscript, type OracleMcpChat } from './ChatSurface'

/**
 * The full-tab view of the MCP chat conversation.
 *
 * The same conversation is also reachable from the docked window in the corner of
 * every tab -- both read the one hook instance in App, so a question asked in the
 * dock is already here (and vice versa) rather than being a second thread.
 */
export default function OracleMCPChatView({ chat }: { chat: OracleMcpChat }) {
  return (
    <div className="panel chat-panel">
      <div className="panel-body chat-toolbar-pane">
        <ChatToolbar chat={chat} />
      </div>

      <div className="panel-body chat-log-pane">
        <ChatTranscript chat={chat} />
      </div>

      <div className="panel-body chat-composer-pane">
        <ChatComposer chat={chat} rows={3} />
      </div>
    </div>
  )
}
