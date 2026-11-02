// Voices offered in the web reader. Every id is a Piper house voice that the Android app already requests from the same
// realtime-tts Piper worker (android/app/src/main/java/com/listenai/service/tts/PiperVoiceMapping.kt), plus the web
// reader's original default, "Warm" (custom:en-us-warm-f). Names and order follow Android's VoicePreset.builtInVoices.
//
// Descriptions state the accent actually served, not the Android persona: Matilda is New Zealand English (no Australian
// female exists in the voice catalog), Dorothy is Canadian, Rachel and Brian are Southern England.
//
// Kept free of imports so node --test can load it directly.

export interface ReaderVoice {
  /** The voice id sent in the Piper `synthesize` message. */
  id: string
  /** Name shown in the picker (matches the Android app). */
  name: string
  /** Short accent / gender label. */
  description: string
}

/** The web reader's original voice and the default for new visitors. Must equal PIPER_VOICE in piperReader.ts. */
export const DEFAULT_READER_VOICE_ID = 'custom:en-us-warm-f'

export const READER_VOICES: readonly ReaderVoice[] = [
  { id: DEFAULT_READER_VOICE_ID, name: 'Warm', description: 'US English, female' },
  { id: 'custom:en-us-kristin', name: 'Bella', description: 'US English, female' },
  { id: 'custom:en-us-john', name: 'Adam', description: 'US English, male' },
  { id: 'custom:en-gb-vctk-p232', name: 'Brian', description: 'English (England), male' },
  { id: 'custom:en-us-libritts_r-f383', name: 'Charlotte', description: 'US English, female' },
  { id: 'custom:en-us-norman', name: 'Josh', description: 'US English, male' },
  { id: 'custom:en-nz-vctk-p335', name: 'Matilda', description: 'New Zealand English, female' },
  { id: 'custom:en-us-libritts_r-m492', name: 'Bill', description: 'US English, male' },
  { id: 'custom:en-us-ljspeech', name: 'Elli', description: 'US English, female' },
  { id: 'custom:en-ca-vctk-p312', name: 'Dorothy', description: 'Canadian English, female' },
  { id: 'custom:en-gb-vctk-p229', name: 'Rachel', description: 'English (England), female' },
]

export function isReaderVoiceId(id: unknown): id is string {
  return typeof id === 'string' && READER_VOICES.some((v) => v.id === id)
}

/** The voice to use for a requested id: the id itself when it is in the list, otherwise the default. */
export function resolveReaderVoice(id: string | null | undefined): string {
  return isReaderVoiceId(id) ? id : DEFAULT_READER_VOICE_ID
}
