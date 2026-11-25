// What the public pages may call "available" today. Each flag mirrors a switch that is OFF by default in the service that implements it,
// so a page deployed before the switch is turned on does not promise something the API would refuse.
//
// To flip a feature: turn the matching switch on in the service first, run one real call through it on the production host, then set the
// flag to true here and redeploy the web app. The migration page, the developers page, llms.txt and the compare pages read these values.
//
//   oneKeyEverywhere        backend env RTTS_KEY_AUTH_ENABLED=true   (the rtts_ key on dubbing, voice conversion, voice design,
//                                                                   audio isolation, audiobooks and sound effects)
//   elevenLabsSpeechToText  gateway env ELEVENLABS_STT=1             (POST /v1/speech-to-text in the Scribe shape)
//   elevenLabsInstantClone  gateway env ELEVENLABS_COMPAT_VOICE_CLONE=1 plus the backend clone route
//                                                                   (POST /v1/voices/add with a consent step)
//
// Verified live on 2026-11-14 (one real production call each); a flag stays false until a person has verified it live. llms.txt is a static file; test/launch-flags.test.ts fails when its
// wording and these values disagree.

export type Availability = 'available' | 'coming-soon'

export const LAUNCH_FLAGS = {
  oneKeyEverywhere: true,
  elevenLabsSpeechToText: true,
  elevenLabsInstantClone: true,
} as const

export type LaunchFlag = keyof typeof LAUNCH_FLAGS

export const availability = (flag: LaunchFlag): Availability => (LAUNCH_FLAGS[flag] ? 'available' : 'coming-soon')
export const availabilityLabel = (flag: LaunchFlag): string => (LAUNCH_FLAGS[flag] ? 'Available' : 'Coming soon')

/** The date these flags were last set from a real check (empty while everything is off). */
export const LAUNCH_FLAGS_VERIFIED_ON = '2026-11-14'

// Features that are hidden altogether (not "coming soon"): with a flag false the web app shows an "unavailable" message on
// the feature's page, and drops its links, docs, parity rows and MCP tools. All are OFF.
//
// To offer one again: set the matching backend env first (voiceDesign: VOICE_DESIGN_PUBLIC=true, customVoiceStudio:
// VOICE_STUDIO_PUBLIC=true), make sure its worker is deployed, run one real call on the production host, then set the flag
// here to true, update public/llms.txt, and redeploy the web app.
export type OfferedFeatures = { readonly voiceDesign: boolean; readonly customVoiceStudio: boolean }

export const OFFERED_FEATURES: OfferedFeatures = {
  voiceDesign: false,
  customVoiceStudio: false,
}

export const UNAVAILABLE_COPY = {
  voiceDesign: 'Voice design is not available right now.',
  customVoiceStudio: 'Training a custom voice from your own recordings is not available right now.',
} as const
