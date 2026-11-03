// In-memory EntitlementStore for the web Pro entitlement tests (no Supabase, no network).
import type { EntitlementStore, SourceRow, EffectiveEntitlement } from '../src/lib/webEntitlement.js';

export function memStore() {
  const sources: SourceRow[] = [];
  const events = new Set<string>();
  const appUsers = new Map<string, string | null>(); // id -> email
  const subs = new Map<string, { plan_id: string; entitlement_managed: boolean } & Partial<EffectiveEntitlement>>();
  const calls = { writeEffective: 0, upsertSource: 0, claim: 0, release: 0 };
  let failNextUpsert = false;
  const store: EntitlementStore = {
    async claimEvent(id) { calls.claim++; if (events.has(id)) return false; events.add(id); return true; },
    async releaseEvent(id) { calls.release++; events.delete(id); },
    async findStripeSourceBySubscription(sid) { return sources.find((s) => s.source === 'stripe' && s.stripe_subscription_id === sid) ?? null; },
    async getSource(uid, source) { return sources.find((s) => s.user_id === uid && s.source === source) ?? null; },
    async findUserIdByEmail(email) {
      const hit = [...appUsers].filter(([, e]) => e?.toLowerCase() === email.toLowerCase());
      return hit.length === 1 ? hit[0]![0] : null;
    },
    async ensureAppUser(id, email) { if (!appUsers.has(id)) appUsers.set(id, email); },
    async upsertSource(row) {
      calls.upsertSource++;
      if (failNextUpsert) { failNextUpsert = false; throw new Error('db down'); }
      const i = sources.findIndex((s) => s.user_id === row.user_id && s.source === row.source);
      if (i >= 0) sources[i] = { ...row }; else sources.push({ ...row });
    },
    async listSources(uid) { return sources.filter((s) => s.user_id === uid).map((s) => ({ ...s })); },
    async getSubscription(uid) { const s = subs.get(uid); return s ? { plan_id: s.plan_id as never, entitlement_managed: s.entitlement_managed } : null; },
    async writeEffective(uid, eff) { calls.writeEffective++; subs.set(uid, { ...eff, plan_id: eff.tier, entitlement_managed: true }); },
  };
  return { store, sources, events, appUsers, subs, calls, failNextUpsert: () => { failNextUpsert = true; } };
}

