// Pure helpers for the "Make your first call" block shown under a freshly generated API key
// (components/DeveloperApiSection.tsx). The key is only ever placed into strings that the page renders
// and the person copies; nothing here logs it, stores it or sends it anywhere.

export const FIRST_CALL_ENDPOINT = 'https://api.readaloudai.org/v1/audio/speech'
export const FIRST_CALL_BODY =
  '{"model":"tts-1","voice":"readaloud-default","input":"Hello from ReadAloud.","response_format":"mp3"}'
export const FIRST_CALL_NOTE =
  'If hello.mp3 will not play, open it in a text editor: it contains the error message.'
export const COPY_FAILED_MESSAGE = 'Copy failed, select the key and copy it manually'

/** Single-quote a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** `export READALOUD_API_KEY=<key>`, so the later examples on the page (which read the variable) work as written. */
export function buildExportLine(key: string): string {
  return `export READALOUD_API_KEY=${shellQuote(key)}`
}

/**
 * A curl call with the real key embedded. `-f` makes curl exit non-zero on an HTTP error (and write no file)
 * instead of saving the error body as hello.mp3; `--show-error` prints the failure.
 */
export function buildFirstCallCurl(key: string): string {
  return [
    `curl -f --show-error -o hello.mp3 ${FIRST_CALL_ENDPOINT} \\`,
    `  -H ${shellQuote(`Authorization: Bearer ${key}`)} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${FIRST_CALL_BODY}'`,
  ].join('\n')
}

/**
 * Copy text to the clipboard. Resolves true on success and false when the clipboard is missing or refuses
 * (insecure context, permission denied, a webview without it), so the caller can fall back to a manual copy.
 */
export async function copyTextSafely(
  text: string,
  clipboard: { writeText: (t: string) => Promise<void> } | undefined | null,
): Promise<boolean> {
  try {
    if (!clipboard || typeof clipboard.writeText !== 'function') return false
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
