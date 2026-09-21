// In-process fakes (no network) with the same event/method shape as
// SttRealtimeClient / PiperTtsClient / the AudioSink interface, for fast
// unit tests of session.js's turn-taking and barge-in logic in isolation
// from the WebSocket transport (that's covered separately by
// test/integration.test.js against real mock WS servers).
import { EventEmitter } from 'node:events';

export class FakeStt extends EventEmitter {
  sendAudio() {}
  commit() {}
  close() { this.closed = true; }
  emitPartial(text) { this.emit('partial', { type: 'partial', text }); }
  emitFinal(text, reason = 'vad') { this.emit('final', { type: 'final', text, reason }); }
}

export class FakeTts extends EventEmitter {
  constructor() {
    super();
    this.synthesizeCalls = [];
    this.stopped = false;
  }
  synthesize(text) {
    this.synthesizeCalls.push(text);
    this.stopped = false;
  }
  stop() { this.stopped = true; }
  close() { this.closed = true; }
  /** Test driver: simulate the server completing (or cancelling) synthesis. */
  finishTurn({ cancelled = false } = {}) {
    if (!cancelled) {
      this.emit('chunk_meta', { type: 'chunk_meta' });
      this.emit('audio', Buffer.alloc(10));
      this.emit('done');
    } else {
      this.emit('cancelled');
    }
  }
}

export class TestAudioSink {
  constructor() {
    this.audioChunks = [];
    this.cleared = 0;
    this.closed = false;
  }
  sendAudio(buf) { this.audioChunks.push(buf); }
  clearQueue() { this.cleared += 1; this.audioChunks = []; }
  isSpeaking() { return this.audioChunks.length > 0; }
  close() { this.closed = true; }
}
