// Reader settings that persist between visits (voice and speed), stored in localStorage under one key.
// Speeds match the Android app (SettingsManager clamps to 0.5x-2.0x; the speed picker offers these steps).
// Pure functions over a minimal Storage-like object so they can be unit-tested without a browser.

export const READER_SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
export const DEFAULT_READER_SPEED = 1
export const READER_SETTINGS_KEY = 'readaloud.reader.settings.v1'

export interface ReaderSettings {
  /** Voice id, or null when none was saved (or the saved one is no longer offered). */
  voice: string | null
  speed: number
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The allowed speed closest to `value` (a non-finite value gives the default). Matches Android's clamp to 0.5-2.0. */
export function normalizeSpeed(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_READER_SPEED
  const clamped = Math.min(2, Math.max(0.5, n))
  return READER_SPEEDS.reduce((best, s) => (Math.abs(s - clamped) < Math.abs(best - clamped) ? s : best), READER_SPEEDS[0]!)
}

/**
 * Read saved settings. Never throws: missing, corrupt or unreadable storage gives the defaults. `isVoiceAvailable` guards
 * against a saved voice that is no longer in the picker.
 */
export function loadReaderSettings(storage: StorageLike | null | undefined, isVoiceAvailable: (id: string) => boolean): ReaderSettings {
  const fallback: ReaderSettings = { voice: null, speed: DEFAULT_READER_SPEED }
  if (!storage) return fallback
  let raw: string | null
  try { raw = storage.getItem(READER_SETTINGS_KEY) } catch { return fallback }
  if (!raw) return fallback
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return fallback }
  if (!parsed || typeof parsed !== 'object') return fallback
  const { voice, speed } = parsed as { voice?: unknown; speed?: unknown }
  return {
    voice: typeof voice === 'string' && isVoiceAvailable(voice) ? voice : null,
    speed: normalizeSpeed(speed ?? DEFAULT_READER_SPEED),
  }
}

/** Save settings. Storage can be full or blocked (private mode); that is not worth an error, so failures are swallowed. */
export function saveReaderSettings(storage: StorageLike | null | undefined, settings: { voice: string; speed: number }): void {
  if (!storage) return
  try {
    storage.setItem(READER_SETTINGS_KEY, JSON.stringify({ voice: settings.voice, speed: normalizeSpeed(settings.speed) }))
  } catch { /* ignore */ }
}
