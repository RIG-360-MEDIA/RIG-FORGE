'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { useAuth } from '@/hooks/useAuth'
import { useAuthStore } from '@/store/authStore'
import { isAdminRole } from '@/lib/roles'
import { userCan } from '@/lib/permissions'
import { useSocket } from '@/hooks/useSocket'
import Avatar from '@/components/ui/Avatar'
import StatusDot from '@/components/ui/StatusDot'
import NotificationBell from '@/components/notifications/NotificationBell'
import NotificationDropdown from '@/components/notifications/NotificationDropdown'
import AskForgieButton from '@/components/assistant/AskForgieButton'
import ChatPanel from '@/components/assistant/ChatPanel'
import ThemeToggle from '@/components/shared/ThemeToggle'
import { useBranding } from '@/lib/use-branding'

// ─── Nav config ───────────────────────────────────────────────────────────────

const ADMIN_NAV = [
  { href: '/dashboard', label: 'DASHBOARD' },
  { href: '/dashboard/messages', label: 'MESSAGES' },
  { href: '/dashboard/workspace', label: 'WORKSPACE' },
  { href: '/dashboard/projects', label: 'PROJECTS' },
  { href: '/dashboard/people', label: 'PEOPLE' },
  { href: '/dashboard/tickets', label: 'TICKETS' },
  { href: '/dashboard/reports', label: 'REPORTS' },
  { href: '/dashboard/issues', label: 'ISSUES' },
  { href: '/dashboard/onboarding', label: 'ONBOARDING' },
] as const

// Super Admin sees everything Admin sees + no additional nav items needed
// (Super Admin powers are surfaced inside the People/Onboarding pages)
const SUPER_ADMIN_NAV = ADMIN_NAV

const EMPLOYEE_NAV = [
  { href: '/dashboard', label: 'DASHBOARD' },
  { href: '/dashboard/messages', label: 'MESSAGES' },
  { href: '/dashboard/workspace', label: 'WORKSPACE' },
  { href: '/dashboard/projects', label: 'MY PROJECTS' },
  { href: '/dashboard/people', label: 'PEOPLE' },
  { href: '/dashboard/tickets', label: 'TICKETS' },
  { href: '/dashboard/reports', label: 'REPORTS' },
  { href: '/dashboard/issues', label: 'ISSUES' },
  { href: '/dashboard/profile', label: 'MY PROFILE' },
] as const

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'ACTIVE' },
  { value: 'FOCUS', label: 'FOCUS' },
  { value: 'AVAILABLE', label: 'AVAILABLE' },
  { value: 'IN_MEETING', label: 'IN MEETING' },
  { value: 'OFFLINE', label: 'OFFLINE' },
] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isNavActive(itemHref: string, pathname: string): boolean {
  if (itemHref === '/dashboard') return pathname === '/dashboard'
  return pathname.startsWith(itemHref)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Topbar() {
  const pathname = usePathname()
  const router = useRouter()
  useAuth()
  const { user, clearUser } = useAuthStore()
  const { appName, appShort } = useBranding()
  useSocket()

  const baseNav = user?.role === 'SUPER_ADMIN'
    ? SUPER_ADMIN_NAV
    : user?.role === 'ADMIN'
      ? ADMIN_NAV
      : EMPLOYEE_NAV
  // Hide capability-gated tabs (e.g. Onboarding) a custom role lacks. Issues is
  // open to everyone — it's a company-wide, collaborative log.
  const NAV_CAP: Record<string, string> = {
    '/dashboard/onboarding': 'onboarding.approve',
  }
  const capNav = baseNav.filter((i) => !NAV_CAP[i.href] || userCan(user, NAV_CAP[i.href]))
  // External/client users are locked to their projects — show only Projects + Profile.
  const navItems = user?.isExternal
    ? capNav.filter((i) => i.href === '/dashboard/projects' || i.href === '/dashboard/profile')
    : capNav

  const [statusOpen, setStatusOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [displayStatus, setDisplayStatus] = useState<string>('OFFLINE')
  const statusRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)

  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const mobileNavRef = useRef<HTMLDivElement>(null)

  const [bellOpen, setBellOpen] = useState(false)
  const bellRef = useRef<HTMLDivElement>(null)
  const [portalReady, setPortalReady] = useState(false)

  useEffect(() => {
    if (user?.currentStatus) setDisplayStatus(user.currentStatus)
  }, [user?.currentStatus])

  useEffect(() => { setPortalReady(true) }, [])

  // Close mobile nav on route change
  useEffect(() => {
    setMobileNavOpen(false)
  }, [pathname])

  // Close dropdowns on outside click
  useEffect(() => {
    if (!statusOpen && !userMenuOpen && !mobileNavOpen) return

    function handleClickOutside(e: MouseEvent): void {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) {
        setStatusOpen(false)
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
      if (mobileNavRef.current && !mobileNavRef.current.contains(e.target as Node)) {
        setMobileNavOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [statusOpen, userMenuOpen, mobileNavOpen])

  function handleStatusSelect(status: string): void {
    setDisplayStatus(status)
    setStatusOpen(false)
    // TODO (P06): PATCH /api/users/me/status — endpoint not yet implemented
    console.log('TODO P06 PATCH /api/users/me/status →', status)
  }

  async function handleLogout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // Network error — clear local state and redirect regardless
    }
    clearUser()
    router.push('/login')
  }

  return (
    <>
      <header className="topbar">

        {/* ── Logo mark ───────────────────────────────────────────────────── */}
        <Link href="/dashboard" className="topbar-brand" title={appName}>
          {appShort}
        </Link>

        {/* Mobile navigation is the fixed bottom tab bar (components/shared/MobileNav).
            The desktop tab row below is hidden under lg by .topbar-nav CSS. */}

        {/* ── Navigation tabs (desktop only) ──────────────────────────────── */}
        {user?.mustChangePassword ? (
          <nav className="topbar-nav">
            <span className="font-mono text-xs text-amber-600 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full">
              ⚠ Please change your password to continue
            </span>
          </nav>
        ) : (
          <nav className="topbar-nav">
            {navItems.map(({ href, label }) => {
              const active = isNavActive(href, pathname)
              return (
                <div key={href} className="flex items-center">
                  <Link
                    href={href}
                    className={`topbar-link${active ? ' topbar-link--active' : ''}`}
                  >
                    {label}
                  </Link>
                </div>
              )
            })}
          </nav>
        )}

        {/* ── Right controls ──────────────────────────────────────────────── */}
        <div className="topbar-controls">

          {/* Ask Forgie (AI assistant) — only shown for approved users */}
          {user && !user.mustChangePassword && <AskForgieButton />}

          {/* Light / dark theme toggle */}
          <ThemeToggle />

          {/* Notification bell */}
          <NotificationBell
            ref={bellRef}
            onClick={() => setBellOpen((prev) => !prev)}
            isOpen={bellOpen}
          />

          {user && (
            <>
              {/* Status selector */}
              <div className="relative hidden min-[1600px]:block" ref={statusRef}>
                <button
                  type="button"
                  onClick={() => setStatusOpen((prev) => !prev)}
                  className="topbar-status-btn"
                >
                  <StatusDot status={displayStatus} size="sm" />
                  <span>{displayStatus.replace('_', ' ')}</span>
                </button>

                {statusOpen && (
                  <div className="topbar-dropdown">
                    {STATUS_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handleStatusSelect(opt.value)}
                        className="topbar-dropdown-item"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* User menu */}
              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={() => setUserMenuOpen((prev) => !prev)}
                  className="topbar-avatar-btn"
                >
                  <Avatar name={user.name} avatarUrl={user.avatarUrl} size="sm" />
                  <span className="hidden md:inline font-mono text-xs text-text-secondary">
                    {user.name}
                  </span>
                </button>

                {userMenuOpen && (
                  <div className="topbar-dropdown">
                    <button
                      type="button"
                      onClick={() => {
                        setUserMenuOpen(false)
                        router.push('/dashboard/profile')
                      }}
                      className="topbar-dropdown-item w-full text-left border-b border-border-default px-3 py-2.5 hover:bg-text-primary/[0.06] transition-colors"
                    >
                      <p className="font-mono text-xs text-text-primary">{user.name}</p>
                      <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest mt-0.5">
                        {user.role} · view profile
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUserMenuOpen(false)
                        router.push('/dashboard/profile')
                      }}
                      className="topbar-dropdown-item"
                    >
                      ▸ PROFILE
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="topbar-dropdown-item text-status-danger hover:text-status-danger"
                    >
                      ▸ SIGN OUT
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </header>

      {/* ── Notification dropdown (portal) ──────────────────────────────── */}
      {portalReady && createPortal(
        <NotificationDropdown
          isOpen={bellOpen}
          onClose={() => setBellOpen(false)}
          bellRef={bellRef}
          isAdmin={user?.role ? isAdminRole(user.role) : false}
        />,
        document.body
      )}

      {/* ── Forgie chat panel (portal, self-mounted) ────────────────────── */}
      <ChatPanel />
    </>
  )
}
