/**
 * Forgie rule-first fast lane (Phase 1 of the hybrid plan).
 *
 * Deterministically answers a handful of common, SAFE, read-only questions
 * straight from the already-built ForgieContext — no LLM, no network, <1ms.
 * Everything else returns null and falls through to the LLM.
 *
 * GOLDEN RULE: high PRECISION, not high coverage. When in any doubt, return
 * null. A wrong instant answer is far worse than a slightly slower LLM answer.
 * All rules answer ONLY about the caller's own data (their tasks/tickets/
 * projects), so there is no cross-user data leak — RBAC is satisfied by
 * construction.
 *
 * Pure + framework-free so it can be unit-tested without a server or DB.
 */

import type { ForgieContext } from '@/lib/assistant/context'

// ─── Normalisation ───────────────────────────────────────────────────────────

/** lowercase, strip filler/politeness, collapse whitespace, drop trailing punctuation. */
export function normalize(raw: string): string {
  let s = (raw ?? '').toLowerCase().trim()
  // strip leading politeness/filler so "hey forgie can you please show my tasks" → "show my tasks"
  s = s.replace(/^(hey|hi|hello|yo|ok|okay|so|um|umm|please|pls|plz)\b[\s,]*/g, '')
  s = s.replace(/\b(forgie|forge|bot|assistant)\b/g, ' ')
  // NOTE: deliberately do NOT strip "can you"/"could you" — it would turn
  // "what can you do" into "what do" and break the help intent.
  s = s.replace(/[¿?!.]+$/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

// ─── Edge-case guards — any true → DO NOT rule-handle, defer to the LLM ───────

// Write / side-effecting verbs. Rules NEVER perform or describe an action — a
// message containing any of these goes to the LLM (which has the propose/confirm
// flow). This is the single most important safety guard.
const WRITE_VERB = /\b(create|add|make|new|raise|open a|close|cancel|delete|remove|drop|assign|reassign|send|email|mail|message|dm|ping|notify|schedule|book|invite|update|change|edit|rename|set|move|mark|resolve|complete|finish|start|launch|archive|promote|demote|approve|reject|share|upload|post)\b/

// Two questions in one — a single rule can't chain. Let the LLM handle it.
const MULTI_INTENT = /\b(and|also|then|plus|as well as)\b|[?][^?]*[?]/

// Negation / exclusion — rules only do simple positive reads.
const NEGATION = /\b(not|except|without|excluding|other than|apart from|no longer|isn't|isnt|aren't|arent|don't|dont|doesn't|doesnt)\b/

// Pronoun / follow-up referring to prior turns — rules are stateless.
const FOLLOWUP = /^(and|also|what about|how about|that|those|these|them|it|his|her|their|the same)\b/

function shouldDefer(n: string): boolean {
  return WRITE_VERB.test(n) || MULTI_INTENT.test(n) || NEGATION.test(n) || FOLLOWUP.test(n)
}

// ─── Small formatting helpers ────────────────────────────────────────────────

function fmtDue(dueDate: string | null): string {
  if (!dueDate) return 'no due date'
  const d = new Date(dueDate)
  if (isNaN(d.getTime())) return 'no due date'
  return `due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

function bullet(lines: string[], cap = 8): string {
  const shown = lines.slice(0, cap)
  const extra = lines.length - shown.length
  return shown.map((l) => `• ${l}`).join('\n') + (extra > 0 ? `\n…and ${extra} more.` : '')
}

// ─── Intent matchers (each returns a full answer string or null) ─────────────

// Greeting — only when the message is *essentially just* a greeting (post-normalise
// it's empty or a tiny hello token), so "hi what's due" doesn't get swallowed.
const GREETING_ONLY = /^(hi|hey|hello|yo|hii+|heya|namaste|hola|good (morning|afternoon|evening)|sup|whats up|what's up)?$/
export function matchGreeting(n: string, ctx: ForgieContext): string | null {
  if (!GREETING_ONLY.test(n)) return null
  const first = ctx.user.name.split(' ')[0]
  const open = ctx.myTasks.filter((t) => t.status !== 'DONE').length
  const overdue = ctx.myTasks.filter((t) => t.isOverdue).length
  const tail = overdue > 0
    ? ` You've got ${overdue} overdue task${overdue === 1 ? '' : 's'} — want the list?`
    : open > 0
      ? ` You have ${open} open task${open === 1 ? '' : 's'}. Ask me "what's due" any time.`
      : ''
  return `Hey ${first}. What do you need?${tail}`
}

// Precise: bare "help" only when it IS the request — not the word "help"
// appearing inside a sentence like "do short standups help a team".
const HELP = /^help( me)?$|\bwhat can (you|u) do\b|\byour capabilities\b|\bwhat do you do\b|\bhow do you (work|help me)\b|\bwhat are you\b|\bwhat can i ask\b/
export function matchHelp(n: string): string | null {
  if (!HELP.test(n)) return null
  return [
    "I'm Forgie — I track the team's work. I can quickly tell you about:",
    '• Your tasks — "what\'s due", "my overdue tasks"',
    '• Your tickets — "my open tickets"',
    '• Your projects — "my projects"',
    'For anything more (creating tasks, sending messages, scheduling, GitHub/Drive/Gmail), just ask in plain English and I\'ll handle it.',
  ].join('\n')
}

// Tasks — "what's due", "my tasks", "todo", "overdue", Hinglish "mera kaam".
const TASK_HIT = /\b(task|tasks|to-?do|to do|due|deadline|overdue|pending|kaam|mera kaam)\b|on my plate/
const OVERDUE_HIT = /\b(overdue|late|behind|slipping|missed)\b/
const WEEK_HIT = /\b(this week|week|next 7 days|coming days)\b/
function matchTasks(n: string, ctx: ForgieContext): string | null {
  if (!TASK_HIT.test(n)) return null
  const open = ctx.myTasks.filter((t) => t.status !== 'DONE')

  if (OVERDUE_HIT.test(n)) {
    const od = open.filter((t) => t.isOverdue)
    if (od.length === 0) return "Nothing overdue — you're all caught up."
    return `You have ${od.length} overdue task${od.length === 1 ? '' : 's'}:\n` +
      bullet(od.map((t) => `${t.title} (${t.projectName}) — ${fmtDue(t.dueDate)}`))
  }

  let list = open
  let scope = 'open task'
  if (WEEK_HIT.test(n)) {
    const cutoff = Date.now() + 7 * 24 * 60 * 60 * 1000
    list = open.filter((t) => t.dueDate && new Date(t.dueDate).getTime() <= cutoff)
    scope = 'task due this week'
  }
  if (list.length === 0) {
    return WEEK_HIT.test(n)
      ? 'Nothing due this week.'
      : 'You have no open tasks right now.'
  }
  // Overdue first, then by due date.
  list = [...list].sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1
    return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
  })
  return `You have ${list.length} ${scope}${list.length === 1 ? '' : 's'}:\n` +
    bullet(list.map((t) => `${t.title} (${t.projectName}) — ${fmtDue(t.dueDate)}${t.isOverdue ? ' (overdue)' : ''}`))
}

// Tickets — "my tickets", "open tickets", "support".
const TICKET_HIT = /\b(ticket|tickets|support request|help request)\b/
function matchTickets(n: string, ctx: ForgieContext): string | null {
  if (!TICKET_HIT.test(n)) return null
  const open = ctx.myTickets.filter((t) => t.status === 'OPEN' || t.status === 'ACCEPTED')
  if (open.length === 0) return 'You have no open tickets.'
  return `You have ${open.length} open ticket${open.length === 1 ? '' : 's'}:\n` +
    bullet(open.map((t) => `${t.title} (${t.projectName}) — ${t.status.toLowerCase()}, ${t.role === 'raised' ? 'you raised' : 'you\'re helping'}`))
}

// Projects — "my projects", "what am I working on".
const PROJECT_HIT = /\b(my projects|projects i|which projects|what am i working on|what.?m i working on|my work)\b/
function matchProjects(n: string, ctx: ForgieContext): string | null {
  if (!PROJECT_HIT.test(n)) return null
  const ps = ctx.myProjects
  if (ps.length === 0) return "You're not on any active projects right now."
  return `You're on ${ps.length} active project${ps.length === 1 ? '' : 's'}:\n` +
    bullet(ps.map((p) => {
      const { done, total, overdue } = p.progress
      const prog = total > 0 ? `${done}/${total} tasks done` : 'no tasks yet'
      return `${p.name} — ${prog}${overdue > 0 ? `, ${overdue} overdue` : ''}`
    }))
}

// ─── Engine ──────────────────────────────────────────────────────────────────

/**
 * Try to answer deterministically. Returns the answer text, or null to defer
 * to the LLM. `channel` lets WhatsApp reuse the same rules.
 */
/**
 * Cheap PRE-context classifier. Identifies the intents that need little or no
 * data — `help` (none) and `greeting` (only the caller's own tasks) — so the
 * route can answer them BEFORE the full multi-query context build. Everything
 * else returns null and takes the normal build → rules → LLM path.
 */
export function classifyFast(raw: string): 'help' | 'greeting' | null {
  const n = normalize(raw)
  if (GREETING_ONLY.test(n)) return 'greeting' // bare hi/hello — trips no guards
  if (shouldDefer(n)) return null // writes / multi-intent / negation / follow-up → LLM
  if (HELP.test(n)) return 'help'
  return null
}

export function tryRuleAnswer(raw: string, ctx: ForgieContext): string | null {
  const n = normalize(raw)
  // Guards first — never rule-handle writes, multi-intent, negation, follow-ups.
  // (Greeting is exempt from the guards since a bare "hi" trips nothing.)
  const greeting = matchGreeting(n, ctx)
  if (greeting) return greeting
  if (shouldDefer(n)) return null
  return (
    matchHelp(n) ??
    matchTasks(n, ctx) ??
    matchTickets(n, ctx) ??
    matchProjects(n, ctx) ??
    null
  )
}
