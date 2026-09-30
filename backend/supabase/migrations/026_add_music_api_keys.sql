-- Persistent API keys for the text-to-music API, so external SDK consumers
-- can authenticate without a Supabase user session. Unlike realtimetts_api_keys
-- (which delegates key issuance/validation to the separate realtime-tts-gateway
-- service), this backend owns key storage and validation directly: only a
-- SHA-256 hash of the raw key is ever stored, matching the existing sha256()
-- helper pattern used elsewhere (lib/cacheKey.ts) rather than a new dependency.

CREATE TABLE music_api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,

    -- SHA-256 hex digest of the raw key. The raw key is shown to the user
    -- exactly once, at creation time, and never stored or retrievable again.
    key_hash TEXT NOT NULL UNIQUE,

    -- First 12 characters of the raw key (e.g. "rlm_a1b2c3d4"), stored
    -- alongside the hash so the key list UI can show which key is which
    -- without ever re-displaying the full secret.
    key_prefix TEXT NOT NULL,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_music_api_keys_user_id ON music_api_keys (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_music_api_keys_key_hash ON music_api_keys (key_hash) WHERE revoked_at IS NULL;

-- Same security posture as music_jobs (019_add_secure_music_jobs.sql): only
-- the backend's service-role key ever touches this table directly. No RLS
-- policy is added for anon/authenticated, so with RLS enabled those roles
-- get zero rows/zero writes by default.
ALTER TABLE music_api_keys ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION create_music_api_key(
    p_user_id UUID,
    p_key_hash TEXT,
    p_key_prefix TEXT
) RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    v_id := uuid_generate_v4();
    INSERT INTO music_api_keys (id, user_id, key_hash, key_prefix, created_at)
    VALUES (v_id, p_user_id, p_key_hash, p_key_prefix, NOW());
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION list_music_api_keys(p_user_id UUID)
RETURNS TABLE (id UUID, key_prefix TEXT, created_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ) AS $$
    SELECT id, key_prefix, created_at, revoked_at
    FROM music_api_keys
    WHERE user_id = p_user_id
    ORDER BY created_at DESC;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION revoke_music_api_key(p_user_id UUID, p_key_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_updated INTEGER;
BEGIN
    UPDATE music_api_keys
    SET revoked_at = NOW()
    WHERE id = p_key_id AND user_id = p_user_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$ LANGUAGE plpgsql;

-- Looks up an active (non-revoked) key by its hash, returning the owning
-- user_id. Used on every /api/music request that authenticates via API key,
-- so this is the hot path — the partial index above (WHERE revoked_at IS NULL)
-- keeps it fast.
CREATE OR REPLACE FUNCTION validate_music_api_key(p_key_hash TEXT)
RETURNS UUID AS $$
    SELECT user_id FROM music_api_keys
    WHERE key_hash = p_key_hash AND revoked_at IS NULL
    LIMIT 1;
$$ LANGUAGE sql STABLE;

REVOKE EXECUTE ON FUNCTION create_music_api_key FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_music_api_keys FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION revoke_music_api_key FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION validate_music_api_key FROM PUBLIC, anon, authenticated;
