import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSegments,
  lengthBudget,
  planSpeed,
  placeSegments,
  wavDurationSec,
  encodeWavPcm16,
  decodeWavPcm16,
  toSrt,
  toVtt,
  type TimedSegment,
} from './dubTiming.js';

const seg = (start: number, end: number, text: string, speaker?: string): TimedSegment => ({ start, end, text, speaker });

// ---------------------------------------------------------------- sanitize

test('sanitize: the S3 c7 hallucination (a "Thank you." segment 75-105 s on a 75 s clip) is dropped', () => {
  const r = sanitizeSegments([seg(0, 10, 'Hello there my friend how are you.'), seg(74.98, 104.96, 'Thank you.')], 75);
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped[0]!.reason, 'beyond_audio');
});

test('sanitize: a segment that straddles the audio end is clamped, not dropped', () => {
  const r = sanitizeSegments([seg(60, 90, 'A long enough sentence that is really spoken until the very end.')], 75);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0]!.end, 75);
});

test('sanitize: without a known duration a very slow "speech rate" segment is still treated as hallucinated', () => {
  const r = sanitizeSegments([seg(0, 8, 'Real words are spoken here at a normal pace for sure.'), seg(8, 38, 'Thank you.')], null);
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped[0]!.reason, 'implausible_rate');
});

test('sanitize: a real short "Thank you." at normal pace is kept', () => {
  const r = sanitizeSegments([seg(0, 1.4, 'Thank you.')], null);
  assert.equal(r.kept.length, 1);
});

test('sanitize: empty, non-speech tags and inverted times are dropped', () => {
  const r = sanitizeSegments([seg(0, 2, '   '), seg(2, 4, '[Music]'), seg(5, 4, 'inverted'), seg(6, 9, 'Fine segment of speech here.')], null);
  assert.equal(r.kept.length, 1);
  assert.deepEqual(r.dropped.map((d) => d.reason).sort(), ['bad_time', 'empty', 'non_speech']);
});

test('sanitize: sub-second backchannel is merged into the adjacent same-speaker segment', () => {
  const r = sanitizeSegments([
    seg(0, 5, 'So what did you do next after that happened.'),
    seg(5.1, 5.4, 'Yeah.'),
    seg(9, 14, 'Then we went home and slept for a long time.'),
  ], null);
  assert.equal(r.kept.length, 2);
  assert.match(r.kept[0]!.text, /after that happened\. Yeah\.$/);
  assert.equal(r.kept[0]!.end, 5.4);
  assert.deepEqual(r.kept[0]!.sourceIndexes, [0, 1]);
});

test('sanitize: sub-second segment from a different speaker is not merged across speakers', () => {
  const r = sanitizeSegments([
    seg(0, 5, 'So what did you do next after that happened.', 'A'),
    seg(5.1, 5.7, 'Yeah.', 'B'),
    seg(9, 14, 'Then we went home and slept for a long time.', 'A'),
  ], null);
  assert.equal(r.kept.length, 3);
});

test('sanitize: isolated very short fragment (<0.4 s, no neighbour within 0.6 s) is dropped', () => {
  const r = sanitizeSegments([seg(0, 5, 'A full sentence is spoken right here.'), seg(20, 20.3, 'Uh.'), seg(40, 45, 'Another full sentence spoken here.')], null);
  assert.equal(r.kept.length, 2);
  assert.equal(r.dropped[0]!.reason, 'too_short');
});

test('sanitize: keeps order and original indexes', () => {
  const r = sanitizeSegments([seg(0, 3, 'One whole sentence here.'), seg(3, 6, 'Two whole sentence here.')], null);
  assert.deepEqual(r.kept.map((k) => k.sourceIndexes), [[0], [1]]);
});

// ---------------------------------------------------------------- budget

test('lengthBudget scales with slot and language speaking rate (hi is slower than es)', () => {
  const es = lengthBudget(10, 'es');
  const hi = lengthBudget(10, 'hi');
  assert.ok(es.maxChars > hi.maxChars);
  assert.ok(es.targetChars <= es.maxChars);
  assert.ok(es.targetChars > 100 && es.targetChars < 220, `es target ${es.targetChars}`);
});

test('lengthBudget has a sane floor for tiny slots', () => {
  assert.ok(lengthBudget(0.3, 'es').maxChars >= 6);
});

// ---------------------------------------------------------------- speed planning

test('planSpeed: measured duration equal to slot -> speed 1', () => {
  assert.equal(planSpeed(5, 5).speed, 1);
});

test('planSpeed: refit uses measured/slot, clamped to [MIN,MAX] and reports clamping', () => {
  const fast = planSpeed(30, 5);
  assert.equal(fast.clamped, true);
  assert.ok(fast.speed <= 2.0);
  const slow = planSpeed(1, 20);
  assert.equal(slow.clamped, true);
  assert.ok(slow.speed >= 0.5);
  const mid = planSpeed(6, 5);
  assert.equal(mid.clamped, false);
  assert.ok(Math.abs(mid.speed - 1.2) < 1e-9);
});

// ---------------------------------------------------------------- wav + placement

function tone(seconds: number, sr = 24000, amp = 8000): Int16Array {
  const a = new Int16Array(Math.round(seconds * sr));
  for (let i = 0; i < a.length; i++) a[i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / sr));
  return a;
}

test('wav encode/decode roundtrip and duration', () => {
  const wav = encodeWavPcm16(tone(1.5), 24000);
  assert.ok(Math.abs(wavDurationSec(wav)! - 1.5) < 1e-3);
  const d = decodeWavPcm16(wav)!;
  assert.equal(d.sampleRate, 24000);
  assert.equal(d.samples.length, 36000);
});

test('wavDurationSec returns null for non-WAV bytes', () => {
  assert.equal(wavDurationSec(Buffer.from('fake-mp3')), null);
});

test('placeSegments puts each segment at its source start with silence in the gaps', () => {
  const sr = 24000;
  const out = placeSegments([
    { slotStart: 0, slotEnd: 2, samples: tone(2) },
    { slotStart: 5, slotEnd: 7, samples: tone(2) },
  ], sr, 10);
  assert.equal(out.placements[0]!.startSec, 0);
  assert.equal(out.placements[1]!.startSec, 5);
  assert.equal(out.maxDriftSec, 0);
  assert.equal(out.samples.length, 10 * sr); // padded to the source duration
  // silence in the gap, signal at the slot start
  assert.equal(out.samples[3 * sr], 0);
  assert.ok(Math.max(...Array.from(out.samples.slice(5 * sr + 1000, 5 * sr + 2000))) > 1000);
});

test('placeSegments: an overlong segment pushes the next start (drift) instead of overlapping, and drift is reported', () => {
  const sr = 24000;
  const out = placeSegments([
    { slotStart: 0, slotEnd: 2, samples: tone(4) },
    { slotStart: 3, slotEnd: 5, samples: tone(2) },
  ], sr, 6);
  assert.equal(out.placements[1]!.startSec, 4);
  assert.ok(Math.abs(out.maxDriftSec - 1) < 1e-6);
  assert.ok(out.samples.length >= 6 * sr);
});

test('placeSegments: segments borrow silence from the following gap without drifting', () => {
  const sr = 24000;
  const out = placeSegments([
    { slotStart: 0, slotEnd: 2, samples: tone(3) },
    { slotStart: 5, slotEnd: 7, samples: tone(2) },
  ], sr, 7);
  assert.equal(out.maxDriftSec, 0);
});

test('placeSegments: empty input yields silence of the source length', () => {
  const out = placeSegments([], 24000, 3);
  assert.equal(out.samples.length, 72000);
});

// ---------------------------------------------------------------- subtitles

test('toSrt formats cues with comma millis and skips empty text', () => {
  const srt = toSrt([
    { start: 0, end: 2.5, text: 'Hola.' },
    { start: 3661.007, end: 3662, text: 'Adios.' },
    { start: 4, end: 5, text: '' },
  ]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:02,500\nHola.\n\n2\n01:01:01,007 --> 01:01:02,000\nAdios.\n');
});

test('toVtt has the WEBVTT header and dot millis', () => {
  const vtt = toVtt([{ start: 1, end: 2, text: 'Bonjour.' }]);
  assert.equal(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour.\n');
});

test('subtitle text cannot inject cue structure via blank lines or arrows', () => {
  const srt = toSrt([{ start: 0, end: 1, text: 'a\n\n2\n00:00:00,000 --> 00:00:01,000\nb' }]);
  assert.ok(!/\n\n2\n/.test(srt));
});
