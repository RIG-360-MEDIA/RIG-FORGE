'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, type ReactNode } from 'react'

import { useAuthStore } from '@/store/authStore'
import { userCan } from '@/lib/permissions'

// ── Icons (inline SVG so we don't pull an icon lib into the bundle) ──────────
const ic = 'h-[22px] w-[22px]'
const sp = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const IconChat = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" /></svg>
const IconHome = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>
const IconFolder = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
const IconTicket = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4z" /><path d="M13 6v12" strokeDasharray="2 2" /></svg>
const IconMore = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
const IconGrid = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
const IconUsers = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.6M17 20a5.5 5.5 0 0 0-3-4.9" /></svg>
const IconReport = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><path d="M6 3h9l5 5v13a0 0 0 0 1 0 0H6a0 0 0 0 1 0 0z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>
const IconUserPlus = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M19 8v6M22 11h-6" /></svg>
const IconUser = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><circle cx="12" cy="8" r="3.4" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></svg>
const IconFlag = () => <svg className={ic} viewBox="0 0 24 24" {...sp}><path d="M5 21V4M5 4h11l-2 3 2 3H5" /></svg>

interface Item {
  href: string
  label: string
  icon: ReactNode
}

function isNavActive(href: string, pathname: string): boolean {
  if (href === '/dashboard') return pathname === '/dashboard'
  return pathname.startsWith(href)
}

export default function MobileNav() {
  const pathname = usePathname()
  const { user } = useAuthStore()
  const [moreOpen, setMoreOpen] = useState(false)

  // Hidden until the user is approved (mirrors the desktop nav gate).
  if (!user || user.mustChangePassword) return null
  const canOnboard = userCan(user, 'onboarding.approve')

  // External/client users are locked to their projects — a single tab, no More sheet.
  if (user.isExternal) {
    return (
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 flex items-stretch h-14 bg-surface-raised/95 backdrop-blur border-t border-border-default"
        aria-label="Primary"
      >
        <Link
          href="/dashboard/projects"
          className="flex-1 flex flex-col items-center justify-center gap-0.5 text-accent-ink"
        >
          <IconFolder />
          <span className="text-[10px] font-medium leading-none">Projects</span>
        </Link>
        <Link
          href="/dashboard/profile"
          className="flex-1 flex flex-col items-center justify-center gap-0.5 text-text-secondary"
        >
          <IconUser />
          <span className="text-[10px] font-medium leading-none">Profile</span>
        </Link>
      </nav>
    )
  }

  // 4 thumb-priority tabs + a More sheet for the rest.
  const primary: Item[] = [
    { href: '/dashboard/messages', label: 'Chat', icon: <IconChat /> },
    { href: '/dashboard', label: 'Home', icon: <IconHome /> },
    { href: '/dashboard/projects', label: 'Projects', icon: <IconFolder /> },
    { href: '/dashboard/tickets', label: 'Tickets', icon: <IconTicket /> },
  ]
  const more: Item[] = [
    { href: '/dashboard/workspace', label: 'Workspace', icon: <IconGrid /> },
    { href: '/dashboard/people', label: 'People', icon: <IconUsers /> },
    { href: '/dashboard/reports', label: 'Reports', icon: <IconReport /> },
    canOnboard
      ? { href: '/dashboard/onboarding', label: 'Onboarding', icon: <IconUserPlus /> }
      : { href: '/dashboard/profile', label: 'Profile', icon: <IconUser /> },
    { href: '/dashboard/issues', label: 'Issues', icon: <IconFlag /> },
  ]
  const moreActive = more.some((m) => isNavActive(m.href, pathname))

  return (
    <>
      {/* ── Fixed bottom tab bar (mobile/tablet only) ─────────────────────── */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 flex items-stretch h-14 bg-surface-raised/95 backdrop-blur border-t border-border-default"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Primary"
      >
        {primary.map(({ href, label, icon }) => {
          const active = isNavActive(href, pathname)
          return (
            <Link
              key={href}
              href={href}
              className={[
                'flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors',
                active ? 'text-accent-ink' : 'text-text-secondary active:text-text-primary',
              ].join(' ')}
            >
              {icon}
              <span className="text-[10px] font-medium leading-none">{label}</span>
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={[
            'flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors',
            moreActive || moreOpen ? 'text-accent-ink' : 'text-text-secondary active:text-text-primary',
          ].join(' ')}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
        >
          <IconMore />
          <span className="text-[10px] font-medium leading-none">More</span>
        </button>
      </nav>

      {/* ── More sheet ────────────────────────────────────────────────────── */}
      {moreOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/40"
          onClick={() => setMoreOpen(false)}
        >
          <div
            className="absolute inset-x-0 bottom-0 bg-surface-raised rounded-t-2xl border-t border-border-default p-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] animate-[slideUp_0.18s_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-2 mt-1 h-1 w-10 rounded-full bg-text-primary/20" />
            <div className="grid grid-cols-4 gap-1">
              {more.map(({ href, label, icon }) => {
                const active = isNavActive(href, pathname)
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMoreOpen(false)}
                    className={[
                      'flex flex-col items-center justify-center gap-1 rounded-xl py-3 transition-colors',
                      active ? 'text-accent-ink bg-accent-ink/10' : 'text-text-secondary active:bg-text-primary/5',
                    ].join(' ')}
                  >
                    {icon}
                    <span className="text-[11px] font-medium leading-none">{label}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
