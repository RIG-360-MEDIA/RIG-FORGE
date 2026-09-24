/**
 * Locates the "Trijya Projects / utility data / By_Laws" folder on a NAS
 * drive and lists every file under it (recursively) — used both by the
 * upload-time auto-route check and the admin backfill route. Folder-name
 * matching is loose (case/space/underscore/hyphen-insensitive) since the
 * exact spelling on disk isn't guaranteed, and no server label is hardcoded —
 * whichever drive happens to have the folder is used.
 */
import { nasList } from './client'

// Each entry matches one path segment, in order, from the drive root down to
// the bylaws folder itself.
const PATH_SEGMENT_PATTERNS: RegExp[] = [
  /^trijya[\s_-]*projects$/i,
  /^utility[\s_-]*data$/i,
  /^by[\s_-]*laws$/i,
]

/** True if `path` (forward-slash NAS path) is inside the bylaws folder, on any server. */
export function isBylawsPath(path: string): boolean {
  const segments = path.split('/').filter(Boolean)
  for (let i = 0; i + PATH_SEGMENT_PATTERNS.length <= segments.length; i++) {
    if (PATH_SEGMENT_PATTERNS.every((pattern, j) => pattern.test(segments[i + j]!))) return true
  }
  return false
}

/** Walk from the drive root, matching one folder per path segment. Returns the
 * bylaws folder's full path on this server, or null if it isn't present there. */
export async function findBylawsFolder(server: string): Promise<string | null> {
  let currentPath = '/'
  for (const pattern of PATH_SEGMENT_PATTERNS) {
    let listing: Awaited<ReturnType<typeof nasList>>
    try {
      listing = await nasList(server, currentPath)
    } catch {
      return null // server unreachable / path doesn't exist
    }
    const match = listing.items.find((i) => i.isDir && pattern.test(i.name))
    if (!match) return null
    currentPath = `${currentPath.replace(/\/$/, '')}/${match.name}`
  }
  return currentPath
}

/** Recursively list every file (not folder) path under `folder` on `server`. */
export async function listFilesRecursive(server: string, folder: string, maxFiles = 2000): Promise<string[]> {
  const files: string[] = []
  const queue: string[] = [folder]
  while (queue.length > 0 && files.length < maxFiles) {
    const dir = queue.shift()!
    const { items } = await nasList(server, dir)
    for (const item of items) {
      const itemPath = `${dir.replace(/\/$/, '')}/${item.name}`
      if (item.isDir) queue.push(itemPath)
      else files.push(itemPath)
    }
  }
  return files
}
