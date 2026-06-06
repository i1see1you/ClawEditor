#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { install, runApp } from '../lib/install.js'
import { readInstallMeta, resolveLaunchPath } from '../lib/paths.js'
import { GITHUB_OWNER, GITHUB_REPO } from '../lib/config.js'

const pkg = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
)

function printHelp() {
  process.stdout.write(`ClawEditor desktop launcher (@claweditor/cli)

Usage:
  claw-editor                 Download (if needed) and launch ClawEditor
  claw-editor install         Install from GitHub Releases
  claw-editor update          Re-download and install latest release
  claw-editor run             Same as default (launch)
  claw-editor version         Show CLI and installed app version
  claw-editor help            Show this help

Options:
  --tag <version>             Install a specific release (e.g. 0.1.0 or v0.1.0)
  --force                     Force re-download

Releases: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases
`)
}

function parseArgs(argv) {
  /** @type {{ command: string, tag?: string, force: boolean }} */
  const out = { command: 'run', force: false }
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    if (a === '--tag') {
      out.tag = args.shift()
      continue
    }
    if (a === '--force') {
      out.force = true
      continue
    }
    if (a === '--help' || a === '-h') {
      out.command = 'help'
      continue
    }
    if (!a.startsWith('-')) {
      out.command = a
    }
  }
  return out
}

async function main() {
  const { command, tag, force } = parseArgs(process.argv.slice(2))

  if (command === 'help') {
    printHelp()
    return
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    const meta = readInstallMeta()
    const launchPath = resolveLaunchPath(meta)
    process.stdout.write(`@claweditor/cli ${pkg.version}\n`)
    if (meta?.version) {
      process.stdout.write(`ClawEditor ${meta.version}${launchPath ? ` (${launchPath})` : ''}\n`)
    } else {
      process.stdout.write('ClawEditor: not installed\n')
    }
    return
  }

  if (command === 'install') {
    await install({ tag, force })
    return
  }

  if (command === 'update') {
    await install({ tag, force: true })
    return
  }

  if (command === 'run' || command === 'start') {
    await runApp({ tag, force })
    return
  }

  process.stderr.write(`Unknown command: ${command}\n\n`)
  printHelp()
  process.exit(1)
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
