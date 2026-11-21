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

/**
 * For interactive transactions: wait up to 10 s for a pooled connection
 * (Prisma's default is 2 s, after which it fails with a 500; the pool holds
 * 5 connections, so a burst of saves queued and some failed) and allow 30 s.
 */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const

const SELECT = { id: true, name: true, sortOrder: true, isActive: true } as const

/**
 * True when a save failed only because the database was busy: no pooled
 * connection free in time (P2024), a transaction that could not start
 * (P2028), or a deadlock that survived its retry (40P01). Nothing was
 * written; the user should simply try again, so the routes answer 503 with
 * that message instead of a generic 500.
 */
export function isBusyError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === 'P2024' || e?.code === 'P2028' || String(e?.message ?? '').includes('40P01')
}
export const BUSY_MESSAGE = 'Busy saving other changes. Nothing was changed; please try again in a moment.'

/**
 * The company's category of this name (any letter case), created when there
 * is none and brought back when archived. Safe when several requests add the
 * same name at once: the loser of the unique-index race gets the winner's row
 * instead of a 500.
 */
export async function findOrCreateCategory(name: string) {
  const find = () => prisma.taskCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: SELECT })
  let cat = await find()
  if (!cat) {
    try {
      const last = await prisma.taskCategory.aggregate({ _max: { sortOrder: true } })
      cat = await prisma.taskCategory.create({ data: { name, sortOrder: (last._max.sortOrder ?? 0) + 1 }, select: SELECT })
      return { category: cat, created: true }
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e
      cat = await find()
      if (!cat) throw e
    }
  }
  if (!cat.isActive) {
    cat = await prisma.taskCategory.update({ where: { id: cat.id }, data: { isActive: true }, select: SELECT })
  }
  return { category: cat, created: false }
}

/** Tidy a submitted category name: trimmed, single spaces. */
export function cleanCategoryName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
}
