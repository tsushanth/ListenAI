import test from 'node:test';
import assert from 'node:assert/strict';
import { probeAudioDurationSec } from './audioProbe.js';
import { encodeWavPcm16 } from './dubTiming.js';

test('probeAudioDurationSec reads WAV duration from the header (no ffprobe needed)', async () => {
  const wav = encodeWavPcm16(new Int16Array(16000 * 3), 16000);
  assert.ok(Math.abs((await probeAudioDurationSec(wav, 'audio/wav'))! - 3) < 1e-3);
});

test('probeAudioDurationSec returns null (never throws) for garbage when ffprobe cannot parse it', async () => {
  assert.equal(await probeAudioDurationSec(Buffer.from('definitely not audio'), 'audio/mpeg'), null);
});
