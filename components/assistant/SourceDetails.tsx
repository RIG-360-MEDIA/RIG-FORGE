'use client'

import { useState } from 'react'
import { ChevronRight, ExternalLink } from 'lucide-react'

import PassageText from '@/components/workspace/PassageText'
import { quotePhrases, tidy } from '@/lib/rag/highlight'

interface SourceData {
  passage: string
  page: number | null
  pageCount: number | null
  pageText: string | null
  pageReason: string | null
  pdfUrl: string
}

/** Whether a chat link is a source-view link (from sourcesFooter in lib/rag/answer.ts). */
export function isSourceLink(href: string | undefined): href is string {
  return !!href && href.startsWith('/dashboard/source?')
}

/** One collapsible section; `onOpen` runs the first time it opens. */
function Section({ title, onOpen, children }: { title: string; onOpen?: () => void; children: React.ReactNode }) {
  const [opened, setOpened] = useState(false)
  return (
    <details
      className="group rounded-md border border-border-subtle bg-surface-raised/40 open:bg-surface-raised/70"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !opened) {
          setOpened(true)
          onOpen?.()
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-text-primary select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform group-open:rotate-90" aria-hidden="true" />
        {title}
      </summary>
      <div className="border-t border-border-subtle px-2.5 py-2 not-prose">{children}</div>
    </details>
  )
}

const Note = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-text-secondary">{children}</p>

/**
 * Under each source of a document answer: the exact line(s) the answer was
 * taken from, the whole paragraph (passage), and the full PDF page, each in
 * its own dropdown, then a link to the whole PDF. The paragraph and the page
 * are fetched when first opened (GET /api/nas/source); the page needs the
 * PDF searched on the NAS, so it is a separate, slower request.
 */
export default function SourceDetails({ href }: { href: string }) {
  const params = new URLSearchParams(href.slice(href.indexOf('?') + 1))
  const quote = params.get('k') ?? ''
  const marks = quotePhrases(quote)
  const server = params.get('s') ?? ''
  const path = params.get('p') ?? ''
  const plainPdf = `/api/nas/download?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}&inline=1`

  const [para, setPara] = useState<SourceData | null>(null)
  const [paraErr, setParaErr] = useState<string | null>(null)
  const [page, setPage] = useState<SourceData | null>(null)
  const [pageErr, setPageErr] = useState<string | null>(null)

  const load = (withPage: boolean, set: (d: SourceData) => void, fail: (e: string) => void) => {
    const qs = new URLSearchParams(params)
    if (!withPage) qs.set('page', '0')
    fetch(`/api/nas/source?${qs}`, { credentials: 'include' })
      .then(async (r) => {
        const j = await r.json().catch(() => null)
        if (!r.ok || !j?.data) throw new Error(j?.error || 'Could not load this source')
        set(j.data as SourceData)
      })
      .catch((e: unknown) => fail(e instanceof Error ? e.message : 'Could not load this source'))
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <Section title="Exact line">
        {marks.length ? (
          <div className="space-y-1.5">
            {marks.map((m, i) => (
              <p key={i} className="border-l-2 border-accent pl-2 text-[13px] leading-5 text-text-primary [overflow-wrap:anywhere]">{m}</p>
            ))}
          </div>
        ) : <Note>No exact line was recorded for this source.</Note>}
      </Section>

      <Section title="Paragraph" onOpen={() => load(false, setPara, setParaErr)}>
        {para ? <PassageText text={tidy(para.passage)} marks={marks} compact />
          : paraErr ? <Note>{paraErr}</Note>
          : <Note>Loading the paragraph…</Note>}
      </Section>

      <Section title={page?.page ? `Page ${page.page}${page.pageCount ? ` of ${page.pageCount}` : ''}` : 'Page'} onOpen={() => load(true, setPage, setPageErr)}>
        {page ? (
          page.page && page.pageText ? (
            <div className="max-h-96 overflow-y-auto">
              <PassageText text={tidy(page.pageText)} marks={marks} compact />
            </div>
          ) : <Note>The page could not be found: {page.pageReason ?? 'unknown reason'}</Note>
        ) : pageErr ? <Note>{pageErr}</Note>
          : <Note>Finding the page in the PDF… (a large document can take up to a minute)</Note>}
      </Section>

      <a
        href={page?.pdfUrl ?? plainPdf}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium"
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        {page?.page ? `Open full PDF at page ${page.page}` : 'Open full PDF'}
      </a>
    </div>
  )
}
