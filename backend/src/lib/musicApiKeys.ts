// Persistent API keys for the text-to-music API. See
// supabase/migrations/026_add_music_api_keys.sql for the storage design:
// only a SHA-256 hash of the raw key is ever stored; the raw key is
// returned to the caller exactly once, at creation time.
import crypto from 'crypto';
import { supabase } from './supabaseClient.js';
import { sha256 } from './cacheKey.js';

export const MUSIC_API_KEY_PREFIX = 'rlm_';

export interface MusicApiKey {
  id: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
}

export function generateMusicApiKey(): string {
  const random = crypto.randomBytes(32).toString('base64url');
  return `${MUSIC_API_KEY_PREFIX}${random}`;
}

export function hashMusicApiKey(rawKey: string): string {
  return sha256(rawKey);
}

export async function createMusicApiKey(userId: string): Promise<{ id: string; rawKey: string }> {
  const rawKey = generateMusicApiKey();
  const keyHash = hashMusicApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const { data: id, error } = await supabase.rpc('create_music_api_key', {
    p_user_id: userId,
    p_key_hash: keyHash,
    p_key_prefix: keyPrefix,
  });
  if (error) throw error;

  return { id: id as string, rawKey };
}

export async function listMusicApiKeys(userId: string): Promise<MusicApiKey[]> {
  const { data, error } = await supabase.rpc('list_music_api_keys', { p_user_id: userId });
  if (error) throw error;
  return (data as MusicApiKey[] | null) ?? [];
}

export async function revokeMusicApiKey(userId: string, keyId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('revoke_music_api_key', {
    p_user_id: userId,
    p_key_id: keyId,
  });
  if (error) throw error;
  return Boolean(data);
}

/**
 * Resolves a raw API key to its owning user_id, or null if the key doesn't
 * look like one of ours, or is invalid/revoked. Cheap prefix check first so
 * a session JWT (which never starts with MUSIC_API_KEY_PREFIX) short-circuits
 * without a DB round-trip.
 */
export async function validateMusicApiKey(rawKey: string): Promise<string | null> {
  if (!rawKey.startsWith(MUSIC_API_KEY_PREFIX)) return null;

  const keyHash = hashMusicApiKey(rawKey);
  const { data, error } = await supabase.rpc('validate_music_api_key', { p_key_hash: keyHash });
  if (error) throw error;
  return (data as string | null) ?? null;
}
