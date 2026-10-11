'use strict';
// LLM usage accounting client: one dependency-free file, copy it into an app (see README "LLM spend").
// Records tokens and cost per day / model / feature and reports them to the central Worker (POST /v1/llm) so every admin page can
// show who spends what. It stores counts and dollars only: never prompts, answers or user ids.
//
//   const { createLlmUsage } = require('./llmUsage');
//   const llm = createLlmUsage({ app: 'calldesk' });             // key from LLM_USAGE_KEY or FAILURE_REPORTER_KEY
//   llm.instrument(anthropicClient);                              // every messages.create / messages.stream is recorded
//   await llm.withFeature('post_call_qa', () => anthropic.messages.create({...}));   // optional label for the breakdown
//   llm.record({ model, usage: json.usage, feature: 'chat' });    // for raw fetch / axios callers
//
// Reporting never throws and never delays a request: rows are batched in memory and sent every 30 s.
// Version: llm-usage 1

const { AsyncLocalStorage } = require('node:async_hooks');

const DEFAULT_URL = 'https://app-failure-reporter.t-sushanth.workers.dev/v1/llm';

// USD per million tokens, from Anthropic's pricing page (2026-10-10) and checked against the org's own cost report for the models in use.
// [input, output, cache write 5m, cache write 1h, cache read]. Models not listed fall back by family and are marked estimated.
const P = (i, o, c5, c1, cr) => ({ in: i, out: o, cw5: c5, cw1: c1, cr, known: true });
const PRICES = {
  'claude-fable-5-1': P(10, 50, 12.5, 20, 0.25), 'claude-fable-5': P(10, 50, 12.5, 20, 1),
  'claude-mythos-5-1': P(10, 50, 12.5, 20, 0.25), 'claude-mythos-5': P(10, 50, 12.5, 20, 1),
  'claude-opus-5-5': P(4, 20, 5, 8, 0.2), 'claude-opus-5': P(5, 25, 6.25, 10, 0.5),
  'claude-opus-4-8': P(5, 25, 6.25, 10, 0.5), 'claude-opus-4-7': P(5, 25, 6.25, 10, 0.5), 'claude-opus-4-6': P(5, 25, 6.25, 10, 0.5), 'claude-opus-4-5': P(5, 25, 6.25, 10, 0.5),
  'claude-opus-4-1': P(15, 75, 18.75, 30, 1.5), 'claude-opus-4': P(15, 75, 18.75, 30, 1.5),
  'claude-sonnet-5-5': P(2, 10, 2.5, 4, 0.1), 'claude-sonnet-5': P(2, 10, 2.5, 4, 0.2),
  'claude-sonnet-4-6': P(3, 15, 3.75, 6, 0.3), 'claude-sonnet-4-5': P(3, 15, 3.75, 6, 0.3), 'claude-sonnet-4': P(3, 15, 3.75, 6, 0.3),
  'claude-haiku-5-5': P(0.1, 0.5, 0.125, 0.2, 0.01), // prompts over 100k tokens pay HAIKU_55_LONG
  'claude-haiku-4-5': P(1, 5, 1.25, 2, 0.1), 'claude-haiku-3-5': P(0.8, 4, 1, 1.6, 0.08),
};
const HAIKU_55_LONG = P(0.5, 2.5, 0.625, 1, 0.05);
const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

/** Normalises 'claude-haiku-4-5-20251001' and similar to the table key. */
function normalizeModel(model) {
  return String(model || 'unknown').toLowerCase().replace(/-\d{8}$/, '').replace(/-latest$/, '');
}

function priceFor(model) {
  const m = normalizeModel(model);
  if (PRICES[m]) return PRICES[m];
  const family = /opus/.test(m) ? P(5, 25, 6.25, 10, 0.5) : /sonnet/.test(m) ? P(3, 15, 3.75, 6, 0.3) : /haiku/.test(m) ? P(1, 5, 1.25, 2, 0.1) : P(5, 25, 6.25, 10, 0.5);
  return { ...family, known: false };
}

const n0 = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

/** Normalises an API `usage` object into counts. */
function readUsage(u) {
  u = u || {};
  const cc = u.cache_creation || {};
  const cw5 = cc.ephemeral_5m_input_tokens !== undefined ? n0(cc.ephemeral_5m_input_tokens) : n0(u.cache_creation_input_tokens);
  const cw1 = n0(cc.ephemeral_1h_input_tokens);
  return { input: n0(u.input_tokens), output: n0(u.output_tokens), cacheWrite5m: cw5, cacheWrite1h: cw1, cacheRead: n0(u.cache_read_input_tokens), webSearches: n0(u.server_tool_use && u.server_tool_use.web_search_requests) };
}

/** Dollar cost of one response. Returns { usd, estimated } where estimated means the model's price is a family fallback. */
function costOf(model, usage) {
  const u = readUsage(usage);
  let p = priceFor(model);
  if (normalizeModel(model) === 'claude-haiku-5-5' && u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead > 100000) p = { ...HAIKU_55_LONG, known: true };
  const usd = (u.input * p.in + u.output * p.out + u.cacheWrite5m * p.cw5 + u.cacheWrite1h * p.cw1 + u.cacheRead * p.cr) / 1e6 + u.webSearches * WEB_SEARCH_USD;
  return { usd, estimated: !p.known };
}

const randomId = () => Array.from({ length: 20 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const FEATURE_OK = /^[a-z0-9_.:-]{0,60}$/i;

function createLlmUsage(opts) {
  opts = opts || {};
  if (!opts.app) throw new Error('createLlmUsage: app is required');
  const env = (typeof process !== 'undefined' && process.env) || {};
  const url = opts.url || env.LLM_USAGE_URL || DEFAULT_URL;
  const key = opts.key || env.LLM_USAGE_KEY || env.FAILURE_REPORTER_KEY || '';
  const now = opts.now || Date.now;
  const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const log = opts.log || (() => {});
  const maxKeys = opts.maxPending || 500;
  const flushMs = opts.flushMs === undefined ? 30000 : opts.flushMs;
  const enabled = opts.enabled !== false && !!key && !!doFetch;
  const als = new AsyncLocalStorage();
  let pending = new Map();
  let flushing = null;
  let timer = null;

  const dayOf = () => new Date(now()).toISOString().slice(0, 10);
  const featureName = (f) => { const v = String(f == null ? (als.getStore() || '') : f); return FEATURE_OK.test(v) ? v : ''; };

  function add(model, feature, ok, usage) {
    const u = readUsage(usage);
    const { usd } = ok ? costOf(model, usage) : { usd: 0 };
    const k = `${dayOf()}|${normalizeModel(model)}|${feature}`;
    const r = pending.get(k) || { calls: 0, errors: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
    r.calls += 1; if (!ok) r.errors += 1;
    r.input_tokens += u.input; r.output_tokens += u.output; r.cache_read_tokens += u.cacheRead; r.cache_write_tokens += u.cacheWrite5m + u.cacheWrite1h; r.cost_usd += usd;
    pending.set(k, r);
    if (pending.size > maxKeys) pending.delete(pending.keys().next().value); // oldest first; accounting must never grow without bound
  }

  /** Record one finished call. `usage` is the API response's usage object. Safe to call from anywhere; never throws. */
  function record({ model, usage, feature, ok = true } = {}) {
    try { if (enabled) { add(model, featureName(feature), ok, usage); schedule(); } } catch (e) { log('llm-usage record failed: ' + (e && e.message)); }
  }

  function schedule() {
    if (timer || !flushMs) return;
    timer = setTimeout(() => { timer = null; flush(); }, flushMs);
    if (timer.unref) timer.unref();
  }

  function items(snapshot) {
    return [...snapshot.entries()].map(([k, r]) => { const [day, model, feature] = k.split('|'); return { day, model, feature, ...r, cost_usd: Math.round(r.cost_usd * 1e6) / 1e6 }; });
  }

  /** Sends everything pending. Resolves when done; a failure keeps the rows for the next flush (4xx other than 429 drops them). */
  function flush() {
    if (flushing) return flushing;
    if (!enabled || pending.size === 0) return Promise.resolve();
    const snapshot = pending; pending = new Map();
    flushing = (async () => {
      const all = items(snapshot);
      for (let i = 0; i < all.length; i += 50) {
        const chunk = all.slice(i, i + 50);
        try {
          const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Report-Key': key }, body: JSON.stringify({ batch_id: randomId(), items: chunk }), signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
          if (res.ok) continue;
          if (res.status >= 400 && res.status < 500 && res.status !== 429) { log('llm-usage rejected (' + res.status + '), batch dropped'); continue; }
          throw new Error('HTTP ' + res.status);
        } catch (e) {
          log('llm-usage send failed, will retry: ' + (e && e.message));
          for (const r of chunk) { // put the rows back (merged) for the next flush
            const k = `${r.day}|${r.model}|${r.feature}`; const cur = pending.get(k);
            if (cur) { for (const f of ['calls', 'errors', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd']) cur[f] += r[f]; }
            else pending.set(k, { calls: r.calls, errors: r.errors, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, cache_write_tokens: r.cache_write_tokens, cost_usd: r.cost_usd });
          }
          for (const rest of all.slice(i + 50)) { const k = `${rest.day}|${rest.model}|${rest.feature}`; if (!pending.has(k)) pending.set(k, { calls: rest.calls, errors: rest.errors, input_tokens: rest.input_tokens, output_tokens: rest.output_tokens, cache_read_tokens: rest.cache_read_tokens, cache_write_tokens: rest.cache_write_tokens, cost_usd: rest.cost_usd }); }
          schedule();
          return;
        }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  /** Runs fn with a feature label that every call inside it inherits (async-safe). */
  function withFeature(name, fn) { return als.run(String(name), fn); }

  function failure(model, feature) { record({ model, feature, ok: false }); }

  /**
   * Wraps client.messages.create and client.messages.stream. The SDK's own return value is passed through untouched; recording is a
   * side branch that handles success and failure, so it cannot change what the caller sees. Returns an uninstall function.
   */
  function instrument(client) {
    const messages = client && client.messages;
    if (!messages || messages.__llmUsage) return () => {};
    const origCreate = messages.create && messages.create.bind(messages);
    const origStream = messages.stream && messages.stream.bind(messages);
    const label = () => featureName();
    // The SDK's messages.stream() helper calls messages.create({ stream: true }) on this same object. Without this guard each streamed
    // turn would be recorded twice (once by each wrapper): detect the helper by its header, and by a flag set while stream() runs.
    let inStreamHelper = false;
    const isHelperCall = (rest) => inStreamHelper || !!(rest[0] && rest[0].headers && rest[0].headers['X-Stainless-Helper-Method'] === 'stream');
    if (origCreate) messages.create = function create(params, ...rest) {
      if (isHelperCall(rest)) return origCreate(params, ...rest);
      const feature = label(); const model = params && params.model;
      let out;
      try { out = origCreate(params, ...rest); } catch (e) { failure(model, feature); throw e; }
      if (params && params.stream) return wrapRawStream(out, model, feature);
      if (out && typeof out.then === 'function') out.then((res) => record({ model: (res && res.model) || model, usage: res && res.usage, feature }), () => failure(model, feature));
      return out;
    };
    if (origStream) messages.stream = function stream(params, ...rest) {
      const feature = label(); const model = params && params.model;
      let s;
      inStreamHelper = true;
      try { s = origStream(params, ...rest); } catch (e) { failure(model, feature); throw e; } finally { inStreamHelper = false; }
      if (s && typeof s.on === 'function') { s.on('finalMessage', (m) => record({ model: (m && m.model) || model, usage: m && m.usage, feature })); s.on('error', () => failure(model, feature)); }
      return s;
    };
    Object.defineProperty(messages, '__llmUsage', { value: true, configurable: true });
    return () => { if (origCreate) messages.create = origCreate; if (origStream) messages.stream = origStream; delete messages.__llmUsage; };
  }

  // create({ stream: true }) returns a promise of an async-iterable of events: usage arrives in message_start and message_delta.
  function wrapRawStream(promise, model, feature) {
    if (!promise || typeof promise.then !== 'function') return promise;
    return promise.then((stream) => {
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream;
      const total = {}; let m = model; let done = false;
      const finish = (ok) => { if (done) return; done = true; ok ? record({ model: m, usage: total, feature }) : failure(m, feature); };
      return new Proxy(stream, { get(target, prop, recv) {
        if (prop !== Symbol.asyncIterator) { const v = Reflect.get(target, prop, target); return typeof v === 'function' ? v.bind(target) : v; }
        return async function* () {
          try {
            for await (const ev of target) {
              if (ev && ev.type === 'message_start' && ev.message) { m = ev.message.model || m; Object.assign(total, ev.message.usage || {}); }
              else if (ev && ev.type === 'message_delta' && ev.usage) Object.assign(total, ev.usage);
              yield ev;
            }
            finish(true);
          } catch (e) { finish(false); throw e; }
        };
      } });
    }, (e) => { failure(model, feature); throw e; });
  }

  if (typeof process !== 'undefined' && process.once) process.once('beforeExit', () => { flush(); });
  return { record, instrument, withFeature, flush, enabled, costOf, pending: () => pending.size };
}

module.exports = { createLlmUsage, costOf, priceFor, readUsage, normalizeModel, PRICES };
