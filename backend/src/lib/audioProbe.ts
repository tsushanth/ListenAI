// Independent source-audio duration. The STT worker's own segment ends cannot be trusted for this: Whisper
// emitted a "Thank you." segment spanning 75-105 s on a 75 s clip (S3, c7), and a duration derived from the
// last segment end would also bill the user for the hallucinated 30 s.

import { spawn } from 'node:child_process';
import { wavDurationSec } from './dubTiming.js';

export async function probeAudioDurationSec(buf: Buffer, mimetype: string): Promise<number | null> {
  if (/wav|wave/i.test(mimetype) || (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF')) {
    const d = wavDurationSec(buf);
    if (d && d > 0) return d;
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | null) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-i', 'pipe:0'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => { p.kill('SIGKILL'); done(null); }, 15_000);
      p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      p.on('error', () => { clearTimeout(timer); done(null); });
      p.on('close', () => {
        clearTimeout(timer);
        const v = parseFloat(out.trim().split('\n')[0] ?? '');
        done(Number.isFinite(v) && v > 0 ? v : null);
      });
      p.stdin.on('error', () => { /* ffprobe closing stdin early is normal */ });
      p.stdin.end(buf);
    } catch {
      done(null);
    }
  });
}
