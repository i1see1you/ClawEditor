import { create } from 'zustand'
import type { OpenClawAction } from '../openclaw/types'
import { OpenClawWsChannel } from '../openclaw/wsChannel'

export type AgentConnection = 'idle' | 'connecting' | 'open' | 'error'

const OPENCLAW_EDIT_TIMEOUT_MS = 10_000
const OPENCLAW_LOCAL_SKILL_TIMEOUT_MS = 120_000
const openclawEditTimeouts = new Map<string, number>()

/** Per-request context for `/aiedit` and `/aiimport` — selection diff metadata for onProposal. */
const pendingLocalSkillContext = new Map<
  string,
  {
    diffMode: 'full' | 'selection'
    selFrom: number
    selTo: number
    fileLen: number
    fileTextSnapshot: string
    fileId?: string
    filePath?: string
    fileName?: string
  }
>()

function clearEditTimeout(requestId?: string) {
  if (!requestId) return
  const t = openclawEditTimeouts.get(requestId)
  if (t !== undefined) {
    window.clearTimeout(t)
    openclawEditTimeouts.delete(requestId)
  }
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface PendingProposal {
  requestId?: string
  newText: string
  title?: string
  summary?: string
  /** Proposal target file identity; used to avoid applying to the wrong active tab. */
  fileId?: string
  filePath?: string
  fileName?: string
  /** When set with selection range, UI may show diff for the selection only. */
  diffMode?: 'full' | 'selection'
  selectionFrom?: number
  selectionTo?: number
}

export interface IncomingParsedIntent {
  requestId?: string
  version: number
  intent: unknown
  fileId?: string
  filePath?: string
  fileName?: string
}

const WS_URL_KEY = 'openclaw.wsUrl'
const GATEWAY_TOKEN_KEY = 'openclaw.gatewayToken'
const GATEWAY_PASSWORD_KEY = 'openclaw.gatewayPassword'

function loadDefaultGatewayUrl(): string {
  if (typeof localStorage === 'undefined') return 'ws://127.0.0.1:18789'
  return localStorage.getItem(WS_URL_KEY) || 'ws://127.0.0.1:18789'
}

function loadDefaultGatewayToken(): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(GATEWAY_TOKEN_KEY) ?? ''
}

function loadDefaultGatewayPassword(): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(GATEWAY_PASSWORD_KEY) ?? ''
}

let wsChannel: OpenClawWsChannel | null = null

let requestCounter = 0
function nextRequestId(): string {
  requestCounter += 1
  return `req-${Date.now()}-${requestCounter}`
}

interface AgentState {
  wsUrl: string
  setWsUrl: (url: string) => void
  /** Must match `gateway.auth.token` / resolved env when the server uses token mode. */
  gatewayToken: string
  setGatewayToken: (token: string) => void
  /** Use when `gateway.auth.mode` is password (or only password is configured). */
  gatewayPassword: string
  setGatewayPassword: (password: string) => void
  connection: AgentConnection
  messages: AgentMessage[]
  streaming: string
  /** When true, suppress assistant final JSON intent echo. */
  suppressAssistantFinalIntentJson: boolean
  pendingProposal: PendingProposal | null
  lastError: string | null
  incomingIntent: IncomingParsedIntent | null
  takeIncomingIntent: () => IncomingParsedIntent | null

  connect: () => Promise<void>
  disconnect: () => Promise<void>
  send: (params: {
    action: OpenClawAction
    instruction: string
    file: { id?: string; name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
  }) => Promise<boolean>
  /** Local /edit failed: ask Gateway for JSON intent, apply with applyParsedIntent. */
  parseEditIntentFallback: (params: {
    freeform: string
    file: { name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
  }) => Promise<{ version: number; intent: unknown }>
  clearProposal: () => void
  setPendingProposal: (p: PendingProposal | null) => void
  appendStreaming: (delta: string) => void
  clearStreaming: () => void
  pushAssistant: (content: string) => void
  pushUser: (content: string) => void
  pushSystem: (content: string) => void
}

function buildOpenClawHandlers(
  set: (
    partial:
      | Partial<AgentState>
      | ((s: AgentState) => Partial<AgentState> | AgentState)
      | AgentState
  ) => void,
  get: () => AgentState
): OpenClawWsChannel['handlers'] {
  return {
    onOpen: () => set({ connection: 'open', lastError: null }),
    onClose: () => set({ connection: 'idle' }),
    onError: () => set({ connection: 'error', lastError: 'WebSocket 连接错误' }),
    onDelta: (delta) => {
      set((s) => ({ streaming: s.streaming + delta }))
    },
    onFinal: (markdown) => {
      const t = markdown.trim()
      if (t.startsWith('{') && t.endsWith('}')) {
        try {
          const obj = JSON.parse(t) as unknown
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            const o = obj as Record<string, unknown>
            const intentObj =
              o.intent && typeof o.intent === 'object' && o.intent !== null && !Array.isArray(o.intent)
                ? (o.intent as Record<string, unknown>)
                : null
            const op =
              (intentObj && typeof intentObj.op === 'string'
                ? intentObj.op
                : typeof o.op === 'string'
                  ? o.op
                  : null) as string | null
            const version = typeof o.version === 'number' ? o.version : 1
            if (op) {
              // If this came from a local skill (/aiedit, /aiimport), try to bind it to the
              // single in-flight request to avoid applying the proposal to the wrong tab.
              let boundRequestId: string | undefined
              let boundFileId: string | undefined
              let boundFilePath: string | undefined
              let boundFileName: string | undefined
              if (pendingLocalSkillContext.size === 1) {
                boundRequestId = pendingLocalSkillContext.keys().next().value as string
                const ctx = pendingLocalSkillContext.get(boundRequestId)
                boundFileId = ctx?.fileId
                boundFilePath = ctx?.filePath
                boundFileName = ctx?.fileName
                clearEditTimeout(boundRequestId)
              }
              // If the assistant outputs an intent JSON envelope, treat it as internal protocol and don't print it.
              set({
                suppressAssistantFinalIntentJson: false,
                streaming: '',
                incomingIntent: {
                  requestId: boundRequestId,
                  version,
                  intent: intentObj ?? o,
                  fileId: boundFileId,
                  filePath: boundFilePath,
                  fileName: boundFileName,
                },
              })
              if (boundRequestId) pendingLocalSkillContext.delete(boundRequestId)
              return
            }
          }
        } catch {
          // ignore parse failures; fall through to normal output
        }
      }

      const mid = `m-${Date.now()}`
      set((s) => ({
        messages: [...s.messages, { id: mid, role: 'assistant' as const, content: markdown }],
        streaming: '',
      }))
    },
    onProposal: ({ requestId, proposal }) => {
      let ctx:
        | {
            diffMode: 'full' | 'selection'
            selFrom: number
            selTo: number
            fileLen: number
            fileTextSnapshot: string
            fileId?: string
            filePath?: string
            fileName?: string
          }
        | undefined

      if (requestId) {
        clearEditTimeout(requestId)
        ctx = pendingLocalSkillContext.get(requestId)
        if (ctx) pendingLocalSkillContext.delete(requestId)
      } else if (pendingLocalSkillContext.size === 1) {
        const rid = pendingLocalSkillContext.keys().next().value as string
        ctx = pendingLocalSkillContext.get(rid)
        clearEditTimeout(rid)
        pendingLocalSkillContext.delete(rid)
      }

      const diffMode: 'full' | 'selection' =
        ctx?.diffMode === 'selection' ? 'selection' : 'full'

      if (ctx?.fileTextSnapshot !== undefined && proposal.newText === ctx.fileTextSnapshot) {
        return
      }

      set({
        pendingProposal: {
          requestId,
          newText: proposal.newText,
          title: proposal.title ?? 'AI 编辑',
          summary: proposal.summary,
          fileId: ctx?.fileId,
          // For tool diff proposals, proposal.summary is typically the path (basename or full).
          filePath:
            ctx?.filePath ??
            (typeof proposal.summary === 'string' && proposal.summary.trim()
              ? proposal.summary.trim()
              : undefined),
          fileName: ctx?.fileName,
          diffMode,
          ...(diffMode === 'selection' && ctx
            ? { selectionFrom: ctx.selFrom, selectionTo: ctx.selTo }
            : {}),
        },
      })
    },
    onParsedIntent: ({ requestId, version, intent }) => {
      clearEditTimeout(requestId)
      set({ incomingIntent: { requestId, version, intent } })
    },
    onIntentError: ({ requestId, code, message }) => {
      clearEditTimeout(requestId)
      if (requestId) pendingLocalSkillContext.delete(requestId)
      if (pendingLocalSkillContext.size === 0) {
        /* noop */
      }
      const codePart = code ? ` [${code}]` : ''
      const idPart = requestId ? ` (${requestId})` : ''
      get().pushSystem(`意图解析失败${codePart}${idPart}: ${message}`)
    },
    clearStreaming: () => set({ streaming: '' }),
    pushSystem: (content) =>
      set((s) => ({
        messages: [...s.messages, { id: `s-${Date.now()}`, role: 'system' as const, content }],
      })),
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  wsUrl: loadDefaultGatewayUrl(),
  setWsUrl: (url) => {
    set({ wsUrl: url })
    if (typeof localStorage !== 'undefined') localStorage.setItem(WS_URL_KEY, url)
  },
  gatewayToken: loadDefaultGatewayToken(),
  setGatewayToken: (token) => {
    set({ gatewayToken: token })
    if (typeof localStorage !== 'undefined') {
      if (token.trim()) localStorage.setItem(GATEWAY_TOKEN_KEY, token)
      else localStorage.removeItem(GATEWAY_TOKEN_KEY)
    }
  },
  gatewayPassword: loadDefaultGatewayPassword(),
  setGatewayPassword: (password) => {
    set({ gatewayPassword: password })
    if (typeof localStorage !== 'undefined') {
      if (password.trim()) localStorage.setItem(GATEWAY_PASSWORD_KEY, password)
      else localStorage.removeItem(GATEWAY_PASSWORD_KEY)
    }
  },
  connection: 'idle',
  messages: [],
  streaming: '',
  suppressAssistantFinalIntentJson: false,
  pendingProposal: null,
  lastError: null,
  incomingIntent: null,
  takeIncomingIntent: () => {
    const p = get().incomingIntent
    if (!p) return null
    set({ incomingIntent: null })
    return p
  },

  connect: async () => {
    await get().disconnect()
    const { wsUrl, gatewayToken, gatewayPassword } = get()
    if (!wsUrl.trim()) {
      set({ lastError: '请填写 Gateway 地址', connection: 'error' })
      return
    }
    set({ connection: 'connecting', lastError: null })

    try {
      const h = buildOpenClawHandlers(set, get)
      wsChannel = new OpenClawWsChannel(wsUrl.trim(), h, {
        gatewayToken: gatewayToken,
        gatewayPassword: gatewayPassword,
      })
      await wsChannel.connect()
    } catch (e) {
      wsChannel = null
      set({
        connection: 'error',
        lastError: e instanceof Error ? e.message : String(e),
      })
    }
  },

  disconnect: async () => {
    const c = wsChannel
    wsChannel = null
    if (c) {
      await c.disconnect().catch(() => {
        /* ignore */
      })
    }
    set({ connection: 'idle' })
  },

  send: async ({
    action,
    instruction,
    file,
    text,
    cursorPos,
    selection,
  }) => {
    const id = nextRequestId()
    const c = wsChannel
    if (!c) {
      set({ lastError: '未连接，请先连接 OpenClaw Gateway' })
      return false
    }

    set(() => ({
      streaming: '',
      lastError: null,
    }))

    if (action === 'edit') {
      clearEditTimeout(id)
      const timer = window.setTimeout(() => {
        if (openclawEditTimeouts.get(id) === timer) {
          openclawEditTimeouts.delete(id)
          get().pushSystem(
            `OpenClaw 命令执行超时（${OPENCLAW_EDIT_TIMEOUT_MS / 1000}秒）：${instruction}`
          )
        }
      }, OPENCLAW_EDIT_TIMEOUT_MS)
      openclawEditTimeouts.set(id, timer)
    }

    const localSkill = action === 'aiedit' || action === 'aiimport'
    if (localSkill) {
      const hasSel = Boolean(selection && selection.from !== selection.to)
      pendingLocalSkillContext.set(id, {
        diffMode: hasSel ? 'selection' : 'full',
        selFrom: hasSel ? selection!.from : 0,
        selTo: hasSel ? selection!.to : 0,
        fileLen: text.length,
        fileTextSnapshot: text,
        fileId: file.id,
        filePath: file.path,
        fileName: file.name,
      })
      clearEditTimeout(id)
      const label = action === 'aiedit' ? '/aiedit' : '/aiimport'
      const timer = window.setTimeout(() => {
        if (openclawEditTimeouts.get(id) === timer) {
          openclawEditTimeouts.delete(id)
          pendingLocalSkillContext.delete(id)
          get().pushSystem(
            `OpenClaw ${label} 超时（${OPENCLAW_LOCAL_SKILL_TIMEOUT_MS / 1000} 秒）：${instruction}`
          )
        }
      }, OPENCLAW_LOCAL_SKILL_TIMEOUT_MS)
      openclawEditTimeouts.set(id, timer)
    }

    try {
      if (action === 'aiedit' || action === 'aiimport') {
        const hasSel = Boolean(selection && selection.from !== selection.to)
        const shared = {
          instruction,
          file,
          text,
          cursorPos,
          selection,
          mode: hasSel ? ('selection' as const) : ('full' as const),
        }
        if (action === 'aiedit') {
          await c.sendAiEditMessage(shared)
        } else {
          await c.sendAiImportMessage(shared)
        }
      } else {
        await c.sendChatMessage({ instruction, file, text, cursorPos, selection })
      }
    } catch (e) {
      clearEditTimeout(id)
      if (localSkill) {
        pendingLocalSkillContext.delete(id)
      }
      const msg = e instanceof Error ? e.message : String(e)
      set({ lastError: `发送失败: ${msg}` })
      return false
    } finally {
      if (!localSkill) {
        clearEditTimeout(id)
      }
    }
    return true
  },

  parseEditIntentFallback: async (params) => {
    const c = wsChannel
    if (!c) {
      throw new Error('未连接 OpenClaw Gateway')
    }
    set({ suppressAssistantFinalIntentJson: true })
    try {
      return await c.parseEditIntentViaGateway(params)
    } finally {
      set({ suppressAssistantFinalIntentJson: false })
    }
  },

  clearProposal: () => set({ pendingProposal: null }),
  setPendingProposal: (p) => set({ pendingProposal: p }),

  appendStreaming: (delta) => set((s) => ({ streaming: s.streaming + delta })),
  clearStreaming: () => set({ streaming: '' }),
  pushAssistant: (content) =>
    set((s) => ({
      messages: [...s.messages, { id: `a-${Date.now()}`, role: 'assistant' as const, content }],
    })),
  pushUser: (content) =>
    set((s) => ({
      messages: [...s.messages, { id: `u-${Date.now()}`, role: 'user' as const, content }],
    })),
  pushSystem: (content) =>
    set((s) => ({
      messages: [...s.messages, { id: `s-${Date.now()}`, role: 'system' as const, content }],
    })),
}))
