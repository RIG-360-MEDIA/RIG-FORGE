import { prisma } from '@/lib/db'
import { MAX_CATEGORY_NAME, cleanCategoryName } from '@/lib/task-categories'
import { createTasks } from '@/lib/tasks'
import type { TaskSummary, TaskTemplateDetail } from '@/lib/types'

export const MAX_TEMPLATE_ITEMS = 500
export const MAX_TEMPLATE_NAME = 100

/** One submitted template line: a title, filed under a category by id or by name. */
export interface TemplateItemInput {
  title: string
  categoryId?: string | null
  categoryName?: string | null
}

/** Lower-case, single-spaced, for comparing titles and names. */
export const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** Tidy a submitted task title: no leading "34." numbering, single spaces. */
export function cleanItemTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/^\s*\d{1,3}[.)]\s*/, '').replace(/\s+/g, ' ').trim()
}

/**
 * Check and tidy submitted template items. Returns the cleaned list, or an
 * error message. Category names are turned into category ids (an existing
 * category of that name in any letter case, an archived one brought back,
 * or a new one), so an Excel import can say "Plumbing" and land under the
 * company's Plumbing category.
 */
export async function resolveTemplateItems(
  raw: unknown,
): Promise<{ items: { title: string; categoryId: string | null }[] } | { error: string }> {
  if (!Array.isArray(raw)) return { error: 'items must be a list' }
  if (raw.length > MAX_TEMPLATE_ITEMS) return { error: `A template can hold at most ${MAX_TEMPLATE_ITEMS} items` }

  const categories = await prisma.taskCategory.findMany({ select: { id: true, name: true, isActive: true } })
  const byName = new Map(categories.map((c) => [norm(c.name), c]))
  const known = new Set(categories.map((c) => c.id))

  const items: { title: string; categoryId: string | null }[] = []
  for (const entry of raw as TemplateItemInput[]) {
    const title = cleanItemTitle(entry?.title)
    if (!title) continue
    if (title.length > 200) return { error: `Each item must be 200 characters or fewer ("${title.slice(0, 40)}...")` }

    let categoryId: string | null = null
    if (typeof entry.categoryId === 'string' && entry.categoryId) {
      if (!known.has(entry.categoryId)) return { error: 'An item names a category that does not exist' }
      categoryId = entry.categoryId
    } else {
      const name = cleanCategoryName(entry.categoryName)
      if (name) {
        if (name.length > MAX_CATEGORY_NAME) return { error: `Category names must be ${MAX_CATEGORY_NAME} characters or fewer` }
        let cat = byName.get(norm(name))
        if (!cat) {
          const last = await prisma.taskCategory.aggregate({ _max: { sortOrder: true } })
          cat = await prisma.taskCategory.create({
            data: { name, sortOrder: (last._max.sortOrder ?? 0) + 1 },
            select: { id: true, name: true, isActive: true },
          })
          byName.set(norm(name), cat)
          known.add(cat.id)
        } else if (!cat.isActive) {
          await prisma.taskCategory.update({ where: { id: cat.id }, data: { isActive: true } })
          cat.isActive = true
        }
        categoryId = cat.id
      }
    }
    items.push({ title, categoryId })
  }
  return { items }
}

/** A template with its items in order, for the editor and the "Add from template" picker. */
export async function loadTemplateDetail(id: string): Promise<TaskTemplateDetail | null> {
  const t = await prisma.taskTemplate.findFirst({
    where: { id },
    select: {
      id: true, name: true, description: true, isActive: true,
      items: {
        orderBy: { sortOrder: 'asc' },
        select: { id: true, title: true, categoryId: true, sortOrder: true, category: { select: { name: true } } },
      },
    },
  })
  if (!t) return null
  return {
    id: t.id, name: t.name, description: t.description, isActive: t.isActive,
    items: t.items.map((i) => ({ id: i.id, title: i.title, categoryId: i.categoryId, categoryName: i.category?.name ?? null, sortOrder: i.sortOrder })),
  }
}

/**
 * Copy a template's items into a project as unassigned tasks, each under its
 * category. `itemIds` limits it to the items ticked. Items already in the
 * project (same title and category) are skipped, counted one for one: a
 * template that lists a line twice on purpose (the same drawing for the
 * ground and the first floor) adds both, and applying it again adds neither.
 */
export async function applyTemplate(
  projectId: string,
  templateId: string,
  itemIds?: string[],
): Promise<{ added: TaskSummary[]; skipped: number } | { error: string }> {
  const template = await loadTemplateDetail(templateId)
  if (!template || !template.isActive) return { error: 'Template not found' }

  const wanted = itemIds ? new Set(itemIds) : null
  const chosen = template.items.filter((i) => !wanted || wanted.has(i.id))
  if (chosen.length === 0) return { error: 'No items chosen' }

  const existing = await prisma.task.findMany({ where: { projectId, isActive: true }, select: { title: true, categoryId: true } })
  const have = new Map<string, number>()
  for (const t of existing) {
    const key = `${t.categoryId ?? ''}|${norm(t.title)}`
    have.set(key, (have.get(key) ?? 0) + 1)
  }
  const fresh = chosen.filter((i) => {
    const key = `${i.categoryId ?? ''}|${norm(i.title)}`
    const n = have.get(key) ?? 0
    if (n === 0) return true
    have.set(key, n - 1)
    return false
  })

  const added = await createTasks(fresh.map((i) => ({
    title: i.title, projectId, status: 'TODO', priority: 'MEDIUM', categoryId: i.categoryId,
  })))
  return { added, skipped: chosen.length - fresh.length }
}
