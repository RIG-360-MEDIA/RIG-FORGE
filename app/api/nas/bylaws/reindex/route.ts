import { type NextRequest, NextResponse } from 'next/server'

import { isAdminRole } from '@/lib/auth'
import { authenticateActive } from '@/lib/authz'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { getOrgId } from '@/lib/tenant-context'
import { isNasEnabled, nasServers, nasFetchBytesStrict, FileTooLargeError } from '@/lib/nas/client'
import { findBylawsFolder, listFilesRecursive } from '@/lib/nas/bylaws-crawl'
import { isExtractable } from '@/lib/nas/extract'
import { indexBylawsFile, isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { MAX_INDEX_BYTES } from '@/lib/rag/index-core'

export const runtime = 'nodejs'
export const maxDuration = 280

interface ServerResult {
  server: string
  folder: string
  filesFound: number
  indexed: number
  unchanged: number
  skippedNotExtractable: number
  skippedTooLarge: number
  failed: number
  /** First few failures with their reasons, so an admin can see WHY. */
  failures: Array<{ path: string; reason: string }>
}

// POST /api/nas/bylaws/reindex — admin-only. Finds the bylaws folder
// ("utility data/By_Laws" at the root of a NAS share) on every drive and
// (re)indexes every extractable file into the separate bylaws Qdrant
// collection. Safe to re-run any time — unchanged files are skipped by
// content hash, so a run that is interrupted can simply be started again.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await authenticateActive(request)
    if (!payload) return errorResponse('Authentication required', 401)
    if (!isAdminRole(payload.role)) return errorResponse('Admin access required', 403)
    if (!isNasEnabled()) return errorResponse('NAS is not available', 403)
    if (!isBylawsIndexingEnabled()) return errorResponse('Bylaws content search is not configured (HF_API_KEY/QDRANT_URL unset)', 503)

    const organizationId = getOrgId()
    const servers = await nasServers()
    const results: ServerResult[] = []

    for (const s of servers) {
      const folder = await findBylawsFolder(s.label)
      if (!folder) continue

      const files = await listFilesRecursive(s.label, folder)
      const result: ServerResult = {
        server: s.label, folder, filesFound: files.length,
        indexed: 0, unchanged: 0, skippedNotExtractable: 0, skippedTooLarge: 0, failed: 0, failures: [],
      }
      const noteFailure = (path: string, reason: string) => {
        result.failed++
        if (result.failures.length < 20) result.failures.push({ path, reason })
      }

      for (const file of files) {
        const name = file.path.split('/').filter(Boolean).pop() || file.path
        if (!isExtractable(name)) {
          result.skippedNotExtractable++
          continue
        }
        // Decide from the LISTED size, before downloading. The old route
        // downloaded every file in full — a 245 MB PDF on a 512 MB instance —
        // and then cut it at 8 MB, which corrupts a PDF beyond parsing.
        if (file.size > MAX_INDEX_BYTES) {
          result.skippedTooLarge++
          if (result.failures.length < 20) {
            result.failures.push({ path: file.path, reason: `${(file.size / 1_048_576).toFixed(1)} MB, over the ${(MAX_INDEX_BYTES / 1_048_576).toFixed(0)} MB limit (RAG_MAX_FILE_MB)` })
          }
          continue
        }
        try {
          const bytes = await nasFetchBytesStrict(s.label, file.path, MAX_INDEX_BYTES)
          // indexBylawsFile never throws — it reports what happened. The old
          // route counted every call as "indexed", even ones that had failed.
          const outcome = await indexBylawsFile(organizationId, s.label, file.path, bytes)
          if (outcome.status === 'indexed') result.indexed++
          else if (outcome.status === 'unchanged') result.unchanged++
          else if (outcome.status === 'skipped') result.skippedNotExtractable++
          else noteFailure(file.path, outcome.reason)
        } catch (e) {
          if (e instanceof FileTooLargeError) result.skippedTooLarge++
          else noteFailure(file.path, e instanceof Error ? e.message : 'download failed')
        }
      }
      results.push(result)
    }

    if (results.length === 0) {
      return successResponse({
        message: 'No "utility data/By_Laws" folder found on any NAS drive.',
        results: [],
      })
    }
    return successResponse({ results })
  } catch (error) {
    console.error('[POST /api/nas/bylaws/reindex]', error)
    return errorResponse('Server error', 500)
  }
}
