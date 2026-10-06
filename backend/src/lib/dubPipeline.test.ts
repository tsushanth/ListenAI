import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAndPlace, type FitInput } from './dubPipeline.js';
import { encodeWavPcm16, decodeWavPcm16 } from './dubTiming.js';

const SR = 24000;

/** Fake Kokoro: duration = chars / cps / speed (speed ~ linear, like the real thing roughly), constant tone. */
function fakeSynth(cps: number, calls: Array<{ text: string; voice: string; speed: number }> = []) {
  return async (text: string, voiceId: string, speed: number): Promise<Buffer> => {
    calls.push({ text, voice: voiceId, speed });
    const n = Math.round((text.length / cps / speed) * SR);
    const a = new Int16Array(n).fill(5000);
    return encodeWavPcm16(a, SR);
  };
}

const inp = (i: number, start: number, end: number, text: string, speaker?: string): FitInput => ({
  index: i, slotStart: start, slotEnd: end, text, speaker, voiceId: speaker === 'B' ? 'ef_dora' : 'em_alex',
});

test('fitAndPlace: refits speed from the measured duration so segments land within 20% of their slot', async () => {
  const calls: Array<{ text: string; voice: string; speed: number }> = [];
  const text = 'x'.repeat(100); // 100 chars at 10 cps = 10 s at speed 1
  const r = await fitAndPlace({
    segments: [inp(0, 0, 8, text), inp(1, 10, 15, 'y'.repeat(75))],
    synth: fakeSynth(10, calls),
    sourceDurationSec: 20,
  });
  for (const s of r.segments) assert.ok(Math.abs(s.synthSec - (s.slotEnd - s.slotStart)) <= 0.2 * (s.slotEnd - s.slotStart), JSON.stringify(s));
  assert.equal(r.segments[0]!.ttsCalls >= 2, true);
  assert.equal(r.maxDriftSec, 0);
  assert.ok(Math.abs(r.durationSec - 20) < 0.01);
  // first call is always at speed 1 (measurement), never the 12.5 chars/s guess
  assert.equal(calls[0]!.speed, 1);
});

test('fitAndPlace: a segment already within 8% of its slot is not re-synthesized', async () => {
  const calls: Array<{ text: string; voice: string; speed: number }> = [];
  const r = await fitAndPlace({ segments: [inp(0, 0, 10, 'x'.repeat(100))], synth: fakeSynth(10, calls), sourceDurationSec: 10 });
  assert.equal(calls.length, 1);
  assert.equal(r.segments[0]!.ttsCalls, 1);
});

test('fitAndPlace: clamps at MAX_SPEED and reports the segment as clamped, never speeds past the cap', async () => {
  const calls: Array<{ text: string; voice: string; speed: number }> = [];
  const r = await fitAndPlace({ segments: [inp(0, 0, 2, 'x'.repeat(200))], synth: fakeSynth(10, calls), sourceDurationSec: 30 });
  assert.equal(r.segments[0]!.clamped, true);
  assert.ok(calls.every((c) => c.speed <= 1.7 + 1e-9 && c.speed >= 0.8 - 1e-9));
});

test('fitAndPlace: passes each segment its own speaker voice', async () => {
  const calls: Array<{ text: string; voice: string; speed: number }> = [];
  await fitAndPlace({
    segments: [inp(0, 0, 4, 'a'.repeat(40), 'A'), inp(1, 5, 9, 'b'.repeat(40), 'B')],
    synth: fakeSynth(10, calls), sourceDurationSec: 10,
  });
  assert.deepEqual([...new Set(calls.map((c) => c.voice))].sort(), ['ef_dora', 'em_alex']);
});

test('fitAndPlace: empty text produces no audio and no TTS call', async () => {
  const calls: Array<{ text: string; voice: string; speed: number }> = [];
  const r = await fitAndPlace({ segments: [inp(0, 0, 3, '   ')], synth: fakeSynth(10, calls), sourceDurationSec: 5 });
  assert.equal(calls.length, 0);
  assert.equal(r.segments[0]!.skipped, 'empty_translation');
});

test('fitAndPlace: undecodable TTS output skips that segment instead of failing the whole dub', async () => {
  let n = 0;
  const synth = async (text: string, v: string, s: number) => (++n === 1 ? Buffer.from('not a wav') : fakeSynth(10)(text, v, s));
  const r = await fitAndPlace({ segments: [inp(0, 0, 4, 'a'.repeat(40)), inp(1, 5, 9, 'b'.repeat(40))], synth, sourceDurationSec: 10 });
  assert.equal(r.segments[0]!.skipped, 'undecodable_audio');
  assert.equal(r.segments[1]!.skipped, undefined);
});

test('fitAndPlace: output WAV is mono 24 kHz PCM16 as long as the source, and decodes', async () => {
  const r = await fitAndPlace({ segments: [inp(0, 1, 5, 'a'.repeat(40))], synth: fakeSynth(10), sourceDurationSec: 12 });
  const d = decodeWavPcm16(r.wav)!;
  assert.equal(d.sampleRate, SR);
  assert.ok(Math.abs(d.samples.length / SR - 12) < 0.01);
});

test('fitAndPlace: overrun that exceeds the next slot is reported as drift on the following segment', async () => {
  const r = await fitAndPlace({
    segments: [inp(0, 0, 2, 'x'.repeat(100)), inp(1, 2.5, 6, 'y'.repeat(35))],
    synth: fakeSynth(10), sourceDurationSec: 10,
  });
  // 100 chars at max speed 1.7 -> ~5.9 s > slot 2: pushes segment 1 past its 2.5 s start
  assert.ok(r.segments[1]!.driftSec > 2);
  assert.ok(r.maxDriftSec > 2);
});

test('fitAndPlace: bounded concurrency still preserves segment order', async () => {
  const order: number[] = [];
  const synth = async (text: string, _v: string, speed: number) => {
    await new Promise((res) => setTimeout(res, text.length % 7));
    order.push(text.length);
    return fakeSynth(10)(text, _v, speed);
  };
  const segs = Array.from({ length: 12 }, (_, i) => inp(i, i * 5, i * 5 + 4, 'z'.repeat(20 + i)));
  const r = await fitAndPlace({ segments: segs, synth, sourceDurationSec: 60, concurrency: 4 });
  assert.deepEqual(r.segments.map((s) => s.index), segs.map((s) => s.index));
  assert.ok(r.segments.every((s, i) => i === 0 || s.placedStartSec >= r.segments[i - 1]!.placedStartSec));
});

// ---- silence trimming (Piper voices carry long lead-in/trailing silence that inflates the measured duration)
function withSilence(speechSec: number, leadSec: number, trailSec: number, cps: number, text: string) {
  const lead = new Int16Array(Math.round(leadSec * SR));
  const speech = new Int16Array(Math.round(speechSec * SR)).fill(6000);
  const trail = new Int16Array(Math.round(trailSec * SR));
  const all = new Int16Array(lead.length + speech.length + trail.length);
  all.set(speech, lead.length);
  return encodeWavPcm16(all, SR);
}

test('fitAndPlace trimSilence: lead-in/trailing silence is removed so the refit sees the speech duration', async () => {
  const synth = async (text: string) => withSilence(text.length / 10, 0.6, 0.8, 10, text);
  const trimmed = await fitAndPlace({ segments: [inp(0, 0, 5, 'x'.repeat(50))], synth, sourceDurationSec: 6, trimSilence: true });
  // speech is 5.0 s, slot is 5 s: within tolerance at speed 1 with no refit once the 1.4 s of silence is trimmed
  assert.equal(trimmed.segments[0]!.ttsCalls, 1);
  assert.ok(Math.abs(trimmed.segments[0]!.synthSec - 5.0) < 0.2, String(trimmed.segments[0]!.synthSec));
  const untrimmed = await fitAndPlace({ segments: [inp(0, 0, 5, 'x'.repeat(50))], synth, sourceDurationSec: 6 });
  assert.ok(untrimmed.segments[0]!.synthSec > trimmed.segments[0]!.synthSec + 0.5);
});

test('fitAndPlace trimSilence: speech onset lands at the slot start (no lead-in delay)', async () => {
  const synth = async (text: string) => withSilence(text.length / 10, 0.5, 0.5, 10, text);
  const r = await fitAndPlace({ segments: [inp(0, 2, 4, 'x'.repeat(20))], synth, sourceDurationSec: 6, trimSilence: true });
  const d = decodeWavPcm16(r.wav)!;
  const firstLoud = d.samples.findIndex((v) => Math.abs(v) > 2000);
  assert.ok(Math.abs(firstLoud / SR - 2.0) < 0.1, `onset ${firstLoud / SR}`);
});

test('fitAndPlace trimSilence: an all-silent synthesis is kept as-is (never trimmed to nothing)', async () => {
  const synth = async () => encodeWavPcm16(new Int16Array(SR), SR);
  const r = await fitAndPlace({ segments: [inp(0, 0, 1, 'x'.repeat(10))], synth, sourceDurationSec: 2, trimSilence: true });
  assert.ok(r.segments[0]!.synthSec > 0.9);
});
