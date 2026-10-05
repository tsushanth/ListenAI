// Upload handling for the STT routes: temp-file lifecycle, magic-byte sniffing, and streaming a temp file to
// the worker. Nothing here buffers a whole upload in memory, and nothing trusts a client-supplied MIME type
// or file name.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface SniffResult { mime: string; container: string }

const ascii = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString('latin1');

/**
 * Identify an audio container from its first bytes. Returns null for anything unrecognised or malformed
 * (including RIFF files that are not WAVE or have no `fmt ` chunk, and non-audio formats such as PNG/HTML/ZIP).
 * The returned mime is OUR canonical mime for that container and is what gets forwarded to the worker.
 */
export function sniffAudio(head: Buffer): SniffResult | null {
  if (head.length < 12) return null;
  if (ascii(head, 0, 4) === 'RIFF') {
    if (ascii(head, 8, 12) === 'WAVE' && ascii(head, 12, 16) === 'fmt ') return { mime: 'audio/wav', container: 'wav' };
    return null;
  }
  if (ascii(head, 0, 4) === 'fLaC') return { mime: 'audio/flac', container: 'flac' };
  if (ascii(head, 0, 4) === 'OggS') return { mime: 'audio/ogg', container: 'ogg' };
  if (ascii(head, 0, 3) === 'ID3') return { mime: 'audio/mpeg', container: 'mp3' };
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return { mime: 'audio/mpeg', container: 'mp3' }; // MPEG/ADTS frame sync
  if (ascii(head, 4, 8) === 'ftyp') return { mime: 'audio/mp4', container: 'mp4' };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { mime: 'audio/webm', container: 'webm' };
  return null;
}

export async function sniffFile(file: string): Promise<SniffResult | null> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    return sniffAudio(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export function sttTmpDir(configured?: string): string {
  const d = configured || path.join(os.tmpdir(), 'stt-uploads');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function tmpPath(dir: string): string {
  return path.join(dir, `${crypto.randomUUID()}.upload`);
}

export async function removeQuiet(file: string | undefined): Promise<void> {
  if (!file) return;
  await fsp.rm(file, { force: true }).catch(() => undefined);
}

export class UploadTooLargeError extends Error {
  constructor(public maxBytes: number) { super(`Upload exceeds ${maxBytes} bytes`); }
}

/** Stream a request body into `file`, aborting (and deleting the partial file) the moment `maxBytes` is exceeded. */
export async function streamToFile(src: Readable, file: string, maxBytes: number): Promise<number> {
  let n = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > maxBytes) { cb(new UploadTooLargeError(maxBytes)); return; }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(src, counter, fs.createWriteStream(file, { mode: 0o600 }));
  } catch (err) {
    await removeQuiet(file);
    throw err;
  }
  return n;
}

/** fetch() init fragment that streams `file` as the request body (never loaded into memory). */
export function workerBody(file: string, size: number, mime: string): { body: ReadableStream; duplex: 'half'; headers: Record<string, string> } {
  return {
    body: Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream,
    duplex: 'half',
    headers: { 'Content-Type': mime, 'Content-Length': String(size) },
  };
}
