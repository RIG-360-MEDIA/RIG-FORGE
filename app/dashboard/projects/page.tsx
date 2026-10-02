'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'

import { useAuth } from '@/hooks/useAuth'
import { userCan } from '@/lib/permissions'
import ProjectFilters from '@/components/projects/ProjectFilters'
import ProjectListRow from '@/components/projects/ProjectListRow'
import ProjectRowSkeleton from '@/components/projects/ProjectRowSkeleton'
import CreateProjectModal from '@/components/projects/CreateProjectModal'
import Alert from '@/components/ui/Alert'
import Button from '@/components/ui/Button'
import EmptyState from '@/components/ui/EmptyState'
import PageShell from '@/components/ui/PageShell'
import type {
  ProjectSummary,
  ProjectDetail,
  PaginatedResponse,
  ApiResponse,
} from '@/lib/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_LIMIT = 20

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * POST /api/projects returns ProjectDetail.
 * The list stores ProjectSummary. This converter bridges the gap.
 */
function detailToSummary(detail: ProjectDetail): ProjectSummary {
  return {
    id: detail.id,
    name: detail.name,
    description: detail.description,
    status: detail.status,
    priority: detail.priority,
    deadline: detail.deadline,
    leadId: detail.leadId,
    leadName: detail.leadName,
    clientId: detail.clientId,
    clientName: detail.clientName,
    siteLocation: detail.siteLocation,
    links: detail.links,
    totalTasks: detail.totalTasks,
    doneTasks: detail.doneTasks,
    memberCount: detail.members.length,
    members: detail.members.slice(0, 5).map((m) => ({
      id: m.userId,
      name: m.name,
      avatarUrl: m.avatarUrl,
      role: m.role,
    })),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  }
}

// ─── Column header row ────────────────────────────────────────────────────────

function ColumnHeaders({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="hidden lg:flex items-center px-6 gap-6 py-3 bg-background-primary border-b border-border-default sticky top-0 z-10">
      <div className="flex-1 min-w-0">
        <span className="font-mono text-[10px] text-muted tracking-widest uppercase">
          Project
        </span>
      </div>
      <div className="w-48 shrink-0">
        <span className="font-mono text-[10px] text-muted tracking-widest uppercase">
          Progress
        </span>
      </div>
      <div className="w-32 shrink-0">
        <span className="font-mono text-[10px] text-muted tracking-widest uppercase">
          Members
        </span>
      </div>
      <div className="w-32 shrink-0">
        <span className="font-mono text-[10px] text-muted tracking-widest uppercase">
          Deadline
        </span>
      </div>
      <div className="w-28 shrink-0">
        <span className="font-mono text-[10px] text-muted tracking-widest uppercase">
          Status
        </span>
      </div>
      {isAdmin && <div className="w-20 shrink-0" />}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()

  const [items, setItems] = useState<ProjectSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // ── Filters ────────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [sortBy, setSortBy] = useState('recent')

  // ── UI state ───────────────────────────────────────────────────────────────
  const [showModal, setShowModal] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // Create/edit controls require projects.manage; the "all projects" view + label uses projects.view_all.
  const isAdmin = userCan(user, 'projects.manage')
  const canViewAll = userCan(user, 'projects.view_all')

  // ── Auth redirect ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authLoading && !user) router.push('/login')
  }, [authLoading, user, router])

  // ── Debounce search ────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchProjects = useCallback(async (cursorParam?: string): Promise<void> => {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) })
    if (cursorParam) params.set('cursor', cursorParam)
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (statusFilter) params.set('status', statusFilter)
    if (priorityFilter) params.set('priority', priorityFilter)
    if (sortBy) params.set('sort', sortBy)

    const res = await fetch(`/api/projects?${params.toString()}`, {
      credentials: 'include',
    })
    const json = (await res.json()) as ApiResponse<PaginatedResponse<ProjectSummary>>

    if (!res.ok || !json.data) {
      throw new Error(json.error ?? 'Failed to fetch projects')
    }

    const { items: newItems, nextCursor: cursor, total: count } = json.data

    if (cursorParam) {
      setItems((prev) => [...prev, ...newItems])
    } else {
      setItems(newItems)
    }
    setNextCursor(cursor)
    setTotal(count)
  }, [debouncedSearch, statusFilter, priorityFilter, sortBy])

  useEffect(() => {
    if (authLoading || !user) return
    setLoading(true)
    setFetchError(null)
    fetchProjects()
      .catch((e: unknown) =>
        setFetchError(e instanceof Error ? e.message : 'Fetch failed'),
      )
      .finally(() => setLoading(false))
  }, [fetchProjects, authLoading, user])

  // ── Load more ──────────────────────────────────────────────────────────────
  async function handleLoadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      await fetchProjects(nextCursor)
    } catch {
      // keep existing list on error
    } finally {
      setLoadingMore(false)
    }
  }

  // ── List mutation handlers ─────────────────────────────────────────────────
  function handleCreated(detail: ProjectDetail) {
    const summary = detailToSummary(detail)
    setItems((prev) => [summary, ...prev])
    setTotal((prev) => prev + 1)
    triggerToast('PROJECT CREATED ')
  }

  function handleUpdate(updated: ProjectSummary) {
    setItems((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
  }

  function handleArchive(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id))
    setTotal((prev) => Math.max(0, prev - 1))
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function triggerToast(message: string) {
    setToast(message)
    setTimeout(() => setToast(null), 3000)
  }

  // ── Early return while auth loads ──────────────────────────────────────────
  if (authLoading) return null

  // ── Empty state subline ────────────────────────────────────────────────────
  const emptySubline =
    debouncedSearch || statusFilter || priorityFilter
      ? 'No projects match your current filters'
      : canViewAll
        ? 'Create your first project to get started'
        : 'You have not been assigned to any projects yet'

  return (
    <PageShell className="min-h-full">
      {/* ── Toast ──────────────────────────────────────────────────────────── */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 border border-accent bg-background-secondary px-4 py-3 font-mono text-xs text-accent-ink tracking-widest forge-glow transition-opacity duration-300">
          {toast}
        </div>
      )}

      {/* ── Page header ────────────────────────────────────────────────────── */}
      <div className="pb-6">
        <p className="type-meta text-accent-ink">Delivery Portfolio</p>
        <h1 className="type-h1">{canViewAll ? 'Projects' : 'My Projects'}</h1>
        <p className="type-body-muted mt-1">{total} active projects</p>
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <ProjectFilters
        search={search}
        status={statusFilter}
        priority={priorityFilter}
        sort={sortBy}
        total={total}
        isAdmin={isAdmin}
        onSearchChange={setSearch}
        onStatusChange={setStatusFilter}
        onPriorityChange={setPriorityFilter}
        onSortChange={setSortBy}
        onCreateClick={() => setShowModal(true)}
      />

      {/* ── Divider ────────────────────────────────────────────────────────── */}
      <div className="border-t border-border-default" />

      {/* ── Column headers ─────────────────────────────────────────────────── */}
      <ColumnHeaders isAdmin={isAdmin} />

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {loading ? (
        Array.from({ length: 5 }).map((_, i) => <ProjectRowSkeleton key={i} />)
      ) : fetchError ? (
        <Alert variant="error">{fetchError}</Alert>
      ) : items.length === 0 ? (
        <EmptyState title="NO PROJECTS FOUND " subline={emptySubline} />
      ) : (
        items.map((project) => (
          <ProjectListRow
            key={project.id}
            project={project}
            isAdmin={isAdmin}
            onUpdate={handleUpdate}
            onArchive={handleArchive}
          />
        ))
      )}

      {/* ── Load more ──────────────────────────────────────────────────────── */}
      {nextCursor && !loading && (
        <div className="flex justify-center mt-4 mb-8">
          <Button
            onClick={() => void handleLoadMore()}
            disabled={loadingMore}
            variant="subtle"
          >
            {loadingMore ? 'LOADING...' : 'LOAD MORE'}
          </Button>
        </div>
      )}

      {/* ── Create modal ───────────────────────────────────────────────────── */}
      <CreateProjectModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onCreated={handleCreated}
      />
    </PageShell>
  )
}
