/**
 * Matches OpenClaw gateway `buildDeviceAuthPayloadV3` + scope normalization
 * (see openclaw `src/gateway/device-auth.ts`, `device-metadata-normalization.ts`).
 */
export function normalizeDeviceMetadataForAuth(value: string | undefined | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return ''
  return trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
}

export function normalizeDeviceAuthScopes(scopes: string[]): string[] {
  const out = new Set<string>()
  for (const s of scopes) {
    const t = s.trim()
    if (t) out.add(t)
  }
  if (out.has('operator.admin')) {
    out.add('operator.read')
    out.add('operator.write')
  } else if (out.has('operator.write')) {
    out.add('operator.read')
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}

export function buildDeviceAuthPayloadV3(params: {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token?: string | null
  nonce: string
  platform?: string | null
  deviceFamily?: string | null
}): string {
  const scopes = normalizeDeviceAuthScopes(params.scopes).join(',')
  const token = params.token ?? ''
  const platform = normalizeDeviceMetadataForAuth(params.platform)
  const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily)
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join('|')
}
