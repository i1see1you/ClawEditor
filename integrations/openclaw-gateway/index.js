/**
 * OpenClaw 2026.4.9+ native plugin: ClawEditor channel bridge.
 * @see openclaw.plugin.json — id must stay `claweditor-gateway`.
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

/** Keep in sync with ClawEditor `src/openclaw/remoteEditorCommand.ts` */
const EDITOR_COMMAND_RE = /^\/(edit|aiedit|aicorrect|aiimport|confirm|cancel)\b/i

const FALLBACK_CTX_SYMBOL = Symbol.for('openclaw.fallbackGatewayContextState')

/** Single holder: WebSocket connId + lease (renewed by ClawEditor while enabled). */
let remoteEditHolderConnId = null
let remoteEditHolderRenewedAt = 0

/** No renew within this window ⇒ holder cleared (crash / half-open TCP). */
const REMOTE_EDIT_LEASE_MS = 75_000

const REMOTE_EDIT_TAKEN_MSG =
  '远程编辑已被其他会话开启。同一 OpenClaw 不能同时开启多个远程编辑。'

function invalidateRemoteEditLease() {
  if (
    remoteEditHolderConnId &&
    Date.now() - remoteEditHolderRenewedAt > REMOTE_EDIT_LEASE_MS
  ) {
    remoteEditHolderConnId = null
    remoteEditHolderRenewedAt = 0
  }
}

function newDeliveryId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Resolve gateway `broadcast` / `broadcastToConnIds` from the process-global fallback resolver
 * OpenClaw sets at gateway startup. Used when `registerGatewayMethod` context is unavailable (e.g. before_dispatch).
 */
function tryResolveGatewayHostFromHost() {
  try {
    const state = globalThis[FALLBACK_CTX_SYMBOL]
    const ctx = typeof state?.resolveContext === 'function' ? state.resolveContext() : null
    const b = ctx?.broadcast
    const t = ctx?.broadcastToConnIds
    if (typeof b !== 'function' || typeof t !== 'function') return null
    return {
      broadcast: b.bind(ctx),
      broadcastToConnIds: t.bind(ctx),
    }
  } catch {
    return null
  }
}

function normalizeCommandLine(event) {
  const raw = event?.content ?? event?.body ?? ''
  return typeof raw === 'string' ? raw.trim() : ''
}

function shouldHandleForConfig(event, ctx, cfg) {
  const only = cfg.onlyChannelIds
  if (Array.isArray(only) && only.length > 0) {
    const ch = String(event?.channel ?? ctx?.channelId ?? '').trim()
    if (!ch || !only.includes(ch)) return false
  }
  const sk = String(event?.sessionKey ?? ctx?.sessionKey ?? '')
  const subs = cfg.skipSessionKeySubstrings
  if (Array.isArray(subs) && subs.length > 0 && sk) {
    const lower = sk.toLowerCase()
    for (const s of subs) {
      if (typeof s === 'string' && s && lower.includes(s.toLowerCase())) return false
    }
  }
  return true
}

function buildPayload(line, event, ctx) {
  // Extract optional --file <name> parameter and strip it from the command line.
  let targetFile
  const fileArgMatch = line.match(/\s--file\s+(\S+)/)
  if (fileArgMatch) {
    targetFile = fileArgMatch[1]
    line = line.replace(fileArgMatch[0], '').replace(/\s+/, ' ').trim()
  }
  return {
    schema: 'claweditor.command',
    version: 1,
    deliveryId: newDeliveryId(),
    line,
    ...(targetFile ? { targetFile } : {}),
    source: {
      channel: String(event?.channel ?? ctx?.channelId ?? 'unknown'),
      sessionKey: event?.sessionKey ?? ctx?.sessionKey,
      userId: event?.senderId ?? ctx?.senderId,
    },
  }
}

function emitToRemoteEditHolder(payload, host, opts) {
  invalidateRemoteEditLease()
  if (!remoteEditHolderConnId) return false
  host.broadcastToConnIds('claweditor.command', payload, new Set([remoteEditHolderConnId]), opts)
  return true
}

export default definePluginEntry({
  id: 'claweditor-gateway',
  name: 'ClawEditor Gateway Bridge',
  description:
    'Delivers claweditor.command for /edit /aiedit /aicorrect /aiimport to the single ClawEditor that claimed remote edit; short-circuits model dispatch via before_dispatch.',
  register(api) {
    const cfg = {
      onlyChannelIds: Array.isArray(api.pluginConfig?.onlyChannelIds)
        ? api.pluginConfig.onlyChannelIds.map((x) => String(x).trim()).filter(Boolean)
        : [],
      skipSessionKeySubstrings: Array.isArray(api.pluginConfig?.skipSessionKeySubstrings)
        ? api.pluginConfig.skipSessionKeySubstrings.map((x) => String(x)).filter(Boolean)
        : [],
      dropIfSlow: api.pluginConfig?.dropIfSlow !== false,
    }

    api.registerGatewayMethod(
      'claweditor-gateway.claimRemoteEdit',
      ({ client, context, respond }) => {
        invalidateRemoteEditLease()
        const connId = typeof client?.connId === 'string' ? client.connId : ''
        if (!connId) {
          respond(false, undefined, { code: 'INVALID_REQUEST', message: 'missing connection id' })
          return
        }
        if (remoteEditHolderConnId === connId) {
          remoteEditHolderRenewedAt = Date.now()
          respond(true, { ok: true, alreadyHolder: true })
          return
        }
        if (remoteEditHolderConnId && remoteEditHolderConnId !== connId) {
          // Notify the previous holder that their lease has been taken over.
          try {
            context.broadcastToConnIds(
              'claweditor.leaseEvicted',
              { reason: 'taken_by_new_session' },
              new Set([remoteEditHolderConnId])
            )
          } catch {
            // Best-effort; proceed with takeover regardless.
          }
        }
        remoteEditHolderConnId = connId
        remoteEditHolderRenewedAt = Date.now()
        respond(true, { ok: true })
      },
      { scope: 'operator.write' }
    )

    api.registerGatewayMethod(
      'claweditor-gateway.releaseRemoteEdit',
      ({ client, respond }) => {
        invalidateRemoteEditLease()
        const connId = typeof client?.connId === 'string' ? client.connId : ''
        if (remoteEditHolderConnId && connId && remoteEditHolderConnId === connId) {
          remoteEditHolderConnId = null
          remoteEditHolderRenewedAt = 0
        }
        respond(true, { ok: true })
      },
      { scope: 'operator.write' }
    )

    api.registerGatewayMethod(
      'claweditor-gateway.renewRemoteEdit',
      ({ client, respond }) => {
        invalidateRemoteEditLease()
        const connId = typeof client?.connId === 'string' ? client.connId : ''
        if (!connId) {
          respond(true, { ok: false })
          return
        }
        if (remoteEditHolderConnId === connId) {
          remoteEditHolderRenewedAt = Date.now()
          respond(true, { ok: true })
          return
        }
        respond(true, { ok: false })
      },
      { scope: 'operator.write' }
    )

    api.registerGatewayMethod(
      'claweditor-gateway.remoteEditStatus',
      ({ client, respond }) => {
        invalidateRemoteEditLease()
        const connId = typeof client?.connId === 'string' ? client.connId : ''
        const active = Boolean(remoteEditHolderConnId)
        const youAreHolder = Boolean(connId && remoteEditHolderConnId === connId)
        respond(true, { active, youAreHolder })
      },
      { scope: 'operator.write' }
    )

    api.registerGatewayMethod(
      'claweditor-gateway.emitCommand',
      ({ context, params, respond }) => {
        const line = typeof params?.line === 'string' ? params.line.trim() : ''
        if (!line || !EDITOR_COMMAND_RE.test(line)) {
          respond(false, { error: 'invalid or non-whitelisted line' })
          return
        }
        const deliveryId = typeof params?.deliveryId === 'string' ? params.deliveryId : newDeliveryId()
        const payload = {
          schema: 'claweditor.command',
          version: 1,
          deliveryId,
          line,
          source:
            params?.source && typeof params.source === 'object' && !Array.isArray(params.source)
              ? params.source
              : {},
        }
        const opts = cfg.dropIfSlow ? { dropIfSlow: true } : undefined
        const host = {
          broadcast: context.broadcast.bind(context),
          broadcastToConnIds: context.broadcastToConnIds.bind(context),
        }
        if (!emitToRemoteEditHolder(payload, host, opts)) {
          respond(false, undefined, {
            code: 'NO_REMOTE_EDIT_HOLDER',
            message:
              '当前没有 ClawEditor 开启远程编辑接收；请在编辑器中勾选「开启远程编辑」后再试。',
          })
          return
        }
        respond(true, { ok: true, deliveryId: payload.deliveryId })
      },
      { scope: 'operator.write' }
    )

    api.on('gateway_stop', () => {
      remoteEditHolderConnId = null
      remoteEditHolderRenewedAt = 0
    })

    api.on('before_dispatch', async (event, ctx) => {
      if (!shouldHandleForConfig(event, ctx, cfg)) return undefined
      const text = normalizeCommandLine(event)
      if (!text.startsWith('/') || !EDITOR_COMMAND_RE.test(text)) return undefined

      const host = tryResolveGatewayHostFromHost()
      if (!host) {
        api.logger.warn?.(
          '[claweditor-gateway] gateway broadcast unavailable; allowing default dispatch.'
        )
        return undefined
      }
      try {
        const opts = cfg.dropIfSlow ? { dropIfSlow: true } : undefined
        if (!emitToRemoteEditHolder(buildPayload(text, event, ctx), host, opts)) {
          api.logger.warn?.(
            '[claweditor-gateway] no remote edit holder; skipping claweditor.command (dispatch still short-circuited).'
          )
        }
      } catch (err) {
        api.logger.warn?.(`[claweditor-gateway] targeted broadcast failed: ${String(err)}`)
        return undefined
      }
      return { handled: true }
    })
  },
})
