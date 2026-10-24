import MarkedText from '@/components/workspace/MarkedText'
import { formatPassage } from '@/lib/rag/format'
import { findSpan } from '@/lib/rag/highlight'

/** Whether a quoted phrase and this table line overlap (either holds the other). */
const touches = (line: string, marks: string[]) =>
  line.trim().length > 0 && marks.some((m) => findSpan(line, m) !== null || findSpan(m, line) !== null)

/**
 * Document text laid out for reading: paragraphs rejoined and tables rebuilt
 * from the one-cell-per-line text PDF extraction gives (lib/rag/format.ts),
 * with the phrases in `marks` highlighted, whole table rows included.
 */
export default function PassageText({ text, marks }: { text: string; marks: string[] }) {
  const blocks = formatPassage(text)
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        if (b.kind === 'text') return <MarkedText key={i} text={b.text} marks={marks} />
        const width = Math.max(b.header.length, ...b.rows.map((r) => ('cells' in r ? r.cells.length : 1)))
        return (
          <div key={i} className="overflow-x-auto">
            <table className="w-full border-collapse text-sm text-text-primary">
              <thead>
                <tr className={touches(b.header.join(' '), marks) ? 'bg-accent/20' : ''}>
                  {b.header.map((h, j) => (
                    <th key={j} className="border border-border-default px-2 py-1 text-left text-xs font-semibold text-text-secondary">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) =>
                  'group' in r ? (
                    <tr key={j} className={touches(r.group, marks) ? 'bg-accent/20' : 'bg-surface-raised'}>
                      <td colSpan={width} className="border border-border-default px-2 py-1 text-xs font-semibold">{r.group}</td>
                    </tr>
                  ) : (
                    <tr key={j} className={touches(r.cells.join(' '), marks) ? 'bg-accent/20 font-medium' : ''}>
                      {r.cells.map((c, x) => (
                        <td key={x} className="border border-border-default px-2 py-1 align-top whitespace-nowrap">{c}</td>
                      ))}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}
