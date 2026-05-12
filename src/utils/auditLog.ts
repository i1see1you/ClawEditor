import { open } from '@tauri-apps/plugin-fs'
import { BaseDirectory } from '@tauri-apps/api/path'

/** NDJSON audit: two-phase records tied by `correlationId`. */
export type AuditLogEvent = 'accepted' | 'finished'

export type AuditCommandSource = 'channel' | 'local'

/** Terminal outcome on the `finished` row only. */
export type AuditFinishedOutcome = 'completed' | 'failed' | 'rejected'

export interface AuditLogAccepted {
  event: 'accepted'
  correlationId: string
  /** Internal proposal requestId (local: 'local-xxx', remote: deliveryId). */
  requestId?: string
  source: AuditCommandSource
  command: string
  channel?: string
  sessionKey?: string
  deliveryId?: string
  file?: string
  fileId?: string
}

export interface AuditLogFinished {
  event: 'finished'
  correlationId: string
  /** Internal proposal requestId (local: 'local-xxx', remote: deliveryId). */
  requestId?: string
  source: AuditCommandSource
  command: string
  channel?: string
  sessionKey?: string
  deliveryId?: string
  file?: string
  fileId?: string
  outcome: AuditFinishedOutcome
  reason?: string
  durationMs?: number
}

export type AuditLogRecord = AuditLogAccepted | AuditLogFinished

const LOG_FILE = 'audit.log'

export function newAuditCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

export async function appendAuditLog(entry: AuditLogRecord): Promise<void> {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
    const encoded = new TextEncoder().encode(line)
    const file = await open(LOG_FILE, {
      write: true,
      create: true,
      append: true,
      baseDir: BaseDirectory.AppData,
    })
    try {
      await file.write(encoded)
    } finally {
      await file.close()
    }
  } catch {
    // Audit log failures must never break the main flow
  }
}
