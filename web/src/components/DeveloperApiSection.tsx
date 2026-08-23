'use client'

import { useState, useEffect, useCallback } from 'react'
import { Code, Copy, Check, Trash2, LogIn, LogOut, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { ttsApiKeysApi, type TTSApiKeySummary } from '@/lib/ttsApiKeysApi'
import type { Session } from '@supabase/supabase-js'

export default function DeveloperApiSection() {
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [keys, setKeys] = useState<TTSApiKeySummary[]>([])
  const [keysLoading, setKeysLoading] = useState(false)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const loadKeys = useCallback(async () => {
    if (!session) return
    setKeysLoading(true)
    try {
      const { keys } = await ttsApiKeysApi.list()
      setKeys(keys)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load keys')
    } finally {
      setKeysLoading(false)
    }
  }, [session])

  useEffect(() => {
    if (session) loadKeys()
  }, [session, loadKeys])

  const signIn = (provider: 'google' | 'apple') => {
    supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: typeof window !== 'undefined' ? window.location.href : undefined },
    })
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setKeys([])
    setNewKey(null)
  }

  const issueKey = async () => {
    setIssuing(true)
    setError(null)
    try {
      const result = await ttsApiKeysApi.create()
      setNewKey(result.key)
      await loadKeys()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create key')
    } finally {
      setIssuing(false)
    }
  }

  const revoke = async (id: string) => {
    try {
      await ttsApiKeysApi.revoke(id)
      await loadKeys()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke key')
    }
  }

  const copyKey = () => {
    if (!newKey) return
    navigator.clipboard.writeText(newKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Code size={20} className="text-green-400" />
        Developer / API Access
      </h2>

      <div className="glass rounded-xl p-6 space-y-4">
        {authLoading ? (
          <div className="flex items-center gap-2 text-white/60">
            <Loader2 size={18} className="animate-spin" /> Loading…
          </div>
        ) : !session ? (
          <div>
            <p className="text-white/70 mb-4">
              Sign in to generate an API key for the realtime TTS service.
            </p>
            <p className="text-xs text-white/50 mb-4">
              Latency note: the GPU backend is provisioned on demand and can take up to
              ~5 minutes to spin up after being idle. It stays warm for 15 minutes after
              your last request, then shuts down automatically to avoid unnecessary cost.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => signIn('google')}
                className="inline-flex items-center gap-2 bg-white text-black font-semibold px-5 py-2.5 rounded-lg hover:bg-white/90 transition-colors"
              >
                <LogIn size={18} /> Sign in with Google
              </button>
              <button
                onClick={() => signIn('apple')}
                className="inline-flex items-center gap-2 bg-dark-tertiary border border-white/10 font-semibold px-5 py-2.5 rounded-lg hover:bg-white/10 transition-colors"
              >
                <LogIn size={18} /> Sign in with Apple
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-white/60 text-sm">{session.user.email}</span>
              <button
                onClick={signOut}
                className="inline-flex items-center gap-1.5 text-white/60 hover:text-white text-sm transition-colors"
              >
                <LogOut size={16} /> Sign out
              </button>
            </div>

            <p className="text-xs text-white/50">
              Latency note: the GPU backend is provisioned on demand and can take up to
              ~5 minutes to spin up after being idle. It stays warm for 15 minutes after
              your last request, then shuts down automatically to avoid unnecessary cost.
            </p>

            {newKey && (
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                <p className="text-sm text-green-300 mb-2 font-medium">
                  Save this key now — it won&apos;t be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-dark-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-white/90 truncate">
                    {newKey}
                  </code>
                  <button
                    onClick={copyKey}
                    className="p-2 bg-dark-tertiary rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    {copied ? <Check size={18} className="text-green-400" /> : <Copy size={18} />}
                  </button>
                </div>
              </div>
            )}

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div>
              <button
                onClick={issueKey}
                disabled={issuing}
                className="inline-flex items-center gap-2 bg-green-500 text-black font-semibold px-5 py-2.5 rounded-lg hover:bg-green-400 transition-colors disabled:opacity-50"
              >
                {issuing ? <Loader2 size={18} className="animate-spin" /> : null}
                Generate new API key
              </button>
            </div>

            <div className="border-t border-white/10 pt-4">
              {keysLoading ? (
                <div className="flex items-center gap-2 text-white/60 text-sm">
                  <Loader2 size={16} className="animate-spin" /> Loading keys…
                </div>
              ) : keys.length === 0 ? (
                <p className="text-white/50 text-sm">No API keys yet.</p>
              ) : (
                <div className="space-y-2">
                  {keys.map((k) => (
                    <div
                      key={k.id}
                      className="flex items-center justify-between bg-dark-tertiary border border-white/10 rounded-lg px-4 py-3"
                    >
                      <div>
                        <span className="font-mono text-sm text-white/80">{k.key_preview}</span>
                        {k.label && <span className="text-white/50 text-xs ml-2">{k.label}</span>}
                        {k.revoked && (
                          <span className="text-red-400 text-xs ml-2 font-medium">revoked</span>
                        )}
                      </div>
                      {!k.revoked && (
                        <button
                          onClick={() => revoke(k.id)}
                          className="text-white/40 hover:text-red-400 transition-colors"
                          title="Revoke key"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
