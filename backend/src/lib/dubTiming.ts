// Pure timing/placement helpers for the dubbing pipeline (no I/O, unit-tested in dubTiming.test.ts).
//
// Ported from the S3 kit's arm C (kit/dub_lab.py: measure real duration at speed 1, refit speed, place each
// segment at its source start with silence in the gaps), plus the guards the S3 report asked for: drop STT
// hallucinations / segments past the audio end, merge sub-second backchannels, and give the translator a
// per-segment length budget.

import { resolveDubLanguage } from './dubLanguages.js';

export interface TimedSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface SanitizedSegment extends TimedSegment {
  /** Indexes into the original STT segment array that this segment covers (merged backchannels have >1). */
  sourceIndexes: number[];
}

export type DropReason = 'empty' | 'non_speech' | 'bad_time' | 'beyond_audio' | 'implausible_rate' | 'too_short';

// Tunables. Chosen from the S3 measurements; see the verification table in the PR notes.
export const MIN_SEGMENT_SEC = 1.0; // shorter segments are merged into a same-speaker neighbour
export const DROP_BELOW_SEC = 0.4; // ...or dropped if they have no neighbour
export const MERGE_GAP_SEC = 0.6;
export const BEYOND_AUDIO_TOLERANCE_SEC = 0.25;
export const MIN_SPEED = 0.8; // below this we pad with silence instead of slowing speech down
export const MAX_SPEED = 1.7; // above this intelligibility collapses (S3: hi at 2.0x); overrun spills into the gap
export const BUDGET_SLACK = 1.2; // translator may exceed the speed-1 length by 20% (absorbed by speed <= 1.2)

const NON_SPEECH = /^\s*[\[(＜<♪♫*].*[\])＞>♪♫*]\s*$/;

export function sanitizeSegments(
  input: TimedSegment[],
  audioDurationSec: number | null | undefined
): { kept: SanitizedSegment[]; dropped: Array<{ index: number; reason: DropReason }> } {
  const dropped: Array<{ index: number; reason: DropReason }> = [];
  const valid: SanitizedSegment[] = [];
  const hasDur = typeof audioDurationSec === 'number' && Number.isFinite(audioDurationSec) && audioDurationSec > 0;

  input.forEach((s, i) => {
    const text = (s.text ?? '').trim();
    if (!text) return void dropped.push({ index: i, reason: 'empty' });
    if (NON_SPEECH.test(text) || /^[♪♫\s.]+$/.test(text)) return void dropped.push({ index: i, reason: 'non_speech' });
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start || s.start < 0) {
      return void dropped.push({ index: i, reason: 'bad_time' });
    }
    let end = s.end;
    if (hasDur) {
      if (s.start >= audioDurationSec! - BEYOND_AUDIO_TOLERANCE_SEC) return void dropped.push({ index: i, reason: 'beyond_audio' });
      end = Math.min(end, audioDurationSec!);
    }
    const dur = end - s.start;
    // Whisper's classic tail hallucination ("Thank you." stretched over 30 s): at least 4 s long and under 1 char/s.
    if (dur >= 4 && text.length / dur < 1.0) return void dropped.push({ index: i, reason: 'implausible_rate' });
    valid.push({ start: s.start, end, text, speaker: s.speaker, sourceIndexes: [i] });
  });

  // Merge pass for sub-second segments.
  const kept: SanitizedSegment[] = [];
  let carry: SanitizedSegment | null = null; // a short segment waiting to be merged into the NEXT one
  for (let k = 0; k < valid.length; k++) {
    let cur = valid[k]!;
    if (carry) {
      cur = {
        start: carry.start, end: cur.end, speaker: cur.speaker,
        text: `${carry.text} ${cur.text}`, sourceIndexes: [...carry.sourceIndexes, ...cur.sourceIndexes],
      };
      carry = null;
    }
    if (cur.end - cur.start >= MIN_SEGMENT_SEC) { kept.push(cur); continue; }
    const prev = kept[kept.length - 1];
    if (prev && prev.speaker === cur.speaker && cur.start - prev.end <= MERGE_GAP_SEC) {
      prev.text = `${prev.text} ${cur.text}`;
      prev.end = Math.max(prev.end, cur.end);
      prev.sourceIndexes = [...prev.sourceIndexes, ...cur.sourceIndexes];
      continue;
    }
    const next = valid[k + 1];
    if (next && next.speaker === cur.speaker && next.start - cur.end <= MERGE_GAP_SEC) { carry = cur; continue; }
    if (cur.end - cur.start < DROP_BELOW_SEC) {
      for (const idx of cur.sourceIndexes) dropped.push({ index: idx, reason: 'too_short' });
      continue;
    }
    kept.push(cur);
  }
  dropped.sort((a, b) => a.index - b.index);
  return { kept, dropped };
}

// ------------------------------------------------------------------ translator length budget

export const CHARS_PER_SEC_DEFAULT = 15;

/** Per-segment character budget for the translator, from the slot length and the target language's measured Kokoro rate. */
export function lengthBudget(slotSec: number, lang: string): { targetChars: number; maxChars: number } {
  const charsPerSec = resolveDubLanguage(lang)?.charsPerSec ?? CHARS_PER_SEC_DEFAULT;
  const slot = Math.max(slotSec, 0.1);
  const target = Math.round(slot * charsPerSec);
  return { targetChars: Math.max(4, target), maxChars: Math.max(6, Math.round(target * BUDGET_SLACK)) };
}

// ------------------------------------------------------------------ speed refit

/** speed so that a segment measured at speed 1 lasts slotSec. Clamped; `clamped` means the slot cannot be met by speed alone. */
export function planSpeed(measuredAtSpeed1Sec: number, slotSec: number, min = MIN_SPEED, max = MAX_SPEED): { speed: number; clamped: boolean } {
  if (!(measuredAtSpeed1Sec > 0) || !(slotSec > 0)) return { speed: 1, clamped: false };
  const raw = measuredAtSpeed1Sec / slotSec;
  const speed = Math.min(max, Math.max(min, raw));
  return { speed, clamped: speed !== raw };
}

// ------------------------------------------------------------------ WAV

export function encodeWavPcm16(samples: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i]!, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export interface DecodedWav { samples: Int16Array; sampleRate: number }

/** Decode mono (or downmix) 16-bit PCM WAV; also accepts 32-bit float (soundfile's default for float arrays). null if unsupported. */
export function decodeWavPcm16(buf: Buffer): DecodedWav | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt: { tag: number; ch: number; sr: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    const end = Math.min(start + size, buf.length);
    if (id === 'fmt ' && end - start >= 16) {
      fmt = { tag: buf.readUInt16LE(start), ch: buf.readUInt16LE(start + 2), sr: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      data = buf.subarray(start, end);
    }
    off = start + size + (size % 2);
  }
  if (!fmt || !data || fmt.ch < 1) return null;
  const bytes = fmt.bits / 8;
  if (!((fmt.tag === 1 && fmt.bits === 16) || (fmt.tag === 3 && fmt.bits === 32))) return null;
  const frames = Math.floor(data.length / (bytes * fmt.ch));
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = (i * fmt.ch + c) * bytes;
      acc += fmt.tag === 1 ? data.readInt16LE(o) : Math.max(-1, Math.min(1, data.readFloatLE(o))) * 32767;
    }
    out[i] = Math.round(acc / fmt.ch);
  }
  return { samples: out, sampleRate: fmt.sr };
}

export function wavDurationSec(buf: Buffer): number | null {
  const d = decodeWavPcm16(buf);
  return d && d.sampleRate > 0 ? d.samples.length / d.sampleRate : null;
}

// ------------------------------------------------------------------ placement

export interface PlacedInput { slotStart: number; slotEnd: number; samples: Int16Array }
export interface Placement { startSec: number; endSec: number; driftSec: number }

const FADE_SEC = 0.004;

/**
 * Lay segment audio on one timeline: each segment starts at its source slot start (kit arm C), or right
 * after the previous segment if that one ran over. Output is padded with silence to `totalDurationSec` so the
 * dub is as long as the source. `driftSec` = placed start - source start (>= 0); maxDriftSec is the worst.
 */
export function placeSegments(
  inputs: PlacedInput[],
  sampleRate: number,
  totalDurationSec: number | null
): { samples: Int16Array; placements: Placement[]; maxDriftSec: number } {
  const placements: Placement[] = [];
  let cursor = 0; // seconds
  let maxDrift = 0;
  const chunks: Array<{ at: number; s: Int16Array }> = [];
  for (const inp of inputs) {
    const startSec = Math.max(inp.slotStart, cursor);
    const durSec = inp.samples.length / sampleRate;
    const drift = startSec - inp.slotStart;
    maxDrift = Math.max(maxDrift, drift);
    placements.push({ startSec, endSec: startSec + durSec, driftSec: drift });
    chunks.push({ at: Math.round(startSec * sampleRate), s: inp.samples });
    cursor = startSec + durSec;
  }
  const endSample = Math.max(
    Math.round((totalDurationSec ?? 0) * sampleRate),
    ...chunks.map((c) => c.at + c.s.length),
    0
  );
  const out = new Int16Array(endSample);
  const fade = Math.round(FADE_SEC * sampleRate);
  for (const c of chunks) {
    const n = c.s.length;
    for (let i = 0; i < n; i++) {
      let v = c.s[i]!;
      if (i < fade) v = Math.round(v * (i / fade));
      else if (n - 1 - i < fade) v = Math.round(v * ((n - 1 - i) / fade));
      out[c.at + i] = v;
    }
  }
  return { samples: out, placements, maxDriftSec: maxDrift };
}

// ------------------------------------------------------------------ subtitles

function ts(sec: number, sep: ',' | '.'): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

function cueText(text: string): string {
  // Blank lines end a cue and "-->" starts a timing line: neither may appear inside cue text.
  return text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n').replace(/-->/g, '->');
}

export interface Cue { start: number; end: number; text: string }

export function toSrt(cues: Cue[]): string {
  let n = 0;
  const parts: string[] = [];
  for (const c of cues) {
    const t = cueText(c.text);
    if (!t) continue;
    n++;
    parts.push(`${n}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${t}\n`);
  }
  return parts.join('\n');
}

export function toVtt(cues: Cue[]): string {
  const parts: string[] = [];
  for (const c of cues) {
    const t = cueText(c.text);
    if (!t) continue;
    parts.push(`${ts(c.start, '.')} --> ${ts(c.end, '.')}\n${t}\n`);
  }
  return `WEBVTT\n\n${parts.join('\n')}`;
}
