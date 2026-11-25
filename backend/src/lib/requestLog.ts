// backend/src/lib/requestLog.ts
// Request-level API log: validation, storage and retention for POST /api/gateway/request-log (the gateway emits one
// event per request). Metadata only: character COUNTS, a gateway key id, enums and timings. Never text, audio or
// raw keys, and no user_id on the row (the owner is resolved at query time via realtimetts_api_keys.gateway_key_id).
import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';
import { RTTS_KEY_PREFIX } from './apiKeyResolver.js';

const log = logger.child({ module: 'request-log' });

export const MAX_EVENTS_PER_BATCH = 200;
export const MAX_BODY_BYTES = '256kb';
export const RETENTION_DAYS = 30;
const TS_WINDOW_MS = 86_400_000; // +-1 day
const INSERT_TIMEOUT_MS = 5000;

export const TRANSPORTS = ['http', 'ws-authorize', 'stt-authorize', 'audio-authorize', 'dubbing-authorize', 'stt-batch', 'other'] as const;
export const OUTCOMES = ['ok', 'auth_failed', 'rate_limited', 'quota_exceeded', 'client_error', 'server_error'] as const;
export type Transport = (typeof TRANSPORTS)[number];
export type Outcome = (typeof OUTCOMES)[number];

/** The row stored in realtimetts_request_log (id and received_at are database defaults). */
export interface RequestLogRow {
  ts: string;
  request_id: string;
  gateway_key_id: string;
  transport: Transport;
  endpoint: string;
  voice: string | null;
  language: string | null;
  chars: number;
  outcome: Outcome;
  http_status: number;
  error_code: string | null;
  ttfb_ms: number | null;
  duration_ms: number | null;
}

const KEYS: ReadonlySet<string> = new Set([
  'ts', 'request_id', 'gateway_key_id', 'transport', 'endpoint', 'voice', 'language', 'chars', 'outcome',
  'http_status', 'error_code', 'ttfb_ms', 'duration_ms',
]);

const CAPS = { endpoint: 120, voice: 60, language: 20, error_code: 60, request_id: 80, gateway_key_id: 80 } as const;
const CHARS_MAX = 10_000_000;
const TTFB_MAX_MS = 600_000;
const DURATION_MAX_MS = 86_400_000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** A bounded, non-empty, single-line string that cannot be a raw API key. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || CONTROL.test(v)) return null;
  if (v.includes(RTTS_KEY_PREFIX)) return null; // a raw key must never land in a log row, whatever field it sneaks into
  return v;
}
function optStr(v: unknown, max: number): string | null | undefined {
  if (v === null) return null;
  const s = str(v, max);
  return s === null ? undefined : s;
}
function int(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : null;
}
function optInt(v: unknown, min: number, max: number): number | null | undefined {
  if (v === null) return null;
  const n = int(v, min, max);
  return n === null ? undefined : n;
}

/** Validates one event strictly. Returns the row to store, or null when anything is off (unknown keys included). */
export function validateEvent(raw: unknown, now: Date = new Date()): RequestLogRow | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!KEYS.has(k)) return null; // e.g. a stray `text` field is refused, not silently ignored

  if (typeof e.ts !== 'string' || !ISO_8601.test(e.ts)) return null;
  const t = Date.parse(e.ts);
  if (!Number.isFinite(t) || Math.abs(t - now.getTime()) > TS_WINDOW_MS) return null;

  const request_id = str(e.request_id, CAPS.request_id);
  const gateway_key_id = str(e.gateway_key_id, CAPS.gateway_key_id);
  const endpoint = str(e.endpoint, CAPS.endpoint);
  // Query strings and fragments can carry text or keys; an endpoint is a path only.
  if (!request_id || !gateway_key_id || !endpoint || /[?#]/.test(endpoint)) return null;

  if (typeof e.transport !== 'string' || !(TRANSPORTS as readonly string[]).includes(e.transport)) return null;
  if (typeof e.outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(e.outcome)) return null;

  const voice = optStr(e.voice, CAPS.voice);
  const language = optStr(e.language, CAPS.language);
  const error_code = optStr(e.error_code, CAPS.error_code);
  const chars = int(e.chars, 0, CHARS_MAX);
  const http_status = int(e.http_status, 100, 599);
  const ttfb_ms = optInt(e.ttfb_ms, 0, TTFB_MAX_MS);
  const duration_ms = optInt(e.duration_ms, 0, DURATION_MAX_MS);
  if (voice === undefined || language === undefined || error_code === undefined) return null;
  if (chars === null || http_status === null || ttfb_ms === undefined || duration_ms === undefined) return null;

  return {
    ts: new Date(t).toISOString(), request_id, gateway_key_id,
    transport: e.transport as Transport, endpoint, voice, language, chars,
    outcome: e.outcome as Outcome, http_status, error_code, ttfb_ms, duration_ms,
  };
}

export type BatchResult =
  | { ok: true; rows: RequestLogRow[]; rejected: number }
  | { ok: false; status: 400 | 413 };

/** Validates a whole body: 400 for a malformed envelope, 413 over the event cap, else per-event accept/reject. */
export function validateBatch(body: unknown, now: Date = new Date()): BatchResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, status: 400 };
  const events = (body as Record<string, unknown>).events;
  if (!Array.isArray(events)) return { ok: false, status: 400 };
  if (events.length > MAX_EVENTS_PER_BATCH) return { ok: false, status: 413 };
  const rows: RequestLogRow[] = [];
  let rejected = 0;
  for (const ev of events) {
    const row = validateEvent(ev, now);
    if (row) rows.push(row); else rejected++;
  }
  return { ok: true, rows, rejected };
}

/** Kill switch, read per request so the owner can flip it with `fly secrets set` alone. Default OFF. */
export function requestLogIngestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['true', '1', 'yes', 'on'].includes((env.REQUEST_LOG_INGEST_ENABLED ?? '').trim().toLowerCase());
}

export type RequestLogInsert = (rows: RequestLogRow[]) => Promise<void>;

/** One bulk insert. Throws on failure or timeout; the route turns that into a 500 without echoing the cause. */
export const insertRequestLog: RequestLogInsert = async (rows) => {
  if (rows.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      supabase.from('realtimetts_request_log').insert(rows),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('request log insert timed out')), INSERT_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    // Postgres check-violation messages append 'Failing row contains (...)' with the row's values: drop that part.
    if (result.error) throw new Error(result.error.message.split('Failing row')[0]!.trim().slice(0, 200));
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Drops rows past retention. Never throws. */
export async function pruneOldRequestLog(
  now: Date = new Date(),
  client: Pick<typeof supabase, 'from'> = supabase,
): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    const { error } = await client.from('realtimetts_request_log').delete().lt('ts', cutoff);
    if (error) throw new Error(error.message);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not prune request log');
  }
}
