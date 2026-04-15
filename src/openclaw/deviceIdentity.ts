/**
 * Ed25519 device identity compatible with OpenClaw Gateway
 * (`src/infra/device-identity.ts`: SHA-256(hex) of raw SPKI tail / raw public key).
 */
const STORAGE_KEY = 'claw-editor.openclaw.deviceIdentity'

type StoredIdentityV1 = {
  v: 1
  publicJwk: JsonWebKey
  privateJwk: JsonWebKey
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const b64 = btoa(bin)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function readStored(): StoredIdentityV1 | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as StoredIdentityV1
    if (p?.v === 1 && p.publicJwk && p.privateJwk) return p
  } catch {
    /* ignore */
  }
  return null
}

function writeStored(data: StoredIdentityV1): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export type DeviceIdentityKeys = {
  /** SHA-256 hex of raw 32-byte Ed25519 public key */
  deviceId: string
  /** Raw public key, base64url (Gateway `normalizeDevicePublicKeyBase64Url`) */
  publicKeyBase64Url: string
  signUtf8Payload: (payload: string) => Promise<string>
}

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentityKeys> {
  const algo: AlgorithmIdentifier = { name: 'Ed25519' }

  let publicKey: CryptoKey
  let privateKey: CryptoKey

  const stored = readStored()
  if (stored) {
    privateKey = await crypto.subtle.importKey('jwk', stored.privateJwk, algo, true, ['sign'])
    publicKey = await crypto.subtle.importKey('jwk', stored.publicJwk, algo, true, ['verify'])
  } else {
    const pair = (await crypto.subtle.generateKey(algo, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    publicKey = pair.publicKey
    privateKey = pair.privateKey
    const publicJwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey
    const privateJwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey
    writeStored({ v: 1, publicJwk, privateJwk })
  }

  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
  const deviceId = await sha256Hex(rawPub)
  const publicKeyBase64Url = base64UrlEncode(rawPub)

  return {
    deviceId,
    publicKeyBase64Url,
    signUtf8Payload: async (payload: string) => {
      const sig = await crypto.subtle.sign(
        'Ed25519',
        privateKey,
        new TextEncoder().encode(payload)
      )
      return base64UrlEncode(new Uint8Array(sig))
    },
  }
}
