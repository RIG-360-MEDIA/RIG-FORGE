/**
 * Retry queue for the two RAG tracking tables (see app/api/cron/rag-retry).
 *
 * Picks FAILED rows, and PENDING rows whose indexing was interrupted (a
 * Render restart mid-index), and tries them again with exponential backoff.
 *
 * Rules that keep it from clogging or looping:
 *  - Every attempt is CLAIMED first (retryCount bumped, nextRetryAt pushed
 *    out) with an optimistic check on retryCount, so two overlapping cron runs
 *    never process the same row, and a row is never picked again before its
 *    backoff is over, whatever the outcome.
 *  - After RAG_RETRY_MAX_ATTEMPTS attempts a row is left alone: it stays
 *    FAILED with its reason, visible, but no longer re-downloaded.
 *  - A file confirmed gone from the NAS (its folder lists fine and it is not
 *    there) has its chunks removed and its row deleted. A folder that cannot
 *    be listed is NOT treated as gone: the connector may just be down.
 *  - A row for a file type the indexer can never read is deleted.
 *  - Each run stops starting new files after RAG_RETRY_TIME_BUDGET_SECONDS, so
 *    a slow connector cannot make one run overlap the next indefinitely.
 */
import { prisma } from '@/lib/db'
import { nasList } from '@/lib/nas/client'
import { isExtractable } from '@/lib/nas/extract'
import { fetchAndIndexFile } from './fetch-and-index'
import { indexBylawsFile } from './index-bylaws-file'
import { indexNasFile } from './index-nas-file'
import { pruneStaleChunks, BYLAWS_COLLECTION, COLLECTION } from './qdrant'

const num = (v: string | undefined, fallback: number, min: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export const RETRY_BATCH_SIZE = Math.floor(num(process.env.RAG_RETRY_BATCH_SIZE, 20, 1))
export const RETRY_MAX_ATTEMPTS = Math.floor(num(process.env.RAG_RETRY_MAX_ATTEMPTS, 6, 1))
/** A PENDING row older than this was written right before a fire-and-forget
 * index that never finished. Generous, because a large file waiting behind a
 * HuggingFace rate limit can legitimately take many minutes. */
export const STUCK_PENDING_MS = num(process.env.RAG_RETRY_STUCK_MINUTES, 30, 1) * 60_000
const TIME_BUDGET_MS = num(process.env.RAG_RETRY_TIME_BUDGET_SECONDS, 240, 10) * 1000

const BASE_DELAY_MS = 15 * 60_000
const MAX_DELAY_MS = 24 * 60 * 60_000

/** Wait before attempt number `attempt + 1`, given `attempt` attempts so far
 * (1-based): 15 min, 1 h, 4 h, 16 h, then 24 h. */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 4 ** (n - 1))
}

export interface RetryRow {
  id: string
  organizationId: string
  server: string
  path: string
  status: string
  retryCount: number
}

interface Table {
  label: 'nas' | 'bylaws'
  collection: string
  indexer: typeof indexNasFile
  findDue(now: Date, take: number): Promise<RetryRow[]>
  claim(row: RetryRow, nextRetryAt: Date): Promise<boolean>
  remove(id: string): Promise<void>
  markFailed(id: string, reason: string): Promise<void>
}

const SELECT = { id: true, organizationId: true, server: true, path: true, status: true, retryCount: true } as const

function dueWhere(now: Date) {
  return {
    retryCount: { lt: RETRY_MAX_ATTEMPTS },
    AND: [
      { OR: [{ status: 'FAILED' as const }, { status: 'PENDING' as const, updatedAt: { lt: new Date(now.getTime() - STUCK_PENDING_MS) } }] },
      { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
    ],
  }
}
const DUE_ORDER = [{ nextRetryAt: { sort: 'asc' as const, nulls: 'first' as const } }, { updatedAt: 'asc' as const }]

const TABLES: Table[] = [
  {
    label: 'nas', collection: COLLECTION, indexer: indexNasFile,
    findDue: (now, take) => prisma.nasIndexedFile.findMany({ where: dueWhere(now), orderBy: DUE_ORDER, take, select: SELECT }),
    claim: async (row, nextRetryAt) => (await prisma.nasIndexedFile.updateMany({
      where: { id: row.id, retryCount: row.retryCount },
      data: { retryCount: { increment: 1 }, nextRetryAt },
    })).count === 1,
    remove: async (id) => { await prisma.nasIndexedFile.deleteMany({ where: { id } }) },
    markFailed: async (id, reason) => { await prisma.nasIndexedFile.updateMany({ where: { id }, data: { status: 'FAILED', error: reason.slice(0, 500) } }) },
  },
  {
    label: 'bylaws', collection: BYLAWS_COLLECTION, indexer: indexBylawsFile,
    findDue: (now, take) => prisma.bylawsIndexedFile.findMany({ where: dueWhere(now), orderBy: DUE_ORDER, take, select: SELECT }),
    claim: async (row, nextRetryAt) => (await prisma.bylawsIndexedFile.updateMany({
      where: { id: row.id, retryCount: row.retryCount },
      data: { retryCount: { increment: 1 }, nextRetryAt },
    })).count === 1,
    remove: async (id) => { await prisma.bylawsIndexedFile.deleteMany({ where: { id } }) },
    markFailed: async (id, reason) => { await prisma.bylawsIndexedFile.updateMany({ where: { id }, data: { status: 'FAILED', error: reason.slice(0, 500) } }) },
  },
]

type Location = { state: 'present'; size: number } | { state: 'gone' } | { state: 'unknown'; reason: string }

/** Where a tracked file stands on the NAS right now. "gone" only when its
 * folder lists successfully and the file is not in it. */
export async function locate(server: string, path: string): Promise<Location> {
  const name = path.split('/').filter(Boolean).pop()
  if (!name) return { state: 'unknown', reason: 'not a file path' }
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  let items: Awaited<ReturnType<typeof nasList>>['items']
  try {
    items = (await nasList(server, dir)).items
  } catch (e) {
    return { state: 'unknown', reason: e instanceof Error ? e.message : 'listing failed' }
  }
  const hit = items.find((i) => i.name === name)
  if (!hit || hit.isDir) return { state: 'gone' }
  return { state: 'present', size: Number(hit.size) || 0 }
}

export interface RetryTally {
  attempted: number
  indexed: number
  unchanged: number
  failed: number
  skipped: number
  removedGone: number
  removedUnreadable: number
  unreachable: number
  /** Due rows left for the next run because this run's time budget ran out. */
  deferred: number
}

async function retryOne(t: Table, row: RetryRow, tally: RetryTally): Promise<void> {
  const name = row.path.split('/').filter(Boolean).pop() || row.path
  const dropFromIndex = async (): Promise<boolean> => {
    try {
      await pruneStaleChunks(row.organizationId, row.server, row.path, 0, t.collection)
    } catch {
      return false // Qdrant unreachable: keep the row so the chunks are not orphaned; retried after backoff
    }
    await t.remove(row.id)
    return true
  }

  if (!isExtractable(name)) {
    if (await dropFromIndex()) tally.removedUnreadable++
    return
  }

  const loc = await locate(row.server, row.path)
  if (loc.state === 'gone') {
    if (await dropFromIndex()) tally.removedGone++
    return
  }
  if (loc.state === 'unknown') {
    tally.unreachable++
    // An interrupted PENDING row becomes FAILED with the real reason, so it
    // does not read as "indexing in progress" forever.
    if (row.status === 'PENDING') await t.markFailed(row.id, `could not check the file on the NAS: ${loc.reason}`)
    return
  }

  tally.attempted++
  const outcome = await fetchAndIndexFile({
    organizationId: row.organizationId, server: row.server, path: row.path, size: loc.size, indexer: t.indexer,
  })
  if (outcome.status === 'indexed') tally.indexed++
  else if (outcome.status === 'unchanged') tally.unchanged++
  else if (outcome.status === 'failed') {
    tally.failed++
    // The returned reason can be fuller than what the indexer stored (e.g. a
    // scanned PDF whose connector OCR also failed), so keep the row's in step.
    await t.markFailed(row.id, outcome.reason)
  } else {
    // skipped (e.g. too large and the connector could not extract it): the
    // indexer never wrote, so record why here. Backoff is already applied.
    tally.skipped++
    await t.markFailed(row.id, outcome.reason)
  }
}

/** One pass over both tables. Call inside the NAS org's context. */
export async function runRetryQueue(now = new Date()): Promise<Record<'nas' | 'bylaws', RetryTally>> {
  const deadline = Date.now() + TIME_BUDGET_MS
  const out = {} as Record<'nas' | 'bylaws', RetryTally>
  for (const t of TABLES) {
    const tally: RetryTally = { attempted: 0, indexed: 0, unchanged: 0, failed: 0, skipped: 0, removedGone: 0, removedUnreadable: 0, unreachable: 0, deferred: 0 }
    out[t.label] = tally
    const rows = await t.findDue(now, RETRY_BATCH_SIZE)
    for (const [i, row] of rows.entries()) {
      if (Date.now() >= deadline) { tally.deferred = rows.length - i; break }
      // Claim before doing anything slow: pushes nextRetryAt out, so neither an
      // overlapping run nor the next one picks this row before its backoff ends.
      const claimed = await t.claim(row, new Date(Date.now() + retryDelayMs(row.retryCount + 1)))
      if (!claimed) continue
      try {
        await retryOne(t, row, tally)
      } catch (e) {
        tally.failed++
        console.error(`[rag-retry] ${t.label} ${row.path}:`, e instanceof Error ? e.message : e)
      }
    }
  }
  return out
}
