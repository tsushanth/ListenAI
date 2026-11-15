# What is deployed

One row per deployed component. Update it in the same change as every deploy. A deploy is only done once the deployed tree equals the tree on main for the deployed paths (compare trees, not commit ids, when a squash merge was used).

| Component | Fly app | Release | Image | Built from | Main commit with the same tree | Date |
|---|---|---|---|---|---|---|
| Backend (`backend/`) | `listenai-backend` | v119 (code), v120 (setting `RTTS_KEY_AUTH_ENABLED=true`) | `deployment-01M7E7N3CXE5KDWE9GW28DF5J9` (sha256:8c0839b9ff3b...) | branch `deploy/p0-2026-11-14` at `eb3d57c8` | `cb69dc31` (`backend/` identical) | 14 Nov 2026 |
| Web (`web/`) | `readaloud-web` | v95 | `deployment-01M7E9TY0D0GYEYDEP1XFE1W46` (sha256:b5fae67ab9db...) | branch `deploy/p0-2026-11-14` at `eb3d57c8` | `cb69dc31` (`web/` identical) | 14 Nov 2026 |

## Switches that are on in production

- Backend: `RTTS_KEY_AUTH_ENABLED=true` (the public API key is accepted on the dubbing, voice conversion, voice design, audio isolation, audiobook, sound effect and speech to text routes).
- Web: all three flags in `web/src/content/launchFlags.ts` are `true`.

## How to check parity

```
git diff <deployed ref> origin/main -- backend web        # must be empty for the deployed paths
```

If the deployed ref no longer exists (squash merge), compare trees instead: `git diff <tree-of-deployed> <tree-of-main> -- backend web`.
