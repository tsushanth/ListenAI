// Thin client for worker-stt-realtime's WebSocket protocol (see
// realtime-tts/worker-stt-realtime/server.py, docstring at the top of that
// file for the full wire format). This module only depends on `ws` and a
// url/token — it doesn't know it's being fed by Twilio vs. a test harness.
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';

/**
 * events emitted: 'ready', 'loading', 'partial', 'speculative_final',
 * 'resume', 'final', 'usage', 'error', 'close'
 * Each partial/final/speculative_final event object is passed through
 * verbatim from the server (see server.py's `ev.append(...)` payload shapes).
 */
export class SttRealtimeClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url - e.g. wss://<host>/v1/stt/realtime
   * @param {string} opts.token - session token or static AUTH_TOKEN
   * @param {'pcm16'|'mulaw'} [opts.encoding='mulaw'] - Twilio audio is
   *   already mu-law@8kHz, so the default here avoids a redundant decode/
   *   re-encode round trip; a browser/test client sending PCM16 should pass
   *   'pcm16'.
   * @param {number} [opts.sampleRate=8000]
   * @param {number} [opts.endpointMs=500] - silence (ms) before a "final"
   */
  constructor({ url, token, encoding = 'mulaw', sampleRate = 8000, endpointMs = 500 }) {
    super();
    this.url = url;
    this.token = token;
    this.encoding = encoding;
    this.sampleRate = sampleRate;
    this.endpointMs = endpointMs;
    this.ws = null;
    this.ready = false;
  }

  connect() {
    const qs = new URLSearchParams({
      token: this.token || '',
      encoding: this.encoding,
      sample_rate: String(this.sampleRate),
      endpoint_ms: String(this.endpointMs),
    });
    this.ws = new WebSocket(`${this.url}?${qs}`);
    this.ws.binaryType = 'nodebuffer';

    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({
        type: 'config', encoding: this.encoding, sample_rate: this.sampleRate,
        endpoint_ms: this.endpointMs, semantic_hint: true, partials: true,
      }));
    });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return; // stt server never sends binary
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'ready') this.ready = true;
      this.emit(msg.type, msg);
    });
    this.ws.on('close', () => { this.ready = false; this.emit('close'); });
    this.ws.on('error', (err) => this.emit('error', err));
    return this;
  }

  /** Send one chunk of raw audio bytes (already in `this.encoding`). */
  sendAudio(buf) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf, { binary: true });
  }

  /** Tell the server the caller stopped talking now (skip the silence wait). */
  commit() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'commit' }));
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'end' })); } catch { /* ignore */ }
    }
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
