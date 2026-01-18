import { logger } from './logger.js';
import { supabase } from './supabaseClient.js';

// ============================================================================
// Rollout Logger
// ============================================================================

const rolloutLogger = logger.child({ module: 'rollout' });

// ============================================================================
// Rollout Configuration
// ============================================================================

export interface RolloutConfig {
  // Job API rollout percentage (0-100)
  jobApiRolloutPercent: number;

  // Kill switch - immediately disables new pipeline for everyone
  killSwitchEnabled: boolean;

  // Explicit allowlist (always included regardless of percentage)
  allowlist: Set<string>;

  // Explicit blocklist (never included regardless of percentage)
  blocklist: Set<string>;
}

// Default test user UUIDs
const DEFAULT_PRO_USER_UUID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_DEV_USER_UUID = '00000000-0000-0000-0000-000000000002';

// In-memory rollout state (can be updated at runtime)
let rolloutConfig: RolloutConfig = {
  jobApiRolloutPercent: 0,  // Start at 0% (only allowlist)
  killSwitchEnabled: false,
  allowlist: new Set([
    DEFAULT_PRO_USER_UUID,
    DEFAULT_DEV_USER_UUID,
  ]),
  blocklist: new Set(),
};

// ============================================================================
// Rollout Control Functions
// ============================================================================

/**
 * Check if a user should use the new job-based API.
 * Uses consistent hashing so same user always gets same result.
 */
export function isUserInJobApiRollout(userId: string): boolean {
  // 1. Check kill switch first - if enabled, no one uses new pipeline
  if (rolloutConfig.killSwitchEnabled) {
    rolloutLogger.debug({ userId }, 'Kill switch enabled, user not in rollout');
    return false;
  }

  // 2. Check blocklist - always excluded
  if (rolloutConfig.blocklist.has(userId)) {
    rolloutLogger.debug({ userId }, 'User in blocklist, excluded from rollout');
    return false;
  }

  // 3. Check allowlist - always included
  if (rolloutConfig.allowlist.has(userId)) {
    rolloutLogger.debug({ userId }, 'User in allowlist, included in rollout');
    return true;
  }

  // 4. Check percentage rollout using consistent hashing
  const hash = hashUserId(userId);
  const bucket = hash % 100;  // 0-99
  const inRollout = bucket < rolloutConfig.jobApiRolloutPercent;

  rolloutLogger.debug({
    userId,
    hash,
    bucket,
    rolloutPercent: rolloutConfig.jobApiRolloutPercent,
    inRollout,
  }, 'User rollout check');

  return inRollout;
}

/**
 * Simple consistent hash function for user ID.
 * Returns a value 0-99 based on the user ID.
 */
function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash) % 100;
}

// ============================================================================
// Rollout Management Functions
// ============================================================================

/**
 * Set the rollout percentage (0-100).
 */
export function setRolloutPercent(percent: number): void {
  const clamped = Math.max(0, Math.min(100, percent));
  const previous = rolloutConfig.jobApiRolloutPercent;
  rolloutConfig.jobApiRolloutPercent = clamped;

  rolloutLogger.info({
    event: 'rollout_percent_changed',
    previous,
    current: clamped,
  }, `Rollout percentage changed from ${previous}% to ${clamped}%`);
}

/**
 * Get current rollout percentage.
 */
export function getRolloutPercent(): number {
  return rolloutConfig.jobApiRolloutPercent;
}

/**
 * Enable the kill switch (disables new pipeline for everyone).
 */
export function enableKillSwitch(): void {
  if (!rolloutConfig.killSwitchEnabled) {
    rolloutConfig.killSwitchEnabled = true;
    rolloutLogger.warn({
      event: 'kill_switch_enabled',
    }, 'KILL SWITCH ENABLED - New job pipeline disabled for all users');
  }
}

/**
 * Disable the kill switch (resumes rollout).
 */
export function disableKillSwitch(): void {
  if (rolloutConfig.killSwitchEnabled) {
    rolloutConfig.killSwitchEnabled = false;
    rolloutLogger.info({
      event: 'kill_switch_disabled',
      rolloutPercent: rolloutConfig.jobApiRolloutPercent,
    }, 'Kill switch disabled - Rollout resumed');
  }
}

/**
 * Check if kill switch is enabled.
 */
export function isKillSwitchEnabled(): boolean {
  return rolloutConfig.killSwitchEnabled;
}

/**
 * Add a user to the allowlist.
 */
export function addToAllowlist(userId: string): void {
  if (!rolloutConfig.allowlist.has(userId)) {
    rolloutConfig.allowlist.add(userId);
    rolloutLogger.info({ event: 'allowlist_add', userId }, 'User added to allowlist');
  }
}

/**
 * Remove a user from the allowlist.
 */
export function removeFromAllowlist(userId: string): void {
  if (rolloutConfig.allowlist.has(userId)) {
    rolloutConfig.allowlist.delete(userId);
    rolloutLogger.info({ event: 'allowlist_remove', userId }, 'User removed from allowlist');
  }
}

/**
 * Add a user to the blocklist.
 */
export function addToBlocklist(userId: string): void {
  if (!rolloutConfig.blocklist.has(userId)) {
    rolloutConfig.blocklist.add(userId);
    rolloutLogger.info({ event: 'blocklist_add', userId }, 'User added to blocklist');
  }
}

/**
 * Remove a user from the blocklist.
 */
export function removeFromBlocklist(userId: string): void {
  if (rolloutConfig.blocklist.has(userId)) {
    rolloutConfig.blocklist.delete(userId);
    rolloutLogger.info({ event: 'blocklist_remove', userId }, 'User removed from blocklist');
  }
}

/**
 * Get current rollout status.
 */
export function getRolloutStatus(): {
  killSwitchEnabled: boolean;
  rolloutPercent: number;
  allowlistSize: number;
  blocklistSize: number;
} {
  return {
    killSwitchEnabled: rolloutConfig.killSwitchEnabled,
    rolloutPercent: rolloutConfig.jobApiRolloutPercent,
    allowlistSize: rolloutConfig.allowlist.size,
    blocklistSize: rolloutConfig.blocklist.size,
  };
}

// ============================================================================
// Environment-based Initialization
// ============================================================================

/**
 * Initialize rollout config from environment variables.
 * Called on startup.
 */
export function initRolloutFromEnv(): void {
  // JOB_API_ROLLOUT_PERCENT: 0-100
  const percentEnv = process.env.JOB_API_ROLLOUT_PERCENT;
  if (percentEnv) {
    const percent = parseInt(percentEnv, 10);
    if (!isNaN(percent)) {
      rolloutConfig.jobApiRolloutPercent = Math.max(0, Math.min(100, percent));
    }
  }

  // JOB_API_KILL_SWITCH: true/false
  const killSwitchEnv = process.env.JOB_API_KILL_SWITCH;
  if (killSwitchEnv === 'true') {
    rolloutConfig.killSwitchEnabled = true;
  }

  // JOB_API_ALLOWLIST: comma-separated user IDs
  const allowlistEnv = process.env.JOB_API_ALLOWLIST;
  if (allowlistEnv) {
    const userIds = allowlistEnv.split(',').map(id => id.trim()).filter(Boolean);
    for (const userId of userIds) {
      rolloutConfig.allowlist.add(userId);
    }
  }

  // JOB_API_BLOCKLIST: comma-separated user IDs
  const blocklistEnv = process.env.JOB_API_BLOCKLIST;
  if (blocklistEnv) {
    const userIds = blocklistEnv.split(',').map(id => id.trim()).filter(Boolean);
    for (const userId of userIds) {
      rolloutConfig.blocklist.add(userId);
    }
  }

  rolloutLogger.info({
    event: 'rollout_initialized',
    config: getRolloutStatus(),
  }, 'Rollout configuration initialized from environment');
}

// ============================================================================
// Database-based Rollout Config (optional persistence)
// ============================================================================

/**
 * Load rollout config from database.
 * Falls back to in-memory config if not found.
 */
export async function loadRolloutFromDB(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('rollout_config')
      .select('*')
      .eq('key', 'job_api')
      .single();

    if (error) {
      // Table might not exist yet - that's OK
      rolloutLogger.debug({ error }, 'Could not load rollout config from DB (table may not exist)');
      return;
    }

    if (data) {
      const config = data.config as {
        rollout_percent?: number;
        kill_switch?: boolean;
        allowlist?: string[];
        blocklist?: string[];
      };

      if (config.rollout_percent !== undefined) {
        rolloutConfig.jobApiRolloutPercent = config.rollout_percent;
      }
      if (config.kill_switch !== undefined) {
        rolloutConfig.killSwitchEnabled = config.kill_switch;
      }
      if (config.allowlist) {
        for (const userId of config.allowlist) {
          rolloutConfig.allowlist.add(userId);
        }
      }
      if (config.blocklist) {
        for (const userId of config.blocklist) {
          rolloutConfig.blocklist.add(userId);
        }
      }

      rolloutLogger.info({
        event: 'rollout_loaded_from_db',
        config: getRolloutStatus(),
      }, 'Rollout configuration loaded from database');
    }
  } catch (err) {
    rolloutLogger.warn({ err }, 'Failed to load rollout config from DB');
  }
}

/**
 * Save current rollout config to database.
 */
export async function saveRolloutToDB(): Promise<void> {
  try {
    const configData = {
      rollout_percent: rolloutConfig.jobApiRolloutPercent,
      kill_switch: rolloutConfig.killSwitchEnabled,
      allowlist: Array.from(rolloutConfig.allowlist),
      blocklist: Array.from(rolloutConfig.blocklist),
    };

    const { error } = await supabase
      .from('rollout_config')
      .upsert({
        key: 'job_api',
        config: configData,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

    if (error) {
      rolloutLogger.warn({ error }, 'Failed to save rollout config to DB');
    } else {
      rolloutLogger.info({ event: 'rollout_saved_to_db' }, 'Rollout config saved to database');
    }
  } catch (err) {
    rolloutLogger.warn({ err }, 'Exception saving rollout config to DB');
  }
}

// ============================================================================
// Backward Compatibility
// ============================================================================

/**
 * Legacy function for backward compatibility.
 * Uses the new rollout system.
 * @deprecated Use isUserInJobApiRollout instead
 */
export function isUserAllowlistedForJobApi(userId: string): boolean {
  return isUserInJobApiRollout(userId);
}

/**
 * Legacy function for backward compatibility.
 * @deprecated Use addToAllowlist instead
 */
export function addUserToJobApiAllowlist(userId: string): void {
  addToAllowlist(userId);
}
