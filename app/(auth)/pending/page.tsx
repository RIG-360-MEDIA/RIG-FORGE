'use client'

import { useEffect, useState, useCallback } from 'react'
import { Hourglass } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type { AuthUser, ApiResponse } from '@/lib/types'

export default function PendingPage() {
  const router = useRouter()
  const [userName, setUserName] = useState('')
  const [checking, setChecking] = useState(false)

  const checkStatus = useCallback(async () => {
    if (checking) return
    setChecking(true)
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' })
      const json = await res.json() as ApiResponse<AuthUser>
      if (!res.ok || !json.data) {
        router.push('/login')
        return
      }
      setUserName(json.data.name)
      if (!json.data.isOnboarding) {
        router.push('/dashboard')
      }
    } catch {
      // ignore network errors
    } finally {
      setChecking(false)
    }
  }, [checking, router])

  // Initial check
  useEffect(() => {
    void checkStatus()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => { void checkStatus() }, 30_000)
    return () => clearInterval(interval)
  }, [checkStatus])

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-background-primary flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center">
        <p className="type-meta text-accent-ink mb-2">FORGE</p>
        <h1 className="type-h3 mb-8">
          {userName ? `Welcome, ${userName}!` : 'Welcome!'}
        </h1>

        <div className="bg-surface-raised border border-border-default rounded-card p-8 mb-6">
          <Hourglass className="h-9 w-9 mx-auto mb-4 text-text-secondary" aria-hidden="true" />
          <p className="text-text-primary font-mono text-sm mb-3">
            Your account is pending approval.
          </p>
          <p className="text-text-secondary font-mono text-xs leading-relaxed">
            An admin will review and approve your access shortly.
            Once approved, you&apos;ll be automatically redirected
            to your workspace.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void checkStatus()}
          disabled={checking}
          className="w-full h-10 bg-background-tertiary border border-border-default rounded-card font-mono text-xs text-text-secondary hover:text-text-primary hover:bg-surface-highlight transition-colors mb-4 disabled:opacity-50"
        >
          {checking ? 'Checking...' : 'Refresh Status'}
        </button>

        <p className="font-mono text-[10px] text-text-muted mb-2">
          Auto-checks every 30 seconds
        </p>

        <button
          type="button"
          onClick={() => void handleLogout()}
          className="font-mono text-xs text-text-muted hover:text-status-danger transition-colors"
        >
          Not you? Log out
        </button>
      </div>
    </div>
  )
}
