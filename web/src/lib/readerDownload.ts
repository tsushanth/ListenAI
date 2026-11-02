// File name for the reader's "Download audio" button. Pure, so it can be unit-tested without a browser.
// The reader produces a 16-bit mono PCM WAV (lib/piperReader.ts buildWav), so the extension is always .wav.

const FALLBACK_STEM = 'readaloud-audio'
const MAX_STEM_CHARS = 48
const MAX_WORDS = 8

/**
 * A safe file name derived from the start of the text that was read, e.g. "The Quick Brown Fox!" ->
 * "readaloud-the-quick-brown-fox.wav". ASCII letters/digits only (other scripts, emoji and path characters are
 * dropped); text with nothing usable gives "readaloud-audio.wav".
 */
export function readerDownloadFilename(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents: "café" -> "cafe"
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS)
  let stem = words.join('-').slice(0, MAX_STEM_CHARS).replace(/-+$/, '')
  stem = stem ? `readaloud-${stem}` : FALLBACK_STEM
  return `${stem}.wav`
}
