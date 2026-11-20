// Holds the dedicated, billing-enabled realtime-tts platform API key
// (REALTIME_TTS_API_KEY, minted per docs/superpowers/plans/2026-09-22-android-realtime-tts-production-readiness.md
// step "Mint the app's own realtime-tts key") server-side and forwards session-authorize calls to the
// realtime-tts platform (api.readaloudai.org) on behalf of the mobile app, so the raw platform key never
// ships in the APK. Mirrors web/src/lib/mcp/upstream.ts's authorize() (same gateway, same {key, engine}
// contract) but this route only needs the token/url hand-off, not the WebSocket relay that upstream.ts also
// does for the MCP server.
import { Router } from 'express';
import { ttsQuota as defaultQuota, type TtsQuota, type Admission } from '../lib/ttsQuota.js';
import { isTtsTestBypass, logTestBypassUsed } from '../lib/ttsTestBypass.js';

// SECURITY NOTE: this router is mounted (see index.ts) behind requireAuth, but requireAuth defaults
// any request with a missing/invalid/empty bearer token to a shared "pro user" instead of rejecting
// it — intentional elsewhere in this app (a generous free tier for apps without real per-user auth
// set up), and the Android app deliberately sends an empty `Bearer ` token here (matching
// CloudTTSService.kt's existing pattern). That means this route is effectively callable by anyone
// with no real authentication, and every successful call mints a session billed against the shared
// REALTIME_TTS_API_KEY. It is bounded by realtimeTtsAuthorizeRateLimit (see middleware/rateLimit.ts,
// IP-keyed, stricter than the general burstRateLimit) so an anonymous caller can't cheaply run up
// real GPU/CPU billing — but that's a cost bound, not authentication. This must be revisited (real
// per-user auth, or a session-bound quota) before any public, non-invite-only launch.

// Deliberately not using lib/logger.js here: that module imports lib/config.js, which eagerly validates
// the full Supabase env at import time — overkill for this route, which touches no Supabase config, and
// it would force every consumer (including this route's own unit tests) to provide Supabase secrets just
// to log an error. console.error still lands in Cloud Run/Fly's structured log capture.
const realtimeTtsLogger = {
  error: (obj: unknown, msg?: string) => console.error('[realtimeTts]', msg ?? '', obj),
};

// Same default as web/src/lib/mcp/upstream.ts's GATEWAY — the realtime-tts platform's public,
// client-facing host. Deliberately distinct from config.TTS_GATEWAY_URL (realtime-tts-gateway.fly.dev),
// which is the separate admin API used by ttsGatewayClient.ts to issue/revoke keys.
const GATEWAY_URL = process.env.REALTIME_TTS_GATEWAY_URL || 'https://api.readaloudai.org';

// Per-install quota, per-minute limit and global circuit breaker: see lib/ttsQuota.ts (in-memory, per instance;
// the backend never sees the text, so characters are charged as a per-authorize estimate).
const VOICE_ID_RE = /^[a-z0-9._-]{1,64}$/;
// Public ids of the studio-tier voices the app may ask for over this route (the multilingual GPU worker's two voices). Env STUDIO_APP_VOICES
// (comma list) overrides; anything else sent as {"engine":"studio","voice":...} answers 400 UNKNOWN_VOICE.
function studioAppVoices(): Set<string> {
  const raw = (process.env.STUDIO_APP_VOICES ?? 'mira,remy').split(',').map((v) => v.trim()).filter((v) => VOICE_ID_RE.test(v));
  return new Set(raw);
}
const TIER_TO_GATEWAY_ENGINE: Record<string, string> = { live: 'piper', studio: 'kokoro' };

export function createRealtimeTtsRouter(quota: TtsQuota = defaultQuota): Router {
const router = Router();

  router.post('/authorize', async (req, res) => {
    const apiKey = process.env.REALTIME_TTS_API_KEY;
    if (!apiKey) {
      realtimeTtsLogger.error('REALTIME_TTS_API_KEY is not configured');
      res.status(500).json({ error: 'realtime-tts not configured' });
      return;
    }

    // Optional X-Install-Id (random UUID from the app). Absent/malformed -> stricter anonymous bucket keyed by IP, so
    // app versions that do not send it keep working.
    // Tester bypass (lib/ttsTestBypass.ts): a request with the valid X-Tts-Test-Key skips the quota entirely (nothing is
    // reserved, so nothing is refunded); the express limiters skip it too. Off unless TTS_TEST_BYPASS_KEY is set.
    const bypass = isTtsTestBypass(req);
    let admission: Admission | null = null;
    if (bypass) {
      logTestBypassUsed();
    } else {
      const decision = quota.admit(req.get('x-install-id'), req.ip);
      if (!decision.ok) {
        if (decision.retryAfterSeconds !== undefined) res.set('Retry-After', String(decision.retryAfterSeconds));
        res.status(decision.status).json(decision.body);
        return;
      }
      admission = decision;
    }
    const refund = () => { if (admission) quota.refund(admission); };

    // Clients may name the tier (`live` / `studio`, the only public engine names) or send the legacy engine id (still accepted
    // unchanged). The tier names are translated to the gateway's engine ids here, so no engine id has to be public.
    const requested = typeof req.body?.engine === 'string' ? req.body.engine : 'live';
    // STUDIO ROUTE: {"engine":"studio","voice":"<public voice id>"} (the Android app, for a studio-tier voice). The gateway picks the worker by the
    // voice (the multilingual GPU worker for Mira and Remy, answered at a neutral host, woken here so its cold start overlaps the app's connect).
    // Without a voice, `studio` keeps its old meaning (the English studio worker), and every other request is untouched, so shipped app builds
    // that always send {"engine":"piper"} behave exactly as before.
    const voice = typeof req.body?.voice === 'string' && VOICE_ID_RE.test(req.body.voice) ? req.body.voice : undefined;
    const studioVoice = requested === 'studio' && voice !== undefined;
    if (studioVoice && !studioAppVoices().has(voice)) {
      refund();
      res.status(400).json({ error: 'UNKNOWN_VOICE' });
      return;
    }
    const engine = TIER_TO_GATEWAY_ENGINE[requested] ?? requested;
    // Optional: the app asks for word timings. Forwarded only when literally true; the gateway answers {alignment: true|false}
    // and, when true, returns the alignment worker's WebSocket URL (which adds `words` to each chunk_meta message).
    // The studio worker has no word timings, so alignment is never asked of it (the answer says alignment:false).
    const wantAlignment = req.body?.alignment === true;
    const forwardAlignment = wantAlignment && !studioVoice;

    let upstream: Response;
    try {
      upstream = await fetch(`${GATEWAY_URL}/tts/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Studio route: no explicit engine, the voice decides (gateway registry), and the answer must say it reached the studio tier.
        body: JSON.stringify({ key: apiKey, ...(studioVoice ? { voice } : { engine }), ...(forwardAlignment ? { alignment: true } : {}) }),
      });
    } catch (err) {
      realtimeTtsLogger.error({ err }, 'realtime-tts gateway unreachable');
      refund();
      res.status(502).json({ error: 'realtime-tts gateway unreachable' });
      return;
    }

    if (!upstream.ok) {
      // Never forward the upstream response body verbatim: it's attacker/operator-controlled text from the
      // gateway and, more importantly, this is the one place a misbehaving gateway could echo the key we just
      // sent it back in an error body. Log it (server-side only) and return a fixed, key-free message.
      const body = await upstream.text().catch(() => '');
      realtimeTtsLogger.error({ status: upstream.status, body }, 'realtime-tts authorize failed');
      refund();
      res.status(502).json({ error: 'realtime-tts authorize failed' });
      return;
    }

    const data = (await upstream.json().catch(() => null)) as { token?: string; url?: string; alignment?: boolean; tier?: string; warm?: boolean } | null;
    if (!data?.token || !data.url) {
      realtimeTtsLogger.error({ data }, 'realtime-tts authorize returned an unexpected response');
      refund();
      res.status(502).json({ error: 'realtime-tts authorize failed' });
      return;
    }

    // The studio route must have reached the studio tier. A gateway that does not know the voice (or an older gateway that ignores `voice`) answers
    // the default Live engine, which would read the text in the wrong voice (the loop the app saw): refuse instead, the app uses the phone voice.
    if (studioVoice && data.tier !== 'studio') {
      realtimeTtsLogger.error({ tier: data.tier }, 'studio voice did not reach the studio tier');
      refund();
      res.status(400).json({ error: 'UNKNOWN_VOICE' });
      return;
    }

    // `alignment` is only present when the app asked for it; an older gateway that ignores the field yields false.
    res.status(200).json({
      token: data.token,
      url: data.url,
      ...(wantAlignment ? { alignment: forwardAlignment && data.alignment === true } : {}),
      // Hint only: a GPU wake-up was requested at the gateway (the studio worker scales to zero; cold start measured in docs/studio-voice-routing.md).
      ...(studioVoice && typeof data.warm === 'boolean' ? { warm: data.warm } : {}),
    });
  });

  return router;
}

export const realtimeTtsRouter = createRealtimeTtsRouter();
