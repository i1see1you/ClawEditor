import { useEffect, useRef, useMemo, useCallback, useState } from 'react'
import { computeSelectionDiffSlices } from '../utils/selectionMergeDiff'
import { buildSideBySideRows, mergeLinesByAdoption } from '../utils/lineAlignedPartialMerge'
import { selectionProposalFieldsFromReplaceSelectionIntent } from '../utils/pendingProposalSelectionDiff'
import {
  useAgentStore,
  hashContent,
  enqueueRemoteIntentPipeline,
  discardRemoteIntentPipelineByCorrelation,
} from '../store/agentStore'
import { useEditorStore } from '../store/editorStore'
import { useFileStore } from '../store/fileStore'
import type { FileTab } from '../types'
import { TextDiffView } from './TextDiffView'
import { AgentChatInput } from './AgentChatInput'
import { getEditReplaceParamHint } from './agentCommandPalette'
import type { OpenClawAction } from '../openclaw/types'
import { applyParsedIntent, type ApplyIntentResult } from '../openclaw/applyIntent'
import { gotoLineInEditor } from '../utils/gotoLine'
import { parseLocalFind } from '../utils/findCommand'
import { applyFindInEditor } from '../utils/applyFindInEditor'
import { parseSimpleEditInstruction } from '../utils/simpleCommands'
import { applyDeleteMatchingLines, mergeRange } from '../utils/documentOps'
import { parseEditDropMatchingPayload } from '../utils/parseEditDropMatching'
import {
  MAX_INSERT_CHARS,
  tryParseInsertAppendBody,
} from '../utils/parseEditInsertAppend'
import { open } from '@tauri-apps/plugin-dialog'
import { stat } from '@tauri-apps/plugin-fs'
import { getClaweditorConfigForSkill, validateClaweditorConfig } from '../skills/claweditorConfig'
import { runSkillCompletions } from '../skills/completionEngine'
import { getSkillDef, getSkillHelpText } from '../skills/skillRegistry'
import { getCommandHintText } from '../commands/registry'
import { setRemoteCommandExecutor } from '../agent/remoteCommandBridge'
import {
  appendAuditLog,
  newAuditCorrelationId,
  type AuditFinishedOutcome,
} from '../utils/auditLog'
import { createPatch } from 'diff'

/** In-flight slash / remote command audit row (paired accepted → finished). */
type CommandAuditContext = {
  correlationId: string
  source: 'channel' | 'local'
  command: string
  startMs: number
  channel?: string
  sessionKey?: string
  deliveryId?: string
  fileId?: string
  fileName?: string
}

interface AgentPanelProps {
  activeFile: FileTab | undefined
  height: number
}

type LocalEditParseResult =
  | { kind: 'help'; text: string }
  | {
      kind: 'edit'
      newText: string
      summary: string
      /** Present for `/edit replace-selection …` text payloads — proposal UI can diff selection only. */
      selectionRange?: { from: number; to: number }
    }
  | { kind: 'error'; message: string }
  | { kind: 'fallback_gateway'; rest: string }
  | { kind: 'noop' }
  | {
      kind: 'edit_clipboard'
      op: 'insert' | 'append' | 'replace_file' | 'replace_selection'
    }

const CMD_HISTORY_MAX = 200

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '')
}

function ansiMsg(msg: string): string {
  return stripAnsi(msg)
}

const REMOTE_DIFF_MAX_CHARS = 1800

/** Generate a compact unified diff string for sending to Channel. */
function generateUnifiedDiff(before: string, after: string, fileName: string): string {
  const patch = createPatch(fileName, before, after, '', '', { context: 3 })
  // createPatch output: line 0 = "Index: ...", line 1 = "===...", line 2 = "--- ...", line 3 = "+++ ..."
  // Keep only the hunks (from line 4 onward).
  const hunks = patch.split('\n').slice(4).join('\n').trim()
  if (hunks.length <= REMOTE_DIFF_MAX_CHARS) return hunks
  return hunks.slice(0, REMOTE_DIFF_MAX_CHARS) + '\n…（diff 过长，已截断，建议在编辑器查看完整内容）'
}

const MAX_SKILL_SCOPE_LINES = 1000

/** Full buffer text for `fileId` (or active tab) — used for pre-model content hash. */
function fullDocumentTextForHash(fileId: string | undefined, active: FileTab | undefined, fallback: string): string {
  if (fileId) {
    const f = useFileStore.getState().files.find((x) => x.id === fileId)
    if (f && typeof f.content === 'string') return f.content
  }
  if (active && typeof active.content === 'string') return active.content
  return fallback
}

function countLines(text: string): number {
  if (!text) return 1
  let n = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) n++
  }
  return n
}



function formatIntentForLog(version: number, intent: unknown): string {
  try {
    return `OpenClaw 返回的意图 JSON（version ${version}）：\n${JSON.stringify(intent, null, 2)}`
  } catch {
    return `OpenClaw 返回的意图（version ${version}，无法序列化为 JSON）：\n${String(intent)}`
  }
}

type ActionModalState =
  | { kind: 'none' }
  | {
      kind: 'prompt'
      title: string
      placeholder?: string
      resolve: (v: string | null) => void
    }
  | {
      kind: 'one_select'
      title: string
      options: { id: string; label: string }[]
      resolve: (v: string | null) => void
    }

export function AgentPanel({ activeFile, height }: AgentPanelProps) {
  const [inputValue, setInputValue] = useState('')
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const chatLogRef = useRef<HTMLDivElement>(null)
  const [actionModal, setActionModal] = useState<ActionModalState>({ kind: 'none' })
  /** In-flight Channel command audits keyed by `correlationId` (parallel pipelines). */
  const inFlightChannelAuditsRef = useRef(new Map<string, CommandAuditContext>())
  /** Matches `accepted` NDJSON row until `finished` for local (non-Channel) commands. */
  const inFlightAuditRef = useRef<CommandAuditContext | null>(null)

  const finishAuditCtx = useCallback(
    (ctx: CommandAuditContext | null, outcome: AuditFinishedOutcome, reason?: string) => {
      if (!ctx) return
      const durationMs = Date.now() - ctx.startMs
      void appendAuditLog({
        event: 'finished',
        correlationId: ctx.correlationId,
        source: ctx.source,
        command: ctx.command,
        channel: ctx.channel,
        sessionKey: ctx.sessionKey,
        deliveryId: ctx.deliveryId,
        file: ctx.fileName,
        fileId: ctx.fileId,
        outcome,
        reason,
        durationMs,
      })
      if (ctx.source === 'local' && inFlightAuditRef.current?.correlationId === ctx.correlationId) {
        inFlightAuditRef.current = null
      }
    },
    []
  )

  const finishChannelAudit = useCallback(
    (correlationId: string | undefined, outcome: AuditFinishedOutcome, reason?: string) => {
      if (!correlationId) return
      const ctx = inFlightChannelAuditsRef.current.get(correlationId)
      if (!ctx) return
      finishAuditCtx(ctx, outcome, reason)
      inFlightChannelAuditsRef.current.delete(correlationId)
    },
    [finishAuditCtx]
  )

  const finishOpenCommandAudit = useCallback(
    (outcome: AuditFinishedOutcome, reason?: string) => {
      finishAuditCtx(inFlightAuditRef.current, outcome, reason)
    },
    [finishAuditCtx]
  )

  const wsUrl = useAgentStore((s) => s.wsUrl)
  const setWsUrl = useAgentStore((s) => s.setWsUrl)
  const gatewayToken = useAgentStore((s) => s.gatewayToken)
  const setGatewayToken = useAgentStore((s) => s.setGatewayToken)
  const gatewayPassword = useAgentStore((s) => s.gatewayPassword)
  const setGatewayPassword = useAgentStore((s) => s.setGatewayPassword)
  const remoteEditReceive = useAgentStore((s) => s.remoteEditReceive)
  const setRemoteEditReceive = useAgentStore((s) => s.setRemoteEditReceive)
  const connection = useAgentStore((s) => s.connection)
  const prevConnectionRef = useRef(connection)
  const pendingProposals = useAgentStore((s) => s.pendingProposals)
  const activeProposalId = useAgentStore((s) => s.activeProposalId)
  const setActiveProposalId = useAgentStore((s) => s.setActiveProposalId)
  /** Active proposal for editor UI — derived from Map. Most existing code uses this. */
  const pendingProposal = activeProposalId ? (pendingProposals.get(activeProposalId) ?? null) : null
  const pendingProposalCount = pendingProposals.size
  const lastError = useAgentStore((s) => s.lastError)
  const connect = useAgentStore((s) => s.connect)
  const disconnect = useAgentStore((s) => s.disconnect)
  const send = useAgentStore((s) => s.send)
  const parseEditIntentFallback = useAgentStore((s) => s.parseEditIntentFallback)
  const parseFindIntentFallback = useAgentStore((s) => s.parseFindIntentFallback)
  const clearProposal = useAgentStore((s) => s.clearProposal)
  const setPendingProposal = useAgentStore((s) => s.setPendingProposal)
  const messages = useAgentStore((s) => s.messages)
  const streaming = useAgentStore((s) => s.streaming)
  const incomingIntent = useAgentStore((s) => s.incomingIntent)
  const takeIncomingIntent = useAgentStore((s) => s.takeIncomingIntent)
  const pushUser = useAgentStore((s) => s.pushUser)
  const pushSystem = useAgentStore((s) => s.pushSystem)
  const sendCommandStatus = useAgentStore((s) => s.sendCommandStatus)

  const selection = useEditorStore((s) => s.selection)

  const files = useFileStore((s) => s.files)
  const setActiveFileId = useFileStore((s) => s.setActiveFileId)
  const updateContent = useFileStore((s) => s.updateContent)
  const markModified = useFileStore((s) => s.markModified)

  const canUseAgent = Boolean(
    activeFile &&
      !activeFile.isPdf &&
      typeof activeFile.content === 'string' &&
      activeFile.path
  )

  const fileText = typeof activeFile?.content === 'string' ? activeFile.content : ''

  const proposalTargetFile = useMemo(() => {
    if (!pendingProposal?.fileId) return activeFile
    return files.find((f) => f.id === pendingProposal.fileId) ?? activeFile
  }, [pendingProposal?.fileId, files, activeFile])

  const proposalTargetFileByPath = useMemo(() => {
    const pp = pendingProposal
    if (!pp?.filePath) return undefined
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const target = norm(pp.filePath)
    return (
      files.find((f) => (f.path ? norm(f.path) === target : false)) ??
      files.find((f) => (f.path ? norm(f.path).endsWith('/' + target) : false)) ??
      files.find((f) => (f.path ? norm(f.path).split('/').pop() === target.split('/').pop() : false))
    )
  }, [pendingProposal, files])

  const effectiveProposalTargetFile = proposalTargetFileByPath ?? proposalTargetFile

  const proposalFileText =
    typeof effectiveProposalTargetFile?.content === 'string'
      ? effectiveProposalTargetFile.content
      : fileText

  const inputPlaceholder = useMemo(() => {
    if (!canUseAgent) return '请先打开非 PDF 文本文件以使用 Agent'
    const editHint = getEditReplaceParamHint(inputValue)
    if (editHint) return editHint
    if (!wsUrl.trim()) return '填写 Gateway 地址后连接 · 输入 / 查看命令'
    if (connection !== 'open')
      return '连接 Gateway 后发送 · 输入 / 查看命令'
    return getCommandHintText()
  }, [canUseAgent, wsUrl, connection, inputValue])

  const proposalDiff = useMemo(() => {
    if (!pendingProposal) return null
    const p = pendingProposal
    let before: string
    let after: string
    let subtitle: string
    if (
      p.diffMode === 'selection' &&
      p.selectionFrom !== undefined &&
      p.selectionTo !== undefined
    ) {
      const r = computeSelectionDiffSlices(
        proposalFileText,
        p.newText,
        p.selectionFrom,
        p.selectionTo
      )
      if (r.ok) {
        before = r.before
        after = r.after
        subtitle = '仅选区 vs 建议（应用后仍写入合并全文）'
      } else {
        before = proposalFileText
        after = p.newText
        subtitle = '选区外也有变更或未对齐，已显示全文 diff'
      }
    } else {
      before = proposalFileText
      after = p.newText
      subtitle = '当前文件 vs 建议内容（全文）'
    }
    const sideBySide =
      p.proposalDiffVariant === 'side_by_side_interactive'
        ? buildSideBySideRows(before, after)
        : null
    return { before, after, subtitle, sideBySide }
  }, [pendingProposal, proposalFileText])

  /** Row indices (0-based) where the proposal “after” line is adopted for partial apply. */
  const [adoptedDiffLines, setAdoptedDiffLines] = useState<Set<number>>(() => new Set())

  useEffect(() => {
    const sb = proposalDiff?.sideBySide
    if (!sb?.lineAligned) {
      setAdoptedDiffLines(new Set())
      return
    }
    setAdoptedDiffLines(new Set(sb.rows.filter((r) => r.changed).map((r) => r.lineIndex)))
  }, [
    pendingProposal?.newText,
    pendingProposal?.selectionFrom,
    pendingProposal?.selectionTo,
    pendingProposal?.proposalDiffVariant,
    pendingProposal?.fileId,
    proposalDiff?.before,
    proposalDiff?.after,
    proposalDiff?.sideBySide?.lineAligned,
  ])

  const toggleAdoptedLine = useCallback((lineIndex: number) => {
    setAdoptedDiffLines((prev) => {
      const next = new Set(prev)
      if (next.has(lineIndex)) next.delete(lineIndex)
      else next.add(lineIndex)
      return next
    })
  }, [])

  const classifyAction = (raw: string): { action: OpenClawAction; instruction: string } => {
    // Single chat action; /edit and /<skill> are handled separately.
    const t = raw.trim()
    return { action: 'explain', instruction: t }
  }

  const parseLocalEdit = (
    fileTextRaw: string,
    rawLine: string,
    selectionForLocal: { from: number; to: number; text: string } | null,
    cursorPos: number
  ): LocalEditParseResult => {
    const line = rawLine.trim()
    const m = line.match(/^\/edit(?:\s+([\s\S]*))?$/i)
    if (!m) return { kind: 'noop' }

    const rest = (m[1] ?? '').trim()
    const helpText = [
      '本地编辑命令（仅修改当前文件内容，不走 OpenClaw）：',
      '',
      '/edit help',
      '/edit replace <from> with <to>',
      "/edit replace <from> -> <to>   (也支持 '=>')",
      '/edit delete <text>',
      '/edit line <trim|sort|dedupe|empty|blank>',
      '/edit line drop-matching /regex/flags   或  /edit line drop-matching \"字面\"  （删整行；有选区则只处理选区所在行范围）',
      '/edit drop-matching …  与  /edit 删除匹配行 …  同上（可不写 line）',
      '/edit case <upper|lower|title>',
      '/edit insert --clipboard   或 /edit insert -c   （从剪贴板读入，插入光标处）',
      '/edit append --clipboard   或 /edit append -c   （从剪贴板读入，追加到文末）',
      "/edit append '…'   或 /edit insert \"…\"   （单/双引号一行内短文本）",
      '/edit insert \'\'\'…\'\'\'',
      '/edit append """…"""   （三引号多行或大段；多行粘贴后回车提交）',
      '/edit replace-file …   （整篇正文替换为载荷；--clipboard / 三引号 / 单双引号同 insert）',
      '/edit replace-selection …   （整块选区替换为载荷；需非空选区）',
      '',
      '提示：非编辑意图请直接输入对话，不要加 /edit。',
    ].join('\n')

    if (!rest || /^help$/i.test(rest) || /^h$/i.test(rest) || /^帮助$/.test(rest)) {
      return { kind: 'help', text: helpText }
    }

    const sel =
      selectionForLocal && selectionForLocal.from !== selectionForLocal.to
        ? selectionForLocal
        : null

    const parts = rest.split(/\s+/)
    const sub = (parts[0] ?? '').toLowerCase()
    const afterSub = rest.slice(parts[0]?.length ?? 0).trim()

    const fail = (message: string): LocalEditParseResult => ({
      kind: 'error',
      message: `${message}\n\n可用命令：\n${helpText}`,
    })

    if (sub === 'replace') {
      const r1 = afterSub.match(/^([\s\S]+?)\s+with\s+([\s\S]+)$/i)
      if (r1) {
        const local = parseSimpleEditInstruction(
          fileTextRaw,
          `replace ${r1[1]} with ${r1[2]}`,
          sel
        )
        if (!local) return fail('本地 replace 未找到可替换的内容。')
        return { kind: 'edit', newText: local.newText, summary: local.summary }
      }
      const r2 = afterSub.match(/^([\s\S]+?)\s*(?:->|=>)\s*([\s\S]+)$/)
      if (r2) {
        const local = parseSimpleEditInstruction(
          fileTextRaw,
          `replace ${r2[1]} with ${r2[2]}`,
          sel
        )
        if (!local) return fail('本地 replace 未找到可替换的内容。')
        return { kind: 'edit', newText: local.newText, summary: local.summary }
      }
      return fail('replace 语法不正确。示例：/edit replace foo with bar')
    }

    if (sub === 'delete' || sub === 'remove') {
      if (!afterSub) return fail('delete 缺少参数。示例：/edit delete foo')
      const local = parseSimpleEditInstruction(fileTextRaw, `delete ${afterSub}`, sel)
      if (!local) return fail('本地 delete 未找到要删除的内容。')
      return { kind: 'edit', newText: local.newText, summary: local.summary }
    }

    if (sub === 'line') {
      const dropM = afterSub.match(
        /^(?:drop-matching|delete-matching|grep-delete)\s+([\s\S]+)$/i
      )
      if (dropM) {
        const parsed = parseEditDropMatchingPayload((dropM[1] ?? '').trim())
        if (!parsed) {
          return fail(
            'drop-matching 需要有效参数。示例：/edit line drop-matching /\\\\bTODO\\\\b/i  或  /edit line drop-matching \"deprecated\"'
          )
        }
        const params =
          parsed.mode === 'regex'
            ? { mode: 'regex' as const, pattern: parsed.pattern, flags: parsed.flags }
            : { mode: 'literal' as const, needle: parsed.needle }
        const r = applyDeleteMatchingLines(fileTextRaw, sel, params, '删除匹配行')
        if (!r) {
          return fail(
            '删除匹配行未生效（正则无效、无命中行，或字面量未出现在任一行）。'
          )
        }
        return { kind: 'edit', newText: r.newText, summary: r.summary }
      }

      const op = (parts[1] ?? '').toLowerCase()
      const mapped =
        op === 'trim'
          ? '去除行尾空格'
          : op === 'sort'
            ? '排序行'
            : op === 'dedupe' || op === 'unique'
              ? '去重行'
              : op === 'empty'
                ? '删除空行'
                : op === 'blank'
                  ? '删除空白行'
                  : ''
      if (!mapped) return fail('line 子命令不支持。示例：/edit line trim')
      const local = parseSimpleEditInstruction(fileTextRaw, mapped, sel)
      if (!local) return fail('本地 line 操作没有产生变化。')
      return { kind: 'edit', newText: local.newText, summary: local.summary }
    }

    if (sub === 'case') {
      const op = (parts[1] ?? '').toLowerCase()
      const mapped =
        op === 'upper' || op === 'uppercase'
          ? '转大写'
          : op === 'lower' || op === 'lowercase'
            ? '转小写'
            : op === 'title' || op === 'titlecase'
              ? '首字母大写'
              : ''
      if (!mapped) return fail('case 子命令不支持。示例：/edit case upper')
      const local = parseSimpleEditInstruction(fileTextRaw, mapped, sel)
      if (!local) return fail('本地 case 操作没有产生变化。')
      return { kind: 'edit', newText: local.newText, summary: local.summary }
    }

    if (sub === 'insert') {
      const r = tryParseInsertAppendBody(afterSub)
      if (r.kind === 'error') return fail(r.message)
      if (r.kind === 'incomplete') {
        return fail('未闭合的三引号块（多行请粘贴完整内容直到出现闭合引号）。')
      }
      if (r.kind === 'clipboard') return { kind: 'edit_clipboard', op: 'insert' }
      if (r.kind === 'text') {
        const pos = cursorPos
        if (pos < 0 || pos > fileTextRaw.length) {
          return fail('光标位置无效（请确保编辑器焦点在目标位置）。')
        }
        const newText = mergeRange(fileTextRaw, pos, pos, r.text)
        return {
          kind: 'edit',
          newText,
          summary: `在光标处插入 ${r.text.length} 字符`,
        }
      }
    }

    if (sub === 'append') {
      const r = tryParseInsertAppendBody(afterSub)
      if (r.kind === 'error') return fail(r.message)
      if (r.kind === 'incomplete') {
        return fail('未闭合的三引号块（多行请粘贴完整内容直到出现闭合引号）。')
      }
      if (r.kind === 'clipboard') return { kind: 'edit_clipboard', op: 'append' }
      if (r.kind === 'text') {
        const newText = fileTextRaw + r.text
        return {
          kind: 'edit',
          newText,
          summary: `在文末追加 ${r.text.length} 字符`,
        }
      }
    }

    if (sub === 'replace-file') {
      const r = tryParseInsertAppendBody(afterSub)
      if (r.kind === 'error') return fail(r.message)
      if (r.kind === 'incomplete') {
        return fail('未闭合的引号块（多行请粘贴完整内容直到闭合）。')
      }
      if (r.kind === 'clipboard') return { kind: 'edit_clipboard', op: 'replace_file' }
      if (r.kind === 'text') {
        return {
          kind: 'edit',
          newText: r.text,
          summary: `整篇替换为 ${r.text.length} 字符`,
        }
      }
    }

    if (sub === 'replace-selection') {
      if (!sel) {
        return fail('replace-selection 需要编辑器中非空选区。')
      }
      const r = tryParseInsertAppendBody(afterSub)
      if (r.kind === 'error') return fail(r.message)
      if (r.kind === 'incomplete') {
        return fail('未闭合的引号块（多行请粘贴完整内容直到闭合）。')
      }
      if (r.kind === 'clipboard') return { kind: 'edit_clipboard', op: 'replace_selection' }
      if (r.kind === 'text') {
        const newText = mergeRange(fileTextRaw, sel.from, sel.to, r.text)
        return {
          kind: 'edit',
          newText,
          summary: `选区整块替换为 ${r.text.length} 字符`,
          selectionRange: { from: sel.from, to: sel.to },
        }
      }
    }

    const local = parseSimpleEditInstruction(fileTextRaw, rest, sel)
    if (local) return { kind: 'edit', newText: local.newText, summary: local.summary }
    return { kind: 'fallback_gateway', rest }
  }

  const contextForSend = useMemo(() => {
    if (!activeFile) return null
    return {
      file: {
        id: activeFile.id,
        name: activeFile.name,
        language: activeFile.language,
        path: activeFile.path,
      },
      text: fileText,
      cursorPos: selection?.from ?? 0,
      selection:
        selection && selection.text.length > 0
          ? { text: selection.text, from: selection.from, to: selection.to }
          : null,
    }
  }, [activeFile, fileText, selection])

  const contextForSkillSend = useMemo(() => {
    if (!contextForSend) return null
    if (contextForSend.selection?.text) {
      return {
        ...contextForSend,
        // Skill input is scope text: when there's a selection, only send selection text.
        text: contextForSend.selection.text,
      }
    }
    return contextForSend
  }, [contextForSend])

  const handleApplyIntentResult = useCallback(
    (
      result: ApplyIntentResult,
      requestId?: string,
      cmdHash?: number,
      cmdOrig?: string,
      cmdCorrId?: string,
      remoteCtx?: {
        sessionKey?: string
        channel?: string
        deliveryId?: string
        correlationId?: string
        pipelineStartMs?: number
        originalCommand?: string
      }
    ) => {
      switch (result.kind) {
        case 'edit':
          if (result.newText === fileText) {
            pushSystem(ansiMsg('\x1b[33m意图未改变文档\x1b[0m'))
            finishOpenCommandAudit('completed', 'no_document_change')
          } else {
            setPendingProposal({
              requestId: requestId ?? `intent-${Date.now()}`,
              newText: result.newText,
              title: result.title,
              summary: result.summary,
              remoteSessionKey: remoteCtx?.sessionKey,
              sessionKey: remoteCtx?.sessionKey,
              channel: remoteCtx?.channel,
              deliveryId: remoteCtx?.deliveryId,
              baseContentHash: cmdHash,
              originalCommand: cmdOrig ?? remoteCtx?.originalCommand,
              correlationId: cmdCorrId ?? remoteCtx?.correlationId,
              remotePipelineStartMs: remoteCtx?.pipelineStartMs,
              proposalCreatedAt: Date.now(),
            })
            pushSystem(
              ansiMsg(
                '\x1b[33m已生成修改提案：请在弹窗中确认 diff 后再点击「应用修改」。\x1b[0m'
              )
            )
          }
          break
        case 'goto': {
          const view = useEditorStore.getState().editorView
          if (!view) {
            pushSystem(ansiMsg('\x1b[33m编辑器尚未就绪，无法跳转行\x1b[0m'))
            finishOpenCommandAudit('failed', 'editor_not_ready')
            break
          }
          if (!gotoLineInEditor(view, result.line)) {
            pushSystem(ansiMsg(`\x1b[33m无法跳转到第 ${result.line} 行\x1b[0m`))
            finishOpenCommandAudit('failed', 'goto_failed')
          } else {
            finishOpenCommandAudit('completed')
          }
          break
        }
        case 'find': {
          const view = useEditorStore.getState().editorView
          if (!view) {
            pushSystem(ansiMsg('\x1b[33m编辑器尚未就绪，无法查找\x1b[0m'))
            finishOpenCommandAudit('failed', 'editor_not_ready')
            break
          }
          const fr = applyFindInEditor(view, result.spec)
          if (!fr.ok) {
            pushSystem(ansiMsg(`\x1b[31m${fr.message}\x1b[0m`))
            finishOpenCommandAudit('failed', fr.message)
          } else {
            pushSystem(fr.summary)
            finishOpenCommandAudit('completed')
          }
          break
        }
        case 'clarify':
          pushSystem(ansiMsg(`\x1b[33m${result.message}\x1b[0m`))
          finishOpenCommandAudit('completed', 'clarify')
          break
        case 'noop':
          finishOpenCommandAudit('completed', 'noop')
          break
        case 'error':
          pushSystem(ansiMsg(`\x1b[31m${result.message}\x1b[0m`))
          finishOpenCommandAudit('failed', result.message)
          break
      }
    },
    [fileText, setPendingProposal, pushSystem, finishOpenCommandAudit, finishChannelAudit]
  )

  const processCommand = useCallback(
    (line: string, opts?: {
      origin?: 'local' | 'remote'
      meta?: {
        channel?: string
        sessionKey?: string
        deliveryId?: string
        targetFile?: string
        correlationId?: string
        pipelineStartMs?: number
      }
    }) => {
      const origin = opts?.origin ?? 'local'
      const meta = opts?.meta

      if (!canUseAgent || !contextForSend) {
        pushSystem(ansiMsg('\x1b[33m请打开文本文件以使用 Agent\x1b[0m'))
        if (origin === 'local') {
          const cid = newAuditCorrelationId()
          void appendAuditLog({
            event: 'finished',
            correlationId: cid,
            source: 'local',
            command: line.trim(),
            outcome: 'rejected',
            reason: 'no_text_file_or_agent_disabled',
          })
        }
        return
      }

      const trimmed = line.trim()
      if (!trimmed) return

      const remoteSnap =
        origin === 'remote' && meta
          ? {
              channel: meta.channel,
              sessionKey: meta.sessionKey,
              deliveryId: meta.deliveryId,
              correlationId: meta.correlationId,
              pipelineStartMs: meta.pipelineStartMs,
              originalCommand: trimmed,
            }
          : undefined

      const sel =
        selection && selection.from !== selection.to
          ? { from: selection.from, to: selection.to, text: selection.text }
          : null
      const cursorPos = selection?.from ?? 0

      const skillMatchEarly = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/)
      if (skillMatchEarly) {
        const earlySkillId = (skillMatchEarly[1] ?? '').toLowerCase()
        if (earlySkillId === 'confirm' || earlySkillId === 'cancel') {
          // Parse optional deliveryId argument: /confirm [deliveryId] or /cancel [deliveryId]
          const argDeliveryId = (skillMatchEarly[2] ?? '').trim() || undefined
          const metaChannel = meta?.channel
          const metaSessionKey = meta?.sessionKey

          const writeConfirmCancelAudit = (
            proposal: import('../store/agentStore').PendingProposal,
            outcome: AuditFinishedOutcome,
            reason?: string
          ) => {
            void appendAuditLog({
              event: 'finished',
              correlationId: proposal.correlationId ?? newAuditCorrelationId(),
              requestId: proposal.requestId,
              source: 'channel',
              command: trimmed,
              channel: metaChannel,
              sessionKey: metaSessionKey,
              deliveryId: proposal.deliveryId,
              file: proposal.fileName,
              fileId: proposal.fileId,
              outcome,
              reason,
              durationMs: Date.now() - proposal.proposalCreatedAt,
            })
          }

          const logOrphanFinished = (reason: string) => {
            void appendAuditLog({
              event: 'finished',
              correlationId: newAuditCorrelationId(),
              source: origin === 'remote' ? 'channel' : 'local',
              command: trimmed,
              channel: metaChannel,
              sessionKey: metaSessionKey,
              file: activeFile?.name,
              fileId: activeFile?.id,
              outcome: 'failed',
              reason,
            })
          }

          /** Find proposal by deliveryId, or fall back to most-recent for this channel. */
          const findProposal = (): import('../store/agentStore').PendingProposal | null => {
            const proposals = useAgentStore.getState().pendingProposals
            if (argDeliveryId) {
              for (const p of proposals.values()) {
                if (p.deliveryId === argDeliveryId) return p
              }
              return null
            }
            // No arg: find most recently created proposal for this channel
            let best: import('../store/agentStore').PendingProposal | null = null
            for (const p of proposals.values()) {
              if (p.remoteSessionKey && (!metaChannel || p.channel === metaChannel)) {
                if (!best || p.proposalCreatedAt > best.proposalCreatedAt) best = p
              }
            }
            return best
          }

          /** Poll up to 3s for a proposal with the given deliveryId (竞态：已accepted但提案未到). */
          const waitForProposal = async (): Promise<import('../store/agentStore').PendingProposal | null> => {
            if (!argDeliveryId) return null
            const maxMs = 3000
            const interval = 500
            let elapsed = 0
            while (elapsed < maxMs) {
              await new Promise<void>((r) => setTimeout(r, interval))
              elapsed += interval
              const proposals = useAgentStore.getState().pendingProposals
              for (const p of proposals.values()) {
                if (p.deliveryId === argDeliveryId) return p
              }
            }
            return null
          }

          if (earlySkillId === 'confirm') {
            void (async () => {
              let pp = findProposal()
              if (!pp && argDeliveryId) {
                // deliveryId known but proposal not yet arrived — poll
                pp = await waitForProposal()
                if (!pp) {
                  if (metaSessionKey) {
                    sendCommandStatus(metaSessionKey, `[ClawEditor] /confirm ${argDeliveryId} → 提案生成中，请稍后重试`)
                  }
                  if (origin === 'local') logOrphanFinished('proposal_not_yet_ready')
                  return
                }
              }
              if (!pp) {
                pushSystem(ansiMsg('\x1b[33m当前没有待确认的远程提案。\x1b[0m'))
                if (metaSessionKey) {
                  sendCommandStatus(metaSessionKey, `[ClawEditor] /confirm → 当前没有待确认的提案`)
                }
                if (origin === 'local') logOrphanFinished('no_pending_remote_proposal')
                return
              }
              const proposal = pp
              const targetId =
                proposal.fileId ??
                files.find((f) => f.path && proposal.filePath && f.path === proposal.filePath)?.id ??
                activeFile?.id
              if (!targetId) {
                if (metaSessionKey) sendCommandStatus(metaSessionKey, `[ClawEditor] /confirm → 找不到目标文件`)
                writeConfirmCancelAudit(proposal, 'failed', 'no_target_file_for_confirm')
                if (proposal.correlationId) finishChannelAudit(proposal.correlationId, 'failed', 'no_target_file_for_confirm')
                return
              }
              // Hash stale check
              const targetFile = useFileStore.getState().files.find((f) => f.id === targetId)
              const currentContent = typeof targetFile?.content === 'string' ? targetFile.content : ''
              if (proposal.baseContentHash !== undefined && hashContent(currentContent) !== proposal.baseContentHash) {
                if (metaSessionKey) {
                  sendCommandStatus(metaSessionKey, `[ClawEditor] /confirm → 文件已被修改，提案基于旧版本，请重新发送命令`)
                }
                writeConfirmCancelAudit(proposal, 'failed', 'stale_content')
                clearProposal(proposal.requestId)
                if (proposal.correlationId) finishChannelAudit(proposal.correlationId, 'failed', 'stale_content')
                return
              }
              updateContent(targetId, proposal.newText)
              markModified(targetId, true)
              clearProposal(proposal.requestId)
              pushSystem(ansiMsg('\x1b[32m修改已应用\x1b[0m'))
              if (metaSessionKey) {
                const durationMs = Date.now() - proposal.proposalCreatedAt
                sendCommandStatus(metaSessionKey, `[ClawEditor] ${proposal.originalCommand ?? trimmed} → completed (${durationMs}ms)`)
              }
              writeConfirmCancelAudit(proposal, 'completed')
              if (proposal.correlationId) finishChannelAudit(proposal.correlationId, 'completed')
            })()
            return
          }

          // /cancel
          void (async () => {
            let pp = findProposal()
            if (!pp && argDeliveryId) {
              pp = await waitForProposal()
            }
            if (!pp) {
              pushSystem(ansiMsg('\x1b[33m当前没有待取消的远程提案。\x1b[0m'))
              if (metaSessionKey) {
                sendCommandStatus(metaSessionKey, `[ClawEditor] /cancel → 当前没有待取消的提案`)
              }
              if (origin === 'local') logOrphanFinished('no_pending_remote_proposal')
              return
            }
            const proposal = pp
            if (metaSessionKey) {
              const durationMs = Date.now() - proposal.proposalCreatedAt
              sendCommandStatus(metaSessionKey, `[ClawEditor] ${proposal.originalCommand ?? trimmed} → failed: user cancelled (${durationMs}ms)`)
            }
            clearProposal(proposal.requestId)
            writeConfirmCancelAudit(proposal, 'failed', 'user_cancelled')
            if (proposal.correlationId) finishChannelAudit(proposal.correlationId, 'failed', 'user_cancelled')
          })()
          return
        }
      }

      let auditSnap: CommandAuditContext | null = null

      const cmdRequestId =
        origin === 'remote'
          ? meta?.correlationId ?? meta?.deliveryId ?? `remote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          : `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

      const finish = (outcome: AuditFinishedOutcome, reason?: string) => {
        if (origin === 'remote' && meta?.correlationId) {
          finishChannelAudit(meta.correlationId, outcome, reason)
        } else {
          finishAuditCtx(auditSnap, outcome, reason)
        }
        auditSnap = null
      }

      if (origin === 'remote') {
        auditSnap = meta?.correlationId ? inFlightChannelAuditsRef.current.get(meta.correlationId) ?? null : null
      } else {
        const correlationId = newAuditCorrelationId()
        auditSnap = {
          correlationId,
          source: 'local',
          command: trimmed,
          startMs: Date.now(),
          fileId: activeFile?.id,
          fileName: activeFile?.name,
        }
        inFlightAuditRef.current = auditSnap
        void appendAuditLog({
          event: 'accepted',
          correlationId,
          requestId: cmdRequestId,
          source: 'local',
          command: trimmed,
          file: activeFile?.name,
          fileId: activeFile?.id,
        })
      }

      const cmdCorrelationId = auditSnap?.correlationId ?? meta?.correlationId

      const skillMatch = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/)
      if (skillMatch) {
        const skillId = (skillMatch[1] ?? '').toLowerCase()
        const rest = (skillMatch[2] ?? '').trim()

        if (skillId === 'find') {
          const selScope =
            sel && sel.from !== sel.to
              ? { from: sel.from, to: sel.to }
              : null
          const localFind = parseLocalFind(trimmed, selScope)
          if (localFind.kind === 'help') {
            useAgentStore.setState({ lastError: null })
            pushSystem(localFind.text)
            finish('completed', 'help')
            return
          }
          if (localFind.kind === 'error') {
            useAgentStore.setState({ lastError: null })
            pushSystem(ansiMsg(`\x1b[31m${localFind.message}\x1b[0m`))
            finish('failed', localFind.message)
            return
          }
          if (localFind.kind === 'find') {
            useAgentStore.setState({ lastError: null })
            const view = useEditorStore.getState().editorView
            if (!view) {
              pushSystem(ansiMsg('\x1b[33m编辑器尚未就绪，无法查找\x1b[0m'))
              finish('failed', 'editor_not_ready')
              return
            }
            const fr = applyFindInEditor(view, localFind.spec)
            if (!fr.ok) {
              pushSystem(ansiMsg(`\x1b[31m${fr.message}\x1b[0m`))
              finish('failed', fr.message)
            } else {
              pushSystem(fr.summary)
              finish('completed')
            }
            return
          }
          if (localFind.kind === 'fallback_gateway') {
            if (!wsUrl.trim()) {
              pushSystem(
                ansiMsg(
                  '\x1b[31m本地无法解析该 /find。请连接 OpenClaw Gateway，或改用 /find help。\x1b[0m'
                )
              )
              finish('rejected', 'gateway_url_missing')
              return
            }
            if (connection !== 'open') {
              pushSystem(
                ansiMsg(
                  '\x1b[31m本地无法解析该 /find。请先连接 OpenClaw，或改用 /find help。\x1b[0m'
                )
              )
              finish('rejected', 'gateway_not_connected')
              return
            }
            void (async () => {
              useAgentStore.setState({ lastError: null })
              pushSystem(
                ansiMsg(
                  '\x1b[33m本地判定需 OpenClaw（多词或长文本等），正在解析查找意图…\x1b[0m'
                )
              )
              try {
                const { version, intent } = await parseFindIntentFallback({
                  freeform: `/find ${localFind.rest}`,
                  file: contextForSend.file,
                  text: '',
                  cursorPos: contextForSend.cursorPos,
                  selection: null,
                })
                pushSystem(formatIntentForLog(version, intent))
                const r = applyParsedIntent(fileText, sel, version, intent)
                if (r.kind === 'edit') {
                  pushSystem(
                    ansiMsg(
                      '\x1b[31m模型返回了编辑类意图，并非查找。请改用 /edit 或重述查找需求。\x1b[0m'
                    )
                  )
                  finish('failed', 'unexpected_edit_intent')
                } else {
                  handleApplyIntentResult(r, undefined, undefined, undefined, undefined, remoteSnap ?? undefined)
                }
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                pushSystem(ansiMsg(`\x1b[31m${msg}\x1b[0m`))
                finish('failed', msg)
              }
            })()
            return
          }
          finish('failed', 'unknown_find_branch')
          return
        }
        const def = getSkillDef(skillId)
        if (def) {
          const wantsExplicitHelp =
            /^help$/i.test(rest) || /^h$/i.test(rest) || /^帮助$/.test(rest)
          if (!wsUrl.trim()) {
            pushSystem(ansiMsg('\x1b[31m请填写 Gateway 地址。\x1b[0m'))
            finish('rejected', 'gateway_url_missing')
            return
          }
          if (connection !== 'open') {
            pushSystem(ansiMsg('\x1b[31m未连接 OpenClaw Gateway。请先连接。\x1b[0m'))
            finish('rejected', 'gateway_not_connected')
            return
          }
          void (async () => {
            useAgentStore.setState({ lastError: null })
            const cfgAll = getClaweditorConfigForSkill(skillId)
            const hasCompletions = Boolean(cfgAll?.completions && cfgAll.completions.length > 0)
            const allowEmptyInstruction = cfgAll?.allowEmptyInstruction === true

            // Empty rest: prefer completions when present; otherwise show help unless
            // ```claweditor``` sets allowEmptyInstruction (scope-driven skills like /aicorrect).
            if (!rest && !hasCompletions && !allowEmptyInstruction) {
              useAgentStore.setState({ lastError: null })
              pushSystem(
                getSkillHelpText(skillId) ?? `未在 skills/${skillId}/SKILL.md 中找到 help 文档块。`
              )
              finish('completed', 'help')
              return
            }
            if (wantsExplicitHelp) {
              useAgentStore.setState({ lastError: null })
              pushSystem(
                getSkillHelpText(skillId) ?? `未在 skills/${skillId}/SKILL.md 中找到 help 文档块。`
              )
              finish('completed', 'help')
              return
            }
            if (cfgAll) {
              const v = validateClaweditorConfig(cfgAll as any)
              if (!v.ok) {
                pushSystem(
                  ansiMsg(
                    `\x1b[31mclaweditor 配置错误（skills/${skillId}/SKILL.md）:\n- ${v.errors.join('\n- ')}\x1b[0m`
                  )
                )
                if (v.warnings.length) {
                  pushSystem(ansiMsg(`\x1b[33m配置警告:\n- ${v.warnings.join('\n- ')}\x1b[0m`))
                }
                finish('failed', 'invalid_claweditor_config')
                return
              }
              if (v.warnings.length) {
                pushSystem(ansiMsg(`\x1b[33m配置警告:\n- ${v.warnings.join('\n- ')}\x1b[0m`))
              }
            }

            const runAction = async (a: any) => {
              const action = a?.action as string
              if (action === 'one_select') {
                const title = a?.ui?.title ?? '选择'
                const options =
                  (a?.options as { id: string; label: string }[] | undefined) ?? []
                return await new Promise<Record<string, string> | null>((resolve) => {
                  setActionModal({
                    kind: 'one_select',
                    title,
                    options,
                    resolve: (v) => resolve(v ? { id: v } : null),
                  })
                })
              }
              if (action === 'prompt_user') {
                const title = a?.ui?.title ?? '请输入'
                const placeholder = a?.ui?.placeholder
                return await new Promise<Record<string, string> | null>((resolve) => {
                  setActionModal({
                    kind: 'prompt',
                    title,
                    placeholder,
                    resolve: (v) => resolve(v === null ? null : { text: v.trim() }),
                  })
                })
              }
              if (action === 'pick_file') {
                const title = a?.ui?.title ?? '选择文件'
                const hardMax = 20 * 1024 * 1024
                const maxBytes = Math.min(
                  typeof a?.maxBytes === 'number' ? a.maxBytes : 20 * 1024 * 1024,
                  hardMax
                )
                const selected = await open({ multiple: false, title })
                if (!selected || Array.isArray(selected)) return null
                const path = String(selected)
                const name = path.split('/').pop() || path
                const st = await stat(path).catch(() => null)
                if (st && typeof st.size === 'number' && st.size > maxBytes) {
                  throw new Error(`导入文件过大（>${maxBytes} bytes）`)
                }
                return { name, path }
              }
              if (action === 'clipboard_read') {
                const hardMax = 500_000
                const maxChars = Math.min(
                  typeof a?.maxChars === 'number' ? a.maxChars : 200_000,
                  hardMax
                )
                if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
                  throw new Error('当前环境无法读取剪贴板（需安全上下文与权限）。')
                }
                const content = await navigator.clipboard.readText()
                if (content.length > maxChars) {
                  throw new Error(`剪贴板内容过长（>${maxChars} chars）`)
                }
                return { content }
              }
              throw new Error(`不支持的 action: ${action}`)
            }

            let instruction = rest
            if (cfgAll?.completions?.length) {
              const r = await runSkillCompletions({
                args: cfgAll?.args,
                completions: cfgAll?.completions,
                instructionWrapper: cfgAll?.instructionWrapper,
                ctx: { rest, instruction: rest },
                runAction: async (a) => {
                  try {
                    return await runAction(a)
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    pushSystem(ansiMsg(`\x1b[31m补全失败: ${msg}\x1b[0m`))
                    return null
                  }
                },
              })
              if (!r.ok) {
                if ('cancelled' in r && r.cancelled) {
                  pushSystem(ansiMsg(`\x1b[33m已取消 /${skillId}。\x1b[0m`))
                  finish('failed', 'user_cancelled')
                } else {
                  pushSystem(ansiMsg(`\x1b[31m${(r as any).error}\x1b[0m`))
                  finish('failed', String((r as any).error ?? 'completion_failed'))
                }
                return
              }
              instruction = r.instruction
            }

            const requiresScopeText =
              (cfgAll as any)?.requiresScopeText === false ? false : true

            let sendCtx = (requiresScopeText
              ? (contextForSkillSend ?? contextForSend)
              : ({ ...(contextForSend as any), text: '' } as any)) as any

            // Guard against overlong context: truncate full-scope skill text when file exceeds line limit.
            // Keep behavior unchanged when there's a selection (selection scope already handled upstream).
            const hasSelectionScope = Boolean(
              sendCtx?.selection && sendCtx.selection.from !== sendCtx.selection.to
            )
            if (requiresScopeText && !hasSelectionScope) {
              const scopeText = String(sendCtx.text ?? '')
              const total = countLines(scopeText)
              if (total > MAX_SKILL_SCOPE_LINES) {
                // Take the first MAX_SKILL_SCOPE_LINES lines.
                let endOffset = scopeText.length
                let lineCount = 0
                for (let i = 0; i < scopeText.length; i++) {
                  if (scopeText.charCodeAt(i) === 10 /* \n */) {
                    lineCount++
                    if (lineCount === MAX_SKILL_SCOPE_LINES) {
                      endOffset = i
                      break
                    }
                  }
                }
                const slicedText = scopeText.slice(0, endOffset)

                // Promote truncation to a real "virtual selection" so UI can show selection diff.
                sendCtx = {
                  ...sendCtx,
                  text: slicedText,
                  selection: {
                    from: 0,
                    to: endOffset,
                    text: slicedText,
                  },
                }

                // User-visible notice.
                pushSystem(
                  ansiMsg(
                    `\x1b[33m/${skillId}：当前文件约 ${total} 行，超过 ${MAX_SKILL_SCOPE_LINES} 行上限；已自动截取前 ${MAX_SKILL_SCOPE_LINES} 行并仅发送该片段。\x1b[0m`
                  )
                )

                // Model-visible notice: inject a short prefix into instruction.
                const header = [
                  '[ClawEditor context limit]',
                  `NOTE: The editor buffer text below is TRUNCATED to avoid exceeding model context.`,
                  `Original total lines: ${total}. Provided lines: 1-${MAX_SKILL_SCOPE_LINES} (first ${MAX_SKILL_SCOPE_LINES} lines only).`,
                  `Do NOT assume or reference content outside the provided lines.`,
                  `You MUST NOT output replace_file. Only edit within the provided selection and output replace_selection with the provided UTF-16 offsets (selFrom/selTo).`,
                  '',
                ].join('\n')
                instruction = header + instruction
              }
            }

            const preSendFullHash = hashContent(
              fullDocumentTextForHash(sendCtx.file?.id ?? activeFile?.id, activeFile, fileText)
            )
            const pipelineMeta =
              remoteSnap && meta?.correlationId
                ? {
                    correlationId: meta.correlationId,
                    sessionKey: remoteSnap.sessionKey,
                    channel: remoteSnap.channel,
                    deliveryId: remoteSnap.deliveryId,
                    pipelineStartMs: remoteSnap.pipelineStartMs ?? Date.now(),
                    originalCommand: trimmed,
                    baseContentHash: preSendFullHash,
                  }
                : undefined

            const ok = await send({
              action: 'skill',
              skillId,
              instruction,
              ...(sendCtx as any),
              requestId: cmdRequestId,
              pipelineMeta,
            })
            if (!ok) {
              pushSystem(
                ansiMsg(
                  '\x1b[31m请求未能发出（未连接或网关拒绝）。请查看工具栏状态与系统消息。\x1b[0m'
                )
              )
              finish('failed', 'send_rejected')
            }
          })()
          return
        }
      }

      const localResult = parseLocalEdit(fileText, trimmed, sel, cursorPos)
      if (localResult.kind === 'help') {
        useAgentStore.setState({ lastError: null })
        pushSystem(localResult.text)
        finish('completed', 'help')
        return
      }
      if (localResult.kind === 'error') {
        useAgentStore.setState({ lastError: null })
        pushSystem(ansiMsg(`\x1b[31m${localResult.message}\x1b[0m`))
        finish('failed', localResult.message)
        return
      }
      if (localResult.kind === 'edit') {
        useAgentStore.setState({ lastError: null })
        if (localResult.newText === fileText) {
          pushSystem(ansiMsg('\x1b[33m本地命令没有产生变化\x1b[0m'))
          finish('completed', 'no_document_change')
        } else {
          const selDiff =
            localResult.selectionRange &&
            localResult.selectionRange.from < localResult.selectionRange.to
              ? {
                  diffMode: 'selection' as const,
                  selectionFrom: localResult.selectionRange.from,
                  selectionTo: localResult.selectionRange.to,
                }
              : {}
          setPendingProposal({
            requestId: cmdRequestId,
            newText: localResult.newText,
            title: '本地命令',
            summary: localResult.summary,
            fileId: activeFile?.id,
            filePath: activeFile?.path,
            fileName: activeFile?.name,
            remoteSessionKey: remoteSnap?.sessionKey,
            sessionKey: remoteSnap?.sessionKey,
            channel: remoteSnap?.channel,
            deliveryId: origin === 'remote' ? remoteSnap?.deliveryId : undefined,
            baseContentHash: hashContent(fileText),
            originalCommand: trimmed,
            correlationId: cmdCorrelationId,
            remotePipelineStartMs: remoteSnap?.pipelineStartMs,
            proposalCreatedAt: Date.now(),
            ...selDiff,
          })
        }
        return
      }

      if (localResult.kind === 'edit_clipboard') {
        useAgentStore.setState({ lastError: null })
        const snapClip = auditSnap
        void (async () => {
          try {
            if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
              pushSystem(
                ansiMsg(
                  '\x1b[31m当前环境无法读取剪贴板（需安全上下文与权限）。\x1b[0m'
                )
              )
              finishAuditCtx(snapClip, 'failed', 'clipboard_unavailable')
              return
            }
            const text = await navigator.clipboard.readText()
            if (text.length > MAX_INSERT_CHARS) {
              pushSystem(
                ansiMsg(`\x1b[31m剪贴板内容过长（>${MAX_INSERT_CHARS} 字符）。\x1b[0m`)
              )
              finishAuditCtx(snapClip, 'failed', 'clipboard_too_large')
              return
            }
            let newText: string
            let summary: string
            if (localResult.op === 'insert') {
              newText = mergeRange(fileText, cursorPos, cursorPos, text)
              summary = `从剪贴板在光标处插入 ${text.length} 字符`
            } else if (localResult.op === 'append') {
              newText = fileText + text
              summary = `从剪贴板在文末追加 ${text.length} 字符`
            } else if (localResult.op === 'replace_file') {
              newText = text
              summary = `从剪贴板整篇替换（${text.length} 字符）`
            } else {
              if (!sel) {
                pushSystem(
                  ansiMsg('\x1b[31mreplace-selection 需要非空选区。\x1b[0m')
                )
                finishAuditCtx(snapClip, 'rejected', 'selection_required')
                return
              }
              newText = mergeRange(fileText, sel.from, sel.to, text)
              summary = `从剪贴板替换选区（${text.length} 字符）`
            }
            if (newText === fileText) {
              pushSystem(ansiMsg('\x1b[33m剪贴板为空，未修改文档。\x1b[0m'))
              finishAuditCtx(snapClip, 'completed', 'no_document_change')
              return
            }
            const clipSelDiff =
              localResult.op === 'replace_selection' && sel
                ? {
                    diffMode: 'selection' as const,
                    selectionFrom: sel.from,
                    selectionTo: sel.to,
                  }
                : {}
            setPendingProposal({
              requestId: cmdRequestId,
              newText,
              title: '本地命令',
              summary,
              fileId: activeFile?.id,
              filePath: activeFile?.path,
              fileName: activeFile?.name,
              remoteSessionKey: remoteSnap?.sessionKey,
              sessionKey: remoteSnap?.sessionKey,
              channel: remoteSnap?.channel,
              deliveryId: origin === 'remote' ? remoteSnap?.deliveryId : undefined,
              baseContentHash: hashContent(fileText),
              originalCommand: trimmed,
              correlationId: cmdCorrelationId,
              remotePipelineStartMs: remoteSnap?.pipelineStartMs,
              proposalCreatedAt: Date.now(),
              ...clipSelDiff,
            })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            pushSystem(ansiMsg(`\x1b[31m读取剪贴板失败: ${msg}\x1b[0m`))
            finishAuditCtx(snapClip, 'failed', msg)
          }
        })()
        return
      }

      if (localResult.kind === 'fallback_gateway') {
        if (!wsUrl.trim()) {
          pushSystem(
            ansiMsg(
              '\x1b[31m本地无法解析该 /edit。请连接 OpenClaw Gateway，或改用子命令（/edit help）。\x1b[0m'
            )
          )
          finish('rejected', 'gateway_url_missing')
          return
        }
        if (connection !== 'open') {
          pushSystem(
            ansiMsg(
              '\x1b[31m本地无法解析该 /edit。请先连接 OpenClaw，或改用子命令（/edit help）。\x1b[0m'
            )
          )
          finish('rejected', 'gateway_not_connected')
          return
        }
        void (async () => {
          useAgentStore.setState({ lastError: null })
          pushSystem(
            ansiMsg('\x1b[33m本地解析失败，正在通过 OpenClaw 解析编辑意图…\x1b[0m')
          )
          const preHash = hashContent(fullDocumentTextForHash(activeFile?.id, activeFile, fileText))
          const pm =
            origin === 'remote' && remoteSnap && meta?.correlationId
              ? {
                  correlationId: meta.correlationId,
                  sessionKey: remoteSnap.sessionKey,
                  channel: remoteSnap.channel,
                  deliveryId: remoteSnap.deliveryId,
                  pipelineStartMs: remoteSnap.pipelineStartMs ?? Date.now(),
                  originalCommand: trimmed,
                  baseContentHash: preHash,
                }
              : undefined
          try {
            const { version, intent } = await parseEditIntentFallback({
              freeform: localResult.rest,
              file: contextForSend.file,
              // Privacy: do not send full document text or selection to OpenClaw for /edit fallback.
              text: '',
              cursorPos: contextForSend.cursorPos,
              selection: null,
            })
            pushSystem(formatIntentForLog(version, intent))
            const r = applyParsedIntent(fileText, sel, version, intent)
            if (r.kind === 'edit') {
              if (r.newText === fileText) {
                pushSystem(ansiMsg('\x1b[33m意图未改变文档\x1b[0m'))
                finish('completed', 'no_document_change')
              } else {
                const intentSel = selectionProposalFieldsFromReplaceSelectionIntent(
                  intent,
                  fileText.length
                )
                setPendingProposal({
                  requestId: cmdRequestId,
                  newText: r.newText,
                  title: r.title,
                  summary: r.summary,
                  fileId: activeFile?.id,
                  filePath: activeFile?.path,
                  fileName: activeFile?.name,
                  remoteSessionKey: remoteSnap?.sessionKey,
                  sessionKey: remoteSnap?.sessionKey,
                  channel: remoteSnap?.channel,
                  deliveryId: origin === 'remote' ? remoteSnap?.deliveryId : undefined,
                  baseContentHash: pm ? pm.baseContentHash : hashContent(fileText),
                  originalCommand: trimmed,
                  correlationId: cmdCorrelationId,
                  remotePipelineStartMs: remoteSnap?.pipelineStartMs,
                  proposalCreatedAt: Date.now(),
                  ...(intentSel ?? {}),
                })
                pushSystem(
                  ansiMsg(
                    '\x1b[33m已生成修改提案：请在弹窗中确认 diff 后再点击「应用修改」。\x1b[0m'
                  )
                )
              }
            } else {
              handleApplyIntentResult(r, undefined, undefined, undefined, undefined, remoteSnap ?? undefined)
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            pushSystem(ansiMsg(`\x1b[31m${msg}\x1b[0m`))
            finish('failed', msg)
          }
        })()
        return
      }

      const { action, instruction } = classifyAction(trimmed)
      if (!instruction) {
        finish('rejected', 'unknown_command')
        return
      }

      if (!wsUrl.trim()) {
        pushSystem(ansiMsg('\x1b[31m请填写 Gateway 地址。\x1b[0m'))
        finish('rejected', 'gateway_url_missing')
        return
      }
      if (connection !== 'open') {
        pushSystem(ansiMsg('\x1b[31m未连接 OpenClaw Gateway。请先连接。\x1b[0m'))
        finish('rejected', 'gateway_not_connected')
        return
      }

      void (async () => {
        const preHash = hashContent(fullDocumentTextForHash(activeFile?.id, activeFile, fileText))
        const pm =
          origin === 'remote' && remoteSnap && meta?.correlationId
            ? {
                correlationId: meta.correlationId,
                sessionKey: remoteSnap.sessionKey,
                channel: remoteSnap.channel,
                deliveryId: remoteSnap.deliveryId,
                pipelineStartMs: remoteSnap.pipelineStartMs ?? Date.now(),
                originalCommand: trimmed,
                baseContentHash: preHash,
              }
            : undefined
        if (pm) enqueueRemoteIntentPipeline(pm)
        const ok = await send({ action, instruction, ...contextForSend, requestId: cmdRequestId })
        if (!ok) {
          pushSystem(
            ansiMsg(
              '\x1b[31m请求未能发出（未连接或网关拒绝）。请查看工具栏状态与系统消息。\x1b[0m'
            )
          )
          finish('failed', 'send_rejected')
          if (meta?.correlationId) discardRemoteIntentPipelineByCorrelation(meta.correlationId)
        }
      })()
    },
    [
      canUseAgent,
      contextForSend,
      contextForSkillSend,
      selection,
      fileText,
      wsUrl,
      connection,
      send,
      setPendingProposal,
      parseEditIntentFallback,
      parseFindIntentFallback,
      handleApplyIntentResult,
      pushSystem,
      proposalTargetFileByPath,
      effectiveProposalTargetFile,
      activeFile,
      files,
      updateContent,
      markModified,
      clearProposal,
      sendCommandStatus,
      finishAuditCtx,
      finishOpenCommandAudit,
      finishChannelAudit,
    ]
  )

  const handleSubmit = useCallback(
    (raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      pushUser(trimmed)
      setInputValue('')
      setCommandHistory((h) => {
        if (trimmed === h[h.length - 1]) return h
        const next = [...h, trimmed]
        if (next.length > CMD_HISTORY_MAX) {
          next.splice(0, next.length - CMD_HISTORY_MAX)
        }
        return next
      })
      processCommand(trimmed, { origin: 'local' })
    },
    [pushUser, processCommand]
  )

  useEffect(() => {
    setRemoteCommandExecutor((line, meta) => {
      const trimmed = line.trim()
      if (!trimmed) return

      const auditReject = (reason: string) => {
        const correlationId = meta.deliveryId ?? newAuditCorrelationId()
        void appendAuditLog({
          event: 'finished',
          correlationId,
          source: 'channel',
          command: trimmed,
          channel: meta.channel,
          sessionKey: meta.sessionKey,
          deliveryId: meta.deliveryId,
          outcome: 'rejected',
          reason,
        })
      }

      // /confirm and /cancel are confirmation responses, not new write pipelines.
      if (/^\/(confirm|cancel)\b/i.test(trimmed)) {
        pushUser(`[Channel] ${trimmed}`)
        processCommand(trimmed, {
          origin: 'remote',
          meta: { channel: meta.channel, sessionKey: meta.sessionKey, deliveryId: meta.deliveryId },
        })
        return
      }

      // Resolve the target file early when --file is specified.
      let resolvedFile = activeFile
      if (meta.targetFile) {
        const target = meta.targetFile.toLowerCase()
        const matched = useFileStore
          .getState()
          .files.find((f) => f.name.toLowerCase() === target)
        if (matched) {
          resolvedFile = matched
        } else {
          auditReject('target_file_not_open')
          if (meta.sessionKey) {
            sendCommandStatus(
              meta.sessionKey,
              `[ClawEditor] ${trimmed} → rejected: 文件「${meta.targetFile}」未在编辑器中打开`
            )
          }
          return
        }
      }

      const correlationId = meta.deliveryId ?? newAuditCorrelationId()
      const startedAt = Date.now()
      const auditCtx: CommandAuditContext = {
        correlationId,
        source: 'channel',
        command: trimmed,
        startMs: startedAt,
        channel: meta.channel,
        sessionKey: meta.sessionKey,
        deliveryId: meta.deliveryId,
        fileId: resolvedFile?.id,
        fileName: resolvedFile?.name,
      }
      inFlightChannelAuditsRef.current.set(correlationId, auditCtx)
      void appendAuditLog({
        event: 'accepted',
        correlationId,
        source: 'channel',
        command: trimmed,
        channel: meta.channel,
        sessionKey: meta.sessionKey,
        deliveryId: meta.deliveryId,
        file: resolvedFile?.name,
        fileId: resolvedFile?.id,
      })

      // Switch to the target tab if --file was specified.
      if (meta.targetFile && resolvedFile && resolvedFile.id !== activeFile?.id) {
        useFileStore.getState().setActiveFileId(resolvedFile.id)
      }

      pushUser(`[Channel] ${trimmed}`)

      // Send 'accepted' with current file context so Channel user knows what will be edited.
      if (meta.sessionKey) {
        const currentFile = resolvedFile?.name ?? activeFile?.name ?? '（无打开文件）'
        const openFiles = useFileStore.getState().files
        const fileListPart =
          openFiles.length > 1
            ? `\n当前打开的文件：${openFiles.map((f) => (f.name === currentFile ? `**${f.name}**（当前）` : f.name)).join(' · ')}\n如需指定其他文件，可在命令中加 --file <文件名>，例如：${trimmed.replace(/^(\/\w+)/, `$1 --file utils.ts`)}`
            : ''
        sendCommandStatus(
          meta.sessionKey,
          `[ClawEditor] ${trimmed} → accepted（操作文件：${currentFile}）${fileListPart}`
        )
      }
      processCommand(trimmed, {
        origin: 'remote',
        meta: {
          channel: meta.channel,
          sessionKey: meta.sessionKey,
          deliveryId: meta.deliveryId,
          targetFile: meta.targetFile,
          correlationId,
          pipelineStartMs: startedAt,
        },
      })
    })
    return () => setRemoteCommandExecutor(null)
  }, [pushUser, processCommand, sendCommandStatus, pendingProposal, activeFile])

  useEffect(() => {
    if (!lastError) return
    pushSystem(ansiMsg(`\x1b[31m${lastError}\x1b[0m`))
    const noProposal = useAgentStore.getState().pendingProposals.size === 0
    if (!noProposal) return
    for (const ctx of inFlightChannelAuditsRef.current.values()) {
      finishAuditCtx(ctx, 'failed', lastError)
      if (ctx.sessionKey) {
        sendCommandStatus(ctx.sessionKey, `[ClawEditor] ${ctx.command} → failed: ${lastError}`)
      }
    }
    inFlightChannelAuditsRef.current.clear()
    if (inFlightAuditRef.current) {
      finishOpenCommandAudit('failed', lastError)
    }
  }, [lastError, pushSystem, sendCommandStatus, finishOpenCommandAudit, finishAuditCtx])

  useEffect(() => {
    const el = chatLogRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  useEffect(() => {
    const prev = prevConnectionRef.current
    if (connection === 'open' && prev !== 'open') {
      pushSystem('已连接 OpenClaw Gateway')
    }
    prevConnectionRef.current = connection
  }, [connection, pushSystem])

  useEffect(() => {
    if (!incomingIntent) return
    if (!canUseAgent || !activeFile) return

    const payload = takeIncomingIntent()
    if (!payload) return

    const sel =
      selection && selection.from !== selection.to
        ? { from: selection.from, to: selection.to, text: selection.text }
        : null

    const baseFile =
      payload.fileId ? files.find((f) => f.id === payload.fileId) ?? activeFile : activeFile
    const baseText = typeof baseFile?.content === 'string' ? baseFile.content : fileText
    const result = applyParsedIntent(baseText, sel, payload.version, payload.intent)
    if (result.kind === 'edit') {
      if (result.newText === baseText) {
        pushSystem(ansiMsg('\x1b[33m意图未改变文档\x1b[0m'))
        if (payload.remotePipeline?.correlationId) {
          finishChannelAudit(payload.remotePipeline.correlationId, 'completed', 'no_document_change')
        } else {
          finishOpenCommandAudit('completed', 'no_document_change')
        }
      } else {
        const intentSel = selectionProposalFieldsFromReplaceSelectionIntent(
          payload.intent,
          baseText.length
        )
        setPendingProposal({
          requestId: payload.requestId ?? `intent-${Date.now()}`,
          newText: result.newText,
          title: result.title,
          summary: result.summary,
          fileId: payload.fileId,
          filePath: payload.filePath,
          fileName: payload.fileName,
          remoteSessionKey: payload.remotePipeline?.sessionKey,
          sessionKey: payload.remotePipeline?.sessionKey,
          channel: payload.remotePipeline?.channel,
          deliveryId: payload.remotePipeline?.deliveryId,
          baseContentHash: payload.remotePipeline?.baseContentHash ?? hashContent(baseText),
          correlationId: payload.remotePipeline?.correlationId ?? inFlightAuditRef.current?.correlationId,
          remotePipelineStartMs: payload.remotePipeline?.pipelineStartMs,
          originalCommand: payload.remotePipeline?.originalCommand,
          proposalCreatedAt: Date.now(),
          ...(intentSel ?? {}),
          ...(payload.skillId === 'aicorrect'
            ? { proposalDiffVariant: 'side_by_side_interactive' as const }
            : {}),
        })
        pushSystem(
          ansiMsg(
            '\x1b[33m已生成修改提案：请在弹窗中确认 diff 后再应用。\x1b[0m'
          )
        )
      }
    } else {
      handleApplyIntentResult(
        result,
        payload.requestId,
        undefined,
        undefined,
        undefined,
        payload.remotePipeline
          ? {
              sessionKey: payload.remotePipeline.sessionKey,
              channel: payload.remotePipeline.channel,
              deliveryId: payload.remotePipeline.deliveryId,
              correlationId: payload.remotePipeline.correlationId,
              pipelineStartMs: payload.remotePipeline.pipelineStartMs,
              originalCommand: payload.remotePipeline.originalCommand,
            }
          : undefined
      )
    }
  }, [
    incomingIntent,
    takeIncomingIntent,
    canUseAgent,
    activeFile,
    fileText,
    files,
    pushSystem,
    setPendingProposal,
    selection,
    handleApplyIntentResult,
    finishOpenCommandAudit,
    finishChannelAudit,
  ])

  const [staleWarning, setStaleWarning] = useState(false)

  // Reset stale warning when active proposal changes
  useEffect(() => {
    setStaleWarning(false)
  }, [activeProposalId])

  const applyProposalAll = useCallback(() => {
    if (!pendingProposal) return
    const targetId =
      pendingProposal.fileId ??
      proposalTargetFileByPath?.id ??
      effectiveProposalTargetFile?.id ??
      activeFile?.id
    if (!targetId) return
    // Stale-content check
    const targetFile = files.find((f) => f.id === targetId)
    const currentContent = typeof targetFile?.content === 'string' ? targetFile.content : ''
    if (pendingProposal.baseContentHash !== undefined && hashContent(currentContent) !== pendingProposal.baseContentHash) {
      setStaleWarning(true)
      return
    }
    updateContent(targetId, pendingProposal.newText)
    markModified(targetId, true)
    clearProposal(pendingProposal.requestId)
    setStaleWarning(false)
    pushSystem(ansiMsg('\x1b[32m修改已应用\x1b[0m'))
    if (pendingProposal.remoteSessionKey && pendingProposal.correlationId) {
      const durationMs = Date.now() - (pendingProposal.remotePipelineStartMs ?? pendingProposal.proposalCreatedAt)
      sendCommandStatus(
        pendingProposal.sessionKey!,
        `[ClawEditor] ${pendingProposal.originalCommand ?? ''} → completed (${durationMs}ms)`
      )
      finishChannelAudit(pendingProposal.correlationId, 'completed')
    } else {
      finishOpenCommandAudit('completed')
    }
  }, [
    pendingProposal,
    proposalTargetFileByPath?.id,
    effectiveProposalTargetFile?.id,
    activeFile?.id,
    files,
    updateContent,
    markModified,
    clearProposal,
    pushSystem,
    sendCommandStatus,
    finishOpenCommandAudit,
    finishChannelAudit,
  ])

  const applyProposalSelected = useCallback(() => {
    if (!pendingProposal || !proposalDiff) return
    const sb = proposalDiff.sideBySide
    if (!sb?.lineAligned) {
      pushSystem(ansiMsg('\x1b[31m无法按行部分应用（行数不一致）。\x1b[0m'))
      return
    }
    const changedRows = sb.rows.filter((r) => r.changed)
    if (changedRows.length > 0 && !changedRows.some((r) => adoptedDiffLines.has(r.lineIndex))) {
      pushSystem(ansiMsg('\x1b[33m未选中任何修改（差异行需至少采纳一行）。\x1b[0m'))
      return
    }
    const m = mergeLinesByAdoption(proposalDiff.before, proposalDiff.after, adoptedDiffLines, true)
    if (!m.ok) {
      pushSystem(ansiMsg(`\x1b[31m${m.message}\x1b[0m`))
      return
    }
    let out = m.text
    if (
      pendingProposal.diffMode === 'selection' &&
      pendingProposal.selectionFrom !== undefined &&
      pendingProposal.selectionTo !== undefined
    ) {
      out = mergeRange(
        proposalFileText,
        pendingProposal.selectionFrom,
        pendingProposal.selectionTo,
        m.text
      )
    }
    const targetId =
      pendingProposal.fileId ??
      proposalTargetFileByPath?.id ??
      effectiveProposalTargetFile?.id ??
      activeFile?.id
    if (!targetId) return
    // Stale-content check
    const targetFile = files.find((f) => f.id === targetId)
    const currentContent = typeof targetFile?.content === 'string' ? targetFile.content : ''
    if (pendingProposal.baseContentHash !== undefined && hashContent(currentContent) !== pendingProposal.baseContentHash) {
      setStaleWarning(true)
      return
    }
    updateContent(targetId, out)
    markModified(targetId, true)
    clearProposal(pendingProposal.requestId)
    setStaleWarning(false)
    pushSystem(ansiMsg('\x1b[32m已应用所选修改\x1b[0m'))
    if (pendingProposal.remoteSessionKey && pendingProposal.correlationId) {
      const durationMs = Date.now() - (pendingProposal.remotePipelineStartMs ?? pendingProposal.proposalCreatedAt)
      sendCommandStatus(
        pendingProposal.sessionKey!,
        `[ClawEditor] ${pendingProposal.originalCommand ?? ''} → completed (${durationMs}ms)`
      )
      finishChannelAudit(pendingProposal.correlationId, 'completed')
    } else {
      finishOpenCommandAudit('completed')
    }
  }, [
    pendingProposal,
    proposalDiff,
    adoptedDiffLines,
    proposalFileText,
    proposalTargetFileByPath?.id,
    effectiveProposalTargetFile?.id,
    activeFile?.id,
    files,
    updateContent,
    markModified,
    clearProposal,
    pushSystem,
    finishOpenCommandAudit,
    finishChannelAudit,
    sendCommandStatus,
  ])

  const interactiveSideBySideProposal = Boolean(
    pendingProposal?.proposalDiffVariant === 'side_by_side_interactive' &&
      proposalDiff?.sideBySide?.lineAligned
  )

  /** Wraps clearProposal to also send a 'failed' status back to the Channel. */
  const handleRejectProposal = useCallback(() => {
    if (pendingProposal?.remoteSessionKey && pendingProposal.correlationId) {
      const durationMs = Date.now() - (pendingProposal.remotePipelineStartMs ?? pendingProposal.proposalCreatedAt)
      sendCommandStatus(
        pendingProposal.sessionKey!,
        `[ClawEditor] ${pendingProposal.originalCommand ?? ''} → failed: user rejected the proposal (${durationMs}ms)`
      )
      finishChannelAudit(pendingProposal.correlationId, 'failed', 'user_rejected_proposal')
    } else {
      finishOpenCommandAudit('failed', 'user_rejected_proposal')
    }
    if (pendingProposal) {
      clearProposal(pendingProposal.requestId)
    }
    setStaleWarning(false)
  }, [pendingProposal, clearProposal, sendCommandStatus, finishOpenCommandAudit, finishChannelAudit])

  // When a remote proposal arrives, send the diff to Channel for confirmation.
  useEffect(() => {
    const proposal = pendingProposal
    if (!proposal?.remoteSessionKey) return
    const sessionKey = proposal.remoteSessionKey
    const fileName = effectiveProposalTargetFile?.name ?? 'unknown'
    const before = proposalFileText
    const after = proposal.newText
    const command = proposal.originalCommand ?? ''

    if (before === after) {
      // No actual change — notify and clear immediately.
      sendCommandStatus(sessionKey, `[ClawEditor] ${command} → 命令未产生修改`)
      clearProposal(proposal.requestId)
      if (proposal.correlationId) {
        finishChannelAudit(proposal.correlationId, 'completed', 'no_document_change')
      } else {
        finishOpenCommandAudit('completed', 'no_document_change')
      }
      return
    }

    const diffText = generateUnifiedDiff(before, after, fileName)
    const msg = [
      `[ClawEditor] ${command} → diff preview (${fileName}):`,
      '```diff',
      diffText,
      '```',
      '回复 /confirm 应用修改，/cancel 取消。',
    ].join('\n')
    sendCommandStatus(sessionKey, msg)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProposal?.remoteSessionKey])

  const handleConnect = () => {
    if (connection === 'open') {
      void disconnect().then(() => {
        pushSystem(ansiMsg('\x1b[33m已断开连接\x1b[0m'))
      })
    } else {
      void connect()
    }
  }

  return (
    <div className="agent-panel" style={{ height }}>
      <div className="agent-toolbar">
        <input
          className="agent-ws-url"
          type="text"
          value={wsUrl}
          onChange={(e) => setWsUrl(e.target.value)}
          placeholder="ws://127.0.0.1:18789"
          disabled={connection === 'connecting'}
          title="Gateway WebSocket 地址"
        />
        <input
          className="agent-token-field"
          type="password"
          value={gatewayToken}
          onChange={(e) => setGatewayToken(e.target.value)}
          placeholder="Token（token 模式）"
          autoComplete="off"
          spellCheck={false}
          disabled={connection === 'connecting'}
          title="与正在运行的 Gateway 解析出的 gateway.auth.token 完全一致。若配置与环境变量都有，以实际进程为准；勿带引号。"
        />
        <input
          className="agent-token-field agent-password-field"
          type="password"
          value={gatewayPassword}
          onChange={(e) => setGatewayPassword(e.target.value)}
          placeholder="密码（password 模式，与 token 二选一）"
          autoComplete="off"
          spellCheck={false}
          disabled={connection === 'connecting'}
          title="仅当网关为 password 认证时填写 gateway.auth.password；与上一栏不要同时填（同时填时优先使用 Token）。"
        />
        <label
          className="agent-remote-edit-label"
          title="同一 OpenClaw Gateway 仅允许一台编辑器接收频道发来的 /edit、/aiedit 等远程命令。需安装 claweditor-gateway 插件。"
        >
          <input
            type="checkbox"
            checked={remoteEditReceive}
            disabled={connection === 'connecting'}
            onChange={(e) => {
              const v = e.target.checked
              void setRemoteEditReceive(v).catch((err) => {
                window.alert(err instanceof Error ? err.message : String(err))
              })
            }}
          />
          <span>开启远程编辑</span>
        </label>
        <button
          type="button"
          className={`agent-btn${connection === 'open' ? '' : ' primary'}`}
          onClick={handleConnect}
          disabled={connection === 'connecting'}
        >
          {connection === 'open' ? '断开' : connection === 'connecting' ? '连接中...' : '连接'}
        </button>
        <span className="agent-status">
          {connection === 'open' ? '已连接' : connection === 'connecting' ? '连接中…' : '未连接'}
        </span>
        {!canUseAgent ? (
          <span className="agent-hint">请打开非 PDF 文本文件以使用 Agent</span>
        ) : selection && selection.from !== selection.to ? (
          <span className="agent-hint">选区优先（{selection.text.length} 字符）</span>
        ) : null}
      </div>

      <div className="agent-chat-log" ref={chatLogRef}>
        <div className="agent-chat-messages">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`agent-chat-msg agent-chat-msg-${m.role}`}
            >
              <div className="agent-chat-msg-role">
                {m.role === 'user'
                  ? '你'
                  : m.role === 'assistant'
                    ? 'OpenClaw'
                    : '系统'}
              </div>
              <pre className="agent-chat-msg-body">{m.content}</pre>
            </div>
          ))}
          {streaming ? (
            <div className="agent-chat-msg agent-chat-msg-assistant agent-chat-streaming">
              <div className="agent-chat-msg-role">OpenClaw · 生成中</div>
              <pre className="agent-chat-msg-body agent-chat-stream-body">{streaming}</pre>
            </div>
          ) : null}
        </div>
      </div>

      <div className="agent-chat-input-row">
        <AgentChatInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          placeholder={inputPlaceholder}
          disabled={!canUseAgent}
          commandHistory={commandHistory}
          aria-label="Agent 指令与对话"
        />
      </div>

      {pendingProposal && effectiveProposalTargetFile && !pendingProposal.remoteSessionKey ? (
        <div className="agent-proposal-overlay" role="dialog" aria-modal="true">
          <div className="agent-proposal-card">
            <div className="agent-proposal-title">
              {pendingProposal.title || '确认修改'}
              {pendingProposalCount > 1 ? (
                <span className="agent-proposal-queue-badge">
                  {Array.from(pendingProposals.keys()).indexOf(activeProposalId ?? '') + 1}/{pendingProposalCount}
                  <button
                    type="button"
                    className="agent-btn agent-proposal-skip-btn"
                    title="跳过此提案，查看下一条"
                    onClick={() => {
                      const ids = Array.from(pendingProposals.keys())
                      const cur = ids.indexOf(activeProposalId ?? '')
                      const next = ids[(cur + 1) % ids.length]
                      if (next && next !== activeProposalId) setActiveProposalId(next)
                    }}
                  >
                    跳过
                  </button>
                </span>
              ) : null}
            </div>
            {(pendingProposal.fileId || pendingProposal.filePath) &&
            activeFile &&
            effectiveProposalTargetFile.id !== activeFile.id ? (
              <div className="agent-proposal-summary">
                该提案属于「{effectiveProposalTargetFile.name}」。你当前在「{activeFile.name}」。
                <button
                  type="button"
                  className="agent-btn"
                  style={{ marginLeft: 8 }}
                  onClick={() => setActiveFileId(effectiveProposalTargetFile.id)}
                >
                  切换到目标文件
                </button>
              </div>
            ) : null}
            {pendingProposal.summary ? (
              <div className="agent-proposal-summary">{pendingProposal.summary}</div>
            ) : null}
            <div className="agent-proposal-diff-wrap">
              <TextDiffView
                before={proposalDiff?.before ?? proposalFileText}
                after={proposalDiff?.after ?? pendingProposal.newText}
                subtitle={
                  proposalDiff?.subtitle ??
                  `${effectiveProposalTargetFile.name} vs 建议内容（应用到目标文件）`
                }
                variant={
                  pendingProposal.proposalDiffVariant === 'side_by_side_interactive'
                    ? 'sideBySide'
                    : 'unified'
                }
                interactive={interactiveSideBySideProposal}
                adoptedLineIndices={adoptedDiffLines}
                onToggleAdoptedLine={toggleAdoptedLine}
              />
            </div>
            <div className="agent-proposal-buttons">
              {staleWarning ? (
                <div className="agent-proposal-stale-warning">
                  文件内容已被修改，提案基于旧版本。
                  <button
                    type="button"
                    className="agent-btn"
                    onClick={() => {
                      const orig = pendingProposal.originalCommand
                      clearProposal(pendingProposal.requestId)
                      setStaleWarning(false)
                      if (orig) processCommand(orig, { origin: 'local' })
                    }}
                  >
                    基于最新内容重新执行
                  </button>
                  <button
                    type="button"
                    className="agent-btn"
                    onClick={() => {
                      clearProposal(pendingProposal.requestId)
                      setStaleWarning(false)
                    }}
                  >
                    取消提案
                  </button>
                </div>
              ) : null}
              <button type="button" className="agent-btn" onClick={handleRejectProposal}>
                取消
              </button>
              {interactiveSideBySideProposal ? (
                <>
                  <button
                    type="button"
                    className="agent-btn"
                    onClick={applyProposalSelected}
                  >
                    应用所选修改
                  </button>
                  <button
                    type="button"
                    className="agent-btn primary"
                    onClick={applyProposalAll}
                  >
                    应用全部修改
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="agent-btn primary"
                  onClick={applyProposalAll}
                >
                  应用修改
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {actionModal.kind !== 'none' ? (
        <div className="external-file-dialog-overlay" role="dialog" aria-modal="true">
          <div className="external-file-dialog-card">
            <div className="external-file-dialog-title">{actionModal.title}</div>
            {actionModal.kind === 'prompt' ? (
              <div className="external-file-dialog-body">
                <input
                  type="text"
                  className="agent-ws-url"
                  placeholder={actionModal.placeholder ?? ''}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const v = (e.target as HTMLInputElement).value
                      const r = actionModal.resolve
                      setActionModal({ kind: 'none' })
                      r(v)
                    } else if (e.key === 'Escape') {
                      const r = actionModal.resolve
                      setActionModal({ kind: 'none' })
                      r(null)
                    }
                  }}
                />
              </div>
            ) : actionModal.kind === 'one_select' ? (
              <div className="external-file-dialog-body">
                <div className="external-file-dialog-buttons" style={{ flexWrap: 'wrap' }}>
                  {actionModal.options.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className="agent-btn"
                      onClick={() => {
                        const r = actionModal.resolve
                        setActionModal({ kind: 'none' })
                        r(opt.id)
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="agent-btn"
                    onClick={() => {
                      const r = actionModal.resolve
                      setActionModal({ kind: 'none' })
                      r(null)
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
