import type { Priority, TaskStatus } from '@prisma/client'

import { prisma } from '@/lib/db'
import type { TaskSummary } from '@/lib/types'

const MAX_DEPENDENCY_HOPS = 10

/** Task row + relations required to build TaskSummary. */
export type TaskForSummary = {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: Priority
  projectId: string
  assigneeId: string | null
  expectedOutput: string | null
  startDate: Date | null
  dueDate: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  project: { name: string }
  assignee: { name: string; avatarUrl: string | null } | null
}


/**
 * Maps a Prisma task with project + assignee includes to the public TaskSummary shape.
 */
export function buildTaskSummary(task: TaskForSummary): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    projectId: task.projectId,
    projectName: task.project.name,
    assigneeId: task.assigneeId,
    assigneeName: task.assignee?.name ?? null,
    assigneeAvatar: task.assignee?.avatarUrl ?? null,
    expectedOutput: task.expectedOutput,
    startDate: task.startDate,
    dueDate: task.dueDate,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}
