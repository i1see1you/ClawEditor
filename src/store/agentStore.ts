import { create } from 'zustand'
import type { OpenClawAction } from '../openclaw/types'
import { OpenClawWsChannel } from '../openclaw/wsChannel'
import {
  extractDocumentFromAssistantMarkdown,
  mergeAiEditExtractWithSnapshot,
} from '../utils/aiEditExtract'

export type AgentConnection = 'idle' | 'connecting' | 'open' | 'error'

const OPENCLAW_EDIT_TIMEOUT_MS = 10_000
const OPENCLAW_AIEDIT_TIMEOUT_MS = 120_000
const openclawEditTimeouts = new Map<string, number>()

/** Per-request context so onProposal can attach selection diff metadata for `/aiedit`. */
const pendingAiEditContext = new Map<
  string,
  {
    diffMode: 'full' | 'selection'
    selFrom: number
    selTo: number
    fileLen: number
    /** Snapshot at send time — used when assistant returns text instead of tool diff. */
    fileTextSnapshot: string
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
  /** When set with selection range, UI may show diff for the selection only. */
  diffMode?: 'full' | 'selection'
  selectionFrom?: number
  selectionTo?: number
}

export interface IncomingParsedIntent {
  requestId?: string
  version: number
  intent: unknown
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
  /** True after `/aiedit` send succeeds until proposal or assistant fallback consumes it. */
  aiEditAwaitingTextFallback: boolean
  /** Concatenate assistant `onFinal` chunks until extract yields a complete fenced file (avoids early wrong diff). */
  aiEditAccumulatedAssistantMarkdown: string

  connect: () => Promise<void>
  disconnect: () => Promise<void>
  send: (params: {
    action: OpenClawAction
    instruction: string
    file: { name: string; language: string; path: string }
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

function tryConsumeAiEditProposalFromAssistantMarkdown(
  markdown: string,
  get: () => AgentState
): PendingProposal | null {
  if (!get().aiEditAwaitingTextFallback) return null
  if (pendingAiEditContext.size !== 1) return null

  const rid = [...pendingAiEditContext.keys()][0]
  const ctx = pendingAiEditContext.get(rid)
  if (!ctx?.fileTextSnapshot) return null

  const extracted = extractDocumentFromAssistantMarkdown(markdown)
  if (!extracted) return null

  // Guard against early extraction of unrelated fenced blocks (e.g. sender metadata).
  // For /aiedit fallback, require a strong signal that the assistant actually provided the
  // merged document, otherwise keep waiting for later chunks.
  const hasStrongMarker = /\bNewText:\s*/.test(markdown) || /\bnewText:\s*\|\s*\n/.test(markdown)
  if (!hasStrongMarker && extracted.length < Math.max(32, ctx.fileTextSnapshot.length / 3)) {
    return null
  }

  const newFull = mergeAiEditExtractWithSnapshot(ctx.fileTextSnapshot, ctx, extracted)
  if (newFull === ctx.fileTextSnapshot) return null

  clearEditTimeout(rid)
  pendingAiEditContext.delete(rid)

  const diffMode = ctx.diffMode === 'selection' ? 'selection' : 'full'
  return {
    newText: newFull,
    title: 'AI 编辑',
    summary: '来自助手最终回复（未走 Gateway diff 工具），请确认后再应用',
    diffMode,
    ...(diffMode === 'selection' ? { selectionFrom: ctx.selFrom, selectionTo: ctx.selTo } : {}),
  }
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
              // If the assistant outputs an intent JSON envelope, treat it as internal protocol and don't print it.
              set({
                suppressAssistantFinalIntentJson: false,
                streaming: '',
                incomingIntent: { version, intent: intentObj ?? o },
              })
              return
            }
          }
        } catch {
          // ignore parse failures; fall through to normal output
        }
      }

      const aiAwait = get().aiEditAwaitingTextFallback && pendingAiEditContext.size === 1
      let mergedForAiEdit = markdown
      if (aiAwait) {
        const prev = get().aiEditAccumulatedAssistantMarkdown
        mergedForAiEdit = prev ? `${prev}\n\n${markdown}` : markdown
        set({ aiEditAccumulatedAssistantMarkdown: mergedForAiEdit })
      }

      const aiProposal = tryConsumeAiEditProposalFromAssistantMarkdown(mergedForAiEdit, get)
      if (aiProposal) {
        set((s) => ({
          streaming: '',
          aiEditAwaitingTextFallback: false,
          aiEditAccumulatedAssistantMarkdown: '',
          pendingProposal: aiProposal,
          messages: [
            ...s.messages,
            {
              id: `s-${Date.now()}`,
              role: 'system' as const,
              content: '已生成 AI 修改提案，请在弹窗中确认 diff 后再点击「应用修改」。',
            },
          ],
        }))
        return
      }

      const mid = `m-${Date.now()}`
      set((s) => ({
        messages: [...s.messages, { id: mid, role: 'assistant' as const, content: markdown }],
        streaming: '',
      }))
    },
    onProposal: ({ requestId, proposal }) => {
      // Tool diff payloads often omit requestId; pair with the single pending /aiedit row
      // so the 120s timer clears and selection diff metadata applies.
      let ctx:
        | {
            diffMode: 'full' | 'selection'
            selFrom: number
            selTo: number
            fileLen: number
            fileTextSnapshot: string
          }
        | undefined

      if (requestId) {
        clearEditTimeout(requestId)
        ctx = pendingAiEditContext.get(requestId)
        if (ctx) pendingAiEditContext.delete(requestId)
      } else if (pendingAiEditContext.size === 1) {
        const rid = pendingAiEditContext.keys().next().value as string
        ctx = pendingAiEditContext.get(rid)
        clearEditTimeout(rid)
        pendingAiEditContext.delete(rid)
      }

      const diffMode: 'full' | 'selection' =
        ctx?.diffMode === 'selection' ? 'selection' : 'full'

      if (ctx?.fileTextSnapshot !== undefined && proposal.newText === ctx.fileTextSnapshot) {
        set({ aiEditAwaitingTextFallback: false, aiEditAccumulatedAssistantMarkdown: '' })
        return
      }

      set({
        aiEditAwaitingTextFallback: false,
        aiEditAccumulatedAssistantMarkdown: '',
        pendingProposal: {
          requestId,
          newText: proposal.newText,
          title: proposal.title ?? 'AI 编辑',
          summary: proposal.summary,
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
      if (requestId) pendingAiEditContext.delete(requestId)
      if (pendingAiEditContext.size === 0) {
        set({ aiEditAwaitingTextFallback: false, aiEditAccumulatedAssistantMarkdown: '' })
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
  aiEditAwaitingTextFallback: false,
  aiEditAccumulatedAssistantMarkdown: '',
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

    const userLine = `[${action}] ${instruction}`
    set((s) => ({
      messages: [...s.messages, { id: `u-${id}`, role: 'user' as const, content: userLine }],
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

    if (action === 'aiedit') {
      set({ aiEditAccumulatedAssistantMarkdown: '' })
      const hasSel = Boolean(selection && selection.from !== selection.to)
      pendingAiEditContext.set(id, {
        diffMode: hasSel ? 'selection' : 'full',
        selFrom: hasSel ? selection!.from : 0,
        selTo: hasSel ? selection!.to : 0,
        fileLen: text.length,
        fileTextSnapshot: text,
      })
      clearEditTimeout(id)
      const timer = window.setTimeout(() => {
        if (openclawEditTimeouts.get(id) === timer) {
          openclawEditTimeouts.delete(id)
          pendingAiEditContext.delete(id)
          set({ aiEditAwaitingTextFallback: false, aiEditAccumulatedAssistantMarkdown: '' })
          get().pushSystem(
            `OpenClaw /aiedit 超时（${OPENCLAW_AIEDIT_TIMEOUT_MS / 1000} 秒）：${instruction}`
          )
        }
      }, OPENCLAW_AIEDIT_TIMEOUT_MS)
      openclawEditTimeouts.set(id, timer)
    }

    try {
      if (action === 'aiedit') {
        const hasSel = Boolean(selection && selection.from !== selection.to)
        await c.sendAiEditMessage({
          instruction,
          file,
          text,
          cursorPos,
          selection,
          mode: hasSel ? 'selection' : 'full',
        })
      } else {
        await c.sendChatMessage({ instruction, file, text, cursorPos, selection })
      }
    } catch (e) {
      clearEditTimeout(id)
      if (action === 'aiedit') {
        pendingAiEditContext.delete(id)
        set({ aiEditAwaitingTextFallback: false, aiEditAccumulatedAssistantMarkdown: '' })
      }
      const msg = e instanceof Error ? e.message : String(e)
      get().pushSystem(`发送失败: ${msg}`)
      set({ lastError: msg })
      return false
    } finally {
      if (action !== 'aiedit') {
        clearEditTimeout(id)
      }
    }
    if (action === 'aiedit') {
      set({ aiEditAwaitingTextFallback: true })
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
      // If it didn't get consumed by onFinal filter, release it anyway.
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
