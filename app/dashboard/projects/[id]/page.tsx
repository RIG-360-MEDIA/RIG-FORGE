'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { useAuth } from '@/hooks/useAuth'
import { userCan } from '@/lib/permissions'
import ProjectHeader from '@/components/projects/detail/ProjectHeader'
import { useProjectTab } from '@/components/projects/detail/ProjectTabs'
import OverviewTab from '@/components/projects/detail/OverviewTab'
import TasksTab from '@/components/projects/detail/TasksTab'
import UpdatesTab from '@/components/projects/detail/UpdatesTab'
import EditProjectModal from '@/components/projects/detail/EditProjectModal'
import AddMemberModal from '@/components/projects/detail/AddMemberModal'
import Button from '@/components/ui/Button'
import EmptyState from '@/components/ui/EmptyState'
import type { ProjectDetail, ProjectSummary, ApiResponse } from '@/lib/types'

function mergeSummaryIntoDetail(detail: ProjectDetail, summary: ProjectSummary): ProjectDetail {
  return {
    ...detail,
    name: summary.name,
    description: summary.description,
    status: summary.status,
    priority: summary.priority,
    deadline: summary.deadline,
    totalTasks: summary.totalTasks,
    doneTasks: summary.doneTasks,
    updatedAt: summary.updatedAt,
  }
}

function ProjectDetailSkeleton() {
  return (
    <div className="min-h-full">
      <div className="bg-background-secondary border-b border-border-default px-4 sm:px-6 lg:px-8 pt-6 pb-0">
        <div className="h-4 w-32 forge-shimmer bg-background-tertiary mb-6" />
        <div className="flex justify-between mb-4">
          <div className="h-9 w-64 max-w-[70%] forge-shimmer bg-background-tertiary" />
          <div className="h-8 w-48 forge-shimmer bg-background-tertiary" />
        </div>
        <div className="flex gap-2 mb-4">
          <div className="h-5 w-16 forge-shimmer bg-background-tertiary" />
          <div className="h-5 w-16 forge-shimmer bg-background-tertiary" />
        </div>
        <div className="h-2 w-full max-w-md forge-shimmer bg-background-tertiary mb-6" />
        <div className="flex border-b border-border-default -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 overflow-x-auto">
          <div className="h-10 w-28 forge-shimmer bg-background-tertiary mb-0 mr-4" />
          <div className="h-10 w-28 forge-shimmer bg-background-tertiary mb-0 mr-4" />
          <div className="h-10 w-28 forge-shimmer bg-background-tertiary mb-0" />
        </div>
      </div>
      <div className="px-4 sm:px-6 lg:px-8 py-6 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-10 w-full forge-shimmer bg-background-secondary border border-border-default" />
        ))}
      </div>
    </div>
  )
}

export default function ProjectDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = typeof params.id === 'string' ? params.id : ''
  const { user, loading: authLoading } = useAuth()
  const userId = user?.id ?? null
  const tab = useProjectTab()

  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const [editOpen, setEditOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const isAdmin = userCan(user, 'projects.manage')
  const isLead = project?.leadId === user?.id

  useEffect(() => {
    if (!authLoading && !user) router.push('/login')
  }, [authLoading, user, router])

  const loadProject = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setNotFound(false)
    setForbidden(false)
    setFetchError(null)
    try {
      const res = await fetch(`/api/projects/${id}`, { credentials: 'include' })
      const json = (await res.json()) as ApiResponse<ProjectDetail>

      if (res.status === 404) {
        setNotFound(true)
        setProject(null)
      } else if (res.status === 403) {
        setForbidden(true)
        setProject(null)
      } else if (!res.ok) {
        setFetchError(json.error ?? 'Failed to load project')
        setProject(null)
      } else if (json.data) {
        setProject(json.data)
      } else {
        setFetchError(json.error ?? 'Failed to load project')
        setProject(null)
      }
    } catch {
      setFetchError('Network error')
      setProject(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (authLoading || !userId || !id) return
    void loadProject()
  }, [authLoading, userId, id, loadProject])

  function handleSaved(summary: ProjectSummary) {
    setProject((p) => (p ? mergeSummaryIntoDetail(p, summary) : null))
  }

  function handleAdded(detail: ProjectDetail) {
    setProject(detail)
    setToast('MEMBERS ADDED ')
    setTimeout(() => setToast(null), 3000)
  }

  if (authLoading) {
    return <ProjectDetailSkeleton />
  }

  if (!user) {
    return null
  }

  if (loading) {
    return <ProjectDetailSkeleton />
  }

  if (notFound) {
    return (
      <EmptyState
        title="PROJECT NOT FOUND "
        subline="The project may have been removed or the link is invalid."
        action={<Button variant="subtle" onClick={() => router.push('/dashboard/projects')}>← Back to Projects</Button>}
      />
    )
  }

  if (forbidden) {
    return (
      <EmptyState
        title="ACCESS DENIED "
        subline="You are not a member of this project."
      />
    )
  }

  if (fetchError || !project) {
    return (
      <EmptyState
        title="ERROR "
        subline={fetchError ?? 'Unable to load this project.'}
        action={<Button variant="subtle" onClick={() => void loadProject()}>RETRY</Button>}
      />
    )
  }

  return (
    <div className="min-h-full flex flex-col bg-background-primary">
      {toast && (
        <div className="fixed top-4 right-4 z-50 border border-accent bg-background-secondary px-4 py-3 font-mono text-xs text-accent-ink tracking-widest forge-glow">
          {toast}
        </div>
      )}

      <ProjectHeader
        project={project}
        isAdmin={isAdmin}
        onEditClick={() => setEditOpen(true)}
        onAddMemberClick={() => setAddMemberOpen(true)}
      />

      <div className="flex-1">
        {tab === 'overview' && (
          <OverviewTab
            project={project}
            isAdmin={isAdmin}
            isLead={isLead}
            currentUserId={userId ?? undefined}
            onProjectChange={setProject}
          />
        )}
        {tab === 'tasks' && (
          <TasksTab
            projectId={project.id}
            isAdmin={isAdmin}
            isLead={isLead}
            currentUserId={userId ?? ''}
            canCreate={!user?.isExternal}
          />
        )}
        {tab === 'updates' && (
          <UpdatesTab
            projectId={project.id}
            currentUser={{ id: user?.id ?? '', name: user?.name ?? '', role: user?.role ?? '' }}
            isLead={isLead}
            isAdmin={isAdmin}
          />
        )}
      </div>

      <EditProjectModal
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        project={project}
        onSaved={handleSaved}
      />

      <AddMemberModal
        isOpen={addMemberOpen}
        onClose={() => setAddMemberOpen(false)}
        project={project}
        onAdded={handleAdded}
      />
    </div>
  )
}
