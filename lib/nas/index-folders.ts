/**
 * Scope for the general-NAS content index — which folders get backfilled
 * (app/api/nas/reindex) and swept for staleness (app/api/cron/rag-stale-sweep).
 * Indexing the whole NAS (~327k files) is too much for the free HuggingFace/
 * Qdrant tiers, so an admin opts specific folders in here instead.
 */
export interface IndexFolder {
  server: string
  path: string
}

/** NAS_INDEX_FOLDERS: comma-separated "server:/path" pairs, e.g.
 * "WD:/01 ARCHITECTURE,WD:/Anjana". Unset/empty disables the general-NAS
 * backfill and sweep entirely — files uploaded through Forge still index as
 * they always have, this only controls the opt-in bulk backfill of files
 * already on the NAS. */
export function parseIndexFolders(): IndexFolder[] {
  const raw = process.env.NAS_INDEX_FOLDERS?.trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(':')
      if (i === -1) throw new Error(`NAS_INDEX_FOLDERS entry "${entry}" is missing the "server:/path" colon`)
      return { server: entry.slice(0, i).trim(), path: entry.slice(i + 1).trim() || '/' }
    })
}

/** Keep folders small enough to crawl in full. A sweep that only partially
 * lists a folder (hitting this cap) must NOT prune files past the cap — they
 * were never confirmed absent, just not reached — so this is set well above
 * what a reasonably scoped "specific folder" should ever contain, rather
 * than the ~2000-file default sized for the small bylaws folder. */
export const INDEX_FOLDER_MAX_FILES = Number(process.env.NAS_INDEX_MAX_FILES ?? 20_000)
