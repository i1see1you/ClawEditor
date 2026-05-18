/**
 * OpenClaw Gateway plugin: claw_editor.v1 Channel remote edit bridge.
 * @see openclaw.plugin.json — id must stay `claweditor-gateway`.
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { getRuntimeConfigSnapshot } from 'openclaw/plugin-sdk/runtime-config-snapshot'

const BUSINESS_COMMANDS = ['/edit', '/aiedit', '/aicorrect', '/aiimport']
const CONFIRM_CANCEL_RE = /^\/(confirm|cancel)\s+(\S+)/i

const FALLBACK_CTX_SYMBOL = Symbol.for('openclaw.fallbackGatewayContextState')

let remoteEditHolderConnId = null
let remoteEditHolderRenewedAt = 0
const REMOTE_EDIT_LEASE_MS = 75_000

/** channel_id → { sessionKey, channelPluginId, accountId, deliveryTo, threadId, cachedAt } */
const channelSessionCache = new Map()
const CHANNEL_SESSION_CACHE_TTL_MS = REMOTE_EDIT_LEASE_MS

let pluginChannelRuntime = null

function invalidateRemoteEditLease() {
  if (
    remoteEditHolderConnId &&
    Date.now() - remoteEditHolderRenewedAt > REMOTE_EDIT_LEASE_MS
  ) {
    remoteEditHolderConnId = null
    remoteEditHolderRenewedAt = 0
  }
  const now = Date.now()
  for (const [k, v] of channelSessionCache) {
    if (now - v.cachedAt > CHANNEL_SESSION_CACHE_TTL_MS) channelSessionCache.delete(k)
  }
}

function newRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

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

/** agent:main:feishu:direct:… → feishu */
function parseChannelPluginIdFromSessionKey(sessionKey) {
  if (!sessionKey) return undefined
  const parts = String(sessionKey).split(':')
  if (parts.length >= 3 && parts[0] === 'agent' && parts[1] === 'main') {
    return parts[2]
  }
  return undefined
}

function parseFeishuThreadId(conversationId) {
  const m = String(conversationId).match(/:topic:([^:]+)/i)
  return m?.[1]?.trim() || undefined
}

/** Build outbound sendText `to` from canonical conversationId. */
function buildDeliveryTo(channelPluginId, conversationId) {
  const id = String(conversationId ?? '').trim()
  if (!id) return undefined
  const plugin = String(channelPluginId ?? '').toLowerCase()
  if (plugin === 'feishu' || plugin === 'lark') {
    const topicMatch = id.match(/^(.+):topic:([^:]+)/i)
    if (topicMatch) {
      const chatId = topicMatch[1].trim()
      return chatId.startsWith('oc_') ? `chat:${chatId}` : `chat:${chatId}`
    }
    const senderOnly = id.match(/^(.+):sender:([^:]+)$/i)
    if (senderOnly && !id.includes(':topic:')) {
      const sender = senderOnly[2].trim()
      return sender.startsWith('ou_') || sender.startsWith('on_') ? `user:${sender}` : sender
    }
    if (id.startsWith('oc_')) return `chat:${id}`
    if (id.startsWith('ou_') || id.startsWith('on_')) return `user:${id}`
    return id
  }
  return id
}

function buildV1Context(event, ctx) {
  const channel_id = String(ctx?.conversationId ?? '').trim()
  if (!channel_id) return null
  const sessionKey = String(event?.sessionKey ?? ctx?.sessionKey ?? '').trim()
  const channel_plugin = parseChannelPluginIdFromSessionKey(sessionKey)
  const account_id = String(ctx?.accountId ?? event?.accountId ?? '').trim() || undefined
  const delivery_to = buildDeliveryTo(channel_plugin, channel_id) || channel_id
  const thread_id =
    channel_plugin === 'feishu' || channel_plugin === 'lark'
      ? parseFeishuThreadId(channel_id)
      : undefined
  return {
    channel_id,
    ...(channel_plugin ? { channel_plugin } : {}),
    ...(account_id ? { account_id } : {}),
    delivery_to,
    ...(thread_id ? { thread_id } : {}),
  }
}

function cacheChannelSession(channel_id, event, ctx) {
  const sessionKey = String(event?.sessionKey ?? ctx?.sessionKey ?? '').trim()
  const channelPluginId = parseChannelPluginIdFromSessionKey(sessionKey)
  const accountId = String(ctx?.accountId ?? event?.accountId ?? '').trim() || undefined
  const deliveryTo = buildDeliveryTo(channelPluginId, channel_id) || channel_id
  const threadId =
    channelPluginId === 'feishu' || channelPluginId === 'lark'
      ? parseFeishuThreadId(channel_id)
      : undefined
  channelSessionCache.set(channel_id, {
    sessionKey,
    channelPluginId,
    accountId,
    deliveryTo,
    threadId,
    cachedAt: Date.now(),
  })
}

function emitToRemoteEditHolder(eventName, payload, host, opts) {
  invalidateRemoteEditLease()
  if (!remoteEditHolderConnId) return false
  host.broadcastToConnIds(eventName, payload, new Set([remoteEditHolderConnId]), opts)
  return true
}

function parseTargetFile(line) {
  const m = line.match(/\s--file\s+(\S+)/)
  if (!m) return { line, targetFile: undefined }
  return {
    line: line.replace(m[0], '').replace(/\s+/g, ' ').trim(),
    targetFile: m[1],
  }
}

function formatV1OutboundText(event) {
  const { type, request_id, payload } = event
  if (type === 'claw_editor.v1.diff_response') {
    const summary = payload?.summary ?? ''
    const diff = payload?.diff_text?.trim()
    const file = payload?.file_name ? ` (${payload.file_name})` : ''
    const body = diff
      ? `${summary}${file}\n\n\`\`\`diff\n${diff}\n\`\`\``
      : `${summary}${file}`.trim()
    return (
      `🤖 AI 自动修改建议已生成\n\n${body}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `✍️ 请复制下方指令并在群内回复进行审批：\n\n` +
      `【 采纳修改 】 👉  /confirm ${request_id}\n` +
      `【 忽略建议 】 👉  /cancel ${request_id}`
    )
  }
  if (type === 'claw_editor.v1.commit_response') {
    const isApply = payload?.action === 'apply'
    if (isApply) {
      return (
        `✅ 编辑器报告：磁盘写入成功！\n流水号 \`${request_id}\` 的修改已提交到编辑器缓存。` +
        (payload?.message ? `\n${payload.message}` : '')
      )
    }
    return (
      `🗑️ 编辑器报告：操作已取消。\n流水号 \`${request_id}\` 的临时修改已被取消。` +
      (payload?.message ? `\n${payload.message}` : '')
    )
  }
  return payload?.summary ?? payload?.message ?? ''
}

async function deliverV1ToChannel(gatewayContext, event, logger) {
  const ctx = event?.context
  const text = formatV1OutboundText(event)
  const to = ctx?.delivery_to?.trim() || ctx?.channel_id?.trim()
  if (!text || !to || !ctx?.channel_id) {
    logger?.warn?.('[claweditor-gateway] deliver skipped: missing delivery_to/channel_id or text')
    return false
  }

  const cached = channelSessionCache.get(ctx.channel_id)
  const channelPluginId =
    ctx.channel_plugin ??
    cached?.channelPluginId ??
    parseChannelPluginIdFromSessionKey(cached?.sessionKey)
  if (!channelPluginId) {
    logger?.warn?.('[claweditor-gateway] deliver skipped: unknown channel_plugin')
    return false
  }

  const cfg = getRuntimeConfigSnapshot()
  if (!cfg) {
    logger?.warn?.('[claweditor-gateway] deliver skipped: runtime config unavailable')
    return false
  }

  const loadAdapter = pluginChannelRuntime?.channel?.outbound?.loadAdapter
  if (typeof loadAdapter !== 'function') {
    logger?.warn?.('[claweditor-gateway] deliver skipped: channel outbound runtime unavailable')
    return false
  }

  const accountId = ctx.account_id ?? cached?.accountId ?? null
  const threadId = ctx.thread_id ?? cached?.threadId ?? null

  try {
    const adapter = await loadAdapter(channelPluginId)
    if (!adapter?.sendText) {
      logger?.warn?.(
        `[claweditor-gateway] channel ${channelPluginId} has no outbound sendText adapter`
      )
      return false
    }
    const result = await adapter.sendText({
      cfg,
      to,
      text,
      accountId,
      threadId,
      deps: gatewayContext?.deps ?? undefined,
    })
    if (result?.messageId) {
      logger?.info?.(
        `[claweditor-gateway] delivered via channel outbound channel=${channelPluginId} to=${to}`
      )
      return true
    }
    logger?.warn?.(
      `[claweditor-gateway] channel outbound returned no messageId channel=${channelPluginId}`
    )
  } catch (err) {
    logger?.warn?.(`[claweditor-gateway] channel outbound failed: ${String(err)}`)
  }

  return false
}

export default definePluginEntry({
  id: 'claweditor-gateway',
  name: 'ClawEditor Gateway Bridge',
  description:
    'claw_editor.v1: Channel /edit-style commands to ClawEditor Master; diff and commit responses via channel outbound.',
  register(api) {
    pluginChannelRuntime = api.runtime ?? null
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
          try {
            context.broadcastToConnIds(
              'claweditor.leaseEvicted',
              { reason: 'taken_by_new_session' },
              new Set([remoteEditHolderConnId])
            )
          } catch {
            /* best-effort */
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
      'claweditor-gateway.emitV1Event',
      async ({ context, params, respond }) => {
        const event = params?.event
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
          respond(false, undefined, {
            code: 'INVALID_REQUEST',
            message: 'missing event object',
          })
          return
        }
        const ok = await deliverV1ToChannel(context, event, api.logger)
        respond(true, { ok })
      },
      { scope: 'operator.write' }
    )

    api.on('gateway_stop', () => {
      remoteEditHolderConnId = null
      remoteEditHolderRenewedAt = 0
      channelSessionCache.clear()
    })

    api.on('before_dispatch', async (event, ctx) => {
      if (!shouldHandleForConfig(event, ctx, cfg)) return undefined
      const text = normalizeCommandLine(event)
      if (!text.startsWith('/')) return undefined

      const host = tryResolveGatewayHostFromHost()
      if (!host) return undefined

      const opts = cfg.dropIfSlow ? { dropIfSlow: true } : undefined
      invalidateRemoteEditLease()

      const matchedBiz = BUSINESS_COMMANDS.find((cmd) => text.startsWith(cmd))
      if (matchedBiz) {
        if (!remoteEditHolderConnId) {
          return {
            handled: true,
            text: '❌ 桌面编辑器未在线或未开启「远程编辑」。请打开 ClawEditor 并勾选远程编辑接收。',
          }
        }
        const requestId = newRequestId()
        const context = buildV1Context(event, ctx)
        if (!context) {
          return {
            handled: true,
            text: '❌ 无法识别 Channel 会话（缺少 conversationId）。',
          }
        }
        cacheChannelSession(context.channel_id, event, ctx)
        const { line, targetFile } = parseTargetFile(text)
        const payload = {
          type: 'claw_editor.v1.request',
          request_id: requestId,
          context,
          payload: {
            full_text: line || text,
            args: text.split(/\s+/).slice(1),
            ...(targetFile ? { target_file: targetFile } : {}),
          },
        }
        emitToRemoteEditHolder('claw_editor.v1.request', payload, host, opts)
        api.logger.info?.(
          `[claweditor-gateway] v1.request ${matchedBiz} → ${requestId} (channel=${context.channel_id})`
        )
        return {
          handled: true,
          text: `⏳ 正在后台处理您的 ${matchedBiz} 请求，流水号: ${requestId}...`,
        }
      }

      const cc = text.match(CONFIRM_CANCEL_RE)
      if (cc) {
        const cmd = cc[1].toLowerCase()
        const targetRequestId = cc[2]
        if (!targetRequestId?.startsWith('req_')) {
          return {
            handled: true,
            text: '⚠️ 错误的指令格式。请输入正确的流水号，例如：/confirm req_xxxx',
          }
        }
        if (!remoteEditHolderConnId) {
          return {
            handled: true,
            text: '❌ 无法执行审批，桌面编辑器已断开连接或未开启远程编辑。',
          }
        }
        const context = buildV1Context(event, ctx)
        if (!context) {
          return {
            handled: true,
            text: '❌ 无法识别 Channel 会话（缺少 conversationId）。',
          }
        }
        cacheChannelSession(context.channel_id, event, ctx)
        const actionType = cmd === 'confirm' ? 'apply' : 'ignore'
        const payload = {
          type: 'claw_editor.v1.commit',
          request_id: targetRequestId,
          context,
          payload: { action: actionType },
        }
        emitToRemoteEditHolder('claw_editor.v1.commit', payload, host, opts)
        api.logger.info?.(
          `[claweditor-gateway] v1.commit ${actionType} → ${targetRequestId}`
        )
        return {
          handled: true,
          text: `🔄 正在向编辑器提交 [${actionType === 'apply' ? '采纳' : '忽略'}] 决策...`,
        }
      }

      return undefined
    })
  },
})
