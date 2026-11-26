// Pure helpers for the "Make your first call" block shown under a freshly generated API key
// (components/DeveloperApiSection.tsx). Nothing here logs or stores the key. It is placed into strings that the page renders
// and the person copies, and it is sent to our own backend only when the person presses "Run it now".

export const FIRST_CALL_ENDPOINT = 'https://api.readaloudai.org/v1/audio/speech'
export const FIRST_CALL_BODY =
  '{"model":"tts-1","voice":"readaloud-default","input":"Hello from ReadAloud.","response_format":"mp3"}'
export const FIRST_CALL_NOTE =
  'If hello.mp3 will not play, open it in a text editor: it contains the error message.'
export const COPY_FAILED_MESSAGE = 'Copy failed, select the key and copy it manually'

export const RUN_NOW_FAILED_MESSAGE = 'The test call could not be made. The command below does the same thing.'

/** The button is offered only when the call costs nothing: a complimentary account, or free credits left. */
export function canRunFirstCall(comped: boolean, freeRemaining: number | null | undefined): boolean {
  return comped || (typeof freeRemaining === 'number' && freeRemaining >= 100)
}

export function runNowSuccessLine(characters: number, comped: boolean): string {
  return comped ? 'It worked. Press play to hear it.' : `It worked and used ${characters} characters of your free credits. Press play to hear it.`
}

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
