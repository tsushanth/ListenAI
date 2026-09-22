# SDD ledger — plan: docs/superpowers/plans/2026-09-22-android-realtime-tts-production-readiness.md

## Workspace note
Plan spans two repos. Piece 1/2 (Tasks 1-4) execute in worktree
~/Documents/GitHub/worktrees/sdd-prod-readiness-realtime-tts (branch sdd-prod-readiness,
off realtime-tts main @ 7411989). Piece 3/4 (Tasks 5-8) execute in worktree
~/Documents/GitHub/worktrees/sdd-prod-readiness-readaloudai (branch sdd-prod-readiness,
off ReadAloudAI android-realtime-tts-migration @ b294606, which already contains
today's checkpointed test-build RealtimeTTSService.kt/TTSService.kt that Tasks 7-8 modify).
This ledger lives in the ReadAloudAI worktree but tracks both.

## Preflight conflict scan

| Pair | Shares | Produces / Consumes | Finding |
|---|---|---|---|
| Task1 -> Task2 | none directly (Task1 creates voice_storage.py; Task2 modifies server.py) | Task1 produces `VoiceStorage(bucket, endpoint_url, cache_dir, max_cache_entries)` w/ `get/put/delete/list_ids`; Task2 consumes exactly these names/signatures | clean |
| Task2 -> Task3 | env var names | Task2 defines `TIGRIS_BUCKET`, `TIGRIS_ENDPOINT_URL` in server.py; Task3 sets them as Fly secrets with matching names | clean |
| Task3 <-> Task4 | `worker-piper-fly/fly.toml` | Task3's Files list claims "Modify: fly.toml" but none of Task3's 6 steps actually edit fly.toml (all are `fly storage create`/`fly secrets set`/requirements.txt/docs/backfill - Tigris config goes via secrets, not fly.toml). Task4 is the only task with real fly.toml edits ([http_service] block). | **Plan defect**: Task3's Files list over-claims fly.toml. Ruling: Task3 does not touch fly.toml; only Task4 does. Not a same-file conflict once corrected. |
| Task5 -> Task6 | env var name | Task5 mints key, stores as `REALTIME_TTS_API_KEY` Fly secret; Task6 reads `process.env.REALTIME_TTS_API_KEY` | clean |
| Task7 <-> Task8 | `RealtimeTTSService.kt` | Task7 wires `PiperVoiceMapping.resolve(voice)` into `synthesizeOverWebSocket`; Task8 rewrites `authorize()` in the same file, removing `API_KEY`. Sequential edits to the same file, same order as the plan's own task numbering. | clean - correctly sequential, SDD dispatches one implementer at a time anyway |
| Task2 self-consistency | test fixture assumption | Task2 Step1's test assumes `test_engine_inprocess.py` already has a reachable small test onnx via `MODEL_PATH` for its existing tests | Assumed by the plan, not verified here - implementer should confirm and flag if false rather than fabricate a fixture |

## Rulings (preflight)

- Ruling: Task 3 does not modify `fly.toml` (Tigris config is Fly secrets only); only Task 4 touches `fly.toml`. Cost if wrong: negligible - if Task 3's implementer discovers a real fly.toml need, that's new information handled in that task's own review loop, not blocked by this ruling.


## Task 1: Tigris client wrapper with LRU disk cache
- BASE: 7411989 (realtime-tts worktree)
- Dispatched implementer (haiku), agent a7f5833b2b6f34337
- Review: spec compliant; quality Needs fixes. Important findings: (1) race on concurrent get() for same uncached vid, no per-vid locking around fetch/rename; (2) blanket ClientError handling on model.onnx fetch masks real S3/auth errors as "not found" instead of only 404/NoSuchKey.
- Fix round 1/5: resuming implementer a7f5833b2b6f34337 with both findings
- Fix round 1/5: 2/2 addressed, 0 open (commits d17aa7f..1699b45)
- Task 1: minor (deferred): test_get_distinguishes_not_found_from_access_errors doesn't actually inject a non-404 ClientError, so the RuntimeError branch is unverified by any test
- Task 1: minor (deferred): unlocked read at end of get() has a pre-existing-style TOCTOU with concurrent LRU eviction (not introduced by this fix, not closed by it either)
- Task 1: complete (commits 7411989..1699b45, 2 parked minors)

## Task 2: Wire VoiceStorage into get_engine and admin endpoints
- BASE: 1699b45
- Dispatched implementer (sonnet), agent a11ebb0585e9e55fd
- Review: spec compliant, quality Approved. All three implementer-flagged concerns confirmed sound (local TestClient not a gap, VOICES_DIR correctly repurposed as pure local cache, tests are real/load-bearing not vacuous).
- Task 2: minor (deferred): voice_storage import placed mid-file, not with top imports
- Task 2: minor (deferred): admin_delete_voice/admin_list_voices HTTP endpoints untested (test exercises VoiceStorage.delete/list_ids directly, not through HTTP layer)
- Task 2: minor (deferred): admin_put_voice reads all VOICE_FILES fully into memory before voice_storage.put() - matches brief's own pseudocode verbatim (plan-mandated), flagged for large voices only
- Task 2: complete (commits 1699b45..0c936d0, review clean, 3 parked minors)

## Task 3: Provision Tigris storage (real production infra)
- BASE: 0c936d0
- User explicitly confirmed: dispatch as subagent like others, despite real production side effects (fly storage create, fly secrets set -a piper-tts-sjc, backfill republish)
- Ruling carried into dispatch: Task 3 does not touch fly.toml (per preflight ruling)
- Dispatched implementer (sonnet), agent a7fcfcc35fe29a948
- Prior implementer was cut off mid-run (session ended). Controller verified real state directly against production: bucket exists, secrets set, Dockerfile fix (boto3 + voice_storage.py COPY) was salvageable and committed as 901198d. TIGRIS_SETUP.md never written, code never deployed, backfill status unverifiable/treated as not done.
- Re-dispatched fresh implementer (sonnet) to finish: deploy, write setup doc, run+verify backfill. Agent a694590ef9df7fd77.
- Finished by fresh implementer: deployed Tigris-aware code to piper-tts-sjc (healthy), backfilled all 69 tier A+B voices into piper-voices-prod, verified via GET /admin/voices (69 entries) AND a real end-to-end /v1/tts/stream synthesis call against custom:en-us-joe (200, ~119KB PCM) - genuine round-trip proof, not just an admin-endpoint check. Commit adc021a (TIGRIS_SETUP.md) on top of the already-committed 901198d Dockerfile fix.
- Task 3: complete (commits 0c936d0..adc021a, real production deploy+backfill verified)

## Task 5: Dedicated API key for the app (done directly by controller, not dispatched)
- Rotated ADMIN_SECRET on realtime-tts-gateway (safe, isolated secret), minted API key "readaloud-android-app-backend-proxy" (id 78c7df8c-1624-4748-a34e-d34220257a1c), enabled billing, stored as REALTIME_TTS_API_KEY secret on listenai-backend (verified real app name via `fly apps list`). listenai-backend redeployed and health-checked (200) afterward.
- Task 5: complete (no commits — infra-only action)

## Tasks 4, 6, 7: dispatched in parallel (separate worktrees/repos, no file overlap)
- Task 4 (realtime-tts repo, worktree sdd-prod-readiness-realtime-tts, BASE adc021a): first dispatch (agent ac70107aedf64d735) incorrectly self-reported BLOCKED without testing filesystem access. Re-dispatched (agent a4838ceddaf9510f9) with explicit instruction to test cd/git status before concluding anything. In progress.
- Task 6 (ReadAloudAI repo, new worktree sdd-task6-backend-proxy, BASE b294606): dispatched (agent a66576a999a873916). In progress.
- Task 7 (ReadAloudAI repo, new worktree sdd-task7-voice-mapping, BASE b294606): dispatched (agent a7270ecc6ca3e3c33). Implementer reported DONE (commit 116ffd2). Controller independently verified all 10 mapping-table voice ids exist in real voices/catalog.json. Task reviewer (agent a319d6b73508c07bc): Spec compliance ✅, Code quality ✅, one Minor finding (adam's mapping coincidentally equals fallback value, slightly weakens one test's discriminating power) — parked, no action required.
- Task 7: complete (commit b294606..116ffd2, review clean, 1 parked minor)
- Task 6: implementer DONE (commit 408b2ec). Two deviations flagged (node:test instead of vitest — repo's real convention, verified; gateway contract based on web/src/lib/mcp/upstream.ts instead of the brief's mismatched config.ts reference — verified correct). Task reviewer (agent a030fc7cfd18cf316): Spec compliance ✅, Code quality ✅, 2 Minor findings (no ws(s):// URL scheme validation on returned url; coarse 502 doesn't distinguish 401/402/429) — parked, no action required.
- Task 6: complete (commit b294606..408b2ec, review clean, 2 parked minors)

## Task 6 + 7 merge (prerequisite for Task 8)
- Merged sdd-task7-voice-mapping into sdd-task6-backend-proxy worktree: clean merge, no conflicts (backend vs android, no file overlap). Merge commit e27c9a1.

## Task 8: Point app at backend-proxy, remove embedded key
- BASE: e27c9a1 (merge commit, has both Task 6 + Task 7)
- Dispatched implementer (sonnet), agent a77167d4f1a8d65a6, work in /Users/sushanthtiruvaipati/Documents/GitHub/worktrees/sdd-task6-backend-proxy. In progress.
- Task 8: implementer DONE_WITH_CONCERNS (commit 89eaf94) — no Android SDK in implementer's sandbox, so build/on-device verification (brief Step 3) wasn't performed there. Controller independently ran `./gradlew assembleReaderDebug` in the real worktree (ANDROID_HOME set, real SDK on this machine): BUILD SUCCESSFUL. Task reviewer (agent a8d0c9a44863c8ab3): independently grepped tree for the old embedded key (zero hits), verified authorize() request shape against Task 6's real route code line-by-line, verified the reused empty-bearer header against CloudTTSService.kt directly. Spec compliance ✅, Code quality ✅. 2 Minor findings (inert empty auth header - matches existing app convention, not enforced by backend yet; BACKEND_BASE_URL duplicates a literal already hardcoded in ~7 other files - pre-existing codebase pattern) — parked, no action required. Missing on-device manual test explicitly assessed by reviewer as acceptable residual, not blocking, given the narrow verified diff and clean build.
- Task 8: complete (commit e27c9a1..89eaf94, review clean, 2 parked minors, build verified by controller)
