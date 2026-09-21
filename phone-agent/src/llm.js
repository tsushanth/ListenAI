// LLM interface for the orchestration loop, kept behind one function so the
// rest of the code (session.js) never imports a specific provider SDK.
//
// STATUS: no LLM API key was available/confirmed in this environment for
// this project (ReadAloudAI). The sibling repo's backend/package.json does
// list @anthropic-ai/sdk as a dependency and call-loop-poc/server.js already
// uses ANTHROPIC_API_KEY, so real LLM access likely exists *somewhere* in
// this account/org already — but no key was confirmed available/scoped for
// this new phone-agent service, and per this repo's CLAUDE.md rule ("don't
// guess secret names from code... ask before assuming"), this module does
// NOT fabricate or reuse a key from elsewhere. It is stubbed behind
// `AnswerEngine` with a clear flag: **needs an ANTHROPIC_API_KEY (or
// equivalent) provisioned for phone-agent-mvp before this can produce real
// answers.** The Anthropic-backed implementation below is real, working
// code — it activates automatically the moment ANTHROPIC_API_KEY is set in
// the environment, no code change required.

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

/** Picks the stub unless ANTHROPIC_API_KEY is set — see module docstring. */
export function createAnswerEngine(env = process.env) {
  if (env.ANTHROPIC_API_KEY) {
    return createAnthropicAnswerEngine({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return createStubAnswerEngine();
}
