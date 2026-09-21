import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallSession, DEFAULT_GREETING } from '../src/session.js';
import { createStubAnswerEngine } from '../src/llm.js';
import { FakeStt, FakeTts, TestAudioSink } from './fakes.js';

function buildSession(events = []) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const sink = new TestAudioSink();
  const session = new CallSession({
    stt, tts, answerEngine: createStubAnswerEngine(), sink,
    onEvent: (e) => events.push(e),
  });
  return { stt, tts, sink, session, events };
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
