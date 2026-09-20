// Wrap raw PCM16 little-endian mono audio in a 44-byte WAV (RIFF) header.
export const SAMPLE_RATE = 24000
export const BYTES_PER_SAMPLE = 2

export function pcmDurationSeconds(pcmBytes: number, sampleRate = SAMPLE_RATE): number {
  return pcmBytes / (sampleRate * BYTES_PER_SAMPLE)
}

export function pcm16ToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28) // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// Used by tests and the integration script to check what we return.
export function parseWav(buf: Uint8Array) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file')
  }
  const sampleRate = b.readUInt32LE(24)
  const channels = b.readUInt16LE(22)
  const bits = b.readUInt16LE(34)
  const dataBytes = b.readUInt32LE(40)
  if (dataBytes !== b.length - 44) throw new Error('data chunk size does not match file length')
  return { sampleRate, channels, bits, dataBytes, seconds: dataBytes / (sampleRate * channels * (bits / 8)) }
}
