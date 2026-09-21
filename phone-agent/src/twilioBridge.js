// Bridges a Twilio Media Streams WebSocket connection (the transport
// <Connect><Stream> opens to our server on an inbound call) to a
// CallSession. Twilio's wire format: JSON frames with base64 mu-law@8kHz
// audio in, and the same shape expected back out, paced at real time (one
// 160-byte/20ms frame roughly every 20ms — dumping a whole reply's audio
// at once overruns Twilio's playback buffer). See src/audio.js for the
// codec/resample helpers and realtime-tts/call-loop-poc/twilioAdapter.js
// for the reference implementation this pacing logic is modeled on.
import {
  chunkToTwilioFrames, decodeTwilioMediaPayload, encodeTwilioMediaPayload, piperPcm24kToTwilioMuLaw,
} from './audio.js';

/** AudioSink implementation that paces mu-law frames out over a Twilio Media Streams WebSocket. */
export class TwilioAudioSink {
  constructor(twilioWs, getStreamSid) {
    this.twilioWs = twilioWs;
    this.getStreamSid = getStreamSid;
    this._queue = [];
    this._timer = null;
  }

  /** pcmBuf: PCM16LE@24kHz from worker-piper-fly. */
  sendAudio(pcmBuf) {
    const muLaw = piperPcm24kToTwilioMuLaw(pcmBuf);
    for (const frame of chunkToTwilioFrames(muLaw)) this._queue.push(frame);
    this._startPacing();
  }

  /** Barge-in: drop whatever's still queued so stale audio doesn't keep playing over the caller. */
  clearQueue() {
    this._queue = [];
  }

  isSpeaking() {
    return this._queue.length > 0;
  }

  _startPacing() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      const frame = this._queue.shift();
      if (!frame) {
        clearInterval(this._timer);
        this._timer = null;
        return;
      }
      const streamSid = this.getStreamSid();
      if (!streamSid || this.twilioWs.readyState !== this.twilioWs.OPEN) return;
      this.twilioWs.send(JSON.stringify({
        event: 'media', streamSid, media: { payload: encodeTwilioMediaPayload(frame) },
      }));
    }, 20);
  }

  close() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

/**
 * Wires one Twilio Media Streams WebSocket connection to a fresh CallSession.
 * @param {WebSocket} twilioWs - server-side ws for the inbound /twilio-media-stream connection
 * @param {(sink: TwilioAudioSink, callSid: string|null) => import('./session.js').CallSession} createSession
 *   Factory so the caller can build the STT/TTS clients + CallSession once
 *   streamSid/callSid are known (matches how a real Twilio flow supplies
 *   per-call context, e.g. from the /voice webhook's TwiML <Parameter>s).
 */
export function attachTwilioMediaStream(twilioWs, createSession) {
  let streamSid = null;
  let callSid = null;
  let session = null;
  const sink = new TwilioAudioSink(twilioWs, () => streamSid);

  twilioWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      // createSession may be async (e.g. it needs the TTS WebSocket to finish
      // connecting before the greeting's first synthesize() call would
      // otherwise be silently dropped) — always await it, whether or not the
      // caller's factory actually returns a Promise.
      Promise.resolve(createSession(sink, callSid))
        .then((s) => {
          session = s;
          return session.start();
        })
        .catch((err) => console.error('[twilio-bridge] session setup/start failed:', err));
    } else if (msg.event === 'media') {
      if (!session) return; // audio arriving before 'start' shouldn't happen per Twilio's protocol, but guard anyway
      session.pushAudio(decodeTwilioMediaPayload(msg.media.payload));
    } else if (msg.event === 'stop') {
      sink.close();
      session?._end('hangup');
    }
  });

  twilioWs.on('close', () => {
    sink.close();
    session?._end('hangup');
  });

  return { getSession: () => session };
}
