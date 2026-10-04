/**
 * Run bookkeeping for the two background backfills (bylaws and general NAS),
 * shared so both get the same guarantees:
 *
 *  - At most one RUNNING run per org and pipeline. Checked and created under a
 *    Postgres advisory lock, so two clicks at once cannot start two runs.
 *  - A run that stops heart-beating (Render restarted mid-run: the detached job
 *    died with the process) is marked FAILED as interrupted when the next run
 *    is requested, instead of blocking every future run forever.
 *  - A live job notices when its run was taken over that way and stops, so two
 *    jobs never work through the same files at once.
 */
import { prisma } from '@/lib/db'

export type RunKind = 'bylaws' | 'nas'

export interface RunRow {
  id: string
  organizationId: string
  status: 'RUNNING' | 'DONE' | 'FAILED'
  startedAt: Date
  finishedAt: Date | null
  heartbeatAt: Date
  results: unknown
  error: string | null
}

const minutes = Number(process.env.RAG_RUN_STALE_MINUTES)
/** No heartbeat for this long means the job is dead. Heartbeats come from a
 * timer every HEARTBEAT_MS, independent of how long one file takes. */
export const RUN_STALE_MS = (Number.isFinite(minutes) && minutes >= 2 ? minutes : 10) * 60_000
const HEARTBEAT_MS = 60_000

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
type Db = typeof prisma | Tx

// The two run tables have identical shapes; this keeps the rest of the file
// free of per-table branching.
function table(db: Db, kind: RunKind) {
  const d = (kind === 'bylaws' ? db.bylawsReindexRun : db.nasReindexRun) as unknown as {
    findFirst(a: object): Promise<RunRow | null>
    findUnique(a: object): Promise<RunRow | null>
    create(a: object): Promise<RunRow>
    updateMany(a: object): Promise<{ count: number }>
  }
  return d
}

export function isStale(run: Pick<RunRow, 'status' | 'heartbeatAt'>, now = Date.now()): boolean {
  return run.status === 'RUNNING' && now - run.heartbeatAt.getTime() > RUN_STALE_MS
}

/**
 * Return the org's live run if there is one, otherwise create a new one.
 * `started` tells the caller whether to launch the background job.
 */
export async function startRun(kind: RunKind, organizationId: string): Promise<{ run: RunRow; started: boolean }> {
  return prisma.$transaction(async (tx) => {
    // Serialises concurrent requests for the same org + pipeline; released at
    // commit. $executeRaw, not $queryRaw: the function returns `void`, which
    // Prisma cannot deserialise as a result column.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rag-reindex:${kind}:${organizationId}`}))`
    const t = table(tx, kind)
    const running = await t.findFirst({ where: { organizationId, status: 'RUNNING' }, orderBy: { startedAt: 'desc' } })
    if (running && !isStale(running)) return { run: running, started: false }
    if (running) {
      await t.updateMany({
        where: { id: running.id, organizationId, status: 'RUNNING' },
        data: {
          status: 'FAILED', finishedAt: new Date(),
          error: `interrupted: no progress since ${running.heartbeatAt.toISOString()} (the server most likely restarted); a new run was started`,
        },
      })
    }
    const run = await t.create({ data: { organizationId } })
    return { run, started: true }
  })
}

/** Status as shown to an admin. A RUNNING run that has gone stale is reported
 * as interrupted even before the next start request marks it FAILED. */
export function runView(run: RunRow) {
  const stale = isStale(run)
  return {
    runId: run.id,
    status: stale ? 'interrupted' : run.status.toLowerCase(),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastProgressAt: run.heartbeatAt,
    results: run.results ?? [],
    error: stale ? 'no progress for a while; the server most likely restarted. Start the backfill again.' : run.error,
  }
}

export async function getRun(kind: RunKind, organizationId: string, runId: string | null): Promise<RunRow | null> {
  const t = table(prisma, kind)
  const run = runId
    ? await t.findUnique({ where: { id: runId } })
    : await t.findFirst({ where: { organizationId }, orderBy: { startedAt: 'desc' } })
  return run && run.organizationId === organizationId ? run : null
}

/**
 * Keeps a run alive while its job works, and tells the job when to stop.
 * Every write is conditional on the run still being RUNNING: if it was taken
 * over as interrupted, `cancelled()` turns true and the job should return.
 * Writes name the org explicitly rather than relying on the request context
 * having survived into the detached job and its timer.
 */
export function trackRun(kind: RunKind, runId: string, organizationId: string) {
  let cancelled = false
  const touch = async (data: Record<string, unknown> = {}) => {
    const { count } = await table(prisma, kind).updateMany({
      where: { id: runId, organizationId, status: 'RUNNING' },
      data: { ...data, heartbeatAt: new Date() },
    })
    if (count === 0) cancelled = true
  }
  const timer = setInterval(() => { touch().catch(() => {}) }, HEARTBEAT_MS)
  timer.unref?.()
  return {
    cancelled: () => cancelled,
    progress: (results: unknown) => touch({ results }).catch(() => {}),
    async finish(status: 'DONE' | 'FAILED', data: { results?: unknown; error?: string }) {
      clearInterval(timer)
      await table(prisma, kind).updateMany({
        where: { id: runId, organizationId, status: 'RUNNING' },
        data: { ...data, status, finishedAt: new Date(), heartbeatAt: new Date() },
      }).catch(() => {})
    },
    stop: () => clearInterval(timer),
  }
}
