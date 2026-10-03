/**
 * Forgie bylaws tool — searches the separate Trijya bylaws RAG index (own
 * Qdrant collection, own ingestion pipeline — see lib/rag/index-bylaws-file.ts
 * and app/api/nas/bylaws/reindex). Kept independent from nas_semantic_search
 * so bylaws answers are never diluted by unrelated drawings/specs/misc files.
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import { isNasEnabled } from '@/lib/nas/client'
import { getOrgId } from '@/lib/tenant-context'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { embedQuery } from '@/lib/rag/embeddings'
import { searchChunksHybrid, BYLAWS_COLLECTION } from '@/lib/rag/qdrant'

export function buildBylawsTools(): ToolSet {
  return {
    bylaws_search: tool({
      description:
        'Search Trijya\'s bylaws documents by meaning, e.g. "what is the setback requirement" or "rules on building height". Separate from general NAS file search — use this specifically for bylaw/regulation/ordinance questions. Returns the most relevant passages with their source document.',
      inputSchema: z.object({
        query: z.string().describe('A question or phrase describing the bylaw topic, e.g. "maximum building height in residential zones".'),
        limit: z.number().optional().describe('Max passages to return (default 6).'),
      }),
      execute: async ({ query, limit }) => {
        if (!isNasEnabled()) return { error: 'Bylaws search is not available' }
        if (!isBylawsIndexingEnabled()) return { error: 'Bylaws search is not configured for this deployment.' }
        try {
          const vector = await embedQuery(query)
          const hits = await searchChunksHybrid(getOrgId(), vector, query, limit ?? 6, BYLAWS_COLLECTION)
          if (hits.length === 0) {
            return { query, matches: [], hint: 'No indexed bylaws passages matched. The bylaws folder may not have been indexed yet (see /api/nas/bylaws/reindex).' }
          }
          return {
            query,
            matches: hits.map((h) => ({
              server: h.server, path: h.path, fileName: h.fileName,
              score: Math.round(h.score * 1000) / 1000, matchType: h.matchType, excerpt: h.text,
            })),
          }
        } catch (e) {
          return { error: e instanceof Error ? e.message : 'bylaws search failed' }
        }
      },
    }),
  }
}
