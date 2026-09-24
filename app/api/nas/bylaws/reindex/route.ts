import { type NextRequest, NextResponse } from 'next/server'

import { isAdminRole } from '@/lib/auth'
import { authenticateActive } from '@/lib/authz'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { getOrgId } from '@/lib/tenant-context'
import { isNasEnabled, nasServers, nasFetchBytes } from '@/lib/nas/client'
import { findBylawsFolder, listFilesRecursive } from '@/lib/nas/bylaws-crawl'
import { isExtractable } from '@/lib/nas/extract'
import { indexBylawsFile, isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'

export const runtime = 'nodejs'
export const maxDuration = 280

interface ServerResult {
  server: string
  folder: string
  filesFound: number
  indexed: number
  skippedNotExtractable: number
  failed: number
}

// POST /api/nas/bylaws/reindex — admin-only. Crawls every NAS drive for the
// "Trijya Projects/utility data/By_Laws" folder (wherever it happens to live)
// and (re)indexes every extractable file found into the separate bylaws
// Qdrant collection. Safe to re-run any time — unchanged files are skipped
// (see indexBylawsFile's content-hash check).
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

      const filePaths = await listFilesRecursive(s.label, folder)
      const result: ServerResult = {
        server: s.label, folder, filesFound: filePaths.length,
        indexed: 0, skippedNotExtractable: 0, failed: 0,
      }

      for (const filePath of filePaths) {
        const name = filePath.split('/').filter(Boolean).pop() || filePath
        if (!isExtractable(name)) {
          result.skippedNotExtractable++
          continue
        }
        try {
          const bytes = await nasFetchBytes(s.label, filePath)
          await indexBylawsFile(organizationId, s.label, filePath, bytes)
          result.indexed++
        } catch {
          result.failed++
        }
      }
      results.push(result)
    }

    if (results.length === 0) {
      return successResponse({
        message: 'No "Trijya Projects/utility data/By_Laws" folder found on any NAS drive.',
        results: [],
      })
    }
    return successResponse({ results })
  } catch (error) {
    console.error('[POST /api/nas/bylaws/reindex]', error)
    return errorResponse('Server error', 500)
  }
}
