'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

import Alert from '@/components/ui/Alert'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Input from '@/components/ui/Input'
import { SmokeBackground } from '@/components/ui/spooky-smoke-animation'
import { useAuthStore } from '@/store/authStore'
import { fetchWithRetry } from '@/lib/fetch-with-retry'
import { APP_NAME, APP_NAME_UPPER } from '@/lib/branding'
import type { AuthUser, ApiResponse } from '@/lib/types'

export default function LoginPage() {
  const router = useRouter()
  const { setUser, clearUser } = useAuthStore()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [brand, setBrand] = useState({ appName: APP_NAME, appNameUpper: APP_NAME_UPPER })

  // Forgot-password mode: the request goes to the user's company admins, who
  // reset it from People and hand over a temporary password (no email service).
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin')
  const [resetEmail, setResetEmail] = useState('')
  const [resetSending, setResetSending] = useState(false)
  const [resetDone, setResetDone] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  // Always clear any existing session when visiting login page
  // User must re-authenticate every time
  useEffect(() => {
    clearUser()
    void fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
  }, [clearUser])

  // Resolve per-host white-label branding (e.g. forge.trijyaforge.com → Trijya Forge).
  useEffect(() => {
    void fetch('/api/branding')
      .then((r) => r.json())
      .then((j) => {
        const n = j?.data?.appName as string | undefined
        if (n) setBrand({ appName: n, appNameUpper: n.toUpperCase() })
      })
      .catch(() => {})
  }, [])

  async function handleSubmit(): Promise<void> {
    if (isLoading) return

    setIsLoading(true)
    setError(null)

    try {
      // fetchWithRetry silently retries once on 500/502/503/504 — hides
      // transient server blips (e.g., post-cold-start stale-pool errors)
      // from the user. Wrong-password 401s are NOT retried.
      const res = await fetchWithRetry('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.trim(), password }),
        retries: 1,
        retryDelayMs: 2000,
      })

      const json: ApiResponse<AuthUser> = await res.json() as ApiResponse<AuthUser>

      if (res.ok && json.data) {
        setUser(json.data)
        router.push('/dashboard')
      } else {
        setError(json.error ?? 'Authentication failed')
        setIsLoading(false)
      }
    } catch {
      setError('Unable to connect. Please try again.')
      setIsLoading(false)
    }
  }

  function openForgot(): void {
    setResetEmail(email.trim())
    setResetDone(false)
    setResetError(null)
    setError(null)
    setMode('forgot')
  }

  function backToSignIn(): void {
    setMode('signin')
    setResetDone(false)
    setResetError(null)
  }

  async function handleResetRequest(): Promise<void> {
    if (resetSending) return
    if (!resetEmail.trim()) {
      setResetError('Enter your email address')
      return
    }
    setResetSending(true)
    setResetError(null)
    try {
      // The server answers the same way whether or not the account exists, so
      // any completed request shows the same confirmation.
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail.trim() }),
      })
      setResetDone(true)
    } catch {
      setResetError('Unable to connect. Please try again.')
    } finally {
      setResetSending(false)
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center">
      <div className="absolute inset-0 z-0">
        <SmokeBackground smokeColor="#1a3a5c" />
      </div>
      <Card className="relative z-10 w-full max-w-[460px] p-8 md:p-10">
        <div className="text-center">
          <p className="type-meta text-accent-ink">WORKFORCE INTELLIGENCE PLATFORM</p>
          <h1 className="type-h1 mt-2">{brand.appName}</h1>
          <p className="type-body-muted mt-2">Secure operational command access</p>
        </div>

        {mode === 'forgot' ? (
          <form
            className="mt-9 space-y-5"
            onSubmit={(e) => { e.preventDefault(); void handleResetRequest() }}
          >
            <div>
              <p className="type-meta text-accent-ink">RESET ACCESS KEY</p>
              <p className="type-body-muted mt-2">
                Enter your account email. Your company&apos;s administrators will be asked to reset your password.
              </p>
            </div>

            {resetDone ? (
              <Alert variant="success">
                If that email belongs to an account, your company&apos;s administrators have been notified. They will reset your password and give you a temporary one.
              </Alert>
            ) : (
              <>
                <Input
                  id="reset-email"
                  type="email"
                  label="Email Address"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  disabled={resetSending}
                  placeholder="you@company.com"
                  autoComplete="email"
                  maxLength={254}
                />

                {resetError && <Alert variant="error">ERROR  {resetError}</Alert>}

                <Button
                  type="submit"
                  disabled={resetSending}
                  className="w-full mt-2"
                  size="lg"
                  variant="primary"
                >
                  {resetSending ? 'SENDING...' : 'REQUEST RESET'}
                </Button>
              </>
            )}

            <div className="text-center">
              <button
                type="button"
                onClick={backToSignIn}
                className="font-mono text-[10px] tracking-widest uppercase text-text-muted hover:text-accent-ink"
              >
                Back to sign in
              </button>
            </div>
          </form>
        ) : (
        <form
          className="mt-9 space-y-5"
          onSubmit={(e) => { e.preventDefault(); void handleSubmit() }}
        >
          <Input
            id="email"
            type="email"
            label="Email Address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isLoading}
            placeholder="you@company.com"
            autoComplete="email"
          />

          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              label="Access Key"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isLoading}
              placeholder="••••••••"
              autoComplete="current-password"
              className="pr-20"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              tabIndex={-1}
              className="absolute right-3 top-[40px] font-mono text-[10px] tracking-widest text-text-muted hover:text-accent-ink"
            >
              {showPassword ? 'HIDE' : 'SHOW'}
            </button>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={openForgot}
                disabled={isLoading}
                className="font-mono text-[10px] tracking-widest uppercase text-text-muted hover:text-accent-ink disabled:opacity-50"
              >
                Forgot password?
              </button>
            </div>
          </div>

          {error && <Alert variant="error">ERROR  {error}</Alert>}

          <Button
            type="submit"
            disabled={isLoading}
            className="w-full mt-2"
            size="lg"
            variant="primary"
          >
            {isLoading ? 'SIGNING IN...' : 'SIGN IN'}
          </Button>
        </form>
        )}

        <div className="mt-10 text-center">
          <p className="type-meta">{brand.appNameUpper} v1.0 — INTERNAL USE ONLY</p>
          <p className="type-meta mt-1">UNAUTHORIZED ACCESS IS PROHIBITED</p>
        </div>
      </Card>
    </div>
  )
}
