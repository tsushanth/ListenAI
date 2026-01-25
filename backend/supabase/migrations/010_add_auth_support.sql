-- ============================================================================
-- Migration: Add Authentication Support
-- Adds user_devices table for device-to-user linking
-- Updates app_users to support Supabase Auth
-- ============================================================================

-- ============================================================================
-- Update app_users table for auth support
-- ============================================================================

-- Add email column if not exists (for tracking authenticated users)
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email TEXT;

-- Add provider column to track auth provider (apple, google, etc.)
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS auth_provider TEXT;

-- Add email verified timestamp
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Index for email lookups
CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email) WHERE email IS NOT NULL;

-- ============================================================================
-- User Devices Table
-- Links device IDs to authenticated users for data migration
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- User association
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Device information
    device_id TEXT NOT NULL UNIQUE,  -- The device ID from X-Device-ID header
    device_name TEXT,                 -- Optional friendly name (e.g., "iPhone 15")
    platform TEXT,                    -- ios, android, web

    -- Timestamps
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Find devices by user
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);

-- Find user by device (for migration lookups)
CREATE INDEX IF NOT EXISTS idx_user_devices_device_id ON user_devices(device_id);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role full access on user_devices" ON user_devices
    FOR ALL
    USING (true);

-- ============================================================================
-- Functions
-- ============================================================================

-- Function: Link device to user (upsert)
CREATE OR REPLACE FUNCTION link_device_to_user(
    p_user_id UUID,
    p_device_id TEXT,
    p_platform TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO user_devices (user_id, device_id, platform, linked_at, last_seen_at)
    VALUES (p_user_id, p_device_id, p_platform, NOW(), NOW())
    ON CONFLICT (device_id)
    DO UPDATE SET
        user_id = p_user_id,
        platform = COALESCE(p_platform, user_devices.platform),
        last_seen_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Function: Migrate device data to authenticated user
-- Migrates cloned_voices and shared_voices from device_id to user_id
CREATE OR REPLACE FUNCTION migrate_device_data_to_user(
    p_user_id UUID,
    p_device_id TEXT
)
RETURNS TABLE (
    cloned_voices_migrated INTEGER,
    shared_voices_migrated INTEGER
) AS $$
DECLARE
    v_cloned_count INTEGER := 0;
    v_shared_count INTEGER := 0;
BEGIN
    -- Migrate cloned_voices
    UPDATE cloned_voices
    SET user_id = p_user_id::TEXT
    WHERE user_id = p_device_id
      AND NOT EXISTS (
          SELECT 1 FROM cloned_voices cv2
          WHERE cv2.user_id = p_user_id::TEXT
            AND cv2.name = cloned_voices.name
      );
    GET DIAGNOSTICS v_cloned_count = ROW_COUNT;

    -- Migrate shared_voices
    UPDATE shared_voices
    SET owner_user_id = p_user_id::TEXT
    WHERE owner_user_id = p_device_id
      AND NOT EXISTS (
          SELECT 1 FROM shared_voices sv2
          WHERE sv2.owner_user_id = p_user_id::TEXT
            AND sv2.cloned_voice_id = shared_voices.cloned_voice_id
      );
    GET DIAGNOSTICS v_shared_count = ROW_COUNT;

    RETURN QUERY SELECT v_cloned_count, v_shared_count;
END;
$$ LANGUAGE plpgsql;

-- Function: Get user by device ID
CREATE OR REPLACE FUNCTION get_user_by_device(p_device_id TEXT)
RETURNS TABLE (
    user_id UUID,
    email TEXT,
    linked_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT ud.user_id, au.email, ud.linked_at
    FROM user_devices ud
    JOIN auth.users au ON au.id = ud.user_id
    WHERE ud.device_id = p_device_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Update last_seen_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION update_device_last_seen()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE user_devices
    SET last_seen_at = NOW()
    WHERE device_id = NEW.device_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE user_devices IS
    'Links device IDs to authenticated Supabase users.
     Used for migrating anonymous usage data when user signs in.';

COMMENT ON COLUMN user_devices.device_id IS
    'The device identifier from X-Device-ID header.
     Generated client-side (UUID or vendor ID).';

COMMENT ON FUNCTION migrate_device_data_to_user IS
    'Migrates data created under a device ID to an authenticated user.
     Called when a user signs in and links their device.';
