import { create } from 'zustand'
import { marketplaceApi, SharedVoice, MySharedVoice, RewardsSummary, RewardHistoryEntry, SortOption } from '@/lib/api'

interface MarketplaceStore {
  // Browse state
  voices: SharedVoice[]
  isLoading: boolean
  error: string | null
  sort: SortOption
  search: string
  offset: number
  hasMore: boolean

  // My shares state
  myShares: MySharedVoice[]
  mySharesLoading: boolean

  // Rewards state
  rewards: RewardsSummary | null
  rewardHistory: RewardHistoryEntry[]
  rewardsLoading: boolean

  // Actions
  browse: (params?: { search?: string; sort?: SortOption; reset?: boolean }) => Promise<void>
  loadMore: () => Promise<void>
  loadMyShares: () => Promise<void>
  loadRewards: () => Promise<void>
  loadRewardHistory: () => Promise<void>
  creditRewards: () => Promise<number>
  revokeVoice: (id: string) => Promise<void>
  rateVoice: (id: string, rating: number, review?: string) => Promise<void>
  reportVoice: (id: string, reason: string, description: string) => Promise<void>
  setSort: (sort: SortOption) => void
  setSearch: (search: string) => void
  clearError: () => void
}

export const useMarketplaceStore = create<MarketplaceStore>((set, get) => ({
  voices: [],
  isLoading: false,
  error: null,
  sort: 'popular',
  search: '',
  offset: 0,
  hasMore: true,

  myShares: [],
  mySharesLoading: false,

  rewards: null,
  rewardHistory: [],
  rewardsLoading: false,

  browse: async (params = {}) => {
    const { reset = false, search, sort } = params
    const state = get()

    if (search !== undefined) set({ search })
    if (sort !== undefined) set({ sort })
    if (reset) set({ offset: 0, voices: [], hasMore: true })

    set({ isLoading: true, error: null })

    try {
      const currentState = get()
      const response = await marketplaceApi.browse({
        search: search ?? currentState.search || undefined,
        sort: sort ?? currentState.sort,
        limit: 20,
        offset: reset ? 0 : currentState.offset,
      })

      set({
        voices: reset ? response.voices : [...currentState.voices, ...response.voices],
        hasMore: response.voices.length >= 20,
        isLoading: false,
      })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load voices',
        isLoading: false,
      })
    }
  },

  loadMore: async () => {
    const state = get()
    if (state.isLoading || !state.hasMore) return

    set({ offset: state.offset + 20 })
    await get().browse()
  },

  loadMyShares: async () => {
    set({ mySharesLoading: true })
    try {
      const response = await marketplaceApi.getMyShares()
      set({ myShares: response.shares, mySharesLoading: false })
    } catch (error) {
      set({ mySharesLoading: false })
    }
  },

  loadRewards: async () => {
    set({ rewardsLoading: true })
    try {
      const rewards = await marketplaceApi.getRewardsSummary()
      set({ rewards, rewardsLoading: false })
    } catch (error) {
      set({ rewardsLoading: false })
    }
  },

  loadRewardHistory: async () => {
    try {
      const response = await marketplaceApi.getRewardHistory()
      set({ rewardHistory: response.history })
    } catch (error) {
      // Silently fail
    }
  },

  creditRewards: async () => {
    try {
      const response = await marketplaceApi.creditRewards()
      await get().loadRewards()
      return response.credited_minutes
    } catch (error) {
      throw error
    }
  },

  revokeVoice: async (id: string) => {
    await marketplaceApi.revokeVoice(id)
    await get().loadMyShares()
  },

  rateVoice: async (id: string, rating: number, review?: string) => {
    await marketplaceApi.rateVoice(id, rating, review)
  },

  reportVoice: async (id: string, reason: string, description: string) => {
    await marketplaceApi.reportVoice(id, reason as any, description)
  },

  setSort: (sort: SortOption) => {
    set({ sort })
    get().browse({ sort, reset: true })
  },

  setSearch: (search: string) => {
    set({ search })
  },

  clearError: () => set({ error: null }),
}))
