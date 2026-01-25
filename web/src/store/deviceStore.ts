import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

interface DeviceStore {
  deviceId: string | null
  isHydrated: boolean
  getDeviceId: () => string
  hydrate: () => void
}

export const useDeviceStore = create<DeviceStore>()(
  persist(
    (set, get) => ({
      deviceId: null,
      isHydrated: false,

      getDeviceId: () => {
        let id = get().deviceId
        if (!id) {
          id = crypto.randomUUID()
          set({ deviceId: id })
        }
        return id
      },

      hydrate: () => {
        set({ isHydrated: true })
      },
    }),
    {
      name: 'device-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ deviceId: state.deviceId }),
      onRehydrateStorage: () => (state) => {
        state?.hydrate()
      },
    }
  )
)
