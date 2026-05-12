import { create } from 'zustand'
import type { OpenClawAction } from '../openclaw/types'
import { OpenClawWsChannel } from '../openclaw/wsChannel'
import { getSkillDef } from '../skills/skillRegistry'
import { runRemoteEditorCommand } from '../agent/remoteCommandBridge'

export type AgentConnection = 'idle' | 'connecting' | 'open' | 'error'

const OPENCLAW_EDIT_TIMEOUT_MS = 10_000
const OPENCLAW_LOCAL_SKILL_TIMEOUT_MS = 120_000
const openclawEditTimeouts = new Map<string, number>()

/** Monotonic suffix so message ids stay unique when multiple append in the same ms. */
let agentMessageSeq = 0
function nextAgentMessageId(prefix: string): string {
  agentMessageSeq += 1
  return `${prefix}-${Date.now()}-${agentMessageSeq}`
}

/** Dim timestamp prefix for Agent output system lines (local wall clock). */
function formatAgentSystemLogPrefix(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return `\x1b[90m[${ts}]\x1b[0m `
}

/** FIFO: store `send()` request ids so JSON/tool results bind to the correct in-flight turn when several overlap. */
const skillIntentBindQueue: string[] = []

function removeSkillIntentBindQueueEntry(requestId: string) {
  const i = skillIntentBindQueue.indexOf(requestId)
  if (i >= 0) skillIntentBindQueue.splice(i, 1)
}

/** Remote explain → JSON intent: FIFO meta captured in AgentPanel before gateway send (full-file hash). */
export interface RemoteIntentPipelineMeta {
  correlationId: string
  sessionKey?: string
  channel?: string
  deliveryId?: string
  pipelineStartMs: number
  originalCommand?: string
  /** Full-document djb2 hash at snapshot (before model). */
  baseContentHash: number
}

const remoteIntentPipelineQueue: RemoteIntentPipelineMeta[] = []

export function enqueueRemoteIntentPipeline(meta: RemoteIntentPipelineMeta) {
  remoteIntentPipelineQueue.push(meta)
}

export function takeRemoteIntentPipeline(): RemoteIntentPipelineMeta | undefined {
  return remoteIntentPipelineQueue.shift()
}

export function discardRemoteIntentPipelineByCorrelation(correlationId: string) {
  const i = remoteIntentPipelineQueue.findIndex((m) => m.correlationId === correlationId)
  if (i >= 0) remoteIntentPipelineQueue.splice(i, 1)
}

/** Per-request context for local skill flows — selection diff metadata for onProposal. */
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
    /** Set for local `action: 'skill'` requests (e.g. bind intent UI to /aicorrect). */
    skillId?: string
    /** When Channel-originated skill/explain shares this outbound id. */
    pipelineMeta?: RemoteIntentPipelineMeta
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
  /** Required. 'local-xxx' for editor commands, deliveryId for Channel commands. */
  requestId: string
  /** Channel deliveryId — used by /confirm <id> for precise matching. */
  deliveryId?: string
  /** Channel session key — for sendCommandStatus callbacks. */
  sessionKey?: string
  /** Channel id — for /confirm (no-arg) "most recent" lookup. */
  channel?: string
  /** Date.now() when proposal was created — TTL start + /confirm no-arg sort key. */
  proposalCreatedAt: number
  /** djb2 hash of file content when command was issued. Used for stale-check on apply. */
  baseContentHash?: number
  /** Original command string — used to re-run when stale check fails (editor side). */
  originalCommand?: string
  /** correlationId from the accepted audit row — carried to confirm/cancel audit rows. */
  correlationId?: string
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
  /** When set, proposal dialog uses interactive side-by-side diff (e.g. /aicorrect). */
  proposalDiffVariant?: 'side_by_side_interactive'
  /**
   * When set, this proposal originated from a remote Channel command.
   * The diff is sent to this session key for confirmation; the editor popup is suppressed.
   */
  remoteSessionKey?: string
  /** Channel pipeline start (accepted) for duration in status messages. */
  remotePipelineStartMs?: number
}

export interface IncomingParsedIntent {
  requestId?: string
  version: number
  intent: unknown
  fileId?: string
  filePath?: string
  fileName?: string
  /** Present when intent was bound to a single in-flight local skill request. */
  skillId?: string
  /** Dequeued with this JSON intent when explain path was remote-originated. */
  remotePipeline?: RemoteIntentPipelineMeta
}

const WS_URL_KEY = 'openclaw.wsUrl'
const GATEWAY_TOKEN_KEY = 'openclaw.gatewayToken'
const GATEWAY_PASSWORD_KEY = 'openclaw.gatewayPassword'
const REMOTE_EDIT_RECEIVE_KEY = 'openclaw.remoteEditReceive'

function loadRemoteEditReceivePreference(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(REMOTE_EDIT_RECEIVE_KEY) === '1'
}

function persistRemoteEditReceive(enabled: boolean) {
  if (typeof localStorage === 'undefined') return
  if (enabled) localStorage.setItem(REMOTE_EDIT_RECEIVE_KEY, '1')
  else localStorage.removeItem(REMOTE_EDIT_RECEIVE_KEY)
}

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

/** Tracks the sessionKey of the most recent remote command for lease-lost notifications. */
let lastRemoteSessionKey: string | null = null

/** djb2 hash — fast, dependency-free, sufficient for stale-content detection. */
export function hashContent(text: string): number {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i)
    h = h >>> 0
  }
  return h
}

/** TTL timers for pending proposals. Cleared when proposal is resolved. */
const proposalTtlTimers = new Map<string, ReturnType<typeof setTimeout>>()

const PROPOSAL_TTL_MS = 5 * 60 * 1000
const PROPOSAL_MAX_COUNT = 10

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
  /** Receive channel /edit-style commands via Gateway plugin (single holder per Gateway). */
  remoteEditReceive: boolean
  setRemoteEditReceive: (enabled: boolean) => Promise<void>
  connection: AgentConnection
  messages: AgentMessage[]
  streaming: string
  /** When true, suppress assistant final JSON intent echo. */
  suppressAssistantFinalIntentJson: boolean
  pendingProposals: Map<string, PendingProposal>
  activeProposalId: string | null
  lastError: string | null
  incomingIntent: IncomingParsedIntent | null
  takeIncomingIntent: () => IncomingParsedIntent | null

  connect: () => Promise<void>
  disconnect: () => Promise<void>
  send: (params: {
    action: OpenClawAction
    skillId?: string
    instruction: string
    file: { id?: string; name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
    /** When set, used for tool/JSON binding and optional Channel pipeline meta. */
    requestId?: string
    pipelineMeta?: RemoteIntentPipelineMeta
  }) => Promise<boolean>
  /** Local /edit failed: ask Gateway for JSON intent, apply with applyParsedIntent. */
  parseEditIntentFallback: (params: {
    freeform: string
    file: { name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
  }) => Promise<{ version: number; intent: unknown }>
  parseFindIntentFallback: (params: {
    freeform: string
    file: { name: string; language: string; path: string }
    text: string
    cursorPos: number
    selection: { text: string; from: number; to: number } | null
  }) => Promise<{ version: number; intent: unknown }>
  clearProposal: (requestId: string) => void
  clearAllProposals: () => void
  /** Clear only Channel-originated proposals (deliveryId present); keep local ones. */
  clearChannelProposals: () => void
  setPendingProposal: (p: PendingProposal) => void
  setActiveProposalId: (id: string | null) => void
  appendStreaming: (delta: string) => void
  clearStreaming: () => void
  pushAssistant: (content: string) => void
  pushUser: (content: string) => void
  pushSystem: (content: string) => void
  /** Send a plain-text status message back to a Channel session (best-effort). */
  sendCommandStatus: (sessionKey: string, text: string) => void
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
    onClose: () => {
      get().clearChannelProposals()
      set({ connection: 'idle' })
    },
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
            const intentArr =
              Array.isArray(o.intent) && o.intent.length > 0 && typeof o.version === 'number' && o.version === 1
                ? o.intent
                : null
            const intentObj =
              o.intent && typeof o.intent === 'object' && o.intent !== null && !Array.isArray(o.intent)
                ? (o.intent as Record<string, unknown>)
                : null
            const op = intentArr
              ? typeof (intentArr[0] as Record<string, unknown>)?.op === 'string'
                ? String((intentArr[0] as Record<string, unknown>).op)
                : null
              : (intentObj && typeof intentObj.op === 'string'
                  ? intentObj.op
                  : typeof o.op === 'string'
                    ? o.op
                    : null)
            const version = typeof o.version === 'number' ? o.version : 1
            if (op) {
              // Bind JSON intent to the correct in-flight skill/explain turn (FIFO when several overlap).
              let boundRequestId: string | undefined
              let boundFileId: string | undefined
              let boundFilePath: string | undefined
              let boundFileName: string | undefined
              let boundSkillId: string | undefined
              while (skillIntentBindQueue.length > 0 && !boundRequestId) {
                const cand = skillIntentBindQueue[0]!
                const ctxPeek = pendingLocalSkillContext.get(cand)
                if (ctxPeek) {
                  boundRequestId = skillIntentBindQueue.shift()!
                  const ctx = pendingLocalSkillContext.get(boundRequestId)
                  boundFileId = ctx?.fileId
                  boundFilePath = ctx?.filePath
                  boundFileName = ctx?.fileName
                  boundSkillId = ctx?.skillId
                  clearEditTimeout(boundRequestId)
                } else {
                  skillIntentBindQueue.shift()
                }
              }
              if (!boundRequestId && pendingLocalSkillContext.size === 1) {
                boundRequestId = pendingLocalSkillContext.keys().next().value as string
                const ctx = pendingLocalSkillContext.get(boundRequestId)
                boundFileId = ctx?.fileId
                boundFilePath = ctx?.filePath
                boundFileName = ctx?.fileName
                boundSkillId = ctx?.skillId
                clearEditTimeout(boundRequestId)
              }
              const remotePipeline = takeRemoteIntentPipeline()
              // Print raw JSON for debugging (command output window).
              const debugId = nextAgentMessageId('dbg-intent')
              set((s) => ({
                suppressAssistantFinalIntentJson: false,
                streaming: '',
                messages: [
                  ...s.messages,
                  {
                    id: debugId,
                    role: 'system' as const,
                    content: `OpenClaw intent JSON:\n${t}`,
                  },
                ],
                incomingIntent: {
                  requestId: boundRequestId,
                  version,
                  intent: intentArr ?? intentObj ?? o,
                  fileId: boundFileId,
                  filePath: boundFilePath,
                  fileName: boundFileName,
                  skillId: boundSkillId,
                  remotePipeline,
                },
              }))
              if (boundRequestId) pendingLocalSkillContext.delete(boundRequestId)
              return
            }
          }
        } catch {
          if (remoteIntentPipelineQueue.length > 0) {
            remoteIntentPipelineQueue.shift()
          }
          // ignore parse failures; fall through to normal output
        }
      }

      if (remoteIntentPipelineQueue.length > 0 && !t.trim().startsWith('{')) {
        remoteIntentPipelineQueue.shift()
      }

      const mid = nextAgentMessageId('m')
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
            pipelineMeta?: RemoteIntentPipelineMeta
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

      const baseContentHash =
        ctx?.fileTextSnapshot !== undefined ? hashContent(ctx.fileTextSnapshot) : undefined

      const pm = ctx?.pipelineMeta
      get().setPendingProposal({
        requestId: requestId ?? `proposal-${Date.now()}`,
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
        remoteSessionKey: pm?.sessionKey,
        sessionKey: pm?.sessionKey,
        channel: pm?.channel,
        deliveryId: pm?.deliveryId,
        correlationId: pm?.correlationId,
        originalCommand: pm?.originalCommand,
        remotePipelineStartMs: pm?.pipelineStartMs,
        baseContentHash,
        proposalCreatedAt: Date.now(),
      })
    },
    onParsedIntent: ({ requestId, version, intent }) => {
      clearEditTimeout(requestId)
      set({ incomingIntent: { requestId, version, intent } })
    },
    onIntentError: ({ requestId, code, message }) => {
      clearEditTimeout(requestId)
      if (requestId) {
        removeSkillIntentBindQueueEntry(requestId)
        pendingLocalSkillContext.delete(requestId)
      }
      if (pendingLocalSkillContext.size === 0) {
        /* noop */
      }
      const codePart = code ? ` [${code}]` : ''
      const idPart = requestId ? ` (${requestId})` : ''
      get().pushSystem(`意图解析失败${codePart}${idPart}: ${message}`)
    },
    clearStreaming: () => set({ streaming: '' }),
    pushSystem: (content) => get().pushSystem(content),
    onRemoteCommand: (line, meta) => {
      if (meta.sessionKey) {
        lastRemoteSessionKey = meta.sessionKey
      }
      const ran = runRemoteEditorCommand(line, meta)
      if (!ran) {
        get().pushSystem(
          '收到远程编辑器命令，但 Agent 面板未就绪。请打开主界面中的 Agent 面板后再从 Channel 发送命令。'
        )
      }
    },
    onRemoteEditHoldLost: () => {
      persistRemoteEditReceive(false)
      set({ remoteEditReceive: false })
      get().pushSystem(
        '远程编辑接收已失效（连接断开、租约过期或其他会话占用）。如需继续接收频道命令，请重新勾选「开启远程编辑」。'
      )
      // Notify the last known Channel session that the lease is gone.
      if (lastRemoteSessionKey && wsChannel) {
        void wsChannel.sendCommandStatus(
          lastRemoteSessionKey,
          '[ClawEditor] 远程编辑租约已失效，后续命令将无法执行，请重新开启远程编辑。'
        )
      }
    },
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
  remoteEditReceive: loadRemoteEditReceivePreference(),
  setRemoteEditReceive: async (enabled: boolean) => {
    const c = wsChannel
    if (!enabled) {
      if (c && get().connection === 'open') {
        await c.releaseRemoteEditReceive().catch(() => {})
      }
      persistRemoteEditReceive(false)
      set({ remoteEditReceive: false })
      return
    }
    persistRemoteEditReceive(true)
    set({ remoteEditReceive: true })
    if (c && get().connection === 'open') {
      try {
        await c.claimRemoteEditReceive()
      } catch (e) {
        persistRemoteEditReceive(false)
        set({ remoteEditReceive: false })
        throw e instanceof Error ? e : new Error(String(e))
      }
    }
  },
  connection: 'idle',
  messages: [],
  streaming: '',
  suppressAssistantFinalIntentJson: false,
  pendingProposals: new Map(),
  activeProposalId: null,
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
      if (wsChannel && get().remoteEditReceive) {
        try {
          await wsChannel.claimRemoteEditReceive()
        } catch (e) {
          persistRemoteEditReceive(false)
          const msg = e instanceof Error ? e.message : String(e)
          set({ remoteEditReceive: false })
          get().pushSystem(`开启远程编辑失败：${msg}`)
        }
      }
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
    if (c && get().remoteEditReceive) {
      try {
        await c.releaseRemoteEditReceive()
      } catch {
        /* ignore */
      }
    }
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
    skillId,
    instruction,
    file,
    text,
    cursorPos,
    selection,
    requestId: requestIdParam,
    pipelineMeta,
  }) => {
    const id = requestIdParam ?? nextRequestId()
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

    const localSkill = action === 'skill'
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
        skillId: skillId ?? undefined,
        ...(pipelineMeta ? { pipelineMeta } : {}),
      })
      skillIntentBindQueue.push(id)
      clearEditTimeout(id)
      const label = skillId ? `/${skillId}` : '/skill'
      const timer = window.setTimeout(() => {
        if (openclawEditTimeouts.get(id) === timer) {
          openclawEditTimeouts.delete(id)
          removeSkillIntentBindQueueEntry(id)
          pendingLocalSkillContext.delete(id)
          get().pushSystem(
            `OpenClaw ${label} 超时（${OPENCLAW_LOCAL_SKILL_TIMEOUT_MS / 1000} 秒）：${instruction}`
          )
        }
      }, OPENCLAW_LOCAL_SKILL_TIMEOUT_MS)
      openclawEditTimeouts.set(id, timer)
    }

    try {
      if (action === 'skill') {
        if (!skillId) throw new Error('缺少 skillId')
        const def = getSkillDef(skillId)
        if (!def) throw new Error(`未知 skill: ${skillId}`)
        if (def.kind !== 'local_intent_four_op') {
          await c.sendChatMessage({ instruction, file, text, cursorPos, selection, requestId: id })
          return true
        }
        const hasSel = Boolean(selection && selection.from !== selection.to)
        const shared = {
          instruction,
          file,
          text,
          cursorPos,
          selection,
          mode: hasSel ? ('selection' as const) : ('full' as const),
        }
        await c.sendLocalSkillMessage(skillId, shared)
      } else {
        await c.sendChatMessage({ instruction, file, text, cursorPos, selection, requestId: id })
      }
    } catch (e) {
      clearEditTimeout(id)
      if (localSkill) {
        removeSkillIntentBindQueueEntry(id)
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

  parseFindIntentFallback: async (params) => {
    const c = wsChannel
    if (!c) {
      throw new Error('未连接 OpenClaw Gateway')
    }
    set({ suppressAssistantFinalIntentJson: true })
    try {
      return await c.parseFindIntentViaGateway(params)
    } finally {
      set({ suppressAssistantFinalIntentJson: false })
    }
  },

  clearProposal: (requestId: string) => {
    // Clear TTL timer
    const t = proposalTtlTimers.get(requestId)
    if (t !== undefined) { clearTimeout(t); proposalTtlTimers.delete(requestId) }
    set((s) => {
      const next = new Map(s.pendingProposals)
      next.delete(requestId)
      // Advance activeProposalId to the earliest remaining proposal
      let nextActiveId: string | null = s.activeProposalId
      if (s.activeProposalId === requestId) {
        nextActiveId = null
        let earliest = Infinity
        for (const [id, p] of next) {
          if (p.proposalCreatedAt < earliest) { earliest = p.proposalCreatedAt; nextActiveId = id }
        }
      }
      return { pendingProposals: next, activeProposalId: nextActiveId }
    })
  },

  clearAllProposals: () => {
    for (const [id, t] of proposalTtlTimers) { clearTimeout(t); proposalTtlTimers.delete(id) }
    set({ pendingProposals: new Map(), activeProposalId: null })
  },

  clearChannelProposals: () => {
    set((s) => {
      const next = new Map(s.pendingProposals)
      for (const [id, p] of next) {
        if (p.deliveryId !== undefined) {
          const t = proposalTtlTimers.get(id)
          if (t !== undefined) { clearTimeout(t); proposalTtlTimers.delete(id) }
          next.delete(id)
        }
      }
      let nextActiveId = s.activeProposalId
      if (nextActiveId && !next.has(nextActiveId)) {
        nextActiveId = null
        let earliest = Infinity
        for (const [id, p] of next) {
          if (p.proposalCreatedAt < earliest) { earliest = p.proposalCreatedAt; nextActiveId = id }
        }
      }
      return { pendingProposals: next, activeProposalId: nextActiveId }
    })
  },

  setPendingProposal: (p: PendingProposal) => {
    const state = get()
    if (state.pendingProposals.size >= PROPOSAL_MAX_COUNT) {
      // Notify Channel if applicable
      if (p.sessionKey && wsChannel) {
        void wsChannel.sendCommandStatus(
          p.sessionKey,
          '[ClawEditor] 待确认提案过多，请先处理现有提案后再发送命令'
        )
      }
      state.pushSystem('待确认提案已达上限（10 条），请先处理现有提案。')
      return
    }
    // Register TTL timer
    const ttlTimer = setTimeout(() => {
      proposalTtlTimers.delete(p.requestId)
      const current = get().pendingProposals.get(p.requestId)
      if (!current) return
      if (current.sessionKey && wsChannel) {
        void wsChannel.sendCommandStatus(
          current.sessionKey,
          `[ClawEditor] ${current.originalCommand ?? ''} → 提案已过期（5 分钟未确认）`.trim()
        )
      }
      get().clearProposal(p.requestId)
    }, PROPOSAL_TTL_MS)
    proposalTtlTimers.set(p.requestId, ttlTimer)
    set((s) => {
      const next = new Map(s.pendingProposals)
      next.set(p.requestId, p)
      const activeId = s.activeProposalId ?? p.requestId
      return { pendingProposals: next, activeProposalId: activeId }
    })
  },

  setActiveProposalId: (id: string | null) => set({ activeProposalId: id }),

  appendStreaming: (delta) => set((s) => ({ streaming: s.streaming + delta })),
  clearStreaming: () => set({ streaming: '' }),
  pushAssistant: (content) =>
    set((s) => ({
      messages: [...s.messages, { id: nextAgentMessageId('a'), role: 'assistant' as const, content }],
    })),
  pushUser: (content) =>
    set((s) => ({
      messages: [...s.messages, { id: nextAgentMessageId('u'), role: 'user' as const, content }],
    })),
  pushSystem: (content) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: nextAgentMessageId('s'),
          role: 'system' as const,
          content: formatAgentSystemLogPrefix() + content,
        },
      ],
    })),
  sendCommandStatus: (sessionKey, text) => {
    if (wsChannel) void wsChannel.sendCommandStatus(sessionKey, text)
  },
}))
