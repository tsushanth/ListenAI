// npm test (node:test via tsx, run with --experimental-test-module-mocks).
// Unit tests for chapterDetection.ts:
//  - ePub TOC parsing (EPUB3 nav.xhtml) into titled chapters, with the
//    short-chapter merge behavior.
//  - LLM-based chapter splitting for plain text, with the Anthropic call
//    intercepted at the transport level (see below) — no real network call
//    is made.
//  - The fallback-to-one-chapter path on malformed/unusable LLM output.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
// chapterDetection.ts builds its module-level Anthropic client from
// config.ANTHROPIC_API_KEY, which config.ts reads once at its own first
// import — set it here, before anything imports chapterDetection.js (or its
// config.js dependency), so every LLM-splitting test below gets a real
// (mock-transport) Anthropic client rather than the "not configured"
// fallback.
process.env.ANTHROPIC_API_KEY ??= 'test-anthropic-key';

// The Anthropic Node SDK does NOT use globalThis.fetch — its Node shim
// (_shims/node-runtime.js) does its own `require('node-fetch')` and calls
// that directly, once, when the SDK module is first loaded. Overriding
// globalThis.fetch has no effect on it. So we mock the `node-fetch` package
// itself (via node:test's module mocking, hence --experimental-test-module-
// mocks) instead — and we do it here, at the top of the file, before
// anything below ever imports chapterDetection.js (which is what pulls in
// the SDK and triggers that one-time `require('node-fetch')`).
let anthropicResponse: { status: number; body: unknown } = { status: 200, body: null };
const anthropicRequests: Array<{ body: unknown }> = [];

mock.module('node-fetch', {
  defaultExport: async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (!url.includes('api.anthropic.com')) {
      throw new Error(`Unexpected real network call to ${url} — add a mock for it instead.`);
    }
    anthropicRequests.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(anthropicResponse.body), {
      status: anthropicResponse.status,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

// ---------------------------------------------------------------------------
// ePub test fixture builder
// ---------------------------------------------------------------------------

function buildEpub(opts: { chapters: Array<{ href: string; navTitle?: string; html: string }> }): Buffer {
  const zip = new AdmZip();

  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      `<?xml version="1.0"?>
<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      'utf8'
    )
  );

  const manifestItems = opts.chapters
    .map((c, i) => `<item id="ch${i}" href="${c.href}" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const spineItems = opts.chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join('\n');

  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(
      `<?xml version="1.0"?>
<package>
  <manifest>
    ${manifestItems}
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`,
      'utf8'
    )
  );

  const navLinks = opts.chapters
    .filter((c) => c.navTitle)
    .map((c) => `<li><a href="${c.href}">${c.navTitle}</a></li>`)
    .join('\n');
  zip.addFile(
    'OEBPS/nav.xhtml',
    Buffer.from(
      `<?xml version="1.0"?>
<html xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc"><ol>${navLinks}</ol></nav>
  </body>
</html>`,
      'utf8'
    )
  );

  for (const c of opts.chapters) {
    zip.addFile(`OEBPS/${c.href}`, Buffer.from(c.html, 'utf8'));
  }

  return zip.toBuffer();
}

// ---------------------------------------------------------------------------
// ePub tests
// ---------------------------------------------------------------------------

test('detectChaptersFromEpub: parses nav.xhtml TOC into titled chapters', async () => {
  const { detectChaptersFromEpub } = await import('./chapterDetection.js');

  const epub = buildEpub({
    chapters: [
      { href: 'ch0.xhtml', navTitle: 'Chapter One', html: `<html><body><p>${'a'.repeat(300)}</p></body></html>` },
      { href: 'ch1.xhtml', navTitle: 'Chapter Two', html: `<html><body><p>${'b'.repeat(300)}</p></body></html>` },
    ],
  });

  const chapters = detectChaptersFromEpub(epub);

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0]?.title, 'Chapter One');
  assert.equal(chapters[1]?.title, 'Chapter Two');
  assert.match(chapters[0]?.text ?? '', /^a+$/);
  assert.match(chapters[1]?.text ?? '', /^b+$/);
});

test('detectChaptersFromEpub: falls back to generic titles when there is no TOC', async () => {
  const { detectChaptersFromEpub } = await import('./chapterDetection.js');

  const epub = buildEpub({
    chapters: [{ href: 'ch0.xhtml', html: `<html><body><p>${'c'.repeat(300)}</p></body></html>` }],
  });

  const chapters = detectChaptersFromEpub(epub);

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.title, 'Chapter 1');
});

test('detectChaptersFromEpub: merges a too-short chapter into its neighbor', async () => {
  const { detectChaptersFromEpub } = await import('./chapterDetection.js');

  const epub = buildEpub({
    chapters: [
      { href: 'ch0.xhtml', navTitle: 'Title Page', html: '<html><body><p>short</p></body></html>' }, // < 200 chars
      { href: 'ch1.xhtml', navTitle: 'Chapter One', html: `<html><body><p>${'x'.repeat(300)}</p></body></html>` },
    ],
  });

  const chapters = detectChaptersFromEpub(epub);

  // The first chapter is under MIN_CHAPTER_CHARS and has nothing before it to
  // merge into, so it's folded *forward* into chapter two rather than dropped.
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.title, 'Chapter One');
  assert.match(chapters[0]?.text ?? '', /^short\n\nx+$/);
});

test('detectChaptersFromEpub: throws on an invalid ePub (missing container.xml)', async () => {
  const { detectChaptersFromEpub } = await import('./chapterDetection.js');
  const zip = new AdmZip();
  zip.addFile('nothing.txt', Buffer.from('not an epub', 'utf8'));

  assert.throws(() => detectChaptersFromEpub(zip.toBuffer()), /missing META-INF\/container\.xml/);
});

// ---------------------------------------------------------------------------
// LLM-based text splitting (node-fetch mocked at the top of this file)
// ---------------------------------------------------------------------------

test('detectChaptersFromText: splits text using LLM-reported chapter boundaries', async () => {
  const longText = `Chapter One\n${'a'.repeat(3000)}\nChapter Two\n${'b'.repeat(3000)}`;
  const secondChapterOffset = longText.indexOf('Chapter Two');

  anthropicResponse = {
    status: 200,
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { title: 'Chapter One', startOffset: 0 },
            { title: 'Chapter Two', startOffset: secondChapterOffset },
          ]),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  };

  // Import with a fresh module instance so the Anthropic client is
  // constructed with ANTHROPIC_API_KEY set above (module-level `anthropic`
  // is created once, at import time).
  const { detectChaptersFromText } = await import('./chapterDetection.js?llm-split');

  const chapters = await detectChaptersFromText(longText, 'My Book');

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0]?.title, 'Chapter One');
  assert.equal(chapters[1]?.title, 'Chapter Two');
  assert.match(chapters[0]?.text ?? '', /^Chapter One\na+$/);
  assert.match(chapters[1]?.text ?? '', /^Chapter Two\nb+$/);
});

test('detectChaptersFromText: falls back to one chapter on malformed LLM JSON', async () => {
  anthropicResponse = {
    status: 200,
    body: {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'this is not JSON at all, sorry' }],
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  };

  const { detectChaptersFromText } = await import('./chapterDetection.js?llm-malformed');

  const longText = `${'z'.repeat(5000)}`;
  const chapters = await detectChaptersFromText(longText, 'Fallback Book');

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.title, 'Fallback Book');
  assert.equal(chapters[0]?.text, longText);
});

test('detectChaptersFromText: falls back to one chapter when the Anthropic call errors', async () => {
  anthropicResponse = { status: 500, body: { error: { message: 'upstream error' } } };

  const { detectChaptersFromText } = await import('./chapterDetection.js?llm-error');

  const longText = `${'q'.repeat(5000)}`;
  const chapters = await detectChaptersFromText(longText, 'Error Book');

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.title, 'Error Book');
});

test('detectChaptersFromText: falls back to one chapter when ANTHROPIC_API_KEY is unset', async () => {
  // config.ts (and therefore chapterDetection.ts's module-level Anthropic
  // client) reads ANTHROPIC_API_KEY exactly once, at first import, and that
  // module instance is cached process-wide by tsx/node's loader — so testing
  // the "no key" branch needs a genuinely separate process, not just an
  // env mutation + re-import. See chapterDetectionNoKey.helper.ts (not part
  // of `npm test`'s own file list — it's only ever run from here).
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  // Throws (non-zero exit) if the helper's assertion fails.
  execFileSync('npx', ['tsx', '--test', 'src/lib/chapterDetectionNoKey.helper.ts'], {
    cwd: new URL('../../', import.meta.url).pathname,
    env,
    stdio: 'pipe',
  });
});

test('detectChaptersFromText: short input is not sent to the LLM at all', async () => {
  const requestsBefore = anthropicRequests.length;

  const { detectChaptersFromText } = await import('./chapterDetection.js');
  const chapters = await detectChaptersFromText('short text', 'Short');

  assert.equal(anthropicRequests.length, requestsBefore);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.title, 'Short');
});

test('detectChaptersFromText: throws on empty input', async () => {
  const { detectChaptersFromText } = await import('./chapterDetection.js');
  await assert.rejects(() => detectChaptersFromText('   '), /input text is empty/);
});
