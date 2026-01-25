'use client'

import { useEffect, useState } from 'react'
import { Gift, Clock, CheckCircle, Loader2, ArrowDown, TrendingUp } from 'lucide-react'
import { useMarketplaceStore } from '@/store/marketplaceStore'

export default function RewardsPage() {
  const {
    rewards,
    rewardHistory,
    rewardsLoading,
    loadRewards,
    loadRewardHistory,
    creditRewards,
  } = useMarketplaceStore()

  const [claiming, setClaiming] = useState(false)
  const [claimSuccess, setClaimSuccess] = useState<number | null>(null)

  useEffect(() => {
    loadRewards()
    loadRewardHistory()
  }, [loadRewards, loadRewardHistory])

  const handleClaim = async () => {
    setClaiming(true)
    try {
      const credited = await creditRewards()
      setClaimSuccess(credited)
      setTimeout(() => setClaimSuccess(null), 5000)
    } catch (error) {
      console.error('Failed to claim rewards:', error)
    } finally {
      setClaiming(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Rewards</h1>
        <p className="text-white/60">
          Earn free minutes when others use your shared voices.
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {/* Pending */}
        <div className="glass rounded-xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-orange-500/20 flex items-center justify-center">
              <Clock size={24} className="text-orange-400" />
            </div>
            <div>
              <div className="text-sm text-white/60">Pending Rewards</div>
              <div className="text-2xl font-bold">
                {rewards ? `${rewards.pending.minutes.toFixed(2)} min` : '—'}
              </div>
            </div>
          </div>

          {rewards && rewards.pending.minutes > 0 && (
            <button
              onClick={handleClaim}
              disabled={claiming}
              className="w-full flex items-center justify-center gap-2 bg-primary text-black font-semibold py-3 rounded-lg hover:bg-primary-dark transition-colors disabled:opacity-50"
            >
              {claiming ? (
                <Loader2 className="animate-spin" size={20} />
              ) : (
                <>
                  <ArrowDown size={20} />
                  Claim {rewards.pending.minutes.toFixed(2)} Minutes
                </>
              )}
            </button>
          )}

          {claimSuccess !== null && (
            <div className="mt-3 p-3 bg-green-500/20 text-green-400 rounded-lg text-sm text-center">
              Successfully claimed {claimSuccess.toFixed(2)} minutes!
            </div>
          )}
        </div>

        {/* Total Earned */}
        <div className="glass rounded-xl p-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
              <TrendingUp size={24} className="text-green-400" />
            </div>
            <div>
              <div className="text-sm text-white/60">Total Earned</div>
              <div className="text-2xl font-bold">
                {rewards ? `${rewards.credited.total_minutes.toFixed(2)} min` : '—'}
              </div>
            </div>
          </div>

          <div className="mt-4 text-sm text-white/50">
            {rewards
              ? `${rewards.pending.count} pending transactions`
              : 'Loading...'}
          </div>
        </div>
      </div>

      {/* How It Works */}
      <div className="glass rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Gift size={20} className="text-primary" />
          How Rewards Work
        </h2>
        <ul className="space-y-3 text-sm text-white/70">
          <li className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center shrink-0 text-xs font-bold">1</span>
            <span>Share your cloned voice to the marketplace</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center shrink-0 text-xs font-bold">2</span>
            <span>When others use your voice for TTS, you earn 10% of the audio duration</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-primary/20 text-primary flex items-center justify-center shrink-0 text-xs font-bold">3</span>
            <span>Claim your pending rewards to add minutes to your account</span>
          </li>
        </ul>
      </div>

      {/* Reward History */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Reward History</h2>

        {rewardsLoading && rewardHistory.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="animate-spin text-primary" size={32} />
          </div>
        ) : rewardHistory.length === 0 ? (
          <div className="glass rounded-xl p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-dark-tertiary flex items-center justify-center mx-auto mb-4">
              <Gift size={32} className="text-white/30" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No Rewards Yet</h3>
            <p className="text-white/60 text-sm">
              Share your voice and start earning when others use it.
            </p>
          </div>
        ) : (
          <div className="glass rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left px-4 py-3 text-sm text-white/60 font-medium">Voice</th>
                  <th className="text-left px-4 py-3 text-sm text-white/60 font-medium hidden md:table-cell">Usage</th>
                  <th className="text-right px-4 py-3 text-sm text-white/60 font-medium">Reward</th>
                  <th className="text-right px-4 py-3 text-sm text-white/60 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rewardHistory.map((entry) => (
                  <tr key={entry.id} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium truncate max-w-[200px]">
                        {entry.voice_name}
                      </div>
                      <div className="text-xs text-white/50">
                        {new Date(entry.created_at).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-white/60 hidden md:table-cell">
                      {entry.characters_generated.toLocaleString()} chars
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-green-400 font-medium">
                        +{entry.reward_minutes.toFixed(3)} min
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {entry.credited ? (
                        <span className="inline-flex items-center gap-1 text-green-400 text-sm">
                          <CheckCircle size={14} />
                          Claimed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-orange-400 text-sm">
                          <Clock size={14} />
                          Pending
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
