'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '@/store/assistantStore'
import ActionCard from './ActionCard'
import SourceDetails, { isSourceLink } from './SourceDetails'

export default function Message({
  msg,
  conversationId,
}: {
  msg: ChatMessage
  conversationId: string | null
}) {
  const isUser = msg.role === 'user'

  return (
    <div className={['flex flex-col', isUser ? 'items-end' : 'items-start'].join(' ')}>
      <div
        className={[
          'max-w-[85%] px-4 py-2.5 text-sm rounded-2xl',
          isUser
            ? 'bg-[#1A1A1A] text-white rounded-br-md'
            : 'bg-surface-mid text-text-primary rounded-bl-md border border-border-subtle',
        ].join(' ')}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words leading-relaxed">{msg.content}</p>
        ) : (
          <div className="prose prose-sm max-w-none prose-headings:font-semibold prose-headings:text-text-primary prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:text-text-primary prose-code:bg-black/5 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-pre:bg-[#1A1A1A] prose-pre:text-[#FAFAFA] prose-strong:text-text-primary prose-a:text-emerald-700 prose-a:underline prose-a:underline-offset-2 hover:prose-a:text-emerald-800 [&_a]:[overflow-wrap:anywhere] prose-blockquote:my-1 prose-blockquote:border-l-2 prose-blockquote:border-accent prose-blockquote:pl-2 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-text-primary [&_blockquote_p:first-of-type]:before:content-none [&_blockquote_p:last-of-type]:after:content-none [&_blockquote]:[overflow-wrap:anywhere]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // A document answer's source link (its own paragraph under each
                // source) becomes the Exact line / Paragraph / Page dropdowns.
                p: ({ node, children, ...props }) => {
                  const only = node?.children.filter((c) => !(c.type === 'text' && !c.value.trim()))
                  const link = only?.length === 1 && only[0]?.type === 'element' && only[0].tagName === 'a' ? only[0] : null
                  const href = link ? String(link.properties?.href ?? '') : ''
                  if (isSourceLink(href)) return <SourceDetails href={href} />
                  return <p {...props}>{children}</p>
                },
                // Force every link to open in a new tab and add safe rel attrs.
                // remark-gfm autolinks bare URLs as <a>, so this covers
                // both `[label](url)` and raw `https://...` mentions.
                a: ({ href, children, ...props }) => (
                  <a
                    {...props}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {/* Provider/cache/fallback meta is intentionally NOT shown to users —
          which LLM served the reply is an internal detail. (Still tracked in
          the DB + admin usage dashboard at /dashboard/assistant.) */}

      {/* Inline confirmation cards for any proposed write actions */}
      {!isUser && msg.pendingActions && msg.pendingActions.length > 0 && (
        <div className="w-full max-w-[85%] flex flex-col gap-1.5">
          {msg.pendingActions.map((action) => (
            <ActionCard
              key={action.actionId}
              messageId={msg.id}
              action={action}
              conversationId={conversationId}
            />
          ))}
        </div>
      )}
    </div>
  )
}
