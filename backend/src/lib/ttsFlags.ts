// Remote TTS switches served by GET /api/config as `tts: { apiEnabled, engineApiEnabled }`.
// The Android client (TtsSourceFlags / TtsFlagLogic.parseRemote) reads exactly these two booleans.
// No imports from lib/config.js on purpose: that module validates the full Supabase env at import time.

export interface TtsFlags {
  /** Whether the app's reader should try the ReadAloud API first. Env TTS_API_ENABLED, default true. */
  apiEnabled: boolean;
  /**
   * KILL SWITCH ONLY. Whether the ReadAloud system TTS engine (text from OTHER apps) may use the API.
   * Always false unless env TTS_ENGINE_API_ENABLED is exactly "true" (case-insensitive, trimmed).
   * Absent, empty or garbled values resolve to false. The client additionally requires an explicit in-app
   * opt-in (see docs/tts-sources.md, "Privacy: engine API route"), which does not exist yet, so this must
   * stay unset in production until that opt-in ships.
   */
  engineApiEnabled: boolean;
}

/** "false"/"0"/"no"/"off" -> false, "true"/"1"/"yes"/"on" -> true, anything else -> fallback. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  return fallback;
}

export function getTtsFlags(env: NodeJS.ProcessEnv = process.env): TtsFlags {
  return {
    apiEnabled: parseBool(env.TTS_API_ENABLED, true),
    engineApiEnabled: (env.TTS_ENGINE_API_ENABLED ?? '').trim().toLowerCase() === 'true',
  };
}
