/**
 * People lookup fast-lane — "search Divyanjali in contacts", "Kavya's number",
 * "who is Rohit" → answered straight from the team directory, no LLM.
 *
 * Why: the LLM path was either failing outright or replying with only an email,
 * even though the directory already holds the phone. This returns the full card
 * (name · role · email · phone) instantly and deterministically.
 *
 * Contact details are admin-only (listMembers enforces that) — employees get
 * name + role, which is exactly the existing RBAC.
 */
import { listMembers } from '@/lib/assistant/tools/members'
import type { ToolUser } from '@/lib/assistant/tools/projects'

// Must look like a person/contact question.
const CONTACT_INTENT =
  /\b(contact|contacts|number|phone|mobile|email|e-?mail|reach|details|who is|who's|whos)\b/i
// Anything action-y belongs to the LLM (send/email X, assign, etc).
const ACTION = /\b(send|email to|mail to|message|dm|ping|call|assign|add|create|invite|schedule|share)\b/i
// Strip the question scaffolding so the remainder is the person's name.
const NAME_STOP =
  /\b(search|searching|find|get|show|look|lookup|give|tell|me|my|the|a|an|of|in|on|for|from|to|contact|contacts|number|phone|mobile|whatsapp|email|e-?mail|address|details|detail|info|reach|who|is|whos|what|whats|please|pls|can|could|you|u|about|team|directory|google|list|and|his|her|their)\b/gi

interface Memberish {
  id: string
  name: string
  role: string
  email?: string
  contactEmail?: string | null
  whatsappNumber?: string | null
  projectCount?: number
}

export async function tryPeopleFastLane(raw: string, caller: ToolUser): Promise<string | null> {
  const c = (raw ?? '').trim()
  if (!c || c.length > 120) return null
  if (!CONTACT_INTENT.test(c)) return null
  if (ACTION.test(c)) return null // "email Kavya the file" → LLM/tools

  const name = c
    .toLowerCase()
    .replace(NAME_STOP, ' ')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (name.length < 3) return null // no concrete name → defer to the LLM

  try {
    const members = (await listMembers(caller, { search: name, limit: 5 })) as unknown as Memberish[]
    if (!members.length) return null // let the LLM try (aliases, nicknames, etc.)

    const card = (m: Memberish): string => {
      const bits: string[] = []
      const mail = m.contactEmail || m.email
      if (mail) bits.push(`  Email: ${mail}`)
      if (m.whatsappNumber) bits.push(`  Phone: ${m.whatsappNumber}`)
      if (!mail && !m.whatsappNumber) bits.push('  _No contact details on file._')
      return [`**${m.name}** — ${m.role.replace('_', ' ').toLowerCase()}`, ...bits].join('\n')
    }

    if (members.length === 1) return card(members[0]!)
    return [`Found ${members.length} people matching “${name}”:`, '', ...members.map(card)].join('\n')
  } catch {
    return null // directory hiccup → fall through to the LLM
  }
}
