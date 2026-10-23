import type { TaskSummary } from '@/lib/types'

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE'
export type Priority   = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

/** Group key for tasks without a category. */
export const NONE = '__none__'

/** Offered when a company adds its first categories; any name can be typed instead. */
export const SUGGESTED_CATEGORIES = [
  'Civil', 'Structure', 'Electrical', 'Plumbing', 'HVAC', 'Interior', 'Furniture',
  'Landscape', 'Drawings', 'Approvals', 'Site visits', 'Client meetings',
]

export const PRIORITY_STYLES: Record<Priority, string> = {
  LOW:      'bg-gray-700 text-gray-300',
  MEDIUM:   'bg-blue-900 text-blue-300',
  HIGH:     'bg-orange-900 text-orange-300',
  CRITICAL: 'bg-red-900 text-red-300',
}

/** Marks a task can carry. 5 means payment related — see lib/tasks.ts. */
export const PAYMENT_POINTS = 5
export const POINTS_LABELS: Record<number, string> = {
  1: '1 mark — small task',
  2: '2 marks — bigger task',
  5: '5 marks — payment related',
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  TODO:        'To Do',
  IN_PROGRESS: 'In Progress',
  DONE:        'Done',
}

export function isOverdue(task: TaskSummary): boolean {
  if (!task.dueDate || task.status === 'DONE') return false
  return new Date(task.dueDate) < new Date()
}

export function formatDate(date: Date | string | null): string {
  if (!date) return 'No due date'
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "31 Oct", for compact assignment labels. */
export function shortDate(date: Date | string | null): string {
  return date ? new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''
}

/** yyyy-mm-dd for a date input. */
export function toDateInput(date: Date | string | null): string {
  return date ? new Date(date).toISOString().slice(0, 10) : ''
}

const STATUS_RANK: Record<string, number> = { IN_PROGRESS: 0, TODO: 1, DONE: 2 }

/** Work in progress first, then to-do by due date, done last; ties keep the order they were added. */
export function compareTasks(a: TaskSummary, b: TaskSummary): number {
  const s = (STATUS_RANK[a.status] ?? 1) - (STATUS_RANK[b.status] ?? 1)
  if (s !== 0) return s
  return compareByDue(a, b)
}

/** By due date (none last), then the order they were added. */
export function compareByDue(a: TaskSummary, b: TaskSummary): number {
  const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity
  const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity
  if (da !== db) return da - db
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

/** Non-empty lines of pasted text, list bullets and numbering removed. */
export function pastedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•▪◦]|\d{1,3}[.)])\s+/, '').trim())
    .filter(Boolean)
}

export const optionClass = 'bg-background-primary text-primary'
export const fieldClass =
  'text-xs bg-background-primary border border-border-default rounded px-2 py-1.5 text-primary focus:outline-none focus:border-accent disabled:opacity-50 [color-scheme:light]'
