import { PrismaClient } from '@prisma/client'

import { getOrgId, getRequestOrgId, isOrgScopeDisabled } from '@/lib/tenant-context'

/**
 * Every table that carries an organizationId (the 30 tenant tables). Queries on
 * these are auto-scoped to the caller's org by the org-scope extension below.
 * Excludes Organization (the tenant registry) and WhatsappAuth (bridge infra).
 *
 * A model MISSING from this Set silently mis-stamps: creates fall back to the
 * `@default("rig360")` column default, so another tenant's row lands in rig360
 * and is invisible to the org that made it. CustomRole was missing until
 * 2026-08-24 and did exactly that. When adding a model with an organizationId,
 * add it here in the same change.
 */
const TENANT_MODELS = new Set<string>([
  'User', 'Client', 'Project', 'ProjectMember', 'Task', 'Ticket', 'TicketComment',
  'DailyLog', 'DailyActivity', 'WeeklyReport', 'TaskThread', 'ProjectThread',
  'ThreadMessage', 'Notification', 'AssistantConversation', 'AssistantMessage',
  'AssistantUsage', 'AssistantResponseCache', 'AssistantAuditLog', 'DailyLogDraft',
  'GoogleIntegration', 'StandupDigest', 'Conversation', 'ConversationMember',
  'ChatMessage', 'MessageReaction', 'MessageStar', 'Block', 'PushSubscription',
  'Issue', 'CustomRole', 'NasIndexedFile', 'BylawsIndexedFile',
  'BylawsReindexRun', 'NasReindexRun',
])

/**
 * Prisma error codes that indicate the underlying connection went bad
 * (typical when Render's dyno cycles and the pgbouncer pool ends up
 * with stale TCP connections to Supabase). When we hit one of these,
 * we drop the pool, wait a moment, and retry the operation once.
 */
const RETRYABLE_CODES = new Set<string>([
  'P1001', // Can't reach database server
  'P1002', // Database server connection timed out
  'P1017', // Server has closed the connection
  'P2024', // Timed out fetching a new connection from the connection pool
])

const RETRY_DELAY_MS = 500

function makePrisma() {
  const base = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  })

  return base
    .$extends({
      name: 'auto-retry-on-stale-connection',
      query: {
        async $allOperations({ args, query }) {
          try {
            return await query(args)
          } catch (err) {
            const e = err as { code?: string; name?: string }
            const isInitError = e?.name === 'PrismaClientInitializationError'
            const code = typeof e?.code === 'string' ? e.code : undefined
            const isRetryable = isInitError || (code !== undefined && RETRYABLE_CODES.has(code))

            if (!isRetryable) throw err

            // Drop the stale pool and retry once. Prisma reconnects lazily
            // on the next query, so the retry will use fresh connections.
            try {
              await base.$disconnect()
            } catch {
              // ignore — disconnect can race during shutdown, never fatal
            }
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))

            if (process.env.NODE_ENV === 'production') {
              console.warn(
                `[prisma] retried operation after ${code ?? e?.name ?? 'unknown error'} (non-fatal)`,
              )
            }

            return query(args)
          }
        },
      },
    })
    .$extends({
      // ── Multi-tenancy: auto-scope every tenant-model query to the caller's org.
      // The org comes from lib/tenant-context (set by verifyToken per request);
      // outside a request it defaults to the single-org "rig360".
      //
      // Scoped: list/aggregate/bulk + inserts, and — when the caller's company is
      // KNOWN (a verified login token, or runWithOrg) — every lookup by unique
      // key too: findUnique / findUniqueOrThrow / update / delete / upsert.
      //
      // Lookups by unique key used to be left unscoped on the theory that cuid
      // ids are unguessable. They are not secret, though: they appear in URLs,
      // links, notifications and API responses. Leaving them unscoped let a
      // signed-in user of one company read another company's project — name,
      // description, members, links — by its id (confirmed on production,
      // 2026-10-03; 184 such call sites across 64 files). Filtering here closes
      // all of them at once, and any added later.
      //
      // When the company is NOT known (login, webhooks, crons) those lookups stay
      // unscoped, exactly as before: login finds a user by email before their
      // company is known, and filtering it to the rig360 default would lock out
      // every other company. Those paths are gated by their own secrets.
      //
      // Prisma 5 allows a non-unique field (organizationId) alongside the unique
      // key in these `where` clauses. A record in another company is then simply
      // not found: findUnique returns null, update/delete throw P2025.
      name: 'org-scope',
      query: {
        $allModels: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async $allOperations({ model, operation, args, query }: any) {
            if (!TENANT_MODELS.has(model)) return query(args)
            const org = getOrgId()
            const reqOrg = getRequestOrgId()     // undefined → don't filter unique lookups
            const unscoped = isOrgScopeDisabled() // withoutOrgScope(): global read-only checks
            const a = args ?? {}
            switch (operation) {
              case 'create':
                if (a.data && a.data.organizationId === undefined) {
                  a.data = { ...a.data, organizationId: org }
                }
                break
              case 'createMany':
                if (Array.isArray(a.data)) {
                  a.data = a.data.map((d: Record<string, unknown>) =>
                    d.organizationId === undefined ? { ...d, organizationId: org } : d,
                  )
                } else if (a.data && a.data.organizationId === undefined) {
                  a.data = { ...a.data, organizationId: org }
                }
                break
              case 'upsert':
                if (a.create && a.create.organizationId === undefined) {
                  a.create = { ...a.create, organizationId: org }
                }
                if (reqOrg) a.where = { ...(a.where ?? {}), organizationId: a.where?.organizationId ?? reqOrg }
                break
              case 'findMany':
              case 'findFirst':
              case 'findFirstOrThrow':
              case 'count':
              case 'aggregate':
              case 'groupBy':
              case 'updateMany':
              case 'deleteMany':
                if (!unscoped) a.where = { ...(a.where ?? {}), organizationId: a.where?.organizationId ?? org }
                break
              case 'findUnique':
              case 'findUniqueOrThrow':
              case 'update':
              case 'delete':
                if (reqOrg) a.where = { ...(a.where ?? {}), organizationId: a.where?.organizationId ?? reqOrg }
                break
              default:
                break
            }
            return query(a)
          },
        },
      },
    })
}

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof makePrisma> | undefined
}

export const prisma = globalForPrisma.prisma ?? makePrisma()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
