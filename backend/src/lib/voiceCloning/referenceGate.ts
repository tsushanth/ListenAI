// Reference-audio gate: decide, from measured AudioMetrics, whether a clip is good enough to clone from.
// Pure function; thresholds come from ClonePolicy. The REPORT showed Chatterbox degrades hardest on
// noisy references (sim 0.68 -> 0.33 at 10 dB), so a noisy clip is rejected rather than cloned badly.
import type { AudioMetrics } from './types.js';
import type { ClonePolicy } from './policy.js';

export type GateFailureCode =
  | 'too_short'
  | 'too_long'
  | 'not_enough_speech'
  | 'too_noisy'
  | 'clipped'
  | 'multiple_speakers'
  | 'music_detected';

export interface GateFailure {
  code: GateFailureCode;
  message: string;
}

export interface GateResult {
  ok: boolean;
  failures: GateFailure[];
}

export function evaluateReference(m: AudioMetrics, p: ClonePolicy): GateResult {
  const failures: GateFailure[] = [];
  if (m.durationSec < p.minReferenceSec) {
    failures.push({ code: 'too_short', message: `Reference audio must be at least ${p.minReferenceSec} seconds (got ${m.durationSec.toFixed(1)}).` });
  }
  if (m.durationSec > p.maxReferenceSec) {
    failures.push({ code: 'too_long', message: `Reference audio must be at most ${p.maxReferenceSec} seconds.` });
  }
  const speechRatio = m.durationSec > 0 ? m.speechSec / m.durationSec : 0;
  if (speechRatio < p.minSpeechRatio) {
    failures.push({ code: 'not_enough_speech', message: 'Less than half of the clip contains speech. Record continuous talking with few pauses.' });
  }
  if (m.snrDb < p.minSnrDb) {
    failures.push({ code: 'too_noisy', message: 'Background noise is too high. Record in a quiet room close to the microphone.' });
  }
  if (m.clippingRatio > p.maxClippingRatio) {
    failures.push({ code: 'clipped', message: 'The recording is distorted (clipping). Lower the input volume and record again.' });
  }
  if (m.minWindowSimilarity !== null && m.minWindowSimilarity < p.minWindowSimilarity) {
    failures.push({ code: 'multiple_speakers', message: 'The clip seems to contain more than one speaker. Use a recording of only the voice you are cloning.' });
  }
  if (m.musicProb > p.maxMusicProb) {
    failures.push({ code: 'music_detected', message: 'Music or background audio was detected. Use a clean recording of speech only.' });
  }
  return { ok: failures.length === 0, failures };
}

/** The consent clip is not cloned from, so only the basics are enforced. */
export function evaluateConsentClip(m: AudioMetrics, p: ClonePolicy): GateResult {
  const failures: GateFailure[] = [];
  if (m.durationSec < p.minConsentSec) failures.push({ code: 'too_short', message: 'The consent recording is too short.' });
  if (m.durationSec > p.maxConsentSec) failures.push({ code: 'too_long', message: 'The consent recording is too long.' });
  if (m.musicProb > p.maxMusicProb) failures.push({ code: 'music_detected', message: 'Music or background audio was detected in the consent recording.' });
  return { ok: failures.length === 0, failures };
}
