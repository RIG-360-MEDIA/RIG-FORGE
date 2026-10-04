import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-request tenant context.
 *
 * Multi-tenancy enforcement (Phase 3). `verifyToken` calls `setOrgContext` with
 * the caller's organizationId (from their JWT) for the remainder of the request's
 * async execution — so the Prisma org-scope extension (lib/db.ts) can transparently
 * scope every query without threading the org through 95 route handlers.
 *
 * When there is no context (cron jobs, seed scripts, code that runs before auth),
 * `getOrgId()` falls back to the single-org default, which is correct today.
 */
interface TenantStore {
  organizationId: string
  /** True only for a request whose org came from a verified login token (or an
   *  explicit runWithOrg). Lookups by unique key are company-filtered ONLY when
   *  this is set — see lib/db.ts. Absent for login, webhooks and crons. */
  fromRequest?: boolean
  /** Set by withoutOrgScope() for the few lookups that must be global. */
  unscoped?: boolean
}

const storage = new AsyncLocalStorage<TenantStore>()

export const DEFAULT_ORG = 'rig360'

/**
 * Bind the org for the rest of the current request's async execution.
 * Uses enterWith (not run) so it can be called from inside the synchronous
 * verifyToken without wrapping every handler in a callback.
 */
export function setOrgContext(organizationId: string): void {
  storage.enterWith({ organizationId, fromRequest: true })
}

/** Run `fn` within an explicit org context (crons / scripts / background jobs,
 *  or acting on behalf of a specific user, e.g. sending mail as them). */
export function runWithOrg<T>(organizationId: string, fn: () => PromiseLike<T> | T): Promise<T> {
  // Awaited inside run() for the same reason as withoutOrgScope below.
  return storage.run({ organizationId, fromRequest: true }, async () => await fn())
}

/** The current request's org, or the single-org default when there's no context. */
export function getOrgId(): string {
  return storage.getStore()?.organizationId ?? DEFAULT_ORG
}

/**
 * The org to filter lookups-by-unique-key with, or undefined when there is no
 * authenticated context (login, webhooks, crons) or inside withoutOrgScope().
 *
 * Deliberately NOT falling back to DEFAULT_ORG: login looks a user up by email
 * before their company is known, and would lock every non-rig360 user out if
 * the lookup were filtered to the default.
 */
export function getRequestOrgId(): string | undefined {
  const s = storage.getStore()
  return s && s.fromRequest && !s.unscoped ? s.organizationId : undefined
}

/** True inside withoutOrgScope(). */
export function isOrgScopeDisabled(): boolean {
  return storage.getStore()?.unscoped === true
}

/**
 * Run `fn` with ALL company filtering switched off.
 *
 * Only for READ-ONLY checks against columns that are unique across every
 * company — User.email and User.whatsappNumber — where "is this taken?" has to
 * look at all companies or the database rejects the save with an unhelpful
 * error. Never wrap writes, and never wrap anything that returns data to the
 * caller beyond a yes/no.
 */
export function withoutOrgScope<T>(fn: () => PromiseLike<T> | T): Promise<T> {
  const s = storage.getStore()
  // Awaited INSIDE run(): a Prisma query is lazy and only executes when awaited,
  // so returning it unawaited would run it after this context has already ended.
  return storage.run({ organizationId: s?.organizationId ?? DEFAULT_ORG, fromRequest: s?.fromRequest, unscoped: true }, async () => await fn())
}
