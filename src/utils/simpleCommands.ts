/**
 * Local regex-based commands (offline). Selection-first — delegates to documentOps.
 */

import {
  applyReplaceAll,
  applyDeleteLiteral,
  applyDeleteLine1,
  applyLineOp,
  applyCaseOp,
  type DocSelectionNullable,
} from './documentOps'

export type LocalCommandSelection = NonNullable<DocSelectionNullable>

function parseCnNumber(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  if (/^\d+$/.test(t)) return Number(t)
  const digit: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (t === '十') return 10
  // 1-99: 十三 / 二十 / 二十三
  const m = t.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/)
  if (m) {
    const tens = m[1] ? digit[m[1]] : 1
    const ones = m[2] ? digit[m[2]] : 0
    return tens * 10 + ones
  }
  if (t.length === 1 && t in digit) return digit[t]
  return null
}

function tryReplace(
  fileText: string,
  instruction: string,
  sel: DocSelectionNullable
): { newText: string; summary: string } | null {
  let m = instruction.match(/^将(.+?)替换为(.*)$/s)
  if (m) {
    const r = applyReplaceAll(fileText, sel, m[1], m[2], '将')
    if (r) return r
  }
  m = instruction.match(/^把(.+?)替换成(.*)$/s)
  if (m) {
    const r = applyReplaceAll(fileText, sel, m[1], m[2], '把')
    if (r) return r
  }
  m = instruction.match(/^replace\s+(.+?)\s+with\s+(.+)$/is)
  if (m) {
    return applyReplaceAll(fileText, sel, m[1].trim(), m[2].trim(), 'replace')
  }
  return null
}

function tryDeleteSubstring(
  fileText: string,
  instruction: string,
  sel: DocSelectionNullable
): { newText: string; summary: string } | null {
  // Delete Nth line (1-indexed)
  let m = instruction.match(/^删除第\s*([0-9一二两三四五六七八九十]+)\s*行$/s)
  if (m) {
    const n = parseCnNumber(m[1])
    if (n !== null) return applyDeleteLine1(fileText, sel, n, '删除行')
    return null
  }
  m = instruction.match(/^delete\s+line\s+(\d+)$/is)
  if (m) {
    return applyDeleteLine1(fileText, sel, Number(m[1]), 'delete line')
  }

  m = instruction.match(/^删除\s*(.+)$/s)
  if (m) {
    return applyDeleteLiteral(fileText, sel, m[1].trim(), '删除')
  }
  m = instruction.match(/^delete\s+(.+)$/is)
  if (m) {
    return applyDeleteLiteral(fileText, sel, m[1].trim(), 'delete')
  }
  m = instruction.match(/^remove\s+(.+)$/is)
  if (m) {
    return applyDeleteLiteral(fileText, sel, m[1].trim(), 'remove')
  }
  return null
}

function tryLineOps(
  fileText: string,
  instruction: string,
  sel: DocSelectionNullable
): { newText: string; summary: string } | null {
  const t = instruction.trim()
  if (/^删除空行$/s.test(t) || /^remove\s+empty\s+lines$/i.test(t)) {
    return applyLineOp(fileText, sel, 'empty', '删除空行')
  }
  if (/^删除空白行$/s.test(t) || /^remove\s+blank\s+lines$/i.test(t)) {
    return applyLineOp(fileText, sel, 'blank', '删除空白行')
  }
  if (/^去除行尾空格$/s.test(t) || /^trim\s*行尾$/s.test(t) || /^trim\s*(trailing|lines)$/i.test(t)) {
    return applyLineOp(fileText, sel, 'trim', '去除行尾空格')
  }
  if (/^排序行$/s.test(t) || /^sort\s+lines$/i.test(t)) {
    return applyLineOp(fileText, sel, 'sort', '排序行')
  }
  if (/^去重行$/s.test(t) || /^dedupe\s+lines$/i.test(t) || /^unique\s+lines$/i.test(t)) {
    return applyLineOp(fileText, sel, 'dedupe', '去重行')
  }
  return null
}

function tryCase(
  fileText: string,
  instruction: string,
  sel: DocSelectionNullable
): { newText: string; summary: string } | null {
  const t = instruction.trim()
  if (/^转大写$/s.test(t) || /^uppercase$/i.test(t) || /^to\s+uppercase$/i.test(t)) {
    return applyCaseOp(fileText, sel, 'up', '转大写')
  }
  if (/^转小写$/s.test(t) || /^lowercase$/i.test(t) || /^to\s+lowercase$/i.test(t)) {
    return applyCaseOp(fileText, sel, 'low', '转小写')
  }
  if (/^首字母大写$/s.test(t) || /^title\s*case$/i.test(t)) {
    return applyCaseOp(fileText, sel, 'title', '首字母大写')
  }
  return null
}

export function parseSimpleEditInstruction(
  fileText: string,
  instruction: string,
  selection: LocalCommandSelection | null
): { newText: string; summary: string } | null {
  const t = instruction.trim()
  if (!t) return null

  const sel: DocSelectionNullable =
    selection && selection.from !== selection.to ? selection : null

  return (
    tryReplace(fileText, t, sel) ??
    tryLineOps(fileText, t, sel) ??
    tryCase(fileText, t, sel) ??
    tryDeleteSubstring(fileText, t, sel) ??
    null
  )
}
