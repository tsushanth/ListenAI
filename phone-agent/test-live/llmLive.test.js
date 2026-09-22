// Live tests against the REAL OpenRouter API (real spend, small scale — a
// handful of short conversational turns). Deliberately kept OUT of
// `npm test` (test/, run by CI/every dev machine) so the normal suite stays
// offline/deterministic/free. Run explicitly with:
//
//   OPENROUTER_API_KEY=... npm run test:live
//
// This is the evidence that the OpenRouter-backed AnswerEngine (src/llm.js)
// actually works against a real model, not just a shape-compatible fake —
// and that the structured (tool-call) outcome field is genuinely returned
// by the model, not merely accepted by our parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterAnswerEngine } from '../src/llm.js';
import { CallSession, DEFAULT_SYSTEM_PROMPT, DEFAULT_GREETING } from '../src/session.js';
import { FakeStt, FakeTts, TestAudioSink } from '../test/fakes.js';

const apiKey = process.env.OPENROUTER_API_KEY;

test('OpenRouter engine: real model call returns a spoken reply + a structured outcome', { skip: !apiKey && 'OPENROUTER_API_KEY not set' }, async () => {
  const engine = createOpenRouterAnswerEngine({ apiKey });
  const history = [
    { role: 'assistant', content: DEFAULT_GREETING },
    { role: 'user', content: 'yes, that works for me' },
  ];
  const result = await engine.reply(history, DEFAULT_SYSTEM_PROMPT);
  console.log('[live] confirm ->', JSON.stringify(result));

  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.length > 0);
  assert.equal(result.outcome, 'confirmed');
});

test('OpenRouter engine: decline is recognized as reschedule', { skip: !apiKey && 'OPENROUTER_API_KEY not set' }, async () => {
  const engine = createOpenRouterAnswerEngine({ apiKey });
  const history = [
    { role: 'assistant', content: DEFAULT_GREETING },
    { role: 'user', content: "no, I can't make it that day, something came up" },
  ];
  const result = await engine.reply(history, DEFAULT_SYSTEM_PROMPT);
  console.log('[live] decline ->', JSON.stringify(result));

  assert.equal(result.outcome, 'reschedule');
});

test('OpenRouter engine: mumbled/unclear response is not misread as a yes or no', { skip: !apiKey && 'OPENROUTER_API_KEY not set' }, async () => {
  const engine = createOpenRouterAnswerEngine({ apiKey });
  const history = [
    { role: 'assistant', content: DEFAULT_GREETING },
    { role: 'user', content: 'uhh mm hmm mmphf what' },
  ];
  const result = await engine.reply(history, DEFAULT_SYSTEM_PROMPT);
  console.log('[live] mumble ->', JSON.stringify(result));

  assert.notEqual(result.outcome, 'confirmed');
  assert.notEqual(result.outcome, 'reschedule');
});

test('OpenRouter engine: "what?" / ask-to-repeat is treated as a repeat request, not an answer', { skip: !apiKey && 'OPENROUTER_API_KEY not set' }, async () => {
  const engine = createOpenRouterAnswerEngine({ apiKey });
  const history = [
    { role: 'assistant', content: DEFAULT_GREETING },
    { role: 'user', content: "what? sorry can you say that again" },
  ];
  const result = await engine.reply(history, DEFAULT_SYSTEM_PROMPT);
  console.log('[live] repeat-request ->', JSON.stringify(result));

  assert.notEqual(result.outcome, 'confirmed');
  assert.notEqual(result.outcome, 'reschedule');
});

test('OpenRouter engine: changes their answer mid-conversation -> final outcome reflects the latest turn', { skip: !apiKey && 'OPENROUTER_API_KEY not set' }, async () => {
  const engine = createOpenRouterAnswerEngine({ apiKey });
  let history = [
    { role: 'assistant', content: DEFAULT_GREETING },
    { role: 'user', content: 'yes that should work' },
  ];
  const first = await engine.reply(history, DEFAULT_SYSTEM_PROMPT);
  console.log('[live] change-answer step1 ->', JSON.stringify(first));
  history = [...history, { role: 'assistant', content: first.text }, { role: 'user', content: 'actually wait, no, I need to reschedule, sorry' }];
  const second = await engine.reply(history, DEFAULT_SYSTEM_PROMPT);
  console.log('[live] change-answer step2 ->', JSON.stringify(second));

  assert.equal(second.outcome, 'reschedule');
});

test('Full CallSession end to end against the real OpenRouter model (fake STT/TTS, real LLM in the loop)', { skip: !apiKey && 'OPENROUTER_API_KEY not set' }, async () => {
  const engine = createOpenRouterAnswerEngine({ apiKey });
  const stt = new FakeStt();
  const tts = new FakeTts();
  const sink = new TestAudioSink();
  const events = [];
  const session = new CallSession({ stt, tts, answerEngine: engine, sink, onEvent: (e) => events.push(e) });

  const p0 = session.start();
  tts.finishTurn();
  await p0;

  stt.emitFinal("yeah I can confirm that");
  await new Promise((r) => setTimeout(r, 4000)); // real network round trip
  const llmReply = events.find((e) => e.type === 'llm_reply');
  console.log('[live] full-session llm_reply ->', JSON.stringify(llmReply));
  tts.finishTurn();
  await new Promise((r) => setImmediate(r));

  assert.equal(session.state.outcome, 'confirmed');
  assert.equal(session.state.ended, true);
});
