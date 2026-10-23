import { prisma } from '@/lib/db'
import type { TokenPayload } from '@/lib/auth'
import { tokenCan } from '@/lib/permissions'

export const MAX_CATEGORY_NAME = 60

/** The columns every category read returns (TaskCategorySummary). */
export const CATEGORY_SELECT = { id: true, name: true, sortOrder: true, isActive: true } as const

/**
 * May this user manage the task list of this project: build it, apply a
 * template, assign tasks in bulk, add a category from inside it? Admins
 * (tasks.manage) anywhere; otherwise only the project's lead. External
 * (client/supplier) users never.
 */
export async function canManageProjectTasks(payload: TokenPayload, projectId: unknown): Promise<boolean> {
  if (payload.isExternal) return false
  if (tokenCan(payload, 'tasks.manage')) return true
  if (typeof projectId !== 'string' || !projectId) return false
  const project = await prisma.project.findFirst({ where: { id: projectId, isActive: true }, select: { leadId: true } })
  return project?.leadId === payload.userId
}

/** Tidy a submitted category name: trimmed, single spaces. */
export function cleanCategoryName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
}
