// Stable, language-neutral error codes for client-facing error bodies.
//
// Every 4xx/5xx JSON body carries `code` next to the English `error` / `message` that older clients still read.
// Clients map `code` to their own translated text and show the English `message` only for a code they do not know,
// so a new code can be added here without an app release. Codes are lower_snake_case and never change once shipped.

import type { Request } from 'express';

/** Codes a client is expected to translate. Anything else is shown with the server's English message. */
export const ERROR_CODES = [
  'invalid_request', 'invalid_json', 'text_too_long', 'invalid_voice_id', 'job_id_required', 'device_id_required',
  'unauthenticated', 'token_expired', 'token_invalid', 'forbidden', 'tier_required', 'not_owner',
  'not_found', 'shared_voice_not_found', 'voice_not_found', 'job_not_found',
  'quota_exceeded', 'quota_daily_exceeded', 'quota_monthly_exceeded', 'payment_required',
  'rate_limited', 'voice_already_shared', 'voice_already_revoked', 'cannot_report_own_voice', 'already_reported',
  'cannot_rate_own_voice', 'cloning_unavailable',
  'provider_error', 'service_unavailable', 'timeout', 'internal_error', 'payload_too_large', 'unknown_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Known English messages that map to a more specific code than the HTTP status alone gives. Order matters. */
const MESSAGE_CODES: ReadonlyArray<readonly [RegExp, ErrorCode]> = [
  [/^Text too long/i, 'text_too_long'],
  [/^Invalid voice ID format/i, 'invalid_voice_id'],
  [/^Job ID is required/i, 'job_id_required'],
  [/^X-Device-ID header is required/i, 'device_id_required'],
  [/^This voice is already shared/i, 'voice_already_shared'],
  [/^Voice is already revoked/i, 'voice_already_revoked'],
  [/^You cannot report your own voice/i, 'cannot_report_own_voice'],
  [/^You have already reported this voice/i, 'already_reported'],
  [/^You cannot rate your own voice/i, 'cannot_rate_own_voice'],
  [/^You can only revoke your own/i, 'not_owner'],
  [/^This voice requires a higher subscription tier/i, 'tier_required'],
  [/^Voice cloning is not available/i, 'cloning_unavailable'],
  [/^Shared voice not found/i, 'shared_voice_not_found'],
  [/^Cloned voice not found/i, 'voice_not_found'],
  [/^Job not found/i, 'job_not_found'],
  [/^Token expired/i, 'token_expired'],
  [/(invalid or expired token|invalid token|malformed token|token signature|token claims|invalid or revoked api key)/i, 'token_invalid'],
  [/\bdaily\b.*\b(limit|quota)\b|\b(limit|quota)\b.*\bdaily\b/i, 'quota_daily_exceeded'],
  [/\bmonthly\b.*\b(limit|quota)\b|\b(limit|quota)\b.*\bmonthly\b/i, 'quota_monthly_exceeded'],
];

function codeFromStatus(statusCode: number): ErrorCode {
  switch (statusCode) {
    case 400: case 422: return 'invalid_request';
    case 401: return 'unauthenticated';
    case 402: return 'quota_exceeded';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 408: case 504: return 'timeout';
    case 413: return 'payload_too_large';
    case 429: return 'rate_limited';
    case 502: return 'provider_error';
    case 503: return 'service_unavailable';
    default: return statusCode >= 500 ? 'internal_error' : 'unknown_error';
  }
}

/**
 * The stable code for an error response. `explicit` (set where the error is thrown) wins; otherwise the English
 * message is matched against the table above; otherwise the HTTP status decides.
 */
export function resolveErrorCode(statusCode: number, message: unknown, explicit?: string): string {
  if (explicit) return explicit;
  if (typeof message === 'string') {
    for (const [re, code] of MESSAGE_CODES) if (re.test(message)) return code;
  }
  return codeFromStatus(statusCode);
}

// ---------------------------------------------------------------------------
// Accept-Language
// ---------------------------------------------------------------------------

/** Interface languages the Android app ships. Text on the wire stays English; this only says what the client asked for. */
export const SUPPORTED_LANGUAGES = [
  'en', 'ar', 'cs', 'de', 'el', 'es', 'fi', 'fil', 'fr', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'ms', 'nl', 'pl',
  'pt-BR', 'ro', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-CN', 'zh-TW', 'zh-HK',
] as const;

const LEGACY_TAGS: Record<string, string> = { in: 'id', tl: 'fil', iw: 'he' };

/**
 * Chinese ships in two scripts. Traditional: zh-TW (Taiwan, and a bare zh-Hant) and zh-HK (Hong Kong, Macau). Simplified: zh-CN,
 * which is also what a bare "zh" means (every client before the Traditional locales sent that), zh-SG and zh-Hans.
 */
function chineseVariant(subtags: string[]): 'zh-CN' | 'zh-TW' | 'zh-HK' {
  const lower = subtags.map((s) => s.toLowerCase());
  const region = lower.find((s) => s.length === 2);
  if (region === 'hk' || region === 'mo') return 'zh-HK';
  if (region === 'tw') return 'zh-TW';
  if (region === 'cn' || region === 'sg') return 'zh-CN';
  if (lower.includes('hant')) return 'zh-TW';
  return 'zh-CN';
}

/**
 * Best supported language for an Accept-Language header (RFC 9110 weights), or 'en' when the header is missing,
 * malformed or lists nothing we support.
 */
export function pickLanguage(header: string | undefined | null): string {
  if (!header || typeof header !== 'string' || header.length > 500) return 'en';
  const ranges = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: (tag ?? '').trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((r) => r.tag && r.tag !== '*' && r.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  for (const { tag } of ranges) {
    const parts = tag.replace(/_/g, '-').split('-');
    const lang = (parts[0] ?? '').toLowerCase();
    const base = Object.hasOwn(LEGACY_TAGS, lang) ? LEGACY_TAGS[lang]! : lang;
    if (base === 'zh') return chineseVariant(parts.slice(1));
    const region = parts.slice(1).find((p) => p.length === 2);
    const full = region ? `${base}-${region.toUpperCase()}` : base;
    const exact = SUPPORTED_LANGUAGES.find((s) => s.toLowerCase() === full.toLowerCase());
    if (exact) return exact;
    const byBase = SUPPORTED_LANGUAGES.find((s) => s.toLowerCase() === base);
    if (byBase) return byBase;
    if (base === 'pt') return 'pt-BR';
  }
  return 'en';
}

export function requestLanguage(req: Pick<Request, 'get'>): string {
  return pickLanguage(req.get('Accept-Language'));
}
