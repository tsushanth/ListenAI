import { LAUNCH_FLAGS, type LaunchFlag } from './launchFlags.ts'
import { RA_LANGUAGES } from './readaloudFacts.ts'

// The "works today / partial / not yet" table on /developers/migrate-from-elevenlabs.
//
// Source: the parity map of 2026-11-14 (ElevenLabs API features against ReadAloud, one row per feature; ReadAloud column re-checked against
// the gateway and backend code), reduced to what a customer needs: the feature in ElevenLabs' words, where ReadAloud stands, one plain note.
// Only ReadAloud's own voice names, languages and tiers appear; nothing about how a voice is made (test/public-leak.test.ts scans this file).
//
// `flag` marks a row whose status depends on a switch (see launchFlags.ts). With the switch off the row reads "Coming soon"; with it on, it
// reads `status`. `status` is what the row means when the feature is live.

export type ParityStatus = 'works' | 'partial' | 'not-yet'
export type ParityRow = { area: string; feature: string; status: ParityStatus; note: string; flag?: LaunchFlag }

export const PARITY_AS_OF = '2026-11-17'

export const PARITY_ROWS: readonly ParityRow[] = [
  // Text to speech
  { area: 'Text to speech', feature: 'Convert and stream over HTTP, all output formats', status: 'works', note: 'Run with both official SDKs against the live API on 2026-10-10. Formats above 24 kHz are upsampled and flagged by a response header.' },
  { area: 'Text to speech', feature: 'WebSocket stream-input and multi-stream-input', status: 'works', note: 'Python SDK convert_realtime and a plain client. The JavaScript SDK has no text-to-speech WebSocket client.' },
  { area: 'Text to speech', feature: 'Voice list, search and lookup (v1, v2), models, user and subscription', status: 'works', note: 'ElevenLabs response shape when the key is sent as xi-api-key. Each voice lists name, language, dialect, gender and tier.' },
  { area: 'Text to speech', feature: 'OpenAI-compatible speech route and a Vapi custom voice endpoint', status: 'works', note: 'Extras on top of the ElevenLabs routes.' },
  { area: 'Text to speech', feature: 'Model ids (Flash, Turbo, Multilingual, v3, v4)', status: 'partial', note: 'Any id is accepted and a response header says how it was treated. The voice you pass decides the tier, except that v3 and v4 ids on the default voice reach the Expressive tier (see audio tags below).' },
  { area: 'Text to speech', feature: 'Voice settings (stability, similarity, style, speaker boost)', status: 'partial', note: 'Only speed has an effect. The others are accepted, ignored, and echoed in the x-compat-ignored header.' },
  { area: 'Text to speech', feature: 'Timestamps (with-timestamps)', status: 'partial', note: 'The non-streaming route returns alignment for the default voice. The streaming variant returns null alignment, and WebSocket streams carry no timing.' },
  { area: 'Text to speech', feature: 'Language breadth (ElevenLabs: 32, 70+ and 90+ by model)', status: 'partial', note: `${RA_LANGUAGES.short}. ElevenLabs is far ahead here.` },
  { area: 'Text to speech', feature: 'Text normalisation (numbers, dates, currency)', status: 'partial', note: 'Applied on ReadAloud Live only; apply_text_normalization is ignored.' },
  { area: 'Text to speech', feature: 'Audio tags, emotion and acting control (v3, v4)', status: 'partial', note: 'English only, in the Expressive tier. Delivery tags [whisper], [sigh] and [excited] change how the rest of the sentence is spoken; insertion tags [chuckle], [cough] and [gasp] add the sound. Laughs and emotion tags such as [sad] or [angry] are removed and listed in the x-compat-ignored response header. One request uses one family: a delivery tag mixed with an insertion tag drops the insertion tag. Not processed on WebSocket streams or in dialogue. Generated whole, not streamed, and the first request after a long idle can take 25 to 45 seconds. ElevenLabs is far ahead on expressive control.' },
  { area: 'Text to speech', feature: 'Pronunciation dictionaries', status: 'works', note: 'Create from rules, add and remove rules, list and delete work on the ElevenLabs paths, and locators in a speech request are applied: alias rules on every voice, phoneme rules on Live voices. Creating one from a PLS file returns 501.' },
  { area: 'Text to speech', feature: 'Text to dialogue (multi-speaker)', status: 'works', note: 'The non-streaming route returns audio for two speakers. The streaming dialogue socket was not tested, and cloned voices are not accepted in dialogue yet.' },
  { area: 'Text to speech', feature: 'Request stitching (previous and next text, request ids), seed', status: 'not-yet', note: 'Accepted and ignored.' },
  // Voices
  { area: 'Voices', feature: 'Instant voice clone (POST /v1/voices/add)', status: 'partial', flag: 'elevenLabsInstantClone', note: 'English, Spanish and German, a recorded consent step that ElevenLabs does not have, a key with billing enabled, 1,500 characters per request, no timestamps or WebSocket for cloned voices. The first create after a long idle can take about a minute.' },
  { area: 'Voices', feature: 'Voice library and shared voices', status: 'partial', note: 'A small catalogue of named voices; no community library.' },
  { area: 'Voices', feature: 'Professional voice clone (trained voice)', status: 'partial', note: "Through ReadAloud's own cloning API, not the ElevenLabs path; needs a payment method." },
  { area: 'Voices', feature: 'Voice design from a text description', status: 'partial', note: 'Separate ReadAloud route, not the ElevenLabs path. Works with the rtts_ key once one-key access is on.' },
  { area: 'Voices', feature: 'Voice changer (speech to speech)', status: 'partial', note: 'Works on the ElevenLabs path (POST /v1/speech-to-speech) into two built-in voices; the first request after a long idle can take about a minute. ReadAloud also has its own voice conversion route.' },
  { area: 'Voices', feature: 'Voice remixing', status: 'not-yet', note: '' },
  // Speech to text
  { area: 'Speech to text', feature: 'Batch transcription in the Scribe shape (POST /v1/speech-to-text)', status: 'works', flag: 'elevenLabsSpeechToText', note: 'model_id scribe_v1, scribe_v2 and scribe_v3 are all accepted and served by one tier; words with timestamps; transcripts are not stored. Upload limit 100 MB.' },
  { area: 'Speech to text', feature: 'Speaker labels (diarize)', status: 'partial', flag: 'elevenLabsSpeechToText', note: 'On the ElevenLabs route diarize=true is accepted but has no effect (speaker_id stays null; the x-compat-ignored header says so). ReadAloud\'s own route labels up to 8 speakers.' },
  { area: 'Speech to text', feature: 'Keyterms', status: 'partial', note: "ReadAloud's own route takes up to 500 English terms. On the ElevenLabs route keyterms returns a 400." },
  { area: 'Speech to text', feature: 'Realtime transcription (Scribe v3 Live)', status: 'partial', note: 'Early. A WebSocket in the Scribe shape for English, Spanish and German. Warm, the first partial arrives in about 0.7 seconds. The first session after a long idle can take about 9 seconds to the first partial and may end without a committed transcript, so send some audio and retry. Use the VAD commit strategy: a manual commit can clip the last word. Send the key in the token subprotocol, not in the URL. No price is published for it yet.' },
  { area: 'Speech to text', feature: 'Entity detection and redaction, audio event tags, webhooks, multichannel, medical model', status: 'not-yet', note: 'Rejected with a 400 on the ElevenLabs route, never silently dropped.' },
  { area: 'Speech to text', feature: 'Forced alignment', status: 'works', note: 'POST /v1/forced-alignment returns character-level timings; checked live on 2026-11-17 with a short English clip.' },
  // Audio tools
  { area: 'Audio tools', feature: 'Dubbing', status: 'partial', note: 'Audio in, audio out, on its own ReadAloud route (not /v1/dubbing); no segment editor, no video.' },
  { area: 'Audio tools', feature: 'Audio isolation and sound effects', status: 'partial', note: 'Separate ReadAloud routes that are not generally available yet.' },
  { area: 'Audio tools', feature: 'Music and video to music', status: 'not-yet', note: 'Not offered.' },
  { area: 'Projects', feature: 'Audiobooks (text or EPUB, chapters, one MP3 with chapter marks)', status: 'partial', note: 'Own route; not yet exercised on a full real book in production.' },
  { area: 'Projects', feature: 'Studio editor, snapshots, podcasts, Audio Native player', status: 'not-yet', note: '' },
  // Agents
  { area: 'Agents', feature: 'Agents platform, Speech Engine, realtime speech to speech, realtime translation', status: 'not-yet', note: 'ReadAloud is the voice inside LiveKit, Pipecat and Vapi agents, not an agent platform.' },
  // Platform
  { area: 'Platform', feature: 'One API key on every REST family', status: 'works', flag: 'oneKeyEverywhere', note: 'One rtts_ key (Authorization: Bearer or xi-api-key) for speech, speech to text, dubbing, voice conversion, voice design, audio isolation, audiobooks and sound effects.' },
  { area: 'Platform', feature: 'Usage and subscription endpoints', status: 'works', note: '/v1/user, /v1/user/subscription and usage statistics work (the statistics call needs start_unix and end_unix).' },
  { area: 'Platform', feature: 'MCP server', status: 'works', note: 'Hosted, with the same key.' },
  { area: 'Platform', feature: 'SDKs', status: 'partial', note: "Use ElevenLabs' official SDKs for speech, voices, models and user. ReadAloud's own packages cover text to speech only." },
  { area: 'Platform', feature: 'History and outbound webhooks', status: 'partial', note: 'History list, get, audio and delete work, within a storage cap. Webhook routes answer; we have not measured delivery in production.' },
  { area: 'Platform', feature: 'Workspaces, SSO, audit logs, data residency', status: 'not-yet', note: 'Single hosting footprint; no regional isolation.' },
]

export type ShownStatus = ParityStatus | 'coming-soon'
export const shownStatus = (r: ParityRow, flags: Readonly<Record<LaunchFlag, boolean>> = LAUNCH_FLAGS): ShownStatus => (r.flag && !flags[r.flag] ? 'coming-soon' : r.status)
export const STATUS_LABEL: Record<ShownStatus, string> = { works: 'Works today', partial: 'Partial', 'not-yet': 'Not yet', 'coming-soon': 'Coming soon' }
