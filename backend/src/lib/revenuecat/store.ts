import { supabase } from '../supabaseClient.js';
import type { ApplyRecord, PlanId } from './events.js';

export type ApplyResult = 'applied' | 'duplicate' | 'stale';
export interface EntitlementRow { user_id: string; plan_id: PlanId; status: 'active' | 'expired'; expires_at: string | null }

export interface RevenueCatStore {
  apply(rec: ApplyRecord): Promise<ApplyResult>;
  getEntitlement(userId: string): Promise<EntitlementRow | null>;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export const supabaseRevenueCatStore: RevenueCatStore = {
  async apply(r) {
    const { data, error } = await supabase.rpc('apply_revenuecat_event', {
      p_event_id: r.eventId, p_event_type: r.eventType, p_user_id: r.userId, p_event_ts_ms: r.eventTsMs,
      p_status: r.status, p_plan_id: r.planId, p_product_id: r.productId, p_store: r.store,
      p_expires_at: iso(r.expiresAtMs), p_canceled_at: iso(r.canceledAtMs), p_cancel_reason: r.cancelReason,
    });
    if (error) throw error;
    if (data !== 'applied' && data !== 'duplicate' && data !== 'stale') throw new Error(`unexpected apply result ${String(data)}`);
    return data;
  },
  async getEntitlement(userId) {
    const { data, error } = await supabase.from('revenuecat_entitlements')
      .select('user_id, plan_id, status, expires_at').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return (data as EntitlementRow | null) ?? null;
  },
};
