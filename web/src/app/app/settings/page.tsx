'use client'

import { useState, useEffect } from 'react'
import { User, Smartphone, ExternalLink, Copy, Check } from 'lucide-react'
import DeveloperApiSection from '@/components/DeveloperApiSection'

export default function SettingsPage() {
  const [deviceId, setDeviceId] = useState<string>('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let id = localStorage.getItem('deviceId')
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem('deviceId', id)
    }
    setDeviceId(id)
  }, [])

  const copyDeviceId = () => {
    navigator.clipboard.writeText(deviceId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Settings</h1>
        <p className="text-white/60">
          Manage your account and preferences.
        </p>
      </div>

      {/* Account Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <User size={20} className="text-blue-400" />
          Account
        </h2>

        <div className="glass rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-sm text-white/60 mb-2">Device ID</label>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-dark-tertiary border border-white/10 rounded-lg px-4 py-3 text-white/70 font-mono text-sm truncate">
                {deviceId}
              </div>
              <button
                onClick={copyDeviceId}
                className="p-3 bg-dark-tertiary rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                title="Copy Device ID"
              >
                {copied ? <Check size={20} className="text-green-400" /> : <Copy size={20} />}
              </button>
            </div>
            <p className="text-xs text-white/50 mt-2">
              This ID identifies your device. Your voices and rewards are linked to this ID.
            </p>
          </div>
        </div>
      </section>

      <DeveloperApiSection />

      {/* Mobile App Section */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Smartphone size={20} className="text-purple-400" />
          Mobile App
        </h2>

        <div className="glass rounded-xl p-6">
          <p className="text-white/70 mb-4">
            Get the full ReadAloud AI experience with our iOS app. Clone your voice, import articles, and listen on the go.
          </p>

          <a
            href="https://apps.apple.com/app/readaloud-ai"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-white text-black font-semibold px-6 py-3 rounded-lg hover:bg-white/90 transition-colors"
          >
            Download on the App Store
            <ExternalLink size={18} />
          </a>
        </div>
      </section>

      {/* About Section */}
      <section>
        <h2 className="text-lg font-semibold mb-4">About</h2>

        <div className="glass rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-white/60">Version</span>
            <span className="font-mono">1.0.0</span>
          </div>

          <div className="border-t border-white/10 pt-4 space-y-2">
            <a
              href="/privacy"
              className="block text-white/70 hover:text-white transition-colors"
            >
              Privacy Policy
            </a>
            <a
              href="/terms"
              className="block text-white/70 hover:text-white transition-colors"
            >
              Terms of Service
            </a>
            <a
              href="mailto:support@kreativekoala.llc"
              className="block text-white/70 hover:text-white transition-colors"
            >
              Contact Support
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
