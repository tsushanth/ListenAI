// Fit-and-place core of the dubbing pipeline: synthesize each translated segment at speed 1, measure the
// real duration, refit the speed to the source slot, then lay the segments on the source timeline. Mirrors
// the S3 kit's arm C (dub_lab.py) and is shared by the production route and the verification harness.
// Transport-agnostic: `synth(text, voiceId, speed)` returns a WAV buffer.

import {
  MAX_SPEED, MIN_SPEED, decodeWavPcm16, encodeWavPcm16, placeSegments, planSpeed, type Placement,
} from './dubTiming.js';

export interface FitInput {
  /** Position in the sanitized segment list. */
  index: number;
  slotStart: number;
  slotEnd: number;
  text: string;
  speaker?: string;
  voiceId: string;
}

export type SynthFn = (text: string, voiceId: string, speed: number) => Promise<Buffer>;

export interface FitResult {
  index: number;
  slotStart: number;
  slotEnd: number;
  speaker?: string;
  voiceId: string;
  speedUsed: number;
  /** Duration of the audio that was placed (0 if skipped). */
  synthSec: number;
  /** Duration measured at speed 1 (the refit input). */
  naturalSec: number;
  clamped: boolean;
  ttsCalls: number;
  placedStartSec: number;
  driftSec: number;
  skipped?: 'empty_translation' | 'undecodable_audio';
}

export interface FitOptions {
  segments: FitInput[];
  synth: SynthFn;
  sourceDurationSec: number | null;
  /** Concurrent segments in flight against the TTS service (default 3). */
  concurrency?: number;
  minSpeed?: number;
  maxSpeed?: number;
  /** Skip the refit when the speed-1 duration is already this close to the slot (default 8%). */
  tolerance?: number;
  /** Trim lead-in/trailing silence of each synthesized segment (Piper voices carry ~0.3-0.8 s of it). */
  trimSilence?: boolean;
  /** Extra refit rounds when the first refit still misses by > 15% and is not clamped (default 1). */
  extraRefits?: number;
}

const TARGET_SR = 24000;
const TRIM_THRESHOLD = 0.015; // fraction of the segment's peak
const TRIM_KEEP_SEC = 0.04;

/** Remove leading/trailing samples below 1.5% of the peak, keeping 40 ms of margin. All-silent audio is returned unchanged. */
export function trimSilence(x: Int16Array, sampleRate: number): Int16Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]!); if (a > peak) peak = a; }
  if (peak === 0) return x;
  const thr = peak * TRIM_THRESHOLD;
  let a = 0;
  let b = x.length - 1;
  while (a < x.length && Math.abs(x[a]!) <= thr) a++;
  while (b > a && Math.abs(x[b]!) <= thr) b--;
  const keep = Math.round(TRIM_KEEP_SEC * sampleRate);
  return x.subarray(Math.max(0, a - keep), Math.min(x.length, b + 1 + keep));
}

function resampleLinear(x: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return x;
  const n = Math.round((x.length * to) / from);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (i * from) / to;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    const a = x[i0] ?? 0;
    const b = x[Math.min(i0 + 1, x.length - 1)] ?? a;
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Synthed {
  input: FitInput;
  samples: Int16Array | null;
  speedUsed: number;
  naturalSec: number;
  clamped: boolean;
  calls: number;
  skipped?: FitResult['skipped'];
}

async function fitOne(inp: FitInput, o: Required<Pick<FitOptions, 'synth' | 'minSpeed' | 'maxSpeed' | 'tolerance' | 'extraRefits' | 'trimSilence'>>): Promise<Synthed> {
  const base = { input: inp, speedUsed: 1, naturalSec: 0, clamped: false, calls: 0 };
  if (!inp.text.trim()) return { ...base, samples: null, skipped: 'empty_translation' };
  const slot = Math.max(inp.slotEnd - inp.slotStart, 0.1);

  const run = async (speed: number): Promise<{ samples: Int16Array; sec: number } | null> => {
    const wav = await o.synth(inp.text.trim(), inp.voiceId, speed);
    base.calls++;
    const d = decodeWavPcm16(wav);
    if (!d || d.samples.length === 0) return null;
    let s = resampleLinear(d.samples, d.sampleRate, TARGET_SR);
    if (o.trimSilence) s = trimSilence(s, TARGET_SR);
    return { samples: s, sec: s.length / TARGET_SR };
  };

  const first = await run(1);
  if (!first) return { ...base, samples: null, skipped: 'undecodable_audio' };
  base.naturalSec = first.sec;

  let best = { samples: first.samples, sec: first.sec, speed: 1 };
  let clamped = false;
  if (Math.abs(first.sec - slot) / slot > o.tolerance) {
    let speed = 1;
    let measuredAtSpeed1 = first.sec;
    for (let round = 0; round <= o.extraRefits; round++) {
      const plan = planSpeed(measuredAtSpeed1, slot, o.minSpeed, o.maxSpeed);
      clamped = plan.clamped;
      speed = plan.speed;
      const r = await run(speed);
      if (!r) break;
      if (Math.abs(r.sec - slot) < Math.abs(best.sec - slot)) best = { samples: r.samples, sec: r.sec, speed };
      if (clamped || Math.abs(r.sec - slot) / slot <= 0.15) break;
      // Still off: duration is not exactly 1/speed. Re-derive the speed-1 equivalent from this measurement.
      measuredAtSpeed1 = r.sec * speed;
    }
  }
  return { ...base, samples: best.samples, speedUsed: best.speed, clamped };
}

export async function fitAndPlace(opts: FitOptions): Promise<{
  wav: Buffer;
  durationSec: number;
  segments: FitResult[];
  maxDriftSec: number;
  placements: Placement[];
}> {
  const o = {
    synth: opts.synth,
    minSpeed: opts.minSpeed ?? MIN_SPEED,
    maxSpeed: opts.maxSpeed ?? MAX_SPEED,
    tolerance: opts.tolerance ?? 0.08,
    extraRefits: opts.extraRefits ?? 1,
    trimSilence: opts.trimSilence ?? false,
  };
  const synthed = await pool(opts.segments, opts.concurrency ?? 3, (s) => fitOne(s, o));

  const playable = synthed.filter((s) => s.samples && s.samples.length > 0);
  const placed = placeSegments(
    playable.map((s) => ({ slotStart: s.input.slotStart, slotEnd: s.input.slotEnd, samples: s.samples! })),
    TARGET_SR,
    opts.sourceDurationSec
  );
  const placementByIndex = new Map<number, Placement>();
  playable.forEach((s, i) => placementByIndex.set(s.input.index, placed.placements[i]!));

  const segments: FitResult[] = synthed.map((s) => {
    const p = placementByIndex.get(s.input.index);
    return {
      index: s.input.index,
      slotStart: s.input.slotStart,
      slotEnd: s.input.slotEnd,
      speaker: s.input.speaker,
      voiceId: s.input.voiceId,
      speedUsed: s.speedUsed,
      synthSec: s.samples ? s.samples.length / TARGET_SR : 0,
      naturalSec: s.naturalSec,
      clamped: s.clamped,
      ttsCalls: s.calls,
      placedStartSec: p?.startSec ?? s.input.slotStart,
      driftSec: p?.driftSec ?? 0,
      skipped: s.skipped,
    };
  });
  return {
    wav: encodeWavPcm16(placed.samples, TARGET_SR),
    durationSec: placed.samples.length / TARGET_SR,
    segments,
    maxDriftSec: placed.maxDriftSec,
    placements: placed.placements,
  };
}
