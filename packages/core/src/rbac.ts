import type { AuthUser, CollectionConfig, GlobalConfig, OpGrant, RbacConfig, RbacOp, RbacStore, RoleDef } from './types'

/** Storage table holding runtime-editable role definitions. Provisioned only when
 *  `config.rbac` is set. `name` is the PK; `def` is the JSON {@link RoleDef}. */
export const ROLES_TABLE = '_roles'

/** The canonical role the auth layer has always trusted (`isAdminUser`): a principal
 *  whose `roles` includes the literal 'admin' is a full admin. Preserved so enabling
 *  RBAC never demotes an existing admin convention. */
const LITERAL_ADMIN_ROLE = 'admin'

/** The operations RBAC can grant. `publish` only applies to drafts-enabled collections. */
const ALL_OPS: readonly RbacOp[] = ['read', 'create', 'update', 'delete', 'publish']

/** Create the mutable runtime store. The injected access closures capture this object
 *  by reference, so any later mutation (createRole/updateRole/deleteRole) takes effect
 *  on the very next access check — no recompile, no restart. */
export function createRbacStore(config: RbacConfig | undefined): RbacStore {
  const roles: Record<string, RoleDef> = {}
  // Seed from config. A deep-ish copy keeps the live store independent of the user's
  // config object (so a later in-place config mutation can't silently change grants).
  if (config?.roles) {
    for (const [name, def] of Object.entries(config.roles)) roles[name] = cloneRoleDef(def)
  }
  return { roles }
}

/** A defensive copy of a RoleDef so the live store and any persisted/seed copy never
 *  alias the same nested objects. */
export function cloneRoleDef(def: RoleDef): RoleDef {
  const out: RoleDef = {}
  if (def.description !== undefined) out.description = def.description
  if (def.admin !== undefined) out.admin = def.admin
  if (def.collections) out.collections = cloneGrants(def.collections)
  if (def.globals) out.globals = cloneGrants(def.globals)
  return out
}

function cloneGrants(grants: Record<string, OpGrant>): Record<string, OpGrant> {
  const out: Record<string, OpGrant> = {}
  for (const [slug, grant] of Object.entries(grants)) {
    out[slug] = grant === true ? true : [...grant]
  }
  return out
}

/** Whether a grant covers an op (`true` = all ops, else membership in the list). */
function grantAllows(grant: OpGrant | undefined, op: RbacOp): boolean {
  if (grant === undefined) return false
  if (grant === true) return true
  return grant.includes(op)
}

/** A principal is an admin if any of its roles is the literal 'admin' (legacy
 *  convention) OR maps to a live role with `admin: true`. Admins bypass per-op grants. */
function isAdminPrincipal(store: RbacStore, roles: readonly string[]): boolean {
  for (const role of roles) {
    if (role === LITERAL_ADMIN_ROLE) return true
    if (store.roles[role]?.admin === true) return true
  }
  return false
}

/** The single RBAC decision used by every injected access rule. Returns true when the
 *  principal is an admin, or when ANY of its roles grants `op` on the target resource in
 *  the LIVE store. Anonymous principals (no user) and principals with no matching grant
 *  get false — preserving deny-by-default. Globals and collections are symmetric. */
export function rbacAllows(
  store: RbacStore,
  user: AuthUser | null | undefined,
  target: { kind: 'collection' | 'global'; slug: string; op: RbacOp },
): boolean {
  const roles = user?.roles
  if (!Array.isArray(roles) || roles.length === 0) return false
  if (isAdminPrincipal(store, roles)) return true
  for (const role of roles) {
    const def = store.roles[role]
    if (!def) continue
    const grants = target.kind === 'collection' ? def.collections : def.globals
    if (grantAllows(grants?.[target.slug], target.op)) return true
  }
  return false
}

/**
 * Enforce RBAC by INJECTION. For each collection × op (read/create/update/delete, plus
 * publish on drafts collections) and each global × op (read/update) that has NO explicit
 * `access[op]`, install a closure delegating to {@link rbacAllows} against the live store.
 *
 * Where an explicit access fn already exists it is LEFT UNTOUCHED — it wins, so existing
 * configs behave exactly as before. The injected closures capture `store` by reference,
 * which is what makes runtime role edits take effect immediately.
 *
 * Mutates the collection/global `access` objects in place (the sanitized config owns
 * fresh objects). No-op overall unless `config.rbac` is present, so when RBAC is absent
 * nothing here runs and the deny-by-default-with-no-rule behaviour is fully preserved.
 */
export function injectRbac(
  store: RbacStore,
  collections: CollectionConfig[],
  globals: GlobalConfig[],
  draftsEnabled: (collection: CollectionConfig) => boolean,
): void {
  for (const collection of collections) {
    const access = (collection.access = { ...collection.access })
    const ops: RbacOp[] = ['read', 'create', 'update', 'delete']
    // `publish` is only a meaningful, separately-gated op on drafts collections.
    if (draftsEnabled(collection)) ops.push('publish')
    for (const op of ops) {
      if (access[op]) continue // explicit rule wins — never override
      access[op] = ({ req }) => rbacAllows(store, req.user, { kind: 'collection', slug: collection.slug, op })
    }
  }
  for (const global of globals) {
    const access = (global.access = { ...global.access })
    // Globals only support read/update.
    for (const op of ['read', 'update'] as const) {
      if (access[op]) continue
      access[op] = ({ req }) => rbacAllows(store, req.user, { kind: 'global', slug: global.slug, op })
    }
  }
}

/** Validate a RoleDef supplied at runtime (createRole/updateRole). Throws a plain Error
 *  with a clear message on the first violation; the HTTP/Local layers map it to a 400. */
export function assertValidRoleDef(name: string, def: unknown): asserts def is RoleDef {
  if (typeof name !== 'string' || name.length === 0) throw new Error('A non-empty role `name` is required.')
  if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error('A role definition object is required.')
  const d = def as Record<string, unknown>
  if (d.description !== undefined && typeof d.description !== 'string') {
    throw new Error('`description` must be a string.')
  }
  if (d.admin !== undefined && typeof d.admin !== 'boolean') throw new Error('`admin` must be a boolean.')
  assertValidGrants('collections', d.collections)
  assertValidGrants('globals', d.globals)
}

function assertValidGrants(key: string, grants: unknown): void {
  if (grants === undefined) return
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) {
    throw new Error(`\`${key}\` must be a map of slug to grant.`)
  }
  for (const [slug, grant] of Object.entries(grants as Record<string, unknown>)) {
    if (grant === true) continue
    if (!Array.isArray(grant) || !grant.every((op) => (ALL_OPS as readonly string[]).includes(op as string))) {
      throw new Error(`\`${key}.${slug}\` must be \`true\` or an array of ${ALL_OPS.join('/')}.`)
    }
  }
}
