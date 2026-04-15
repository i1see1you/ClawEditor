/** Trim, strip BOM, unwrap one layer of surrounding quotes (common paste mistakes). */
export function normalizeGatewayCredential(raw: string): string {
  let s = raw.replace(/^\uFEFF/, '').trim()
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim()
  }
  return s
}
