// Stateless crypto for the OAuth server. No database: everything is a self-contained token.
//
// OAUTH_SIGNING_SECRET (>= 32 random bytes, hex or base64; e.g. `openssl rand -base64 48`) is the single
// root secret. Two independent subkeys are derived with HKDF-SHA256:
//   - "sign": HMAC-SHA256 for client_id tokens (readable by the client, integrity only)
//   - "seal": AES-256-GCM for authorization codes, access tokens and refresh tokens. These are opaque
//     to clients: GCM gives confidentiality (the embedded API key) AND integrity, with the token type
//     bound as AAD so a code can never be replayed as an access token.
// ROTATION: changing the secret invalidates every client_id, code and token. Connected users simply
// reconnect (their old connector API keys stay valid until revoked in /developers).
// Tokens, codes and keys must never be logged.
import { createHash, createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

export class OAuthConfigError extends Error {}

let cached: { secret: string; sign: Buffer; seal: Buffer } | null = null

function decodeSecret(raw: string): Buffer | null {
  const s = raw.trim()
  const buf = /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64')
  return buf.length >= 32 ? buf : null
}

/** Whether the OAuth server is configured. Endpoints return 503 when false; /mcp keeps working with API keys. */
export function oauthConfigured(): boolean {
  const raw = process.env.OAUTH_SIGNING_SECRET
  return !!raw && decodeSecret(raw) !== null
}

function keys() {
  const raw = process.env.OAUTH_SIGNING_SECRET
  if (!raw) throw new OAuthConfigError('OAUTH_SIGNING_SECRET is not set')
  if (cached && cached.secret === raw) return cached
  const ikm = decodeSecret(raw)
  if (!ikm) throw new OAuthConfigError('OAUTH_SIGNING_SECRET must decode to at least 32 bytes')
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', ikm, 'readaloud-oauth-v1', info, 32))
  cached = { secret: raw, sign: derive('hmac-sign'), seal: derive('aes-gcm-seal') }
  return cached
}

export const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url')
export const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url')

/** Constant-time string comparison (hashes first so length differences do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

// ---- signed (HMAC) tokens: client_id ----
export function signToken(prefix: string, payload: object): string {
  const body = b64u(JSON.stringify(payload))
  const mac = createHmac('sha256', keys().sign).update(`${prefix}.${body}`).digest()
  return `${prefix}.${body}.${b64u(mac)}`
}

export function verifySigned<T>(prefix: string, token: string): T | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== prefix) return null
  const expect = b64u(createHmac('sha256', keys().sign).update(`${prefix}.${parts[1]}`).digest())
  if (!safeEqual(expect, parts[2])) return null
  try { return JSON.parse(fromB64u(parts[1]).toString('utf8')) as T } catch { return null }
}

// ---- sealed (AES-256-GCM) tokens: codes, access tokens, refresh tokens ----
export function seal(prefix: string, payload: object): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keys().seal, iv)
  c.setAAD(Buffer.from(prefix))
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()])
  return `${prefix}.${b64u(Buffer.concat([iv, c.getAuthTag(), ct]))}`
}

export function open<T>(prefix: string, token: string): T | null {
  const i = token.indexOf('.')
  if (i < 0 || token.slice(0, i) !== prefix) return null
  try {
    const raw = fromB64u(token.slice(i + 1))
    if (raw.length < 29) return null
    const d = createDecipheriv('aes-256-gcm', keys().seal, raw.subarray(0, 12))
    d.setAAD(Buffer.from(prefix))
    d.setAuthTag(raw.subarray(12, 28))
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as T
  } catch { return null }
}

// ---- PKCE (RFC 7636, S256 only) ----
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/
const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/
export const isValidChallenge = (c: string) => CHALLENGE_RE.test(c)
export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}
export function verifyPkce(verifier: string, challenge: string, method: string = 'S256'): boolean {
  if (method !== 'S256') return false // "plain" is never accepted
  if (!VERIFIER_RE.test(verifier) || !CHALLENGE_RE.test(challenge)) return false
  return safeEqual(pkceS256(verifier), challenge)
}

export const hashId = (s: string) => createHash('sha256').update(s).digest('base64url').slice(0, 22)
export const nowSec = () => Math.floor(Date.now() / 1000)
