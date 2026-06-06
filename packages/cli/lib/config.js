/** @typedef {'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win32-x64' | 'win32-arm64'} PlatformKey */

export const GITHUB_OWNER = 'i1see1you'
export const GITHUB_REPO = 'ClawEditor'
export const PRODUCT_NAME = 'ClawEditor'
export const APP_BINARY_NAME = process.platform === 'win32' ? 'claw-editor.exe' : 'claw-editor'

/**
 * GitHub Release asset name patterns (Tauri bundle naming).
 * First matching asset wins.
 * @type {Record<PlatformKey, RegExp[]>}
 */
export const ASSET_PATTERNS = {
  'darwin-arm64': [/aarch64\.app\.tar\.gz$/i, /aarch64\.dmg$/i],
  'darwin-x64': [/x64\.app\.tar\.gz$/i, /x64\.dmg$/i],
  'linux-x64': [/amd64\.AppImage$/i, /amd64\.deb$/i],
  'linux-arm64': [/aarch64\.AppImage$/i, /arm64\.deb$/i],
  'win32-x64': [/x64-setup\.exe$/i, /x64\.msi$/i],
  'win32-arm64': [/arm64-setup\.exe$/i, /arm64\.msi$/i],
}
