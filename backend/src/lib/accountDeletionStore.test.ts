// Run: npm test. The Supabase-backed account store against an in-memory fake of the supabase-js calls it makes:
// every delete is keyed by the user id, shared storage objects are never removed, missing tables are skipped,
// the auth user is deleted idempotently.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, any>;

function makeDb(initial: Record<string, Row[]>, opts: { missing?: string[]; authError?: { status?: number; code?: string; message: string } | null } = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(initial));
  const files: Record<string, Set<string>> = {};
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  const deleteLog: Array<{ table: string; column: string; value: string }> = [];
  const authDeleted: string[] = [];

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: 'select' | 'delete' | 'update' = 'select';
    let cols: string[] | null = null;
    let patch: Row = {};
    let single = false;
    const exec = () => {
      if (opts.missing?.includes(table)) return { data: null, error: { code: 'PGRST205', message: `no table ${table}` } };
      const rows = tables[table] ?? [];
      const match = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === 'delete') { tables[table] = rows.filter((r) => !match.includes(r)); return { data: null, error: null }; }
      if (mode === 'update') { match.forEach((r) => Object.assign(r, patch)); return { data: null, error: null }; }
      const out = match.map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r));
      return { data: single ? (out[0] ?? null) : out, error: null };
    };
    const b: any = {
      select(c: string) { cols = c.split(',').map((x) => x.trim()); return b; },
      delete() { mode = 'delete'; return b; },
      update(p: Row) { mode = 'update'; patch = p; return b; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); if (mode === 'delete') deleteLog.push({ table, column: c, value: String(v) }); return b; },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      maybeSingle() { single = true; return b; },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(exec()).then(res, rej); },
    };
    return b;
  }

  const db: any = {
    from: builder,
    storage: {
      from: (bucket: string) => ({
        list: async (prefix: string) => ({
          data: [...(files[bucket] ?? [])].filter((p) => p.startsWith(`${prefix}/`)).map((p) => ({ id: 'x', name: p.slice(prefix.length + 1) })),
          error: null,
        }),
        remove: async (paths: string[]) => { removed.push({ bucket, paths }); paths.forEach((p) => files[bucket]?.delete(p)); return { data: null, error: null }; },
      }),
    },
    auth: { admin: { deleteUser: async (id: string) => { authDeleted.push(id); return { error: opts.authError ?? null }; } } },
  };
  return { db, tables, files, removed, deleteLog, authDeleted };
}

const modP = import('./accountDeletionStore.js');

test('deleteUserRows deletes only by the verified id: other users\' rows survive, every delete is keyed by id', async () => {
  const { createSupabaseAccountStore, USER_ROW_TARGETS } = await modP;
  const k = makeDb({
    tts_jobs: [{ id: 1, user_id: A }, { id: 2, user_id: B }],
    subscriptions: [{ user_id: A }, { user_id: B }],
    app_users: [{ id: A }, { id: B }],
    stt_key_settings: [{ subject: A }, { subject: 'key:abc' }],
    voice_reports: [{ reporter_user_id: A }, { reporter_user_id: B }],
  });
  const res = await createSupabaseAccountStore(k.db).deleteUserRows(A);
  assert.deepEqual(k.tables.tts_jobs, [{ id: 2, user_id: B }]);
  assert.deepEqual(k.tables.subscriptions, [{ user_id: B }]);
  assert.deepEqual(k.tables.app_users, [{ id: B }]);
  assert.deepEqual(k.tables.stt_key_settings, [{ subject: 'key:abc' }]);
  assert.deepEqual(k.tables.voice_reports, [{ reporter_user_id: B }]);
  assert.equal(k.deleteLog.length, USER_ROW_TARGETS.length);
  assert.ok(k.deleteLog.every((d) => d.value === A), 'no delete is keyed by anything but the user id');
  assert.equal(res.tablesTouched, USER_ROW_TARGETS.length);
});

test('consent evidence, output hashes and the shared cache are never in the delete list', async () => {
  const { USER_ROW_TARGETS } = await modP;
  const names = USER_ROW_TARGETS.map(([t]) => t);
  for (const keep of ['voice_consents', 'voice_consent_challenges', 'voice_clone_output_hashes', 'voice_clones', 'tts_cache', 'stripe_webhook_events']) {
    assert.equal(names.includes(keep), false, keep);
  }
});

test('tables missing from a deployment are skipped, other errors still fail the run', async () => {
  const { createSupabaseAccountStore } = await modP;
  const k = makeDb({ tts_jobs: [{ id: 1, user_id: A }] }, { missing: ['music_jobs', 'voice_isolations'] });
  const res = await createSupabaseAccountStore(k.db).deleteUserRows(A);
  assert.deepEqual(res.tablesSkipped.sort(), ['music_jobs', 'voice_isolations']);

  const bad = makeDb({});
  bad.db.from = () => { const b: any = { delete: () => b, eq: () => Promise.resolve({ data: null, error: { code: '23503', message: 'fk' } }) }; return b; };
  await assert.rejects(createSupabaseAccountStore(bad.db).deleteUserRows(A), /fk/);
});

test('collectStorage: own objects only. A path another user\'s job or the shared cache also points at is left alone', async () => {
  const { createSupabaseAccountStore } = await modP;
  const k = makeDb({
    tts_jobs: [
      { user_id: A, audio_path: 'jobs/own.mp3', preview_audio_path: null, full_audio_path: 'jobs/own-full.mp3' },
      { user_id: A, audio_path: 'jobs/dedup.mp3', preview_audio_path: null, full_audio_path: null },
      { user_id: B, audio_path: 'jobs/dedup.mp3', preview_audio_path: null, full_audio_path: null },
      { user_id: B, audio_path: 'jobs/b-only.mp3', preview_audio_path: null, full_audio_path: null },
    ],
    tts_cache: [{ audio_path: 'jobs/own-full.mp3' }],
    sound_effect_jobs: [{ user_id: A, audio_path: 'sfx/a.wav' }],
    music_jobs: [],
    audiobooks: [{ id: 'book1', user_id: A, export_audio_path: 'exports/a.mp3' }, { id: 'book2', user_id: B, export_audio_path: 'exports/b.mp3' }],
    audiobook_chapters: [{ audiobook_id: 'book1', audio_path: 'jobs/own.mp3' }, { audiobook_id: 'book2', audio_path: 'jobs/b-only.mp3' }],
    cloned_voices: [{ user_id: A, audio_path: `${A}/v.wav` }, { user_id: B, audio_path: `${B}/v.wav` }],
  });
  k.files['audio-files'] = new Set([`${A}/upload1.pdf`, `${B}/upload2.pdf`]);
  const groups = await createSupabaseAccountStore(k.db).collectStorage(A);
  const audio = groups.find((g) => g.bucket === 'audio-files')!.paths.sort();
  assert.deepEqual(audio, [`${A}/upload1.pdf`, 'exports/a.mp3', 'jobs/own.mp3', 'sfx/a.wav'].sort());
  assert.deepEqual(groups.find((g) => g.bucket === 'cloned-voices')!.paths, [`${A}/v.wav`]);
  for (const g of groups) for (const p of g.paths) assert.ok(!p.includes(B) && !p.includes('b-only') && !p.includes('dedup') && p !== 'jobs/own-full.mp3');
});

test('removeStorage removes exactly the given paths from the given bucket', async () => {
  const { createSupabaseAccountStore } = await modP;
  const k = makeDb({});
  const paths = Array.from({ length: 250 }, (_, i) => `p/${i}`);
  await createSupabaseAccountStore(k.db).removeStorage({ bucket: 'audio-files', paths });
  assert.equal(k.removed.length, 3);
  assert.deepEqual(k.removed.flatMap((r) => r.paths), paths);
  assert.ok(k.removed.every((r) => r.bucket === 'audio-files'));
});

test('subscriptionFlags: active Stripe and RevenueCat ledger rows and an active non-comped API plan count; lapsed and comped do not', async () => {
  const { createSupabaseAccountStore } = await modP;
  const future = new Date(Date.now() + 86400_000).toISOString();
  const past = new Date(Date.now() - 30 * 86400_000).toISOString();
  const row = (source: string, status: string, end: string) => ({ user_id: A, source, tier: 'pro', status, current_period_end: end });

  const none = makeDb({ entitlement_sources: [row('stripe', 'canceled', future), row('revenuecat', 'active', past)], realtimetts_billing: [{ user_id: A, active: true, comped: true, stripe_subscription_id: null }] });
  assert.deepEqual(await createSupabaseAccountStore(none.db).subscriptionFlags(A), { stripe: false, play: false });

  const both = makeDb({ entitlement_sources: [row('stripe', 'active', future), row('revenuecat', 'trialing', future)] });
  assert.deepEqual(await createSupabaseAccountStore(both.db).subscriptionFlags(A), { stripe: true, play: true });

  const api = makeDb({ realtimetts_billing: [{ user_id: A, active: true, comped: false, stripe_subscription_id: 'sub_1' }] });
  assert.deepEqual(await createSupabaseAccountStore(api.db).subscriptionFlags(A), { stripe: true, play: false });

  const other = makeDb({ entitlement_sources: [{ ...row('stripe', 'active', future), user_id: B }] });
  assert.deepEqual(await createSupabaseAccountStore(other.db).subscriptionFlags(A), { stripe: false, play: false }, 'another user\'s subscription is not ours');

  const noLedger = makeDb({}, { missing: ['entitlement_sources'] });
  assert.deepEqual(await createSupabaseAccountStore(noLedger.db).subscriptionFlags(A), { stripe: false, play: false });
});

test('deleteAuthUser: deleted, already gone is success, other errors throw', async () => {
  const { createSupabaseAccountStore } = await modP;
  const ok = makeDb({});
  assert.equal(await createSupabaseAccountStore(ok.db).deleteAuthUser(A), 'deleted');
  assert.deepEqual(ok.authDeleted, [A]);
  const gone = makeDb({}, { authError: { status: 404, code: 'user_not_found', message: 'User not found' } });
  assert.equal(await createSupabaseAccountStore(gone.db).deleteAuthUser(A), 'not_found');
  const bad = makeDb({}, { authError: { status: 500, message: 'db down' } });
  await assert.rejects(createSupabaseAccountStore(bad.db).deleteAuthUser(A), /db down/);
});
