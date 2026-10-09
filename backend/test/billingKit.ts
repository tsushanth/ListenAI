// Shared test harness for the realtime-tts billing tests: an in-memory fake of the few Supabase table/rpc
// calls billing makes, plus prototype-level Stripe spies (the module under test builds its own private
// Stripe client, so the resource prototypes are patched, same trick as realtimeTtsBilling.music.test.ts).
// Import AFTER setting env vars. Uses require('stripe') deliberately (CJS build, see the music test).
declare const require: (id: string) => any;

type Row = Record<string, any>;

export interface Kit {
  tables: Record<string, Row[]>;
  writes: Array<{ table: string; op: string; payload: Row }>;
  rpcCalls: Array<{ fn: string; args: Row }>;
  stripeCalls: Array<{ name: string; args: unknown[] }>;
  gatewayCalls: Array<{ id: string; enabled: boolean }>;
  stripeReturns: Record<string, any>;
  stripeThrows: Record<string, Error>;
  freeCredits: Record<string, { granted: number; used: number }>;
  rpcError: boolean;
  usageRows: Array<Row>;
  usageRpcError: boolean;
  restore(): void;
}

export async function installKit(): Promise<Kit> {
  const { supabase } = await import('../src/lib/supabaseClient.js');
  const Stripe = require('stripe');
  const kit: Kit = {
    tables: { realtimetts_billing: [], realtimetts_api_keys: [], realtimetts_free_credits: [] },
    writes: [],
    rpcCalls: [],
    stripeCalls: [],
    gatewayCalls: [],
    stripeReturns: {},
    stripeThrows: {},
    freeCredits: {},
    rpcError: false,
    usageRows: [],
    usageRpcError: false,
    restore() {},
  };

  const sb = supabase as any;
  const originalFrom = sb.from;
  const originalRpc = sb.rpc;

  sb.from = (table: string) => {
    const rows = (kit.tables[table] ??= []);
    let op: 'select' | 'update' | 'upsert' | 'insert' = 'select';
    let head = false;
    let payload: Row = {};
    let onConflict: string | undefined;
    const filters: Array<(r: Row) => boolean> = [];
    let returning = false;
    const matched = () => rows.filter((r) => filters.every((f) => f(r)));
    const exec = (): any => {
      if (op === 'select' && head) return { data: null, count: matched().length, error: null };
      if (op === 'insert') {
        const row = { id: `row_${rows.length + 1}`, comped: false, created_at: 'now', revoked_at: null, ...payload };
        kit.writes.push({ table, op, payload });
        rows.push(row);
        return { data: [{ ...row }], error: null };
      }
      if (op === 'select') return { data: matched().map((r) => ({ ...r })), error: null };
      if (op === 'update') {
        const hit = matched();
        if (hit.length) kit.writes.push({ table, op, payload });
        hit.forEach((r) => Object.assign(r, payload));
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      kit.writes.push({ table, op, payload });
      const key = onConflict ?? 'id';
      const existing = rows.find((r) => r[key] === payload[key]);
      if (existing) Object.assign(existing, payload);
      else rows.push({ id: `row_${rows.length}`, comped: false, ...payload });
      return { data: null, error: null };
    };
    const b: any = {
      select(_cols?: string, opts?: { head?: boolean }) { if (op !== 'select') returning = true; if (opts?.head) head = true; return b; },
      insert(p: Row) { op = 'insert'; payload = p; return b; },
      order() { return b; },
      single: async () => { const r = exec(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: null }; },
      update(p: Row) { op = 'update'; payload = p; return b; },
      upsert(p: Row, opts?: { onConflict?: string }) { op = 'upsert'; payload = p; onConflict = opts?.onConflict; return b; },
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return b; },
      is(col: string, val: unknown) { filters.push((r) => (r[col] ?? null) === val); return b; },
      maybeSingle: async () => { const r = exec(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: null }; },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(exec()).then(resolve, reject); },
    };
    return b;
  };

  // Mirrors consume_free_credits' contract (LEAST(units, remaining), row created on first use).
  sb.rpc = async (fn: string, args: Row) => {
    // The usage ledger rpc is tracked separately so rpcCalls keeps meaning "free-credit rpcs" for the existing tests.
    if (fn === 'realtimetts_add_usage') {
      if (kit.usageRpcError) return { data: null, error: { message: 'boom' } };
      kit.usageRows.push(args);
      return { data: null, error: null };
    }
    kit.rpcCalls.push({ fn, args });
    if (kit.rpcError) return { data: null, error: { message: 'boom' } };
    const c = (kit.freeCredits[args.p_user] ??= { granted: args.p_grant, used: 0 });
    const consumed = Math.min(args.p_units, Math.max(0, c.granted - c.used));
    c.used += consumed;
    return { data: consumed, error: null };
  };

  const probe = new Stripe('sk_test_probe');
  const spy = (obj: any, method: string, name: string, dflt: any) => {
    const proto = Object.getPrototypeOf(obj);
    const original = proto[method];
    proto[method] = async (...args: unknown[]) => {
      kit.stripeCalls.push({ name, args });
      if (kit.stripeThrows[name]) throw kit.stripeThrows[name];
      const r = kit.stripeReturns[name] ?? dflt;
      return typeof r === 'function' ? r(...args) : r;
    };
    return () => { proto[method] = original; };
  };
  const restores = [
    spy(probe.billing.meterEvents, 'create', 'meterEvents.create', {}),
    spy(probe.invoiceItems, 'create', 'invoiceItems.create', { id: 'ii_1' }),
    spy(probe.subscriptions, 'retrieve', 'subscriptions.retrieve', {}),
    spy(probe.customers, 'retrieve', 'customers.retrieve', { id: 'cus_1', invoice_settings: {} }),
    spy(probe.paymentMethods, 'list', 'paymentMethods.list', { data: [] }),
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'u1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/admin/keys') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'gk_new', key: 'rtts_test_key_abcdef' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/admin/keys/billing')) {
      kit.gatewayCalls.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  kit.restore = () => {
    kit.stripeThrows = {};
    sb.from = originalFrom;
    sb.rpc = originalRpc;
    restores.forEach((r) => r());
    globalThis.fetch = originalFetch;
  };
  return kit;
}

export const billingRow = (over: Row = {}): Row => ({
  id: 'b1', user_id: 'u1', stripe_customer_id: 'cus_u1', stripe_subscription_id: 'sub_1',
  stripe_subscription_item_id: 'si_1', active: true, comped: false, ...over,
});

export const stripeMeterCalls = (kit: Kit) => kit.stripeCalls.filter((c) => c.name === 'meterEvents.create');
