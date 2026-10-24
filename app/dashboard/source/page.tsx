'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ExternalLink, FileText } from 'lucide-react'

import MarkedText from '@/components/workspace/MarkedText'
import { quotePhrases, tidy } from '@/lib/rag/highlight'

interface SourceView {
  server: string
  path: string
  fileName: string
  keyLines: string
  passage: string
  page: number | null
  pageCount: number | null
  pageText: string | null
  pageReason: string | null
  pdfUrl: string
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-border-default bg-surface-raised/60">
      <header className="flex items-baseline justify-between gap-3 border-b border-border-default px-4 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-secondary">{title}</h2>
        {hint && <span className="text-xs text-text-secondary">{hint}</span>}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  )
}

/**
 * The source view behind a chat answer's "Show passage and page" link, to
 * check the answer against the document: the key lines it was taken from,
 * the whole passage, and the full PDF page it is on, each with the key lines
 * highlighted.
 */
function SourceInner() {
  const params = useSearchParams()
  const [view, setView] = useState<SourceView | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setView(null); setErr(null)
    fetch(`/api/nas/source?${params.toString()}`, { credentials: 'include' })
      .then(async (r) => {
        const j = await r.json().catch(() => null)
        if (!r.ok || !j?.data) throw new Error(j?.error || 'Could not load this source')
        setView(j.data as SourceView)
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load this source'))
  }, [params])

  const marks = quotePhrases(view?.keyLines ?? params.get('k') ?? '')

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Source</p>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary [overflow-wrap:anywhere]">
            <FileText className="h-5 w-5 shrink-0" aria-hidden="true" />
            {view?.fileName ?? params.get('p')?.split('/').pop() ?? 'Document'}
          </h1>
          {view && <p className="text-xs text-text-secondary [overflow-wrap:anywhere]">{view.server} · {view.path}</p>}
        </div>
        {view && (
          <a
            href={view.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded border border-border-default px-3 py-1.5 text-sm text-text-primary hover:bg-surface-raised"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            {view.page ? `Open PDF at page ${view.page}` : 'Open document'}
          </a>
        )}
      </div>

      {err && <div className="rounded border border-border-default px-4 py-3 text-sm text-red-500">{err}</div>}

      {marks.length > 0 && (
        <Section title="Key lines" hint="what the answer was taken from">
          <div className="space-y-2">
            {marks.map((m, i) => (
              <p key={i} className="border-l-2 border-accent pl-3 text-sm leading-6 text-text-primary [overflow-wrap:anywhere]">{m}</p>
            ))}
          </div>
        </Section>
      )}

      {!view && !err && <p className="text-sm text-text-secondary">Loading the passage and finding its page in the PDF…</p>}

      {view && (
        <>
          <Section title="Whole passage" hint="key lines highlighted">
            <MarkedText text={tidy(view.passage)} marks={marks} />
          </Section>

          {view.page && view.pageText ? (
            <Section title={`Full page ${view.page}${view.pageCount ? ` of ${view.pageCount}` : ''}`} hint="as printed in the PDF">
              <MarkedText text={tidy(view.pageText)} marks={marks} className="max-h-[70vh] overflow-y-auto" />
            </Section>
          ) : (
            <div className="rounded border border-border-default px-4 py-3 text-sm text-text-secondary">
              The page could not be found: {view.pageReason ?? 'unknown reason'} Use the passage above, or search the document for a phrase from the key lines.
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function SourcePage() {
  return (
    <Suspense fallback={null}>
      <SourceInner />
    </Suspense>
  )
}
