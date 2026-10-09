# ReadAloud admin dashboard (API business view): design spec

Date: 2026-10-08. Status: design approved section by section by the owner; this written spec awaits owner review. DESIGN ONLY, nothing built.

## 1. Intent and success criteria
The /admin page (web/src/app/admin/page.tsx) shows only reporter-Worker data (health of one backend probe, issues, events) and "No usage reported yet" because nothing feeds the Worker's usage table. Goal: an admin view like the Calldesk hub (calldesktech src/app/admin) for the API business: who the real customers are, what they use, what needs attention, whether the services are healthy.
Success: the owner opens /admin on the API tab and sees, without running any query: real-customer account and key counts (owner accounts excluded), TTS characters and STT audio minutes for 24 h / 7 d / 30 d, free-credit burn, paid customers, a signup-to-paid funnel, a customers table, worker health, and a short "needs attention" list. First viewer is the owner only.
Out of scope for v1: the App (consumer) tab beyond what exists today, per-customer drill-down pages, margin/cost display, alerts by email.

## 2. Architecture (approved section 1)
- New backend endpoint `GET /api/admin/dashboard?range=24h|7d|30d` in listenai-backend. It authenticates the caller itself: Supabase bearer token, Google identity provider, confirmed email, email on the admin allowlist (same rule as web/src/lib/adminAuth.ts, ADMIN_EMAILS). Any other caller gets 404, as the current web route does. No new shared secret.
- Web: a thin Next route `/api/admin/dashboard` forwards the Authorization header to the backend and returns its JSON (no-store). The existing `/api/admin/overview` (reporter Worker: health, issues, events) is unchanged. The page merges both.
- Exclusion of the owner's own accounts: env var `ADMIN_EXCLUDE_EMAILS` (comma-separated) on listenai-backend, resolved to auth user ids and filtered out of every number. No migration, no schema flag.

## 3. Page layout, API tab (approved section 2)
Header (title, App/API tabs, range selector 24h/7d/30d, Refresh); Needs attention; Health strip; Stat cards; Funnel; Customers table; Charts (phase 2); Issues and recent events (existing).
- Needs attention rules (start set): a worker down or slow; a paying key whose usage report failed; a key out of free credits with no card; Stripe webhook failures; a one-key usage spike.
- Health strip: backend, gateway, Piper, Kokoro, batch STT: up/down, latency, "asleep (cold)" for scale-to-zero workers. Piper and gateway are probed by the backend; Kokoro and STT are NOT probed (a probe wakes a Modal container and costs money): they show the last real request's outcome.
- Stat cards: API accounts and active keys (excluding owner), TTS characters and STT audio minutes for the range, requests, free credits used vs granted, paid customers, estimated billed usage from Stripe.
- Funnel: signed up -> created a key -> first request -> used up free credits -> added a card.
- Customers table: full email (admin only), signed up, keys, first and last request, 7-day usage, credits left, status (free / paid / at limit). Sortable.
- App tab: unchanged in v1.

## 4. Data, security and failure handling (approved section 3)
- Constraint: the gateway `/admin/usage/drain` returns each key's usage and CLEARS it; the backend already drains every 5 minutes to bill Stripe (reportUsageToStripe in backend/src/lib/realtimeTtsBilling.ts). Per-day TTS usage must therefore be recorded at that same drain, never by a second reader (it would steal usage and under-bill).
- New table `realtimetts_usage_daily(day date, gateway_key_id text, engine text, units numeric, requests integer, primary key(day, gateway_key_id, engine))`, row-level security ON, service-role access only. Written by upsert-add inside the existing drain path. The write is wrapped so a failure can never fail or delay billing. TTS history starts when this ships.
- STT history already exists in `stt_transcriptions` (migration 032 adds a `surface` column); STT charts need no new writes. TO VERIFY: that rows carry per-key duration.
- Response is independent sections `attention, health, totals, funnel, customers, series`; one section failing returns `{error}` for that section only and the page shows "Could not load X".
- Security: admin-only, 404 otherwise, `Cache-Control: no-store`, parameterized queries, read-only endpoint, only the stored key preview is ever shown (never a raw key), no new secret.
- Testing: aggregate tests against a fake database; auth tests (no token, non-admin, email/password login of the admin address, valid admin); drain-hook tests (idempotent, never throws into billing); page component tests with fixtures; a manual production check.

## 5. Rollout and risks (approved section 4)
Phases: P1 = migration + drain hook + endpoint + redesigned API tab (health, attention, cards, funnel, customers). P2 = charts (new accounts/day, TTS chars/day, STT minutes/day), Stripe backfill if meter events allow, daily headline metrics pushed to the Worker `/v1/usage` so the existing usage views fill. P3 (optional) = App tab, per-customer drill-down.
Deploy order: migration (owner applies the SQL in the Supabase editor; I verify the schema), then the drain hook alone to listenai-backend from a clean worktree (own commits only; check Fly releases/branch first) and watch 2-3 drain cycles, then the endpoint, then the web page. New config: `ADMIN_EXCLUDE_EMAILS` on listenai-backend (value supplied by the owner at deploy time; not stored in the repo).
Risks: the billing-path hook (guarded, tested, deployed alone first); history starts empty (charts labelled "since <date>"); unverified facts to confirm during the build: `stt_transcriptions` per-key duration, which Stripe fields give billed usage, the exact drain output shape (normalizeGatewayDrain in ttsGatewayClient.ts), how Kokoro/STT last-request outcomes can be read without a probe.
