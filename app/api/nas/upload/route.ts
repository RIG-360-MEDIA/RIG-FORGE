import { type NextRequest } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isNasEnabled, nasUpload } from '@/lib/nas/client'
import { isBylawsPath } from '@/lib/nas/bylaws-crawl'
import { isExtractable } from '@/lib/nas/extract'
import { getOrgId } from '@/lib/tenant-context'
import { indexNasFile, isRagIndexingEnabled, markNasPending } from '@/lib/rag/index-nas-file'
import { indexBylawsFile, isBylawsIndexingEnabled, markBylawsPending } from '@/lib/rag/index-bylaws-file'

export const runtime = 'nodejs'
// Allow large-ish uploads (drawings/PDFs). Next caps body at 4MB by default for
// route handlers only via config; App Router streams FormData so this is fine.
export const maxDuration = 120

// POST /api/nas/upload?server=WD&path=/folder  (multipart form, field "file")
export async function POST(request: NextRequest) {
  const token = getTokenFromCookies(request)
  if (!token) return errorResponse('Authentication required', 401)
  if (!verifyToken(token)) return errorResponse('Invalid or expired session', 401)
  if (!isNasEnabled()) return errorResponse('NAS is not available', 403)

  const { searchParams } = new URL(request.url)
  const server = searchParams.get('server')
  const path = searchParams.get('path') || '/'
  if (!server) return errorResponse('server is required', 400)

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return errorResponse('Expected multipart form data', 400)
  }
  const file = form.get('file')
  if (!(file instanceof File)) return errorResponse('file field is required', 400)

  try {
    const res = await nasUpload(server, path, file, file.name)
    const fullPath = `${path.replace(/\/$/, '')}/${file.name}`
    const inBylawsFolder = isBylawsPath(fullPath)

    // Bylaws files go ONLY into the separate bylaws index, never the general
    // one — keeps the two RAG pipelines fully independent (see lib/rag/index-bylaws-file.ts).
    // The indexers report failures as a returned outcome rather than by
    // throwing, so log those explicitly — otherwise a failed index would only
    // be visible in the tracking table, never in the server logs.
    const report = (tag: string) => (outcome: Awaited<ReturnType<typeof indexNasFile>>) => {
      if (outcome.status === 'failed') console.warn(`[${tag}] ${fullPath}: ${outcome.reason}`)
      else if (outcome.status === 'indexed' && outcome.warning) console.warn(`[${tag}] ${fullPath}: ${outcome.warning}`)
    }
    // Only files the indexer can actually read are tracked. A photo, DWG or
    // video would otherwise get a PENDING row that nothing ever resolves (the
    // indexer skips them without writing), and the retry cron would re-fetch
    // those same files every run.
    const indexable = isExtractable(file.name)
    if (indexable && inBylawsFolder && isBylawsIndexingEnabled()) {
      const organizationId = getOrgId()
      // Write a PENDING row BEFORE the detached chain starts: if Render
      // restarts mid-index, this leaves a real row for the retry queue
      // (app/api/cron/rag-retry) to pick up, instead of no row at all.
      await markBylawsPending(organizationId, server, fullPath).catch(() => {})
      file
        .arrayBuffer()
        .then((buf) => indexBylawsFile(organizationId, server, fullPath, Buffer.from(buf)))
        .then(report('bylaws-rag'))
        .catch((e) => console.error('[bylaws-rag] indexing failed:', e))
    } else if (indexable && !inBylawsFolder && isRagIndexingEnabled()) {
      const organizationId = getOrgId()
      await markNasPending(organizationId, server, fullPath).catch(() => {})
      // Fire-and-forget — don't make the uploader wait on embedding/indexing.
      file
        .arrayBuffer()
        .then((buf) => indexNasFile(organizationId, server, fullPath, Buffer.from(buf)))
        .then(report('nas-rag'))
        .catch((e) => console.error('[nas-rag] indexing failed:', e))
    }
    return successResponse(res)
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : 'NAS upload failed', 502)
  }
}
