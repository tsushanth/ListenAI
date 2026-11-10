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
          <p className="text-gray-400 mb-6">Last updated: November 10, 2026</p>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">1. Information We Collect</h2>
            <p className="text-gray-300 mb-4">
              ReadAloud AI collects information you provide directly to us, such as when you create an account,
              use our services, or contact us for support, and some technical information the apps send automatically.
              This may include:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Email address, and in the Android app the name and profile picture of your Google account, if you sign in</li>
              <li>Content you import or listen to (articles, PDFs, pasted text, web links, emails you choose to open), which is processed as described in Section 3</li>
              <li>Voice recordings for voice cloning (if you use this feature)</li>
              <li>Usage data and preferences</li>
              <li>In the Android app: crash and error reports, which are sent automatically, and usage statistics, which are sent only if you allow them (Section 9)</li>
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
            <h2 className="text-2xl font-semibold text-white mb-4">3. Where Your Text and Audio Go</h2>
            <p className="text-gray-300 mb-4">
              ReadAloud AI turns text into speech on servers that we run, and uses a small number of other services, listed below.
              <strong> In the Android app, text you listen to with a standard voice is sent to our speech service by default.
              The app does not show a separate consent prompt before it does this.</strong> Section 8 explains how to read on
              your device instead.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Text-to-Speech: the ReadAloud speech service</h3>
            <p className="text-gray-300 mb-3">
              When the Android app reads English text with one of its standard voices, it works like this:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>The app first asks our backend (listenai-backend.fly.dev) for a short-lived session token. That request does not contain your text, your account or your name.</li>
              <li>The app then sends the text, in sentence-sized pieces, together with the voice and speed you picked, directly to the ReadAloud speech service (api.readaloudai.org) over an encrypted connection, and plays the audio that comes back. The speech service runs Piper, an open-source speech model that we operate on cloud servers (Fly.io and Modal).</li>
              <li>Like any internet connection, this shows your IP address to those servers. We do not attach your account to these requests.</li>
              <li>This covers everything the app reads aloud: text you paste, documents and web pages you import, and, if you connect Gmail, the emails you open.</li>
              <li>Audio that comes back is also kept on your phone (up to about 150 MB, oldest removed first) so that re-reading the same text does not need the network.</li>
            </ul>
            <p className="text-gray-300 mt-3 mb-3">
              <strong>What we have not verified:</strong> we have not completed a review of whether the speech servers, or their
              hosting providers, keep request text in operational logs, or for how long. We therefore do not state a retention
              period for it, and we do not promise that it is not retained. Please do not send text through the app that you are
              not willing to have processed on these servers.
            </p>
            <p className="text-gray-300 mb-3">
              Text in languages other than English is not sent to the ReadAloud speech service. The app reads it with the
              speech engine already on your phone (for example Google or Samsung text-to-speech). That engine is provided by its
              maker, and its own privacy terms apply to what it does.
            </p>
            <p className="text-gray-300 mb-3">
              Older app versions and some other voices may use Kokoro, an open-source speech model that we operate on cloud servers.
              The ReadAloud text-to-speech engine app (ReadAloud Voice), which other apps can call, processes text on your device and, in its
              current configuration, does not send text read by other apps to our servers.
            </p>
            <p className="text-gray-300 mb-3">
              We do not send your text to any other text-to-speech provider.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Importing a Web Page by Link</h3>
            <p className="text-gray-300 mb-3">
              When you import a web page by link in the Android app, the link is sent to our backend. Our server downloads the page,
              extracts the article text, and by default sends that text to a language-model service to clean it up (remove menus,
              ads and similar clutter). The link may appear in our server logs. If our server cannot fetch the page, the app
              tries to download the page directly from your phone instead.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">AI Summarization and Article Cleanup</h3>
            <p className="text-gray-300 mb-3">
              When you ask for a summary, or when an imported web page is cleaned up as described above, the article text is sent to:
            </p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li><strong>Anthropic</strong> (anthropic.com, Claude models) &mdash; processes the text and returns the result, subject to <a href="https://www.anthropic.com/legal/privacy" className="text-primary hover:text-primary-dark">Anthropic&apos;s privacy policy</a>. We have not independently verified Anthropic&apos;s retention of API requests.</li>
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
              <li><strong>Google</strong> &mdash; Google sign-in, and Gmail access if you connect it (Section 9)</li>
            </ul>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">On-Device Processing</h3>
            <p className="text-gray-300">
              Importing PDF and EPUB files, recognising text in photos, and detecting the language of text happen on your device.
              On Android you can also turn on Offline AI in Settings: its voice model is downloaded once from Hugging Face
              (huggingface.co), and once it is loaded, standard voices read on your device and your text is not sent to our speech service.
              Apple&apos;s built-in voices (AVSpeechSynthesizer) on iOS also process text entirely on the device.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">4. How We Use Your Information</h2>
            <p className="text-gray-300 mb-4">We use the information we collect to:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Provide, maintain, and improve our services, including fixing crashes and errors</li>
              <li>Process your content into audio and, where you ask for it, summaries, using the services described in Section 3</li>
              <li>Create and maintain your voice clones</li>
              <li>Send you technical notices and support messages</li>
              <li>Respond to your comments and questions</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">5. Data Retention</h2>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li><strong>TTS audio:</strong> Cached on our servers for up to 30 days for performance, then automatically deleted</li>
              <li><strong>Text read aloud in the Android app with standard voices:</strong> Our backend never receives this text. Whether the speech servers keep it in logs has not been verified, so we state no retention period (Section 3). Audio is cached on your phone only.</li>
              <li><strong>Crash and error reports:</strong> Sent to a reporting service we run; see Section 9. We have not set or verified a fixed retention period for them.</li>
              <li><strong>Voice clones and reference recordings:</strong> Stored until you delete them via the app</li>
              <li><strong>Consent records (confirmation and, when collected, consent recording, transcript, score):</strong> Kept while the voice exists and for 12 months after it is deleted</li>
              <li><strong>Fingerprints of generated audio:</strong> Kept for 90 days</li>
              <li><strong>AI summaries:</strong> Not stored on our servers after delivery to your device</li>
              <li><strong>Account data:</strong> Kept while your account exists. If you ask us to delete your account, we delete it by hand as described in Section 10, subject to the exceptions listed there.</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">6. Service Providers</h2>
            <p className="text-gray-300">
              The speech models we operate (Piper, Kokoro and Chatterbox) run on cloud infrastructure under our own accounts, and
              the app connects to them over encrypted connections (TLS). Services run by others (Supabase, Anthropic, Google,
              RevenueCat, Hugging Face, Cloudflare, PostHog) handle data under their own terms and privacy policies, and we do not
              control how they operate. Apart from the points stated in this policy, we have not verified how long those providers
              keep data.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">7. Data Security</h2>
            <p className="text-gray-300">
              Data sent between the apps and our servers travels over encrypted connections (HTTPS/TLS). The Android app stores
              your sign-in tokens in Android&apos;s encrypted storage on your phone. We do not claim that every piece of data
              is encrypted wherever it is stored, and no method of transmission or storage is completely secure.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">8. Your Rights and Choices</h2>
            <p className="text-gray-300 mb-4">What you can do, and how:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li><strong>Keep reading on your device (Android).</strong> Turn on Offline AI in Settings (it needs Android 8 or later and 3 GB of RAM) and let the on-device voice finish downloading. Standard voices then read on your device. This is not an absolute guarantee: if the on-device voice cannot load, the app can fall back to our speech service.</li>
              <li><strong>Delete a voice clone.</strong> In the app (Settings, Voice Cloning) or by email.</li>
              <li><strong>Turn usage statistics on or off (Android).</strong> Settings, usage statistics. Crash and error reports cannot currently be turned off in the app.</li>
              <li><strong>Delete your account and data, access your data, or export it.</strong> There is no button in the app or website for these yet. Email us as described in Section 10 and we handle the request by hand.</li>
              <li><strong>Stop marketing email.</strong> Tell us by email and we will stop.</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">9. Android App: Sign-In, Gmail, Statistics, Crash Reports and Purchases</h2>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>
                <strong>Google sign-in.</strong> Sign-in is optional and is needed for voice cloning and for syncing your plan. When you sign in, Google
                gives the app an ID token that our backend exchanges for an account in Supabase, which stores your email, name and
                profile picture from your Google account. Your phone&apos;s Android ID, or a random ID if that is unavailable, is sent to our
                backend with some requests (sign-in, linking your device to your account, and browsing the voice marketplace).
              </li>
              <li>
                <strong>Gmail (optional).</strong> If you connect Gmail to import emails, the app asks Google for the <code>gmail.modify</code> permission,
                which is broader than reading. The app only lists and reads messages; it does not send, delete or change email. Your Google access
                token is stored in encrypted storage on your phone and emails are fetched from Google directly to your phone, not through our servers.
                If you then listen to an email, its text is processed like any other text (Section 3). You can disconnect at any time in your
                Google Account settings under third-party access.
              </li>
              <li>
                <strong>Usage statistics (optional, off until you say yes).</strong> The first time you open the app it asks whether to share usage
                statistics. If you allow it, Google Firebase Analytics counts events such as opening the app, onboarding, importing content (the kind
                of import and its language, never the text), starting and finishing playback, which speech source was used, reaching the free limit, and
                viewing or completing a purchase. Firebase ties these to a random app-instance ID and records device model, app and Android version and
                approximate location, as described in <a href="https://firebase.google.com/support/privacy" className="text-primary hover:text-primary-dark">Firebase&apos;s privacy information</a>.
                If you decline, nothing is sent and locally stored analytics data is reset. The app does not read your advertising ID, has no advertising SDKs,
                and does not use this data for advertising.
              </li>
              <li>
                <strong>Crash and error reports (always on).</strong> If the app crashes, a feature fails, or one of our servers returns a server error, the app sends a
                report to a reporting service we run on Cloudflare Workers (app-failure-reporter.t-sushanth.workers.dev). The report contains the error and its
                stack trace, the app version, your device maker and model, your Android version and the name of the feature that failed (for a server error, the server name and request path, not the content). It is meant not to contain
                the text you read or import. These reports are sent automatically and are not covered by the usage-statistics choice. They carry no account ID, but a
                stack trace or error message could in rare cases include other details.
              </li>
              <li>
                <strong>Purchases and subscriptions.</strong> Purchases are processed by Google Play. RevenueCat (revenuecat.com) receives purchase and subscription status
                and an app user ID (your account ID if you are signed in), and some paywall information (such as which screen showed the paywall). Our paywall tooling also records paywall views and purchase events,
                with a random ID and any product and price involved, on a server we run (on Fly.io).
              </li>
              <li>
                <strong>Older versions.</strong> This describes the current Android app. Older versions may collect different data, including analytics that
                were on by default, so please update to the latest version.
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">10. Deleting Your Account and Data</h2>
            <p className="text-gray-300 mb-4">
              There is currently no delete-account button in the app or on the website. To have your account and data deleted:
            </p>
            <ol className="list-decimal pl-6 text-gray-300 space-y-2">
              <li>
                Email{' '}
                <a href="mailto:puzzleverseai@gmail.com?subject=ReadAloud%20AI%20account%20deletion" className="text-primary hover:text-primary-dark">puzzleverseai@gmail.com</a>{' '}
                with the subject &quot;ReadAloud AI account deletion&quot;, from the email address of the account you want deleted (the Google account you signed in with), so we can match the request to the account.
              </li>
              <li>We will reply to confirm that we received it. We handle these requests manually, so it is not instant.</li>
              <li>We then delete your account and the data tied to it, including voice clones and their reference recordings, from the systems we run (Supabase and our voice-cloning service), apart from the exceptions below.</li>
            </ol>
            <p className="text-gray-300 mt-4 mb-2">What deletion does not remove:</p>
            <ul className="list-disc pl-6 text-gray-300 space-y-2">
              <li>Consent records for voice clones, kept for 12 months after the voice is deleted, and fingerprints of generated audio, kept for 90 days (Section 2).</li>
              <li>Purchase and subscription records held by Google Play and RevenueCat, and any records we are legally required to keep. Deleting your account does not cancel a Google Play subscription: cancel it in Google Play.</li>
              <li>Crash and error reports, which are not linked to your account. Anonymous usage statistics already sent to Google Firebase are covered by Firebase&apos;s own terms.</li>
              <li>Anything held by other providers under their own policies, and text processed on our speech servers, whose retention we have not verified (Section 3).</li>
            </ul>
            <p className="text-gray-300 mt-4">
              You can also delete a voice clone yourself in the app at any time, and stop sharing usage statistics in Settings, without deleting your account.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold text-white mb-4">11. Website Visits and the Homepage Demo</h2>
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
            <h2 className="text-2xl font-semibold text-white mb-4">12. Contact Us</h2>
            <p className="text-gray-300">
              If you have any questions about this Privacy Policy, or want to make a request described in it, please contact us at{' '}
              <a href="mailto:puzzleverseai@gmail.com" className="text-primary hover:text-primary-dark">
                puzzleverseai@gmail.com
              </a>
              . You can also write to{' '}
              <a href="mailto:privacy@readaloudai.org" className="text-primary hover:text-primary-dark">
                privacy@readaloudai.org
              </a>
              ; for deletion requests, please use puzzleverseai@gmail.com as described in Section 10.
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
