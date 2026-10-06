// Anonymous analytics for the homepage voice demo (LiveDemo). We record WHAT was played (which example sentence, or "custom"
// with only its length), how long the first audio took and how much audio played. The typed text itself is never sent or stored.
export const DEMO_KINDS = ['play', 'first_audio', 'done', 'stopped', 'error', 'sample_fallback'] as const
export type DemoKind = (typeof DEMO_KINDS)[number]

export interface DemoEventInput {
  kind?: unknown
  sid?: unknown
  preset?: unknown // index of the example sentence, or -1 for custom text
  chars?: unknown
  firstMs?: unknown
  audioMs?: unknown
  reason?: unknown
}

export interface DemoEvent {
  kind: DemoKind
  sid: string
  preset: number
  chars: number
  firstMs: number | null
  audioMs: number | null
  reason: string | null
}

const clampInt = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : null

/** Validates and normalises a demo event from the browser; null when it is not a well-formed event. */
export function parseDemoEvent(b: DemoEventInput | null | undefined): DemoEvent | null {
  if (!b || typeof b !== 'object') return null
  if (typeof b.kind !== 'string' || !(DEMO_KINDS as readonly string[]).includes(b.kind)) return null
  const sid = typeof b.sid === 'string' && /^[a-z0-9]{8,32}$/i.test(b.sid) ? b.sid : null
  if (!sid) return null
  const reason = typeof b.reason === 'string' ? b.reason.replace(/[^a-z0-9 _:-]/gi, '').slice(0, 40) || null : null
  return {
    kind: b.kind as DemoKind,
    sid,
    preset: clampInt(b.preset, -1, 20) ?? -1,
    chars: clampInt(b.chars, 0, 200) ?? 0,
    firstMs: clampInt(b.firstMs, 0, 60000),
    audioMs: clampInt(b.audioMs, 0, 120000),
    reason,
  }
}
