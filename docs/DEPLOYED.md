# What is deployed

One row per deployed component. Update it in the same change as every deploy. A deploy is only done once the deployed tree equals the tree on main for the deployed paths (compare trees, not commit ids, when a squash merge was used).

| Component | Fly app | Release | Image | Built from | Main commit with the same tree | Date |
|---|---|---|---|---|---|---|
| Backend (`backend/`) | `listenai-backend` | v121 (multilingual clone routing, new env names below). Rollback: v120 (`flyctl deploy -a listenai-backend --image registry.fly.io/listenai-backend:deployment-01M7E7N3CXE5KDWE9GW28DF5J9`), which carries the same code as v119 and the key-auth setting. | `deployment-01M7HDTP5WG5VMYC5TVMQ0VKHE` (sha256:7a1d19f608c6...) | `origin/main` at `9f6c183b` | `9f6c183b` (`backend/` identical) | 16 Nov 2026 (05:39 UTC) |
| Web (`web/`) | `readaloud-web` | v96 | `deployment-01M7EM1P878FC94YBBNWC1CJX5` (sha256:fa3c60c919a6...) | `origin/main` at `c514f5c4` | `c514f5c4` (`web/` identical) | 15 Nov 2026 (03:31 UTC) |

## Switches that are on in production

- Backend (v121): `VOICE_CLONE_ML_SERVICE_URL` and `VOICE_CLONE_ML_SERVICE_SECRET` are set (names only). Clone languages in `VOICE_CLONE_ML_LANGUAGES` (unset: de, fr, es, pt, it, ja, pl, ru) go to the multilingual serving app on Modal (`readaloud-clone-ml`, scale to zero, volume `readaloud-clone-ml-voices`); every other language stays on the existing serving app (`VOICE_CLONE_SERVICE_*`, untouched). To turn the new path off: `flyctl secrets unset VOICE_CLONE_ML_SERVICE_URL VOICE_CLONE_ML_SERVICE_SECRET -a listenai-backend`.
- Backend: `RTTS_KEY_AUTH_ENABLED=true` (the public API key is accepted on the dubbing, voice conversion, voice design, audio isolation, audiobook, sound effect and speech to text routes).
- Web: all three flags in `web/src/content/launchFlags.ts` are `true`.

## Verification of v121 (2026-11-16)

Run inside the deployed backend with the real environment, public synthetic reference clips, all test voices deleted afterwards: German and Spanish clones were created on and synthesized by the multilingual serving app (creation 1.1 to 3.3 s, synthesis 1.4 s warm, 11.5 s on the first call after a cold start, watermark score 1 with the Perth scheme on both); an English clone and a Hindi clone were served by the existing serving app, unchanged (a Hindi clone is not in the multilingual list, so it keeps its old path). The full backend suite on the merged tree: 950 passed, 3 skipped, 0 failed (one earlier run had one flaky socket failure that passed on rerun).

## How to check parity

```
git diff <deployed ref> origin/main -- backend web        # must be empty for the deployed paths
```

If the deployed ref no longer exists (squash merge), compare trees instead: `git diff <tree-of-deployed> <tree-of-main> -- backend web`.
