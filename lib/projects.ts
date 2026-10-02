import { prisma } from '@/lib/db'
import type { ProjectDetail, ProjectSummary, ProjectLink } from '@/lib/types'

// ─── Auth helpers ─────────────────────────────────────────────────────────────

export async function isMemberOfProject(
  userId: string,
  projectId: string,
): Promise<boolean> {
  const membership = await prisma.projectMember.findUnique({
    where: { userId_projectId: { userId, projectId } },
    select: { id: true },
  })
  return membership !== null
}

/**
 * Can this user be given a task on this project?
 *
 * Normally the assignee must be an active member of the project. SUPER_ADMINs
 * are the exception: they oversee every project, and the team needs to be able
 * to send questions up to them without an admin first adding them to each
 * project one by one. So a super admin is assignable everywhere.
 *
 * findFirst (not findUnique) so the org-scope extension applies and one tenant
 * cannot assign work to another tenant's super admin.
 */
export async function canBeAssigned(userId: string, projectId: string): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true },
    select: { role: true },
  })
  if (!user) return false
  if (user.role === 'SUPER_ADMIN') return true

  const membership = await prisma.projectMember.findUnique({
    where: { userId_projectId: { userId, projectId } },
    select: { id: true },
  })
  return membership !== null
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export async function fetchProjectDetail(
  projectId: string,
): Promise<ProjectDetail | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId, isActive: true },
    include: {
      lead: { select: { id: true, name: true, email: true, avatarUrl: true, role: true, currentStatus: true } },
      client: { select: { id: true, name: true } },
      members: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
              role: true,
              currentStatus: true,
            },
          },
        },
      },
      tasks: {
        where: { isActive: true },
        include: {
          assignee: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!project) return null

  const totalTasks = project.tasks.length
  const doneTasks = project.tasks.filter((t) => t.status === 'DONE').length
  const rawLinks = project.links
  const links: ProjectLink[] = Array.isArray(rawLinks)
    ? (rawLinks as unknown as ProjectLink[])
    : []

  // The project LEAD isn't necessarily a ProjectMember row, which meant they
  // never appeared in the assignee dropdown ("I want the task assigned to the
  // project lead but it's not giving me the option"). Surface the lead as a
  // member (listed first) so they're assignable everywhere members are used.
  const memberRows = project.members.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    avatarUrl: m.user.avatarUrl,
    role: m.user.role,
    currentStatus: m.user.currentStatus,
    joinedAt: m.joinedAt,
    isLead: project.leadId === m.user.id,
  }))
  if (project.lead && project.leadId && !memberRows.some((m) => m.userId === project.leadId)) {
    memberRows.unshift({
      userId: project.lead.id,
      name: project.lead.name,
      email: project.lead.email,
      avatarUrl: project.lead.avatarUrl,
      role: project.lead.role,
      currentStatus: project.lead.currentStatus,
      joinedAt: project.createdAt,
      isLead: true,
    })
  }

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    priority: project.priority,
    deadline: project.deadline,
    leadId: project.leadId,
    leadName: project.lead?.name ?? null,
    clientId: project.clientId,
    clientName: project.client?.name ?? null,
    siteLocation: project.siteLocation,
    links,
    totalTasks,
    doneTasks,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    members: memberRows,
    tasks: project.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      expectedOutput: t.expectedOutput,
      status: t.status,
      priority: t.priority,
      assigneeId: t.assigneeId,
      assigneeName: t.assignee?.name ?? null,
      points: t.points,
      startDate: t.startDate,
      dueDate: t.dueDate,
      completedAt: t.completedAt,
      createdAt: t.createdAt,
    })),
  }
}

export async function fetchProjectSummary(
  projectId: string,
): Promise<ProjectSummary | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId, isActive: true },
    include: {
      lead: { select: { name: true } },
      client: { select: { id: true, name: true } },
      tasks: {
        where: { isActive: true },
        select: { status: true },
      },
      members: {
        take: 5,
        orderBy: { joinedAt: 'asc' },
        select: {
          user: {
            select: { id: true, name: true, avatarUrl: true, role: true },
          },
        },
      },
      _count: { select: { members: true } },
    },
  })

  if (!project) return null

  const totalTasks = project.tasks.length
  const doneTasks = project.tasks.filter((t) => t.status === 'DONE').length
  const rawLinks = project.links
  const links: ProjectLink[] = Array.isArray(rawLinks)
    ? (rawLinks as unknown as ProjectLink[])
    : []

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    priority: project.priority,
    deadline: project.deadline,
    leadId: project.leadId,
    leadName: project.lead?.name ?? null,
    clientId: project.clientId,
    clientName: project.client?.name ?? null,
    siteLocation: project.siteLocation,
    links,
    totalTasks,
    doneTasks,
    memberCount: project._count.members,
    members: project.members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      avatarUrl: m.user.avatarUrl,
      role: m.user.role,
    })),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}
