'use client'

import { motion } from 'framer-motion'
import { Mic, Wand2, Sparkles, Shield } from 'lucide-react'

export default function VoiceCloning() {
  return (
    <section className="py-24 bg-dark-secondary overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left - Content */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center space-x-2 bg-primary/10 px-4 py-2 rounded-full mb-6">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm text-primary font-medium">New Feature</span>
            </div>

            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-6">
              Listen in{' '}
              <span className="gradient-text">Your Own Voice</span>
            </h2>

            <p className="text-xl text-gray-400 mb-8">
              Clone any voice with just 30 seconds of audio. Listen to articles, documents,
              and more read by you, or any voice you choose.
            </p>

            <div className="space-y-4">
              <div className="flex items-start space-x-4">
                <div className="w-10 h-10 bg-primary/20 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Mic className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h4 className="text-white font-semibold mb-1">30 Second Recording</h4>
                  <p className="text-gray-400 text-sm">Just record a short sample of your voice reading the provided text.</p>
                </div>
              </div>

              <div className="flex items-start space-x-4">
                <div className="w-10 h-10 bg-primary/20 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Wand2 className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h4 className="text-white font-semibold mb-1">AI Cloning Magic</h4>
                  <p className="text-gray-400 text-sm">Our AI creates a natural-sounding clone that captures your unique voice.</p>
                </div>
              </div>

              <div className="flex items-start space-x-4">
                <div className="w-10 h-10 bg-primary/20 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Shield className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h4 className="text-white font-semibold mb-1">Private & Secure</h4>
                  <p className="text-gray-400 text-sm">Your voice data is encrypted and never shared. Delete anytime.</p>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Right - Visual */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="relative"
          >
            <div className="relative bg-dark-tertiary rounded-3xl p-8 border border-gray-700">
              {/* Voice cloning UI mockup */}
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center w-24 h-24 bg-primary/20 rounded-full mb-4 relative">
                  <Mic className="w-12 h-12 text-primary" />
                  {/* Pulse rings */}
                  <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping" />
                </div>
                <h3 className="text-white font-semibold text-lg">Recording your voice...</h3>
                <p className="text-gray-400 text-sm mt-1">00:24 / 00:30</p>
              </div>

              {/* Waveform visualization */}
              <div className="bg-dark rounded-2xl p-6 mb-6">
                <div className="flex items-center justify-center space-x-1 h-16">
                  {[...Array(30)].map((_, i) => (
                    <motion.div
                      key={i}
                      className="w-1.5 bg-primary rounded-full"
                      animate={{
                        height: [8, Math.random() * 40 + 16, 8],
                      }}
                      transition={{
                        duration: 0.8,
                        repeat: Infinity,
                        delay: i * 0.05,
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Sample text */}
              <div className="bg-dark rounded-2xl p-4">
                <p className="text-gray-300 text-sm leading-relaxed">
                  <span className="text-primary">Welcome to ReadAloud.</span>{' '}
                  <span className="text-gray-500">I&apos;m recording my voice so the app can create a personalized voice clone that sounds just like me...</span>
                </p>
              </div>

              {/* Progress bar */}
              <div className="mt-6">
                <div className="h-2 bg-dark rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-primary"
                    initial={{ width: '0%' }}
                    whileInView={{ width: '80%' }}
                    viewport={{ once: true }}
                    transition={{ duration: 2, ease: 'easeOut' }}
                  />
                </div>
              </div>
            </div>

            {/* Floating badge */}
            <motion.div
              animate={{ y: [-5, 5, -5] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -top-4 -right-4 bg-green-500/20 border border-green-500/30 rounded-2xl px-4 py-2"
            >
              <span className="text-green-400 text-sm font-medium">PRO Feature</span>
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
