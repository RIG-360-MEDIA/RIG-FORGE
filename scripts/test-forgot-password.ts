/**
 * Offline test for POST /api/auth/forgot-password.
 *
 * Touches NO database: `@/lib/db` and `@/lib/push/send` are replaced in the
 * module cache with in-memory fakes before the route is loaded. The real
 * lib/tenant-context and lib/permissions are used, and every fake query records
 * the company context it ran under, so tenant scoping is checked too.
 *
 * Run: npx tsx scripts/test-forgot-password.ts
 */
import Module from 'node:module'
import path from 'node:path'

import { getOrgId, getRequestOrgId, isOrgScopeDisabled } from '@/lib/tenant-context'

// ─── In-memory data ──────────────────────────────────────────────────────────

interface FakeUser {
  id: string
  organizationId: string
  name: string
  email: string
  role: 'SUPER_ADMIN' | 'ADMIN' | 'EMPLOYEE'
  isActive: boolean
  isOnboarding: boolean
  customRole: { permissions: string[]; isExternal: boolean } | null
}

interface FakeNotification {
  id: string
  organizationId: string
  userId: string
  type: string
  title: string
  body: string
  linkTo: string | null
  read: boolean
  createdAt: Date
}

const u = (id: string, organizationId: string, role: FakeUser['role'], extra: Partial<FakeUser> = {}): FakeUser => ({
  id, organizationId, role, name: id, email: `${id}@${organizationId}.test`,
  isActive: true, isOnboarding: false, customRole: null, ...extra,
})

const users: FakeUser[] = [
  // rig360
  u('sa1', 'rig360', 'SUPER_ADMIN'),
  u('sa2', 'rig360', 'SUPER_ADMIN'),
  u('ad1', 'rig360', 'ADMIN'),
  u('ad2', 'rig360', 'ADMIN', { customRole: { permissions: ['members.view'], isExternal: false } }),
  u('emp1', 'rig360', 'EMPLOYEE'),
  u('emp2', 'rig360', 'EMPLOYEE'),
  u('mgr', 'rig360', 'EMPLOYEE', { customRole: { permissions: ['members.view', 'members.reset_password'], isExternal: false } }),
  u('resetonly', 'rig360', 'EMPLOYEE', { customRole: { permissions: ['members.reset_password'], isExternal: false } }),
  u('ext', 'rig360', 'EMPLOYEE', { customRole: { permissions: ['members.view', 'members.reset_password'], isExternal: true } }),
  u('inactiveadmin', 'rig360', 'ADMIN', { isActive: false }),
  u('onboardadmin', 'rig360', 'ADMIN', { isOnboarding: true }),
  u('gone', 'rig360', 'EMPLOYEE', { isActive: false }),
  // trijya
  u('tsa', 'trijya', 'SUPER_ADMIN'),
  u('tad', 'trijya', 'ADMIN'),
  u('temp', 'trijya', 'EMPLOYEE', { name: 'Trijya Employee' }),
  u('tsa2', 'trijya', 'SUPER_ADMIN'),
  // A company whose only privileged user is the requester.
  u('solo', 'solo', 'ADMIN'),
]

const notifications: FakeNotification[] = []
let notifSeq = 0

// ─── Query recorder + where matcher ──────────────────────────────────────────

interface Call { op: string; org: string; reqOrg: string | undefined; unscoped: boolean; where?: unknown }
const calls: Call[] = []
function record(op: string, where?: unknown): void {
  calls.push({ op, org: getOrgId(), reqOrg: getRequestOrgId(), unscoped: isOrgScopeDisabled(), where })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matches(row: any, where: Record<string, any> | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k]
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('not' in cond && v === cond.not) return false
      if ('in' in cond && !cond.in.includes(v)) return false
      if ('gte' in cond && !(v >= cond.gte)) return false
      return true
    }
    return v === cond
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(row: any, select: Record<string, unknown> | undefined): any {
  if (!select) return { ...row }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(select)) out[k] = row[k]
  return out
}

/** Emulates the org-scope extension for list queries with no explicit org. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scoped(where: any): any {
  if (isOrgScopeDisabled()) return where
  return { ...(where ?? {}), organizationId: where?.organizationId ?? getOrgId() }
}

const fakePrisma = {
  user: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async findUnique({ where, select }: any) {
      record('user.findUnique', where)
      const reqOrg = getRequestOrgId()
      const w = reqOrg ? { ...where, organizationId: reqOrg } : where
      const row = users.find((r) => matches(r, w))
      return row ? pick(row, select) : null
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async findFirst({ where, select }: any) {
      record('user.findFirst', where)
      const row = users.find((r) => matches(r, scoped(where)))
      return row ? pick(row, select) : null
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async findMany({ where, select }: any) {
      record('user.findMany', where)
      return users.filter((r) => matches(r, scoped(where))).map((r) => pick(r, select))
    },
  },
  notification: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async findMany({ where, select }: any) {
      record('notification.findMany', where)
      return notifications.filter((r) => matches(r, scoped(where))).map((r) => pick(r, select))
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async createMany({ data }: any) {
      record('notification.createMany')
      for (const d of data) {
        notifications.push({
          id: `n${++notifSeq}`, read: false, createdAt: new Date(), linkTo: null,
          ...d, organizationId: d.organizationId ?? getOrgId(),
        })
      }
      return { count: data.length }
    },
  },
}

interface PushCall { userIds: string[]; payload: { title: string; body: string; url?: string }; org: string }
const pushCalls: PushCall[] = []
let pushShouldFail = false
async function fakeSendPushToUsers(userIds: string[], payload: PushCall['payload']): Promise<void> {
  pushCalls.push({ userIds, payload, org: getOrgId() })
  if (pushShouldFail) throw new Error('simulated push failure')
}

// ─── Install fakes, then load the route ──────────────────────────────────────

function stub(relPath: string, exportsObj: unknown): void {
  const file = require.resolve(path.resolve(__dirname, '..', relPath))
  const m = new Module(file)
  m.filename = file
  m.loaded = true
  m.exports = exportsObj
  require.cache[file] = m
}
stub('lib/db.ts', { prisma: fakePrisma })
stub('lib/push/send.ts', { sendPushToUsers: fakeSendPushToUsers })

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require('../app/api/auth/forgot-password/route') as typeof import('../app/api/auth/forgot-password/route')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NextRequest } = require('next/server') as typeof import('next/server')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EXPECTED_BODY = JSON.stringify({
  data: { message: "If that email belongs to an account, your company's administrators have been notified. They will reset your password and give you a temporary one." },
  error: null,
})

let failures = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  PASS  ${name}`)
  else { failures++; console.log(`  FAIL  ${name}`, detail ?? '') }
}

let ipSeq = 0
async function send(body: unknown, ip = `10.0.0.${++ipSeq}`, raw = false): Promise<{ status: number; text: string }> {
  const req = new NextRequest('http://localhost/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 172.16.0.1` },
    body: raw ? (body as string) : JSON.stringify(body),
  })
  const res = await POST(req)
  const text = await res.text()
  // The work runs after the response; give it a moment to finish.
  await new Promise((r) => setTimeout(r, 30))
  return { status: res.status, text }
}

function newNotificationsSince(n: number): FakeNotification[] { return notifications.slice(n) }
const sorted = (a: string[]) => [...a].sort()
const same = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

async function scenario(
  name: string,
  body: unknown,
  expectRecipients: string[],
  opts: { ip?: string; raw?: boolean; expectOrg?: string } = {},
): Promise<FakeNotification[]> {
  console.log(`\n${name}`)
  const before = notifications.length
  const callsBefore = calls.length
  const pushBefore = pushCalls.length
  const res = await send(body, opts.ip, opts.raw)
  check('status 200', res.status === 200, res.status)
  check('identical response body', res.text === EXPECTED_BODY, res.text)
  const created = newNotificationsSince(before)
  check(`recipients = [${expectRecipients.join(', ')}]`, same(created.map((n) => n.userId), expectRecipients), created.map((n) => n.userId))
  if (opts.expectOrg) {
    const mine = calls.slice(callsBefore)
    const lookup = mine[0]
    check('email lookup is unscoped (withoutOrgScope)', !!lookup && lookup.op === 'user.findUnique' && lookup.unscoped, lookup)
    const rest = mine.slice(1)
    check(`every later query ran in org "${opts.expectOrg}"`, rest.every((c) => c.org === opts.expectOrg && c.reqOrg === opts.expectOrg), rest.map((c) => `${c.op}@${c.org}`))
    check('notifications stamped with that org', created.every((n) => n.organizationId === opts.expectOrg))
    const recipientOrgs = created.map((n) => users.find((x) => x.id === n.userId)?.organizationId)
    check('recipients belong to that org', recipientOrgs.every((o) => o === opts.expectOrg), recipientOrgs)
  }
  const pushes = pushCalls.slice(pushBefore)
  if (expectRecipients.length > 0) {
    check('push sent to the same recipients, in the same org', pushes.length === 1 && same(pushes[0].userIds, expectRecipients) && pushes[0].org === (opts.expectOrg ?? pushes[0].org), pushes)
  } else {
    check('no push sent', pushes.length === 0, pushes)
  }
  return created
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const trijya = await scenario('Trijya employee (mixed-case email with spaces)', { email: '  TEMP@Trijya.TEST ' }, ['tsa', 'tad', 'tsa2'], { expectOrg: 'trijya' })
  const n = trijya[0]
  check('type ADMIN_MESSAGE', n?.type === 'ADMIN_MESSAGE', n?.type)
  check('title', n?.title === 'Password reset requested', n?.title)
  check('body', n?.body === 'Trijya Employee (temp@trijya.test) asked for a password reset from the login page.', n?.body)
  check('linkTo opens the member slide-over', n?.linkTo === '/dashboard/people?member=temp', n?.linkTo)

  await scenario(
    'rig360 employee: SUPER_ADMINs, ADMIN, custom role with view+reset; not view-less admin, reset-only, external, inactive, onboarding',
    { email: 'emp1@rig360.test' },
    ['sa1', 'sa2', 'ad1', 'mgr'],
    { expectOrg: 'rig360' },
  )

  await scenario('rig360 ADMIN target: SUPER_ADMINs only', { email: 'ad1@rig360.test' }, ['sa1', 'sa2'], { expectOrg: 'rig360' })
  await scenario('SUPER_ADMIN target: nobody can reset, nothing sent', { email: 'sa1@rig360.test' }, [])
  await scenario('ADMIN target in a company with no SUPER_ADMIN: nothing sent', { email: 'solo@solo.test' }, [])
  await scenario('Unknown email: nothing sent', { email: 'nobody@nowhere.test' }, [])
  await scenario('Deactivated account: nothing sent', { email: 'gone@rig360.test' }, [])

  await scenario('Invalid JSON', '{not json', [], { raw: true })
  await scenario('Missing email', {}, [])
  await scenario('Not an email', { email: 'hello' }, [])
  await scenario('Email over 254 chars', { email: `${'a'.repeat(250)}@x.test` }, [])

  // De-dupe: emp1 was already notified above; a second request creates nothing.
  await scenario('Duplicate request within 6h: no new notifications', { email: 'emp1@rig360.test' }, [])
  // Once one recipient reads theirs, only that recipient gets a fresh one.
  const sa1Notif = notifications.find((x) => x.userId === 'sa1' && x.linkTo === '/dashboard/people?member=emp1')
  if (sa1Notif) sa1Notif.read = true
  // emp1 has now used 2 of 3 per-email requests.
  await scenario('After sa1 read theirs: only sa1 notified again', { email: 'emp1@rig360.test' }, ['sa1'], { expectOrg: 'rig360' })

  // Per-email limit (3 per hour): emp1 has used 3; a 4th from a fresh IP is dropped.
  const n2 = notifications.find((x) => x.userId === 'ad1' && x.linkTo === '/dashboard/people?member=emp1')
  if (n2) n2.read = true // would otherwise be re-notified
  await scenario('Per-email limit: 4th request in the hour is dropped', { email: 'emp1@rig360.test' }, [])

  // Per-IP limit (5 per 15 min).
  console.log('\nPer-IP limit: 6th request from one IP is dropped')
  const ip = '203.0.113.9'
  for (let i = 0; i < 5; i++) await send({ email: `unknown${i}@nowhere.test` }, ip)
  await scenario('  6th request (a real account) from the same IP', { email: 'emp2@rig360.test' }, [], { ip })
  await scenario('  same account from another IP still works', { email: 'emp2@rig360.test' }, ['sa1', 'sa2', 'ad1', 'mgr'], { expectOrg: 'rig360' })

  // Push failure must not break anything.
  pushShouldFail = true
  await scenario('Push failure is non-fatal', { email: 'tad@trijya.test' }, ['tsa', 'tsa2'], { expectOrg: 'trijya' })
  pushShouldFail = false

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
