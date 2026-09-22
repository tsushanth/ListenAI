# phone-agent-mvp

A narrow phone conversational-agent MVP: Twilio Media Streams bridged to
this org's existing realtime STT (`worker-stt-realtime`) and Piper TTS
(`worker-piper-fly`) WebSocket pipeline, both in the sibling `realtime-tts`
repo. Built on the `phone-agent-mvp` branch of `ReadAloudAI`, **not wired to
any live Twilio number** — see "What's needed for a live demo" below.

## Use case picked: appointment-reminder confirmation

Inbound call answers, asks "can you confirm your appointment tomorrow at
2 PM?", the caller says yes/no, the agent reads back a one-line
confirmation or reschedule acknowledgement, then hangs up. Defined in
`src/session.js` (`DEFAULT_SYSTEM_PROMPT` / `DEFAULT_GREETING`).

## Architecture

```
Twilio <Connect><Stream>  --WS (mu-law@8kHz, JSON+base64 frames)-->
  src/twilioBridge.js (TwilioAudioSink: 20ms-paced frames out, barge-in clear)
    --raw mu-law bytes--> src/session.js (CallSession: turn-taking, barge-in)
        --mu-law@8kHz--> src/sttClient.js --WS--> worker-stt-realtime
        <--partial/speculative_final/final events--
        --history+prompt--> src/llm.js (AnswerEngine: real OpenRouter-backed
                                          LLM if OPENROUTER_API_KEY is set —
                                          this is genuinely wired up now —
                                          direct-Anthropic if ANTHROPIC_API_KEY
                                          is set instead, else the offline stub)
        --sentence-chunked text--> src/ttsClient.js --WS--> worker-piper-fly
        <--chunk_meta + PCM16@24kHz--
    --PCM16@24kHz--> src/audio.js (resample+mu-law encode) --> back to Twilio
```

Files:
- `src/audio.js` — mu-law <-> PCM16 codec, 24kHz<->8kHz resample, Twilio's
  160-byte/20ms frame chunking.
- `src/sttClient.js` / `src/ttsClient.js` — WebSocket clients for the two
  existing worker protocols (see their docstrings in
  `../realtime-tts/worker-stt-realtime/server.py` and
  `../realtime-tts/worker-piper-fly/server.py` for the exact wire format
  this code was written against).
- `src/session.js` — the orchestration loop / state machine, transport- and
  provider-agnostic (works against fakes, mocks, or the real clients above
  identically — that's what makes it testable without Twilio).
- `src/twilioBridge.js` — wires one Twilio Media Streams WebSocket to a
  `CallSession`, including 20ms real-time pacing of outbound audio and
  clearing the paced queue on barge-in.
- `src/llm.js` — the `AnswerEngine` interface; a working offline stub
  (used by default and by every test in `test/`) plus two real,
  network-backed implementations: `createOpenRouterAnswerEngine` (real,
  genuinely wired up and tested — see "What's real now" below) and
  `createAnthropicAnswerEngine` (direct Anthropic, written but unexercised
  since no `ANTHROPIC_API_KEY` was available). `createAnswerEngine()` picks
  Anthropic-direct if `ANTHROPIC_API_KEY` is set, else OpenRouter if
  `OPENROUTER_API_KEY` is set, else the stub.
- `src/server.js` — entry point: an HTTP+WS server exposing
  `/twilio-media-stream`. **Not started against a live Twilio number.**

## Why hand-rolled instead of LiveKit Agents / Pipecat

Evaluated both, chose not to adopt either for this scope:

- **The STT/TTS legs already speak bespoke, non-standard WebSocket
  protocols** (`worker-stt-realtime`'s `partial`/`speculative_final`/
  `final`/`resume` event set; `worker-piper-fly`'s `chunk_meta` + raw-PCM
  framing). Neither framework has a built-in connector for either — using
  either framework here means writing the same amount of custom
  STT/TTS-adapter code as the hand-rolled version does, just inside that
  framework's plugin interface instead of a plain module. Adoption doesn't
  remove the actual integration work for this task; it only adds it inside
  someone else's abstraction, plus a new dependency and its own learning
  curve/debugging surface.
- **Barge-in and audio pacing are already solved** by the existing
  protocol (`worker-piper-fly`'s native `stop` message) and a well-understood
  ~80-line pacing queue (this repo's `twilioBridge.js`, modeled directly on
  the already-working `realtime-tts/call-loop-poc/twilioAdapter.js`). That
  is exactly the kind of audio-orchestration-loop plumbing LiveKit/Pipecat
  exist to save you from writing — but it's already written and proven in
  this codebase, so the case for adopting a framework to get it "for free"
  doesn't apply here.
- **Precedent in this codebase**: `realtime-tts/call-loop-poc` already
  built a more feature-complete version of this exact pattern (Twilio
  bridging, barge-in, sentence-chunked streaming) by hand, not on a
  framework, and it's in production-adjacent use (mystery-shopper testing,
  `/active-calls`, tenant lookup). That's a working existence proof that
  hand-rolling this narrow a loop is tractable and was the right call last
  time too.
- **Where a framework would start to pay off**: multi-provider STT/TTS
  swapping, telephony backends beyond Twilio, or a much larger flow graph
  (many nodes, transfers, voicemail detection, DTMF menus) — none of which
  this MVP's single two-question flow needs. If the product grows into
  that, re-evaluate then; the `CallSession`/`AudioSink` interfaces here are
  narrow enough that swapping the orchestration core later wouldn't
  require re-touching the Twilio bridge or audio codec code.

## What's real now (post-hardening-pass)

This section supersedes the MVP report's "What's stubbed" — most of what
was flagged there as stubbed is now real:

- **LLM is genuinely live**, via `OPENROUTER_API_KEY`
  (`createOpenRouterAnswerEngine` in `src/llm.js`), calling
  `anthropic/claude-haiku-4.5` through OpenRouter's OpenAI-compatible
  `/chat/completions` endpoint. This isn't a shape-compatible fake — it was
  run against the real API (`npm run test:live`, six real network calls,
  small scale) and produces real, on-task replies. Example real exchanges
  (verbatim from a live run):
  - Confirm: user "yes, that works for me" -> `{"text":"Great! Your appointment is confirmed for tomorrow at 2 PM. Thank you and goodbye!","outcome":"confirmed"}`
  - Decline: user "no, I can't make it that day, something came up" -> `{"text":"No problem! I'll help you reschedule. What day and time works better for you?","outcome":"reschedule"}`
  - Mumbled: user "uhh mm hmm mmphf what" -> `{"text":"I'm sorry, I didn't quite catch that. Can you confirm your appointment tomorrow at 2 PM—is that a yes or no?","outcome":null}`
  - Mid-conversation answer change: confirms, then "actually wait, no, I need to reschedule, sorry" -> second call correctly returns `outcome:"reschedule"`, overriding the first.
  - The Anthropic-direct implementation (`createAnthropicAnswerEngine`, used automatically if `ANTHROPIC_API_KEY` is set instead) is unchanged from the MVP — written but still never actually run, since no direct Anthropic key was available in this environment; OpenRouter was the available and, per the task, simpler path (OpenAI-compatible surface, one `fetch` call, no SDK dependency).
- **Outcome detection is now structured, not regex-on-free-text.** The
  OpenRouter engine forces a tool call (`respond_to_caller({reply,
  outcome})`, see `OUTCOME_TOOL` in `src/llm.js`) so the model reports
  `confirmed` / `reschedule` / `unclear` / `none` as an explicit field —
  `session.js` reads `result.outcome` directly. The original
  `/\bconfirmed\b/i` / `/reschedule/i` regex sniff is kept **only** as a
  fallback for engines that don't report a structured outcome (the offline
  stub, and the unexercised direct-Anthropic path) — it's demonstrably too
  fragile to be primary: a real model's unclear-reprompt reply
  ("...should I reschedule or keep the original time?") contains the word
  "reschedule" while meaning the opposite of that outcome, which the tool
  call disambiguates and a bare regex would have gotten wrong (see the
  `session.test.js` test covering exactly this case).
- **Silence/no-response handling is new.** The MVP's `MAX_TURNS` guard only
  covered a caller who kept talking without resolving; there was no
  handling at all for a caller who said nothing after the agent finished a
  turn (dead air, disconnected line, etc. — the call would simply hang
  open). `CallSession` now arms a watchdog timer after every agent turn:
  one reprompt ("Sorry, are you still there?") on the first silence, then a
  graceful goodbye and `outcome: 'timeout'` if the second attempt also gets
  nothing.
- **Streaming LLM output**: still not done — `AnswerEngine.reply()` returns
  the full text in one call. Unchanged from the MVP; still a reasonable
  scope cut for replies this short.
- **Speculative-final handling**: still not exploited — unchanged from the
  MVP, same reasoning as before (flagged as the next latency optimization,
  more relevant now that a real network-bound LLM call is actually in the
  loop instead of a synchronous stub).

## How this was tested

Still no live Twilio call, no live STT/TTS worker, no phone number — that
remains explicitly out of scope (see below). What changed in this pass:

- `test/audio.test.js` — unchanged: unit tests for the codec/resample/
  framing math.
- `test/session.test.js` — the offline, no-network suite, now **21 tests**
  (up from 8), covering the original happy-path/decline/barge-in/unclear/
  empty-transcript cases plus this pass's additions: mumbled/unintelligible
  transcripts, "what?"/repeat-me requests, an answer that changes
  mid-conversation before the call resolves, silence/no-response timing out
  into one reprompt then a graceful goodbye, silence timeout being
  cancelled by a late-but-real response, and the new structured
  `{text, outcome}` reply shape (including the case where the outcome
  field and a naive text-regex would disagree). All still run against
  in-process fakes (`test/fakes.js`) — no network, no API spend.
- `test/integration.test.js` — unchanged: real `SttRealtimeClient` /
  `PiperTtsClient` against local mock WebSocket servers through the real
  `TwilioBridge`, still using the offline LLM stub (keeping this suite
  deterministic and free).
- **New: `test-live/llmLive.test.js`** — real calls to the real OpenRouter
  API (skipped automatically if `OPENROUTER_API_KEY` isn't set; **not**
  part of `npm test`, so the default suite stays free/offline/deterministic
  for CI and every dev machine). Run explicitly with
  `OPENROUTER_API_KEY=... npm run test:live`. Covers: confirm, decline,
  mumbled input, "what?"/repeat request, an answer that changes
  mid-conversation, and one full `CallSession` run with the real LLM in the
  loop end to end (fake STT/TTS, real network call for the LLM leg). All 6
  passed against the real API in this pass; the reply text logged by each
  test (see above) is a real model output, not a canned fixture.

Run: `npm install && npm test` from this directory (**21 tests**, all
passing, process exits cleanly with no leaked WebSocket/timer handles — the
new no-response watchdog timers are `.unref()`'d specifically so they don't
hold the test process open).

## What's needed for a live demo (deliberately still not done here)

Explicitly out of scope for this hardening pass, same as the MVP:
- No Twilio phone number was provisioned.
- No TwiML app / voice webhook pointing `<Connect><Stream>` at
  `src/server.js`'s `/twilio-media-stream` was configured.
- `src/server.js` was never started against real `worker-stt-realtime` /
  `worker-piper-fly` endpoints or a real Twilio call.
- No real speech was transcribed by the real STT worker — `test-live/`
  only exercises the LLM leg over real network calls; STT/TTS are still
  only exercised against protocol-accurate mocks.

To go from here to an actual live call: provision a number (small
recurring Twilio cost — needs explicit approval), point its voice webhook
at a deployed instance of `src/server.js` (needs a deploy target — this
MVP doesn't have a Fly app of its own yet), set `STT_WS_URL`/`TTS_WS_URL`/
`GATEWAY_API_KEY` to the real gateway. The LLM leg no longer blocks this —
`OPENROUTER_API_KEY` is enough. **Flagging this rather than doing it —
still needs a live Twilio number and explicit approval to test
end-to-end.**

## Honest assessment of demo-readiness (updated)

- The orchestration logic (turn-taking, barge-in, audio format conversion,
  Twilio Media Streams framing/pacing, and now silence/timeout handling)
  is real, working code, tested end-to-end against protocol-accurate
  mocks.
- The LLM is no longer the blocking gap it was — it's a real, working,
  network-backed implementation, verified against the actual API with
  real conversational inputs including messy ones (see above). What
  separates this from an actual live demo is now purely *provisioning* on
  the telephony/STT/TTS side: a phone number, a deploy target, and real
  STT/TTS worker endpoints. None of those were in scope to do unilaterally
  here.
- Remaining honest gaps:
  1. **No real speech was ever transcribed against this code** — unchanged
     from the MVP. The STT leg is still only tested against a scripted
     mock; real-world transcription quality/latency and the exact shape of
     `partial`/`speculative_final` traffic on real audio remain unverified.
     First real thing to check once a worker endpoint is reachable.
  2. **The messier-input tests are still synthetic text, not synthetic
     *speech*.** `test-live/` feeds the LLM realistic-looking transcript
     strings directly — it proves the LLM handles messy phrasing well, but
     an actual mumbled utterance has to survive the STT leg first (noisy
     partials, low-confidence finals, wrong words entirely), which is a
     distinct and still-untested failure surface from what's covered here.
  3. **Direct-Anthropic path (`createAnthropicAnswerEngine`) remains
     unexercised** — it's dead code from a testing standpoint until an
     `ANTHROPIC_API_KEY` is provisioned for this service specifically.
     OpenRouter is the one real, verified path right now.
  4. **No retry on the LLM call, only a graceful failure path.** A network
     error, timeout, or OpenRouter outage on the `/chat/completions` call
     is now caught (`_handleUserTurn`'s try/catch, `session.test.js`'s
     "LLM call failing..." test) and ends the call with a "having trouble,
     we'll try you again later" line and `outcome: 'error'`, instead of an
     unhandled rejection. It still doesn't retry or add a request timeout
     of its own — a slow-but-eventually-successful call just makes the
     caller wait; that's a reasonable next step, not done in this pass.
