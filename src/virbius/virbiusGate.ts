import { invoke } from '@tauri-apps/api/core'
import { getVirbiusAppId, resolveVirbiusDataDir, VIRBIUS_TENANT_ID } from './config'

export type VirbiusOutboundPart = { key: string; text: string }

export type VirbiusGateOutboundResult = {
  traceId: string
  parts: VirbiusOutboundPart[]
  blocked: boolean
  blockReason?: string
  reviewHit: boolean
}

export type VirbiusGateInboundResult = {
  content: string
  unresolvedTokens: string[]
}

let configured = false

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function ensureConfigured(): Promise<boolean> {
  if (!isTauri()) return false
  if (configured) return true
  await invoke('virbius_configure', {
    args: {
      dataDir: await resolveVirbiusDataDir(),
      tenantId: VIRBIUS_TENANT_ID,
      appId: getVirbiusAppId(),
    },
  })
  configured = true
  return true
}

/** Scan + DLP mask text before sending to OpenClaw (aiedit / skill flows). */
export async function virbiusGateOutbound(params: {
  scene: string
  parts: VirbiusOutboundPart[]
}): Promise<VirbiusGateOutboundResult | null> {
  const nonEmpty = params.parts.filter((p) => p.text.length > 0)
  if (nonEmpty.length === 0) return null
  if (!(await ensureConfigured())) return null

  const result = await invoke<VirbiusGateOutboundResult>('virbius_gate_outbound', {
    args: {
      scene: params.scene,
      parts: nonEmpty,
    },
  })
  return result
}

/** Restore DLP placeholders in model JSON/text after OpenClaw responds. */
export async function virbiusGateInbound(params: {
  traceId: string
  content: string
  scene?: string
}): Promise<VirbiusGateInboundResult | null> {
  if (!params.traceId || !params.content) return null
  if (!(await ensureConfigured())) return null
  return invoke<VirbiusGateInboundResult>('virbius_gate_inbound', {
    args: {
      traceId: params.traceId,
      content: params.content,
      scene: params.scene,
    },
  })
}

export function partText(
  parts: VirbiusOutboundPart[] | undefined,
  key: string,
  fallback: string
): string {
  return parts?.find((p) => p.key === key)?.text ?? fallback
}
