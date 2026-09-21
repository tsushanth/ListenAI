// Minimal stand-ins for worker-stt-realtime and worker-piper-fly that speak
// their real wire protocols (see the docstrings in the actual server.py
// files this mirrors) over a local WebSocket server. Used so the
// integration test exercises SttRealtimeClient/PiperTtsClient/CallSession/
// TwilioBridge exactly as a live call would — same client code, same
// message shapes — without needing network access, real models, or Twilio.
//
// The STT mock can't actually transcribe synthetic audio (there's no real
// speech in a sine-wave test clip), so it's *scripted*: after it has seen
// >= `triggerBytes` of inbound audio in the current utterance, it emits a
// partial, then a final with a preset transcript. Everything downstream
// (session.js's turn handling, barge-in wiring, the LLM stub, TTS
// synthesis, and Twilio-frame pacing on the way out) is exercised for
// real, unmocked.
import { WebSocketServer } from 'ws';

export function startMockSttServer({ port = 0, triggerBytes = 3200, transcript = 'yes' } = {}) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port }, () => {
      const addr = wss.address();
      resolve({ url: `ws://127.0.0.1:${addr.port}`, close: () => wss.close() });
    });
    wss.on('connection', (ws) => {
      let bytesThisUtterance = 0;
      let firedFinal = false;
      ws.send(JSON.stringify({ type: 'ready', engine: 'mock' }));
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          let msg;
          try { msg = JSON.parse(data.toString()); } catch { return; }
          if (msg.type === 'commit' && !firedFinal) {
            firedFinal = true;
            ws.send(JSON.stringify({ type: 'final', segment: 0, text: transcript, start_s: 0, end_s: 1, reason: 'commit' }));
          }
          return;
        }
        bytesThisUtterance += data.length;
        ws.send(JSON.stringify({ type: 'partial', text: transcript.slice(0, 1), start_s: 0, audio_s: bytesThisUtterance / 8000 }));
        if (bytesThisUtterance >= triggerBytes && !firedFinal) {
          firedFinal = true;
          ws.send(JSON.stringify({ type: 'final', segment: 0, text: transcript, start_s: 0, end_s: bytesThisUtterance / 8000, reason: 'vad' }));
        }
      });
    });
  });
}

/** Synthetic PCM16 "audio" (silence is fine — the test only checks framing/format, not content). */
function synthPcm16(seconds, sampleRate = 24000) {
  const n = Math.round(seconds * sampleRate);
  return Buffer.alloc(n * 2); // all-zero PCM16LE == silence, valid audio bytes
}

export function startMockTtsServer({ port = 0 } = {}) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port }, () => {
      const addr = wss.address();
      resolve({ url: `ws://127.0.0.1:${addr.port}`, close: () => wss.close() });
    });
    wss.on('connection', (ws) => {
      let cancelled = false;
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'stop') { cancelled = true; return; }
        if (msg.type !== 'synthesize') return;
        cancelled = false;
        const pcm = synthPcm16(0.2);
        ws.send(JSON.stringify({ type: 'chunk_meta', text: '', gen_ms: 5, audio_s: 0.2, providers: ['mock'], format: 'pcm16', sample_rate: 24000 }));
        // Give a `stop` sent immediately after synthesize a chance to land before we'd emit 'done'.
        setTimeout(() => {
          if (cancelled) { ws.send(JSON.stringify({ type: 'cancelled' })); return; }
          ws.send(pcm);
          ws.send(JSON.stringify({ type: 'done' }));
        }, 10);
      });
    });
  });
}
