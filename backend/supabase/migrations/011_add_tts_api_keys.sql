-- ============================================================================
-- Migration: TTS Realtime API Keys
-- Lets a real, authenticated Supabase user generate an API key for the
-- standalone realtime-tts service (github.com/tsushanth/realtime-tts). The
-- gateway itself is the source of truth for whether a key is VALID (a JSON
-- file store, see gateway/keys.js) - this table only tracks ownership and
-- display metadata for the ReadAloud web UI. The raw key value is never
-- stored here, only the gateway-issued `key_id` (safe, non-secret) needed to
-- revoke it later, and a short prefix for display.
--
-- Table prefixed `realtimetts_` (not `tts_`, which is already used by this
-- app's own tables like tts_jobs/tts_usage) — this Supabase project is shared
-- across multiple apps, so tables owned by a different app get that app's
-- name as an explicit prefix to keep ownership obvious at a glance.
-- ============================================================================

CREATE TABLE IF NOT EXISTS realtimetts_api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Owner - real Supabase Auth user only. Deliberately NOT nullable and NOT
    -- backed by app_users, unlike most of this app's device-ID-first tables -
    -- an API key must be tied to a real signed-in identity, not an anonymous
    -- device, since it grants access to a billable external service.
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- gateway/keys.js's issued key id (a UUID it generates) - used to call
    -- DELETE /admin/keys on the gateway when this row is revoked.
    gateway_key_id TEXT NOT NULL UNIQUE,

    -- First ~10 chars of the raw key, for display only ("rtts_8b8cb...").
    -- Never store the full raw key.
    key_preview TEXT NOT NULL,

    label TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_realtimetts_api_keys_user_id ON realtimetts_api_keys(user_id);

ALTER TABLE realtimetts_api_keys ENABLE ROW LEVEL SECURITY;

-- Service role only - all access goes through the backend (which uses
-- SUPABASE_SERVICE_ROLE_KEY), never directly from the client.
CREATE POLICY "Service role full access on realtimetts_api_keys" ON realtimetts_api_keys
    FOR ALL
    USING (true);

COMMENT ON TABLE realtimetts_api_keys IS
    'Ownership/display record for realtime-tts-gateway API keys. The gateway
     (a separate Fly app, github.com/tsushanth/realtime-tts) is the actual
     source of truth for key validity - this table exists so the ReadAloud
     web UI can show a user their own keys and let them revoke one, without
     ever storing the raw secret server-side after issuance.';
