import { prisma } from '@/lib/db'
import { sendPushToUsers } from '@/lib/push/send'

/** A task that was just given to someone. */
export interface AssignedTask {
  title: string
  projectId: string
  projectName: string
  assigneeId: string
}

/**
 * Tell people they have been given tasks: an in-app notification and a phone
 * push. One notification per person per project, so assigning ten electrical
 * tasks to someone at once sends one message, not ten. Nothing is sent to the
 * person who did the assigning.
 *
 * Never throws: a failed notification must not fail the assignment itself.
 */
export async function notifyTasksAssigned(tasks: AssignedTask[], actor: { userId: string }): Promise<void> {
  try {
    const groups = new Map<string, AssignedTask[]>()
    for (const t of tasks) {
      if (t.assigneeId === actor.userId) continue
      const key = `${t.assigneeId}|${t.projectId}`
      groups.set(key, [...(groups.get(key) ?? []), t])
    }
    if (groups.size === 0) return

    const who = await prisma.user.findFirst({ where: { id: actor.userId }, select: { name: true } })
    const by = who?.name ?? 'Someone'

    for (const list of groups.values()) {
      const first = list[0]!
      const title = list.length === 1 ? 'New task for you' : `${list.length} new tasks for you`
      const body = list.length === 1
        ? `${by} assigned you "${first.title}" in ${first.projectName}`
        : `${by} assigned you ${list.length} tasks in ${first.projectName}: ${list.slice(0, 3).map((t) => `"${t.title}"`).join(', ')}${list.length > 3 ? ' and more' : ''}`
      const linkTo = `/dashboard/projects/${first.projectId}#tasks`
      await prisma.notification.create({
        data: { userId: first.assigneeId, type: 'TASK_ASSIGNED', title, body: body.slice(0, 500), linkTo },
      })
      void sendPushToUsers([first.assigneeId], { title, body: body.slice(0, 140), url: linkTo, tag: `tasks-${first.projectId}` })
    }
  } catch (error) {
    console.error('[notifyTasksAssigned]', error)
  }
}
