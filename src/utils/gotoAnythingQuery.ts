/**
 * Parse Goto Anything query: optional trailing `:line` (1-based), rest is fuzzy file query.
 * Last `:digits` wins so paths like `C:\foo` are not used on POSIX-only apps; Tauri paths are usually `/`.
 */
export function parseGotoAnythingQuery(raw: string): { fileQuery: string; line: number | undefined } {
  const t = raw.trimEnd()
  const m = t.match(/:(\d+)\s*$/)
  if (!m || m.index === undefined) return { fileQuery: raw.trim(), line: undefined }
  const line = Number.parseInt(m[1], 10)
  if (!Number.isFinite(line) || line < 1) return { fileQuery: raw.trim(), line: undefined }
  const fileQuery = t.slice(0, m.index).trimEnd()
  return { fileQuery, line }
}
