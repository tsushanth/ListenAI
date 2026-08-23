'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle, ArrowRight, Download } from 'lucide-react'
import { motion } from 'framer-motion'

function SuccessContent() {
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('session_id')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // You could verify the session here
    setLoading(false)
  }, [sessionId])

  if (loading) {
    return (
      <div className="min-h-screen bg-dark flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-dark flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="max-w-md w-full text-center"
      >
        {/* Success icon */}
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
          className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6"
        >
          <CheckCircle className="w-10 h-10 text-green-500" />
        </motion.div>

        <h1 className="text-3xl font-bold text-white mb-4">
          Payment Successful!
        </h1>

        <p className="text-gray-400 mb-8">
          Thank you for your purchase! Your PRO subscription is now active.
          Download the app to start enjoying premium features.
        </p>

        {/* Download buttons */}
        <div className="space-y-4 mb-8">
          <Link
            href="https://play.google.com/store/apps/details?id=com.listenai"
            target="_blank"
            className="flex items-center justify-center space-x-3 bg-white text-dark px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors w-full"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3,20.5V3.5C3,2.91 3.34,2.39 3.84,2.15L13.69,12L3.84,21.85C3.34,21.6 3,21.09 3,20.5M16.81,15.12L6.05,21.34L14.54,12.85L16.81,15.12M20.16,10.81C20.5,11.08 20.75,11.5 20.75,12C20.75,12.5 20.53,12.9 20.18,13.18L17.89,14.5L15.39,12L17.89,9.5L20.16,10.81M6.05,2.66L16.81,8.88L14.54,11.15L6.05,2.66Z"/>
            </svg>
            <span className="font-semibold">Download for Android</span>
          </Link>
        </div>

        {/* Instructions */}
        <div className="bg-dark-secondary rounded-2xl p-6 text-left mb-8">
          <h3 className="text-white font-semibold mb-4 flex items-center space-x-2">
            <Download className="w-5 h-5 text-primary" />
            <span>How to activate your subscription</span>
          </h3>
          <ol className="space-y-3 text-gray-400 text-sm">
            <li className="flex items-start space-x-3">
              <span className="bg-primary text-dark w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold">1</span>
              <span>Download the ReadAloud AI app from your app store</span>
            </li>
            <li className="flex items-start space-x-3">
              <span className="bg-primary text-dark w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold">2</span>
              <span>Sign in with the same email you used for payment</span>
            </li>
            <li className="flex items-start space-x-3">
              <span className="bg-primary text-dark w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold">3</span>
              <span>Your PRO features will be automatically unlocked</span>
            </li>
          </ol>
        </div>

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

export default function SuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-dark flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    }>
      <SuccessContent />
    </Suspense>
  )
}
