'use client'

import { motion } from 'framer-motion'
import { Play, Headphones, Mic } from 'lucide-react'
import Link from 'next/link'

export default function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-16">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-dark via-dark-secondary to-dark" />

      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl animate-pulse-slow" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-orange-500/10 rounded-full blur-3xl animate-pulse-slow" style={{ animationDelay: '1s' }} />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left content */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-center lg:text-left"
          >
            <div className="inline-flex items-center space-x-2 bg-dark-tertiary px-4 py-2 rounded-full mb-6">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-sm text-gray-300">Now with Voice Cloning</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold leading-tight mb-6">
              Turn Any Text Into{' '}
              <span className="gradient-text">Natural Speech</span>
            </h1>

            <p className="text-xl text-gray-400 mb-8 max-w-lg mx-auto lg:mx-0">
              Transform articles, PDFs, emails, and documents into natural-sounding audio.
              Listen to your content anywhere with AI-powered voices.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start flex-wrap">
              {/* Web App Button */}
              <Link
                href="/app"
                className="inline-flex items-center justify-center space-x-3 bg-primary text-dark px-6 py-3 rounded-xl hover:bg-primary-dark transition-colors"
              >
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                </svg>
                <div className="text-left">
                  <div className="text-xs">Try it now</div>
                  <div className="text-lg font-semibold">Web App</div>
                </div>
              </Link>

              {/* App Store Button */}
              <Link
                href="https://apps.apple.com/us/app/readaloud-ai/id6757346255"
                target="_blank"
                className="inline-flex items-center justify-center space-x-3 bg-white text-dark px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors"
              >
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                </svg>
                <div className="text-left">
                  <div className="text-xs">Download on the</div>
                  <div className="text-lg font-semibold">App Store</div>
                </div>
              </Link>

              {/* Play Store Button - Coming Soon */}
              <div
                className="inline-flex items-center justify-center space-x-3 bg-gray-700 text-gray-300 px-6 py-3 rounded-xl cursor-not-allowed opacity-75"
              >
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3,20.5V3.5C3,2.91 3.34,2.39 3.84,2.15L13.69,12L3.84,21.85C3.34,21.6 3,21.09 3,20.5M16.81,15.12L6.05,21.34L14.54,12.85L16.81,15.12M20.16,10.81C20.5,11.08 20.75,11.5 20.75,12C20.75,12.5 20.53,12.9 20.18,13.18L17.89,14.5L15.39,12L17.89,9.5L20.16,10.81M6.05,2.66L16.81,8.88L14.54,11.15L6.05,2.66Z"/>
                </svg>
                <div className="text-left">
                  <div className="text-xs">Android</div>
                  <div className="text-lg font-semibold">Coming Soon</div>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="flex justify-center lg:justify-start gap-8 mt-12">
              <div>
                <div className="text-3xl font-bold text-white">50+</div>
                <div className="text-sm text-gray-400">AI Voices</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-white">10+</div>
                <div className="text-sm text-gray-400">Languages</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-white">Unlimited</div>
                <div className="text-sm text-gray-400">Listening</div>
              </div>
            </div>
          </motion.div>

          {/* Right content - Phone mockup */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="relative flex justify-center"
          >
            <div className="relative">
              {/* Phone frame */}
              <div className="relative w-72 h-[580px] bg-dark-tertiary rounded-[3rem] p-3 shadow-2xl border border-gray-700">
                {/* Screen */}
                <div className="w-full h-full bg-dark-secondary rounded-[2.5rem] overflow-hidden relative">
                  {/* Notch */}
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-7 bg-dark-tertiary rounded-b-2xl" />

                  {/* App content mockup */}
                  <div className="pt-12 px-4">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-6">
                      <div className="text-white font-semibold">Library</div>
                      <div className="w-8 h-8 bg-dark-tertiary rounded-full" />
                    </div>

                    {/* Article cards */}
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="bg-dark-tertiary rounded-2xl p-4 mb-3">
                        <div className="flex items-start space-x-3">
                          <div className="w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center">
                            <Headphones className="w-6 h-6 text-primary" />
                          </div>
                          <div className="flex-1">
                            <div className="h-4 bg-gray-700 rounded w-3/4 mb-2" />
                            <div className="h-3 bg-gray-800 rounded w-1/2" />
                          </div>
                        </div>
                        {/* Waveform */}
                        <div className="flex items-center justify-center space-x-1 mt-4">
                          {[...Array(7)].map((_, j) => (
                            <div
                              key={j}
                              className="w-1 bg-primary rounded-full waveform-bar"
                              style={{
                                height: `${8 + Math.random() * 16}px`,
                                animationDelay: `${j * 0.1}s`
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    ))}

                    {/* Mini player */}
                    <div className="absolute bottom-4 left-4 right-4 bg-primary rounded-2xl p-3 flex items-center space-x-3">
                      <div className="w-10 h-10 bg-dark rounded-xl flex items-center justify-center">
                        <Play className="w-5 h-5 text-primary" fill="currentColor" />
                      </div>
                      <div className="flex-1">
                        <div className="h-2 bg-dark/30 rounded w-full" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Floating elements */}
              <motion.div
                animate={{ y: [-10, 10, -10] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                className="absolute -top-4 -right-8 bg-dark-tertiary rounded-2xl p-4 shadow-xl border border-gray-700"
              >
                <Mic className="w-8 h-8 text-primary" />
              </motion.div>

              <motion.div
                animate={{ y: [10, -10, 10] }}
                transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
                className="absolute -bottom-4 -left-8 bg-primary rounded-2xl px-4 py-2 shadow-xl"
              >
                <span className="text-dark font-semibold">Clone Your Voice</span>
              </motion.div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
