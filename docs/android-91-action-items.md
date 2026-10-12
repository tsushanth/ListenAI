# ReadAloud Android 2.14.47 (91): action items

Version 91 went to Google Play production at 100% on 2026-10-11 (PR #5 merged, main = versionCode 91).
The backend `paywall` config block was deployed to Fly (`listenai-backend`, release v107).

## Action items (owner)

1. **Watch for crashes and ANRs for the next 1-2 days.** There was no staged cushion at 100%.
   Check the Play Console (Android vitals) for 2.14.47, especially onboarding and the player, which this
   release touched most. If crash rates rise, halt by rolling back or shipping a fix as 92.
2. **Revoke the RevenueCat API key that was pasted into a Claude chat.** Dashboard: ReadAloud project
   (`proj83f86ab8`), API keys, delete the read-only v2 key. It is stored only in `~/.claude.json` (the
   `revenuecat` MCP entry); remove it with `claude mcp remove revenuecat` once revoked.

## Related follow-ups

- **Check the funnel in about a week.** Compare day-1 retention and paywall-to-purchase against the
  2026-10-11 baseline: 1,728 Android customers ever, 0.35% ever paid, 88% seen on a single day. Firebase now
  receives onboarding / paywall / first_listen / playback events; RevenueCat gets `last_paywall_*` attributes.
- **Server-side paywall tuning does not work in 91.** The app fetched `api.listenai.app/api/config`, which
  does not resolve; the real backend is `listenai-backend.fly.dev`. Fixed on branch `fix/paywall-config-host`
  (one-line change). It only reaches users in the next release (92). Until then the app uses its built-in
  defaults (2 sessions after a first listen, 3 without, 24h cooldown).
- Intermittent "Read now" no-op (not reproduced) and the "Enjoying ReadAloud?" rating dialog right after the
  first listen (existing behavior) are still open.
