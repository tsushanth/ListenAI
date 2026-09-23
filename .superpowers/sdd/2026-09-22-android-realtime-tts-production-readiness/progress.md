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

## Task 4: Autoscaling — BLOCKED, not complete
- BASE: adc021a, implementer commit eecdec1 (pushed to origin)
- Implementer DONE_WITH_CONCERNS: fly.toml changes deployed (connections-type concurrency, soft/hard limits below MAX_CONNECTIONS=4, mounts volume removed as structurally required), load_test.py/LOAD_TEST.md are real working tooling, ran 3 real load tests against production. Real negative result: 30/60 timeouts, machine count flat at 2 the whole run — autoscaling did not fire.
- Root causes (external, not code bugs): (1) installed flyctl v0.4.95 does not parse max_machines_running at all — confirmed independently by controller via `fly config show -a piper-tts-sjc` (field genuinely absent from live config). Unknown whether the real deploy pipeline uses a different/newer flyctl. (2) Org-wide Fly machine quota exhausted (`fly scale count 4` failed: "organization has reached its machine limit") — ~30 apps share one quota. Correctly not worked around (cross-cutting infra/billing decision, escalated not silently bypassed).
- Task reviewer (agent a8a7f88481047c9d4): Spec compliance ❌ (qualified — code correct, but the brief's actual deliverable, proof that 1→N scaling works, is unmet). Code quality ✅. One Important nuance: "[mounts] removal is reversible" was overstated — one machine (68354e9c424108) was actually destroyed and replaced by Fly's own HA logic, not paused; the volume itself is safely preserved (detached, not deleted).
- Ruling: this is an environmental/infra blocker, not a fixable code defect — no further fix-loop dispatch. Reported directly to user. Requires human action: (a) confirm what flyctl version the real prod deploy pipeline uses, (b) raise Fly org machine quota via billing@fly.io or free capacity from another app.
- Task 4: BLOCKED — parked, not marked complete. Code changes are real and deployed; the task's actual goal (verified autoscaling) is not achieved.

## Summary: Tasks 4-8 dispatch complete
- Task 4: BLOCKED (external infra, needs human action — flyctl/quota)
- Task 5: complete (done directly, no commit)
- Task 6: complete, reviewed clean (2 parked minors)
- Task 7: complete, reviewed clean (1 parked minor)
- Task 8: complete, reviewed clean (2 parked minors), build verified by controller
- All Tasks 6+7+8 merged into one branch (sdd-task6-backend-proxy @ 89eaf94), pushed to origin.
- Full-plan whole-branch review + finishing-a-development-branch NOT yet run — Task 4 being blocked means the plan as a whole is not done; pending user direction on how to proceed given the Task 4 blocker.

## On-device verification (physical Pixel 9 Pro, controller-run, 2026-09-23)
- Merged android-realtime-tts-migration (b294606) + sdd-task6-backend-proxy (Tasks 6+7+8, 89eaf94) via fast-forward (sdd-task6-backend-proxy was already a direct descendant) — clean, no conflicts. Pushed to origin.
- Built and installed real APK on connected device (`./gradlew installReaderDebug`), imported real text, tapped play.
- FIRST real finding: authorize() returned a genuine 404 NOT_FOUND. Root cause found: Task 6's backend route (reviewed clean, merged to git) had never actually been deployed to production listenai-backend.fly.dev — last real deploy was 15h52m stale, predating today's work. This is exactly the kind of gap only a real on-device/integration test catches; unit/integration tests all ran against local test servers, not the real deployed backend.
- Fixed: ran `fly deploy -a listenai-backend` for real. Verified via direct curl (200, real token + wss:// url, no key leaked) and via a second on-device attempt.
- Second on-device attempt: full real success. Logs show RealtimeTTSService picked, real WAV synthesized and played to completion (0:03/0:03, "Full" badge), using the real per-voice mapping (Bella -> af_bella -> synthesized via Piper). This is the first genuine end-to-end proof of the whole migration working on real hardware.
- Ruling: backend deploys are NOT automatic on merge in this project — a real deploy step is required and was missing from the plan's task list. Noting this as a process gap for future SDD plans touching this backend.

## Task 4: CLOSED — genuinely complete
- Closure commit 4a683b2 reviewed (agent abd29b3e8488fdcf9): Spec compliance ✅, Code quality ✅. Real machine-state transition (1 started/3 stopped -> all 4 started) tied directly to a load-test run, independently re-verified by both the closure implementer and this reviewer as qualitatively different evidence from the original blocked report (not a re-narration). Numbers diverging slightly from the controller's own earlier run (55/60 vs 48/60, needed a second run for clean 40/40) correctly treated as live-system variance, not smoothed over — a good-faith signal.
- Task 4: COMPLETE (adc021a..4a683b2, reviewed clean)

## Final whole-branch reviews + fix wave
- ReadAloudAI whole-branch review (agent ac405be0474d8a3dc): NOT READY -> READY WITH NOTED CONCERNS after fixing the blocker. Critical: leaked platform API key found live on PUBLIC GitHub repo (tsushanth/ListenAI, 4 branches) despite being removed from HEAD in Task 8. Controller revoked the key immediately at the gateway (id 5134f777-a9fe-48c8-9ccb-84120409e9a6), confirmed dead via direct curl (401). Important findings: /api/realtime-tts/authorize is an open proxy (requireAuth defaults unauthenticated to "pro user"); isAvailable() health-checks the wrong dependency (old gateway, not new backend-proxy).
- realtime-tts whole-branch review (agent a0a540ab86b516762): READY WITH NOTED CONCERNS. Storage/autoscaling integration independently re-verified sound. Important findings: fly.toml/LOAD_TEST.md contradictory root-cause narratives; LOAD_TEST.md pass-criteria contradicts its own recorded results; fly scale count 4 undocumented (silent regression risk on fresh deploy); MAX_CACHED_VOICE_FILES=200 unbounded-by-bytes risk on unsized root disk.
- Fix wave (parallel, one per repo):
  - ReadAloudAI (agent adc12e5a480f42e44, commit 1233113): added dedicated IP-keyed rate limit (10/5min) on /api/realtime-tts/authorize on top of existing burstRateLimit + documented intentional no-real-auth design (deferred: real per-user auth, explicitly out of scope, needed before public launch). Fixed isAvailable() to check both backend+gateway health. Reused BACKEND_URL, fixed misleading error messages, removed stray "(Task 5)" comment. Real verification: backend npm test 35/35, tsc clean, Android gradle build+test BUILD SUCCESSFUL (SDK was available in that environment this run).
  - realtime-tts (agent adc5317eb13d23da7, commit f7fa71e): reconciled fly.toml/LOAD_TEST.md into one consistent root-cause story; fixed pass-criteria to the real clean 12/40 run, kept 20/60 as labeled overload probe; documented fly scale count 4 in TIGRIS_SETUP.md; lowered MAX_CACHED_VOICE_FILES 200->80 (~5GB). Controller independently verified REAL production disk size via `fly ssh console`: 7.8G total, 7.3G available — 80-entry estimate confirmed safe with real headroom, not just an assumption. Updated CAPACITY_PLAN.md; deliberately did not add TIGRIS_BUCKET fail-fast (voice_storage=None looks like an intentional local-dev degradation path).
- Scoped re-reviews of both fix commits dispatched (agents a517496683bec9aeb, a73cb5668df4126c8) — in progress.
