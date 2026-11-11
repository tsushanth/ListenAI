// Account deletion (Play "account deletion" requirement): orchestration only, everything injected so the order of
// the steps and the ownership guarantees are unit-tested without Supabase.
//
// Order matters and is part of the contract:
//   0. refuse ids that are not a real user (non-UUID, or one of the shared default users requireAuth falls back to)
//   1. subscription check: an active Stripe or Play subscription needs an explicit acknowledgement (we cancel nothing)
//   2. voice clones: reference audio + embeddings removed on the serving app (consent evidence is kept for its
//      retention window by design, see lib/voiceCloning/service.ts deleteVoiceClone)
//   3. gateway (developer API) keys revoked at the gateway
//   4. stored audio objects removed from storage (never an object another user's job also points at)
//   5. the user's rows removed
//   6. the auth user, LAST: until this succeeds the user can still sign in and retry; every step above is safe to repeat.
import { AppError } from '../types/index.js';
import { deleteVoiceClone, type CloneDeps } from './voiceCloning/service.js';
import type { CloneStore } from './voiceCloning/types.js';

/** requireAuth() maps a missing/invalid token to these shared users. They are never a real account and must never be deleted. */
export const SHARED_DEFAULT_USER_IDS: ReadonlySet<string> = new Set([
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubscriptionFlags {
  /** An active (or trialing / past_due) Stripe subscription, from the web checkout or the developer-API plan. */
  stripe: boolean;
  /** An active Google Play subscription known to the backend (RevenueCat ledger row). The app also checks its own entitlement. */
  play: boolean;
}

export interface StorageGroup {
  bucket: string;
  paths: string[];
}

export interface AccountStore {
  subscriptionFlags(userId: string): Promise<SubscriptionFlags>;
  /** Revokes every non-revoked developer API key at the gateway; returns how many. Throws if the gateway refuses. */
  revokeGatewayKeys(userId: string): Promise<number>;
  /** Objects owned by this user and by nobody else (shared cache objects are excluded). */
  collectStorage(userId: string): Promise<StorageGroup[]>;
  removeStorage(group: StorageGroup): Promise<void>;
  /** Deletes the user's rows, keyed only by [userId]. Tables that do not exist in this deployment are skipped. */
  deleteUserRows(userId: string): Promise<{ tablesTouched: number; tablesSkipped: string[] }>;
  /** Deletes the Supabase auth user. 'not_found' means it was already gone (idempotent success). */
  deleteAuthUser(userId: string): Promise<'deleted' | 'not_found'>;
}

export interface AccountDeletionDeps {
  store: AccountStore;
  /** Always available (used to look for voices to delete). */
  cloneStore: CloneStore;
  /** null when the voice-clone service is not configured (feature dark). */
  cloneDeps: () => CloneDeps | null;
}

export class AccountDeletionError extends AppError {
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(status, code, message, details);
    this.name = 'AccountDeletionError';
  }
}

export type DeleteAccountResult =
  | { status: 'blocked'; subscriptions: SubscriptionFlags }
  | {
    status: 'deleted';
    subscriptions: SubscriptionFlags;
    voicesDeleted: number;
    gatewayKeysRevoked: number;
    storageObjectsRemoved: number;
    authUser: 'deleted' | 'not_found';
  };

export function assertDeletableUserId(userId: string): void {
  if (!UUID_RE.test(userId) || SHARED_DEFAULT_USER_IDS.has(userId.toLowerCase())) {
    throw new AccountDeletionError(403, 'not_a_real_account', 'This request is not tied to a real account.');
  }
}

export async function deleteAccount(
  deps: AccountDeletionDeps,
  userId: string,
  opts: { acknowledgeSubscriptions: boolean },
): Promise<DeleteAccountResult> {
  assertDeletableUserId(userId);
  const { store } = deps;

  // 1. We never cancel anything financial. The user is told, and must confirm, when a subscription is still active.
  const subscriptions = await store.subscriptionFlags(userId);
  if ((subscriptions.stripe || subscriptions.play) && !opts.acknowledgeSubscriptions) {
    return { status: 'blocked', subscriptions };
  }

  // 2. Voice clones (includes disabled / half-deleted ones: listVoices only hides the already-deleted).
  const voices = await deps.cloneStore.listVoices(userId);
  let voicesDeleted = 0;
  if (voices.length > 0) {
    const cloneDeps = deps.cloneDeps();
    if (!cloneDeps) {
      // Not deleting the rows would leave the reference audio on the serving app with no owner. Retry when it is back.
      throw new AccountDeletionError(503, 'voice_service_unavailable',
        'Your cloned voices could not be removed right now. Nothing else was deleted yet. Please try again later.');
    }
    for (const v of voices) {
      // Ownership is enforced inside deleteVoiceClone (store.getVoice(id, userId)).
      await deleteVoiceClone(cloneDeps, userId, v.id);
      voicesDeleted += 1;
    }
  }

  // 3. Developer API keys.
  const gatewayKeysRevoked = await store.revokeGatewayKeys(userId);

  // 4. Stored audio.
  let storageObjectsRemoved = 0;
  for (const group of await store.collectStorage(userId)) {
    if (group.paths.length === 0) continue;
    await store.removeStorage(group);
    storageObjectsRemoved += group.paths.length;
  }

  // 5. Rows.
  await store.deleteUserRows(userId);

  // 6. The auth user, last.
  const authUser = await store.deleteAuthUser(userId);

  return { status: 'deleted', subscriptions, voicesDeleted, gatewayKeysRevoked, storageObjectsRemoved, authUser };
}
