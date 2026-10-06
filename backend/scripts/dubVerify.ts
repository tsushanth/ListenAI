// Verification harness for the dubbing fixes: replays the S3 kit's stored STT segments + translations through the
// PRODUCTION fit/place code (src/lib/dubPipeline.ts) against a live TTS endpoint, writing one WAV + one metadata JSON
// per (clip, language, variant). Scoring (ASR WER, back-translation) happens elsewhere.
//
//   npx tsx scripts/dubVerify.ts prep   --data <S3 data dir> --out inputs.json
//   (--bearer <secret> adds an Authorization header, for the dedicated dub_piper.py function)
//   npx tsx scripts/dubVerify.ts run    --data <S3 data dir> --tts <base url> --variant K|P1|P2 --langs es,fr,hi --out <dir> [--budget-translations file.json]
//
// Variants: K = replica of the kit's arm C (raw segments, speed clamp 0.5-2.0, always one refit, no hallucination
// filter) so the harness can be checked against the S3 numbers; P1 = production pipeline on the S3 translations;
// P2 = production pipeline on length-budgeted translations.
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeSegments, lengthBudget, type SanitizedSegment } from '../src/lib/dubTiming.js';
import { fitAndPlace } from '../src/lib/dubPipeline.js';
import { resolveDubLanguage } from '../src/lib/dubLanguages.js';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1]! : d; };

interface Stt { res: Record<string, { dur: number; segments: Array<{ start: number; end: number; text: string }> }> }
const dataDir = opt('data')!;
const stt = JSON.parse(fs.readFileSync(path.join(dataDir, 'stt_segments.json'), 'utf8')) as Stt;
const trans = JSON.parse(fs.readFileSync(path.join(dataDir, 'translations.json'), 'utf8')) as Record<string, Record<string, string[]>>;

function kept(clip: string): SanitizedSegment[] {
  const c = stt.res[clip]!;
  return sanitizeSegments(c.segments, c.dur).kept;
}

if (cmd === 'prep') {
  const out: Record<string, unknown> = {};
  for (const clip of Object.keys(stt.res)) {
    const c = stt.res[clip]!;
    const s = sanitizeSegments(c.segments, c.dur);
    out[clip] = {
      dur: c.dur,
      raw_segments: c.segments.length,
      dropped: s.dropped.map((d) => ({ ...d, text: c.segments[d.index]!.text.slice(0, 60) })),
      segments: s.kept.map((k) => ({
        text: k.text,
        slot_sec: +(k.end - k.start).toFixed(2),
        source_indexes: k.sourceIndexes,
        budget_es: lengthBudget(k.end - k.start, 'es'),
        budget_fr: lengthBudget(k.end - k.start, 'fr'),
        budget_hi: lengthBudget(k.end - k.start, 'hi'),
      })),
    };
  }
  fs.writeFileSync(opt('out', 'inputs.json')!, JSON.stringify(out, null, 1));
  console.log('wrote', opt('out', 'inputs.json'));
} else if (cmd === 'run') {
  void (async () => {
  const tts = opt('tts')!.replace(/\/$/, '');
  const variant = opt('variant', 'P1')!;
  const langs = (opt('langs', 'es,fr') as string).split(',');
  const outDir = opt('out', 'out')!;
  const budgetFile = opt('budget-translations');
  const budget = budgetFile ? (JSON.parse(fs.readFileSync(budgetFile, 'utf8')) as Record<string, Record<string, string[]>>) : null;
  fs.mkdirSync(outDir, { recursive: true });
  const engine = opt('engine', 'kokoro')!;
  const VOICE: Record<string, string> = engine === 'piper'
    ? { es: opt('es-voice', 'es-pilot-m')!, fr: opt('fr-voice', 'fr-fr-mls-m')! }
    : { es: 'em_alex', fr: 'ff_siwis', hi: 'hm_omega' };
  const tagName = opt('tag', variant)!;
  let serverSynthMs = 0;
  let ttsCallsTotal = 0;

  const synthFor = (lang: string) => async (text: string, voiceId: string, speed: number): Promise<Buffer> => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await fetch(`${tts}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opt('bearer') ? { Authorization: `Bearer ${opt('bearer')}` } : {}) },
        body: JSON.stringify({ text, voice_id: voiceId, language: lang, speed, model: 'kokoro' }),
        signal: AbortSignal.timeout(180_000),
      });
      if (r.ok) { serverSynthMs += Number(r.headers.get('x-synthesis-time-ms') ?? 0); ttsCallsTotal++; return Buffer.from(await r.arrayBuffer()); }
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
    throw new Error('TTS failed after retries');
  };

  const t0 = Date.now();
  for (const clip of Object.keys(stt.res)) {
    for (const lang of langs) {
      const tag = `${clip}__${lang}_${tagName}`;
      if (fs.existsSync(path.join(outDir, `${tag}.json`))) { console.log(tag, 'exists, skipping'); continue; } // resumable
      const c = stt.res[clip]!;
      const l = resolveDubLanguage(lang)!;
      let segs: Array<{ start: number; end: number; text: string; sourceIndexes: number[] }>;
      let texts: string[];
      let fitOpts: Record<string, number> = {};
      if (variant === 'K') {
        segs = c.segments.map((s, i) => ({ ...s, sourceIndexes: [i] }));
        texts = trans[clip]![lang]!;
        fitOpts = { minSpeed: 0.5, maxSpeed: 2.0, tolerance: 0, extraRefits: 0 };
      } else {
        const k = kept(clip);
        segs = k;
        if (variant === 'P1') {
          texts = k.map((s) => s.sourceIndexes.map((i) => trans[clip]![lang]![i]!).join(' ').trim());
        } else {
          const b = budget?.[clip]?.[lang];
          if (!b || b.length !== k.length) throw new Error(`budget translations missing/mismatched for ${clip} ${lang}: ${b?.length} vs ${k.length}`);
          texts = b;
        }
      }
      const voice = VOICE[l.code]!;
      const tStart = Date.now();
      const synthMs0 = serverSynthMs;
      const calls0 = ttsCallsTotal;
      const r = await fitAndPlace({
        segments: segs.map((s, i) => ({ index: i, slotStart: s.start, slotEnd: s.end, text: texts[i] ?? '', voiceId: voice })),
        synth: synthFor(l.code),
        sourceDurationSec: c.dur,
        concurrency: 3,
        trimSilence: l.engine === 'piper' && engine === 'piper',
        minSpeed: l.speedRange.min,
        maxSpeed: l.speedRange.max,
        ...fitOpts,
      });
      fs.writeFileSync(path.join(outDir, `${tag}.wav`), r.wav);
      fs.writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify({
        clip, lang, variant: tagName, voice, srcDur: c.dur, wallSec: (Date.now() - tStart) / 1000, serverSynthSec: (serverSynthMs - synthMs0) / 1000, ttsCalls: ttsCallsTotal - calls0, outDur: r.durationSec, maxDriftSec: r.maxDriftSec,
        intended: texts.filter((t) => t.trim()).join(' '),
        segments: r.segments.map((s, i) => ({
          ...s, text: texts[i], chars: (texts[i] ?? '').length, budget_max: lengthBudget(s.slotEnd - s.slotStart, l.code).maxChars,
        })),
      }));
      console.log(tag, 'segs', segs.length, 'out', r.durationSec.toFixed(1), 'drift', r.maxDriftSec.toFixed(2), 't+', ((Date.now() - t0) / 1000).toFixed(0));
    }
  }
  })().catch((e) => { console.error(e); process.exit(1); });
}
