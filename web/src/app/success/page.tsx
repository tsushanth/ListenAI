'use client'

import Link from 'next/link'
import { ArrowRight, Info } from 'lucide-react'
import { motion } from 'framer-motion'
import { PLAY_STORE_URL, successCopy } from '@/lib/webPro'

// This page used to tell every visitor their PRO plan was live, without checking
// anything: no entitlement existed to check. It now states only what is true (see lib/webPro.ts successCopy).
// The Stripe session id in the URL is deliberately not read: the page cannot verify it and must not imply it did.
export default function SuccessPage() {
  const copy = successCopy()

  return (
    <main className="min-h-screen bg-dark flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="max-w-md w-full text-center"
      >
        <div className="w-20 h-20 bg-primary/20 rounded-full flex items-center justify-center mx-auto mb-6">
          <Info className="w-10 h-10 text-primary" />
        </div>

        <h1 className="text-3xl font-bold text-white mb-4">{copy.title}</h1>

        <p className="text-gray-400 mb-8">{copy.body}</p>

        {copy.showPlayLink && (
          <div className="space-y-4 mb-8">
            <Link
              href={PLAY_STORE_URL}
              target="_blank"
              className="flex items-center justify-center space-x-3 bg-white text-dark px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors w-full"
            >
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3,20.5V3.5C3,2.91 3.34,2.39 3.84,2.15L13.69,12L3.84,21.85C3.34,21.6 3,21.09 3,20.5M16.81,15.12L6.05,21.34L14.54,12.85L16.81,15.12M20.16,10.81C20.5,11.08 20.75,11.5 20.75,12C20.75,12.5 20.53,12.9 20.18,13.18L17.89,14.5L15.39,12L17.89,9.5L20.16,10.81M6.05,2.66L16.81,8.88L14.54,11.15L6.05,2.66Z"/>
              </svg>
              <span className="font-semibold">Get ReadAloud AI on Google Play</span>
            </Link>
          </div>
        )}

        <Link
          href="/"
          className="inline-flex items-center space-x-2 text-primary hover:text-primary-dark transition-colors"
        >
          <span>Back to home</span>
          <ArrowRight className="w-4 h-4" />
        </Link>
      </motion.div>
    </main>
  )
}
