// npm test (node:test via tsx). Unit tests for routes/audiobooks.ts.
// All Supabase REST calls are intercepted via a patched global.fetch (same
// convention as routes/voiceDesign.test.ts) — no real database, no real
// ffmpeg process, no real Anthropic call. child_process.spawn is mocked via
// node:test's module mocking (--experimental-test-module-mocks) so the
// export test never shells out to a real `ffmpeg` binary.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import AdmZip from 'adm-zip';
import { EventEmitter } from 'node:events';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
process.env.GATEWAY_FORWARD_SECRET ??= 'gw-forward-secret';

const SUPABASE_URL = process.env.SUPABASE_URL;
const GATEWAY_FORWARD_SECRET = process.env.GATEWAY_FORWARD_SECRET;

// ---------------------------------------------------------------------------
// child_process.spawn mock — the export route's ffmpeg invocation is asserted
// on argument construction only; no real ffmpeg ever runs.
// ---------------------------------------------------------------------------

interface SpawnCall { command: string; args: string[] }
const spawnCalls: SpawnCall[] = [];
let spawnExitCode = 0;

class FakeChildProcess extends EventEmitter {
  stderr = new EventEmitter();
}

mock.module('node:child_process', {
  namedExports: {
    spawn: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const proc = new FakeChildProcess();
      queueMicrotask(async () => {
        // On a "successful" run, the route reads the output file back
        // (to upload it) after this process exits — a real ffmpeg would
        // have written real bytes there, so the fake one must too, or
        // that read 404s with ENOENT even though the invocation itself
        // was correct. The output path is always ffmpeg's last arg here.
        if (spawnExitCode === 0) {
          const outputPath = args[args.length - 1];
          if (outputPath) {
            const fs = await import('node:fs/promises');
            await fs.writeFile(outputPath, Buffer.from('fake-mp3-bytes'));
          }
        }
        proc.emit('close', spawnExitCode);
      });
      return proc;
    },
  },
});

// ---------------------------------------------------------------------------
// Supabase REST mock — a tiny in-memory store keyed the same way
// audiobooks.ts's own queries key their reads.
// ---------------------------------------------------------------------------

interface StoredAudiobook {
  id: string;
  user_id: string;
  title: string;
  voice_id: string;
  speed: number;
  source_type: 'text' | 'epub';
  status: string;
  chapter_count: number;
  export_status: string;
  export_audio_path: string | null;
  export_duration_sec: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface StoredChapter {
  id: string;
  audiobook_id: string;
  sequence: number;
  title: string | null;
  text_content: string;
  char_count: number;
  tts_job_id: string | null;
  status: string;
  audio_path: string | null;
  duration_seconds: number | null;
  error_message: string | null;
}

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

const audiobooks = new Map<string, StoredAudiobook>();
const chaptersByAudiobook = new Map<string, StoredChapter[]>();
const ttsJobStatuses = new Map<string, { status: string; audio_path?: string; full_audio_path?: string; duration_sec?: number; error_message?: string; chunks_total?: number; chunks_completed?: number }>();
let createTTSJobShouldFail = false;

function resetStore() {
  audiobooks.clear();
  chaptersByAudiobook.clear();
  ttsJobStatuses.clear();
  spawnCalls.length = 0;
  spawnExitCode = 0;
  createTTSJobShouldFail = false;
  nextId = 1;
}

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  const method = init?.method ?? 'GET';
  // init.headers may be a Headers instance (undici does this internally for
  // supabase-js's calls) rather than a plain object — go through Headers to
  // read it correctly either way.
  const wantsSingle = new Headers(init?.headers).get('accept') === 'application/vnd.pgrst.object+json';
  // Storage uploads (routes/audiobooks.ts's uploadAudioFromFile) send a raw
  // audio Buffer as the body, not JSON — parsing that unconditionally throws
  // before the request is even routed below, which storage-js then reports
  // as an opaque upload failure. Only REST table/RPC calls need `body`
  // parsed, so fall back to undefined for anything that isn't valid JSON.
  let body: any;
  if (init?.body) {
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = undefined;
    }
  }

  if (!url.startsWith(`${SUPABASE_URL}/rest/v1/`) && !url.startsWith(`${SUPABASE_URL}/storage/v1/`)) {
    return originalFetch(input, init);
  }

  const restPath = url.replace(`${SUPABASE_URL}/rest/v1/`, '');

  // ---- RPC: create_tts_job -------------------------------------------------
  if (restPath.startsWith('rpc/create_tts_job') && method === 'POST') {
    if (createTTSJobShouldFail) {
      return jsonResponse({ message: 'simulated createTTSJob failure' }, 500);
    }
    const jobId = genId('job');
    ttsJobStatuses.set(jobId, { status: 'queued' });
    return jsonResponse(jobId);
  }

  // ---- RPC: get_tts_job -----------------------------------------------------
  if (restPath.startsWith('rpc/get_tts_job') && method === 'POST') {
    const jobId = body?.p_job_id as string;
    const job = ttsJobStatuses.get(jobId);
    if (!job) return jsonResponse([]);
    return jsonResponse([
      {
        id: jobId,
        status: job.status,
        audio_path: job.audio_path ?? null,
        full_audio_path: job.full_audio_path ?? null,
        duration_sec: job.duration_sec ?? null,
        error_message: job.error_message ?? null,
        chunks_total: job.chunks_total ?? null,
        chunks_completed: job.chunks_completed ?? 0,
      },
    ]);
  }

  // ---- audiobooks table -----------------------------------------------------
  if (restPath.startsWith('audiobooks') && !restPath.startsWith('audiobook_chapters')) {
    if (method === 'POST') {
      const row: StoredAudiobook = {
        id: genId('audiobook'),
        user_id: body.user_id,
        title: body.title,
        voice_id: body.voice_id,
        speed: body.speed,
        source_type: body.source_type,
        status: body.status,
        chapter_count: body.chapter_count,
        export_status: 'not_started',
        export_audio_path: null,
        export_duration_sec: null,
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      audiobooks.set(row.id, row);
      return jsonResponse(wantsSingle ? row : [row]);
    }
    if (method === 'PATCH') {
      const idMatch = restPath.match(/id=eq\.([^&]+)/);
      const id = idMatch?.[1];
      const row = id ? audiobooks.get(id) : undefined;
      if (row) Object.assign(row, body);
      return jsonResponse(row ? [row] : []);
    }
    if (method === 'GET') {
      const idMatch = restPath.match(/id=eq\.([^&]+)/);
      const userIdMatch = restPath.match(/user_id=eq\.([^&]+)/);
      const id = idMatch?.[1];
      const requestedUserId = userIdMatch?.[1] ? decodeURIComponent(userIdMatch[1]) : undefined;
      let row = id ? audiobooks.get(id) : undefined;
      // The real query filters by .eq('user_id', userId) too — a row that
      // exists but belongs to someone else must miss here, same as a real
      // Postgres row-owner mismatch would, so ownership tests are real.
      if (row && requestedUserId && row.user_id !== requestedUserId) row = undefined;
      if (!row) return jsonResponse(wantsSingle ? { message: 'not found' } : [], wantsSingle ? 406 : 200);
      return jsonResponse(wantsSingle ? row : [row]);
    }
  }

  // ---- audiobook_chapters table ----------------------------------------------
  if (restPath.startsWith('audiobook_chapters')) {
    if (method === 'POST') {
      const inserts = Array.isArray(body) ? body : [body];
      const rows: StoredChapter[] = inserts.map((c: Partial<StoredChapter>) => ({
        id: genId('chapter'),
        audiobook_id: c.audiobook_id as string,
        sequence: c.sequence as number,
        title: c.title ?? null,
        text_content: c.text_content as string,
        char_count: c.char_count as number,
        tts_job_id: null,
        status: (c.status as string) ?? 'pending',
        audio_path: null,
        duration_seconds: null,
        error_message: null,
      }));
      const audiobookId = rows[0]?.audiobook_id;
      if (audiobookId) chaptersByAudiobook.set(audiobookId, rows);
      return jsonResponse(rows);
    }
    if (method === 'PATCH') {
      const idMatch = restPath.match(/id=eq\.([^&]+)/);
      const id = idMatch?.[1];
      for (const rows of chaptersByAudiobook.values()) {
        const row = rows.find((r) => r.id === id);
        if (row) {
          Object.assign(row, body);
          return jsonResponse([row]);
        }
      }
      return jsonResponse([]);
    }
    if (method === 'GET') {
      const idMatch = restPath.match(/audiobook_id=eq\.([^&]+)/);
      const id = idMatch?.[1];
      const rows = (id ? chaptersByAudiobook.get(id) : undefined) ?? [];
      return jsonResponse([...rows].sort((a, b) => a.sequence - b.sequence));
    }
  }

  // ---- storage: download chapter audio for export ----------------------------
  if (url.includes('/storage/v1/object/') && method === 'GET') {
    return new Response(Buffer.from('fake-mp3-bytes'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  }
  if (url.includes('/storage/v1/object/') && method === 'POST') {
    return jsonResponse({ Key: 'ok' });
  }
  if (url.includes('/storage/v1/object/sign/')) {
    return jsonResponse({ signedURL: '/signed/path' });
  }

  return jsonResponse([]);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// ePub fixture builder (same shape as chapterDetection.test.ts's)
// ---------------------------------------------------------------------------

function buildEpub(chapters: Array<{ href: string; navTitle: string; text: string }>): string {
  const zip = new AdmZip();
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, 'utf8')
  );
  const manifestItems = chapters.map((c, i) => `<item id="ch${i}" href="${c.href}" media-type="application/xhtml+xml"/>`).join('\n');
  const spineItems = chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join('\n');
  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(
      `<?xml version="1.0"?><package><manifest>${manifestItems}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>${spineItems}</spine></package>`,
      'utf8'
    )
  );
  const navLinks = chapters.map((c) => `<li><a href="${c.href}">${c.navTitle}</a></li>`).join('\n');
  zip.addFile(
    'OEBPS/nav.xhtml',
    Buffer.from(`<?xml version="1.0"?><html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${navLinks}</ol></nav></body></html>`, 'utf8')
  );
  for (const c of chapters) {
    zip.addFile(`OEBPS/${c.href}`, Buffer.from(`<html><body><p>${c.text}</p></body></html>`, 'utf8'));
  }
  return zip.toBuffer().toString('base64');
}

// A user id middleware/auth.ts's getUserTier special-cases as 'unlimited',
// so tests don't need to mock a subscriptions lookup too.
const UNLIMITED_USER_ID = '00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

async function boot() {
  const { requireAuthOrApiKey } = await import('../middleware/apiKeyAuth.js');
  const { errorHandler } = await import('../middleware/errorHandler.js');
  const { audiobooksRouter } = await import('./audiobooks.js');

  const app = express();
  app.use(express.json());
  app.use('/api/audiobooks', requireAuthOrApiKey, audiobooksRouter);
  app.use(errorHandler);

  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/audiobooks`;

  const call = (auth: 'gateway' | 'none' | { badSecret: true }, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = body ? { 'Content-Type': 'application/json' } : {};
    if (auth === 'gateway') {
      headers['x-gateway-admin-secret'] = GATEWAY_FORWARD_SECRET as string;
      headers['x-gateway-uid'] = UNLIMITED_USER_ID;
    } else if (typeof auth === 'object' && auth.badSecret) {
      headers['x-gateway-admin-secret'] = 'wrong-secret';
      headers['x-gateway-uid'] = UNLIMITED_USER_ID;
    }
    return fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  };

  const close = () => {
    // server.close() alone only stops accepting new connections and waits
    // for existing ones to end on their own — fetch's keep-alive sockets
    // never do, so without this every boot() leaves a socket open and the
    // process hangs after the last test instead of exiting.
    server.closeAllConnections();
    server.close();
  };

  return { call, close };
}

test.beforeEach(() => {
  resetStore();
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

test('POST /api/audiobooks: no credentials -> 401, never reaches the route', async () => {
  const s = await boot();
  const r = await s.call('none', 'POST', '', { title: 'x', voice_id: 'am_adam', text: 'hello' });
  assert.equal(r.status, 401);
  assert.equal(audiobooks.size, 0);
  s.close();
});

test('POST /api/audiobooks: wrong gateway-forward secret -> 401', async () => {
  const s = await boot();
  const r = await s.call({ badSecret: true }, 'POST', '', { title: 'x', voice_id: 'am_adam', text: 'hello' });
  assert.equal(r.status, 401);
  s.close();
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test('POST /api/audiobooks: missing required fields -> 400 VALIDATION_ERROR', async () => {
  const s = await boot();
  const r = await s.call('gateway', 'POST', '', { title: 'x' }); // no voice_id, no text
  assert.equal(r.status, 400);
  const json = await r.json();
  assert.equal(json.error, 'VALIDATION_ERROR');
  s.close();
});

test('POST /api/audiobooks: source_type "epub" without epub_base64 -> 400', async () => {
  const s = await boot();
  const r = await s.call('gateway', 'POST', '', { title: 'x', voice_id: 'am_adam', source_type: 'epub' });
  assert.equal(r.status, 400);
  s.close();
});

test('POST /api/audiobooks: source_type "text" without text -> 400', async () => {
  const s = await boot();
  const r = await s.call('gateway', 'POST', '', { title: 'x', voice_id: 'am_adam', source_type: 'text' });
  assert.equal(r.status, 400);
  s.close();
});

// ---------------------------------------------------------------------------
// Chapter fan-out orchestration
// ---------------------------------------------------------------------------

test('POST /api/audiobooks: short plain text creates one chapter and one TTS job', async () => {
  const s = await boot();
  const r = await s.call('gateway', 'POST', '', {
    title: 'My Short Book',
    voice_id: 'am_adam',
    text: 'A short piece of text.',
  });

  assert.equal(r.status, 202);
  const json = await r.json();
  assert.equal(json.chapter_count, 1);
  assert.equal(json.status, 'processing');

  const stored = audiobooks.get(json.audiobook_id);
  assert.ok(stored);
  assert.equal(stored?.status, 'processing');
  assert.equal(ttsJobStatuses.size, 1);
  s.close();
});

test('POST /api/audiobooks: epub with N chapters fans out N TTS jobs, one per chapter', async () => {
  const s = await boot();
  const epub_base64 = buildEpub([
    { href: 'ch0.xhtml', navTitle: 'Chapter One', text: 'a'.repeat(300) },
    { href: 'ch1.xhtml', navTitle: 'Chapter Two', text: 'b'.repeat(300) },
    { href: 'ch2.xhtml', navTitle: 'Chapter Three', text: 'c'.repeat(300) },
  ]);

  const r = await s.call('gateway', 'POST', '', {
    title: 'My Epub Book',
    voice_id: 'am_adam',
    source_type: 'epub',
    epub_base64,
  });

  assert.equal(r.status, 202);
  const json = await r.json();
  assert.equal(json.chapter_count, 3);
  assert.deepEqual(
    json.chapters.map((c: { title: string }) => c.title),
    ['Chapter One', 'Chapter Two', 'Chapter Three']
  );

  assert.equal(ttsJobStatuses.size, 3);
  const chapters = chaptersByAudiobook.get(json.audiobook_id) ?? [];
  assert.equal(chapters.length, 3);
  for (const chapter of chapters) {
    assert.equal(chapter.status, 'queued');
    assert.ok(chapter.tts_job_id);
  }
  s.close();
});

test('POST /api/audiobooks: a per-chapter TTS job failure marks that chapter failed but does not abort the others', async () => {
  const s = await boot();
  const epub_base64 = buildEpub([
    { href: 'ch0.xhtml', navTitle: 'Chapter One', text: 'a'.repeat(300) },
    { href: 'ch1.xhtml', navTitle: 'Chapter Two', text: 'b'.repeat(300) },
  ]);

  createTTSJobShouldFail = true;

  const r = await s.call('gateway', 'POST', '', {
    title: 'Flaky Book',
    voice_id: 'am_adam',
    source_type: 'epub',
    epub_base64,
  });

  assert.equal(r.status, 202);
  const json = await r.json();
  assert.equal(json.status, 'failed');

  const stored = audiobooks.get(json.audiobook_id);
  assert.equal(stored?.status, 'failed');
  const chapters = chaptersByAudiobook.get(json.audiobook_id) ?? [];
  assert.ok(chapters.every((c) => c.status === 'failed'));
  s.close();
});

// ---------------------------------------------------------------------------
// GET /:id/status
// ---------------------------------------------------------------------------

test('GET /api/audiobooks/:id/status: 404 for another user’s audiobook', async () => {
  const s = await boot();
  audiobooks.set('audiobook-999', {
    id: 'audiobook-999',
    user_id: 'someone-else',
    title: 'Not yours',
    voice_id: 'am_adam',
    speed: 1,
    source_type: 'text',
    status: 'processing',
    chapter_count: 1,
    export_status: 'not_started',
    export_audio_path: null,
    export_duration_sec: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  chaptersByAudiobook.set('audiobook-999', []);

  const r = await s.call('gateway', 'GET', '/audiobook-999/status');
  assert.equal(r.status, 404);
  s.close();
});

test('GET /api/audiobooks/:id/status: rolls up chapter statuses into an overall status', async () => {
  const s = await boot();
  const createRes = await s.call('gateway', 'POST', '', { title: 'Status Book', voice_id: 'am_adam', text: 'short text here' });
  const created = await createRes.json();

  // Flip the (single) chapter's underlying TTS job to ready, as the worker would.
  const chapters = chaptersByAudiobook.get(created.audiobook_id) ?? [];
  const jobId = chapters[0]?.tts_job_id as string;
  ttsJobStatuses.set(jobId, { status: 'ready', audio_path: 'audiobooks/x/ch0.mp3', duration_sec: 42 });

  const r = await s.call('gateway', 'GET', `/${created.audiobook_id}/status`);
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.status, 'completed');
  assert.equal(json.chapters_completed, 1);
  assert.equal(json.overall_percentage, 100);
  s.close();
});

// ---------------------------------------------------------------------------
// POST /:id/export — argument construction only, ffmpeg itself is mocked
// ---------------------------------------------------------------------------

test('POST /api/audiobooks/:id/export: 400 when a chapter is not ready', async () => {
  const s = await boot();
  const createRes = await s.call('gateway', 'POST', '', { title: 'Export Book', voice_id: 'am_adam', text: 'short text here' });
  const created = await createRes.json();

  const r = await s.call('gateway', 'POST', `/${created.audiobook_id}/export`);
  assert.equal(r.status, 400);
  assert.equal(spawnCalls.length, 0);
  s.close();
});

test('POST /api/audiobooks/:id/export: builds the expected ffmpeg concat+chapters invocation and never runs a real process', async () => {
  const s = await boot();
  const epub_base64 = buildEpub([
    { href: 'ch0.xhtml', navTitle: 'Chapter One', text: 'a'.repeat(300) },
    { href: 'ch1.xhtml', navTitle: 'Chapter Two', text: 'b'.repeat(300) },
  ]);
  const createRes = await s.call('gateway', 'POST', '', { title: 'Export Book', voice_id: 'am_adam', source_type: 'epub', epub_base64 });
  const created = await createRes.json();

  const chapters = chaptersByAudiobook.get(created.audiobook_id) ?? [];
  for (const chapter of chapters) {
    ttsJobStatuses.set(chapter.tts_job_id as string, { status: 'ready', audio_path: `audiobooks/x/ch${chapter.sequence}.mp3`, duration_sec: 10 });
  }
  // Prime each chapter's cached status/audio_path the same way GET /status would.
  await s.call('gateway', 'GET', `/${created.audiobook_id}/status`);

  const r = await s.call('gateway', 'POST', `/${created.audiobook_id}/export`);
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.export_status, 'completed');

  assert.equal(spawnCalls.length, 1);
  const call = spawnCalls[0];
  assert.equal(call?.command, 'ffmpeg');
  assert.deepEqual(call?.args.slice(0, 4), ['-y', '-f', 'concat', '-safe']);
  assert.ok(call?.args.includes('-map_metadata'));
  assert.ok(call?.args.includes('-codec'));
  assert.ok(call?.args.includes('copy'));
  // Last arg is the output path.
  assert.match(call?.args.at(-1) ?? '', /export\.mp3$/);
  s.close();
});

test('POST /api/audiobooks/:id/export: a non-zero ffmpeg exit code fails the export', async () => {
  const s = await boot();
  const createRes = await s.call('gateway', 'POST', '', { title: 'Bad Export Book', voice_id: 'am_adam', text: 'short text here' });
  const created = await createRes.json();
  const chapters = chaptersByAudiobook.get(created.audiobook_id) ?? [];
  const jobId = chapters[0]?.tts_job_id as string;
  ttsJobStatuses.set(jobId, { status: 'ready', audio_path: 'audiobooks/x/ch0.mp3', duration_sec: 10 });
  await s.call('gateway', 'GET', `/${created.audiobook_id}/status`);

  spawnExitCode = 1;

  const r = await s.call('gateway', 'POST', `/${created.audiobook_id}/export`);
  assert.equal(r.status, 500);
  const stored = audiobooks.get(created.audiobook_id);
  assert.equal(stored?.export_status, 'failed');
  s.close();
});
