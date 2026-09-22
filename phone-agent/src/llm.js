// LLM interface for the orchestration loop, kept behind one function so the
// rest of the code (session.js) never imports a specific provider SDK.
//
// STATUS (post-hardening-pass): OPENROUTER_API_KEY was available in this
// environment and is now genuinely wired up — createOpenRouterAnswerEngine
// below makes real calls to OpenRouter's OpenAI-compatible
// /chat/completions endpoint (currently anthropic/claude-haiku-4.5) and has
// been run against the real API (see ../test-live/llmLive.test.js and the
// README's "What's real now" section for real example exchanges). No
// direct ANTHROPIC_API_KEY was available/confirmed for this service, so
// createAnthropicAnswerEngine below is unchanged from the MVP: real,
// written code that activates automatically if that key is ever set, but
// still never actually exercised. createAnswerEngine() prefers
// ANTHROPIC_API_KEY if present, else OPENROUTER_API_KEY, else the offline
// stub used by all of test/.

/**
 * @typedef {object} AnswerEngine
 * @property {(history: {role:'user'|'assistant', content:string}[], systemPrompt: string) => Promise<string>} reply
 *   Returns the full assistant reply as one string. The orchestration loop
 *   (session.js) sentence-chunks it before sending to TTS — see
 *   sentenceChunker.js port below. A streaming variant is a natural
 *   follow-up (see README "Not built") but out of scope for this MVP: the
 *   qualifying-question flow only needs 1-2 short turns, so waiting for
 *   the full (short) reply before starting TTS costs little, and it keeps
 *   this interface simple to stub/test.
 */

/**
 * Deterministic stub — no network call, no cost, fully offline-testable.
 * Used automatically when no ANTHROPIC_API_KEY is set, and always used
 * under `node --test` regardless of env, so tests never depend on network
 * access or spend API budget.
 * @returns {AnswerEngine}
 */
export function createStubAnswerEngine() {
  return {
    async reply(history) {
      const lastUser = [...history].reverse().find((m) => m.role === 'user');
      const text = (lastUser?.content || '').toLowerCase();
      if (/\b(yes|yeah|yep|correct|that's right|sounds good|confirm)\b/.test(text)) {
        return "Great, you're confirmed. We'll see you then. Goodbye!";
      }
      if (/\b(no|nope|not|can't|cannot|reschedule)\b/.test(text)) {
        return "No problem, someone from our team will call you back to reschedule. Goodbye!";
      }
      if (history.filter((m) => m.role === 'user').length === 0) {
        return "Hi, this is a reminder call. Can you confirm your appointment tomorrow at 2 PM?";
      }
      return 'Sorry, could you say yes or no — can you make your appointment?';
    },
  };
}

/**
 * Real Anthropic-backed engine. Only constructed/used if ANTHROPIC_API_KEY
 * is present (see createAnswerEngine below) — never called from tests.
 * @returns {AnswerEngine}
 */
export function createAnthropicAnswerEngine({ apiKey, model = 'claude-3-5-haiku-20241022' }) {
  return {
    async reply(history, systemPrompt) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model,
        max_tokens: 200,
        system: systemPrompt,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      });
      return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  };
}

// Forces the model to return its spoken reply *and* the call outcome as one
// structured tool call, instead of us regex-sniffing the reply text for
// words like "confirmed" / "reschedule" (see the MVP report's honest gap:
// "the outcome should be a structured tool-call/JSON field instead of a
// text-sniff"). `reply.outcome` from this engine is authoritative;
// session.js only falls back to the regex for the offline stub, which has
// no tool-calling of its own.
const OUTCOME_TOOL = {
  type: 'function',
  function: {
    name: 'respond_to_caller',
    description:
      'Speak the next line to the caller on this phone call, and report the ' +
      "appointment outcome implied by the caller's most recent turn.",
    parameters: {
      type: 'object',
      properties: {
        reply: {
          type: 'string',
          description: 'What to say next. One or two short sentences — this is read aloud by TTS, not chat.',
        },
        outcome: {
          type: 'string',
          enum: ['confirmed', 'reschedule', 'unclear', 'none'],
          description:
            "'confirmed' if the caller just confirmed the appointment, 'reschedule' if they just said " +
            "they can't make it / want to reschedule or cancel, 'unclear' if their last turn could not be " +
            "understood as yes/no and should be re-asked, 'none' if there is nothing to resolve yet " +
            '(e.g. this is the opening greeting).',
        },
      },
      required: ['reply', 'outcome'],
      additionalProperties: false,
    },
  },
};

const RESOLVED_OUTCOMES = new Set(['confirmed', 'reschedule']);

/**
 * Real engine backed by OpenRouter (https://openrouter.ai) — an
 * OpenAI-Chat-Completions-compatible API that fronts Claude and other
 * models behind one key. Preferred over the direct-Anthropic path above
 * when only OPENROUTER_API_KEY is available (see createAnswerEngine).
 * Uses forced tool-calling (`tool_choice`) so the outcome comes back as a
 * structured field rather than free text — see OUTCOME_TOOL above.
 * @returns {AnswerEngine}
 */
export function createOpenRouterAnswerEngine({
  apiKey,
  model = 'anthropic/claude-haiku-4.5',
  baseUrl = 'https://openrouter.ai/api/v1',
  fetchImpl = fetch,
}) {
  return {
    async reply(history, systemPrompt) {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ];

      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // OpenRouter's optional-but-recommended app-identification headers.
          'HTTP-Referer': 'https://github.com/readaloudai/phone-agent-mvp',
          'X-Title': 'phone-agent-mvp',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 200,
          tools: [OUTCOME_TOOL],
          tool_choice: { type: 'function', function: { name: 'respond_to_caller' } },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText} ${body}`);
      }

      const data = await res.json();
      const message = data.choices?.[0]?.message;
      const toolCall = message?.tool_calls?.[0];

      if (!toolCall) {
        // Some models/providers occasionally ignore tool_choice and just
        // answer in plain text — degrade gracefully instead of throwing,
        // since a phone call can't just hang after a malformed response.
        return { text: message?.content || "Sorry, could you say that again?", outcome: null };
      }

      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        return { text: message?.content || 'Sorry, could you repeat that?', outcome: null };
      }

      const outcome = RESOLVED_OUTCOMES.has(args.outcome) ? args.outcome : null;
      return { text: args.reply || 'Sorry, could you repeat that?', outcome };
    },
  };
}

/**
 * Picks the real engine if a key is available, else the offline stub.
 * ANTHROPIC_API_KEY (direct Anthropic) wins if both are set; otherwise
 * OPENROUTER_API_KEY is used — this is what's actually wired up and
 * exercised for this project (see README "What's real now").
 */
export function createAnswerEngine(env = process.env) {
  if (env.ANTHROPIC_API_KEY) {
    return createAnthropicAnswerEngine({ apiKey: env.ANTHROPIC_API_KEY });
  }
  if (env.OPENROUTER_API_KEY) {
    return createOpenRouterAnswerEngine({
      apiKey: env.OPENROUTER_API_KEY,
      ...(env.OPENROUTER_MODEL ? { model: env.OPENROUTER_MODEL } : {}),
    });
  }
  return createStubAnswerEngine();
}
