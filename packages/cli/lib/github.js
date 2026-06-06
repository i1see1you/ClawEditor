import { GITHUB_OWNER, GITHUB_REPO } from './config.js'

const API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`

/**
 * @param {string | undefined} tag `latest` or `v0.1.0`
 */
export async function fetchRelease(tag) {
  const url = tag && tag !== 'latest'
    ? `${API}/releases/tags/${tag.startsWith('v') ? tag : `v${tag}`}`
    : `${API}/releases/latest`

  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': '@claweditor/cli',
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `GitHub release not found (${res.status}): ${url}${body ? `\n${body.slice(0, 200)}` : ''}`,
    )
  }

  return /** @type {Promise<{ tag_name: string, assets: Array<{ name: string, browser_download_url: string, size: number }> }>} */ (res.json())
}

/**
 * @param {Array<{ name: string, browser_download_url: string }>} assets
 * @param {RegExp[]} patterns
 */
export function pickAsset(assets, patterns) {
  for (const pattern of patterns) {
    const hit = assets.find((a) => pattern.test(a.name))
    if (hit) return hit
  }
  return null
}

/**
 * @param {string} url
 * @param {string} dest
 * @param {(received: number, total: number) => void} [onProgress]
 */
export async function downloadFile(url, dest, onProgress) {
  const res = await fetch(url, {
    headers: { 'User-Agent': '@claweditor/cli' },
    redirect: 'follow',
  })
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}): ${url}`)
  }

  const total = Number(res.headers.get('content-length') || 0)
  const reader = res.body.getReader()
  const chunks = []
  let received = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    onProgress?.(received, total)
  }

  const { writeFileSync } = await import('node:fs')
  writeFileSync(dest, Buffer.concat(chunks))
}
