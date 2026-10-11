/**
 * Claude API spend accounting for the whole backend (llmUsage.js is copied from the app-failure-reporter repo).
 *
 * One shared instance. Inert unless the LLM_USAGE_KEY env var is set (no timers, no network): the key is deliberately NOT
 * defaulted, and failureReporter's built-in default key is never used here. Records counts and dollars per day / model /
 * feature label only: never prompts, answers, document titles or user ids. Reporting never throws into a request.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLlmUsage } = require('./llmUsage') as typeof import('./llmUsage');

export const llm = createLlmUsage({
  app: 'readaloud',
  enabled: !!process.env.LLM_USAGE_KEY,
  key: process.env.LLM_USAGE_KEY,
  log: (m: string) => console.warn(`[llm-usage] ${m}`),
});

/** Wraps a client's messages.create / messages.stream. Idempotent. Call it on every `new Anthropic(...)`. */
export function instrumentAnthropic<T>(client: T): T {
  llm.instrument(client);
  return client;
}

/** Runs fn with a feature label (low cardinality: a feature name, never content). */
export function withFeature<T>(name: string, fn: () => T): T {
  return llm.withFeature(name, fn);
}

/** Sends pending rows, giving up after maxMs so a slow Worker can never hold up shutdown. */
export async function flushLlmUsage(maxMs = 2500): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      llm.flush(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, maxMs); }),
    ]);
  } catch {
    // reporting is best effort
  } finally {
    if (timer) clearTimeout(timer);
  }
}
