'use client'

import { useEffect, useState, useRef } from 'react'
import { Search, Play, Pause, Star, Users, Loader2 } from 'lucide-react'
import { useMarketplaceStore } from '@/store/marketplaceStore'
import { SharedVoice, SortOption } from '@/lib/api'

const sortOptions: { value: SortOption; label: string }[] = [
  { value: 'popular', label: 'Most Popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'rating', label: 'Top Rated' },
]

export default function MarketplacePage() {
  const {
    voices,
    isLoading,
    error,
    sort,
    search,
    hasMore,
    browse,
    loadMore,
    setSort,
    setSearch,
    clearError,
  } = useMarketplaceStore()

  const [searchInput, setSearchInput] = useState(search)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    browse({ reset: true })
  }, [browse])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setSearch(searchInput)
    browse({ search: searchInput, reset: true })
  }

  const handlePlay = async (voice: SharedVoice) => {
    if (playingId === voice.id) {
      audioRef.current?.pause()
      setPlayingId(null)
      return
    }

    if (!voice.preview_audio_url) return

    if (audioRef.current) {
      audioRef.current.pause()
    }

    const audio = new Audio(voice.preview_audio_url)
    audioRef.current = audio

    audio.onended = () => setPlayingId(null)
    audio.onerror = () => setPlayingId(null)

    try {
      await audio.play()
      setPlayingId(voice.id)
    } catch (err) {
      console.error('Failed to play audio:', err)
    }
  }

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Voice Marketplace</h1>
        <p className="text-white/60">
          Discover and use community-shared voices for your text-to-speech.
        </p>
      </div>

      {/* Search and filters */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <form onSubmit={handleSearch} className="flex-1">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40" size={20} />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search voices..."
              className="w-full bg-dark-tertiary border border-white/10 rounded-lg pl-12 pr-4 py-3 text-white placeholder:text-white/40 focus:outline-none focus:border-primary"
            />
          </div>
        </form>

        <div className="flex gap-2">
          {sortOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setSort(option.value)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                sort === option.value
                  ? 'bg-primary text-black'
                  : 'bg-dark-tertiary text-white/70 hover:bg-white/10'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="glass rounded-xl p-6 mb-6 border border-red-500/30">
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={() => {
              clearError()
              browse({ reset: true })
            }}
            className="px-4 py-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && voices.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 className="animate-spin text-primary mb-4" size={40} />
          <p className="text-white/60">Loading voices...</p>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && voices.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-20 h-20 rounded-full bg-dark-tertiary flex items-center justify-center mb-6">
            <Search size={40} className="text-white/30" />
          </div>
          <h2 className="text-xl font-semibold mb-2">No voices found</h2>
          <p className="text-white/60 max-w-md">
            {search
              ? 'Try a different search term or clear your search.'
              : 'Be the first to share your voice with the community!'}
          </p>
        </div>
      )}

      {/* Voice grid */}
      {voices.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {voices.map((voice) => (
              <VoiceCard
                key={voice.id}
                voice={voice}
                isPlaying={playingId === voice.id}
                onPlay={() => handlePlay(voice)}
              />
            ))}
          </div>

          {/* Load more */}
          {hasMore && (
            <div className="flex justify-center mt-8">
              <button
                onClick={loadMore}
                disabled={isLoading}
                className="px-6 py-3 bg-dark-tertiary rounded-lg text-white/70 hover:bg-white/10 transition-colors disabled:opacity-50"
              >
                {isLoading ? (
                  <Loader2 className="animate-spin" size={20} />
                ) : (
                  'Load More'
                )}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Voice Card Component
function VoiceCard({
  voice,
  isPlaying,
  onPlay,
}: {
  voice: SharedVoice
  isPlaying: boolean
  onPlay: () => void
}) {
  // Generate consistent color from voice ID
  const hue = Math.abs(voice.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360

  return (
    <div className="glass rounded-xl p-5 hover:bg-white/10 transition-colors">
      <div className="flex items-start gap-4 mb-4">
        {/* Avatar */}
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center text-white text-xl font-bold shrink-0"
          style={{ background: `linear-gradient(135deg, hsl(${hue}, 60%, 50%), hsl(${hue}, 60%, 35%))` }}
        >
          {voice.display_name.charAt(0).toUpperCase()}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold truncate">{voice.display_name}</h3>
            {voice.is_own && (
              <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded">
                YOU
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 text-sm text-white/60">
            <span className="flex items-center gap-1">
              <Star size={14} className="text-yellow-400" />
              {voice.avg_rating.toFixed(1)}
            </span>
            <span className="flex items-center gap-1">
              <Users size={14} />
              {voice.usage_count}
            </span>
          </div>
        </div>

        {/* Play button */}
        <button
          onClick={onPlay}
          disabled={!voice.preview_audio_url}
          className="w-11 h-11 rounded-full bg-primary flex items-center justify-center text-black hover:bg-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
        </button>
      </div>

      {/* Tags */}
      {voice.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {voice.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="text-xs bg-dark-tertiary text-white/60 px-2 py-1 rounded"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Description */}
      {voice.description && (
        <p className="text-sm text-white/50 line-clamp-2">{voice.description}</p>
      )}
    </div>
  )
}
