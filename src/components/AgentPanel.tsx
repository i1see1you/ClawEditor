import { useEffect, useRef, useMemo, useCallback } from 'react'
import { computeSelectionDiffSlices } from '../utils/selectionMergeDiff'
import { useAgentStore } from '../store/agentStore'
import { useEditorStore } from '../store/editorStore'
import { useFileStore } from '../store/fileStore'
import type { FileTab } from '../types'
import { TextDiffView } from './TextDiffView'
import { XTerminal, type XTerminalRef } from './XTerminal'
import type { OpenClawAction } from '../openclaw/types'
import { applyParsedIntent, type ApplyIntentResult } from '../openclaw/applyIntent'
import { gotoLineInEditor } from '../utils/gotoLine'
import { parseSimpleEditInstruction } from '../utils/simpleCommands'
import { mergeRange } from '../utils/documentOps'
import {
  MAX_INSERT_CHARS,
  tryParseInsertAppendBody,
} from '../utils/parseEditInsertAppend'

interface AgentPanelProps {
  activeFile: FileTab | undefined
  height: number
}

type LocalEditParseResult =
  | { kind: 'help'; text: string }
  | { kind: 'edit'; newText: string; summary: string }
  | { kind: 'error'; message: string }
  | { kind: 'fallback_gateway'; rest: string }
  | { kind: 'noop' }
  | {
      kind: 'edit_clipboard'
      op: 'insert' | 'append' | 'replace_file' | 'replace_selection'
    }

export function AgentPanel({ activeFile, height }: AgentPanelProps) {
  const termRef = useRef<XTerminalRef>(null)
  const streamWrittenLenRef = useRef(0)

  const wsUrl = useAgentStore((s) => s.wsUrl)
  const setWsUrl = useAgentStore((s) => s.setWsUrl)
  const gatewayToken = useAgentStore((s) => s.gatewayToken)
  const setGatewayToken = useAgentStore((s) => s.setGatewayToken)
  const gatewayPassword = useAgentStore((s) => s.gatewayPassword)
  const setGatewayPassword = useAgentStore((s) => s.setGatewayPassword)
  const connection = useAgentStore((s) => s.connection)
  const pendingProposal = useAgentStore((s) => s.pendingProposal)
  const lastError = useAgentStore((s) => s.lastError)
  const connect = useAgentStore((s) => s.connect)
  const disconnect = useAgentStore((s) => s.disconnect)
  const send = useAgentStore((s) => s.send)
  const parseEditIntentFallback = useAgentStore((s) => s.parseEditIntentFallback)
  const clearProposal = useAgentStore((s) => s.clearProposal)
  const setPendingProposal = useAgentStore((s) => s.setPendingProposal)
  const messages = useAgentStore((s) => s.messages)
  const streaming = useAgentStore((s) => s.streaming)
  const incomingIntent = useAgentStore((s) => s.incomingIntent)
  const takeIncomingIntent = useAgentStore((s) => s.takeIncomingIntent)

  const selection = useEditorStore((s) => s.selection)

  const updateContent = useFileStore((s) => s.updateContent)
  const markModified = useFileStore((s) => s.markModified)

  const canUseAgent = Boolean(
    activeFile &&
      !activeFile.isPdf &&
      typeof activeFile.content === 'string' &&
      activeFile.path
  )

  const fileText = typeof activeFile?.content === 'string' ? activeFile.content : ''

  const proposalDiff = useMemo(() => {
    if (!pendingProposal) return null
    const p = pendingProposal
    if (
      p.diffMode === 'selection' &&
      p.selectionFrom !== undefined &&
      p.selectionTo !== undefined
    ) {
      const r = computeSelectionDiffSlices(fileText, p.newText, p.selectionFrom, p.selectionTo)
      if (r.ok) {
        return {
          before: r.before,
          after: r.after,
          subtitle: '仅选区 vs 建议（应用后仍写入合并全文）',
        }
      }
      return {
        before: fileText,
        after: p.newText,
        subtitle: '选区外也有变更或未对齐，已显示全文 diff',
      }
    }
    return {
      before: fileText,
      after: p.newText,
      subtitle: '当前文件 vs 建议内容（全文）',
    }
  }, [pendingProposal, fileText])

  const classifyAction = (raw: string): { action: OpenClawAction; instruction: string } => {
    const t = raw.trim()
    let m = t.match(/^\/(explain|format)\s*(.*)$/i)
    if (m) {
      const a = m[1].toLowerCase() as OpenClawAction
      const rest = (m[2] ?? '').trim()
      return { action: a, instruction: rest || t }
    }

    if (/^(格式化|format)\b/i.test(t)) return { action: 'format', instruction: t }
    if (/^(解释|explain|说明|讲解)\b/i.test(t)) return { action: 'explain', instruction: t }
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
      // /edit replace A with B
      // /edit replace A -> B
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
        }
      }
    }

    // Back-compat: allow "/edit <freeform>" to use existing local parser,
    // but keep the "one entry point" requirement (must be prefixed by /edit).
    const local = parseSimpleEditInstruction(fileTextRaw, rest, sel)
    if (local) return { kind: 'edit', newText: local.newText, summary: local.summary }
    return { kind: 'fallback_gateway', rest }
  }

  const contextForSend = useMemo(() => {
    if (!activeFile) return null
    return {
      file: {
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

  const handleApplyIntentResult = useCallback(
    (result: ApplyIntentResult, requestId?: string) => {
      switch (result.kind) {
        case 'edit':
          if (result.newText === fileText) {
            termRef.current?.writeln('\x1b[33m意图未改变文档\x1b[0m')
          } else {
            setPendingProposal({
              requestId,
              newText: result.newText,
              title: result.title,
              summary: result.summary,
            })
            termRef.current?.writeln('\x1b[33m已生成修改提案：请在弹窗中确认 diff 后再点击“应用修改”。\x1b[0m')
          }
          break
        case 'goto': {
          const view = useEditorStore.getState().editorView
          if (!view) {
            termRef.current?.writeln('\x1b[33m编辑器尚未就绪，无法跳转行\x1b[0m')
            break
          }
          if (!gotoLineInEditor(view, result.line)) {
            termRef.current?.writeln(`\x1b[33m无法跳转到第 ${result.line} 行\x1b[0m`)
          }
          break
        }
        case 'clarify':
          termRef.current?.writeln(`\x1b[33m${result.message}\x1b[0m`)
          break
        case 'noop':
          break
        case 'error':
          termRef.current?.writeln(`\x1b[31m${result.message}\x1b[0m`)
          break
      }
    },
    [fileText, setPendingProposal]
  )

  const handleCommand = useCallback(
    (line: string) => {
      if (!canUseAgent || !contextForSend) {
        termRef.current?.writeln('\x1b[33m请打开文本文件以使用 Agent\x1b[0m')
        return
      }

      const trimmed = line.trim()
      if (!trimmed) return

      const sel =
        selection && selection.from !== selection.to
          ? { from: selection.from, to: selection.to, text: selection.text }
          : null
      const cursorPos = selection?.from ?? 0

      const aieditMatch = trimmed.match(/^\/aiedit(?:\s+([\s\S]*))?$/i)
      if (aieditMatch) {
        const rest = (aieditMatch[1] ?? '').trim()
        const helpText = [
          '用法：/aiedit <自然语言指令>',
          '',
          '  由 OpenClaw 按 skills/aiedit/SKILL.md 协议改写；回复应为 JSON（四种本地 op）或由 Gateway diff 工具给出合并全文；需已连接 Gateway。',
          '  无选区：附带全文，确认时为全文 diff。',
          '  有选区：发送选区与全文，确认时可仅 diff 选区。',
          '',
          '  示例：/aiedit 把语气改得更正式',
        ].join('\n')
        if (!rest || /^help$/i.test(rest) || /^h$/i.test(rest) || /^帮助$/.test(rest)) {
          useAgentStore.setState({ lastError: null })
          termRef.current?.writeln(helpText)
          return
        }
        if (!wsUrl.trim()) {
          termRef.current?.writeln('\x1b[31m请填写 Gateway 地址。\x1b[0m')
          return
        }
        if (connection !== 'open') {
          termRef.current?.writeln('\x1b[31m未连接 OpenClaw Gateway。请先连接。\x1b[0m')
          return
        }
        void (async () => {
          useAgentStore.setState({ lastError: null })
          const ok = await send({
            action: 'aiedit',
            instruction: rest,
            ...contextForSend!,
          })
          if (!ok) {
            termRef.current?.writeln(
              '\x1b[31m请求未能发出（未连接或网关拒绝）。请查看工具栏状态与系统消息。\x1b[0m'
            )
          }
        })()
        return
      }

      const aiimportMatch = trimmed.match(/^\/aiimport(?:\s+([\s\S]*))?$/i)
      if (aiimportMatch) {
        const rest = (aiimportMatch[1] ?? '').trim()
        const helpText = [
          '用法：/aiimport <自然语言说明>',
          '',
          '  按 skills/aiimport/SKILL.md 将外部内容导入当前缓冲；模型仅输出 JSON（四种本地 op）或 diff。',
          '  需已连接 Gateway。',
          '',
          '  示例：/aiimport 把下面这段接在文末：……',
        ].join('\n')
        if (!rest || /^help$/i.test(rest) || /^h$/i.test(rest) || /^帮助$/.test(rest)) {
          useAgentStore.setState({ lastError: null })
          termRef.current?.writeln(helpText)
          return
        }
        if (!wsUrl.trim()) {
          termRef.current?.writeln('\x1b[31m请填写 Gateway 地址。\x1b[0m')
          return
        }
        if (connection !== 'open') {
          termRef.current?.writeln('\x1b[31m未连接 OpenClaw Gateway。请先连接。\x1b[0m')
          return
        }
        void (async () => {
          useAgentStore.setState({ lastError: null })
          const ok = await send({
            action: 'aiimport',
            instruction: rest,
            ...contextForSend!,
          })
          if (!ok) {
            termRef.current?.writeln(
              '\x1b[31m请求未能发出（未连接或网关拒绝）。请查看工具栏状态与系统消息。\x1b[0m'
            )
          }
        })()
        return
      }

      const localResult = parseLocalEdit(fileText, trimmed, sel, cursorPos)
      if (localResult.kind === 'help') {
        useAgentStore.setState({ lastError: null })
        termRef.current?.writeln(localResult.text)
        return
      }
      if (localResult.kind === 'error') {
        useAgentStore.setState({ lastError: null })
        termRef.current?.writeln(`\x1b[31m${localResult.message}\x1b[0m`)
        return
      }
      if (localResult.kind === 'edit') {
        useAgentStore.setState({ lastError: null })
        if (localResult.newText === fileText) {
          termRef.current?.writeln('\x1b[33m本地命令没有产生变化\x1b[0m')
        } else {
          setPendingProposal({
            newText: localResult.newText,
            title: '本地命令',
            summary: localResult.summary,
          })
        }
        return
      }

      if (localResult.kind === 'edit_clipboard') {
        useAgentStore.setState({ lastError: null })
        void (async () => {
          try {
            if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
              termRef.current?.writeln(
                '\x1b[31m当前环境无法读取剪贴板（需安全上下文与权限）。\x1b[0m'
              )
              return
            }
            const text = await navigator.clipboard.readText()
            if (text.length > MAX_INSERT_CHARS) {
              termRef.current?.writeln(
                `\x1b[31m剪贴板内容过长（>${MAX_INSERT_CHARS} 字符）。\x1b[0m`
              )
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
                termRef.current?.writeln(
                  '\x1b[31mreplace-selection 需要非空选区。\x1b[0m'
                )
                return
              }
              newText = mergeRange(fileText, sel.from, sel.to, text)
              summary = `从剪贴板替换选区（${text.length} 字符）`
            }
            if (newText === fileText) {
              termRef.current?.writeln('\x1b[33m剪贴板为空，未修改文档。\x1b[0m')
              return
            }
            setPendingProposal({
              newText,
              title: '本地命令',
              summary,
            })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            termRef.current?.writeln(`\x1b[31m读取剪贴板失败: ${msg}\x1b[0m`)
          }
        })()
        return
      }

      if (localResult.kind === 'fallback_gateway') {
        if (!wsUrl.trim()) {
          termRef.current?.writeln(
            '\x1b[31m本地无法解析该 /edit。请连接 OpenClaw Gateway，或改用子命令（/edit help）。\x1b[0m'
          )
          return
        }
        if (connection !== 'open') {
          termRef.current?.writeln(
            '\x1b[31m本地无法解析该 /edit。请先连接 OpenClaw，或改用子命令（/edit help）。\x1b[0m'
          )
          return
        }
        void (async () => {
          useAgentStore.setState({ lastError: null })
          termRef.current?.writeln('\x1b[33m本地解析失败，正在通过 OpenClaw 解析编辑意图…\x1b[0m')
          try {
            const { version, intent } = await parseEditIntentFallback({
              freeform: localResult.rest,
              ...contextForSend,
            })
            const r = applyParsedIntent(fileText, sel, version, intent)
            handleApplyIntentResult(r)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            termRef.current?.writeln(`\x1b[31m${msg}\x1b[0m`)
          }
        })()
        return
      }

      const { action, instruction } = classifyAction(trimmed)
      if (!instruction) return

      if (!wsUrl.trim()) {
        termRef.current?.writeln('\x1b[31m请填写 Gateway 地址。\x1b[0m')
        return
      }
      if (connection !== 'open') {
        termRef.current?.writeln('\x1b[31m未连接 OpenClaw Gateway。请先连接。\x1b[0m')
        return
      }

      void (async () => {
        const ok = await send({ action, instruction, ...contextForSend })
        if (!ok) {
          termRef.current?.writeln(
            '\x1b[31m请求未能发出（未连接或网关拒绝）。请查看工具栏状态与系统消息。\x1b[0m'
          )
        }
      })()
    },
    [
      canUseAgent,
      contextForSend,
      selection,
      fileText,
      wsUrl,
      connection,
      send,
      wsUrl,
      setPendingProposal,
      parseEditIntentFallback,
      handleApplyIntentResult,
    ]
  )

  useEffect(() => {
    const term = termRef.current
    if (!term) return

    if (lastError) {
      term.writeln(`\x1b[31m${lastError}\x1b[0m`)
      term.write('> ')
      term.focus()
    }
  }, [lastError])

  useEffect(() => {
    const term = termRef.current
    if (!term) return

    messages.slice(-1).forEach((m) => {
      const prefix = m.role === 'user' ? '\x1b[36m>\x1b[0m ' : m.role === 'assistant' ? '\x1b[32mOpenClaw:\x1b[0m ' : '\x1b[33m系统:\x1b[0m '
      const lines = m.content.split('\n')
      lines.forEach((line, i) => {
        if (i === 0) term.writeln(prefix + line)
        else term.writeln('  ' + line)
      })
    })
  }, [messages])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const s = streaming
    if (s.length === 0) {
      streamWrittenLenRef.current = 0
      return
    }
    const w = streamWrittenLenRef.current
    if (s.length >= w) {
      term.write(s.slice(w))
      streamWrittenLenRef.current = s.length
    }
  }, [streaming])

  useEffect(() => {
    if (!incomingIntent) return
    if (!canUseAgent || !activeFile) return

    const payload = takeIncomingIntent()
    if (!payload) return

    const sel =
      selection && selection.from !== selection.to
        ? { from: selection.from, to: selection.to, text: selection.text }
        : null

    const result = applyParsedIntent(fileText, sel, payload.version, payload.intent)
    handleApplyIntentResult(result, payload.requestId)
  }, [
    incomingIntent,
    takeIncomingIntent,
    canUseAgent,
    activeFile,
    fileText,
    selection,
    handleApplyIntentResult,
  ])

  const applyProposal = () => {
    if (!activeFile || !pendingProposal) return
    updateContent(activeFile.id, pendingProposal.newText)
    markModified(activeFile.id, true)
    clearProposal()
    termRef.current?.writeln('\x1b[32m修改已应用\x1b[0m')
  }

  const handleConnect = () => {
    if (connection === 'open') {
      void disconnect().then(() => {
        termRef.current?.writeln('\x1b[33m已断开连接\x1b[0m')
      })
    } else {
      void connect()
    }
  }

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (connection === 'open') {
      term.writeln('\x1b[32m已连接 OpenClaw\x1b[0m')
      term.write('> ')
      term.focus()
    }
    // 断开/错误请依赖工具栏状态与 lastError 提示。
  }, [connection])

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

      <div
        className="agent-terminal-wrap"
        role="presentation"
        onMouseDown={() => {
          termRef.current?.focus()
        }}
      >
        <XTerminal
          ref={termRef}
          onLine={handleCommand}
          prompt="> "
          className="agent-terminal"
        />
      </div>

      {pendingProposal && activeFile ? (
        <div className="agent-proposal-overlay" role="dialog" aria-modal="true">
          <div className="agent-proposal-card">
            <div className="agent-proposal-title">
              {pendingProposal.title || '确认修改'}
            </div>
            {pendingProposal.summary ? (
              <div className="agent-proposal-summary">{pendingProposal.summary}</div>
            ) : null}
            <div className="agent-proposal-diff-wrap">
              <TextDiffView
                before={proposalDiff?.before ?? fileText}
                after={proposalDiff?.after ?? pendingProposal.newText}
                subtitle={proposalDiff?.subtitle ?? '当前文件 vs 建议内容（仅当前文件）'}
              />
            </div>
            <div className="agent-proposal-buttons">
              <button type="button" className="agent-btn" onClick={clearProposal}>
                取消
              </button>
              <button type="button" className="agent-btn primary" onClick={applyProposal}>
                应用修改
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}