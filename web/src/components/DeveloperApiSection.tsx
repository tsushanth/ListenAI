'use client'

import { useState, useEffect, useCallback } from 'react'
import { Code, Copy, Check, Trash2, LogOut, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { ttsApiKeysApi, type TTSApiKeySummary, type FreeCredits } from '@/lib/ttsApiKeysApi'
import { creditsAsCharacters, FREE_CREDIT_UNITS } from '@/lib/pricing'
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
  const [billingActive, setBillingActive] = useState(false)
  const [comped, setComped] = useState(false)
  const [credits, setCredits] = useState<FreeCredits | null>(null)
  const [billingLoading, setBillingLoading] = useState(false)
  const [authMode, setAuthMode] = useState<'signin' | 'signup' | 'forgot'>('signin')
  const [recovering, setRecovering] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authSubmitting, setAuthSubmitting] = useState(false)
  const [authNotice, setAuthNotice] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      // The emailed reset link signs the user in with a short-lived recovery session; make them
      // choose a new password before showing the account, instead of dropping them into it.
      if (event === 'PASSWORD_RECOVERY') {
        setRecovering(true)
        document.getElementById('get-started')?.scrollIntoView()
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const loadKeys = useCallback(async () => {
    if (!session) return
    setKeysLoading(true)
    try {
      const { keys, billing_active, comped, free_credits } = await ttsApiKeysApi.list()
      setKeys(keys)
      setBillingActive(billing_active)
      setComped(!!comped)
      setCredits(free_credits ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load keys')
    } finally {
      setKeysLoading(false)
    }
  }, [session])

  useEffect(() => {
    if (session) loadKeys()
  }, [session, loadKeys])

  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthSubmitting(true)
    setError(null)
    setAuthNotice(null)
    try {
      if (authMode === 'forgot') {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/developers`,
        })
        if (resetError) throw resetError
        // Same message whether or not the address has an account, so this can't be used to probe for accounts.
        setAuthNotice('If an account exists for that email, we sent a link to reset your password. It can take a minute to arrive; check spam too.')
        setAuthMode('signin')
      } else if (authMode === 'signup') {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password })
        if (signUpError) throw signUpError
        if (!data.session) {
          // Email confirmation is required before a session is issued — this is a
          // Supabase project setting, not something this form controls.
          setAuthNotice('Check your email to confirm your account, then sign in.')
          setAuthMode('signin')
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
        if (signInError) throw signInError
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authentication failed')
    } finally {
      setAuthSubmitting(false)
    }
  }

  const submitNewPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (newPassword !== confirmPassword) {
      setError('The two passwords do not match.')
      return
    }
    setAuthSubmitting(true)
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
      if (updateError) throw updateError
      setRecovering(false)
      setNewPassword('')
      setConfirmPassword('')
      setAuthNotice('Password updated. You are signed in.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the password')
    } finally {
      setAuthSubmitting(false)
    }
  }

  const signInWithGoogle = async () => {
    setError(null)
    setAuthNotice(null)
    setAuthSubmitting(true)
    // Full-page redirect to Google and back; Supabase restores the session from the URL on return
    // (detectSessionInUrl). The return URL must be on the project's redirect allow list.
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/developers` },
    })
    if (oauthError) {
      setError(oauthError.message)
      setAuthSubmitting(false)
    }
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

  const startCheckout = async () => {
    if (!session?.user.email) return
    setBillingLoading(true)
    setError(null)
    try {
      const { url } = await ttsApiKeysApi.startCheckout(session.user.email)
      window.location.href = url
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start checkout')
      setBillingLoading(false)
    }
  }

  const openPortal = async () => {
    setBillingLoading(true)
    setError(null)
    try {
      const { url } = await ttsApiKeysApi.openBillingPortal()
      window.location.href = url
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open billing portal')
      setBillingLoading(false)
    }
  }

  const creditsExhausted = !billingActive && !comped && credits !== null && credits.remaining <= 0

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
        ) : recovering && session ? (
          <div>
            <p className="text-white/70 mb-4">Choose a new password for {session.user.email}.</p>
            <form onSubmit={submitNewPassword} className="space-y-3 max-w-sm">
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New password"
                autoComplete="new-password"
                className="w-full bg-dark-tertiary border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-primary"
              />
              <input
                type="password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                autoComplete="new-password"
                className="w-full bg-dark-tertiary border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-primary"
              />
              {error && <p className="text-sm text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={authSubmitting}
                className="inline-flex items-center gap-2 bg-white text-black font-semibold px-5 py-2.5 rounded-lg hover:bg-white/90 transition-colors disabled:opacity-50"
              >
                {authSubmitting ? <Loader2 size={18} className="animate-spin" /> : null}
                Update password
              </button>
            </form>
          </div>
        ) : !session ? (
          <div>
            <p className="text-white/70 mb-4">
              {authMode === 'forgot'
                ? 'Enter your email and we will send you a link to reset your password.'
                : 'Sign in to generate an API key for the realtime TTS service.'}
            </p>
            <p className="text-xs text-white/50 mb-4">
              Latency note: a cold worker (idle for a couple minutes) can take several
              seconds to spin up on the first request; once warm, responses stream back
              in under a second.
            </p>
            {authNotice && (
              <p className="text-sm text-green-300 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2 mb-4">
                {authNotice}
              </p>
            )}

            {authMode !== 'forgot' && (
              <div className="max-w-sm mb-4">
                <button
                  type="button"
                  onClick={signInWithGoogle}
                  disabled={authSubmitting}
                  className="w-full inline-flex items-center justify-center gap-2 bg-white text-black font-semibold px-5 py-2.5 rounded-lg hover:bg-white/90 transition-colors disabled:opacity-50"
                >
                  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>
                    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/>
                    <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.100 0 24s.9 7.600 2.600 10.800l7.900-6.100z"/>
                    <path fill="#34A853" d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.500-5.800c-2.100 1.400-4.800 2.300-8.400 2.300-6.300 0-11.600-4.100-13.500-9.800l-7.900 6.100C6.500 42.600 14.600 48 24 48z"/>
                  </svg>
                  Continue with Google
                </button>
                <div className="flex items-center gap-3 my-4 text-xs text-white/40">
                  <span className="flex-1 h-px bg-white/10" /> or use email <span className="flex-1 h-px bg-white/10" />
                </div>
              </div>
            )}

            <form onSubmit={submitAuth} className="space-y-3 max-w-sm">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full bg-dark-tertiary border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-primary"
              />
              {authMode !== 'forgot' && (
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                  className="w-full bg-dark-tertiary border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-primary"
                />
              )}
              {error && <p className="text-sm text-red-400">{error}</p>}
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="inline-flex items-center gap-2 bg-white text-black font-semibold px-5 py-2.5 rounded-lg hover:bg-white/90 transition-colors disabled:opacity-50"
                >
                  {authSubmitting ? <Loader2 size={18} className="animate-spin" /> : null}
                  {authMode === 'signup' ? 'Create account' : authMode === 'forgot' ? 'Send reset link' : 'Sign in'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode(authMode === 'signin' ? 'signup' : 'signin')
                    setError(null)
                    setAuthNotice(null)
                  }}
                  className="text-sm text-white/50 hover:text-white transition-colors"
                >
                  {authMode === 'signin' ? "Don't have an account? Sign up" : authMode === 'forgot' ? 'Back to sign in' : 'Already have an account? Sign in'}
                </button>
              </div>
              {authMode === 'signin' && (
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('forgot')
                    setError(null)
                    setAuthNotice(null)
                  }}
                  className="text-sm text-white/50 hover:text-white transition-colors"
                >
                  Forgot password?
                </button>
              )}
            </form>
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
              Latency note: a cold worker (idle for a couple minutes) can take several
              seconds to spin up on the first request; once warm, responses stream back
              in under a second.
            </p>

            <div className="bg-dark-tertiary border border-white/10 rounded-lg p-4 flex items-center justify-between">
              <div>
                <p className="text-sm text-white font-medium">
                  {comped
                    ? 'Complimentary account - full access, not billed'
                    : billingActive
                      ? 'Pay-as-you-go active'
                      : `Free credits: ${(credits?.remaining ?? FREE_CREDIT_UNITS).toLocaleString('en-US')} of ${(credits?.granted ?? FREE_CREDIT_UNITS).toLocaleString('en-US')} remaining`}
                </p>
                <p className="text-xs text-white/50 mt-0.5">
                  {comped
                    ? 'No usage limits and nothing to pay.'
                    : billingActive
                      ? '$0.01 per 1,000 characters, no limit.'
                      : creditsExhausted
                        ? 'Your free credits are used up. Add a payment method to keep going.'
                        : `That is ${creditsAsCharacters(credits?.remaining ?? FREE_CREDIT_UNITS)}, shared across speech, dubbing, transcription and the other tools. Add a payment method for unlimited pay-as-you-go usage.`}
                </p>
              </div>
              {!comped && (
                <button
                  onClick={billingActive ? openPortal : startCheckout}
                  disabled={billingLoading}
                  className={`inline-flex items-center gap-2 font-semibold px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 flex-shrink-0 ${
                    !billingActive && creditsExhausted
                      ? 'bg-green-500 text-black ring-2 ring-green-300 hover:bg-green-400'
                      : 'bg-white text-black hover:bg-white/90'
                  }`}
                >
                  {billingLoading ? <Loader2 size={14} className="animate-spin" /> : null}
                  {billingActive ? 'Manage billing' : 'Add payment method'}
                </button>
              )}
            </div>

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
