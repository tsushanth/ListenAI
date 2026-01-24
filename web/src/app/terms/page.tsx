import Link from 'next/link'

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-dark py-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <Link href="/" className="text-primary hover:text-primary-dark mb-8 inline-block">
          &larr; Back to Home
        </Link>

        <h1 className="text-4xl font-bold text-white mb-8">Terms of Service</h1>

        <div className="prose prose-invert max-w-none">
          <p className="text-gray-400 mb-6">Last updated: January 2026</p>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">1. Acceptance of Terms</h2>
            <p className="text-gray-300">
              By accessing or using ReadAloud AI, you agree to be bound by these Terms of Service.
              If you do not agree to these terms, please do not use our services.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">2. Description of Service</h2>
            <p className="text-gray-300">
              ReadAloud AI provides text-to-speech services that convert written content into audio.
              Our services include content import, AI voice synthesis, voice cloning, and audio playback features.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">3. User Accounts</h2>
            <p className="text-gray-300 mb-4">To use certain features, you may need to create an account. You agree to:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Provide accurate and complete information</li>
              <li>Maintain the security of your account credentials</li>
              <li>Notify us immediately of any unauthorized use</li>
              <li>Be responsible for all activities under your account</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">4. Voice Cloning</h2>
            <p className="text-gray-300 mb-4">
              When using our voice cloning feature, you agree to:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Only clone voices you have permission to clone (your own or with explicit consent)</li>
              <li>Not use cloned voices for impersonation, fraud, or malicious purposes</li>
              <li>Not create clones of public figures without authorization</li>
              <li>Accept responsibility for how you use cloned voices</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">5. Acceptable Use</h2>
            <p className="text-gray-300 mb-4">You agree not to use our services to:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Violate any laws or regulations</li>
              <li>Infringe on intellectual property rights</li>
              <li>Distribute malware or harmful content</li>
              <li>Harass, abuse, or harm others</li>
              <li>Interfere with the proper functioning of the service</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">6. Subscriptions and Payments</h2>
            <p className="text-gray-300 mb-4">
              Some features require a paid subscription. By subscribing, you agree to:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Pay all applicable fees</li>
              <li>Automatic renewal unless cancelled</li>
              <li>Our refund policy (7-day trial, 30-day money-back guarantee)</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">7. Intellectual Property</h2>
            <p className="text-gray-300">
              ReadAloud AI and its content, features, and functionality are owned by us and are protected
              by copyright, trademark, and other intellectual property laws. You retain ownership of
              content you import, but grant us a license to process it for providing the service.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">8. Limitation of Liability</h2>
            <p className="text-gray-300">
              To the maximum extent permitted by law, ReadAloud AI shall not be liable for any indirect,
              incidental, special, consequential, or punitive damages resulting from your use of the service.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">9. Changes to Terms</h2>
            <p className="text-gray-300">
              We may modify these terms at any time. Continued use of the service after changes
              constitutes acceptance of the new terms.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">10. Contact Us</h2>
            <p className="text-gray-300">
              If you have any questions about these Terms of Service, please contact us at{' '}
              <a href="mailto:legal@readaloudai.org" className="text-primary hover:text-primary-dark">
                legal@readaloudai.org
              </a>
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
