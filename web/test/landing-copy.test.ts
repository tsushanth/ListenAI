import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Consumer landing page (/reader) and llms.txt must not claim things the apps do not do. Evidence for each rule:
//  - 10 built-in voices: android VoicePreset.builtInVoices (PiperVoiceMapping has 10 entries)
//  - speed 0.5x-2x: android SettingsManager.setPlaybackSpeed clamps to 0.5-2.0
//  - cloning is own-voice only, consent-gated (android VoiceCloningFlowScreen ATTESTATION_TEXT, backend voiceClones)
//  - no tags/folders UI in the Android library (filters: all, in progress, favorites, emails, archived)
//  - "Share Extension" and Safari are iOS; Android has a share target (AndroidManifest SEND filters)
//  - non-English text uses the phone's TTS engine (TTSCoordinator), not 10+ AI-voice languages
const FILES = [
  '../src/components/Features.tsx',
  '../src/components/Hero.tsx',
  '../src/components/HowItWorks.tsx',
  '../src/components/Pricing.tsx',
  '../src/components/FAQ.tsx',
  '../src/components/VoiceCloning.tsx',
  '../public/llms.txt',
]
const FORBIDDEN: [RegExp, string][] = [
  [/50\+|over 50|50 AI voices/i, '50+ voices'],
  [/\b3x\b/i, 'speed up to 3x'],
  [/share extension/i, 'Share Extension'],
  [/safari/i, 'Safari'],
  [/tags and folders|\btags\b|\bfolders\b/i, 'tags / folders'],
  [/anyone'?\\?'?s voice|clone any voice/i, "cloning anyone's voice"],
  [/10\+ languages|Japanese, Korean, Chinese/i, '10+ languages'],
]

for (const f of FILES) {
  test(`${f.split('/').pop()} makes none of the unsupported landing-page claims`, () => {
    const text = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')
    for (const [re, label] of FORBIDDEN) assert.ok(!re.test(text), `${f} still says: ${label}`)
  })
}
