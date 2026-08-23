// CRUD for the tts_api_keys table (see supabase/migrations/011_add_tts_api_keys.sql).
// This table only tracks ownership/display metadata — realtime-tts-gateway (a
// separate Fly app) is the source of truth for whether a key is actually valid.
import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';

const keysLogger = logger.child({ module: 'ttsApiKeys' });

export interface TTSApiKeyRecord {
  id: string;
  user_id: string;
  gateway_key_id: string;
  key_preview: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export async function createApiKeyRecord(params: {
  userId: string;
  gatewayKeyId: string;
  keyPreview: string;
  label: string | null;
}): Promise<TTSApiKeyRecord> {
  const { data, error } = await supabase
    .from('tts_api_keys')
    .insert({
      user_id: params.userId,
      gateway_key_id: params.gatewayKeyId,
      key_preview: params.keyPreview,
      label: params.label,
    })
    .select()
    .single();

  if (error) {
    keysLogger.error({ error, userId: params.userId }, 'Failed to create API key record');
    throw error;
  }
  return data as TTSApiKeyRecord;
}

export async function listApiKeysForUser(userId: string): Promise<TTSApiKeyRecord[]> {
  const { data, error } = await supabase
    .from('tts_api_keys')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    keysLogger.error({ error, userId }, 'Failed to list API keys');
    throw error;
  }
  return (data ?? []) as TTSApiKeyRecord[];
}

/** Returns the record if it belonged to this user and was marked revoked; null if not found/not owned. */
export async function revokeApiKeyRecord(id: string, userId: string): Promise<TTSApiKeyRecord | null> {
  const { data, error } = await supabase
    .from('tts_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // no matching row
    keysLogger.error({ error, id, userId }, 'Failed to revoke API key record');
    throw error;
  }
  return data as TTSApiKeyRecord;
}
