# MCP → backend identity bridge

## The problem

Four features built in parallel (STT, Dubbing, Sound Effects, Audiobooks) each independently hit the same
gap: their MCP tools (`web/src/lib/mcp/server.ts`) authenticate callers with a developer/gateway API key —
validated against the realtime-tts gateway's `/tts/authorize` (or `/stt/authorize`), same mechanism
`web/src/lib/mcp/upstream.ts`'s `authorize()` already uses for TTS. But the backend Express routes those
tools need to call (`backend/src/routes/stt.ts`, `dub.ts`, `soundEffects.ts`, `audiobooks.ts`) require a
real Supabase JWT, via either `requireAuth` (`backend/src/middleware/auth.ts`) or a route-local
`requireRealAuth`-style check. An MCP tool has no JWT — only the developer's raw API key — so right now it
either can't call these routes at all, or (worse) forwards the raw key as a bearer token, which the backend
correctly rejects as an invalid JWT.

Voice Isolator skipped MCP for this exact reason rather than ship something broken.

## Is there already a fix for this? Yes, partially — one working feature already solves it, narrowly

`backend/src/routes/voiceStudioApiKey.ts` (mounted at `/internal/voice-studio-api`, reached only from the
realtime-tts gateway) already has a real key → backend-identity bridge, and it works in production today:

1. The realtime-tts **gateway** (a separate Fly app, not this backend) is the only thing that ever sees the
   raw API key. It validates the key against its own key store (`gateway/keys.js`).
2. Once validated, the gateway forwards the request to this backend with a **shared secret**
   (`x-gateway-admin-secret`, checked against `config.GATEWAY_FORWARD_SECRET` with a timing-safe compare)
   plus the **already-resolved identity** as headers: `x-gateway-uid` (the key's bound Supabase uid, if
   any) and `x-gateway-key-id` (the key's own id, used when there's no bound uid).
3. `voiceStudioApiKey.ts`'s `authenticate()` trusts the secret, reads the identity headers, and treats
   `uid || keyId` as the caller's backend identity. No JWT ever enters this path.

This is exactly the "gateway-forwarded-secret" pattern the task description points at. It is **not**
reusable as-is because it's wired inline into one router's `authenticate` callback (`createVoiceStudioRouter`
takes it as a dependency) rather than exposed as middleware any other route could mount.

`backend/src/routes/ttsApiKeys.ts`'s `requireRealAuth` is the *other* half of the picture: it's the "reject
anything that isn't a genuinely valid Supabase JWT" middleware, with **no default-user fallback** (unlike
`middleware/auth.ts`'s `requireAuth`, which silently resolves any missing/invalid/dev-mode credential to a
shared default UUID — fine for anonymous device-ID UX, actively dangerous for a billed or MCP-reachable
route). `requireRealAuth` is also not exported/reusable — it's a private function in that one route file
(see `soundEffects.ts`'s own comment on this branch, which explicitly wanted to reuse it and couldn't).

## What was built

`backend/src/middleware/apiKeyAuth.ts` — a single, reusable, exported middleware:

```ts
export async function requireAuthOrApiKey(req, res, next)
```

It generalizes both existing pieces into one thing any route can mount:

1. **Gateway-forwarded API key identity** (lifted straight out of `voiceStudioApiKey.ts`'s `authenticate`,
   generalized instead of feature-specific): trusts `x-gateway-admin-secret` against
   `config.GATEWAY_FORWARD_SECRET` (timing-safe compare), then resolves identity from `x-gateway-uid`
   (preferred) or `x-gateway-key-id` (bare-key fallback). Checked first since it's a cheap local comparison.
2. **Real Supabase JWT** (same `verifyAuthTokenRemote` call `requireRealAuth` uses) — unchanged existing
   behavior for the web app's own signed-in calls.
3. Anything else → `401`. **There is no third branch and no default/shared-user fallback anywhere in this
   file.** That's the fix for the second flagged issue (see below).

On success it sets **both** `req.userId` and `req.user = { id }`, because the four draft routes read the
resolved identity two different ways (`audiobooks.ts`/`dub.ts` read `req.user.id`; `soundEffects.ts` and
`stt.ts`'s own inline check read `req.userId`) — this way no route needs to change how it reads its own
user id, only how it gets authenticated.

## Exact per-route migration

### `backend/src/routes/stt.ts` (branch `feature/stt-productization`)

This route currently does its **own** inline strict-JWT check (`requireUser`/`requireUserMiddleware`,
lines ~104–121 of `stt.ts`) — which is *why* `backend/src/index.ts` mounts it with no `requireAuth` at all
(line 235: `app.use('/api/stt', sttRouter);`). That inline check is already correctly strict (no fallback),
it just can't accept an API key.

- In `backend/src/index.ts` line 235, change:
  ```diff
  - app.use('/api/stt', sttRouter);
  + app.use('/api/stt', requireAuthOrApiKey, sttRouter);
  ```
  and add `import { requireAuthOrApiKey } from './middleware/apiKeyAuth.js';` near the other middleware
  imports (next to `import { requireAuth } from './middleware/auth.js';`, line ~10).
- In `stt.ts`, `requireUser()` (line ~104) already checks `req.userId` first (line 106:
  `const cached = (req as Request & { userId?: string }).userId;`) before falling back to its own JWT
  verification — so once `requireAuthOrApiKey` has run and set `req.userId`, `requireUser()` short-circuits
  correctly with **zero changes needed inside `stt.ts` itself**. You can leave the inline fallback in place
  or delete it once you're confident every caller goes through the new middleware — your call, not required
  for correctness.

### `backend/src/routes/dub.ts` (branch `feature/dubbing`)

- In `backend/src/index.ts` line 238, change:
  ```diff
  - app.use('/api/dub', requireAuth, dubRouter);
  + app.use('/api/dub', requireAuthOrApiKey, dubRouter);
  ```
  (same import addition as above). `dub.ts` reads `req.user.id` (lines 400, 453) — no change needed there,
  `requireAuthOrApiKey` sets that too.

### `backend/src/routes/soundEffects.ts` (branch `feature/sound-effects`)

**This is the strict-behavior fix, not just the MCP fix — flag this explicitly to whoever merges this
branch.** `soundEffects.ts`'s own top-of-file comment already documents wanting `requireRealAuth` instead
of `requireAuth`'s default-user fallback, and couldn't get it because `requireRealAuth` wasn't exported.
`requireAuthOrApiKey` **is** exported and **has no fallback branch**, so this is now available:

- In `backend/src/index.ts` line 241, change:
  ```diff
  - app.use('/api/sound-effects', requireAuth, soundEffectsRouter);
  + app.use('/api/sound-effects', requireAuthOrApiKey, soundEffectsRouter);
  ```
  (same import addition). Note `soundEffects.ts` reads `(req as StrictAuthedRequest).userId!` — but the
  *actual* `requireAuth` in `middleware/auth.ts` only ever sets `req.user = { id }`, never `req.userId`, so
  as merged today `userId` would be `undefined` on every request regardless of this fix (a separate,
  pre-existing bug on that branch, not introduced by this change). `requireAuthOrApiKey` sets `req.userId`
  too, so **swapping the middleware also fixes that latent bug** as a side effect — but call it out in
  review since it means the route's actual runtime behavior before this branch merges (if it ever ran)
  would have been "every request 401/undefined-crashes", not "billed to a shared user."

### `backend/src/routes/audiobooks.ts` (branch `feature/audiobooks-mvp`)

- In `backend/src/index.ts` line 227, change:
  ```diff
  - app.use('/api/audiobooks', requireAuth, audiobooksRouter);
  + app.use('/api/audiobooks', requireAuthOrApiKey, audiobooksRouter);
  ```
  (same import addition). `audiobooks.ts` reads `req.user.id` (lines 104, 289, 405) — no change needed.

## What the MCP side (web/src/lib/mcp) still needs — the piece this branch could NOT build

`requireAuthOrApiKey` only solves the backend half: it lets a request carrying the gateway-forwarded-secret
headers through. Someone still has to **set** those headers on the way from an MCP tool call to the
backend. Today, per the task description, the MCP tools just forward the raw API key as a bearer token —
that has to change to instead:

1. Call the gateway's existing `/tts/authorize` (or `/stt/authorize`) with the raw key — this is the exact
   call `web/src/lib/mcp/upstream.ts`'s `authorize()` already makes, and it's what actually validates the
   key (this backend still never sees or stores raw key material, same posture as
   `voiceStudioApiKey.ts`'s comment already documents).
2. From a successful `authorize()` response, resolve the caller's identity (`ttsGatewayClient.ts`'s comment
   on `issueGatewayKey` confirms the gateway embeds the owner as a `uid` claim in the session token it
   returns) and the key id.
3. Forward the backend HTTP call with `x-gateway-admin-secret: <GATEWAY_FORWARD_SECRET>`,
   `x-gateway-uid: <uid>` (or `x-gateway-key-id: <key id>` if no bound uid), instead of an
   `Authorization: Bearer <raw key>` header.

**This requires a human decision, not a code change I could make from this worktree alone:**
`GATEWAY_FORWARD_SECRET` today is only provisioned to the backend's own environment (it's the secret the
*gateway* uses to call *this backend* for voice-studio). Making the **web/Next.js MCP server** a second
trusted forwarder means either (a) provisioning the same secret to the web deployment's environment too, or
(b) minting a separate secret scoped to "web MCP server → backend" so a leak of one doesn't compromise the
other. (b) is more correct from a blast-radius standpoint but is a provisioning decision, not something to
default silently. I did not add a `web/src/lib/mcp` helper for this because it lives in a different
package (`web/`) than this worktree's diff and depends on that secret-provisioning decision being made
first — flagging it here rather than guessing.

## Everything else

`voiceStudioApiKey.ts` itself is left unchanged on this branch — it already works, and refactoring it onto
the shared middleware is a nice-to-have cleanup (its `authenticate` callback and
`requireAuthOrApiKey`'s gateway-forwarded branch are now near-duplicates), not required for this fix. Left
as a follow-up so this branch stays scoped to the actual gap.

## Tests

`backend/src/middleware/apiKeyAuth.test.ts` (added to `backend/package.json`'s `test` script) covers:
valid JWT passes; valid gateway-forwarded API key (with and without a bound uid) resolves to the right
identity; wrong/missing forward secret is rejected even with identity headers present; missing credentials
entirely is rejected; an invalid JWT is rejected (not silently accepted); and — the specific regression this
middleware exists to prevent — an invalid/garbage JWT never falls back to a default/shared user id, unlike
`middleware/auth.ts`'s `requireAuth`.

Run: `cd backend && npm test` (all 80 tests pass, including the 8 new ones).

## Voice design, voice conversion and voice cloning (API key + MCP)

- `/api/voice-design` and `/api/voice-convert` are now mounted behind `requireAuthOrApiKey`. Their
  `requireUser()` resolves `req.userId` first, then falls back to JWT, and then **always** checks the active
  subscription (`isBillingActiveForUser`). Unlike `voiceIsolate.ts`/`stt.ts`, the billing check is not skipped
  when `req.userId` is already set; otherwise mounting the bridge would let any authenticated caller past the
  subscription gate. Consent statements and per-user rate limits are unchanged.
- Usage reports for design/convert pass the job id as the Stripe meter event `identifier`, so re-polling a
  finished job cannot bill it twice (MCP clients poll far more than the web app does).
- **Per-user converter deploy for API-key callers.** Conversion runs on a per-user Modal deployment (unless the
  global `VOICE_CONVERT_URL` fallback is configured). `POST/GET/DELETE /api/voice-convert/deploy` is reachable
  through the bridge, so an API-key caller needs no browser. A conversion with no ready deployment answers
  `400 {code: "deployment_required"}`. The MCP `convert_voice` tool reacts to that code by calling
  `POST /deploy` itself (or finding it already running; a `failed` deployment is deleted and redeployed once)
  and returns a retryable `capacity` error saying the converter is being provisioned (~3 minutes), so the
  caller just retries. Raw REST callers do the same by hand: on `deployment_required`, `POST /deploy`, poll
  `GET /deploy` until `status: "ready"`, retry.
- **Cloning** does not go through this backend bridge at all: the MCP tools call the realtime-tts gateway's
  `/v1/voices/*` with the caller's API key as bearer. `commit_voice_clone_dataset` is the billed step ($2.50).
