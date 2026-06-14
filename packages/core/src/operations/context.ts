import type { DatabaseAdapter, Logger, PaginatedResult, Where } from '@kernel/db'
import type { CollectionConfig, Doc, FindOptions, PrincipalRef, RequestContext, SanitizedConfig } from '../types'
import type { RecordAuditArgs } from '../operations'

/**
 * The shared engine context passed to every per-domain operations module.
 *
 * `operations.ts` historically grew into a single ~6.7k-line closure where ~130
 * functions all shared one scope. The decomposition splits cohesive domains
 * (collaboration, comments, saved views, …) into their own modules, each a pure
 * factory `(ctx: OpsContext) => ({ ...ops })`. The factory destructures what it
 * needs from `ctx` under the SAME local names the code already used, so the
 * function bodies move out of the monolith verbatim — no behavioural change.
 *
 * Pure, side-effect-free helpers (access evaluation, the `where` matcher, the
 * system-table name constants, the typed errors) are imported directly by each
 * module from `../access` / `../query` / `../schema` / `../errors`. Only the
 * foundational primitives and the small set of cross-cutting helpers that are
 * built inside the orchestrator live here.
 */
export interface OpsContext {
  /** The sanitized, validated kernel configuration. */
  config: SanitizedConfig
  /** The database adapter (already cache-wrapped when caching is enabled). */
  db: DatabaseAdapter
  /** Optional logger; best-effort side effects warn through it, never throw. */
  logger?: Logger
  /** Hard cap on any bulk read (mirrors the core `MAX_LIMIT`). */
  MAX_LIMIT: number
  /** Resolve a collection by slug, or throw a typed NotFound/BadRequest. */
  collectionOrThrow(slug: string): CollectionConfig
  /** Normalize a partial request context into a full one (locale/segment defaults). */
  buildReq(partial?: Partial<RequestContext>): RequestContext
  /** The principal id/kind for an op, derived from the request user (anonymous → system). */
  principalOf(req: RequestContext): { id: string; type: 'user' | 'agent' | 'system' }
  /**
   * Validate the target collection + document exist and the caller may READ it, returning
   * the collection. Denial throws NotFound (never Forbidden) so a domain op can't be used
   * to probe documents outside the caller's read scope.
   */
  assertTarget(collection: string, id: string, req: RequestContext): Promise<CollectionConfig>
  /** The core access-checked list read — domains compose it rather than touching the db. */
  find<T extends Doc = Doc>(opts: FindOptions): Promise<PaginatedResult<T>>
  /** Append one row to the append-only audit log (best-effort; never throws). */
  recordAudit(args: RecordAuditArgs): Promise<void>
  /** Assert every field a `where` references is a real, filterable column of the collection. */
  assertWhereFields(collection: CollectionConfig, where: Where | undefined): void
  /** The set of field names a `where`/`sort` may legally reference for a collection. */
  filterableFields(collection: CollectionConfig): Set<string>
  /** Whether the request principal carries the `admin` role. */
  isAdminPrincipal(req: RequestContext): boolean
  /** Whether the request principal is a reviewer (admin or editor). */
  isReviewerPrincipal(req: RequestContext): boolean
  /** Coerce a stored principal-type column into the closed union (defaults to 'user'). */
  normalizePrincipalType(value: unknown): PrincipalRef['type']
  /** Assert the caller may READ the collection (collection-level gate). Override skips it. */
  assertCanReadCollection(collection: CollectionConfig, req: RequestContext, override: boolean): Promise<void>
}
