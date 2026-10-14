/**
 * Native chat — service layer (Phase 1).
 *
 * Pure data operations over Prisma for 1:1 DMs and group chats. API routes in
 * app/api/chat/* stay thin and call these. Live delivery is handled separately
 * by Supabase Realtime subscribing to the ChatMessage table — these functions
 * only own the durable writes/reads.
 *
 * The tenancy anchor stamped on every row is the caller's organizationId,
 * resolved per-request via `getOrgId()` (bound by verifyToken from the JWT).
 * It must be passed explicitly on nested inserts (conversation members, the
 * seeded messages) because the Prisma org-scope extension only injects org at
 * the top level and the DB column default is the origin org, not the caller's.
 */
import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/db'
import { sendPushToUsers } from '@/lib/push/send'
import { safeFetch } from '@/lib/net/safe-fetch'
import { deleteObject, keyFromProxyPath } from '@/lib/storage/r2'
import { getOrgId } from '@/lib/tenant-context'
import { getOrgBranding } from '@/lib/org-branding'
import { mentionsForgie, replyAsForgieInChat } from './forgie'

// Stable key for a 1:1 DM: the two user ids sorted + joined, so a unique
// constraint guarantees exactly one DM thread per pair regardless of who
// initiates.
export function dmKeyFor(a: string, b: string): string {
  return [a, b].sort().join(':')
}

const memberUserSelect = { id: true, name: true, avatarUrl: true } as const

// ─── Conversations ─────────────────────────────────────────────────────────

export async function listConversations(userId: string) {
  // Make sure every user always has their dedicated Forgie chat.
  await getOrCreateForgieChat(userId)
  const memberships = await prisma.conversationMember.findMany({
    where: { userId },
    include: {
      conversation: {
        include: {
          members: { include: { user: { select: memberUserSelect } } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  })

  const blocked = new Set(
    (await prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } })).map((b) => b.blockedId),
  )

  const rows = await Promise.all(
    memberships.map(async (m) => {
      const convo = m.conversation
      const lastRaw = convo.messages[0] ?? null
      const last = lastRaw && (!m.clearedAt || new Date(lastRaw.createdAt) > m.clearedAt) ? lastRaw : null
      const since = [m.lastReadAt, m.clearedAt]
        .filter((d): d is Date => Boolean(d))
        .sort((a, b) => b.getTime() - a.getTime())[0]
      const unread = await prisma.chatMessage.count({
        where: {
          conversationId: convo.id,
          senderId: { not: userId },
          deletedAt: null,
          ...(since ? { createdAt: { gt: since } } : {}),
        },
      })
      const others = convo.members
        .filter((mm) => mm.userId !== userId)
        .map((mm) => mm.user)
      return {
        id: convo.id,
        type: convo.type,
        title: convo.isForgie ? 'Forgie' : convo.type === 'GROUP' ? convo.title : others[0]?.name ?? 'Direct message',
        avatarUrl: convo.isForgie ? null : convo.type === 'GROUP' ? convo.imageUrl ?? null : others[0]?.avatarUrl ?? null,
        members: convo.members.map((mm) => ({
          id: mm.user.id,
          name: mm.user.name,
          avatarUrl: mm.user.avatarUrl,
          lastReadAt: mm.lastReadAt,
          role: mm.role,
        })),
        lastMessage: last
          ? { content: last.content, createdAt: last.createdAt, senderId: last.senderId, kind: last.kind }
          : null,
        lastMessageAt: convo.lastMessageAt,
        unread,
        isArchived: m.isArchived,
        isPinned: m.isPinned,
        muted: m.muteUntil ? m.muteUntil > new Date() : false,
        isForgie: convo.isForgie,
        description: convo.description,
        onlyAdminsCanSend: convo.onlyAdminsCanSend,
        inviteToken: convo.inviteToken,
        disappearingSeconds: convo.disappearingSeconds,
        wallpaper: m.wallpaper,
        blocked: convo.type === 'DIRECT' && others[0] ? blocked.has(others[0].id) : false,
      }
    }),
  )

  rows.sort(
    (a, b) =>
      (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
  )
  return rows
}

// Get the existing 1:1 DM for a pair, or create it. Idempotent: the
// (organizationId, dmKey) unique constraint plus a P2002 re-fetch makes
// concurrent "open DM" clicks resolve to the same thread.
export async function getOrCreateDm(userId: string, otherUserId: string) {
  if (userId === otherUserId) throw new Error('Cannot start a DM with yourself')

  const org = getOrgId()
  const dmKey = dmKeyFor(userId, otherUserId)
  const existing = await prisma.conversation.findFirst({
    where: { organizationId: org, type: 'DIRECT', dmKey },
  })
  if (existing) return existing

  try {
    return await prisma.conversation.create({
      data: {
        organizationId: org,
        type: 'DIRECT',
        dmKey,
        createdById: userId,
        members: {
          create: [
            { organizationId: org, userId },
            { organizationId: org, userId: otherUserId },
          ],
        },
      },
    })
  } catch (err) {
    // Lost a create race — the other request made it first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const convo = await prisma.conversation.findFirst({
        where: { organizationId: org, type: 'DIRECT', dmKey },
      })
      if (convo) return convo
    }
    throw err
  }
}

export async function createGroup(userId: string, title: string, memberIds: string[]) {
  const org = getOrgId()
  const ids = Array.from(new Set([userId, ...memberIds]))
  return prisma.conversation.create({
    data: {
      organizationId: org,
      type: 'GROUP',
      title,
      createdById: userId,
      members: {
        create: ids.map((id) => ({
          organizationId: org,
          userId: id,
          role: id === userId ? 'OWNER' : 'MEMBER',
        })),
      },
    },
  })
}

// Resolved per-caller-org so each tenant's Forgie greets under its OWN name
// (Rig Forge / Trijya Forge), never the neutral default or another org's name.
function forgieWelcome(brandUpper: string): string {
  return `Hi! I'm Forgie, your ${brandUpper} assistant. Ask me about your projects, tasks, tickets, standups, or team. I can take actions too (create tasks, log standups), and you can @Forgie me in any group.`
}

// The dedicated 1:1 Forgie (AI) chat for a user. Idempotent via the synthetic
// dmKey "forgie:<userId>" + the (organizationId, dmKey) unique constraint.
export async function getOrCreateForgieChat(userId: string) {
  const org = getOrgId()
  const dmKey = `forgie:${userId}`
  const existing = await prisma.conversation.findFirst({ where: { organizationId: org, dmKey } })
  if (existing) return existing
  try {
    const convo = await prisma.conversation.create({
      data: {
        organizationId: org,
        type: 'DIRECT',
        isForgie: true,
        title: 'Forgie',
        dmKey,
        createdById: userId,
        lastMessageAt: new Date(),
        members: { create: [{ organizationId: org, userId, role: 'OWNER', isPinned: true }] },
      },
    })
    const { orgName } = await getOrgBranding(org)
    await prisma.chatMessage.create({
      data: { organizationId: org, conversationId: convo.id, senderId: null, kind: 'FORGIE', type: 'TEXT', content: forgieWelcome(orgName.toUpperCase()) },
    })
    return convo
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const convo = await prisma.conversation.findFirst({ where: { organizationId: org, dmKey } })
      if (convo) return convo
    }
    throw err
  }
}

// Proactively post a Forgie message into a user's Forgie chat (nudges, alerts…).
export async function forgieDmToUser(userId: string, content: string) {
  const convo = await getOrCreateForgieChat(userId)
  await prisma.$transaction([
    prisma.chatMessage.create({
      data: { organizationId: getOrgId(), conversationId: convo.id, senderId: null, kind: 'FORGIE', type: 'TEXT', content },
    }),
    prisma.conversation.update({ where: { id: convo.id }, data: { lastMessageAt: new Date() } }),
  ])
}

// ─── Messages ──────────────────────────────────────────────────────────────

async function assertMember(conversationId: string, userId: string) {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  })
  if (!member) throw new Error('Not a member of this conversation')
  return member
}

export async function listMessages(
  conversationId: string,
  userId: string,
  opts: { limit?: number; before?: string } = {},
) {
  const member = await assertMember(conversationId, userId)
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { disappearingSeconds: true },
  })
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)

  // Hide messages before "clear chat" and, if disappearing is on, older than the TTL.
  const cutoffs: Date[] = []
  if (member.clearedAt) cutoffs.push(member.clearedAt)
  if (conv?.disappearingSeconds) cutoffs.push(new Date(Date.now() - conv.disappearingSeconds * 1000))
  const since = cutoffs.length ? new Date(Math.max(...cutoffs.map((d) => d.getTime()))) : null

  const messages = await prisma.chatMessage.findMany({
    // Deleted messages are kept as tombstones; clear-chat / disappearing hide earlier ones.
    where: { conversationId, ...(since ? { createdAt: { gt: since } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(opts.before ? { cursor: { id: opts.before }, skip: 1 } : {}),
    include: {
      sender: { select: memberUserSelect },
      reactions: { select: { emoji: true, userId: true } },
      stars: { where: { userId }, select: { id: true } },
    },
  })
  // Return chronological (oldest → newest); flag whether the caller starred each.
  return messages.reverse().map((m) => ({ ...m, starred: m.stars.length > 0 }))
}

const URL_RE = /(https?:\/\/[^\s]+)/i

// Best-effort Open-Graph preview. Server-side fetch (avoids client CORS), short
// timeout + size cap. (SSRF hardening — allowlist/Block private IPs — is a prod TODO.)
async function fetchOgPreview(url: string) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    // SSRF-safe: rejects non-public hosts, re-validates each redirect hop.
    const res = await safeFetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RigForgeBot/1.0)' },
    })
    clearTimeout(timer)
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return null
    const html = (await res.text()).slice(0, 200_000)
    const og = (prop: string): string | undefined => {
      const a = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
      const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'))
      return (a?.[1] ?? b?.[1])?.trim()
    }
    const title = og('title') ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
    const description = og('description')
    let image = og('image')
    if (image?.startsWith('/')) {
      try { image = new URL(url).origin + image } catch { /* ignore */ }
    }
    if (!title && !description && !image) return null
    return { url, title, description, image }
  } catch {
    return null
  }
}

async function enrichLinkPreview(messageId: string, content: string) {
  const match = content.match(URL_RE)
  if (!match) return
  const preview = await fetchOgPreview(match[1])
  if (!preview) return
  await prisma.chatMessage.update({ where: { id: messageId }, data: { linkPreview: preview } }).catch(() => {})
}

// Fire-and-forget Web Push to the other, non-muted members of a conversation.
async function notifyNewMessage(conversationId: string, senderId: string, preview: string) {
  try {
    const [convo, sender, members] = await Promise.all([
      prisma.conversation.findUnique({ where: { id: conversationId }, select: { type: true, title: true } }),
      prisma.user.findUnique({ where: { id: senderId }, select: { name: true } }),
      prisma.conversationMember.findMany({
        where: { conversationId, userId: { not: senderId } },
        select: { userId: true, muteUntil: true },
      }),
    ])
    const now = new Date()
    const targets = members.filter((m) => !m.muteUntil || m.muteUntil <= now).map((m) => m.userId)
    if (targets.length === 0) return
    const senderName = sender?.name ?? 'Someone'
    const title = convo?.type === 'GROUP' ? convo.title ?? 'Group chat' : senderName
    const body = convo?.type === 'GROUP' ? `${senderName}: ${preview}` : preview
    await sendPushToUsers(targets, { title, body: body.slice(0, 140), url: '/dashboard/messages', tag: conversationId })
  } catch (err) {
    console.error('[chat] push notify failed', err)
  }
}

export async function sendMessage(
  conversationId: string,
  userId: string,
  content: string,
  replyToId?: string | null,
) {
  const member = await assertMember(conversationId, userId)
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { type: true, onlyAdminsCanSend: true, isForgie: true },
  })
  if (convo?.type === 'GROUP' && convo.onlyAdminsCanSend && member.role !== 'OWNER' && member.role !== 'ADMIN') {
    throw new Error('Only admins can send messages in this group')
  }
  if (convo?.type === 'DIRECT') {
    const other = await prisma.conversationMember.findFirst({
      where: { conversationId, userId: { not: userId } },
      select: { userId: true },
    })
    if (other && (await isPairBlocked(userId, other.userId))) {
      throw new Error('You can no longer message this contact')
    }
  }
  const text = content.trim()
  if (!text) throw new Error('Message is empty')

  const [message] = await prisma.$transaction([
    prisma.chatMessage.create({
      data: {
        organizationId: getOrgId(),
        conversationId,
        senderId: userId,
        kind: 'USER',
        type: 'TEXT',
        content: text,
        ...(replyToId ? { replyToId } : {}),
      },
      include: { sender: { select: memberUserSelect } },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    }),
    // Sending counts as reading up to now.
    prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    }),
  ])
  // Fire-and-forget Open-Graph preview; delivered live via the ChatMessage UPDATE sub.
  void enrichLinkPreview(message.id, text)
  // In the dedicated Forgie chat every message is for Forgie; elsewhere only when @mentioned.
  if (convo?.isForgie || mentionsForgie(text)) void replyAsForgieInChat(conversationId, userId)
  // No push for the Forgie chat (you're talking to a bot); otherwise notify members.
  if (!convo?.isForgie) void notifyNewMessage(conversationId, userId, text)
  return message
}

export async function markRead(conversationId: string, userId: string) {
  await prisma.conversationMember
    .update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    })
    .catch(() => {
      /* not a member / already gone — nothing to mark */
    })
}

// ─── Group administration ────────────────────────────────────────────────────

type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER'

async function userName(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
  return u?.name ?? 'Someone'
}

// Post a SYSTEM line ("Kavya added Pranav") into the group and bump its activity
// so it surfaces in the list — and, via the ChatMessage realtime INSERT, makes
// every member's client refresh (which is how name/photo/member changes
// propagate live without a separate subscription).
async function postSystemMessage(conversationId: string, content: string) {
  await prisma.$transaction([
    prisma.chatMessage.create({
      data: { organizationId: getOrgId(), conversationId, senderId: null, kind: 'SYSTEM', type: 'TEXT', content },
    }),
    prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } }),
  ])
}

async function requireGroupAdmin(conversationId: string, userId: string) {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  })
  if (!member) throw new Error('Not a member of this conversation')
  if (member.role !== 'OWNER' && member.role !== 'ADMIN') {
    throw new Error('Only group admins can do this')
  }
  return member
}

export async function renameGroup(conversationId: string, userId: string, title: string) {
  await requireGroupAdmin(conversationId, userId)
  const clean = title.trim()
  if (!clean) throw new Error('Group name cannot be empty')
  await prisma.conversation.update({ where: { id: conversationId }, data: { title: clean } })
  await postSystemMessage(conversationId, `${await userName(userId)} changed the group name to "${clean}"`)
}

export async function setGroupImage(conversationId: string, userId: string, imageUrl: string) {
  await requireGroupAdmin(conversationId, userId)
  await prisma.conversation.update({ where: { id: conversationId }, data: { imageUrl } })
  await postSystemMessage(conversationId, `${await userName(userId)} changed the group photo`)
}

export async function addGroupMembers(conversationId: string, userId: string, newMemberIds: string[]) {
  await requireGroupAdmin(conversationId, userId)
  const existing = await prisma.conversationMember.findMany({
    where: { conversationId },
    select: { userId: true },
  })
  const existingIds = new Set(existing.map((e) => e.userId))
  const toAdd = Array.from(new Set(newMemberIds)).filter((id) => id && !existingIds.has(id))
  if (toAdd.length === 0) return
  await prisma.conversationMember.createMany({
    data: toAdd.map((id) => ({ organizationId: getOrgId(), conversationId, userId: id, role: 'MEMBER' as MemberRole })),
    skipDuplicates: true,
  })
  const added = await prisma.user.findMany({ where: { id: { in: toAdd } }, select: { name: true } })
  await postSystemMessage(conversationId, `${await userName(userId)} added ${added.map((a) => a.name).join(', ')}`)
}

export async function removeGroupMember(conversationId: string, userId: string, targetUserId: string) {
  await requireGroupAdmin(conversationId, userId)
  if (targetUserId === userId) throw new Error('Use "leave" to remove yourself')
  const target = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
  })
  if (!target) return
  if (target.role === 'OWNER') throw new Error('Cannot remove the group owner')
  const name = await userName(targetUserId)
  await prisma.conversationMember.delete({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
  })
  await postSystemMessage(conversationId, `${await userName(userId)} removed ${name}`)
}

export async function setMemberRole(
  conversationId: string,
  userId: string,
  targetUserId: string,
  role: 'ADMIN' | 'MEMBER',
) {
  await requireGroupAdmin(conversationId, userId)
  if (role !== 'ADMIN' && role !== 'MEMBER') throw new Error('Invalid role')
  const target = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
  })
  if (!target) throw new Error('Not a member of this conversation')
  if (target.role === 'OWNER') throw new Error('Cannot change the group owner')
  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
    data: { role },
  })
  const verb = role === 'ADMIN' ? 'is now an admin' : 'is no longer an admin'
  await postSystemMessage(conversationId, `${await userName(targetUserId)} ${verb}`)
}

export async function leaveGroup(conversationId: string, userId: string) {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  })
  if (!member) return
  const name = await userName(userId)
  await prisma.conversationMember.delete({
    where: { conversationId_userId: { conversationId, userId } },
  })
  await postSystemMessage(conversationId, `${name} left`)
}

// ─── Delivery acks + media ───────────────────────────────────────────────────

// A recipient's client calls this when it RECEIVES a message (the double-grey
// "delivered" tick). Set once, by a member who isn't the sender.
export async function markDelivered(messageId: string, userId: string) {
  const msg = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { senderId: true, deliveredAt: true, conversationId: true },
  })
  if (!msg || msg.deliveredAt || msg.senderId === userId) return
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: msg.conversationId, userId } },
    select: { userId: true },
  })
  if (!member) return
  await prisma.chatMessage.update({ where: { id: messageId }, data: { deliveredAt: new Date() } })
}

// Create an IMAGE/FILE message whose `content` is the uploaded media URL.
export async function sendMediaMessage(
  conversationId: string,
  userId: string,
  mediaType: 'IMAGE' | 'FILE' | 'AUDIO',
  url: string,
  fileName?: string,
  fileSize?: number,
) {
  await assertMember(conversationId, userId)
  const [message] = await prisma.$transaction([
    prisma.chatMessage.create({
      data: {
        organizationId: getOrgId(),
        conversationId,
        senderId: userId,
        kind: 'USER',
        type: mediaType,
        content: url,
        fileName: fileName ?? null,
        fileSize: fileSize ?? null,
      },
      include: { sender: { select: memberUserSelect } },
    }),
    prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } }),
    prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    }),
  ])
  const label = mediaType === 'IMAGE' ? 'Photo' : mediaType === 'AUDIO' ? 'Voice message' : `File: ${fileName ?? 'attachment'}`
  void notifyNewMessage(conversationId, userId, label)
  return message
}

// ─── Edit / delete ───────────────────────────────────────────────────────────

const EDIT_WINDOW_MS = 15 * 60 * 1000

export async function editMessage(messageId: string, userId: string, content: string) {
  const msg = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { senderId: true, createdAt: true, deletedAt: true, type: true },
  })
  if (!msg) throw new Error('Message not found')
  if (msg.senderId !== userId) throw new Error('You can only edit your own messages')
  if (msg.deletedAt) throw new Error('Cannot edit a deleted message')
  if (msg.type !== 'TEXT') throw new Error('Only text messages can be edited')
  if (Date.now() - new Date(msg.createdAt).getTime() > EDIT_WINDOW_MS) {
    throw new Error('The edit window has passed')
  }
  const text = content.trim()
  if (!text) throw new Error('Message cannot be empty')
  return prisma.chatMessage.update({
    where: { id: messageId },
    data: { content: text, editedAt: new Date() },
    include: { sender: { select: memberUserSelect } },
  })
}

export async function deleteForEveryone(messageId: string, userId: string) {
  const msg = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { senderId: true, deletedAt: true, type: true, content: true },
  })
  if (!msg) throw new Error('Message not found')
  if (msg.senderId !== userId) throw new Error('You can only delete your own messages')
  if (msg.deletedAt) return
  await prisma.chatMessage.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), content: '' },
  })
  // Free the underlying R2 object for media messages (best-effort).
  if (msg.type === 'IMAGE' || msg.type === 'FILE' || msg.type === 'AUDIO') {
    const key = keyFromProxyPath(msg.content)
    if (key) void deleteObject(key)
  }
}

// ─── Reactions ───────────────────────────────────────────────────────────────

// One reaction per user per message: same emoji toggles off, a new emoji replaces.
export async function setReaction(messageId: string, userId: string, emoji: string) {
  const msg = await prisma.chatMessage.findUnique({ where: { id: messageId }, select: { conversationId: true } })
  if (!msg) throw new Error('Message not found')
  await assertMember(msg.conversationId, userId)

  const existing = await prisma.messageReaction.findUnique({
    where: { messageId_userId: { messageId, userId } },
  })
  if (existing) {
    if (existing.emoji === emoji) {
      await prisma.messageReaction.delete({ where: { messageId_userId: { messageId, userId } } })
      return
    }
    await prisma.messageReaction.update({
      where: { messageId_userId: { messageId, userId } },
      data: { emoji },
    })
    return
  }
  await prisma.messageReaction.create({ data: { messageId, userId, emoji } })
}

// ─── Search ──────────────────────────────────────────────────────────────────

export async function searchMessages(conversationId: string, userId: string, q: string) {
  await assertMember(conversationId, userId)
  const query = q.trim()
  if (!query) return []
  return prisma.chatMessage.findMany({
    where: {
      conversationId,
      deletedAt: null,
      kind: 'USER',
      type: 'TEXT',
      content: { contains: query, mode: 'insensitive' },
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
    include: { sender: { select: memberUserSelect } },
  })
}

// ─── Star + pin ──────────────────────────────────────────────────────────────

export async function toggleStar(messageId: string, userId: string) {
  const msg = await prisma.chatMessage.findUnique({ where: { id: messageId }, select: { conversationId: true } })
  if (!msg) throw new Error('Message not found')
  await assertMember(msg.conversationId, userId)
  const existing = await prisma.messageStar.findUnique({ where: { messageId_userId: { messageId, userId } } })
  if (existing) {
    await prisma.messageStar.delete({ where: { messageId_userId: { messageId, userId } } })
    return { starred: false }
  }
  await prisma.messageStar.create({ data: { messageId, userId } })
  return { starred: true }
}

export async function listStarred(userId: string) {
  const stars = await prisma.messageStar.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      message: {
        include: {
          sender: { select: memberUserSelect },
          conversation: { select: { id: true, type: true, title: true } },
        },
      },
    },
  })
  return stars
    .filter((s) => !s.message.deletedAt)
    .map((s) => ({
      id: s.message.id,
      conversationId: s.message.conversationId,
      conversationTitle: s.message.conversation.title,
      content: s.message.content,
      senderId: s.message.senderId,
      senderName: s.message.sender?.name ?? null,
      type: s.message.type,
      createdAt: s.message.createdAt,
    }))
}

export async function pinMessage(messageId: string, userId: string, pin: boolean) {
  const msg = await prisma.chatMessage.findUnique({ where: { id: messageId }, select: { conversationId: true } })
  if (!msg) throw new Error('Message not found')
  await assertMember(msg.conversationId, userId)
  await prisma.chatMessage.update({ where: { id: messageId }, data: { pinnedAt: pin ? new Date() : null } })
}

// ─── Per-user chat settings (archive / mute / pin-chat / clear) ──────────────
export async function setChatFlags(
  conversationId: string,
  userId: string,
  flags: { isArchived?: boolean; isPinned?: boolean; muteUntil?: Date | null; cleared?: boolean; wallpaper?: string | null },
) {
  await assertMember(conversationId, userId)
  const data: Prisma.ConversationMemberUpdateInput = {}
  if (typeof flags.isArchived === 'boolean') data.isArchived = flags.isArchived
  if (typeof flags.isPinned === 'boolean') data.isPinned = flags.isPinned
  if (flags.muteUntil !== undefined) data.muteUntil = flags.muteUntil
  if (flags.cleared) data.clearedAt = new Date()
  if (flags.wallpaper !== undefined) data.wallpaper = flags.wallpaper || null
  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId } },
    data,
  })
}

// ─── Group settings + invite links ───────────────────────────────────────────

export async function setGroupSettings(
  conversationId: string,
  userId: string,
  settings: { description?: string; onlyAdminsCanSend?: boolean },
) {
  await requireGroupAdmin(conversationId, userId)
  const data: Prisma.ConversationUpdateInput = {}
  if (settings.description !== undefined) data.description = settings.description.trim() || null
  if (settings.onlyAdminsCanSend !== undefined) data.onlyAdminsCanSend = settings.onlyAdminsCanSend
  await prisma.conversation.update({ where: { id: conversationId }, data })
  const actor = await userName(userId)
  if (settings.description !== undefined) await postSystemMessage(conversationId, `${actor} updated the group description`)
  if (settings.onlyAdminsCanSend !== undefined) {
    await postSystemMessage(
      conversationId,
      settings.onlyAdminsCanSend ? `${actor} restricted sending to admins only` : `${actor} allowed everyone to send messages`,
    )
  }
}

export async function createInvite(conversationId: string, userId: string): Promise<string> {
  await requireGroupAdmin(conversationId, userId)
  const existing = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { inviteToken: true } })
  if (existing?.inviteToken) return existing.inviteToken
  const token = randomUUID().replace(/-/g, '')
  await prisma.conversation.update({ where: { id: conversationId }, data: { inviteToken: token } })
  return token
}

export async function revokeInvite(conversationId: string, userId: string) {
  await requireGroupAdmin(conversationId, userId)
  await prisma.conversation.update({ where: { id: conversationId }, data: { inviteToken: null } })
}

export async function joinViaInvite(token: string, userId: string): Promise<string> {
  const convo = await prisma.conversation.findUnique({ where: { inviteToken: token }, select: { id: true, type: true } })
  if (!convo || convo.type !== 'GROUP') throw new Error('Invalid or expired invite link')
  const existing = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: convo.id, userId } },
  })
  if (existing) return convo.id
  await prisma.conversationMember.create({ data: { organizationId: getOrgId(), conversationId: convo.id, userId, role: 'MEMBER' } })
  await postSystemMessage(convo.id, `${await userName(userId)} joined via invite link`)
  return convo.id
}

// ─── Block / unblock ─────────────────────────────────────────────────────────

async function isPairBlocked(a: string, b: string): Promise<boolean> {
  const n = await prisma.block.count({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
  })
  return n > 0
}

export async function blockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) throw new Error('You cannot block yourself')
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    update: {},
    create: { blockerId, blockedId },
  })
}

export async function unblockUser(blockerId: string, blockedId: string) {
  await prisma.block.deleteMany({ where: { blockerId, blockedId } })
}

export async function listBlocked(userId: string): Promise<string[]> {
  const rows = await prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } })
  return rows.map((r) => r.blockedId)
}

// ─── Disappearing messages (conversation-level TTL) ──────────────────────────

export async function setDisappearing(conversationId: string, userId: string, seconds: number | null) {
  await assertMember(conversationId, userId)
  const ttl = seconds && seconds > 0 ? Math.floor(seconds) : null
  await prisma.conversation.update({ where: { id: conversationId }, data: { disappearingSeconds: ttl } })
  const actor = await userName(userId)
  await postSystemMessage(
    conversationId,
    ttl ? `${actor} turned on disappearing messages` : `${actor} turned off disappearing messages`,
  )
}

// ─── Polls ───────────────────────────────────────────────────────────────────

type PollPayload = {
  options: { id: string; text: string }[]
  multi: boolean
  votes: Record<string, string[]>
}

export async function createPoll(
  conversationId: string,
  userId: string,
  question: string,
  options: string[],
  multi: boolean,
) {
  const member = await assertMember(conversationId, userId)
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { type: true, onlyAdminsCanSend: true, isForgie: true },
  })
  if (convo?.type === 'GROUP' && convo.onlyAdminsCanSend && member.role !== 'OWNER' && member.role !== 'ADMIN') {
    throw new Error('Only admins can send messages in this group')
  }
  const q = question.trim()
  const opts = options.map((t) => t.trim()).filter(Boolean).slice(0, 12)
  if (!q) throw new Error('Poll question is required')
  if (opts.length < 2) throw new Error('A poll needs at least 2 options')

  const poll: PollPayload = { options: opts.map((text, i) => ({ id: `o${i}`, text })), multi: !!multi, votes: {} }
  const [message] = await prisma.$transaction([
    prisma.chatMessage.create({
      data: {
        organizationId: getOrgId(),
        conversationId,
        senderId: userId,
        kind: 'USER',
        type: 'POLL',
        content: q,
        poll: poll as unknown as Prisma.InputJsonValue,
      },
      include: { sender: { select: memberUserSelect } },
    }),
    prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } }),
    prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: new Date() },
    }),
  ])
  void notifyNewMessage(conversationId, userId, `Poll: ${q}`)
  return message
}

export async function votePoll(messageId: string, userId: string, optionId: string) {
  const msg = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { conversationId: true, poll: true, type: true },
  })
  if (!msg || msg.type !== 'POLL' || !msg.poll) throw new Error('Poll not found')
  await assertMember(msg.conversationId, userId)

  const poll = msg.poll as unknown as PollPayload
  if (!poll.options.some((o) => o.id === optionId)) throw new Error('Invalid option')
  const votes = poll.votes || {}
  for (const o of poll.options) if (!Array.isArray(votes[o.id])) votes[o.id] = []

  const already = votes[optionId].includes(userId)
  if (poll.multi) {
    votes[optionId] = already ? votes[optionId].filter((u) => u !== userId) : [...votes[optionId], userId]
  } else {
    for (const k of Object.keys(votes)) votes[k] = votes[k].filter((u) => u !== userId)
    if (!already) votes[optionId] = [...votes[optionId], userId]
  }
  poll.votes = votes

  return prisma.chatMessage.update({
    where: { id: messageId },
    data: { poll: poll as unknown as Prisma.InputJsonValue },
    include: { sender: { select: memberUserSelect } },
  })
}
