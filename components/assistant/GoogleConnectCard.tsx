'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

interface Status {
  configured: boolean
  connected: boolean
  /** A connection exists but Google rejected it (token revoked or expired). */
  needsReconnect?: boolean
  email: string | null
  connectedAt: string | null
  features?: {
    calendar: boolean
    gmail: boolean
    drive: boolean
  }
}

/**
 * Drop-in card for the Profile page. Shows current Google connection
 * status and a Connect / Disconnect button. Reads ?google=connected
 * etc. from the URL after the OAuth callback redirects back here.
 *
 * Default export wraps the inner component in <Suspense> because
 * useSearchParams() requires a suspense boundary during prerendering
 * (Next.js 14+ App Router rule). Fallback is `null` to match the
 * existing "loading" state of the inner component.
 */
export default function GoogleConnectCard() {
  return (
    <Suspense fallback={null}>
      <GoogleConnectCardInner />
    </Suspense>
  )
}

function GoogleConnectCardInner() {
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const params = useSearchParams()

  // Surface ?google= query params after the OAuth callback
  useEffect(() => {
    const v = params.get('google')
    if (!v) return
    if (v === 'connected') setToast('✓ Google Calendar connected.')
    else if (v === 'cancelled') setToast('Connection cancelled.')
    else if (v === 'error') {
      const reason = params.get('reason')
      setToast(`Connection failed${reason ? `: ${reason}` : '.'}`)
    }
    // Clear the toast after 6 seconds
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [params])

  // Load current status
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/auth/google/status', { credentials: 'include' })
        if (!res.ok) return
        const json = (await res.json()) as { data?: Status }
        if (json.data) setStatus(json.data)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // Re-fetch status if the URL param changed (after a successful connect)
  useEffect(() => {
    if (params.get('google') !== 'connected') return
    void (async () => {
      const res = await fetch('/api/auth/google/status', { credentials: 'include' })
      if (!res.ok) return
      const json = (await res.json()) as { data?: Status }
      if (json.data) setStatus(json.data)
    })()
  }, [params])

  if (loading) return null
  if (!status) return null

  // Server doesn't have Google OAuth configured — admin needs to set
  // GOOGLE_CLIENT_ID etc. in env. Show a quiet hint, not a button.
  if (!status.configured) {
    return (
      <div className="bg-surface-raised border border-border-default rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-mono uppercase tracking-widest text-text-primary">
              Google Calendar
            </h3>
            <p className="text-xs text-text-muted mt-1">
              Not yet enabled on this server. An admin needs to configure the
              integration before users can connect.
            </p>
          </div>
        </div>
      </div>
    )
  }

  function connect() {
    setBusy(true)
    window.location.href = '/api/auth/google/connect'
  }

  async function disconnect() {
    if (!confirm('Disconnect Google Calendar from Forgie? You can reconnect anytime.')) return
    setBusy(true)
    try {
      const res = await fetch('/api/auth/google/disconnect', {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok) {
        setStatus({ ...status!, connected: false, email: null, connectedAt: null })
        setToast('Disconnected.')
      } else {
        setToast('Disconnect failed. Try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-surface-raised border border-border-default rounded-2xl p-5 mb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h3 className="text-sm font-mono uppercase tracking-widest text-text-primary">
            Google Workspace
          </h3>
          {status.connected ? (
            <>
              <p className="text-sm text-text-primary mt-2">
                ✓ Connected as <span className="font-medium">{status.email}</span>
              </p>
              {/* Feature status grid */}
              <div className="grid grid-cols-3 gap-2 mt-3">
                <FeatureBadge label="Calendar" enabled={status.features?.calendar ?? false} />
                <FeatureBadge label="Gmail" enabled={status.features?.gmail ?? false} />
                <FeatureBadge label="Drive" enabled={status.features?.drive ?? false} />
              </div>
              {!(status.features?.gmail && status.features?.drive) && (
                <p className="text-xs text-amber-700 mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                  Some features need new permissions. Click <strong>Reconnect</strong> to
                  grant access to Gmail and Drive.
                </p>
              )}
            </>
          ) : status.needsReconnect ? (
            <p className="text-xs text-amber-700 mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
              Your Google connection{status.email ? <> for <span className="font-medium">{status.email}</span></> : null} has
              expired, so Mail, Drive, Calendar and Forgie cannot use it. Click <strong>Reconnect Google</strong> to
              sign in again.
            </p>
          ) : (
            <>
              <p className="text-sm text-text-secondary mt-2">
                Let Forgie use your Calendar, Gmail, and Drive on your behalf.
              </p>
              <p className="text-xs text-text-muted mt-1">
                Forgie can schedule meetings, send emails, and create folders/docs.
                Read access is limited to what you authorize. Disconnect any time.
              </p>
            </>
          )}
          {toast && (
            <p className="text-xs text-text-primary mt-3 px-3 py-2 bg-surface-mid rounded-lg">
              {toast}
            </p>
          )}
        </div>
        <div className="shrink-0 flex flex-col gap-2">
          {status.connected && !(status.features?.gmail && status.features?.drive) && (
            <button
              type="button"
              onClick={connect}
              disabled={busy}
              className="h-9 px-4 text-sm font-medium rounded-lg bg-[#1A1A1A] text-white hover:bg-[#333] transition-colors disabled:opacity-50"
            >
              Reconnect
            </button>
          )}
          <button
            type="button"
            onClick={status.connected ? disconnect : connect}
            disabled={busy}
            className={[
              'h-9 px-4 text-sm font-medium rounded-lg transition-colors disabled:opacity-50',
              status.connected
                ? 'bg-surface-raised border border-border-default text-text-secondary hover:text-text-primary'
                : 'bg-[#1A1A1A] text-white hover:bg-[#333]',
            ].join(' ')}
          >
            {busy ? '...' : status.connected ? 'Disconnect' : status.needsReconnect ? 'Reconnect Google' : 'Connect Google'}
          </button>
        </div>
      </div>
    </div>
  )
}

function FeatureBadge({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div
      className={[
        'flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border text-xs font-medium',
        enabled
          ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
          : 'bg-surface-mid border-border-subtle text-text-muted',
      ].join(' ')}
    >
      <span aria-hidden="true">{enabled ? '✓' : '○'}</span>
      <span>{label}</span>
    </div>
  )
}
