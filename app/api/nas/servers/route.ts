import { type NextRequest } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isNasEnabled, nasServers } from '@/lib/nas/client'

// GET /api/nas/servers — list configured NAS units (Trijya only). Also the
// signal the Workspace uses to decide whether to show the Files tab.
export async function GET(request: NextRequest) {
  const token = getTokenFromCookies(request)
  if (!token) return errorResponse('Authentication required', 401)
  if (!verifyToken(token)) return errorResponse('Invalid or expired session', 401)
  if (!isNasEnabled()) return successResponse({ enabled: false, reachable: false, servers: [] })
  try {
    const servers = await nasServers()
    return successResponse({ enabled: true, reachable: true, servers })
  } catch (e) {
    // NAS is configured for this org but the storage server / Cloudflare Tunnel
    // is not responding (e.g. the on-prem box or connector is down). Return 200
    // with reachable:false — NOT a 502 — so the client keeps the Files tab and
    // shows a clear "unreachable" state instead of hiding the feature entirely.
    return successResponse({
      enabled: true,
      reachable: false,
      servers: [],
      error: e instanceof Error ? e.message : 'NAS unavailable',
    })
  }
}
