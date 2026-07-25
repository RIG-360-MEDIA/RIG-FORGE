'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { useAuth } from '@/hooks/useAuth'
import { userCan } from '@/lib/permissions'
import MemberCard from '@/components/people/MemberCard'
import MemberSlideOver from '@/components/people/MemberSlideOver'
import RolesManager from '@/components/people/RolesManager'
import StatusDot from '@/components/ui/StatusDot'
import Badge from '@/components/ui/Badge'
import Avatar from '@/components/ui/Avatar'
import type { MemberSummary, ApiResponse, PaginatedResponse } from '@/lib/types'

const PAGE_LIMIT = 20

// ─── Teammate card (read-only, no click, no extra info) ──────────────────────

function TeammateCard({ member }: { member: MemberSummary }) {
  return (
    <div className="forge-card p-5 cursor-default select-none">
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <Avatar name={member.name} avatarUrl={member.avatarUrl} size="lg" />
          <span className="absolute bottom-0 right-0">
            <StatusDot status={member.currentStatus} size="sm" />
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-mono text-sm text-primary font-bold truncate">{member.name}</p>
          <div className="mt-0.5">
            <Badge label={member.role} variant="role" value={member.role} />
          </div>
        </div>
      </div>
      <div className="mt-3">
        <p className="font-mono text-xs text-muted">
          {member.currentStatus === 'WORKING' ? '● Working now' : '○ Not working'}
        </p>
      </div>
    </div>
  )
}

// ─── Inner component (uses useSearchParams — must be inside Suspense) ─────────

function PeoplePageInner() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [members, setMembers] = useState<MemberSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  // Slide-over: driven by ?member= URL param
  // Only open if user is ADMIN or viewing own profile
  const rawSelectedId = searchParams.get('member')
  const isAdmin = userCan(user, 'members.view')
  const isSuperAdmin = user?.role === 'SUPER_ADMIN'
  // Role management (create/edit roles, assign them) is open to base admins +
  // super-admins. Promoting to base ADMIN stays super-admin-only (enforced API-side).
  const canManageRoles = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN'
  // For employees, only allow slide-over for own profile
  const selectedId = isAdmin
    ? rawSelectedId
    : rawSelectedId === user?.id
      ? rawSelectedId
      : null

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [role, setRole] = useState('')
  // Seed the status filter from the URL so deep-links (e.g. the dashboard's
  // "Working Now" card → ?status=WORKING) land pre-filtered.
  const [status, setStatus] = useState(() => {
    const s = searchParams.get('status')
    return s === 'WORKING' || s === 'NOT_WORKING' ? s : ''
  })
  const [rolesManagerOpen, setRolesManagerOpen] = useState(false)

  // Redirect unauthenticated users
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login')
    }
  }, [authLoading, user, router])

  // Debounce search input 300ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  const fetchMembers = useCallback(async (cursorParam?: string): Promise<void> => {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) })
    if (cursorParam) params.set('cursor', cursorParam)
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (role) params.set('role', role)
    if (status) params.set('status', status)

    const res = await fetch(`/api/users?${params.toString()}`, { credentials: 'include' })
    const json = await res.json() as ApiResponse<PaginatedResponse<MemberSummary>>

    if (res.ok && json.data) {
      const { items, nextCursor: cursor, total: count } = json.data
      if (cursorParam) {
        setMembers((prev) => [...prev, ...items])
      } else {
        setMembers(items)
      }
      setNextCursor(cursor)
      setTotal(count)
    }
  }, [debouncedSearch, role, status])

  useEffect(() => {
    if (authLoading || !user) return
    setLoading(true)
    setNextCursor(null)
    fetchMembers()
      .catch(() => { /* keep empty state on error */ })
      .finally(() => setLoading(false))
  }, [fetchMembers, authLoading, user])

  const handleLoadMore = async (): Promise<void> => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      await fetchMembers(nextCursor)
    } catch { /* keep existing list on error */ }
    finally { setLoadingMore(false) }
  }

  // Open slide-over — employees can only open their own
  const openMember = useCallback((id: string) => {
    if (!isAdmin && !isSuperAdmin && id !== user?.id) return  // client-side guard
    const params = new URLSearchParams(searchParams.toString())
    params.set('member', id)
    router.push(`?${params.toString()}`, { scroll: false })
  }, [router, searchParams, isAdmin, user?.id])

  const closeMember = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('member')
    const qs = params.toString()
    router.push(qs ? `?${qs}` : '/dashboard/people', { scroll: false })
  }, [router, searchParams])

  if (authLoading) return null

  const remaining = total - members.length

  // For employees: split own card from teammate cards
  const ownCard = !isAdmin ? members.find((m) => m.isOwnProfile) : null
  const teammates = !isAdmin ? members.filter((m) => !m.isOwnProfile) : []
  const hasNoTeammates = !isAdmin && teammates.length === 0

  return (
    <div className="min-h-full">
      {/* ── Page header ──────────────────────────────────────── */}
      <div className="px-4 sm:px-6 lg:px-8 pt-8 pb-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono text-xs text-muted tracking-widest">[ 01 — PEOPLE ]</p>
            <h1 className="font-mono font-bold text-3xl text-primary tracking-tight mt-1">
              TEAM MEMBERS
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {canManageRoles && (
              <button
                type="button"
                onClick={() => setRolesManagerOpen(true)}
                className="forge-card px-4 py-2 font-mono text-xs text-accent-ink tracking-widest hover:border-accent transition-colors"
              >
                MANAGE ROLES
              </button>
            )}
            <div className="forge-card px-4 py-2 text-right">
              <p className="font-mono font-bold text-2xl text-accent-ink forge-text-glow leading-none">
                {total}
              </p>
              <p className="font-mono text-xs text-muted mt-1">ACTIVE MEMBERS</p>
            </div>
          </div>
        </div>
        <div className="border-t border-border-default mt-6" />
      </div>

      {/* ── Filters bar (admin only) ──────────────────────────── */}
      {isAdmin && (
        <div className="px-4 sm:px-6 lg:px-8 py-4 flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="Search by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-border-default rounded px-3 py-1.5 text-sm bg-surface-raised text-text-primary placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent w-56"
          />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="border border-border-default rounded px-3 py-1.5 text-sm bg-surface-raised text-text-primary focus:outline-none">
            <option value="">All Roles</option>
            <option value="ADMIN">Admin</option>
            <option value="EMPLOYEE">Employee</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="border border-border-default rounded px-3 py-1.5 text-sm bg-surface-raised text-text-primary focus:outline-none">
            <option value="">All Status</option>
            <option value="WORKING">Working</option>
            <option value="NOT_WORKING">Not Working</option>
          </select>
        </div>
      )}

      {/* ── Employee search bar (name search only) ───────────── */}
      {!isAdmin && (
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <input
            type="text"
            placeholder="Search teammates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-border-default rounded px-3 py-1.5 text-sm bg-surface-raised text-text-primary placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent w-56"
          />
        </div>
      )}

      {/* ── Content ──────────────────────────────────────────── */}
      <div className="px-4 sm:px-6 lg:px-8 py-6">
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="forge-card h-48 bg-background-tertiary forge-shimmer" />
            ))}
          </div>
        ) : isAdmin ? (
          /* ── ADMIN view: all cards clickable ── */
          members.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-3">
              <span className="text-muted text-6xl select-none">○</span>
              <p className="font-mono text-sm text-muted tracking-widest">NO MEMBERS FOUND</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {members.map((member) => (
                <MemberCard
                  key={member.id}
                  member={member}
                  isSelected={selectedId === member.id}
                  onClick={() => openMember(member.id)}
                />
              ))}
            </div>
          )
        ) : (
          /* ── EMPLOYEE view: own card + teammates (read-only) ── */
          <div className="space-y-8">
            {/* Own profile — pinned at top, clickable */}
            {ownCard && (
              <div>
                <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-3">
                  YOUR PROFILE
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  <MemberCard
                    member={ownCard}
                    isSelected={selectedId === ownCard.id}
                    onClick={() => openMember(ownCard.id)}
                  />
                </div>
              </div>
            )}

            {/* Teammates — display only, never clickable */}
            {teammates.length > 0 && (
              <div>
                <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-3">
                  YOUR TEAMMATES ({teammates.length})
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {teammates.map((member) => (
                    <TeammateCard key={member.id} member={member} />
                  ))}
                </div>
              </div>
            )}

            {/* No teammates note */}
            {hasNoTeammates && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <span className="text-muted text-4xl select-none">○</span>
                <p className="font-mono text-sm text-muted tracking-widest">NO TEAMMATES YET</p>
                <p className="font-mono text-xs text-muted">You haven&apos;t been added to any projects yet</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Load more (admin only for now) ────────────────────── */}
      {nextCursor && !loading && isAdmin && (
        <div className="px-4 sm:px-6 lg:px-8 pb-8 flex justify-center">
          <button
            onClick={() => void handleLoadMore()}
            disabled={loadingMore}
            className="forge-card px-4 sm:px-6 lg:px-8 py-3 font-mono text-xs text-secondary hover:text-accent-ink transition-all duration-150 cursor-pointer disabled:opacity-50"
          >
            {loadingMore ? 'LOADING...' : `LOAD MORE — ${remaining}`}
          </button>
        </div>
      )}

      {/* ── Member slide-over ─────────────────────────────────── */}
      <MemberSlideOver
        memberId={selectedId}
        isAdmin={isAdmin}
        isSuperAdmin={isSuperAdmin}
        canManageRoles={canManageRoles}
        currentUserId={user?.id}
        onClose={closeMember}
        onRemoved={(id) => setMembers((prev) => prev.filter((m) => m.id !== id))}
        onRoleChanged={(id, role) =>
          setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, role: role as MemberSummary['role'] } : m)))
        }
      />

      {/* ── Roles & Permissions manager (admins + super-admins) ─── */}
      {canManageRoles && (
        <RolesManager
          open={rolesManagerOpen}
          onClose={() => setRolesManagerOpen(false)}
        />
      )}
    </div>
  )
}

// ─── Page export ─────────────────────────────────────────────────────────────

export default function PeoplePage() {
  return (
    <Suspense fallback={null}>
      <PeoplePageInner />
    </Suspense>
  )
}
