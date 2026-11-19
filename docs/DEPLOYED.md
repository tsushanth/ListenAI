# What is deployed

One row per deployed component. Update it in the same change as every deploy. A deploy is only done once the deployed tree equals the tree on main for the deployed paths (compare trees, not commit ids, when a squash merge was used).

| Component | Fly app | Release | Image | Built from | Main commit with the same tree | Date |
|---|---|---|---|---|---|---|
| Backend (`backend/`) | `listenai-backend` | v128 (the consent phrase can be issued in Spanish or German: optional `language` on `POST /internal/voice-clone-api/consent-phrase`, the recording is transcribed and scored in the issued language, #98). Rollback: v127 (`flyctl deploy -a listenai-backend --image registry.fly.io/listenai-backend:deployment-01M7NW34A78GBHRDQH622ZDWNT`). Before v128 the row read: v127 (consent phrase check tolerates one-letter transcriber spelling slips on code words, reads "read aloud" as the brand name, logs `voice_clone_phrase_mismatch` with the issued code words and what was heard, #92). Rollback: v126 (`flyctl deploy -a listenai-backend --image registry.fly.io/listenai-backend:deployment-01M7NK20PBXHG1AGXD27YHVGAS`). Before v127 the row read: v126 (`POST /internal/voice-clone-api/warm`: starts the cloning workers early for a caller who can clone, #90). Rollback: v125 (`flyctl deploy -a listenai-backend --image registry.fly.io/listenai-backend:deployment-01M7K3B2WGFHJ7RQWPJ0GXGJ96`), then v124. Before v126 the row read: v125 (audiobook ePub chapter detection splits at TOC anchors, #83). Rollback: v124 (`flyctl deploy -a listenai-backend --image registry.fly.io/listenai-backend:deployment-01M7HKKA61EF4KDEZ21VKGVKKP`), the cold-start changes without the new detector; v121 before that (`deployment-01M7HDTP5WG5VMYC5TVMQ0VKHE`). | `deployment-01M7P52FV403X9Q0B1T07T7ZFS` (v127 was `deployment-01M7NW34A78GBHRDQH622ZDWNT` (v126 was `deployment-01M7NK20PBXHG1AGXD27YHVGAS`; `deployment-01M7NK20PBXHG1AGXD27YHVGAS` (v125 was `deployment-01M7K3B2WGFHJ7RQWPJ0GXGJ96`, sha256:1038031762ad...) is older)) | `origin/main` at `ee64027c` (clean detached worktree) | `ee64027c` (`backend/` tree `986b7fbb8498` identical, verified 18 Nov 2026) | 18 Nov 2026 (01:42 UTC) |
| Web (`web/`) | `readaloud-web` | v101 (the consent phrase language is forwarded by the REST relay `POST /api/v1/voice-clones/consent-phrase` (`?language=` or JSON body), the MCP tool `readaloud_issue_consent_phrase` (optional `language`) and the Studio, which asks for the phrase in the language chosen in step 1; web `de38990b`, #106, `web/` tree identical to main). Rollback: v100 (`flyctl deploy -a readaloud-web --image registry.fly.io/readaloud-web:deployment-01M7P5KJEB8ADMHP7N8QMM6HV7`). Earlier: v100 (developers page, Migrate from ElevenLabs page, parity table, llms.txt and shared speech-to-text facts state what is live today: expressive audio tags, dialogue, pronunciation dictionaries, forced alignment, clone in en/es/de, early realtime speech to text, history and usage, with the limits; text and tests only, #100). Rollback: v99 (`flyctl deploy -a readaloud-web --image registry.fly.io/readaloud-web:deployment-01M7P59RH03CRY0W7JEXVQ26SE`). Before v100 the row read: v99 (one sentence and one curl comment on /developers/migrate-from-elevenlabs about the optional consent phrase language, #98). Rollback: v98 (`flyctl deploy -a readaloud-web --image registry.fly.io/readaloud-web:deployment-01M7P0F8EEQGG5Z8CY4SBAZZB9`). Before v99 the row read: v98 (install-referrer tags on every Play link, vendor comparisons removed from the home page, engine names removed from /design-voice and the dubbing text; v97 was the same minus the placement rename `webpro_success` to `pro_cta`) | `deployment-01M7P5KJEB8ADMHP7N8QMM6HV7` (sha256:4200d7b60ed6...) (v99 was `deployment-01M7P59RH03CRY0W7JEXVQ26SE`) | `origin/main` at `9b2b929f` | `9b2b929f` (`web/` tree `1c9439611a6e` identical, verified 18 Nov 2026) | 18 Nov 2026 (01:53 UTC) |
| Android app (`android/`, `com.listenai`, reader flavor) | Google Play production | 2.14.58 (102), inProgress at 20% since 2026-11-18 together with 2.14.57 (101) completed. Contents: the hard-coded English sweep (#97, 351 strings in 26 locales, machine translated, needs native review), the model-name removal from user-visible text (#102), a test-only guard (#103), the version bump (#104). AAB sha256 `f07156a15fece97767c9671ccae7046667d3e8a6394c981dcdf79a99daad3285`, signed with the upload key. Device check on a Pixel 9 Pro (in-place update, 10 locales, Home, Library, Read Text, Settings): no crash, no raw tokens, Arabic mirrors; only a few sweep strings are reachable without accounts or content, so most of them were not seen on a device. Rollback: halt the rollout in Play Console, or re-upload release 101 as completed with the same edit API pattern. Never raise above 20% without the owner. Before this the row read: 2.14.57 (101), inProgress at 20% since 2026-11-16 (tag `play/2.14.57-101`, AAB sha256 `e787c7b74786cd70392bfa0124f7b5af046ac58fddf4e86e898bb319b1f4373c`), later completed. | Play bundle (not a Fly image) | `origin/main` at `214eb962` (tag `play/2.14.58-102`); built from a clean worktree of that commit | `214eb962` (`android/` tree identical, verified 18 Nov 2026) | 18 Nov 2026 |

## Switches that are on in production

- Backend (v121): `VOICE_CLONE_ML_SERVICE_URL` and `VOICE_CLONE_ML_SERVICE_SECRET` are set (names only). Clone languages in `VOICE_CLONE_ML_LANGUAGES` (unset: de, fr, es, pt, it, ja, pl, ru) go to the multilingual serving app on Modal (`readaloud-clone-ml`, scale to zero, volume `readaloud-clone-ml-voices`); every other language stays on the existing serving app (`VOICE_CLONE_SERVICE_*`, untouched). To turn the new path off: `flyctl secrets unset VOICE_CLONE_ML_SERVICE_URL VOICE_CLONE_ML_SERVICE_SECRET -a listenai-backend`.
- Backend: `RTTS_KEY_AUTH_ENABLED=true` (the public API key is accepted on the dubbing, voice conversion, voice design, audio isolation, audiobook, sound effect and speech to text routes).
- Web: all three flags in `web/src/content/launchFlags.ts` are `true`.

## Verification of v121 (2026-11-16)

Run inside the deployed backend with the real environment, public synthetic reference clips, all test voices deleted afterwards: German and Spanish clones were created on and synthesized by the multilingual serving app (creation 1.1 to 3.3 s, synthesis 1.4 s warm, 11.5 s on the first call after a cold start, watermark score 1 with the Perth scheme on both); an English clone and a Hindi clone were served by the existing serving app, unchanged (a Hindi clone is not in the multilingual list, so it keeps its old path). The full backend suite on the merged tree: 950 passed, 3 skipped, 0 failed (one earlier run had one flaky socket failure that passed on rerun).

## Clone create cold start, v122 to v124 (2026-11-16)

Cause: creating a clone touches three scale-to-zero apps in sequence, and each can take one to two minutes to start. The reference checks ran on the English serving app (150 to 390 s cold), then the consent phrase is transcribed by the batch speech-to-text app (about 60 to 120 s cold; its gateway token lives only 60 s, so a slow start came back 401), then the voice is created. Changes: reference checks and similarity now run on the multilingual app first (about 22 s cold, identical numbers) and fall back to the English one (`VOICE_CLONE_ANALYZE_ON_PRIMARY=true` restores the old routing); the serving apps and the transcription app are pinged when the consent phrase is issued and when create starts (at most one per 90 s and 20 per hour); the transcription call waits for its ping, mints a fresh token, retries once on 401, and allows 240 s. The public gateway's clone timeout is 420 s.

Measured through the public gateway with synthetic reference clips (all test voices deleted, only the October test voice remains):

| Language | Version | Create | Result |
|---|---|---|---|
| de | v122, all apps cold | 135 s | 503: transcription app cold, token expired |
| de | v123, all apps cold | 251 s | 503: the transcription request sat in a container that was stopping |
| es | v123, cold | 65 s | 200, synthesis 13 s, watermark header present |
| en | v123 | 16 s | 200 (English app already started by an earlier request), synthesis 25 s, watermark header present |
| hi | v123 | 0.2 s | 422 `unsupported_language` |
| de | v124 | 10.6 s | 400 `phrase_mismatch` (the synthetic phrase was transcribed differently; a retry passed) |
| de | v124, apps warm | 14 s | 200, synthesis 2.7 s, watermark header present |

Not verified: a completely cold German create on v124 (the run was stopped). What remains slow: with every app cold and the create sent right after the consent phrase, expect roughly one to two minutes until the transcription app is up; a person recording the phrase hides part of it. An English create with a cold English app can still take about 6 to 7 minutes (GPU capacity wait on that app), which the 420 s gateway limit only just covers.

## Verification of v125: audiobook chapter detection (2026-11-16)

Measured offline on 12 public-domain ePubs against the numbered chapter counts of their plain-text editions: strict precision 0.854 to 0.997, recall 0.966 to 1.000, books with every chapter found 2/12 to 12/12 (the one remaining extra is a dedicatory epistle kept as a long unnumbered section).

Checked inside the running v125 container with a small synthetic ePub (one XHTML file, front matter plus six chapters under anchors): six chapters returned, contents and licence entries dropped, no text from one chapter in its neighbour. The temporary script was removed afterwards; no audiobook rows or synthesis jobs were created. The HTTP route `POST /api/audiobooks` was not called, because it needs a signed-in user and creates rows and synthesis jobs.

Not done: a default pronunciation dictionary for the audiobook voice. The measurement so far is a phoneme-error proxy on 7 terms with one engine and has no word-error or speaker-similarity regression check, so it stays a follow-up.

## Verification of v126: clone warm route (2026-11-17)

An unauthenticated `POST /internal/voice-clone-api/warm` answers 401. With the gateway flag on, listing voices produced 202 from the route in the backend log, and the consent transcription worker and the multilingual clone app showed a running container 8 s later. Cold German creates (workers idle first): 48 s and 38 s without a list beforehand, 21 s and 14 s with one 25 s before. The route shares the existing wake-up throttles (once per 90 s and 20 an hour per app) and needs a verified email and a paid or complimentary plan, like a create.

## How to check parity

```
git diff <deployed ref> origin/main -- backend web        # must be empty for the deployed paths
```

If the deployed ref no longer exists (squash merge), compare trees instead: `git diff <tree-of-deployed> <tree-of-main> -- backend web`.
