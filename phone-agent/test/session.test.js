import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallSession, DEFAULT_GREETING } from '../src/session.js';
import { createStubAnswerEngine } from '../src/llm.js';
import { FakeStt, FakeTts, TestAudioSink } from './fakes.js';

function buildSession(events = [], opts = {}) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const sink = new TestAudioSink();
  const session = new CallSession({
    stt, tts, answerEngine: createStubAnswerEngine(), sink,
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { stt, tts, sink, session, events };
}

/** A fake AnswerEngine that returns the {text, outcome} shape real (non-stub) engines use. */
function structuredEngine(script) {
  let i = 0;
  return {
    async reply() {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return step;
    },
  };
}

test('greeting is spoken on start() before any caller audio', async () => {
  const { tts, session } = buildSession();
  const p = session.start();
  assert.deepEqual(tts.synthesizeCalls, [DEFAULT_GREETING]);
  tts.finishTurn();
  await p;
});

test('happy path: caller confirms -> reply mentions confirmed, ends the call, outcome=confirmed', async () => {
  const { stt, tts, sink, session } = buildSession();
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  stt.emitFinal('yes, that works');
  // answerEngine.reply() is async but resolves on a microtask; give it a tick.
  await new Promise((r) => setImmediate(r));
  assert.match(tts.synthesizeCalls.at(-1), /confirmed/i);
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));

  assert.equal(session.state.ended, true);
  assert.equal(session.state.outcome, 'confirmed');
  assert.equal(stt.closed, true);
  assert.equal(tts.closed, true);
});

test('caller declines -> outcome=reschedule, call still ends on "Goodbye"', async () => {
  const { stt, tts, session } = buildSession();
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  stt.emitFinal('no I cannot make it');
  await new Promise((r) => setImmediate(r));
  assert.match(tts.synthesizeCalls.at(-1), /reschedule/i);
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));

  assert.equal(session.state.outcome, 'reschedule');
  assert.equal(session.state.ended, true);
});

test('barge-in: a partial transcript while the agent is speaking stops TTS and clears the sink queue', async () => {
  const { stt, tts, sink, session, events } = buildSession();
  const p0 = session.start();
  // Don't finish the turn yet — agent is still "speaking".
  sink.sendAudio(Buffer.alloc(5)); // simulate some audio already queued out
  assert.equal(sink.isSpeaking(), true);

  stt.emitPartial('wait actually');
  assert.equal(tts.stopped, true);
  assert.equal(sink.cleared, 1);
  assert.ok(events.some((e) => e.type === 'barge_in'));

  tts.finishTurn({ cancelled: true });
  await p0;
});

test('caller answers something unclear -> agent reprompts instead of ending the call', async () => {
  const { stt, tts, session } = buildSession();
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  stt.emitFinal('what time is it');
  await new Promise((r) => setImmediate(r));
  assert.match(tts.synthesizeCalls.at(-1), /yes or no/i);
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.state.ended, false); // reprompt, not a hangup
});

test('an empty/noise "final" transcript is ignored rather than treated as a turn', async () => {
  const { stt, tts, session } = buildSession();
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  const callsBefore = tts.synthesizeCalls.length;
  stt.emitFinal('   ');
  await new Promise((r) => setImmediate(r));
  assert.equal(tts.synthesizeCalls.length, callsBefore);
  assert.equal(session.state.history.length, 0); // greeting is spoken directly, not added as an LLM turn
});

// --- Hardening pass: messier real-world conversational inputs ---------------
// The stub engine's regex-based logic is the same one under test in the
// "happy path"/"declines"/"unclear" tests above; these add the messier
// patterns the task called out explicitly: mumbled/unintelligible text,
// "what?"/repeat requests, changing an answer mid-call, and silence/timeout.

test('mumbled/unintelligible transcript -> treated like any other unrecognized answer (reprompt, not a crash or hangup)', async () => {
  const { stt, tts, session } = buildSession();
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  stt.emitFinal('uhh mm hmm mmphf'); // stand-in for a garbled STT transcript of a mumbled response
  await new Promise((r) => setImmediate(r));
  assert.match(tts.synthesizeCalls.at(-1), /yes or no/i);
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.state.ended, false);
  assert.equal(session.state.outcome, null);
});

test('caller asks "what?" / to repeat -> reprompted rather than misread as an answer', async () => {
  const { stt, tts, session } = buildSession();
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  stt.emitFinal('what? can you repeat that');
  await new Promise((r) => setImmediate(r));
  assert.match(tts.synthesizeCalls.at(-1), /yes or no/i);
  assert.equal(session.state.outcome, null);
  tts.finishTurn();
});

test('caller changes their answer before the call resolves (reprompt path, still open) -> latest turn wins', async () => {
  const { stt, tts, session } = buildSession();
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  // Unclear first turn keeps the call open...
  stt.emitFinal('uh I dunno maybe');
  await new Promise((r) => setImmediate(r));
  assert.equal(session.state.outcome, null);
  assert.equal(session.state.ended, false);
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));

  // ...then they answer for real.
  stt.emitFinal('actually no I can\'t make it');
  await new Promise((r) => setImmediate(r));
  assert.equal(session.state.outcome, 'reschedule');
  tts.finishTurn();
});

test('silence/no-response after the agent speaks -> one reprompt, then the call ends gracefully with outcome=timeout', async () => {
  const events = [];
  const { tts, session } = buildSession(events, { noResponseTimeoutMs: 15 });
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  // Caller never says anything at all — no partial, no final.
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(events.some((e) => e.type === 'no_response_timeout' && e.count === 1));
  assert.match(tts.synthesizeCalls.at(-1), /still there/i);
  assert.equal(session.state.ended, false); // first timeout reprompts, doesn't hang up
  tts.finishTurn();

  // Still nothing after the reprompt -> give up.
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(events.some((e) => e.type === 'no_response_timeout' && e.count === 2));
  assert.match(tts.synthesizeCalls.at(-1), /goodbye/i);
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.state.ended, true);
  assert.equal(session.state.outcome, 'timeout');
});

test('silence timeout is cancelled if the caller responds before it fires', async () => {
  const { stt, tts, session } = buildSession([], { noResponseTimeoutMs: 50 });
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  await new Promise((r) => setTimeout(r, 10));
  stt.emitFinal('yes, confirmed');
  await new Promise((r) => setImmediate(r));
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));

  // Give the (cancelled) timer's original deadline time to pass, to prove it didn't also fire.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(session.state.outcome, 'confirmed');
  assert.equal(session.state.ended, true);
});

// --- Structured outcome from a real-shaped AnswerEngine ({text, outcome}) --
// Real engines (OpenRouter, via a forced tool call — see llm.js) return
// {text, outcome} instead of a bare string. These drive CallSession with a
// fake of that shape so the outcome-detection path is covered without a
// network call; the actual OpenRouter wiring is exercised for real in
// test-live/llmLive.test.js.

test('structured {text, outcome} reply drives session.state.outcome directly, no text-sniffing needed', async () => {
  const stt = new (await import('./fakes.js')).FakeStt();
  const tts = new (await import('./fakes.js')).FakeTts();
  const sink = new (await import('./fakes.js')).TestAudioSink();
  const engine = structuredEngine([
    { text: "Great, you're all set for tomorrow. Goodbye!", outcome: 'confirmed' },
  ]);
  const session = new CallSession({ stt, tts, answerEngine: engine, sink, onEvent: () => {} });
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  stt.emitFinal('yeah works for me');
  await new Promise((r) => setImmediate(r));
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.state.outcome, 'confirmed');
  assert.equal(session.state.ended, true);
});

test('LLM call failing (network error, rate limit, etc.) ends the call gracefully instead of throwing an unhandled rejection', async () => {
  const stt = new (await import('./fakes.js')).FakeStt();
  const tts = new (await import('./fakes.js')).FakeTts();
  const sink = new (await import('./fakes.js')).TestAudioSink();
  const events = [];
  const engine = { async reply() { throw new Error('OpenRouter request failed: 503 Service Unavailable'); } };
  const session = new CallSession({ stt, tts, answerEngine: engine, sink, onEvent: (e) => events.push(e) });
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  stt.emitFinal('yes that works');
  await new Promise((r) => setImmediate(r));
  assert.match(tts.synthesizeCalls.at(-1), /trouble|goodbye/i);
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));

  assert.equal(session.state.ended, true);
  assert.equal(session.state.outcome, 'error');
  assert.ok(events.some((e) => e.type === 'llm_error'));
});

test('structured reply with outcome:"unclear" reprompts and does NOT get misread by the regex fallback', async () => {
  const stt = new (await import('./fakes.js')).FakeStt();
  const tts = new (await import('./fakes.js')).FakeTts();
  const sink = new (await import('./fakes.js')).TestAudioSink();
  // Deliberately phrase the reply so a naive regex sniff (`/reschedule/i`)
  // would misfire, to prove the structured `outcome` field is what's used.
  const engine = structuredEngine([
    { text: "Sorry, I didn't catch a yes or no — should I reschedule or keep the original time?", outcome: 'unclear' },
  ]);
  const session = new CallSession({ stt, tts, answerEngine: engine, sink, onEvent: () => {} });
  const p0 = session.start();
  tts.finishTurn();
  await p0;

  stt.emitFinal('umm');
  await new Promise((r) => setImmediate(r));
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.state.outcome, null); // not 'reschedule', despite the word appearing in the reply text
  assert.equal(session.state.ended, false);
});
