'use client'

import Link from 'next/link'
import { Mail } from 'lucide-react'

export default function Footer() {
  return (
    <footer id="download" className="py-16 bg-dark border-t border-dark-tertiary">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Download CTA */}
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to Start Listening?
          </h2>
          <p className="text-gray-400 mb-8">
            Download ReadAloud AI for free and transform how you consume content.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            {/* App Store Button */}
            <Link
              href="https://apps.apple.com/app/readaloud-ai"
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

            {/* Play Store Button */}
            <Link
              href="https://play.google.com/store/apps/details?id=com.listenai"
              target="_blank"
              className="inline-flex items-center justify-center space-x-3 bg-white text-dark px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors"
            >
              <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3,20.5V3.5C3,2.91 3.34,2.39 3.84,2.15L13.69,12L3.84,21.85C3.34,21.6 3,21.09 3,20.5M16.81,15.12L6.05,21.34L14.54,12.85L16.81,15.12M20.16,10.81C20.5,11.08 20.75,11.5 20.75,12C20.75,12.5 20.53,12.9 20.18,13.18L17.89,14.5L15.39,12L17.89,9.5L20.16,10.81M6.05,2.66L16.81,8.88L14.54,11.15L6.05,2.66Z"/>
              </svg>
              <div className="text-left">
                <div className="text-xs">Get it on</div>
                <div className="text-lg font-semibold">Google Play</div>
              </div>
            </Link>
          </div>
        </div>

        {/* Footer links */}
        <div className="grid md:grid-cols-4 gap-8 mb-12">
          <div>
            <Link href="/" className="flex items-center space-x-2 mb-4">
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-dark" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                </svg>
              </div>
              <span className="text-xl font-bold text-white">ReadAloud<span className="text-primary">AI</span></span>
            </Link>
            <p className="text-gray-400 text-sm">
              Turn any text into natural speech. Listen to your content anywhere.
            </p>
          </div>

          <div>
            <h4 className="text-white font-semibold mb-4">Product</h4>
            <ul className="space-y-2">
              <li><Link href="#features" className="text-gray-400 hover:text-white transition-colors">Features</Link></li>
              <li><Link href="#pricing" className="text-gray-400 hover:text-white transition-colors">Pricing</Link></li>
              <li><Link href="#faq" className="text-gray-400 hover:text-white transition-colors">FAQ</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="text-white font-semibold mb-4">Legal</h4>
            <ul className="space-y-2">
              <li><Link href="/privacy" className="text-gray-400 hover:text-white transition-colors">Privacy Policy</Link></li>
              <li><Link href="/terms" className="text-gray-400 hover:text-white transition-colors">Terms of Service</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="text-white font-semibold mb-4">Contact</h4>
            <Link href="mailto:support@readaloudai.org" className="flex items-center space-x-2 text-gray-400 hover:text-white transition-colors">
              <Mail className="w-4 h-4" />
              <span>support@readaloudai.org</span>
            </Link>
          </div>
        </div>

        {/* Copyright */}
        <div className="border-t border-dark-tertiary pt-8 text-center">
          <p className="text-gray-500 text-sm">
            &copy; {new Date().getFullYear()} ReadAloud AI. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}
