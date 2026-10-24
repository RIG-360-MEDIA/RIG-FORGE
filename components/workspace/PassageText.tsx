import MarkedText from '@/components/workspace/MarkedText'
import { formatPassage, type PassageBlock } from '@/lib/rag/format'
import { findSpan } from '@/lib/rag/highlight'

/** Whether a quoted phrase and this table line overlap (either holds the other). */
const touches = (line: string, marks: string[]) =>
  line.trim().length > 0 && marks.some((m) => findSpan(line, m) !== null || findSpan(m, line) !== null)

/** Nested clauses step in: 1.6 at the left, 1.6.1 one step right. */
const indent = (clause?: string) => {
  const depth = clause ? clause.split('.').length : 0
  return depth >= 3 ? 'pl-5' : ''
}

function Paragraph({ block, marks, aligned }: { block: Extract<PassageBlock, { kind: 'text' }>; marks: string[]; aligned: boolean }) {
  // "... shall be as follows:" and "Open Area :" introduce what follows.
  const lead = /:\s*$/.test(block.text)
  const text = <MarkedText text={block.text} marks={marks} className={lead ? 'font-medium' : ''} />
  if (!block.clause) return <div className={aligned ? 'pl-14' : ''}>{text}</div>
  return (
    <div className={`flex gap-3 ${indent(block.clause)}`}>
      <span className="mt-0.5 h-fit min-w-[2.75rem] shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold tabular-nums text-text-primary">
        {block.clause}
      </span>
      <div className="min-w-0 flex-1">{text}</div>
    </div>
  )
}

function Table({ block, marks, aligned }: { block: Extract<PassageBlock, { kind: 'table' }>; marks: string[]; aligned: boolean }) {
  const width = Math.max(block.header.length, ...block.rows.map((r) => ('cells' in r ? r.cells.length : 1)))
  let stripe = 0
  return (
    <div className={`${aligned ? 'ml-14' : ''} overflow-x-auto rounded-md border border-border-default`}>
      <table className="w-full border-collapse text-sm text-text-primary">
        <thead className="bg-surface-raised">
          <tr className={touches(block.header.join(' '), marks) ? 'bg-accent/15' : ''}>
            {block.header.map((h, j) => (
              <th key={j} className="border-b border-border-default px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r, j) => {
            if ('group' in r) {
              stripe = 0
              return (
                <tr key={j} className={touches(r.group, marks) ? 'bg-accent/25' : 'bg-accent/10'}>
                  <td colSpan={width} className="border-b border-border-default px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">
                    {r.group}
                  </td>
                </tr>
              )
            }
            const hit = touches(r.cells.join(' '), marks)
            const zebra = stripe++ % 2 === 1
            return (
              <tr
                key={j}
                className={hit ? 'bg-accent/25 font-semibold shadow-[inset_3px_0_0_0_rgb(var(--c-accent))]' : zebra ? 'bg-surface-raised/50' : ''}
              >
                {r.cells.map((c, x) => (
                  <td key={x} className={`border-b border-border-default px-3 py-1.5 align-top whitespace-nowrap tabular-nums ${x === 0 ? 'font-medium' : ''}`}>
                    {c}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Document text laid out for reading: numbered clauses, paragraphs rejoined
 * and tables rebuilt from the one-cell-per-line text PDF extraction gives
 * (lib/rag/format.ts), with the phrases in `marks` highlighted, whole table
 * rows included.
 */
export default function PassageText({ text, marks }: { text: string; marks: string[] }) {
  const blocks = formatPassage(text)
  // Unnumbered text and tables line up with clause text only when there are clauses.
  const aligned = blocks.some((b) => b.kind === 'text' && b.clause)
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) =>
        b.kind === 'text'
          ? <Paragraph key={i} block={b} marks={marks} aligned={aligned} />
          : <Table key={i} block={b} marks={marks} aligned={aligned} />,
      )}
    </div>
  )
}
