// Entry point to the existing /audiobooks tool (components/ra/AudiobookMaker.tsx) from the signed-in web app.
// Kept as data so the copy and the route can be checked by a unit test without a browser.
//
// Copy is deliberately plain: the tool needs sign-in, splits the text into chapters, and each chapter is
// limited by the plan's per-job character limit (backend lib/config.ts TIER_LIMITS), so it does not promise
// "any book" or a particular speed.

export const AUDIOBOOK_CTA = {
  href: '/audiobooks',
  title: 'Audiobooks',
  description: 'Turn a long text or an EPUB into a chaptered audiobook and export it as one MP3.',
  readerPrompt: 'Have a whole book instead of one article?',
  readerLinkLabel: 'Create an audiobook',
} as const
