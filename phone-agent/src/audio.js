// Audio format conversion between Twilio Media Streams (G.711 mu-law, 8kHz,
// 20ms/160-byte frames, base64-in-JSON) and the two internal pipeline legs:
//   - worker-stt-realtime (realtime-tts repo): accepts PCM16LE or mu-law,
//     8kHz or 16kHz, negotiated via a {"type":"config"} frame. We ask for
//     mulaw/8000 so Twilio audio passes straight through with no resample
//     (worker-stt-realtime decodes mu-law itself — see its Up2 upsampler).
//   - worker-piper-fly (realtime-tts repo): always emits PCM16LE mono
//     24kHz binary frames after each {"type":"chunk_meta"}. There is no
//     "give me mu-law" request path on that server today (only the HTTP
//     /v1/tts/stream endpoint supports `format`), so this module downsamples
//     24kHz -> 8kHz and mu-law-encodes for the Twilio leg.
//
// Reference: realtime-tts/call-loop-poc/twilioAdapter.js does the same two
// conversions for its own (Deepgram/Kokoro) pipeline; the mu-law codec and
// framing here are re-implemented rather than imported so this package has
// no dependency on that sibling repo (constraint: read-only reference).

const BIAS = 0x84;
const CLIP = 32635;

/** One 20ms frame at 8kHz mu-law, Twilio's own outbound frame size. */
export const TWILIO_FRAME_BYTES = 160;
export const TWILIO_FRAME_MS = 20;

export function linearToMuLawSample(sample) {
  let sign = 0;
  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Precomputed mu-law -> linear PCM16 table (standard G.711 decode).
const MULAW_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let magnitude = ((mantissa << 3) + BIAS) << exponent;
    magnitude -= BIAS;
    table[i] = sign ? -magnitude : magnitude;
  }
  return table;
})();

/** Buffer of mu-law bytes -> Int16Array PCM16LE samples. */
export function muLawToPcm16(muLawBuf) {
  const out = new Int16Array(muLawBuf.length);
  for (let i = 0; i < muLawBuf.length; i++) out[i] = MULAW_DECODE_TABLE[muLawBuf[i]];
  return out;
}

/** Int16Array PCM16LE samples -> Buffer of mu-law bytes. */
export function pcm16ToMuLaw(int16) {
  const out = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = linearToMuLawSample(int16[i]);
  return out;
}

/**
 * Naive nearest-neighbor resample of PCM16 samples between rates. Adequate
 * for speech at these ratios (24000/8000 = 3:1 exactly); not broadcast
 * quality. Matches the approach already used elsewhere in this codebase
 * (realtime-tts/call-loop-poc/twilioAdapter.js resampleInt16) so behavior
 * here is a known quantity, not a new unverified DSP path.
 */
export function resamplePcm16(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}

/** Twilio media-stream payload (base64 mu-law@8kHz) -> raw mu-law Buffer. */
export function decodeTwilioMediaPayload(base64Payload) {
  return Buffer.from(base64Payload, 'base64');
}

/** Raw mu-law Buffer -> base64 string ready for a Twilio {event:"media"} frame. */
export function encodeTwilioMediaPayload(muLawBuf) {
  return muLawBuf.toString('base64');
}

/** Split a mu-law buffer into Twilio's fixed 160-byte (20ms) frames. */
export function* chunkToTwilioFrames(muLawBuf) {
  for (let i = 0; i < muLawBuf.length; i += TWILIO_FRAME_BYTES) {
    yield muLawBuf.subarray(i, i + TWILIO_FRAME_BYTES);
  }
}

/** worker-piper-fly's PCM16LE@24kHz binary chunk -> mu-law@8kHz for Twilio. */
export function piperPcm24kToTwilioMuLaw(pcmBuf) {
  const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2);
  const down = resamplePcm16(int16, 24000, 8000);
  return pcm16ToMuLaw(down);
}
