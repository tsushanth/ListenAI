import Link from 'next/link'

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-dark py-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <Link href="/" className="text-primary hover:text-primary-dark mb-8 inline-block">
          &larr; Back to Home
        </Link>

        <h1 className="text-4xl font-bold text-white mb-8">Privacy Policy</h1>

        <div className="prose prose-invert max-w-none">
          <p className="text-gray-400 mb-6">Last updated: October 2026</p>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">1. Information We Collect</h2>
            <p className="text-gray-300 mb-4">
              ReadAloud AI collects information you provide directly to us, such as when you create an account,
              use our services, or contact us for support. This may include:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Email address for account creation</li>
              <li>Content you import (articles, PDFs, text) for processing</li>
              <li>Voice recordings for voice cloning (if you use this feature)</li>
              <li>Usage data and preferences</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">2. Voice Cloning Data</h2>
            <p className="text-gray-300 mb-4">
              Voice cloning is available only to signed-in, paying accounts with a verified email address. To create a
              voice clone you give us a reference recording of the voice to clone and confirm that the voice is your
              own, and that you agree we may create a synthetic copy of it. We keep a record that you confirmed this. In
              some configurations we also ask you to record a short consent phrase that we generate for you; when we do,
              we compare that recording with the reference recording to check that they are the same speaker, and we
              transcribe it to check that the phrase was read. A voice recording is personal data and may be biometric data under some laws.
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li><strong>Reference recording:</strong> processed by Chatterbox (an open-source voice model) running on Modal&apos;s cloud GPU infrastructure under our account, and kept on that service&apos;s encrypted storage only while the voice exists. It is not stored in Supabase Storage.</li>
              <li><strong>Consent record:</strong> we keep a record of your confirmation (the date and what you agreed to). When we ask for a consent phrase, the consent recording is also stored in a private Supabase Storage bucket together with its transcript and the similarity score. These are kept for as long as the voice exists and for 12 months after you delete it, so that we can answer abuse and legal claims.</li>
              <li><strong>Deleting a voice</strong> (in the app or by emailing support) removes the reference recording, the voice model data derived from it, and any cached copies on the cloning service. Audio generated with your voice and the consent record are handled as described in Section 5.</li>
              <li>We do not use your recordings, or audio generated from them, to train any model.</li>
              <li>Every file generated with a cloned voice carries an inaudible watermark, and we keep a hash (a fingerprint, not the audio) of each generated file for 90 days so that misuse can be traced.</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">3. Third-Party AI Services</h2>
            <p className="text-gray-300 mb-4">
              ReadAloud AI uses the following third-party and cloud-based AI services to provide its features.
              The app asks for your explicit consent before sending any data to these services.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Text-to-Speech</h3>
            <p className="text-gray-300 mb-3">
              When you use cloud-based voices, your article text is sent to the following services for audio generation:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li><strong>Kokoro TTS</strong> (self-hosted on RunPod GPU cloud infrastructure) &mdash; processes text for standard quality voices</li>
              <li><strong>ElevenLabs</strong> (elevenlabs.io) &mdash; processes text for premium quality voices, subject to <a href="https://elevenlabs.io/privacy" className="text-primary hover:text-primary-dark">ElevenLabs&apos; privacy policy</a></li>
            </ul>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">AI Summarization</h3>
            <p className="text-gray-300 mb-3">
              When you request a content summary, your article text is sent to:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li><strong>OpenAI</strong> (openai.com, model: GPT-4o-mini) &mdash; processes text to generate summaries, subject to <a href="https://openai.com/policies/api-data-usage-policies" className="text-primary hover:text-primary-dark">OpenAI&apos;s API data usage policy</a>. Data sent via the API is not used for model training.</li>
            </ul>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Voice Cloning</h3>
            <p className="text-gray-300 mb-3">
              When you create a voice clone, your voice recording and synthesis text are sent to:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li><strong>Chatterbox</strong> (open-source model, run by us on Modal, modal.com) &mdash; processes your reference recording (and the consent recording, when we ask for one) and your text to create and speak with your voice clone</li>
              <li><strong>Speech-to-text service</strong> (our own transcription service) &mdash; transcribes the consent recording to check the phrase, when we ask for one</li>
            </ul>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Backend &amp; Authentication</h3>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li><strong>Supabase</strong> (supabase.com) &mdash; provides authentication, database, and file storage services</li>
            </ul>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">On-Device Processing</h3>
            <p className="text-gray-300">
              Apple&apos;s built-in voices (AVSpeechSynthesizer) process text entirely on your device. No data is sent
              externally when using on-device voices. You can switch to on-device voices at any time in Settings.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">4. How We Use Your Information</h2>
            <p className="text-gray-300 mb-4">We use the information we collect to:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Provide, maintain, and improve our services</li>
              <li>Process your content into audio using the AI services described in Section 3</li>
              <li>Create and maintain your voice clones</li>
              <li>Send you technical notices and support messages</li>
              <li>Respond to your comments and questions</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">5. Data Retention</h2>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li><strong>TTS audio:</strong> Cached on our servers for up to 30 days for performance, then automatically deleted</li>
              <li><strong>Voice clones and reference recordings:</strong> Stored until you delete them via the app</li>
              <li><strong>Consent records (confirmation and, when collected, consent recording, transcript, score):</strong> Kept while the voice exists and for 12 months after it is deleted</li>
              <li><strong>Fingerprints of generated audio:</strong> Kept for 90 days</li>
              <li><strong>AI summaries:</strong> Not stored on our servers after delivery to your device</li>
              <li><strong>Account data:</strong> Retained while your account is active; deleted upon account deletion</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">6. Third-Party Data Protection</h2>
            <p className="text-gray-300">
              All third-party services we use provide data protection measures consistent with industry standards.
              Self-hosted services (Kokoro TTS, and Chatterbox for voice cloning, which runs on Modal) run on cloud
              infrastructure under our accounts with encryption in transit (TLS). Third-party APIs (ElevenLabs, OpenAI) are accessed under
              API agreements that prohibit use of your data for model training.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">7. Data Security</h2>
            <p className="text-gray-300">
              We implement appropriate security measures to protect your personal information. All data is
              encrypted using industry-standard protocols. However, no method of transmission over the Internet
              is 100% secure.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">8. Your Rights</h2>
            <p className="text-gray-300 mb-4">You have the right to:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Access your personal data</li>
              <li>Delete your account and associated data</li>
              <li>Delete your voice clones at any time</li>
              <li>Revoke consent for AI data sharing (limits you to on-device voices)</li>
              <li>Export your data</li>
              <li>Opt out of marketing communications</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">9. Website Visits and the Homepage Demo</h2>
            <p className="text-gray-300 mb-4">
              When you visit readaloudai.org we count the page load, without cookies and without any script running in your browser.
              For each visit we record:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>The page you loaded and the time</li>
              <li>The website that sent you here (the site name only, not the address of the page you came from)</li>
              <li>Your browser&apos;s user-agent string</li>
              <li>Your approximate location (country and city), worked out from your IP address</li>
              <li>An anonymous visitor ID made from your IP address, browser and the date, which changes every day, so we cannot follow you from one day to the next</li>
            </ul>
            <p className="text-gray-300 mt-4 mb-4">
              We do not store IP addresses ourselves. They are sent to our analytics provider, PostHog (posthog.com), only so it can work out
              the approximate location. We do not count requests that look like bots or automated checks.
            </p>
            <p className="text-gray-300">
              When you play the voice demo on the homepage, we also record which example sentence you chose (or that you typed your own text and how
              long it was), how long the first audio took, how much audio played, and whether it finished or failed. The text you type is sent to our voice
              server to make the audio, but it is not included in these analytics records.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">10. Contact Us</h2>
            <p className="text-gray-300">
              If you have any questions about this Privacy Policy, please contact us at{' '}
              <a href="mailto:privacy@readaloudai.org" className="text-primary hover:text-primary-dark">
                privacy@readaloudai.org
              </a>
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
