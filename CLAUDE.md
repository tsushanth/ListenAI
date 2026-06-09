# CLAUDE.md — instructions for Claude running in this repo

This file is read at the start of every Claude Code session. The rules below override default Claude behavior. **Always follow them.**

This repo is part of a portfolio shared between Sushanth (`t.sushanth@gmail.com`) and his wife. Multiple Claudes may be operating in parallel. The conventions exist to prevent one Claude from clobbering work, leaking secrets, or breaking a deploy because it didn't know the rules of the shared environment.

## Fly.io app for this repo

This repo deploys to Fly app **`listenai-backend`**. Authoritative deploy steps:

```bash
# Verify auth (do this first if anything goes sideways)
flyctl auth whoami

# List the secrets currently configured on Fly (source of truth — names only)
flyctl secrets list -a listenai-backend

# Deploy
flyctl deploy
```

## Hard rules for Fly secrets

1. **Fly.io is the source of truth for secrets.** `.env.example` (if present in this repo) is for local-dev hinting only. If `.env.example` and `flyctl secrets list` disagree, trust Fly.

2. **NEVER `flyctl secrets set` to overwrite or rotate an existing secret unless the user explicitly asks.** Overwriting destroys the prior value — there is no undo. This applies even when "fixing" a name (e.g. renaming `ANTHROPIC_KEY` → `ANTHROPIC_API_KEY`).

3. **NEVER `flyctl secrets unset` without explicit user approval.** Removing a secret silently breaks the running app.

4. **Adding a NEW secret is fine** if (a) the user has asked for a feature that requires it, and (b) you've confirmed the actual value with the user. Don't fabricate values from training data. Don't grep stale `.env.example` files for the value.

5. **Don't guess secret names from code.** If `process.env.X` doesn't appear in `flyctl secrets list`, three things are possible: (a) the code is dead, (b) the env var name in Fly differs from what the code reads (there may be a wrapper that aliases), or (c) there's a real gap. Ask the user before assuming (c) and adding it.

6. **`flyctl deploy` from a fresh clone is safe** — Fly's server-side secret store persists across deploys and across machines. Your push doesn't need to "ship" the secrets.

7. **Build-time vars are different.** If the `Dockerfile` declares `ARG XYZ` and uses `$XYZ` in `RUN`, that needs `--build-arg` or `--build-secret` at build time, NOT a Fly runtime secret. Check `Dockerfile` for `ARG` first.

## Pre-push secrets-scan hook (install once per machine)

This repo has a global `pre-push` hook that blocks commits containing API keys, private keys, OAuth secrets, etc. If you don't have it installed yet, run this one-time setup:

```bash
bash scripts/install-secrets-hook.sh
```

The script writes `~/.git-hooks/pre-push` and points git's global `core.hooksPath` at it. The hook then runs on every `git push` from every repo on this machine.

**Do not disable or bypass the hook without explicit user permission.** If a push is blocked, read the output — it points at the offending line/file/pattern. Fix the secret, don't work around the scanner. Bypass syntax exists (`SKIP_SECRETS_SCAN=1 git push`) but should only be used after confirming the match is a true false positive.

## LLM API keys

- **Never embed paid LLM API keys (OpenAI, Anthropic) in client-side code** — extensions, mobile apps, public web JS. Always use a server proxy. Past incident: 20+ OpenAI keys leaked across Chrome extensions, triggered a portfolio-wide migration off OpenAI.
- For local content generation in a Claude chat, generate inline — don't write a script that burns API credit when chat would do.

## Git etiquette in shared repos

- Both Sushanth and his wife may have unpushed commits on this repo. Before `git pull --rebase` or `git reset --hard`, check `git log @{u}..` to see if local work would be clobbered.
- Default to NEW commits, not `--amend`. Amending changes SHAs and forces the other clone to reconcile.
- Don't force-push to `main`. Ever.
- The pre-push hook scans the commit range being pushed — historical leaks in older commits aren't re-scanned, but anything new is.

## When you don't know something

Ask. The user's time is cheaper than a broken deploy or a leaked key. Specific questions ("what value should `STRIPE_SECRET_KEY` have for staging?") are welcome; guessing is not.
