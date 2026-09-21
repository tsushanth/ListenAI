// Thin client for worker-piper-fly's WebSocket protocol (see
// realtime-tts/worker-piper-fly/server.py docstring). Handles the
// chunk_meta + binary-PCM16@24kHz framing and the mid-sentence `stop`
// (barge-in) message the server already supports natively.
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';

/**
 * events: 'open', 'chunk_meta' (metadata only), 'audio' (Buffer, PCM16LE
 * 24kHz mono — immediately follows chunk_meta per protocol), 'done',
 * 'cancelled', 'error', 'close'
 */
export class PiperTtsClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url - e.g. wss://<host>/tts
   * @param {string} opts.token
   */
  constructor({ url, token }) {
    super();
    this.url = url;
    this.token = token;
    this.ws = null;
    this._pendingMeta = null; // chunk_meta buffered until the binary frame right after it
  }

  connect() {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams({ token: this.token || '' });
      this.ws = new WebSocket(`${this.url}?${qs}`);
      this.ws.binaryType = 'arraybuffer';
      this.ws.once('open', () => { this.emit('open'); resolve(this); });
      this.ws.once('error', reject);
      this.ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
      this.ws.on('close', () => this.emit('close'));
      this.ws.on('error', (err) => this.emit('error', err));
    });
  }

  _onMessage(data, isBinary) {
    if (isBinary) {
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.length);
      this.emit('audio', buf, this._pendingMeta);
      this._pendingMeta = null;
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'chunk_meta') {
      this._pendingMeta = msg;
      this.emit('chunk_meta', msg);
    } else {
      this.emit(msg.type, msg);
    }
  }

  /** Ask for one utterance of speech. Server streams chunk_meta+audio per sentence, then 'done'. */
  synthesize(text, { voice, speed = 1.0 } = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'synthesize', text, voice, speed }));
    }
  }

  /** Mid-sentence interrupt: the server already supports this natively (see server.py `reader()`). */
  stop() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
    }
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
