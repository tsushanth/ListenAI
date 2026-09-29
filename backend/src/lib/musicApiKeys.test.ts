// Requires a local Supabase instance with migration 020 applied.
// Run: npx tsx --test src/lib/musicApiKeys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMusicApiKey,
  listMusicApiKeys,
  revokeMusicApiKey,
  validateMusicApiKey,
  MUSIC_API_KEY_PREFIX,
} from './musicApiKeys.js';

const testUserId = '00000000-0000-0000-0000-000000000099';

test('createMusicApiKey returns a raw key with the expected prefix, and it validates', async () => {
  const { rawKey } = await createMusicApiKey(testUserId);
  assert.ok(rawKey.startsWith(MUSIC_API_KEY_PREFIX));

  const resolvedUserId = await validateMusicApiKey(rawKey);
  assert.equal(resolvedUserId, testUserId);
});

test('validateMusicApiKey returns null for a key that is not ours', async () => {
  const resolvedUserId = await validateMusicApiKey('not-a-real-key');
  assert.equal(resolvedUserId, null);
});

test('validateMusicApiKey returns null for a revoked key', async () => {
  const { id, rawKey } = await createMusicApiKey(testUserId);
  const revoked = await revokeMusicApiKey(testUserId, id);
  assert.equal(revoked, true);

  const resolvedUserId = await validateMusicApiKey(rawKey);
  assert.equal(resolvedUserId, null);
});

test('revokeMusicApiKey returns false for a key belonging to a different user', async () => {
  const { id } = await createMusicApiKey(testUserId);
  const revoked = await revokeMusicApiKey('00000000-0000-0000-0000-000000000098', id);
  assert.equal(revoked, false);
});

test('listMusicApiKeys returns keys scoped to the user, newest first, never the raw key', async () => {
  const before = await listMusicApiKeys(testUserId);
  await createMusicApiKey(testUserId);
  const after = await listMusicApiKeys(testUserId);

  assert.equal(after.length, before.length + 1);
  for (const key of after) {
    assert.ok(key.key_prefix.startsWith(MUSIC_API_KEY_PREFIX));
    assert.ok(!('key_hash' in key));
    assert.ok(!('rawKey' in key));
  }
});
