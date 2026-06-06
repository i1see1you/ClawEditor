import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_BINARY_NAME, PRODUCT_NAME } from './config.js'

export function getDataDir() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'claweditor')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'claweditor')
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'claweditor')
}

export function getInstallMetaPath() {
  return path.join(getDataDir(), 'install.json')
}

export function getCacheDir() {
  return path.join(getDataDir(), 'cache')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Resolve the executable path from an install record or common install locations.
 * @param {{ version?: string, launchPath?: string, assetName?: string } | null} meta
 */
export function resolveLaunchPath(meta) {
  if (meta?.launchPath && fs.existsSync(meta.launchPath)) {
    return meta.launchPath
  }

  if (process.platform === 'darwin') {
    const appBundle = path.join(getDataDir(), `${PRODUCT_NAME}.app`, 'Contents', 'MacOS', APP_BINARY_NAME)
    if (fs.existsSync(appBundle)) return appBundle
  }

  if (process.platform === 'linux') {
    const appImage = path.join(getDataDir(), 'ClawEditor.AppImage')
    if (fs.existsSync(appImage)) return appImage
    const bin = path.join(getDataDir(), 'bin', APP_BINARY_NAME)
    if (fs.existsSync(bin)) return bin
  }

  if (process.platform === 'win32') {
    const candidates = [
      path.join(getDataDir(), APP_BINARY_NAME),
      path.join(getDataDir(), `${PRODUCT_NAME}.exe`),
      path.join(process.env.LOCALAPPDATA || '', PRODUCT_NAME, `${PRODUCT_NAME}.exe`),
      path.join(process.env.LOCALAPPDATA || '', PRODUCT_NAME, APP_BINARY_NAME),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', PRODUCT_NAME, `${PRODUCT_NAME}.exe`),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', PRODUCT_NAME, APP_BINARY_NAME),
    ]
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c
    }
  }

  return null
}

export function readInstallMeta() {
  const metaPath = getInstallMetaPath()
  if (!fs.existsSync(metaPath)) return null
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {
    return null
  }
}

/** @param {Record<string, unknown>} meta */
export function writeInstallMeta(meta) {
  ensureDir(getDataDir())
  fs.writeFileSync(getInstallMetaPath(), JSON.stringify(meta, null, 2) + '\n')
}
