import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linearToMuLawSample, muLawToPcm16, pcm16ToMuLaw, resamplePcm16,
  chunkToTwilioFrames, piperPcm24kToTwilioMuLaw, TWILIO_FRAME_BYTES,
} from '../src/audio.js';

test('mu-law <-> pcm16 round trip stays close (lossy codec, small quantization error expected)', () => {
  const original = new Int16Array([0, 1000, -1000, 16000, -16000, 32000, -32000]);
  const encoded = pcm16ToMuLaw(original);
  const decoded = muLawToPcm16(encoded);
  for (let i = 0; i < original.length; i++) {
    const err = Math.abs(decoded[i] - original[i]);
    assert.ok(err < 700, `sample ${i}: ${original[i]} -> ${decoded[i]} (err ${err})`);
  }
});

test('linearToMuLawSample clips at CLIP and stays in a byte', () => {
  const v = linearToMuLawSample(100000);
  assert.ok(v >= 0 && v <= 255);
});

test('resamplePcm16 24k->8k gives exactly 1/3 the samples (exact ratio)', () => {
  const input = new Int16Array(2400).fill(500);
  const out = resamplePcm16(input, 24000, 8000);
  assert.equal(out.length, 800);
});

test('resamplePcm16 is a no-op when rates match', () => {
  const input = new Int16Array([1, 2, 3]);
  assert.equal(resamplePcm16(input, 8000, 8000), input);
});

test('chunkToTwilioFrames splits into 160-byte (20ms@8kHz mu-law) frames, last frame may be short', () => {
  const buf = Buffer.alloc(160 * 3 + 40, 7);
  const frames = [...chunkToTwilioFrames(buf)];
  assert.equal(frames.length, 4);
  assert.equal(frames[0].length, TWILIO_FRAME_BYTES);
  assert.equal(frames[1].length, TWILIO_FRAME_BYTES);
  assert.equal(frames[2].length, TWILIO_FRAME_BYTES);
  assert.equal(frames[3].length, 40);
});

test('piperPcm24kToTwilioMuLaw: 24kHz PCM16 buffer of N samples -> N/3 mu-law bytes', () => {
  const n = 2400; // 100ms @ 24kHz
  const pcm = Buffer.alloc(n * 2);
  const muLaw = piperPcm24kToTwilioMuLaw(pcm);
  assert.equal(muLaw.length, n / 3);
});
