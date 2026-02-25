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
          <p className="text-gray-400 mb-6">Last updated: February 2026</p>

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
              If you use our voice cloning feature, we collect voice recordings to create your personalized voice clone.
              This data is:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Encrypted in transit and at rest</li>
              <li>Only used to generate your voice clone</li>
              <li>Processed by Chatterbox TTS, hosted on our Google Cloud infrastructure (see Section 3 for details)</li>
              <li>Stored in Supabase Storage (encrypted at rest)</li>
              <li>Deletable at any time through the app</li>
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
              <li><strong>Kokoro TTS</strong> (self-hosted on Google Cloud Platform, us-central1 region) &mdash; processes text for standard quality voices</li>
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
              <li><strong>Chatterbox TTS</strong> (self-hosted on Google Cloud Platform) &mdash; processes audio to create voice clones</li>
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
              <li><strong>Voice clones:</strong> Stored until you delete them via the app</li>
              <li><strong>AI summaries:</strong> Not stored on our servers after delivery to your device</li>
              <li><strong>Account data:</strong> Retained while your account is active; deleted upon account deletion</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">6. Third-Party Data Protection</h2>
            <p className="text-gray-300">
              All third-party services we use provide data protection measures consistent with industry standards.
              Self-hosted services (Kokoro TTS, Chatterbox) run on our own Google Cloud infrastructure with
              encryption in transit (TLS 1.3) and at rest. Third-party APIs (ElevenLabs, OpenAI) are accessed under
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
            <h2 className="text-2xl font-semibold text-white mb-4">9. Contact Us</h2>
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
