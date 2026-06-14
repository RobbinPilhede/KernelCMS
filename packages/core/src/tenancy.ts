import type { Where } from '@kernel/db'
import { asWhere } from './access'
import type {
  AccessArgs,
  AccessFn,
  AccessResult,
  CollectionConfig,
  KernelConfig,
  RequestContext,
  SanitizedTenancy,
} from './types'

/** Keys that must never become the tenant FIELD NAME or be used as a map key — a tenant
 *  field/value flowing into a `Where`/`Row` must never poison `Object.prototype`. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** A safe snake_case identifier (matches the rest of the config's field-name rule). */
const IDENT_RE = /^[a-z][a-z0-9_]*$/

/** Default tenant field name when `tenancy.field` is omitted. */
const DEFAULT_TENANT_FIELD = 'tenant'

/**
 * Resolve the opt-in multi-tenancy setting. OFF (`enabled:false`) unless configured —
 * so when absent NOTHING changes (no tenant field injected, no access wrapped), exactly
 * like RBAC/audit when unset.
 *
 * Validates the tenant `field` is a safe snake_case identifier (it becomes a real column,
 * a `Where` key, and an auto-stamped `Row` key — a hostile value would be a prototype-
 * pollution / injection vector). When `collections` is given it is validated against real,
 * non-system collection slugs; when omitted it defaults to ALL non-system, non-auth
 * collections (resolved by the caller against the final collection list). `requireTenant`
 * defaults TRUE (fail-closed: a principal with no tenant sees nothing in scoped
 * collections). `resolve` defaults to reading the trusted `req.user.tenant` claim.
 */
export function sanitizeTenancy(
  tenancy: KernelConfig['tenancy'],
  collections: CollectionConfig[],
  systemSlugs: ReadonlySet<string>,
  assert: (condition: unknown, message: string) => asserts condition,
): SanitizedTenancy {
  if (!tenancy) {
    return {
      enabled: false,
      field: DEFAULT_TENANT_FIELD,
      collections: [],
      requireTenant: true,
      resolve: defaultResolve,
    }
  }

  const field = tenancy.field ?? DEFAULT_TENANT_FIELD
  assert(
    typeof field === 'string' && IDENT_RE.test(field) && !FORBIDDEN_KEYS.has(field),
    `tenancy.field "${field}" must be a safe snake_case identifier`,
  )

  const bySlug = new Map(collections.map((c) => [c.slug, c]))
  let scoped: string[]
  if (tenancy.collections !== undefined) {
    assert(Array.isArray(tenancy.collections), 'tenancy.collections must be an array of collection slugs')
    for (const slug of tenancy.collections) {
      assert(
        typeof slug === 'string' && bySlug.has(slug) && !systemSlugs.has(slug),
        `tenancy references unknown or system collection "${slug}"`,
      )
    }
    scoped = [...tenancy.collections]
  } else {
    // Default: every non-system, non-auth collection. Auth collections (the user accounts
    // that CARRY the tenant claim) are excluded by default — scoping the principal store to
    // itself would lock admins out of provisioning users across tenants.
    scoped = collections.filter((c) => !systemSlugs.has(c.slug) && !c.auth).map((c) => c.slug)
  }

  const resolve = typeof tenancy.resolve === 'function' ? tenancy.resolve : defaultResolve

  return {
    enabled: true,
    field,
    collections: scoped,
    requireTenant: tenancy.requireTenant !== false,
    resolve,
  }
}

/** The default tenant resolver: the trusted `tenant` claim on the authenticated principal.
 *  NEVER a client query/body/header value — the claim lives on `req.user`, which only the
 *  auth layer can set. Coerced to a non-empty string; anything else means "no tenant". */
function defaultResolve(req: RequestContext): string | null | undefined {
  const raw = req.user?.tenant
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/** Resolve the acting tenant for a request, guarding the resolved value: it must be a
 *  non-empty string that is not a prototype-pollution key (it becomes a `Where`/`Row`
 *  value keyed by the tenant field). Anything else collapses to null ("no tenant"). */
export function resolveTenant(tenancy: SanitizedTenancy, req: RequestContext): string | null {
  const raw = tenancy.resolve(req)
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (FORBIDDEN_KEYS.has(raw)) return null
  return raw
}

/** A `Where` that matches NOTHING — the fail-closed scope for a tenant-less principal
 *  under `requireTenant`. `matchesWhere`/the adapters treat an empty `or` as "deny all". */
const DENY_ALL: Where = { or: [] }

/**
 * Combine the user's own access result with the tenant scope, mirroring how the access
 * pipeline already AND-combines a user `Where` with system scopes:
 *
 * - user `false`  → stays `false` (tenancy never WIDENS a denial).
 * - user `true`   → becomes the tenant `Where` (now row-scoped to the tenant).
 * - user `Where`  → becomes `{ and: [userWhere, tenantWhere] }` (both must hold).
 *
 * When the principal has NO tenant: under `requireTenant` the result is an impossible
 * scope (deny-all) so scoped content is invisible (fail-closed); otherwise the user's
 * result passes through unchanged.
 */
function combine(userResult: AccessResult, tenant: string | null, tenancy: SanitizedTenancy): AccessResult {
  if (userResult === false) return false
  if (tenant === null) {
    // No tenant claim. Fail closed when required; otherwise leave the user's result intact
    // (so a non-required deployment behaves as if tenancy weren't scoping this principal).
    return tenancy.requireTenant ? DENY_ALL : userResult
  }
  const tenantWhere: Where = { [tenancy.field]: { equals: tenant } }
  const userWhere = asWhere(userResult)
  return userWhere ? { and: [userWhere, tenantWhere] } : tenantWhere
}

/**
 * Enforce multi-tenancy by INJECTION, mirroring {@link injectRbac}. For each scoped
 * collection, wrap `access.read/create/update/delete` so the effective rule is the
 * principal's OWN access AND a tenant scope, evaluated per request. The wrapper:
 *
 *  - Bypasses tenancy entirely under `overrideAccess` — there is no `req` for an
 *    override path; the operation code never calls the access fn when `overrideAccess`
 *    is set, so the trusted-server escape hatch (migrations/admin tooling, cross-tenant
 *    seeding) is honoured without any special-casing here.
 *  - Resolves the tenant from the PRINCIPAL via `tenancy.resolve` (default `req.user.tenant`)
 *    — never from a client-supplied param.
 *  - AND-combines the tenant `Where` into the user's result (see {@link combine}), so the
 *    existing find/findByID/update/delete/count pipeline auto-filters by tenant. A
 *    tenant-less principal under `requireTenant` gets a deny-all scope (fail-closed).
 *
 * An ORIGINAL access fn (explicit OR rbac-injected) is preserved and called first, then
 * the tenant scope is layered on top — tenancy NARROWS, never replaces or widens, the
 * collection's own authorization. When no original fn exists the secure-by-default base
 * (authenticated-only) is used, exactly as {@link evalAccess} would.
 *
 * Mutates the scoped collections' `access` objects in place. No-op unless tenancy is
 * enabled, so a non-tenant config is byte-identical to before.
 */
export function injectTenancy(tenancy: SanitizedTenancy, collections: CollectionConfig[]): void {
  if (!tenancy.enabled) return
  const scoped = new Set(tenancy.collections)
  for (const collection of collections) {
    if (!scoped.has(collection.slug)) continue
    const access = (collection.access = { ...collection.access })
    for (const op of ['read', 'create', 'update', 'delete'] as const) {
      const original = access[op]
      access[op] = wrapAccess(original, tenancy)
    }
  }
}

/** Build the tenant-scoping wrapper around an (optional) original access fn. The original
 *  is evaluated with the SAME args first (preserving its boolean/`Where` semantics), then
 *  the tenant scope is AND-combined onto the result. */
function wrapAccess(original: AccessFn | undefined, tenancy: SanitizedTenancy): AccessFn {
  return async (args: AccessArgs): Promise<AccessResult> => {
    // Mirror evalAccess's secure-by-default base: with no original rule, allow only an
    // authenticated principal (then tenant-scope it). This keeps deny-by-default intact.
    const base: AccessResult = original ? await original(args) : Boolean(args.req.user)
    const tenant = resolveTenant(tenancy, args.req)
    return combine(base, tenant, tenancy)
  }
}
