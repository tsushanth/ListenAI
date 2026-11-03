/** Supabase-backed EntitlementStore (service role). Needs migration 036 (MIGRATION-NOT-APPLIED until the owner runs it). */
import { supabase } from './supabaseClient.js';
import type { EffectiveEntitlement, EntitlementSource, EntitlementStore, SourceRow } from './webEntitlement.js';

const SOURCE_COLUMNS =
  'user_id, source, tier, status, stripe_customer_id, stripe_subscription_id, current_period_end, canceled_at, last_event_created';

function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`entitlement store: ${what} failed: ${error?.message ?? 'unknown error'}`);
}

/** Escape LIKE wildcards so an email such as a_b@x.com is matched literally by ilike. */
const likeLiteral = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const supabaseEntitlementStore: EntitlementStore = {
  async claimEvent(eventId, type) {
    const { error } = await supabase.from('stripe_webhook_events').insert({ event_id: eventId, type });
    if (!error) return true;
    if (error.code === '23505') return false; // primary key violation: already processed
    return fail('claimEvent', error);
  },

  async releaseEvent(eventId) {
    const { error } = await supabase.from('stripe_webhook_events').delete().eq('event_id', eventId);
    if (error) fail('releaseEvent', error);
  },

  async findStripeSourceBySubscription(subscriptionId) {
    const { data, error } = await supabase
      .from('entitlement_sources')
      .select(SOURCE_COLUMNS)
      .eq('source', 'stripe')
      .eq('stripe_subscription_id', subscriptionId)
      .limit(1);
    if (error) fail('findStripeSourceBySubscription', error);
    return (data?.[0] as SourceRow | undefined) ?? null;
  },

  async getSource(userId, source: EntitlementSource) {
    const { data, error } = await supabase
      .from('entitlement_sources')
      .select(SOURCE_COLUMNS)
      .eq('user_id', userId)
      .eq('source', source)
      .limit(1);
    if (error) fail('getSource', error);
    return (data?.[0] as SourceRow | undefined) ?? null;
  },

  async findUserIdByEmail(email) {
    const { data, error } = await supabase.from('app_users').select('id').ilike('email', likeLiteral(email.trim())).limit(2);
    if (error) fail('findUserIdByEmail', error);
    return data && data.length === 1 ? (data[0] as { id: string }).id : null;
  },

  async ensureAppUser(userId, email) {
    // Insert-if-missing: subscriptions.user_id references app_users(id). Never overwrites an existing profile row.
    const { error } = await supabase
      .from('app_users')
      .upsert({ id: userId, ...(email ? { email } : {}) }, { onConflict: 'id', ignoreDuplicates: true });
    if (error) fail('ensureAppUser', error);
  },

  async upsertSource(row) {
    const { error } = await supabase
      .from('entitlement_sources')
      .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id,source' });
    if (error) fail('upsertSource', error);
  },

  async listSources(userId) {
    const { data, error } = await supabase.from('entitlement_sources').select(SOURCE_COLUMNS).eq('user_id', userId);
    if (error) fail('listSources', error);
    return (data ?? []) as SourceRow[];
  },

  async getSubscription(userId) {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('plan_id, entitlement_managed')
      .eq('user_id', userId)
      .limit(1);
    if (error) fail('getSubscription', error);
    const row = data?.[0] as { plan_id: SourceRow['tier']; entitlement_managed: boolean | null } | undefined;
    return row ? { plan_id: row.plan_id, entitlement_managed: row.entitlement_managed === true } : null;
  },

  async writeEffective(userId: string, eff: EffectiveEntitlement) {
    const { error } = await supabase.from('subscriptions').upsert(
      {
        user_id: userId,
        plan_id: eff.tier,
        status: eff.status,
        stripe_customer_id: eff.stripe_customer_id,
        stripe_subscription_id: eff.stripe_subscription_id,
        current_period_end: eff.current_period_end,
        canceled_at: eff.canceled_at,
        entitlement_managed: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
    if (error) fail('writeEffective', error);
  },
};
