'use client'

import { useEffect, useState } from 'react'
import { Bell } from 'lucide-react'

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

// A bell that lets the user opt into Web Push for chat. Hidden once granted or
// when the browser can't do push. No-ops gracefully if VAPID isn't configured.
export default function NotificationToggle() {
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default')

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    ) {
      setPerm('unsupported')
      return
    }
    setPerm(Notification.permission)
  }, [])

  async function enable() {
    try {
      const result = await Notification.requestPermission()
      setPerm(result)
      if (result !== 'granted') return
      const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      if (!key) return
      const reg = await navigator.serviceWorker.ready
      const existing = await reg.pushManager.getSubscription()
      const sub =
        existing ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }))
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      })
    } catch (err) {
      console.error('[push] enable failed', err)
    }
  }

  // Only offer the opt-in when it can actually do something (permission still askable).
  if (perm !== 'default') return null
  return (
    <button type="button" onClick={enable} title="Enable notifications" aria-label="Enable notifications" className="text-text-secondary hover:text-text-primary">
      <Bell className="h-4 w-4" aria-hidden="true" />
    </button>
  )
}
