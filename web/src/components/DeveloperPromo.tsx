'use client'

import { motion } from 'framer-motion'
import { Code2, ArrowRight } from 'lucide-react'
import Link from 'next/link'

export default function DeveloperPromo() {
  return (
    <section className="py-24 bg-dark">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="rounded-3xl bg-gradient-to-br from-dark-secondary to-dark-tertiary border border-white/10 p-10 sm:p-14 text-center"
        >
          <span className="inline-flex items-center gap-2 bg-primary/10 text-primary text-sm font-medium px-4 py-1.5 rounded-full mb-6">
            <Code2 size={14} /> For Developers
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Build with our realtime TTS API
          </h2>
          <p className="text-lg text-gray-400 max-w-xl mx-auto mb-8">
            The same streaming voice engine behind ReadAloud AI, available over a simple
            WebSocket API. Sign in, generate a key, start streaming audio.
          </p>
          <Link
            href="/developers"
            className="inline-flex items-center gap-2 bg-primary text-dark px-6 py-3 rounded-xl font-semibold hover:bg-primary-dark transition-colors"
          >
            Explore the API <ArrowRight size={18} />
          </Link>
        </motion.div>
      </div>
    </section>
  )
}
