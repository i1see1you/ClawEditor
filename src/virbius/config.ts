/**
 * Virbius edge DSL — bundled with ClawEditor for local editing.
 * Manifest path: `{dataDir}/edge/{tenant}/{appId}/edge-manifest.json`
 *
 * Default dataDir (Tauri): `<repo>/data/virbius` (dev) or app bundle `virbius/` (release).
 * Override at runtime: localStorage `virbius.dataDir` / `virbius.appId`
 */
export const VIRBIUS_DATA_DIR_REL = 'data/virbius'

export const VIRBIUS_TENANT_ID = 'default'

export const VIRBIUS_APP_ID = 'ClawEditor'

const LS_DATA_DIR = 'virbius.dataDir'
const LS_APP_ID = 'virbius.appId'

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Resolve Virbius data root (absolute path in Tauri desktop app). */
export async function resolveVirbiusDataDir(): Promise<string> {
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(LS_DATA_DIR)?.trim()
    if (v) return v
  }
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<string>('virbius_default_data_dir')
  }
  return VIRBIUS_DATA_DIR_REL
}

export function getVirbiusAppId(): string {
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(LS_APP_ID)?.trim()
    if (v) return v
  }
  return VIRBIUS_APP_ID
}

/** @deprecated Use resolveVirbiusDataDir() — sync fallback for non-Tauri. */
export function getVirbiusDataDir(): string {
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(LS_DATA_DIR)?.trim()
    if (v) return v
  }
  return VIRBIUS_DATA_DIR_REL
}
