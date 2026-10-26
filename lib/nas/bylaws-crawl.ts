/**
 * Locates the bylaws folder ("Trijya Projects / utility data") on a NAS drive
 * and lists every file under it (recursively) — used by the upload-time
 * auto-route check, the admin backfill, the nightly bylaws sync and the stale
 * sweep. Everything under "utility data" is bylaws material: By_Laws (with
 * per-state subfolders such as MDDA UTTARAKHAND), G. O (government orders)
 * and loose bylaws PDFs. Folder-name matching is loose (case/space/
 * underscore/hyphen-insensitive) since the exact spelling on disk isn't
 * guaranteed, and no server label is hardcoded — whichever drive has the
 * folder is used.
 *
 * Keep in step with BYLAWS in scripts/nas-connector/nas_indexer.py: the
 * TRIJYA-3 whole-NAS indexer leaves exactly these paths to this pipeline.
 */
import { nasList } from './client'

// "Trijya Projects" is the NAME OF THE SMB SHARE, not a folder inside it. In
// Windows Explorer the share looks like a folder (\\NAS\Trijya Projects\...),
// but the connector serves paths RELATIVE to the share root, so the real path
// is "/utility data". It is an OPTIONAL leading segment, so the matcher still
// works if the folder is ever nested under one of that name.
const SHARE_SEGMENT = /^trijya[\s_-]*projects?$/i
// Until Oct 2026 only "utility data/By_Laws" counted, and bylaws elsewhere in
// "utility data" (G. O, "Parking by laws for 99 sq. mt. plot area.pdf") went
// to the general NAS index, which bylaws answers never search.
const REQUIRED_SEGMENTS: RegExp[] = [/^utility[\s_-]*data$/i]

/** Not documents: software installers and drivers copied onto the NAS. Same
 * folders the TRIJYA-3 indexer skips (JUNK_DIR in nas_indexer.py). */
const JUNK_DIR = /^(softwares?|drivers?|.*\bdriver\b.*|setup|installers?|program files.*|appdata|x64|x86|_?getintopc.*|libraries)$/i

/** Files listed per crawl at most; `listingComplete: false` reports a cut-off. */
const MAX_FILES = Number(process.env.BYLAWS_MAX_FILES ?? 5000)

/**
 * True if `path` (forward-slash NAS path) is inside the bylaws folder, on any
 * server: "utility data" at the share root, or under a "Trijya Projects"
 * folder there. Anchored at the root, like findBylawsFolder, so a project
 * folder that happens to be called "utility data" is not bylaws.
 */
export function isBylawsPath(path: string): boolean {
  const segments = path.split('/').filter(Boolean)
  const start = segments[0] && SHARE_SEGMENT.test(segments[0]) ? 1 : 0
  return REQUIRED_SEGMENTS.every((pattern, j) => segments[start + j] !== undefined && pattern.test(segments[start + j]!))
}

async function findChildDir(server: string, parent: string, pattern: RegExp): Promise<string | null> {
  let listing: Awaited<ReturnType<typeof nasList>>
  try {
    listing = await nasList(server, parent)
  } catch {
    return null // server unreachable / path doesn't exist
  }
  const match = listing.items.find((i) => i.isDir && pattern.test(i.name))
  return match ? `${parent.replace(/\/$/, '')}/${match.name}` : null
}

/** Walk from the drive root, matching one folder per path segment. Returns the
 * bylaws folder's full path on this server, or null if it isn't present there.
 * Tries the share root first (the real layout), then under an optional
 * "Trijya Projects" folder in case a drive does nest it that way. */
export async function findBylawsFolder(server: string): Promise<string | null> {
  const nested = await findChildDir(server, '/', SHARE_SEGMENT)
  for (const start of nested ? ['/', nested] : ['/']) {
    let currentPath: string | null = start
    for (const pattern of REQUIRED_SEGMENTS) {
      currentPath = await findChildDir(server, currentPath, pattern)
      if (!currentPath) break
    }
    if (currentPath) return currentPath
  }
  return null
}

export interface NasFileEntry {
  path: string
  /** Size in bytes, as reported by the NAS listing. Used to skip oversized
   * files BEFORE downloading them, rather than after. */
  size: number
}

/** Recursively list every file (not folder) under `folder` on `server`. */
export async function listFilesRecursive(server: string, folder: string, maxFiles = MAX_FILES): Promise<NasFileEntry[]> {
  return (await listFilesRecursiveWithStatus(server, folder, maxFiles)).files
}

/**
 * Same crawl, plus whether it reached the end. `complete` is false when the
 * maxFiles cap stopped it with folders still unvisited: anything not listed
 * may still exist, so a caller must not treat "not listed" as "deleted".
 * A listing error throws (never a silently partial result).
 */
export async function listFilesRecursiveWithStatus(
  server: string,
  folder: string,
  maxFiles = MAX_FILES,
): Promise<{ files: NasFileEntry[]; complete: boolean }> {
  const files: NasFileEntry[] = []
  const queue: string[] = [folder]
  let complete = true
  while (queue.length > 0) {
    if (files.length >= maxFiles) { complete = false; break }
    const dir = queue.shift()!
    const { items } = await nasList(server, dir)
    for (const item of items) {
      const itemPath = `${dir.replace(/\/$/, '')}/${item.name}`
      if (item.isDir) {
        if (!JUNK_DIR.test(item.name)) queue.push(itemPath)
      }
      else files.push({ path: itemPath, size: Number(item.size) || 0 })
    }
  }
  // The last folder listed can push past the cap; anything past it is not
  // returned, so the crawl did not cover everything.
  if (files.length > maxFiles) { files.length = maxFiles; complete = false }
  return { files, complete }
}
