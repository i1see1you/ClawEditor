import type { FindQuerySpec } from './applyFindInEditor'

export type LocalFindParseResult =
  | { kind: 'noop' }
  | { kind: 'help'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'find'; spec: FindQuerySpec }
  | { kind: 'fallback_gateway'; rest: string }

function splitArgsWithQuotes(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (q) {
      if (c === '\\' && i + 1 < s.length) {
        cur += s[++i]!
        continue
      }
      if (c === q) {
        q = null
        continue
      }
      cur += c
    } else {
      if (c === ' ' || c === '\t') {
        if (cur) {
          out.push(cur)
          cur = ''
        }
        continue
      }
      if (c === '"' || c === "'") {
        q = c
        continue
      }
      cur += c
    }
  }
  if (cur) out.push(cur)
  return out
}

/** Strip leading `-i` / `-r` flags from raw `/find` args (same tokens as parse loop). */
function stripLeadingFindFlagsFromRest(restRaw: string): string {
  let s = restRaw.trim()
  const flagHead = /^(-i|--ignore-case|-r|--regex)(\s+|$)/i
  for (;;) {
    const m = s.match(flagHead)
    if (!m) break
    s = s.slice(m[0].length).trim()
  }
  return s
}

/** True when the payload (after flags) is wrapped in a matching pair of quotes — forces local literal. */
function isBodyFullyQuotedAfterFlags(restRaw: string): boolean {
  const b = stripLeadingFindFlagsFromRest(restRaw).trim()
  if (b.length < 2) return false
  const a = b[0]!
  const z = b[b.length - 1]!
  return (a === '"' && z === '"') || (a === "'" && z === "'")
}

/** Unicode code-point count (spread); good for CJK length without requiring `Intl.Segmenter` typings. */
function graphemeCount(s: string): number {
  if (!s) return 0
  return [...s].length
}

function wordCount(s: string): number {
  const t = s.trim()
  if (!t) return 0
  return t.split(/\s+/).filter(Boolean).length
}

/** Long single-line identifiers (e.g. very_long_symbol); keep local literal, not NL gateway. */
function looksLikeAsciiIdentifier(body: string): boolean {
  const t = body.trim()
  return t.length > 0 && /^[A-Za-z0-9_.-]+$/.test(t)
}

/** Unquoted body with >6 words OR >6 graphemes → OpenClaw (when not structured). */
const LONG_FIND_GATEWAY_THRESHOLD = 6

function shouldFallbackLongUnquotedBody(body: string): boolean {
  const t = body.trim()
  if (!t) return false
  if (looksLikeAsciiIdentifier(t)) return false
  return (
    wordCount(t) > LONG_FIND_GATEWAY_THRESHOLD ||
    graphemeCount(t) > LONG_FIND_GATEWAY_THRESHOLD
  )
}

/** `/pattern/flags` — pattern may contain `\/`; flags follow the closing slash. */
export function tryParseSlashRegex(s: string): { pattern: string; flags: string } | null {
  const t = s.trim()
  if (!t.startsWith('/')) return null
  let i = 1
  while (i < t.length) {
    const c = t[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '/') {
      const pattern = t.slice(1, i)
      const flags = t.slice(i + 1).replace(/\s[\s\S]*$/, '')
      return { pattern, flags }
    }
    i++
  }
  return null
}

export function parseLocalFind(
  rawLine: string,
  selectionForScope: { from: number; to: number } | null
): LocalFindParseResult {
  const line = rawLine.trim()
  const m = line.match(/^\/find(?:\s+([\s\S]*))?$/i)
  if (!m) return { kind: 'noop' }

  const restRaw = (m[1] ?? '').trim()
  const helpText = [
    '查找命令（设置编辑器搜索查询并打开搜索面板，不修改文档）：',
    '',
    '/find help',
    '/find <字面>              （默认区分大小写）',
    '/find -i <字面>           （忽略大小写；同 --ignore-case）',
    '/find -r <正则>           （JavaScript 正则；同 --regex）',
    '/find -i -r <正则>',
    '/find /<pattern>/<flags>  （例：/foo/i、/\\\\d+/g）',
    '',
    '长文本（无引号且超过 6 个词或 6 个字）默认走 OpenClaw 解析；整段字面请加引号：/find "……"。',
    '多个词且无结构化选项时也会走 OpenClaw；纯 ASCII 标识符（字母数字下划线连字符）即使较长仍本地字面查找。',
  ].join('\n')

  if (!restRaw || /^help$/i.test(restRaw) || /^h$/i.test(restRaw) || /^帮助$/.test(restRaw)) {
    return { kind: 'help', text: helpText }
  }

  const fail = (message: string): LocalFindParseResult => ({
    kind: 'error',
    message: `${message}\n\n${helpText}`,
  })

  const tokens = splitArgsWithQuotes(restRaw)
  if (tokens.length === 0) return fail('缺少查找内容。')

  let ignoreCase = false
  let useRegex = false
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '-i' || t === '--ignore-case') {
      ignoreCase = true
      i++
      continue
    }
    if (t === '-r' || t === '--regex') {
      useRegex = true
      i++
      continue
    }
    if (t.startsWith('-')) {
      return fail(`未知选项：${t}`)
    }
    break
  }

  const tailTokens = tokens.slice(i)
  if (tailTokens.length === 0) return fail('缺少查找内容（仅有选项）。')

  const hadStructuredHint =
    ignoreCase ||
    useRegex ||
    (tailTokens.length === 1 && tailTokens[0]!.startsWith('/'))

  if (tailTokens.length > 1 && !hadStructuredHint) {
    return { kind: 'fallback_gateway', rest: restRaw }
  }

  const body = tailTokens.join(' ')
  if (
    !hadStructuredHint &&
    !isBodyFullyQuotedAfterFlags(restRaw) &&
    shouldFallbackLongUnquotedBody(body)
  ) {
    return { kind: 'fallback_gateway', rest: restRaw }
  }

  let search = body
  let regexpMode = useRegex

  const slash = tryParseSlashRegex(body)
  if (slash) {
    regexpMode = true
    search = slash.pattern
    if (slash.flags.includes('i')) ignoreCase = true
  }

  const restrictTo =
    selectionForScope &&
    selectionForScope.from !== selectionForScope.to &&
    selectionForScope.from >= 0 &&
    selectionForScope.to >= selectionForScope.from
      ? { from: selectionForScope.from, to: selectionForScope.to }
      : undefined

  const spec: FindQuerySpec = regexpMode
    ? {
        search,
        regexp: true,
        literal: false,
        caseSensitive: !ignoreCase,
        restrictTo,
      }
    : {
        search,
        regexp: false,
        literal: true,
        caseSensitive: !ignoreCase,
        restrictTo,
      }

  return { kind: 'find', spec }
}
