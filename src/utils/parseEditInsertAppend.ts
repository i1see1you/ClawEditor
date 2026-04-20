/**
 * /edit insert|append|replace-file|replace-selection: clipboard, triple '''/""", or simple '...' / "..."
 */

export const MAX_INSERT_CHARS = 5_000_000

export type ParseInsertAppendResult =
  | { kind: 'clipboard' }
  | { kind: 'text'; text: string }
  | { kind: 'incomplete' }
  | { kind: 'error'; message: string }

function countDelimOccurrences(s: string, delim: string): number {
  if (!delim) return 0
  let n = 0
  let i = 0
  while (i <= s.length - delim.length) {
    if (s.slice(i, i + delim.length) === delim) {
      n += 1
      i += delim.length
    } else {
      i += 1
    }
  }
  return n
}

function isIncompleteTripleQuotedEdit(buffer: string): boolean {
  const m = buffer.match(
    /^\/edit\s+(insert|append|replace-file|replace-selection)\b/i
  )
  if (!m) return false
  let rest = buffer.slice(m[0].length).trimStart()
  if (/^--clipboard\b/i.test(rest) || /^-c\b/i.test(rest)) return false
  const delim = rest.startsWith("'''") ? "'''" : rest.startsWith('"""') ? '"""' : null
  if (!delim) return false
  return countDelimOccurrences(buffer, delim) % 2 === 1
}

/** 简单单/双引号未闭合时（奇数个引号），回车应换行而非提交。 */
function isIncompleteSimpleQuotedEdit(buffer: string): boolean {
  const m = buffer.match(
    /^\/edit\s+(insert|append|replace-file|replace-selection)\b/i
  )
  if (!m) return false
  let rest = buffer.slice(m[0].length).trimStart()
  if (/^--clipboard\b/i.test(rest) || /^-c\b/i.test(rest)) return false
  if (rest.startsWith("'''") || rest.startsWith('"""')) return false
  if (rest.startsWith("'") && !rest.startsWith("'''")) {
    return ((buffer.match(/'/g) || []).length % 2) === 1
  }
  if (rest.startsWith('"') && !rest.startsWith('"""')) {
    return ((buffer.match(/"/g) || []).length % 2) === 1
  }
  return false
}

/** 三引号块或简单引号串未闭合时，终端应继续换行输入。 */
export function isIncompleteQuotedEdit(buffer: string): boolean {
  return isIncompleteTripleQuotedEdit(buffer) || isIncompleteSimpleQuotedEdit(buffer)
}

function parseTripleQuoted(t: string): ParseInsertAppendResult {
  const delim = t.startsWith("'''") ? "'''" : t.startsWith('"""') ? '"""' : null
  if (!delim) {
    return { kind: 'error', message: '内部错误：三引号解析。' }
  }
  if (t.length < delim.length * 2) {
    return { kind: 'incomplete' }
  }
  const afterOpen = t.slice(delim.length)
  const closeIdx = afterOpen.indexOf(delim)
  if (closeIdx === -1) {
    return { kind: 'incomplete' }
  }
  const body = afterOpen.slice(0, closeIdx)
  const tail = afterOpen.slice(closeIdx + delim.length).trim()
  if (tail !== '') {
    return { kind: 'error', message: '闭合引号后不能有其它内容。' }
  }
  if (body.length > MAX_INSERT_CHARS) {
    return { kind: 'error', message: `正文过长（>${MAX_INSERT_CHARS} 字符）。` }
  }
  return { kind: 'text', text: body }
}

/** 成对单引号 '...'（非三引号）；正文内勿再含未配对单引号，可改用双引号。 */
function parseSimpleSingleQuoted(t: string): ParseInsertAppendResult | null {
  if (!t.startsWith("'") || t.startsWith("'''")) return null
  const end = t.indexOf("'", 1)
  if (end === -1) return { kind: 'incomplete' }
  const body = t.slice(1, end)
  const tail = t.slice(end + 1).trim()
  if (tail !== '') {
    return { kind: 'error', message: '闭合引号后不能有其它内容。' }
  }
  if (body.length > MAX_INSERT_CHARS) {
    return { kind: 'error', message: `正文过长（>${MAX_INSERT_CHARS} 字符）。` }
  }
  return { kind: 'text', text: body }
}

/** 成对双引号 "..."（非三双引号） */
function parseSimpleDoubleQuoted(t: string): ParseInsertAppendResult | null {
  if (!t.startsWith('"') || t.startsWith('"""')) return null
  const end = t.indexOf('"', 1)
  if (end === -1) return { kind: 'incomplete' }
  const body = t.slice(1, end)
  const tail = t.slice(end + 1).trim()
  if (tail !== '') {
    return { kind: 'error', message: '闭合引号后不能有其它内容。' }
  }
  if (body.length > MAX_INSERT_CHARS) {
    return { kind: 'error', message: `正文过长（>${MAX_INSERT_CHARS} 字符）。` }
  }
  return { kind: 'text', text: body }
}

export function tryParseInsertAppendBody(afterInsertOrAppend: string): ParseInsertAppendResult {
  const t = afterInsertOrAppend.trim()
  if (!t) {
    return {
      kind: 'error',
      message:
        '缺少正文：使用 --clipboard / -c，或 \'…\' / "…"，或三引号块。',
    }
  }
  if (/^--clipboard$/i.test(t) || /^-c$/i.test(t)) {
    return { kind: 'clipboard' }
  }

  if (t.startsWith("'''") || t.startsWith('"""')) {
    return parseTripleQuoted(t)
  }

  const sq = parseSimpleSingleQuoted(t)
  if (sq) return sq

  const dq = parseSimpleDoubleQuoted(t)
  if (dq) return dq

  return {
    kind: 'error',
    message: '请使用 --clipboard（或 -c）、单引号 \'…\'、双引号 "…"，或三引号块。',
  }
}
