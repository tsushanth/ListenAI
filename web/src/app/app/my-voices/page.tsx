'use client'

import { useEffect, useState } from 'react'
import { Mic, Trash2, Share2, Star, Users, Loader2, AlertTriangle } from 'lucide-react'
import { useMarketplaceStore } from '@/store/marketplaceStore'
import { clonedVoicesApi, ClonedVoice } from '@/lib/api'

export default function MyVoicesPage() {
  const { myShares, mySharesLoading, loadMyShares, revokeVoice } = useMarketplaceStore()
  const [clonedVoices, setClonedVoices] = useState<ClonedVoice[]>([])
  const [loadingVoices, setLoadingVoices] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState<string | null>(null)

  useEffect(() => {
    loadMyShares()
    loadClonedVoices()
  }, [loadMyShares])

  const loadClonedVoices = async () => {
    setLoadingVoices(true)
    try {
      const response = await clonedVoicesApi.list()
      setClonedVoices(response.voices)
    } catch (error) {
      console.error('Failed to load cloned voices:', error)
    } finally {
      setLoadingVoices(false)
    }
  }

  const handleRevoke = async (id: string) => {
    setRevoking(id)
    try {
      await revokeVoice(id)
      setShowConfirm(null)
    } catch (error) {
      console.error('Failed to revoke:', error)
    } finally {
      setRevoking(null)
    }
  }

  const isLoading = loadingVoices || mySharesLoading

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">My Voices</h1>
        <p className="text-white/60">
          Manage your cloned voices and shared marketplace listings.
        </p>
      </div>

      {/* Cloned Voices Section */}
      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
          <Mic size={20} className="text-purple-400" />
          Cloned Voices
        </h2>

        {isLoading && clonedVoices.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="animate-spin text-primary" size={32} />
          </div>
        ) : clonedVoices.length === 0 ? (
          <div className="glass rounded-xl p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-dark-tertiary flex items-center justify-center mx-auto mb-4">
              <Mic size={32} className="text-white/30" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No Cloned Voices</h3>
            <p className="text-white/60 text-sm">
              Create a voice clone in the mobile app to see it here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {clonedVoices.map((voice) => (
              <div key={voice.id} className="glass rounded-xl p-5 flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-purple-500/20 flex items-center justify-center shrink-0">
                  <Mic size={20} className="text-purple-400" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold truncate">{voice.name}</h3>
                    {voice.is_default && (
                      <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded">
                        DEFAULT
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-white/60">
                    {voice.duration_sec ? `${voice.duration_sec.toFixed(1)}s sample` : 'No sample'}
                    {' • '}
                    Used {voice.usage_count} times
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Shared Voices Section */}
      <section>
        <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
          <Share2 size={20} className="text-orange-400" />
          Shared to Marketplace
        </h2>

        {mySharesLoading && myShares.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="animate-spin text-primary" size={32} />
          </div>
        ) : myShares.length === 0 ? (
          <div className="glass rounded-xl p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-dark-tertiary flex items-center justify-center mx-auto mb-4">
              <Share2 size={32} className="text-white/30" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No Shared Voices</h3>
            <p className="text-white/60 text-sm">
              Share your voice to earn rewards when others use it.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {myShares.map((share) => (
              <div key={share.id} className="glass rounded-xl p-5">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-full bg-orange-500/20 flex items-center justify-center shrink-0">
                    <Share2 size={20} className="text-orange-400" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold truncate">{share.display_name}</h3>
                      <StatusBadge status={share.status} />
                    </div>

                    <div className="flex items-center gap-4 text-sm text-white/60 mb-2">
                      <span className="flex items-center gap-1">
                        <Star size={14} className="text-yellow-400" />
                        {share.avg_rating.toFixed(1)} ({share.rating_count})
                      </span>
                      <span className="flex items-center gap-1">
                        <Users size={14} />
                        {share.usage_count} uses
                      </span>
                    </div>

                    {/* Tags */}
                    {share.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {share.tags.slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            className="text-xs bg-dark-tertiary text-white/50 px-2 py-0.5 rounded"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Revoked reason */}
                    {share.status === 'revoked' && share.revoked_reason && (
                      <p className="text-sm text-red-400 flex items-center gap-1">
                        <AlertTriangle size={14} />
                        {share.revoked_reason}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  {share.status === 'active' && (
                    <div className="relative">
                      {showConfirm === share.id ? (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleRevoke(share.id)}
                            disabled={revoking === share.id}
                            className="px-3 py-1.5 bg-red-500/20 text-red-400 rounded-lg text-sm hover:bg-red-500/30 transition-colors disabled:opacity-50"
                          >
                            {revoking === share.id ? (
                              <Loader2 className="animate-spin" size={16} />
                            ) : (
                              'Confirm'
                            )}
                          </button>
                          <button
                            onClick={() => setShowConfirm(null)}
                            className="px-3 py-1.5 bg-dark-tertiary text-white/60 rounded-lg text-sm hover:bg-white/10 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setShowConfirm(share.id)}
                          className="p-2 text-white/40 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                          title="Revoke from marketplace"
                        >
                          <Trash2 size={18} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-green-500/20 text-green-400',
    pending_review: 'bg-yellow-500/20 text-yellow-400',
    suspended: 'bg-red-500/20 text-red-400',
    revoked: 'bg-gray-500/20 text-gray-400',
  }

  const labels: Record<string, string> = {
    active: 'Active',
    pending_review: 'Pending',
    suspended: 'Suspended',
    revoked: 'Revoked',
  }

  return (
    <span className={`text-xs px-2 py-0.5 rounded ${styles[status] || styles.revoked}`}>
      {labels[status] || status}
    </span>
  )
}
