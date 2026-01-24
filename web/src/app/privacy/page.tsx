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
          <p className="text-gray-400 mb-6">Last updated: January 2026</p>

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
              <li>Never shared with third parties</li>
              <li>Deletable at any time through the app</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">3. How We Use Your Information</h2>
            <p className="text-gray-300 mb-4">We use the information we collect to:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Provide, maintain, and improve our services</li>
              <li>Process your content into audio</li>
              <li>Create and maintain your voice clones</li>
              <li>Send you technical notices and support messages</li>
              <li>Respond to your comments and questions</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">4. Data Security</h2>
            <p className="text-gray-300">
              We implement appropriate security measures to protect your personal information. All data is
              encrypted using industry-standard protocols. However, no method of transmission over the Internet
              is 100% secure.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">5. Your Rights</h2>
            <p className="text-gray-300 mb-4">You have the right to:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Access your personal data</li>
              <li>Delete your account and associated data</li>
              <li>Delete your voice clones at any time</li>
              <li>Export your data</li>
              <li>Opt out of marketing communications</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">6. Contact Us</h2>
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
