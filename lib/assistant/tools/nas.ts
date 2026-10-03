/**
 * Forgie NAS tools — let the assistant browse, search, and READ files on the
 * Trijya office NAS units (via the connector at TRIJYA_NAS_BASE_URL). Gated by
 * isNasEnabled() so only the NAS-owning org (Trijya) ever gets them. Read
 * supports text + spreadsheets today; other binaries return metadata.
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import { isNasEnabled, nasList, nasSearch, nasServers, nasFetchBytes } from '@/lib/nas/client'
import { extractText } from '@/lib/nas/extract'
import { getOrgId } from '@/lib/tenant-context'
import { isRagIndexingEnabled } from '@/lib/rag/index-nas-file'
import { embedQuery } from '@/lib/rag/embeddings'
import { searchChunksHybrid } from '@/lib/rag/qdrant'

export function buildNasTools(): ToolSet {
  return {
    nas_list: tool({
      description:
        'List folders and files in a directory on a Trijya NAS drive. Use to browse project files. `server` is a NAS label (omit to list the available NAS drives). `path` defaults to the root "/".',
      inputSchema: z.object({
        server: z.string().optional().describe('NAS label, e.g. "WD" or "Seagate". Omit to list drives.'),
        path: z.string().optional().describe('Folder path, e.g. "/01 ARCHITECTURE". Defaults to "/".'),
      }),
      execute: async ({ server, path }) => {
        if (!isNasEnabled()) return { error: 'NAS not available' }
        try {
          if (!server) {
            const servers = await nasServers()
            return { drives: servers.map((s) => s.label), hint: 'Call nas_list again with a server to browse it.' }
          }
          const r = await nasList(server, path || '/')
          return {
            server,
            path: r.path,
            items: r.items.slice(0, 100).map((i) => ({ name: i.name, type: i.isDir ? 'folder' : 'file', size: i.size })),
          }
        } catch (e) {
          return { error: e instanceof Error ? e.message : 'list failed' }
        }
      },
    }),

    nas_search: tool({
      description:
        'Search the Trijya NAS for files/folders whose NAME contains the query. Searches all NAS drives if `server` is omitted. Use sort="latest" for "the newest/latest <thing>" questions, and `days` to limit to recently-changed files. Each match includes its modified date. Follow up with nas_read to read a file.',
      inputSchema: z.object({
        query: z.string().describe('Filename text to search for, e.g. "windlass" or "survey drawing".'),
        server: z.string().optional().describe('Restrict to one NAS label; omit to search all.'),
        folder: z.string().optional().describe('Only search inside this folder path, e.g. "/01 ARCHITECTURE".'),
        sort: z
          .enum(['relevance', 'latest', 'oldest', 'largest'])
          .optional()
          .describe('Order of results. Use "latest" for newest-first (e.g. "latest survey drawings").'),
        days: z.number().optional().describe('Only files modified in the last N days.'),
      }),
      execute: async ({ query, server, folder, sort, days }) => {
        if (!isNasEnabled()) return { error: 'NAS not available' }
        try {
          const since = days && days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : undefined
          const targets = server ? [server] : (await nasServers()).map((s) => s.label)
          const all: Array<{ server: string; name: string; path: string; type: string; size: number; modified: string | null }> = []
          for (const t of targets) {
            const r = await nasSearch(t, query, { limit: 30, path: folder, sort: sort ?? 'relevance', since })
            for (const h of r.results) {
              all.push({
                server: t, name: h.name, path: h.path,
                type: h.isDir ? 'folder' : 'file', size: h.size,
                modified: h.mtime ? new Date(h.mtime * 1000).toISOString().slice(0, 10) : null,
              })
            }
            if (all.length >= 50) break
          }
          // Merging two drives can break per-drive ordering — re-sort globally.
          if (sort === 'latest' || sort === 'oldest') {
            all.sort((a, b) => (sort === 'latest' ? 1 : -1) * ((b.modified ?? '').localeCompare(a.modified ?? '')))
          }
          return { query, sort: sort ?? 'relevance', matches: all.slice(0, 50) }
        } catch (e) {
          return { error: e instanceof Error ? e.message : 'search failed' }
        }
      },
    }),

    nas_read: tool({
      description:
        'Read the text content of a file on a Trijya NAS (text files and spreadsheets). Use the exact `server` + `path` from nas_search or nas_list. Returns extracted text so you can answer questions about the file.',
      inputSchema: z.object({
        server: z.string().describe('NAS label, e.g. "WD".'),
        path: z.string().describe('Full file path, e.g. "/01 ARCHITECTURE/spec.txt".'),
      }),
      execute: async ({ server, path }) => {
        if (!isNasEnabled()) return { error: 'NAS not available' }
        try {
          const buf = await nasFetchBytes(server, path)
          const text = await extractText(path, buf)
          return { server, path, bytes: buf.length, content: text }
        } catch (e) {
          return { error: e instanceof Error ? e.message : 'read failed' }
        }
      },
    }),

    nas_semantic_search: tool({
      description:
        'Search the CONTENT of NAS documents by meaning (not filename) and return the most relevant passages, e.g. "what does the spec say about fire rating" or "find the clause about payment terms". Only covers files uploaded since content indexing was enabled — if it returns nothing, fall back to nas_search + nas_read. Each result includes the source file so you can cite it.',
      inputSchema: z.object({
        query: z.string().describe('A question or phrase describing what you\'re looking for, e.g. "fire rating requirements for the lobby".'),
        limit: z.number().optional().describe('Max passages to return (default 6).'),
      }),
      execute: async ({ query, limit }) => {
        if (!isNasEnabled()) return { error: 'NAS not available' }
        if (!isRagIndexingEnabled()) return { error: 'Content search is not configured for this deployment.' }
        try {
          const vector = await embedQuery(query)
          const hits = await searchChunksHybrid(getOrgId(), vector, query, limit ?? 6)
          if (hits.length === 0) {
            return { query, matches: [], hint: 'No indexed passages matched — try nas_search for a filename match instead.' }
          }
          return {
            query,
            matches: hits.map((h) => ({
              server: h.server, path: h.path, fileName: h.fileName,
              score: Math.round(h.score * 1000) / 1000, matchType: h.matchType, excerpt: h.text,
            })),
          }
        } catch (e) {
          return { error: e instanceof Error ? e.message : 'semantic search failed' }
        }
      },
    }),
  }
}
