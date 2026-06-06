import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { APP_BINARY_NAME, ASSET_PATTERNS, PRODUCT_NAME } from './config.js'
import { downloadFile, fetchRelease, pickAsset } from './github.js'
import {
  ensureDir,
  getCacheDir,
  getDataDir,
  readInstallMeta,
  resolveLaunchPath,
  writeInstallMeta,
} from './paths.js'
import { detectPlatformKey } from './platform.js'

function log(msg) {
  process.stderr.write(`${msg}\n`)
}

function formatProgress(received, total) {
  if (!total) return ''
  const pct = Math.min(100, Math.round((received / total) * 100))
  return ` ${pct}%`
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [opts]
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(undefined)
      else reject(new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}`))
    })
  })
}

/**
 * @param {string} archivePath
 * @param {string} destDir
 */
async function extractTarGz(archivePath, destDir) {
  ensureDir(destDir)
  await run('tar', ['-xzf', archivePath, '-C', destDir])
}

function findAppBundle(rootDir) {
  const direct = path.join(rootDir, `${PRODUCT_NAME}.app`)
  if (fs.existsSync(direct)) return direct

  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith('.app')) {
      return path.join(rootDir, e.name)
    }
  }
  return null
}

/**
 * @param {string} assetPath
 * @param {string} assetName
 * @param {string} version
 */
async function installFromAsset(assetPath, assetName, version) {
  const dataDir = getDataDir()
  ensureDir(dataDir)
  const lower = assetName.toLowerCase()

  if (lower.endsWith('.app.tar.gz')) {
    const extractDir = path.join(dataDir, 'current')
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true })
    }
    ensureDir(extractDir)
    await extractTarGz(assetPath, extractDir)
    const appBundle = findAppBundle(extractDir)
    if (!appBundle) {
      throw new Error(`Could not find ${PRODUCT_NAME}.app after extracting ${assetName}`)
    }
    const launchPath = path.join(appBundle, 'Contents', 'MacOS', APP_BINARY_NAME)
    if (!fs.existsSync(launchPath)) {
      throw new Error(`Missing binary in app bundle: ${launchPath}`)
    }
    writeInstallMeta({ version, assetName, launchPath, installedAt: new Date().toISOString() })
    return launchPath
  }

  if (lower.endsWith('.appimage')) {
    const dest = path.join(dataDir, 'ClawEditor.AppImage')
    fs.copyFileSync(assetPath, dest)
    fs.chmodSync(dest, 0o755)
    writeInstallMeta({ version, assetName, launchPath: dest, installedAt: new Date().toISOString() })
    return dest
  }

  if (lower.endsWith('-setup.exe') || lower.endsWith('.msi')) {
    log(`Running Windows installer: ${assetName}`)
    log('Complete the installer dialog, then run `claw-editor` again.')
    await run(assetPath, [], { shell: true, stdio: 'inherit' })
    const launchPath = path.join(
      process.env.LOCALAPPDATA || '',
      PRODUCT_NAME,
      APP_BINARY_NAME,
    )
    writeInstallMeta({
      version,
      assetName,
      launchPath,
      installedAt: new Date().toISOString(),
      note: 'Windows GUI installer',
    })
    return launchPath
  }

  if (lower.endsWith('.dmg')) {
    throw new Error(
      `Automatic install for .dmg is not supported yet. Download ${assetName} from GitHub Releases and drag ${PRODUCT_NAME} to Applications.`,
    )
  }

  throw new Error(`Unsupported release asset: ${assetName}`)
}

/**
 * @param {{ tag?: string, force?: boolean }} [opts]
 */
export async function install(opts = {}) {
  const platformKey = detectPlatformKey()
  const patterns = ASSET_PATTERNS[platformKey]
  if (!patterns) {
    throw new Error(`No release asset mapping for ${platformKey}`)
  }

  const release = await fetchRelease(opts.tag)
  const asset = pickAsset(release.assets, patterns)
  if (!asset) {
    const names = release.assets.map((a) => a.name).join(', ')
    throw new Error(
      `No matching asset for ${platformKey} in ${release.tag_name}. Available: ${names || '(none)'}`,
    )
  }

  const version = release.tag_name.replace(/^v/, '')
  ensureDir(getCacheDir())
  const cachePath = path.join(getCacheDir(), asset.name)

  if (!opts.force && fs.existsSync(cachePath)) {
    log(`Using cached ${asset.name}`)
  } else {
    log(`Downloading ${asset.name} from ${release.tag_name}…`)
    await downloadFile(asset.browser_download_url, cachePath, (received, total) => {
      process.stderr.write(`\rDownloading${formatProgress(received, total)}`)
    })
    process.stderr.write('\n')
  }

  const launchPath = await installFromAsset(cachePath, asset.name, version)
  log(`Installed ${PRODUCT_NAME} ${version}`)
  return { version, launchPath, assetName: asset.name }
}

/**
 * @param {string} launchPath
 */
export function launchApp(launchPath) {
  if (process.platform === 'darwin') {
    if (launchPath.endsWith('.app') || launchPath.includes('.app/')) {
      const appPath = launchPath.includes('.app/')
        ? launchPath.split('.app/')[0] + '.app'
        : launchPath
      spawn('open', ['-a', appPath], { detached: true, stdio: 'ignore' }).unref()
      return
    }
  }

  if (launchPath.endsWith('.AppImage')) {
    spawn(launchPath, [], { detached: true, stdio: 'ignore' }).unref()
    return
  }

  spawn(launchPath, [], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref()
}

/**
 * Ensure app is installed and launch it.
 * @param {{ tag?: string, force?: boolean }} [opts]
 */
export async function runApp(opts = {}) {
  let launchPath = resolveLaunchPath(opts.force ? null : readInstallMeta())

  if (!launchPath || opts.force) {
    const result = await install({ tag: opts.tag, force: opts.force })
    launchPath = result.launchPath
  }

  if (!launchPath || !fs.existsSync(launchPath)) {
    throw new Error(
      `${PRODUCT_NAME} is not installed. Run: npm install -g @claweditor/cli && claw-editor install`,
    )
  }

  launchApp(launchPath)
  log(`Launched ${PRODUCT_NAME}`)
}
