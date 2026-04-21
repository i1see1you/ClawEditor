/**
 * The four JSON edit ops for `/aiedit` and `/aiimport` skill flows (deterministic apply).
 */
import { mergeRange } from './documentOps'

export type LocalEditFourOp = 'replace_file' | 'replace_selection' | 'append' | 'insert'

export function isLocalEditFourOp(op: string): op is LocalEditFourOp {
  return (
    op === 'replace_file' ||
    op === 'replace_selection' ||
    op === 'append' ||
    op === 'insert'
  )
}

export function applyLocalEditFourIntent(
  fileText: string,
  intent: Record<string, unknown>
): { ok: true; newText: string; summary: string } | { ok: false; message: string } {
  const op = intent.op
  if (typeof op !== 'string' || !isLocalEditFourOp(op)) {
    return { ok: false, message: '无效的本地编辑 op。' }
  }

  switch (op) {
    case 'replace_file': {
      const text = intent.text
      if (typeof text !== 'string') {
        return { ok: false, message: 'replace_file 需要字符串 text。' }
      }
      return {
        ok: true,
        newText: text,
        summary: `replace_file（${text.length} 字符）`,
      }
    }
    case 'replace_selection': {
      const sf = intent.selFrom
      const st = intent.selTo
      const text = intent.text
      if (
        typeof sf !== 'number' ||
        typeof st !== 'number' ||
        !Number.isFinite(sf) ||
        !Number.isFinite(st) ||
        !Number.isInteger(sf) ||
        !Number.isInteger(st)
      ) {
        return { ok: false, message: 'replace_selection 需要整数 selFrom、selTo。' }
      }
      if (typeof text !== 'string') {
        return { ok: false, message: 'replace_selection 需要字符串 text。' }
      }
      if (sf < 0 || st < sf || st > fileText.length) {
        return { ok: false, message: 'replace_selection 的区间超出文档范围。' }
      }
      const newText = mergeRange(fileText, sf, st, text)
      return {
        ok: true,
        newText,
        summary: `replace_selection [${sf}, ${st})（${text.length} 字符）`,
      }
    }
    case 'append': {
      const text = intent.text
      if (typeof text !== 'string') {
        return { ok: false, message: 'append 需要字符串 text。' }
      }
      return {
        ok: true,
        newText: fileText + text,
        summary: `append（${text.length} 字符）`,
      }
    }
    case 'insert': {
      const text = intent.text
      const atRaw = intent.at ?? intent.offset
      if (typeof text !== 'string') {
        return { ok: false, message: 'insert 需要字符串 text。' }
      }
      if (typeof atRaw !== 'number' || !Number.isFinite(atRaw) || !Number.isInteger(atRaw)) {
        return { ok: false, message: 'insert 需要整数 at（或 offset）。' }
      }
      const at = Math.trunc(atRaw)
      if (at < 0 || at > fileText.length) {
        return { ok: false, message: 'insert 的 at 超出文档范围。' }
      }
      const newText = mergeRange(fileText, at, at, text)
      return {
        ok: true,
        newText,
        summary: `insert @${at}（${text.length} 字符）`,
      }
    }
    default:
      return { ok: false, message: `不支持的 op: ${op}` }
  }
}
