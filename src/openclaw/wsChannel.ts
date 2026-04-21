import { buildDeviceAuthPayloadV3 } from './deviceAuthPayload'
import { loadOrCreateDeviceIdentity } from './deviceIdentity'
import { normalizeGatewayCredential } from './normalizeCredential'
import { getContextLinesAroundCursor } from '../utils/contextSnippet'
import { extractJsonObject, parseIntentEnvelope } from './extractIntentJson'
import { getSkillMarkdownBody } from '../skills/resolveSkill'

let wsCounter = 0

/** Outbound Gateway messages use basename only — avoids leaking workspace / home directory paths. */
function fileNameFromPath(p: string): string {
  const s = p.replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i === -1 ? s : s.slice(i + 1)
}

/** Debounce tool `update` diffs — each partial newText used to open the proposal popup immediately. */
const DIFF_PROPOSAL_DEBOUNCE_MS = 600

function readStoredCredential(key: string): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(key) ?? ''
}

export class OpenClawWsChannel {
  private ws: WebSocket | null = null
  private handlers: {
    onOpen: () => void
    onClose: (ev: CloseEvent | Event) => void
    onError: (ev: Event) => void
    onDelta: (delta: string) => void
    onFinal: (markdown: string) => void
    onProposal: (proposal: {
      requestId?: string
      proposal: import('./types').OpenClawProposalPayload
    }) => void
    onParsedIntent: (payload: {
      requestId?: string
      version: number
      intent: unknown
    }) => void
    onIntentError: (payload: {
      requestId?: string
      code?: string
      message: string
    }) => void
    clearStreaming?: () => void
    pushSystem?: (content: string) => void
  }
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private turnBuffer = ''
  private activeFilePath: string | undefined
  private messageSubscribed = false
  private subscribedSessionId: string | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Single-flight: wait for assistant JSON when local /edit fails. */
  private intentParseWaiter: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null
  private intentParseAcc = ''
  private intentParseTimer: ReturnType<typeof setTimeout> | null = null
  /** Tool may stream many `update` events with partial `newText`; debounce before onProposal. */
  private diffProposalDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingDiffProposal: { path: string; newText: string } | null = null
  private url: string
  private manualClose = false
  /**
   * Shared gateway token (auth.token). Device v3 payload uses the same string.
   * If empty but `gatewayPassword` is set, OpenClaw uses auth.password and v3 token segment is "".
   */
  private gatewayToken: string
  private gatewayPassword: string

  constructor(
    url: string,
    handlers: OpenClawWsChannel['handlers'],
    options?: { gatewayToken?: string; gatewayPassword?: string }
  ) {
    this.url = url
    this.handlers = handlers
    const rawTok = options?.gatewayToken ?? readStoredCredential('openclaw.gatewayToken')
    const rawPass = options?.gatewayPassword ?? readStoredCredential('openclaw.gatewayPassword')
    this.gatewayToken = normalizeGatewayCredential(rawTok)
    this.gatewayPassword = normalizeGatewayCredential(rawPass)
  }

  async connect(): Promise<void> {
    this.manualClose = false
    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url)
      } catch (e) {
        reject(e)
        return
      }

      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new Error('WebSocket 连接超时'))
      }, 10_000)

      this.ws.onopen = () => {
        clearTimeout(timeout)
        void this.doHandshake().then(resolve).catch(reject)
      }

      this.ws.onmessage = (ev) => {
        try {
          const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
          this.handleMessage(msg)
        } catch {
          // ignore non-JSON frames
        }
      }

      this.ws.onclose = (ev) => {
        this.stopPing()
        if (!this.manualClose) {
          this.handlers.onClose(ev)
        }
      }

      this.ws.onerror = (ev) => {
        clearTimeout(timeout)
        this.handlers.onError(ev)
      }
    })
  }

  private async doHandshake(): Promise<void> {
    if (!this.ws) throw new Error('WebSocket 未初始化')

    // Wait for connect.challenge event
    const challenge = new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMsg = (ev: MessageEvent) => {
        try {
          const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            this.ws!.removeEventListener('message', onMsg)
            resolve(msg.payload as Record<string, unknown>)
          }
        } catch {
          // skip
        }
      }
      this.ws!.addEventListener('message', onMsg)
      setTimeout(() => {
        this.ws!.removeEventListener('message', onMsg)
        reject(new Error('等待 connect.challenge 超时'))
      }, 8_000)
    })

    const ch = await challenge
    const nonce = (ch.nonce as string) ?? ''
    if (!nonce) {
      throw new Error('connect.challenge 缺少 nonce')
    }

    const identity = await loadOrCreateDeviceIdentity()
    const signedAt = Date.now()
    const tok = this.gatewayToken
    const pass = this.gatewayPassword
    const useToken = Boolean(tok)
    /** OpenClaw `resolveSignatureToken` only reads auth.token / deviceToken / bootstrapToken — not password. */
    const signTokenSegment = useToken ? tok : ''
    const clientId = 'gateway-client'
    const clientMode = 'ui'
    const role = 'operator'
    const scopes = ['operator.read', 'operator.write']
    const platform = 'desktop'

    const signPayload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs: signedAt,
      token: signTokenSegment || null,
      nonce,
      platform,
      deviceFamily: null,
    })
    const signature = await identity.signUtf8Payload(signPayload)

    const id = this.nextRpcId()
    const connectPromise = new Promise<void>((resolve, reject) => {
      this.pending.set(String(id), {
        resolve: () => resolve(),
        reject,
      })
    })

    this.ws.send(JSON.stringify({
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          // Must match GatewayClientIdSchema / GatewayClientModeSchema (openclaw gateway protocol).
          id: clientId,
          version: '0.1.0',
          platform,
          mode: clientMode,
        },
        role,
        scopes,
        caps: [],
        commands: [],
        permissions: {},
        ...(useToken
          ? { auth: { token: tok } }
          : pass
            ? { auth: { password: pass } }
            : {}),
        locale: 'zh-CN',
        userAgent: 'claw-editor/0.1.0',
        device: {
          id: identity.deviceId,
          publicKey: identity.publicKeyBase64Url,
          signature,
          signedAt,
          nonce,
        },
      },
    }))

    await connectPromise
    this.handlers.onOpen()
    this.startPing()
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'req', id: this.nextRpcId(), method: 'health', params: {} }))
        } catch {
          // ignore
        }
      }
    }, 30_000)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private nextRpcId(): string {
    return `${Date.now()}-${++wsCounter}`
  }

  /** Gateway `chat.send` requires a unique idempotency key per logical send. */
  private newIdempotencyKey(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    return `${Date.now()}-${++wsCounter}-${Math.random().toString(36).slice(2, 12)}`
  }

  private call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket 未连接'))
    }
    const id = this.nextRpcId()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'res') {
      const id = String(msg.id ?? '')
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        if (msg.ok === false) {
          const err = msg.error as { message?: string } | undefined
          p.reject(new Error(err?.message ?? `RPC 错误: ${msg.method ?? id}`))
        } else {
          p.resolve(msg.payload ?? msg.result)
        }
      }
      return
    }

    if (msg.type === 'event') {
      this.handleEvent(msg.event as string, (msg.payload ?? {}) as Record<string, unknown>)
    }
  }

  private handleEvent(event: string, payload: Record<string, unknown>): void {
    if (event === 'tick') return

    if (event === 'session.message' || event === 'chat.message') {
      this.handleSessionMessage(payload)
      return
    }

    if (event === 'session.tool') {
      this.handleSessionTool(payload)
      return
    }

    if (event === 'shutdown') {
      this.handlers.onClose(new CloseEvent('close'))
    }
  }

  private handleSessionMessage(payload: Record<string, unknown>): void {
    // Gateway `session.message` payload shape:
    // { sessionKey, message: { role, content?, text?, ... }, ... }
    const p =
      payload.message && typeof payload.message === 'object'
        ? (payload.message as Record<string, unknown>)
        : payload

    const role = (p.role as string | undefined) ?? (p.sender as string | undefined) ?? ''

    const extractText = (value: unknown): string => {
      if (typeof value === 'string') return value
      if (!Array.isArray(value)) return ''
      const parts: string[] = []
      for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const it = item as Record<string, unknown>
        // Common block shapes: {type:'text', text:'...'} or {type:'output_text', text:'...'}
        const t = typeof it.text === 'string' ? it.text : ''
        if (t) parts.push(t)
        // Some adapters nest: {type:'content', content:{type:'text',text:'...'}}
        const inner = it.content
        if (inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).text === 'string') {
          parts.push(String((inner as Record<string, unknown>).text))
        }
      }
      return parts.join('')
    }

    const text =
      (p.text as string | undefined) ??
      extractText(p.content) ??
      (typeof p.content === 'string' ? (p.content as string) : '')

    const deltaText = (p.delta as string | undefined) ?? text
    const isStreaming = p.streaming === true || p.chunk === true || p.delta !== undefined

    if (this.intentParseWaiter) {
      if (role === 'assistant' || role === 'model') {
        const chunk = deltaText || text
        if (isStreaming) {
          if (chunk) this.intentParseAcc += chunk
        } else {
          // 合并流式累积与本轮正文；避免网关先发「空完成」导致用空串 resolve，从而误报「未找到 JSON」。
          const full = this.intentParseAcc + (chunk ?? '')
          this.intentParseAcc = ''
          if (full.trim().length > 0) {
            this.finishIntentParse(full)
          }
        }
      }
      return
    }

    if (!text && !deltaText) return

    if (role === 'assistant' || role === 'user') {
      if (isStreaming) {
        this.turnBuffer += deltaText
        this.handlers.onDelta(deltaText)
      } else {
        // Complete message
        if (this.turnBuffer.length > 0) {
          this.handlers.onFinal(this.turnBuffer)
          this.turnBuffer = ''
        } else if (text.length > 0) {
          this.handlers.onFinal(text)
        }
      }
    }
  }

  private finishIntentParse(raw: string): void {
    if (this.intentParseTimer) {
      clearTimeout(this.intentParseTimer)
      this.intentParseTimer = null
    }
    const w = this.intentParseWaiter
    this.intentParseWaiter = null
    if (w) w.resolve(raw)
  }

  private rejectIntentParse(reason: Error): void {
    if (this.intentParseTimer) {
      clearTimeout(this.intentParseTimer)
      this.intentParseTimer = null
    }
    const w = this.intentParseWaiter
    this.intentParseWaiter = null
    this.intentParseAcc = ''
    if (w) w.reject(reason)
  }

  private handleSessionTool(payload: Record<string, unknown>): void {
    const status = (payload.status as string | undefined) ?? ''
    const title = (payload.title as string | undefined) ?? (payload.name as string | undefined) ?? ''

    if (status === 'call' || status === 'start') {
      if (title) this.handlers.pushSystem?.(`[工具] ${title}`)
      return
    }

    if (status === 'update') {
      this.tryExtractDiff(payload, 'update')
      return
    }

    if (status === 'failed') {
      this.handlers.pushSystem?.('[工具] 失败')
    }

    if (status === 'result' || status === 'done') {
      this.tryExtractDiff(payload, 'final')
    }
  }

  private cancelPendingDiffProposal(): void {
    if (this.diffProposalDebounceTimer) {
      clearTimeout(this.diffProposalDebounceTimer)
      this.diffProposalDebounceTimer = null
    }
    this.pendingDiffProposal = null
  }

  private flushDiffProposalDebounced(): void {
    this.diffProposalDebounceTimer = null
    const pending = this.pendingDiffProposal
    this.pendingDiffProposal = null
    if (!pending || !this.activeFilePath) return
    if (!this.pathsMatch(pending.path, this.activeFilePath)) return
    this.handlers.onProposal({
      proposal: {
        kind: 'replace_whole_document',
        newText: pending.newText,
        title: 'diff',
        summary: pending.path,
      },
    })
  }

  /** `update`: debounce (partial newText). `final`: emit immediately (complete newText). */
  private tryExtractDiff(payload: Record<string, unknown>, phase: 'update' | 'final'): void {
    if (!this.activeFilePath) return

    const emitOne = (path: string | undefined, newText: string | undefined) => {
      const ap = this.activeFilePath
      if (!path || typeof newText !== 'string' || !ap || !this.pathsMatch(path, ap)) return
      if (phase === 'final') {
        this.cancelPendingDiffProposal()
        this.handlers.onProposal({
          proposal: { kind: 'replace_whole_document', newText, title: 'diff', summary: path },
        })
      } else {
        this.pendingDiffProposal = { path, newText }
        if (this.diffProposalDebounceTimer) clearTimeout(this.diffProposalDebounceTimer)
        this.diffProposalDebounceTimer = window.setTimeout(() => {
          this.flushDiffProposalDebounced()
        }, DIFF_PROPOSAL_DEBOUNCE_MS)
      }
    }

    const emitFromBlock = (b: Record<string, unknown>) => {
      if (b.type === 'diff') {
        emitOne(b.path as string | undefined, b.newText as string | undefined)
      }
      if (b.type === 'content' && b.content && typeof b.content === 'object') {
        const inner = b.content as Record<string, unknown>
        if (inner.type === 'diff') {
          emitOne(inner.path as string | undefined, inner.newText as string | undefined)
        }
      }
    }

    const content = payload.content
    if (content === undefined || content === null) {
      emitFromBlock(payload)
      return
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        emitFromBlock(block as Record<string, unknown>)
      }
      return
    }

    if (typeof content === 'object') {
      emitFromBlock(content as Record<string, unknown>)
    }
  }

  private pathsMatch(toolPath: string, activePath: string): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const na = norm(toolPath)
    const nb = norm(activePath)
    if (na === nb) return true
    // Model may echo only the basename we sent in the user message.
    const base = (p: string) => {
      const parts = p.split('/').filter(Boolean)
      return parts.length ? parts[parts.length - 1]! : p
    }
    return base(na) === base(nb)
  }

  private buildChatInstructionMessage(params: {
    instruction: string
    file: { name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
  }): string {
    const headerLines = [
      '[ClawEditor → OpenClaw Gateway]',
      `file: ${params.file.name} (${params.file.language})`,
      `path: ${fileNameFromPath(params.file.path)}`,
      '',
      'instruction:',
      params.instruction,
    ]
    if (params.selection?.text) {
      headerLines.push('', '--- editor selection ---', params.selection.text, '--- end selection ---')
    }
    const ctx = getContextLinesAroundCursor(params.text, params.cursorPos, 10, 10)
    headerLines.push(
      '',
      `--- context (cursor ≈ line ${ctx.cursorLine1} / ${ctx.totalLines}; lines ${ctx.startLine1}-${ctx.endLine1}) ---`,
      ctx.snippet,
      '--- end context ---'
    )
    return headerLines.join('\n')
  }

  private buildEditIntentParseMessage(params: {
    freeform: string
    file: { name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
  }): string {
    const lines = [
      '[ClawEditor /edit → OpenClaw 意图解析]',
      '你只输出一个 JSON 对象，不要 markdown 代码块、不要解释、不要多余文字。',
      '格式：{"version":1,"intent":{"op":"replace_all","scope":"auto","from":"AAA","to":"aaa"}}',
      'intent.op 可为：replace_all、replace_regex、delete_literal、case_lower、case_upper、case_title、trim_trailing、sort_lines、dedupe_lines、remove_empty_lines、remove_blank_lines、insert_at、append、set_document、set_selection、goto_line、clarify、noop；可有 scope:"auto"|"file"|"selection"；replace_all 使用 from/to；replace_regex 使用 pattern/flags/replacement（例如删除所有数字：{"op":"replace_regex","pattern":"\\\\d+","flags":"g","replacement":""}）；delete_literal 使用 needle；insert_at 使用 text 与可选 offset（缺省为光标）；append 使用 text；set_document 使用 text（整篇替换）；set_selection 使用 text（需非空选区，整块选区替换）；goto_line 使用 line。',
      '',
      '用户自然语言编辑请求：',
      params.freeform,
      '',
      `file: ${params.file.name} (${params.file.language})`,
      `path: ${fileNameFromPath(params.file.path)}`,
    ]
    if (params.selection?.text) {
      lines.push('', '--- selection ---', params.selection.text, '--- end selection ---')
    }
    const ctx = getContextLinesAroundCursor(params.text, params.cursorPos, 10, 10)
    lines.push(
      '',
      `--- context (cursor ≈ line ${ctx.cursorLine1} / ${ctx.totalLines}; lines ${ctx.startLine1}-${ctx.endLine1}) ---`,
      ctx.snippet,
      '--- end context ---'
    )
    return lines.join('\n')
  }

  /**
   * Subscribe to a fresh session and send one user message (chat.send with sessions.send fallback).
   */
  private async deliverGatewayMessage(message: string): Promise<void> {
    const sessionKey = `claw-editor:${Date.now()}`
    const key = sessionKey
    const idempotencyKey = this.newIdempotencyKey()

    if (!this.messageSubscribed || this.subscribedSessionId !== sessionKey) {
      try {
        await this.call('sessions.messages.subscribe', { key })
        this.messageSubscribed = true
        this.subscribedSessionId = sessionKey
      } catch {
        // subscription may not be supported, continue anyway
      }
    }

    try {
      await this.call('chat.send', {
        sessionKey,
        message,
        idempotencyKey,
      })
    } catch {
      try {
        try {
          await this.call('sessions.create', { key })
        } catch {
          /* ignore */
        }

        try {
          await this.call('sessions.send', { key, message })
        } catch (e3) {
          const msg = e3 instanceof Error ? e3.message : String(e3)
          if (/session\s+not\s+found/i.test(msg) || /session not found/i.test(msg)) {
            await this.call('sessions.create', { key }).catch(() => {
              /* ignore */
            })
            await this.call('sessions.send', { key, message })
          } else {
            throw e3
          }
        }
      } catch (e2) {
        throw e2
      }
    }
  }

  async sendChatMessage(params: {
    instruction: string
    file: { name: string; language: string; path: string }
    /** Full file text (only used to build a line window around the cursor). */
    text: string
    /** Cursor position in the document (UTF-16 offset); typically selection.anchor. */
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
  }): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接')
    }

    this.activeFilePath = params.file.path
    this.turnBuffer = ''
    this.handlers.clearStreaming?.()
    this.cancelPendingDiffProposal()

    const message = this.buildChatInstructionMessage(params)
    await this.deliverGatewayMessage(message)
  }

  /**
   * `/aiedit`: skill markdown from `skills/aiedit/SKILL.md` + buffer payload. Model should answer with JSON (four local ops) and/or editor diff tool.
   */
  async sendAiEditMessage(params: {
    instruction: string
    file: { name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
    mode: 'full' | 'selection'
  }): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接')
    }

    this.activeFilePath = params.file.path
    this.turnBuffer = ''
    this.handlers.clearStreaming?.()
    this.cancelPendingDiffProposal()

    const message = this.buildLocalSkillGatewayMessage('aiedit', params)
    await this.deliverGatewayMessage(message)
  }

  /** `/aiimport`: skill from `skills/aiimport/SKILL.md`. */
  async sendAiImportMessage(params: {
    instruction: string
    file: { name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
    mode: 'full' | 'selection'
  }): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接')
    }

    this.activeFilePath = params.file.path
    this.turnBuffer = ''
    this.handlers.clearStreaming?.()
    this.cancelPendingDiffProposal()

    const message = this.buildLocalSkillGatewayMessage('aiimport', params)
    await this.deliverGatewayMessage(message)
  }

  private buildLocalSkillGatewayMessage(
    skillId: 'aiedit' | 'aiimport',
    params: {
      instruction: string
      file: { name: string; language: string; path: string }
      text: string
      cursorPos: number
      selection: { text: string; from: number; to: number } | null
      mode: 'full' | 'selection'
    }
  ): string {
    const gatewayPath = fileNameFromPath(params.file.path)
    const skillBody = getSkillMarkdownBody(skillId)

    const lines = [
      '[ClawEditor → OpenClaw Gateway]',
      `[${skillId}]`,
      '',
      skillBody.trim(),
      '',
      `file: ${params.file.name} (${params.file.language})`,
      `path: ${gatewayPath}`,
      '',
      `mode: ${params.mode}`,
      '',
      'instruction:',
      params.instruction,
    ]

    if (params.mode === 'full') {
      lines.push(
        '',
        '--- full document (editor buffer; do not read path from disk) ---',
        params.text,
        '--- end full document ---',
        '',
        'Respond with the JSON intent as described in the skill, or use the editor diff preview tool without writing disk.'
      )
    } else if (params.selection && params.selection.from !== params.selection.to) {
      const sel = params.selection
      lines.push(
        '',
        '--- selection (UTF-16 offsets; replace this range in the full document below) ---',
        `from: ${sel.from}`,
        `to: ${sel.to}`,
        '',
        sel.text,
        '--- end selection ---',
        '',
        'The full document below is the only source of truth (not disk).',
        '',
        '--- full document (editor buffer) ---',
        params.text,
        '--- end full document ---',
        '',
        'Apply the instruction to this selection; output JSON per the skill, or merged full file via the editor diff tool — never write disk.',
      )
      const ctx = getContextLinesAroundCursor(params.text, params.cursorPos, 8, 8)
      lines.push(
        '',
        `--- context (cursor ≈ line ${ctx.cursorLine1} / ${ctx.totalLines}; lines ${ctx.startLine1}-${ctx.endLine1}) ---`,
        ctx.snippet,
        '--- end context ---'
      )
    }

    return lines.join('\n')
  }

  /**
   * When local `/edit` parsing fails: ask the model for EditorIntentV1 JSON, then apply locally.
   */
  async parseEditIntentViaGateway(params: {
    freeform: string
    file: { name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
  }): Promise<{ version: number; intent: unknown }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接')
    }
    if (this.intentParseWaiter) {
      throw new Error('已有意图解析请求进行中，请稍后再试')
    }

    this.activeFilePath = params.file.path
    this.turnBuffer = ''
    this.handlers.clearStreaming?.()
    this.intentParseAcc = ''
    this.cancelPendingDiffProposal()

    const promise = new Promise<string>((resolve, reject) => {
      this.intentParseWaiter = { resolve, reject }
      this.intentParseTimer = window.setTimeout(() => {
        this.rejectIntentParse(new Error('OpenClaw 意图解析超时（60 秒）'))
      }, 60_000)
    })

    const message = this.buildEditIntentParseMessage(params)

    try {
      await this.deliverGatewayMessage(message)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      this.rejectIntentParse(err)
      await promise
    }

    const raw = await promise
    try {
      const parsed = extractJsonObject(raw)
      return parseIntentEnvelope(parsed)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`无法从 OpenClaw 回复解析意图 JSON：${msg}`)
    }
  }

  async disconnect(): Promise<void> {
    this.manualClose = true
    this.stopPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.rejectIntentParse(new Error('WebSocket 已断开'))
    this.cancelPendingDiffProposal()

    // Reject all pending
    this.pending.forEach(({ reject }) => reject(new Error('WebSocket 已断开')))
    this.pending.clear()

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.messageSubscribed = false
    this.subscribedSessionId = null
  }
}
