'use client'

// Lets a signed-in customer switch between the two cloning engines available on the Voice API: Piper
// (VoiceStudio.tsx, chunked upload + deploy) and Orpheus (OrpheusVoiceStudio.tsx, streaming synthesis,
// single zip upload). Kept as a thin tab switcher so neither existing component needs to change.
import { useState } from 'react'
import VoiceStudio from '@/components/ra/VoiceStudio'
import OrpheusVoiceStudio from '@/components/ra/OrpheusVoiceStudio'

type Engine = 'piper' | 'orpheus'

export default function VoicesTabs() {
  const [engine, setEngine] = useState<Engine>('piper')
  return (
    <div>
      <div className="ra-vs-tabs" role="tablist" aria-label="Voice cloning engine" style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button role="tab" aria-selected={engine === 'piper'} className={`ra-btn ${engine === 'piper' ? 'solid' : 'ghost'}`} onClick={() => setEngine('piper')}>
          Piper (standard)
        </button>
        <button role="tab" aria-selected={engine === 'orpheus'} className={`ra-btn ${engine === 'orpheus' ? 'solid' : 'ghost'}`} onClick={() => setEngine('orpheus')}>
          Orpheus (streaming)
        </button>
      </div>
      {engine === 'piper' ? <VoiceStudio /> : <OrpheusVoiceStudio />}
    </div>
  )
}
