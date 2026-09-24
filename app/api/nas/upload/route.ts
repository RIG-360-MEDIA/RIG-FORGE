import { type NextRequest } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isNasEnabled, nasUpload } from '@/lib/nas/client'
import { isBylawsPath } from '@/lib/nas/bylaws-crawl'
import { getOrgId } from '@/lib/tenant-context'
import { indexNasFile, isRagIndexingEnabled } from '@/lib/rag/index-nas-file'
import { indexBylawsFile, isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'

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
    if (inBylawsFolder && isBylawsIndexingEnabled()) {
      const organizationId = getOrgId()
      file
        .arrayBuffer()
        .then((buf) => indexBylawsFile(organizationId, server, fullPath, Buffer.from(buf)))
        .catch((e) => console.error('[bylaws-rag] indexing failed:', e))
    } else if (!inBylawsFolder && isRagIndexingEnabled()) {
      const organizationId = getOrgId()
      // Fire-and-forget — don't make the uploader wait on embedding/indexing.
      file
        .arrayBuffer()
        .then((buf) => indexNasFile(organizationId, server, fullPath, Buffer.from(buf)))
        .catch((e) => console.error('[nas-rag] indexing failed:', e))
    }
    return successResponse(res)
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : 'NAS upload failed', 502)
  }
}
