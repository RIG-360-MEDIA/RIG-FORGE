import { PrismaClient } from '@prisma/client'

import { getOrgId } from '@/lib/tenant-context'

/**
 * Every table that carries an organizationId (the 28 tenant tables). Queries on
 * these are auto-scoped to the caller's org by the org-scope extension below.
 * Excludes Organization (the tenant registry) and WhatsappAuth (bridge infra).
 */
const TENANT_MODELS = new Set<string>([
  'User', 'Client', 'Project', 'ProjectMember', 'Task', 'Ticket', 'TicketComment',
  'DailyLog', 'DailyActivity', 'WeeklyReport', 'TaskThread', 'ProjectThread',
  'ThreadMessage', 'Notification', 'AssistantConversation', 'AssistantMessage',
  'AssistantUsage', 'AssistantResponseCache', 'AssistantAuditLog', 'DailyLogDraft',
  'GoogleIntegration', 'StandupDigest', 'Conversation', 'ConversationMember',
  'ChatMessage', 'MessageReaction', 'MessageStar', 'Block', 'PushSubscription',
  'Issue',
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
      // Scoped: list/aggregate/bulk + inserts. NOT scoped: findUnique / update /
      // delete / upsert lookups keyed by a unique field — those resolve by the
      // global cuid id (unguessable). Inserts also get organizationId from the DB
      // column default, so nested writes are covered even though this extension
      // only injects at the top level. Per-org unique constraints + org-at-login
      // are the remaining step for when a 2nd org is onboarded.
      name: 'org-scope',
      query: {
        $allModels: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async $allOperations({ model, operation, args, query }: any) {
            if (!TENANT_MODELS.has(model)) return query(args)
            const org = getOrgId()
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
                break
              case 'findMany':
              case 'findFirst':
              case 'findFirstOrThrow':
              case 'count':
              case 'aggregate':
              case 'groupBy':
              case 'updateMany':
              case 'deleteMany':
                a.where = { ...(a.where ?? {}), organizationId: a.where?.organizationId ?? org }
                break
              default:
                // findUnique / findUniqueOrThrow / update / delete: keyed by a
                // unique field (the cuid id). Left unscoped for now.
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
