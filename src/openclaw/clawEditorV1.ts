/** claw_editor.v1.* — Channel remote edit protocol (plugin ↔ ClawEditor Master). */

/** Round-trip routing context (plugin sets on inbound; Master echoes unchanged). */
export type ClawEditorV1Context = {
  /** Canonical conversation id (cache key). */
  channel_id: string
  /** OpenClaw channel plugin id, e.g. openclaw-weixin | feishu. */
  channel_plugin?: string
  /** Provider account id for multi-account channels. */
  account_id?: string
  /** Outbound sendText `to` (user:…, chat:…, or IM peer id). */
  delivery_to?: string
  /** Feishu topic / thread id when applicable. */
  thread_id?: string
}

export type ClawEditorV1RequestPayload = {
  full_text: string
  args?: string[]
  target_file?: string
}

export type ClawEditorV1RequestEvent = {
  type: 'claw_editor.v1.request'
  request_id: string
  context: ClawEditorV1Context
  payload: ClawEditorV1RequestPayload
}

export type ClawEditorV1CommitPayload = {
  action: 'apply' | 'ignore'
}

export type ClawEditorV1CommitEvent = {
  type: 'claw_editor.v1.commit'
  request_id: string
  context: ClawEditorV1Context
  payload: ClawEditorV1CommitPayload
}

export type ClawEditorV1DiffPayload = {
  summary?: string
  diff_text?: string
  file_name?: string
  image_base64?: string
}

export type ClawEditorV1DiffResponseEvent = {
  type: 'claw_editor.v1.diff_response'
  request_id: string
  context: ClawEditorV1Context
  payload: ClawEditorV1DiffPayload
}

export type ClawEditorV1CommitResponseEvent = {
  type: 'claw_editor.v1.commit_response'
  request_id: string
  context: ClawEditorV1Context
  payload: ClawEditorV1CommitPayload & { ok?: boolean; message?: string }
}

export type ClawEditorV1OutboundEvent = ClawEditorV1DiffResponseEvent | ClawEditorV1CommitResponseEvent

function hasChannelId(context: unknown): context is ClawEditorV1Context {
  return (
    context !== null &&
    typeof context === 'object' &&
    typeof (context as ClawEditorV1Context).channel_id === 'string' &&
    (context as ClawEditorV1Context).channel_id.trim().length > 0
  )
}

export function isClawEditorV1RequestPayload(
  p: Record<string, unknown>
): p is ClawEditorV1RequestEvent {
  return (
    p.type === 'claw_editor.v1.request' &&
    typeof p.request_id === 'string' &&
    p.request_id.startsWith('req_') &&
    hasChannelId(p.context)
  )
}

export function isClawEditorV1CommitPayload(
  p: Record<string, unknown>
): p is ClawEditorV1CommitEvent {
  return (
    p.type === 'claw_editor.v1.commit' &&
    typeof p.request_id === 'string' &&
    p.request_id.startsWith('req_') &&
    hasChannelId(p.context) &&
    p.payload !== null &&
    typeof p.payload === 'object' &&
    ((p.payload as ClawEditorV1CommitPayload).action === 'apply' ||
      (p.payload as ClawEditorV1CommitPayload).action === 'ignore')
  )
}

export function parseClawEditorV1Context(raw: unknown): ClawEditorV1Context | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as ClawEditorV1Context
  const channel_id = typeof o.channel_id === 'string' ? o.channel_id.trim() : ''
  if (!channel_id) return null
  const account_id = typeof o.account_id === 'string' ? o.account_id.trim() : ''
  const delivery_to = typeof o.delivery_to === 'string' ? o.delivery_to.trim() : ''
  const channel_plugin = typeof o.channel_plugin === 'string' ? o.channel_plugin.trim() : ''
  const thread_id = typeof o.thread_id === 'string' ? o.thread_id.trim() : ''
  return {
    channel_id,
    ...(channel_plugin ? { channel_plugin } : {}),
    ...(account_id ? { account_id } : {}),
    ...(delivery_to ? { delivery_to } : {}),
    ...(thread_id ? { thread_id } : {}),
  }
}
