/**
 * Deterministic text transforms (selection-first). Used by local regex commands and OpenClaw intent JSON.
 */

export interface DocSelection {
  from: number
  to: number
  text: string
}

export type DocSelectionNullable = DocSelection | null

export function mergeRange(full: string, start: number, end: number, newMiddle: string): string {
  return full.slice(0, start) + newMiddle + full.slice(end)
}

export function expandToLineBounds(full: string, from: number, to: number): { start: number; end: number } {
  const start = from <= 0 ? 0 : full.lastIndexOf('\n', from - 1) + 1
  let end = to
  const idx = full.indexOf('\n', Math.max(0, to - 1))
  if (idx === -1) {
    end = full.length
  } else {
    end = idx + 1
  }
  return { start, end }
}

function removeEmptyLines(block: string): string {
  return block.split('\n').filter((line) => line !== '').join('\n')
}

function removeBlankLines(block: string): string {
  return block.split('\n').filter((line) => line.trim() !== '').join('\n')
}

function trimTrailingLines(block: string): string {
  return block.split('\n').map((line) => line.replace(/\s+$/, '')).join('\n')
}

function sortLines(block: string): string {
  const lines = block.split('\n')
  const endsWithNl = block.endsWith('\n')
  lines.sort((a, b) => a.localeCompare(b))
  const out = lines.join('\n')
  return endsWithNl && out && !out.endsWith('\n') ? out + '\n' : out
}

function dedupeLines(block: string): string {
  const lines = block.split('\n')
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out.join('\n')
}

function toTitleCase(s: string): string {
  return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

export function applyReplaceAll(
  fileText: string,
  sel: DocSelectionNullable,
  from: string,
  to: string,
  label: string
): { newText: string; summary: string } | null {
  if (!from) return null
  if (sel && sel.from !== sel.to) {
    const piece = sel.text.split(from).join(to)
    const newText = mergeRange(fileText, sel.from, sel.to, piece)
    return { newText, summary: `${label}「${from}」→「${to}」（选区内替换）` }
  }
  const newText = fileText.split(from).join(to)
  return { newText, summary: `${label}「${from}」→「${to}」（全文替换）` }
}

function normalizeRegexFlags(flags: string | undefined): string {
  const merged = `${flags ?? ''}g`
  const out: string[] = []
  for (const ch of merged) {
    if (out.includes(ch)) continue
    out.push(ch)
  }
  return out.join('')
}

/**
 * Some gateways send JSON string values where `\uXXXX` was over-escaped: after
 * JSON.parse the string still contains six literal characters \\ u 0 0 0 a
 * instead of one Unicode code point. Decode those sequences for pattern/replacement.
 */
function decodeLiteralUnicodeEscapes(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/gi, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16))
  )
}

export function applyReplaceRegex(
  fileText: string,
  sel: DocSelectionNullable,
  pattern: string,
  flags: string | undefined,
  replacement: string,
  label: string
): { newText: string; summary: string } | null {
  if (!pattern) return null

  const patternDecoded = decodeLiteralUnicodeEscapes(pattern)
  const replacementDecoded = decodeLiteralUnicodeEscapes(replacement)

  const normalizedFlags = normalizeRegexFlags(flags)
  let re: RegExp
  try {
    re = new RegExp(patternDecoded, normalizedFlags)
  } catch {
    return null
  }

  if (sel && sel.from !== sel.to) {
    const piece = sel.text.replace(re, replacementDecoded)
    const newText = mergeRange(fileText, sel.from, sel.to, piece)
    return {
      newText,
      summary: `${label}/${patternDecoded}/${normalizedFlags} -> ${JSON.stringify(replacementDecoded)}（选区内替换）`,
    }
  }

  const newText = fileText.replace(re, replacementDecoded)
  return {
    newText,
    summary: `${label}/${patternDecoded}/${normalizedFlags} -> ${JSON.stringify(replacementDecoded)}（全文替换）`,
  }
}

export function applyDeleteLiteral(
  fileText: string,
  sel: DocSelectionNullable,
  needle: string,
  label: string
): { newText: string; summary: string } | null {
  if (!needle) return null
  if (sel && sel.from !== sel.to) {
    if (!sel.text.includes(needle)) return null
    const piece = sel.text.split(needle).join('')
    const newText = mergeRange(fileText, sel.from, sel.to, piece)
    return { newText, summary: `${label}「${needle}」（选区内删除）` }
  }
  if (!fileText.includes(needle)) return null
  const newText = fileText.split(needle).join('')
  return { newText, summary: `${label}「${needle}」（全文）` }
}

export function applyDeleteLine1(
  fileText: string,
  sel: DocSelectionNullable,
  line1: number,
  label: string
): { newText: string; summary: string } | null {
  if (!Number.isFinite(line1) || line1 < 1) return null
  if (sel && sel.from !== sel.to) {
    return null
  }
  const lines = fileText.split('\n')
  // split keeps last empty element if text endsWith '\n'; preserve behavior
  const idx0 = line1 - 1
  if (idx0 < 0 || idx0 >= lines.length) return null
  lines.splice(idx0, 1)
  const newText = lines.join('\n')
  if (newText === fileText) return null
  return { newText, summary: `${label}（第 ${line1} 行）` }
}

export type LineOpKind = 'empty' | 'blank' | 'trim' | 'sort' | 'dedupe'

export function applyLineOp(
  fileText: string,
  sel: DocSelectionNullable,
  op: LineOpKind,
  label: string
): { newText: string; summary: string } {
  const runBlock = (block: string) => {
    if (op === 'empty') return removeEmptyLines(block)
    if (op === 'blank') return removeBlankLines(block)
    if (op === 'trim') return trimTrailingLines(block)
    if (op === 'sort') return sortLines(block)
    return dedupeLines(block)
  }

  if (sel && sel.from !== sel.to) {
    const { start, end } = expandToLineBounds(fileText, sel.from, sel.to)
    const block = fileText.slice(start, end)
    const next = runBlock(block)
    const newText = mergeRange(fileText, start, end, next)
    return { newText, summary: `${label}（选区所在行范围）` }
  }

  const next = runBlock(fileText)
  return { newText: next, summary: `${label}（全文）` }
}

export function applyCaseOp(
  fileText: string,
  sel: DocSelectionNullable,
  mode: 'up' | 'low' | 'title',
  label: string
): { newText: string; summary: string } {
  if (sel && sel.from !== sel.to) {
    let piece = sel.text
    if (mode === 'up') piece = piece.toUpperCase()
    else if (mode === 'low') piece = piece.toLowerCase()
    else piece = toTitleCase(piece)
    const newText = mergeRange(fileText, sel.from, sel.to, piece)
    return { newText, summary: `${label}（选区）` }
  }
  let next = fileText
  if (mode === 'up') next = fileText.toUpperCase()
  else if (mode === 'low') next = fileText.toLowerCase()
  else next = toTitleCase(fileText)
  return { newText: next, summary: `${label}（全文）` }
}
