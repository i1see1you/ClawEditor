/** @typedef {import('./config.js').PlatformKey} PlatformKey */

/**
 * @returns {PlatformKey}
 */
export function detectPlatformKey() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  if (process.platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64'
    if (arch === 'x64') return 'darwin-x64'
  }
  if (process.platform === 'linux') {
    if (arch === 'arm64') return 'linux-arm64'
    return 'linux-x64'
  }
  if (process.platform === 'win32') {
    if (arch === 'arm64') return 'win32-arm64'
    return 'win32-x64'
  }
  throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`)
}
