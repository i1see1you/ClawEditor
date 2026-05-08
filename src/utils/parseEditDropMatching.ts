/**
 * Payload for `/edit line drop-matching …` (and aliases).
 * - Slash form `/pat/flags` → regex
 * - `'…'` / `"…"` → literal substring (line removed if it contains the needle)
 * - Otherwise whole remainder → literal substring
 */

export type EditDropMatchingParsed =
  | { mode: 'regex'; pattern: string; flags: string }
  | { mode: 'literal'; needle: string }

/** Parse `/pattern/flags` with escapes; returns null if no closing `/`. */
function parseSlashDelimitedRegex(t: string): { source: string; flags: string } | null {
  const s = t.trim()
  if (!s.startsWith('/')) return null
  let i = 1
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '/') {
      const source = s.slice(1, i)
      const flags = s.slice(i + 1).replace(/[^a-z]/gi, '')
      return { source, flags }
    }
    i += 1
  }
  return null
}

export function parseEditDropMatchingPayload(raw: string): EditDropMatchingParsed | null {
  const t = raw.trim()
  if (!t) return null

  if (t.startsWith('/')) {
    const r = parseSlashDelimitedRegex(t)
    if (!r || !r.source) return null
    return { mode: 'regex', pattern: r.source, flags: r.flags }
  }

  const quoted = /^(['"])([\s\S]*)\1$/.exec(t)
  if (quoted) {
    const needle = quoted[2] ?? ''
    if (!needle) return null
    return { mode: 'literal', needle }
  }

  if (!t) return null
  return { mode: 'literal', needle: t }
}
