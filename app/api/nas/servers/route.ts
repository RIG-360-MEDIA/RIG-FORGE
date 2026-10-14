import { type NextRequest } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isNasEnabled, nasServerStatus } from '@/lib/nas/client'

// GET /api/nas/servers — list configured NAS units (Trijya only). Also the
// signal the Workspace uses to decide whether to show the Files tab.
//
// "reachable" means the NAS itself answers (the connector tried an SMB connect),
// not just that the connector process is up. `servers` lists only the NAS units
// that answer, so the Files tab never opens on a dead drive; the others are in
// `unreachableServers`.
export async function GET(request: NextRequest) {
  const token = getTokenFromCookies(request)
  if (!token) return errorResponse('Authentication required', 401)
  if (!verifyToken(token)) return errorResponse('Invalid or expired session', 401)
  if (!isNasEnabled()) return successResponse({ enabled: false, reachable: false, servers: [] })
  try {
    const all = await nasServerStatus()
    const up = all.filter((s) => s.reachable)
    const down = all.filter((s) => !s.reachable)
    if (down.length) console.warn('[GET /api/nas/servers] unreachable:', down.map((s) => s.error ?? s.label).join('; '))
    return successResponse({
      enabled: true,
      reachable: up.length > 0,
      servers: up.map(({ label }) => ({ label })),
      unreachableServers: down.map(({ label }) => label),
      ...(up.length === 0 && { error: 'The NAS is not responding' }),
    })
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
