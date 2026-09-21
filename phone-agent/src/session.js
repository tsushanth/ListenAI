// Orchestration loop for one call: STT partial/final transcripts ->
// endpointing -> LLM -> TTS, with barge-in wired to worker-piper-fly's
// native mid-sentence `stop` support. This module is transport-agnostic —
// it knows nothing about Twilio, WebSockets, or wire formats. It is driven
// by:
//   - an SttRealtimeClient-shaped event emitter (sttClient.js)
//   - a PiperTtsClient-shaped emitter (ttsClient.js)
//   - an AnswerEngine (llm.js)
//   - an AudioSink: { sendAudio(pcm24kBuf), clearQueue(), isSpeaking() }
//     (twilioBridge.js's TwilioAudioSink, or test/fakes.js's TestAudioSink)
// This separation is what makes the flow testable without Twilio, a real
// phone number, or a live call — see test/session.test.js, which drives
// the exact same CallSession class with an in-memory fake STT/TTS pair.
import { SentenceChunker } from './sentenceChunker.js';

/** Narrow appointment-reminder-confirmation flow (the default use case per the task). */
export const DEFAULT_SYSTEM_PROMPT = `You are a friendly automated assistant calling to confirm an
upcoming appointment. Ask the caller to confirm ("yes") or reschedule ("no"). Keep every reply to
one or two short sentences — this is a phone call, not chat. Once the caller answers, read back a
short confirmation (or reschedule acknowledgement) and end with "Goodbye!"`;

export const DEFAULT_GREETING =
  'Hi, this is a reminder call. Can you confirm your appointment tomorrow at 2 PM?';

const MAX_TURNS = 6; // in-memory session TTL guard: hang up rather than loop forever on a confused caller

/** In-memory-only session state; nothing here is durable or persisted (by design, per the task's scope). */
export class CallSessionState {
  constructor() {
    this.history = []; // [{role, content}]
    this.turn = 0;
    this.startedAt = Date.now();
    this.ended = false;
    this.outcome = null; // 'confirmed' | 'reschedule' | 'timeout' | 'hangup'
  }
}

export class CallSession {
  /**
   * @param {object} opts
   * @param {import('./sttClient.js').SttRealtimeClient} opts.stt
   * @param {import('./ttsClient.js').PiperTtsClient} opts.tts
   * @param {import('./llm.js').AnswerEngine} opts.answerEngine
   * @param {{sendAudio: Function, clearQueue: Function, isSpeaking: Function, close?: Function}} opts.sink
   * @param {string} [opts.systemPrompt]
   * @param {string} [opts.greeting]
   * @param {(evt: {type: string, [k: string]: any}) => void} [opts.onEvent] - observability hook (logging/tests)
   */
  constructor({ stt, tts, answerEngine, sink, systemPrompt = DEFAULT_SYSTEM_PROMPT, greeting = DEFAULT_GREETING, onEvent = () => {} }) {
    this.stt = stt;
    this.tts = tts;
    this.answerEngine = answerEngine;
    this.sink = sink;
    this.systemPrompt = systemPrompt;
    this.greeting = greeting;
    this.onEvent = onEvent;
    this.state = new CallSessionState();
    this._agentSpeaking = false;
    this._pendingBargeIn = false;

    this._wireStt();
    this._wireTts();
  }

  /** Called once the transport (Twilio stream / test harness) is ready to receive audio. */
  async start() {
    this._emit({ type: 'session_start' });
    await this._speak(this.greeting, { isGreeting: true });
  }

  /** Forward one chunk of caller audio, already in the STT client's configured encoding. */
  pushAudio(buf) {
    this.stt.sendAudio(buf);
  }

  _wireStt() {
    this.stt.on('partial', (msg) => {
      this._emit({ type: 'stt_partial', text: msg.text });
      // Barge-in: the caller is talking while the agent's audio is still
      // playing out. Cut the agent off immediately rather than talk over
      // them — this is what "mid-sentence interrupt support" in the STT/
      // TTS pipeline exists for.
      if (this._agentSpeaking && !this._pendingBargeIn) {
        this._pendingBargeIn = true;
        this.tts.stop();
        this.sink.clearQueue();
        this._emit({ type: 'barge_in' });
      }
    });

    this.stt.on('speculative_final', (msg) => {
      this._emit({ type: 'stt_speculative_final', text: msg.text });
      // Early "they're probably done" signal (worker-stt-realtime fires this
      // ~300ms into silence, before the full endpoint_ms wait) — a lower-
      // latency LLM implementation could kick off inference here and discard
      // it on {"type":"resume"}. Not exploited in this MVP: the stub/Haiku
      // LLM call is already fast relative to endpoint_ms, and starting two
      // speculative generations per turn adds real complexity (cancellation,
      // discarding a half-started LLM call) for a latency win that matters
      // more once a slower LLM is in the loop. Flagged as a next step, not
      // built now.
    });

    this.stt.on('final', (msg) => {
      this._emit({ type: 'stt_final', text: msg.text, reason: msg.reason });
      this._pendingBargeIn = false;
      this._handleUserTurn(msg.text);
    });

    this.stt.on('error', (msg) => this._emit({ type: 'stt_error', message: msg?.message || String(msg) }));
  }

  _wireTts() {
    this.tts.on('chunk_meta', (msg) => this._emit({ type: 'tts_chunk_meta', gen_ms: msg.gen_ms, audio_s: msg.audio_s }));
    this.tts.on('audio', (pcmBuf) => this.sink.sendAudio(pcmBuf));
    this.tts.on('done', () => { this._agentSpeaking = false; this._emit({ type: 'tts_done' }); this._afterSpeak?.(); });
    this.tts.on('cancelled', () => { this._agentSpeaking = false; this._emit({ type: 'tts_cancelled' }); this._afterSpeak?.(true); });
    this.tts.on('error', (msg) => this._emit({ type: 'tts_error', message: msg?.message || String(msg) }));
  }

  async _handleUserTurn(text) {
    if (this.state.ended) return;
    if (!text || !text.trim()) return; // e.g. a "final" fired on pure silence/noise
    this.state.history.push({ role: 'user', content: text });
    this.state.turn += 1;

    if (this.state.turn > MAX_TURNS) {
      this.state.outcome = 'timeout';
      await this._speak("I'll have someone follow up with you directly. Goodbye!");
      this._end();
      return;
    }

    const reply = await this.answerEngine.reply(this.state.history, this.systemPrompt);
    this.state.history.push({ role: 'assistant', content: reply });
    this._emit({ type: 'llm_reply', text: reply });

    if (/\bconfirmed\b/i.test(reply)) this.state.outcome = 'confirmed';
    else if (/reschedule/i.test(reply)) this.state.outcome = 'reschedule';

    const shouldEnd = /goodbye/i.test(reply);
    await this._speak(reply);
    if (shouldEnd) this._end();
  }

  /** Streams one utterance to TTS and resolves once it's done playing (or cancelled by barge-in). */
  _speak(text, { isGreeting = false } = {}) {
    return new Promise((resolve) => {
      this._agentSpeaking = true;
      this._afterSpeak = (cancelled) => { this._afterSpeak = null; resolve({ cancelled: !!cancelled }); };
      const chunker = new SentenceChunker((chunk) => this.tts.synthesize(chunk));
      if (isGreeting) {
        chunker.push(text);
      } else {
        chunker.push(text);
      }
      chunker.flush();
    });
  }

  _end(outcome) {
    if (this.state.ended) return;
    this.state.ended = true;
    if (outcome) this.state.outcome = outcome;
    this._emit({ type: 'session_end', outcome: this.state.outcome, turns: this.state.turn });
    this.sink.close?.();
    this.stt.close();
    this.tts.close();
  }

  _emit(evt) {
    this.onEvent({ ...evt, t: Date.now() - this.state.startedAt });
  }
}
