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
        --history+prompt--> src/llm.js (AnswerEngine: stub, or real Anthropic
                                          if ANTHROPIC_API_KEY is set)
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
  (used by default and by all tests) plus a real Anthropic-backed
  implementation that activates automatically if `ANTHROPIC_API_KEY` is set.
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

## What's stubbed

- **LLM**: no `ANTHROPIC_API_KEY` was available/confirmed for this new
  service in this environment. `src/llm.js` stubs it behind
  `createStubAnswerEngine()` (deterministic yes/no/reprompt logic, no
  network) and that stub is what all tests exercise. A real
  `@anthropic-ai/sdk`-backed implementation is written and wired in
  (`createAnthropicAnswerEngine`) and activates automatically the moment
  `ANTHROPIC_API_KEY` is set — no code change needed, just provisioning
  the key. Note `ReadAloudAI/backend` already depends on
  `@anthropic-ai/sdk` and `call-loop-poc/server.js` already uses
  `ANTHROPIC_API_KEY`, so a key plausibly already exists somewhere in this
  org's Fly/deploy secrets — but per this repo's `CLAUDE.md` rule ("don't
  guess secret names from code... ask before assuming"), this task did not
  go looking for or reuse one.
- **Streaming LLM output**: `AnswerEngine.reply()` returns the full text in
  one call rather than streaming tokens. Fine for this MVP's very short
  replies; `sentenceChunker.js` is already wired to consume streamed
  tokens if/when a streaming LLM call replaces this.
- **Speculative-final handling**: `worker-stt-realtime`'s
  `speculative_final` event (fires ~300ms into silence, ahead of the full
  `endpoint_ms` wait) is logged but not exploited to start the LLM call
  early — see the comment in `session.js`. Flagged as the next latency
  optimization once a slower LLM is in the loop.

## How this was tested

No live Twilio call, no live STT/TTS worker, no phone number — per the
task's explicit constraint. Instead:

- `test/audio.test.js` — unit tests for the codec/resample/framing math.
- `test/session.test.js` — drives the real `CallSession` orchestration
  logic (turn-taking, outcome detection, barge-in, MAX_TURNS/empty-final
  guards) against in-process fakes (`test/fakes.js`) with the same
  event/method shape as the real STT/TTS clients — no network.
- `test/integration.test.js` — **the important one**: real
  `SttRealtimeClient` / `PiperTtsClient` talking the *actual*
  worker-stt-realtime / worker-piper-fly wire protocol (see
  `test/mockServers.js`) to local mock WebSocket servers, wired through the
  real `TwilioBridge`, fed synthetic Twilio Media Streams JSON frames
  (base64 mu-law "audio" — silence, since there's no real ASR behind the
  mock) exactly as a live `<Connect><Stream>` would send them. This
  exercises the complete code path a live call would use — Twilio JSON in,
  mu-law decode, STT client, turn-taking, LLM stub, TTS client, mu-law/
  20ms-framed JSON back out — without needing a live number or network
  access to the real workers.

Run: `npm install && npm test` from this directory (14 tests, all passing,
process exits cleanly with no leaked WebSocket/timer handles).

## What's needed for a live demo (deliberately not done here)

Per the task's explicit constraint, none of this was done:
- No Twilio phone number was provisioned.
- No TwiML app / voice webhook pointing `<Connect><Stream>` at
  `src/server.js`'s `/twilio-media-stream` was configured.
- `src/server.js` was never started against real `worker-stt-realtime` /
  `worker-piper-fly` endpoints or a real Twilio call.

To go from here to an actual live call: provision a number (small
recurring Twilio cost — needs explicit approval), point its voice webhook
at a deployed instance of `src/server.js` (needs a deploy target — this
MVP doesn't have a Fly app of its own yet, unlike the sibling services
listed in `ReadAloudAI/CLAUDE.md`), set `STT_WS_URL`/`TTS_WS_URL`/
`GATEWAY_API_KEY` to the real gateway, and provision `ANTHROPIC_API_KEY`
for real LLM replies. **Flagging this rather than doing it — needs a live
Twilio number and explicit approval to test end-to-end**, exactly as the
task asked.

## Honest assessment of demo-readiness

- The orchestration logic (turn-taking, barge-in, audio format conversion,
  Twilio Media Streams framing/pacing) is real, working code, tested
  end-to-end against protocol-accurate mocks. This is the part of the task
  that was "integration work, not an ML problem," and it's done.
- What separates this from an actual live demo is almost entirely
  *provisioning*, not code: a phone number, a deploy target, and real
  API keys/endpoints for the three external services (STT worker, TTS
  worker, LLM). None of those were in scope to do unilaterally here.
- Two real gaps beyond provisioning, worth calling out honestly:
  1. **No real speech was ever transcribed against this code** — the STT
     leg was tested against a scripted mock, not the actual
     `worker-stt-realtime` model, so real-world transcription quality/
     latency and the exact shape of `partial`/`speculative_final` traffic
     on real audio are unverified. First real thing to check once a
     worker endpoint is reachable.
  2. **The LLM is a hardcoded-regex stub**, not tested against how a real
     model actually phrases confirm/reschedule/reprompt replies — the
     `/\bconfirmed\b/i` / `/reschedule/i` outcome-detection regexes in
     `session.js` assume the LLM's wording cooperates. `DEFAULT_SYSTEM_PROMPT`
     nudges toward that wording, but a real model will need to be tested
     against those regexes (or better, the outcome should be a structured
     tool-call/JSON field instead of a text-sniff, which is a reasonable
     hardening item before this goes further than an MVP).
