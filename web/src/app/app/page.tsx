'use client'

import Link from 'next/link'
import { Store, Mic, Gift, BookOpen, ArrowRight } from 'lucide-react'
import { useMarketplaceStore } from '@/store/marketplaceStore'
import { useEffect } from 'react'

const features = [
  {
    href: '/app/marketplace',
    icon: Store,
    title: 'Voice Marketplace',
    description: 'Discover and use community-shared voices for your text-to-speech.',
    color: 'bg-orange-500/20 text-orange-400',
  },
  {
    href: '/app/my-voices',
    icon: Mic,
    title: 'My Voices',
    description: 'Manage your cloned voices and see which ones you\'ve shared.',
    color: 'bg-purple-500/20 text-purple-400',
  },
  {
    href: '/app/rewards',
    icon: Gift,
    title: 'Rewards',
    description: 'Earn free minutes when others use your shared voices.',
    color: 'bg-green-500/20 text-green-400',
  },
  {
    href: '/app/reader',
    icon: BookOpen,
    title: 'Reader',
    description: 'Convert any text to natural-sounding speech instantly.',
    color: 'bg-blue-500/20 text-blue-400',
  },
]

export default function AppHome() {
  const { rewards, loadRewards } = useMarketplaceStore()

  useEffect(() => {
    loadRewards()
  }, [loadRewards])

  return (
    <div className="max-w-4xl mx-auto">
      {/* Welcome section */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Welcome to ReadAloud AI</h1>
        <p className="text-white/60">
          Transform any text into natural-sounding speech with AI-powered voices.
        </p>
      </div>

      {/* Stats cards */}
      {rewards && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          <div className="glass rounded-xl p-6">
            <div className="text-3xl font-bold text-primary mb-1">
              {rewards.pending.minutes.toFixed(1)}
            </div>
            <div className="text-white/60 text-sm">Pending minutes to claim</div>
          </div>
          <div className="glass rounded-xl p-6">
            <div className="text-3xl font-bold text-green-400 mb-1">
              {rewards.credited.total_minutes.toFixed(1)}
            </div>
            <div className="text-white/60 text-sm">Total minutes earned</div>
          </div>
        </div>
      )}

      {/* Feature cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {features.map((feature) => (
          <Link
            key={feature.href}
            href={feature.href}
            className="group glass rounded-xl p-6 hover:bg-white/10 transition-colors"
          >
            <div className="flex items-start gap-4">
              <div className={`p-3 rounded-lg ${feature.color}`}>
                <feature.icon size={24} />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
                  {feature.title}
                  <ArrowRight
                    size={16}
                    className="opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all"
                  />
                </h2>
                <p className="text-white/60 text-sm">{feature.description}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* Quick action */}
      <div className="mt-8 glass rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-2">Quick Start</h2>
        <p className="text-white/60 text-sm mb-4">
          Have text you want to listen to? Paste it in the Reader and hear it spoken aloud.
        </p>
        <Link
          href="/app/reader"
          className="inline-flex items-center gap-2 bg-primary text-black font-semibold px-6 py-3 rounded-lg hover:bg-primary-dark transition-colors"
        >
          <BookOpen size={20} />
          Open Reader
        </Link>
      </div>
    </div>
  )
}
