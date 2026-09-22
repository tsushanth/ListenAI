// Holds the dedicated, billing-enabled realtime-tts platform API key
// (REALTIME_TTS_API_KEY, minted per docs/superpowers/plans/2026-09-22-android-realtime-tts-production-readiness.md
// step "Mint the app's own realtime-tts key") server-side and forwards session-authorize calls to the
// realtime-tts platform (api.readaloudai.org) on behalf of the mobile app, so the raw platform key never
// ships in the APK. Mirrors web/src/lib/mcp/upstream.ts's authorize() (same gateway, same {key, engine}
// contract) but this route only needs the token/url hand-off, not the WebSocket relay that upstream.ts also
// does for the MCP server.
import { Router } from 'express';

export const realtimeTtsRouter = Router();

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

realtimeTtsRouter.post('/authorize', async (req, res) => {
  const apiKey = process.env.REALTIME_TTS_API_KEY;
  if (!apiKey) {
    realtimeTtsLogger.error('REALTIME_TTS_API_KEY is not configured');
    res.status(500).json({ error: 'realtime-tts not configured' });
    return;
  }
  const engine = typeof req.body?.engine === 'string' ? req.body.engine : 'piper';

  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY_URL}/tts/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: apiKey, engine }),
    });
  } catch (err) {
    realtimeTtsLogger.error({ err }, 'realtime-tts gateway unreachable');
    res.status(502).json({ error: 'realtime-tts gateway unreachable' });
    return;
  }

  if (!upstream.ok) {
    // Never forward the upstream response body verbatim: it's attacker/operator-controlled text from the
    // gateway and, more importantly, this is the one place a misbehaving gateway could echo the key we just
    // sent it back in an error body. Log it (server-side only) and return a fixed, key-free message.
    const body = await upstream.text().catch(() => '');
    realtimeTtsLogger.error({ status: upstream.status, body }, 'realtime-tts authorize failed');
    res.status(502).json({ error: 'realtime-tts authorize failed' });
    return;
  }

  const data = (await upstream.json().catch(() => null)) as { token?: string; url?: string } | null;
  if (!data?.token || !data.url) {
    realtimeTtsLogger.error({ data }, 'realtime-tts authorize returned an unexpected response');
    res.status(502).json({ error: 'realtime-tts authorize failed' });
    return;
  }

  res.status(200).json({ token: data.token, url: data.url });
});
