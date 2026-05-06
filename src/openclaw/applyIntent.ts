import type { FindQuerySpec } from '../utils/applyFindInEditor'
import {
  applyReplaceAll,
  applyReplaceRegex,
  applyDeleteLiteral,
  applyLineOp,
  applyCaseOp,
  mergeRange,
  type DocSelectionNullable,
} from '../utils/documentOps'
import { isLocalEditFourOp, applyLocalEditFourIntent } from '../utils/localEditCommand'
import { SUPPORTED_INTENT_PROTOCOL_VERSION, type EditorIntentV1, type IntentScope } from './intentTypes'

export type ApplyIntentResult =
  | { kind: 'edit'; newText: string; summary: string; title: string }
  | { kind: 'goto'; line: number }
  | { kind: 'find'; spec: FindQuerySpec }
  | { kind: 'clarify'; message: string }
  | { kind: 'noop' }
  | { kind: 'error'; message: string }

type ResolvedScope =
  | { ok: true; range: 'file' | 'selection' }
  | { ok: false; message: string }

/**
 * Gateway JSON often over-escapes regex (e.g. pattern parses to `\\d+` instead of `\d+`),
 * which matches a literal backslash + "d" and finds nothing for digits.
 */
function normalizeFindRegexPattern(pattern: string): string {
  let p = pattern
  while (/^\\{2,}(?=[dDwWsSbnrtfvxu])/.test(p)) {
    p = p.replace(/^\\{2,}(?=[dDwWsSbnrtfvxu])/, '\\')
  }
  return p
}

function resolveScope(scope: IntentScope | undefined, sel: DocSelectionNullable): ResolvedScope {
  const s = scope ?? 'auto'
  if (s === 'auto') {
    return { ok: true, range: sel && sel.from !== sel.to ? 'selection' : 'file' }
  }
  if (s === 'file') return { ok: true, range: 'file' }
  if (s === 'selection') {
    if (!sel || sel.from === sel.to) {
      return { ok: false, message: '意图要求选区，但当前没有选中文本。' }
    }
    return { ok: true, range: 'selection' }
  }
  if (s === 'lines') {
    return {
      ok: false,
      message: 'scope "lines" 尚未支持，请使用 auto/file/selection。',
    }
  }
  return { ok: true, range: 'file' }
}

function selForResolved(
  range: 'file' | 'selection',
  sel: DocSelectionNullable
): DocSelectionNullable {
  if (range === 'selection') return sel
  return null
}

export function applyParsedIntent(
  fileText: string,
  selection: DocSelectionNullable,
  version: number,
  raw: unknown
): ApplyIntentResult {
  if (version > SUPPORTED_INTENT_PROTOCOL_VERSION) {
    return {
      kind: 'error',
      message: `不支持的意图协议版本 ${version}（客户端最高 ${SUPPORTED_INTENT_PROTOCOL_VERSION}），请升级应用。`,
    }
  }
  if (version < 1 || !Number.isFinite(version)) {
    return { kind: 'error', message: '缺少或无效的 version 字段。' }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'error', message: 'intent 必须是 JSON 对象。' }
  }

  const intent = raw as EditorIntentV1
  const op = intent.op
  if (typeof op !== 'string') {
    return { kind: 'error', message: '缺少 op 字段。' }
  }

  if (isLocalEditFourOp(op)) {
    const r = applyLocalEditFourIntent(fileText, intent as unknown as Record<string, unknown>)
    if (!r.ok) {
      return { kind: 'error', message: r.message }
    }
    return { kind: 'edit', newText: r.newText, summary: r.summary, title: 'OpenClaw 意图' }
  }

  const resolved = resolveScope(intent.scope, selection)
  if (!resolved.ok) {
    return { kind: 'error', message: resolved.message }
  }
  const effSel = selForResolved(resolved.range, selection)

  switch (op) {
    case 'replace_all': {
      const from = intent.from
      const to = intent.to ?? ''
      if (typeof from !== 'string' || !from) {
        return { kind: 'error', message: 'replace_all 需要非空字符串 from。' }
      }
      const r = applyReplaceAll(fileText, effSel, from, to, 'intent:replace_all')
      if (!r) return { kind: 'error', message: 'replace_all 参数无效。' }
      return { kind: 'edit', newText: r.newText, summary: r.summary, title: 'OpenClaw 意图' }
    }
    case 'replace_regex': {
      const pattern = intent.pattern
      const flags = intent.flags
      const replacement = intent.replacement ?? ''
      if (typeof pattern !== 'string' || !pattern) {
        return { kind: 'error', message: 'replace_regex 需要非空字符串 pattern。' }
      }
      if (flags !== undefined && typeof flags !== 'string') {
        return { kind: 'error', message: 'replace_regex 的 flags 必须是字符串。' }
      }
      if (intent.replacement !== undefined && typeof intent.replacement !== 'string') {
        return { kind: 'error', message: 'replace_regex 的 replacement 必须是字符串。' }
      }
      const r = applyReplaceRegex(
        fileText,
        effSel,
        pattern,
        flags,
        replacement,
        'intent:replace_regex'
      )
      if (!r) return { kind: 'error', message: 'replace_regex 参数无效或正则不合法。' }
      return { kind: 'edit', newText: r.newText, summary: r.summary, title: 'OpenClaw 意图' }
    }
    case 'delete_literal': {
      const needle = intent.needle
      if (typeof needle !== 'string' || !needle) {
        return { kind: 'error', message: 'delete_literal 需要 needle。' }
      }
      const r = applyDeleteLiteral(fileText, effSel, needle, 'intent:delete')
      if (!r) return { kind: 'error', message: 'delete_literal 参数无效。' }
      return { kind: 'edit', newText: r.newText, summary: r.summary, title: 'OpenClaw 意图' }
    }
    case 'sort_lines': {
      const r = applyLineOp(fileText, effSel, 'sort', '排序行')
      return { kind: 'edit', newText: r.newText, summary: r.summary, title: 'OpenClaw 意图' }
    }
    case 'dedupe_lines': {
      const r = applyLineOp(fileText, effSel, 'dedupe', '去重行')
      return { kind: 'edit', newText: r.newText, summary: r.summary, title: 'OpenClaw 意图' }
    }
    case 'case_upper': {
      const r = applyCaseOp(fileText, effSel, 'up', '转大写')
      return { kind: 'edit', newText: r.newText, summary: r.summary, title: 'OpenClaw 意图' }
    }
    case 'case_lower': {
      const r = applyCaseOp(fileText, effSel, 'low', '转小写')
      return { kind: 'edit', newText: r.newText, summary: r.summary, title: 'OpenClaw 意图' }
    }
    case 'case_title': {
      const r = applyCaseOp(fileText, effSel, 'title', '首字母大写')
      return { kind: 'edit', newText: r.newText, summary: r.summary, title: 'OpenClaw 意图' }
    }
    case 'insert_at': {
      const text = intent.text
      if (typeof text !== 'string') {
        return { kind: 'error', message: 'insert_at 需要 text 字段。' }
      }
      let offset: number
      if (typeof intent.offset === 'number' && Number.isFinite(intent.offset)) {
        offset = Math.trunc(intent.offset)
      } else {
        offset = selection?.from ?? 0
      }
      if (offset < 0 || offset > fileText.length) {
        return { kind: 'error', message: 'insert_at 的 offset 超出文档范围。' }
      }
      const newText = mergeRange(fileText, offset, offset, text)
      return {
        kind: 'edit',
        newText,
        summary: `insert_at @${offset}（${text.length} 字符）`,
        title: 'OpenClaw 意图',
      }
    }
    case 'set_document': {
      const text = intent.text
      if (typeof text !== 'string') {
        return { kind: 'error', message: 'set_document 需要 text 字段。' }
      }
      return {
        kind: 'edit',
        newText: text,
        summary: `set_document（${text.length} 字符）`,
        title: 'OpenClaw 意图',
      }
    }
    case 'set_selection': {
      const text = intent.text
      if (typeof text !== 'string') {
        return { kind: 'error', message: 'set_selection 需要 text 字段。' }
      }
      if (!selection || selection.from === selection.to) {
        return { kind: 'error', message: 'set_selection 需要非空选区。' }
      }
      const newText = mergeRange(fileText, selection.from, selection.to, text)
      return {
        kind: 'edit',
        newText,
        summary: `set_selection（${text.length} 字符）`,
        title: 'OpenClaw 意图',
      }
    }
    case 'goto_line': {
      const line = intent.line
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
        return { kind: 'error', message: 'goto_line 需要正整数 line。' }
      }
      return { kind: 'goto', line }
    }
    case 'find_literal': {
      const needle = intent.needle
      if (typeof needle !== 'string' || !needle) {
        return { kind: 'error', message: 'find_literal 需要非空 needle。' }
      }
      const needleTrim = needle.trim()
      const bannedNeedle = /^(TODO|PLACEHOLDER|示例|example|test)$/i
      if (bannedNeedle.test(needleTrim)) {
        return {
          kind: 'error',
          message:
            'find_literal 的 needle 不能是占位词；请让模型输出真实字面，或对开放类实体改用 find_regex（子集枚举）或 clarify。',
        }
      }
      const caseSensitive = intent.caseSensitive !== false
      const restrictTo =
        resolved.range === 'selection' && selection
          ? { from: selection.from, to: selection.to }
          : undefined
      const spec: FindQuerySpec = {
        search: needle,
        regexp: false,
        literal: true,
        caseSensitive,
        restrictTo,
      }
      return { kind: 'find', spec }
    }
    case 'find_regex': {
      const patternRaw = intent.pattern
      if (typeof patternRaw !== 'string' || !patternRaw.trim()) {
        return { kind: 'error', message: 'find_regex 需要非空 pattern。' }
      }
      if (/^(TODO|PLACEHOLDER)$/i.test(patternRaw.trim())) {
        return {
          kind: 'error',
          message:
            'find_regex 的 pattern 不能是占位词；请输出真实正则（如子集枚举）或 clarify。',
        }
      }
      if (intent.flags !== undefined && typeof intent.flags !== 'string') {
        return { kind: 'error', message: 'find_regex 的 flags 必须是字符串。' }
      }
      const pattern = normalizeFindRegexPattern(patternRaw.trim())
      const flags = intent.flags ?? ''
      const ignoreCase = flags.includes('i')
      const restrictTo =
        resolved.range === 'selection' && selection
          ? { from: selection.from, to: selection.to }
          : undefined
      const spec: FindQuerySpec = {
        search: pattern,
        regexp: true,
        literal: false,
        caseSensitive: !ignoreCase,
        restrictTo,
      }
      return { kind: 'find', spec }
    }
    case 'clarify': {
      const msg = typeof intent.message === 'string' ? intent.message : '需要更多信息。'
      return { kind: 'clarify', message: msg }
    }
    case 'noop':
      return { kind: 'noop' }
    default:
      return { kind: 'error', message: `不支持的 op: ${op}` }
  }
}
