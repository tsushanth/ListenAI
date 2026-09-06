'use client'

import { motion } from 'framer-motion'
import { Check, Zap, Globe, Mic2 } from 'lucide-react'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import DeveloperApiSection from '@/components/DeveloperApiSection'

const CODE_SAMPLE = `const ws = new WebSocket(
  "wss://api.readaloudai.org/tts?key=YOUR_API_KEY"
)

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "synthesize",
    text: "Hello, this is realtime text to speech.",
    voice: "af_heart",
    speed: 1.0,
  }))
}

// Server alternates: a JSON "chunk_meta" frame, immediately followed by
// one binary PCM16LE mono 24kHz audio frame — repeated until "done".
ws.onmessage = (event) => {
  if (typeof event.data === "string") {
    const msg = JSON.parse(event.data)
    if (msg.type === "done") console.log("synthesis complete")
    if (msg.type === "error") console.error(msg.message)
    // msg.type === "chunk_meta" -> next binary frame is this chunk's audio
  } else {
    // binary PCM16LE mono 24kHz frame — queue it for playback
    playAudioChunk(event.data)
  }
}`

const plans = [
  {
    name: 'Free',
    price: '$0',
    period: 'to start',
    description: 'For testing and small projects',
    features: [
      'Realtime WebSocket streaming',
      'Kokoro-82M voice model',
      'Pay-as-you-go beyond free tier',
      'No credit card required to try',
    ],
    highlighted: false,
  },
  {
    name: 'Pay as you go',
    price: 'Usage-based',
    period: '',
    description: 'Scales with your app, no plan to manage',
    features: [
      'Everything in Free',
      'Priority GPU warm-up',
      'Multiple concurrent connections',
      'Key-based usage tracking',
      'Revoke/rotate keys anytime',
    ],
    highlighted: true,
  },
]

export default function DevelopersPage() {
  return (
    <main className="min-h-screen bg-dark">
      <Header />

      {/* Hero */}
      <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-5xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <span className="inline-flex items-center gap-2 bg-primary/10 text-primary text-sm font-medium px-4 py-1.5 rounded-full mb-6">
              <Zap size={14} /> Realtime Text-to-Speech API
            </span>
            <h1 className="text-4xl sm:text-6xl font-bold text-white mb-6">
              Streaming TTS,{' '}
              <span className="gradient-text">built for developers</span>
            </h1>
            <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-10">
              A WebSocket API that streams natural-sounding speech as it&apos;s generated —
              the same engine that powers ReadAloud AI, now available for your own apps.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <a
                href="#get-started"
                className="bg-primary text-dark px-6 py-3 rounded-xl font-semibold hover:bg-primary-dark transition-colors"
              >
                Get an API key
              </a>
              <a
                href="#code-sample"
                className="bg-dark-tertiary text-white px-6 py-3 rounded-xl font-semibold hover:bg-dark-tertiary/80 transition-colors border border-white/10"
              >
                View the code
              </a>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 bg-dark-secondary border-y border-dark-tertiary">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 grid md:grid-cols-3 gap-8">
          {[
            {
              icon: Zap,
              title: 'Low-latency streaming',
              desc: 'Audio starts streaming back over WebSocket as it’s generated — no waiting for the full clip to render.',
            },
            {
              icon: Mic2,
              title: 'Natural voices',
              desc: 'Powered by Kokoro-82M, the same model behind ReadAloud AI’s app-store-rated voice quality.',
            },
            {
              icon: Globe,
              title: 'Simple key-based auth',
              desc: 'Generate a key from your dashboard, pass it as a query param, start streaming. No OAuth dance.',
            },
          ].map((f) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4 }}
            >
              <f.icon className="text-primary mb-4" size={28} />
              <h3 className="text-white font-semibold mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Code sample */}
      <section id="code-sample" className="py-24 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-center mb-10"
          >
            <h2 className="text-3xl font-bold text-white mb-4">
              Three lines to your first audio chunk
            </h2>
            <p className="text-gray-400">A plain WebSocket connection. Use it from Node, the browser, or any language with a WS client.</p>
          </motion.div>
          <div className="bg-dark-secondary border border-dark-tertiary rounded-2xl p-6 overflow-x-auto">
            <pre className="text-sm text-gray-300 font-mono leading-relaxed">
              <code>{CODE_SAMPLE}</code>
            </pre>
          </div>
          <p className="text-xs text-white/40 mt-4 text-center">
            Note: the GPU backend is provisioned on demand and can take up to ~5 minutes to spin up after
            being idle, then stays warm for 15 minutes after your last request.
          </p>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 bg-dark-secondary border-y border-dark-tertiary">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl font-bold text-white mb-4">Simple API pricing</h2>
            <p className="text-gray-400">Start free. Pay only for what you stream.</p>
          </motion.div>

          <div className="grid sm:grid-cols-2 gap-8">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`rounded-2xl p-8 ${
                  plan.highlighted
                    ? 'bg-gradient-to-b from-primary/20 to-dark-secondary border-2 border-primary'
                    : 'bg-dark border border-dark-tertiary'
                }`}
              >
                <h3 className="text-xl font-semibold text-white mb-1">{plan.name}</h3>
                <p className="text-gray-400 text-sm mb-4">{plan.description}</p>
                <div className="mb-6">
                  <span className="text-3xl font-bold text-white">{plan.price}</span>
                  {plan.period && <span className="text-gray-400 ml-1">{plan.period}</span>}
                </div>
                <ul className="space-y-3">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-3 text-sm text-gray-300">
                      <Check className="text-primary flex-shrink-0" size={16} />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Get started / key generation */}
      <section id="get-started" className="py-24 px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-center mb-10"
          >
            <h2 className="text-3xl font-bold text-white mb-4">Get your API key</h2>
            <p className="text-gray-400">Sign in and generate a key. It&apos;s ready to use immediately.</p>
          </motion.div>
          <DeveloperApiSection />
        </div>
      </section>

      <Footer />
    </main>
  )
}
