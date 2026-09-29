// Standalone helper invoked in a fresh child process by chapterDetection.test.ts's
// "ANTHROPIC_API_KEY is unset" test — NOT part of `npm test`'s file list, and not a
// `*.test.ts` file, so it never runs on its own. It exists because config.ts (and
// therefore chapterDetection.ts's module-level Anthropic client) reads
// ANTHROPIC_API_KEY exactly once, at first import, so exercising the "no key"
// fallback branch needs a genuinely separate process, not an env mutation + re-import
// within the main test file's already-running one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChaptersFromText } from './chapterDetection.js';

test('detectChaptersFromText falls back to one chapter with no ANTHROPIC_API_KEY', async () => {
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  const longText = 'w'.repeat(5000);
  const chapters = await detectChaptersFromText(longText, 'No Key Book');
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.title, 'No Key Book');
  assert.equal(chapters[0]?.text, longText);
});
