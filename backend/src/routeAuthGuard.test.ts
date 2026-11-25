// npm test (node:test via tsx). Guard: every route mounted in src/index.ts is classified, and no new mount can
// be left unauthenticated by accident. Also pins which REST families accept the public rtts_ key.
//
// How it works: index.ts is read as text, each `app.use/get/post(...)` mount is extracted, and its path +
// auth middleware is compared with the table below. A mount that is not in the table FAILS this test, so
// adding a route forces an explicit decision here (require an auth middleware, or declare why it is public /
// self-authenticating). Changing a classified mount's auth middleware also fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'index.ts'), 'utf8');

type Auth =
  | { mw: string }                       // this middleware must appear in the mount
  | { router: string }                   // the mounted router authenticates itself (reason recorded here)
  | { public: string };                  // deliberately unauthenticated (reason recorded here)

// key = "<method> <path>" where method is USE for app.use
const TABLE: Record<string, Auth> = {
  'USE /api/webhooks': { public: 'Stripe webhook: authenticated by Stripe signature inside the router' },
  'USE /api/gateway/request-log': { router: 'gateway shared secret inside the router (404 unless REQUEST_LOG_INGEST_ENABLED and the secret match)' },
  'GET /health': { public: 'health check' },
  'USE /api': { public: 'rate limiter only, mounted before the routes' },
  'GET /api/tts/job/:jobId': { mw: 'requireAuth' },
  'POST /api/tts/job/:jobId/cancel': { mw: 'requireAuth' },
  'USE /api/tts': { mw: 'requireAuth' },
  'USE /api/realtime-tts': { mw: 'requireAuth' },
  'USE /api/tts/preview': { public: 'rate limiter only (previews are free, router has no extra mount here)' },
  'GET /api/music/job/:jobId': { mw: 'requireMusicAuth' },
  'USE /api/music': { mw: 'requireMusicAuth' },
  'USE /api/music-api-keys': { mw: 'requireRealAuth' },
  'USE /api/usage': { mw: 'requireAuth' },
  'USE /api/voices': { router: 'public voice catalogue' },
  'USE /api/extract': { mw: 'requireAuth' },
  'USE /api/audio': { router: 'serves audio by unguessable id' },
  'USE /api/subscription': { mw: 'requireAuth' },
  'USE /api/entitlement': { router: 'verifies its own bearer / store receipt' },
  'USE /api/latency': { router: 'anonymous latency beacons' },
  'USE /api/ai': { mw: 'requireAuth' },
  'USE /api/admin/voice-clones': { router: 'admin bearer inside the router' },
  'USE /api/admin/dashboard': { router: 'verifies the admin bearer itself (404 for everyone else)' },
  'USE /api/admin': { router: 'admin secret inside the router' },
  'USE /api/tts#worker': { router: 'Pub/Sub push secret inside the router' },
  'USE /api/voice-clones': { router: 'real Supabase session inside the router' },
  'USE /api/cloned-voices': { router: 'legacy device-id router, creation disabled' },
  'USE /api/stories': { router: 'device-id gated inside the router' },
  'USE /api/audiobooks': { mw: 'requireAuthOrApiKey' },
  'USE /api/tts-api-keys': { router: 'router.use(requireRealAuth): session token only, never an API key' },
  'USE /api/voice-design': { mw: 'requireAuthOrApiKey' },
  'USE /api/voice-convert': { mw: 'requireAuthOrApiKey' },
  'USE /api/voice-isolate': { mw: 'requireAuthOrApiKey' },
  'USE /api/stt': { mw: 'requireAuthOrApiKey' },
  'USE /v1': { mw: 'requireAuthOrApiKey' },
  'USE /api/dub': { mw: 'requireAuthOrApiKey' },
  'USE /api/sound-effects': { mw: 'requireAuthOrApiKey' },
  'USE /api/voice-studio': { router: 'strict Supabase session inside the router' },
  'USE /internal/voice-studio-api': { router: 'gateway shared secret inside the router' },
  'USE /internal/voice-clone-api': { router: 'gateway shared secret inside the router' },
  'USE /internal/orpheus-clone-api': { router: 'gateway shared secret inside the router' },
  'USE /api/orpheus-voice-studio': { router: 'strict Supabase session inside the router' },
  'USE /api/marketplace': { router: 'marketplace router checks its own identity' },
  'USE /api/auth': { router: 'sign-in endpoints' },
  'USE /api/account': { router: 'real Supabase session inside the router' },
  'USE /api/config': { public: 'remote config flags' },
};

// The REST families that must accept the public API key: each is mounted behind requireAuthOrApiKey.
const KEY_FAMILIES = ['/api/dub', '/api/voice-convert', '/api/voice-design', '/api/voice-isolate', '/api/audiobooks', '/api/sound-effects', '/api/stt', '/v1'];

function mounts(): Array<{ key: string; path: string; chunk: string }> {
  const noComments = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const parts = noComments.split(/^(?=app\.(?:use|get|post|put|delete|all|patch)\()/m).filter((p) => p.startsWith('app.'));
  const out: Array<{ key: string; path: string; chunk: string }> = [];
  let sawTts = 0;
  for (const chunk of parts) {
    const m = /^app\.(use|get|post|put|delete|all|patch)\(\s*'([^']+)'/.exec(chunk);
    if (!m) continue; // app.use(helmet()), app.use(cors()), notFoundHandler, errorHandler: global middleware, no path
    const method = m[1]!.toUpperCase();
    let path = m[2]!;
    let key = `${method} ${path}`;
    if (key === 'USE /api/tts') { sawTts++; if (sawTts === 2) key = 'USE /api/tts#worker'; }
    out.push({ key, path, chunk });
  }
  return out;
}

test('every mount in index.ts is classified, and its auth middleware matches the table', () => {
  const found = mounts();
  assert.ok(found.length >= 40, `parsed ${found.length} mounts: parser broke?`);
  for (const { key, chunk } of found) {
    const rule = TABLE[key];
    assert.ok(rule, `New route mount "${key}" in index.ts is not classified in routeAuthGuard.test.ts. ` +
      `Mount it behind an auth middleware (requireAuth / requireAuthOrApiKey / requireRealAuth), or add it to the table with the reason it authenticates itself or is public.`);
    if ('mw' in rule) assert.ok(new RegExp(`\\b${rule.mw}\\b`).test(chunk), `${key} must use ${rule.mw}`);
  }
  for (const key of Object.keys(TABLE)) assert.ok(found.some((f) => f.key === key), `table entry "${key}" no longer exists in index.ts: remove it`);
});

test('the public-key families are exactly the ones mounted behind requireAuthOrApiKey', () => {
  const found = mounts().filter((m) => /\brequireAuthOrApiKey\b/.test(m.chunk)).map((m) => m.path).sort();
  assert.deepEqual(found, [...KEY_FAMILIES].sort());
});

test('no key-family mount can lose auth: each carries requireAuthOrApiKey, not the default-user requireAuth', () => {
  for (const p of KEY_FAMILIES) {
    const m = mounts().find((x) => x.path === p);
    assert.ok(m, p);
    assert.ok(/\brequireAuthOrApiKey\b/.test(m!.chunk), p);
    assert.ok(!/\brequireAuth\b/.test(m!.chunk), `${p} must not use requireAuth (shared default-user fallback)`);
  }
});

test('key management stays session-only: /api/tts-api-keys is not behind the key middleware and its router requires a real session', () => {
  const m = mounts().find((x) => x.path === '/api/tts-api-keys')!;
  assert.ok(!/requireAuthOrApiKey/.test(m.chunk));
  const router = readFileSync(join(here, 'routes', 'ttsApiKeys.ts'), 'utf8');
  assert.match(router, /ttsApiKeysRouter\.use\(requireRealAuth\)/);
  const music = mounts().find((x) => x.path === '/api/music-api-keys')!;
  assert.ok(/requireRealAuth/.test(music.chunk) && !/requireAuthOrApiKey/.test(music.chunk));
});

test('request logging redacts every credential header via the shared list', () => {
  assert.match(src, /pinoHttp\(\{[\s\S]*redact:\s*LOG_REDACT_PATHS/);
});

test('switchable features: every mount of a switched-off feature goes through its gate, after any auth middleware', () => {
  const found = mounts();
  const gated: Record<string, string> = {
    '/api/voice-design': 'voice_design',
    '/api/voice-studio': 'voice_studio',
    '/internal/voice-studio-api': 'voice_studio',
    '/internal/orpheus-clone-api': 'voice_studio',
    '/api/orpheus-voice-studio': 'voice_studio',
  };
  for (const [path, feature] of Object.entries(gated)) {
    const m = found.find((x) => x.path === path)!;
    assert.match(m.chunk, new RegExp(`featureGate\\('${feature}'[^\\n]*, \\w+Router\\);`), path);
  }
  assert.match(found.find((x) => x.path === '/api/voice-design')!.chunk, /requireAuthOrApiKey, featureGate/);
});

