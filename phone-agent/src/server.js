// Entry point: a WebSocket server exposing /twilio-media-stream, the URL a
// Twilio <Connect><Stream> would point at from a phone number's voice
// webhook. NOT started against a live Twilio number by this task (no
// number was provisioned, no TwiML app configured) — this file exists so
// the wiring is real and reviewable, and so `node src/server.js` is a
// genuine next step once a number + approval exist. See README.md
// "What's needed for a live demo".
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { SttRealtimeClient } from './sttClient.js';
import { PiperTtsClient } from './ttsClient.js';
import { createAnswerEngine } from './llm.js';
import { CallSession } from './session.js';
import { attachTwilioMediaStream } from './twilioBridge.js';

const STT_URL = process.env.STT_WS_URL || 'wss://api.readaloudai.org/v1/stt/realtime'; // via gateway, see DECISIONS.md for direct-worker vs gateway routing
const TTS_URL = process.env.TTS_WS_URL || 'wss://api.readaloudai.org/tts';
const GATEWAY_TOKEN = process.env.GATEWAY_API_KEY || ''; // gateway/keys.js session token or static key

async function createSessionForCall(sink, callSid) {
  const stt = new SttRealtimeClient({ url: STT_URL, token: GATEWAY_TOKEN, encoding: 'mulaw', sampleRate: 8000 }).connect();
  const tts = new PiperTtsClient({ url: TTS_URL, token: GATEWAY_TOKEN });
  const answerEngine = createAnswerEngine();
  // The bridge (twilioBridge.js) awaits this factory before calling
  // session.start() — session.start() speaks the greeting immediately, so
  // the TTS socket must already be open or that first synthesize() call is
  // silently dropped (PiperTtsClient only sends once ws.readyState is OPEN).
  await tts.connect();
  return new CallSession({
    stt, tts, answerEngine, sink,
    onEvent: (evt) => console.log(`[call ${callSid}]`, JSON.stringify(evt)),
  });
}

export function createApp() {
  const server = createServer((req, res) => { res.writeHead(200); res.end('phone-agent-mvp: ok (not accepting live Twilio traffic in this build)'); });
  const wss = new WebSocketServer({ server, path: '/twilio-media-stream' });
  wss.on('connection', (twilioWs) => attachTwilioMediaStream(twilioWs, createSessionForCall));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 8091;
  createApp().listen(port, () => console.log(`phone-agent-mvp listening on :${port} (ws path /twilio-media-stream)`));
}
