import { findSpans, splitMarked } from '@/lib/rag/highlight'

/** Document text as printed, with every phrase in `marks` highlighted. */
export default function MarkedText({ text, marks, className = '' }: { text: string; marks: string[]; className?: string }) {
  const pieces = splitMarked(text, findSpans(text, marks))
  return (
    <p className={`text-sm leading-6 text-text-primary whitespace-pre-wrap [overflow-wrap:anywhere] ${className}`}>
      {pieces.map((p, i) =>
        p.marked ? (
          <mark key={i} className="rounded-sm bg-accent/20 px-0.5 text-text-primary font-medium">{p.text}</mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  )
}
