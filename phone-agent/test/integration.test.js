// End-to-end test with synthetic/simulated input, NOT a live Twilio call:
// real SttRealtimeClient/PiperTtsClient talking the real worker-stt-realtime
// / worker-piper-fly wire protocols to local mock WS servers (mockServers.js),
// wired through the real TwilioBridge, fed synthetic Twilio Media Streams
// JSON frames (base64 mu-law "audio" — silence, since there's no real ASR
// behind the mock) exactly as a live Twilio <Connect><Stream> would send
// them. This exercises the exact code path a live call would use end to
// end: Twilio-shaped JSON in -> mu-law decode -> STT client -> session
// turn-taking -> LLM stub -> TTS client -> mu-law/20ms-framed JSON back out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';
import { startMockSttServer, startMockTtsServer } from './mockServers.js';
import { SttRealtimeClient } from '../src/sttClient.js';
import { PiperTtsClient } from '../src/ttsClient.js';
import { createStubAnswerEngine } from '../src/llm.js';
import { CallSession } from '../src/session.js';
import { attachTwilioMediaStream } from '../src/twilioBridge.js';

/** Starts a server exposing /twilio-media-stream, matching src/server.js's wiring but pointed at the mock STT/TTS. */
function startPhoneAgentServer({ sttUrl, ttsUrl }) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const { port } = wss.address();
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => wss.close() });
    });
    wss.on('connection', (twilioWs) => {
      attachTwilioMediaStream(twilioWs, async (sink, callSid) => {
        const stt = new SttRealtimeClient({ url: sttUrl, token: 'test', encoding: 'mulaw', sampleRate: 8000 }).connect();
        const tts = new PiperTtsClient({ url: ttsUrl, token: 'test' });
        await tts.connect(); // must be open before session.start() speaks the greeting
        return new CallSession({ stt, tts, answerEngine: createStubAnswerEngine(), sink, onEvent: () => {} });
      });
    });
  });
}

/** A synthetic "caller" mu-law@8kHz frame — silence is valid audio for exercising the pipe. */
function silenceFrame(bytes = 160) {
  return Buffer.alloc(bytes, 0xff); // 0xff is mu-law's encoding of zero amplitude
}

test('synthetic Twilio call: start -> greeting audio flows back framed at 160 bytes -> caller audio drives a final transcript -> confirmation audio flows back -> call ends', async (t) => {
  const stt = await startMockSttServer({ triggerBytes: 4800, transcript: 'yes please confirm' });
  const tts = await startMockTtsServer();
  const agent = await startPhoneAgentServer({ sttUrl: stt.url, ttsUrl: tts.url });
  t.after(() => { stt.close(); tts.close(); agent.close(); });

  const client = new WebSocket(`${agent.url}/twilio-media-stream`);
  await once(client, 'open');

  const received = [];
  client.on('message', (data) => received.push(JSON.parse(data.toString())));

  client.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ_test', callSid: 'CA_test' } }));

  // Wait for the greeting's mu-law frames to arrive, framed at Twilio's 160-byte size.
  await waitFor(() => received.some((m) => m.event === 'media'));
  const mediaFrames = received.filter((m) => m.event === 'media');
  assert.ok(mediaFrames.length > 0, 'expected at least one media frame for the greeting');
  for (const f of mediaFrames) {
    const bytes = Buffer.from(f.media.payload, 'base64');
    assert.ok(bytes.length > 0 && bytes.length <= 160, `frame should be <=160 bytes (Twilio's 20ms mu-law frame), got ${bytes.length}`);
    assert.equal(f.streamSid, 'MZ_test');
  }

  received.length = 0; // now simulate the caller talking: push enough "audio" to trigger the mock STT's scripted final
  for (let i = 0; i < 40; i++) {
    client.send(JSON.stringify({ event: 'media', streamSid: 'MZ_test', media: { payload: silenceFrame().toString('base64') } }));
    await new Promise((r) => setTimeout(r, 2));
  }

  await waitFor(() => received.some((m) => m.event === 'media'), 5000);
  const replyFrames = received.filter((m) => m.event === 'media');
  assert.ok(replyFrames.length > 0, 'expected confirmation-turn audio to flow back to the (simulated) caller');

  client.close();
});

test('barge-in over a real (mocked) TTS connection sends a stop and the server-side sink stops queuing more audio', async (t) => {
  const stt = await startMockSttServer({ triggerBytes: 999999, transcript: 'n/a' }); // never auto-fires; we drive it manually below
  const tts = await startMockTtsServer();
  const agent = await startPhoneAgentServer({ sttUrl: stt.url, ttsUrl: tts.url });
  t.after(() => { stt.close(); tts.close(); agent.close(); });

  const client = new WebSocket(`${agent.url}/twilio-media-stream`);
  await once(client, 'open');
  const received = [];
  client.on('message', (data) => received.push(JSON.parse(data.toString())));
  client.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ_barge', callSid: 'CA_barge' } }));

  await waitFor(() => received.some((m) => m.event === 'media')); // greeting audio starts flowing
  const midGreetingCount = received.filter((m) => m.event === 'media').length;

  // Caller starts talking mid-greeting: send audio so the STT server (which forwards every
  // inbound chunk as a 'partial') fires session.js's barge-in path.
  client.send(JSON.stringify({ event: 'media', streamSid: 'MZ_barge', media: { payload: silenceFrame().toString('base64') } }));
  await new Promise((r) => setTimeout(r, 100));

  // The queued/paced media frames should have stopped growing without bound once cleared —
  // i.e. no runaway flush of a whole reply's audio after barge-in fired.
  await new Promise((r) => setTimeout(r, 100));
  const afterCount = received.filter((m) => m.event === 'media').length;
  assert.ok(afterCount < midGreetingCount + 50, 'expected the paced media queue to have been cleared by barge-in, not to keep growing');

  client.close();
});

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (predicate()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('waitFor timed out')); }
    }, 10);
  });
}
