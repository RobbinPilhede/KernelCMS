import type { DatabaseAdapter, Logger, MigrationJournalEntry, MigrationReport } from '@kernel/db'
import { randomUUID } from 'node:crypto'
import type {
  BackfillOptions,
  BackfillResult,
  CacheTagsOptions,
  ChangeEvent,
  ChangesOptions,
  ChangesResult,
  Doc,
  DuplicatePairResult,
  FindDuplicatesOptions,
  RelatedContentOptions,
  PurgeFeedOptions,
  PurgeFeedResult,
  GraphEdge,
  GraphNode,
  GraphOptions,
  GraphResult,
  GraphSearchOptions,
  GraphSearchResult,
  InsightsOptions,
  InsightsResult,
  Kernel,
  KernelConfig,
  TrackOptions,
  MigrateRunOptions,
  RequestContext,
  RollbackOptions,
  RollbackResult,
  SanitizedConfig,
} from './types'
import { sanitizeConfig } from './config'
import { compileSchema, MIGRATIONS_TABLE } from './schema'
import { createOperations } from './operations'
import { createDiscoverability } from './discoverability'
import { createStructuredData } from './structured-data'
import { createCachedDb } from './cache'
import { CACHE_SLUG, JOBS_SLUG } from './config'
import { BadRequestError, isKernelError } from './errors'
import { attachWebhooks } from './webhooks'
import type { WebhookEnqueue } from './webhooks'
import {
  attachChangeFeed,
  createChangeBus,
  createSeqCounter,
  makeChangeFilter,
  readChanges,
  type ChangeFeedCtx,
} from './realtime'
import { CHANGES_TABLE, WEBHOOK_DELIVERIES_TABLE } from './schema'
import { appendAnalytics, buildAnalyticsRow, computeInsights, createAnalyticsSeq, type AnalyticsCtx } from './analytics'
import { cacheTags as computeCacheTags, computePurge, purgeTagsForEvent } from './edge'
import { createWorkflowEngine, attachWorkflowTriggers } from './workflows'
import { WORKFLOW_JOB_TASK } from './config'
import { attachSearch } from './search'
import { attachSemantic, enrichedEmbeddingText, reciprocalRankFusion } from './vector'
import {
  clampPairLimit,
  clampThreshold,
  filterReadablePairs,
  findDuplicatePairs,
  MAX_DEDUP_DOCS,
  MAX_CANDIDATE_PAIRS,
} from './content-intel'
import { applyPlugins } from './plugins'
import { evalAccess } from './access'
import { ROLES_TABLE, cloneRoleDef } from './rbac'
import { storageFields } from './fields'
import {
  clampDepth,
  clampMaxNodes,
  clampSeedLimit,
  extractText,
  resolveLabel,
  traverseGraph,
  type GraphLoaders,
  type JoinNeighborQuery,
  type LoadedNode,
} from './graph'
import { MAX_POPULATE_DEPTH } from './operations'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

// Keys a backfill may never target: prototype-pollution vectors plus server-owned
// system columns. The positive check (must be a real storage field) already excludes
// these, but listing them keeps the guard explicit and fails closed.
const FORBIDDEN_BACKFILL_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'id',
  'createdAt',
  'updatedAt',
  '_status',
  '_scheduled_at',
])

/** Coerce a journal column (stored as JSON, decoded to an array) into a string[]. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

/** Max documents a single semantic/hybrid query may return — clamps a hostile or
 *  fat-fingered `limit` (a huge value would over-fetch the vector store + read path). */
const MAX_SEMANTIC_LIMIT = 100

function clampLimit(limit: number | undefined): number {
  const n = Math.floor(Number(limit ?? 25))
  if (!Number.isFinite(n)) return 25
  return Math.min(Math.max(1, n), MAX_SEMANTIC_LIMIT)
}

/** Embed a query string, converting any provider error into a generic one. The user's
 *  `embed` closure may hold an API key and its thrown message could carry it — so the
 *  original error is never propagated to the request boundary (which logs it). */
async function embedQuery(embed: (texts: string[]) => Promise<number[][]>, query: string): Promise<number[] | null> {
  let vectors: number[][]
  try {
    vectors = await embed([query])
  } catch {
    throw new Error('Embedding provider failed while embedding the search query.')
  }
  const vec = vectors?.[0]
  return vec && vec.length > 0 ? vec : null
}

// Keys a vector filter may never carry: prototype-pollution vectors. Validity beyond
// these is "must be a real storage field of the collection".
const FORBIDDEN_FILTER_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Validate a semantic-search metadata filter against the target collection. Every key
 * must be a real storage field (rejects prototype-pollution keys and unknown columns);
 * every value must be a scalar. Returns `undefined` when there is nothing to filter, or
 * a clean, null-prototype object safe to hand to the vector store.
 */
function validateVectorFilter(
  config: import('./types').SanitizedConfig,
  collection: string,
  filter: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!filter) return undefined
  const col = config.collectionsBySlug[collection]
  if (!col) return undefined
  const fieldNames = new Set(storageFields(col.fields).map((f) => f.name))
  const out: Record<string, string | number | boolean | null> = Object.create(null)
  let any = false
  for (const key of Object.keys(filter)) {
    if (FORBIDDEN_FILTER_KEYS.has(key)) throw new BadRequestError(`Illegal filter key "${key}".`)
    if (!fieldNames.has(key)) throw new BadRequestError(`"${key}" is not a filterable field of "${collection}".`)
    const value = filter[key]
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new BadRequestError(`Filter value for "${key}" must be a scalar.`)
    }
    out[key] = value
    any = true
  }
  return any ? out : undefined
}

/**
 * Load an ordered list of candidate ids through the access-checked read path, in rank
 * order, dropping any the caller cannot read (a hit for a forbidden doc either returns
 * null or raises an access error — both skipped), and de-duplicating ids. Returns up
 * to `limit` documents. The single chokepoint that guarantees neither semantic nor
 * hybrid search ever surfaces a document the caller is not allowed to read.
 */
async function loadAccessChecked<T extends Doc = Doc>(
  ops: import('./operations').Operations,
  collection: string,
  ids: string[],
  limit: number,
  opts: import('./types').OperationBase,
): Promise<T[]> {
  const docs: T[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    let doc: T | null = null
    try {
      doc = await ops.findByID<T>({
        collection,
        id,
        req: opts.req,
        overrideAccess: opts.overrideAccess,
        depth: opts.depth,
      })
    } catch (err) {
      if (!isKernelError(err)) throw err
    }
    if (doc) docs.push(doc)
    if (docs.length >= limit) break
  }
  return docs
}

/** A configured, non-system collection that participates in the content graph. System
 *  collections (`_*`) and reserved internal tables are never graph nodes. */
function isGraphCollection(config: SanitizedConfig, slug: string): boolean {
  if (typeof slug !== 'string' || slug.startsWith('_')) return false
  return Boolean(config.collectionsBySlug[slug])
}

/**
 * Build the access-checked loader surface the BFS engine consumes. EVERY node load and
 * EVERY reverse query funnels through `ops.findByID` / `ops.find` with the caller's
 * principal, so a document the caller can't read returns null / is absent — and the BFS
 * then drops both the node and the edge to it (no leak). `depth: 1` populates one hop of
 * relationship VALUES on each loaded doc so `outboundNeighbors` can read ref ids even
 * when stored polymorphically; access on those populated relations is irrelevant here
 * because every neighbour is independently re-loaded through `loadNode`.
 */
function makeGraphLoaders(
  ops: import('./operations').Operations,
  config: SanitizedConfig,
  opts: { req?: Partial<RequestContext>; overrideAccess?: boolean },
): GraphLoaders {
  const isCollection = (slug: string): boolean => isGraphCollection(config, slug)

  const toLoaded = (slug: string, doc: Doc): LoadedNode => {
    const collection = config.collectionsBySlug[slug]!
    return {
      collection,
      doc,
      node: { ref: `${slug}:${doc.id}`, collection: slug, id: doc.id, label: resolveLabel(collection, doc) },
    }
  }

  return {
    isCollection,
    async loadNode(slug, id) {
      if (!isCollection(slug)) return null
      let doc: Doc | null = null
      try {
        // depth:0 — raw relationship ids/refs are kept (not populated to nested docs),
        // which is exactly what `outboundNeighbors` wants. Access-checked read path.
        doc = await ops.findByID<Doc>({
          collection: slug,
          id,
          req: opts.req,
          overrideAccess: opts.overrideAccess,
          depth: 0,
        })
      } catch (err) {
        if (!isKernelError(err)) throw err
      }
      return doc ? toLoaded(slug, doc) : null
    },
    async loadReverse(query: JoinNeighborQuery, fromId: string) {
      if (!isCollection(query.collection)) return []
      let result: { docs: Doc[] } = { docs: [] }
      try {
        // The reverse query runs through the access-checked `find`, so a back-reference
        // the caller can't read is filtered out by the related collection's read scope.
        result = await ops.find<Doc>({
          collection: query.collection,
          where: { [query.on]: { equals: fromId } },
          limit: GRAPH_REVERSE_LIMIT,
          req: opts.req,
          overrideAccess: opts.overrideAccess,
          depth: 0,
        })
      } catch (err) {
        if (!isKernelError(err)) throw err
        return []
      }
      return result.docs.map((d) => toLoaded(query.collection, d))
    },
  }
}

/** Cap on rows pulled per reverse-relationship query — bounds a single hub's inbound
 *  fan-out (a doc referenced by thousands of others can't blow up one BFS step). */
const GRAPH_REVERSE_LIMIT = 200

/** Run a bounded, access-checked graph traversal from a seed document. */
async function runGraph(
  ops: import('./operations').Operations,
  config: SanitizedConfig,
  opts: GraphOptions,
): Promise<GraphResult> {
  if (typeof opts.collection !== 'string' || typeof opts.id !== 'string' || opts.id.length === 0) {
    throw new BadRequestError('graph requires a collection and a document id.')
  }
  if (!isGraphCollection(config, opts.collection)) {
    throw new BadRequestError(`Unknown collection "${opts.collection}".`)
  }
  const depth = clampDepth(opts.depth, MAX_POPULATE_DEPTH)
  const maxNodes = clampMaxNodes(opts.maxNodes)
  const loaders = makeGraphLoaders(ops, config, opts)
  const { nodes, edges, truncated } = await traverseGraph(
    loaders,
    { collection: opts.collection, id: opts.id },
    { depth, maxNodes },
  )
  return { nodes, edges, truncated }
}

/**
 * GraphRAG retrieval: seed from semantic hits, expand each seed via the access-checked
 * BFS, and assemble the connected subgraph plus a plain-text `context` array. Seeds and
 * every reachable node are access-checked, so non-readable content never contributes.
 */
async function runGraphSearch<T extends Doc = Doc>(
  ops: import('./operations').Operations,
  config: SanitizedConfig,
  seedSearch: (collection: string, query: string, limit: number) => Promise<{ docs: T[] }>,
  opts: GraphSearchOptions,
): Promise<GraphSearchResult<T>> {
  const query = String(opts.query ?? '')
  const limit = clampSeedLimit(opts.limit)
  const depth = clampDepth(opts.depth, MAX_POPULATE_DEPTH)
  const maxNodes = clampMaxNodes(opts.maxNodes)

  // Resolve which collection seeds come from. An explicit `collection` wins; otherwise
  // use the single semantic-or-searchable collection. Ambiguity is a clear error rather
  // than a silent cross-collection guess.
  const collection = resolveSeedCollection(config, opts.collection)

  if (query.trim().length === 0) {
    return { seeds: [], nodes: [], edges: [], context: [], truncated: false }
  }
  const { docs: seeds } = await seedSearch(collection, query, limit)

  // Expand every seed, merging the subgraphs (de-duped by ref across seeds) under one
  // shared node budget so the TOTAL output stays bounded regardless of seed count.
  const loaders = makeGraphLoaders(ops, config, opts)
  const nodeMap = new Map<string, GraphNode>()
  const edgeKeys = new Set<string>()
  const edges: GraphEdge[] = []
  let truncated = false
  for (const seed of seeds) {
    if (nodeMap.size >= maxNodes) {
      truncated = true
      break
    }
    const remaining = maxNodes - nodeMap.size
    const sub = await traverseGraph(loaders, { collection, id: seed.id }, { depth, maxNodes: remaining + nodeMap.size })
    truncated = truncated || sub.truncated
    for (const n of sub.nodes) if (!nodeMap.has(n.ref)) nodeMap.set(n.ref, n)
    for (const e of sub.edges) {
      const key = `${e.from} ${e.to} ${e.field} ${e.kind}`
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        edges.push(e)
      }
    }
  }

  // Build the grounding context from the readable nodes. Each node is re-loaded through
  // the access-checked path to obtain its full (stripped) doc for the text snippet — a
  // node whose read access changed mid-traversal simply yields no context.
  const context: GraphSearchResult<T>['context'] = []
  for (const node of nodeMap.values()) {
    const loaded = await loaders.loadNode(node.collection, node.id)
    if (!loaded) continue
    context.push({ ref: node.ref, label: loaded.node.label, text: extractText(loaded.collection, loaded.doc) })
  }

  return { seeds, nodes: [...nodeMap.values()], edges, context, truncated }
}

/** Resolve the seed collection for graphSearch: an explicit choice, else the single
 *  collection with semantic (then full-text) search. Ambiguity / absence throws. */
function resolveSeedCollection(config: SanitizedConfig, explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (!isGraphCollection(config, explicit)) throw new BadRequestError(`Unknown collection "${explicit}".`)
    return explicit
  }
  const semantic = Object.keys(config.semanticFields)
  if (semantic.length === 1) return semantic[0]!
  const fullText = Object.keys(config.searchableFields)
  if (semantic.length === 0 && fullText.length === 1) return fullText[0]!
  if (semantic.length === 0 && fullText.length === 0) {
    throw new BadRequestError('graphSearch needs a collection with search enabled (none configured).')
  }
  throw new BadRequestError('graphSearch requires an explicit `collection` when several collections have search.')
}

export function createLogger(level: keyof typeof LEVELS = 'info'): Logger {
  const min = LEVELS[level]
  const emit = (lvl: keyof typeof LEVELS, stream: 'log' | 'warn' | 'error') => (msg: string, meta?: unknown) => {
    if (LEVELS[lvl] < min) return
    const line = `[kernel] ${lvl.toUpperCase()} ${msg}`
    if (meta === undefined) console[stream](line)
    else console[stream](line, meta)
  }
  return {
    debug: emit('debug', 'log'),
    info: emit('info', 'log'),
    warn: emit('warn', 'warn'),
    error: emit('error', 'error'),
  }
}

export interface InitOptions {
  /** Apply the schema (create/alter tables) during init. Default false. */
  autoMigrate?: boolean
  logLevel?: keyof typeof LEVELS
}

/** Boot a Kernel instance: sanitize config, init the adapter, expose the Local API. */
export async function initKernel(config: KernelConfig, options: InitOptions = {}): Promise<Kernel> {
  const logger = createLogger(options.logLevel ?? (process.env.KERNEL_LOG_LEVEL as keyof typeof LEVELS) ?? 'info')
  // Plugins transform the raw config (add collections/fields/hooks) before sanitize.
  const resolved = await applyPlugins(config, logger)
  const sanitized = sanitizeConfig(resolved)
  // Outbound webhooks: attach firing hooks to targeted collections (excluding
  // system tables) before operations are created. Durable endpoints enqueue to the
  // `_webhook_deliveries` outbox (delivered later by `processWebhooks`); inline ones POST
  // best-effort. The enqueue writes a `pending` row due immediately (`nextAttemptAt = now`).
  if (sanitized.webhooks.length > 0) {
    const enqueue: WebhookEnqueue = async (d) => {
      await sanitized.db.create({
        collection: WEBHOOK_DELIVERIES_TABLE,
        data: {
          id: randomUUID(),
          webhook: d.webhook,
          event: d.event,
          collection: d.collection,
          documentId: d.documentId,
          payload: d.payload,
          status: 'pending',
          attempts: 0,
          lastStatus: null,
          nextAttemptAt: new Date().toISOString(),
          deliveredAt: null,
        },
      })
    }
    attachWebhooks(sanitized.collections, sanitized.webhooks, new Set([JOBS_SLUG, CACHE_SLUG]), logger, enqueue)
  }
  // Real-time content: a per-kernel in-process bus + a change-feed ctx whose seq counter
  // is filled in after the adapter inits (it must read `_changes`). Attach the change-feed
  // hooks now (before ops are created), excluding system collections + the outbox itself,
  // so internal writes never emit. The ctx is captured by reference by the hooks.
  const changeBus = createChangeBus(logger)
  let changeFeedCtx: ChangeFeedCtx | null = null
  if (sanitized.realtime.enabled) {
    // A thin wrapper so the hooks can be attached before the seq counter exists; calls
    // are a no-op until boot finishes wiring it (no content write happens before then).
    const lazyCtx: ChangeFeedCtx = {
      db: sanitized.db,
      bus: changeBus,
      seq: { next: () => 0 },
      retain: sanitized.realtime.retain,
      logger,
    }
    changeFeedCtx = lazyCtx
    attachChangeFeed(sanitized.collections, lazyCtx, new Set([JOBS_SLUG, CACHE_SLUG, CHANGES_TABLE]))
  }
  // Full-text search: attach index-sync hooks to searchable collections.
  if (sanitized.search && Object.keys(sanitized.searchableFields).length > 0) {
    attachSearch(sanitized.collections, sanitized.search, sanitized.searchableFields, logger)
  }
  // Semantic search: attach embed-on-write / remove-on-delete hooks alongside full-text.
  if (sanitized.embeddings && sanitized.vector && Object.keys(sanitized.semanticFields).length > 0) {
    attachSemantic(
      sanitized.collections,
      sanitized.vector,
      sanitized.embeddings.embed,
      sanitized.semanticFields,
      logger,
    )
  }
  const schema = compileSchema(sanitized)

  await sanitized.db.init({ logger })
  // Always register the schema's table registry so reads/writes resolve their
  // tables even when migrations are managed out-of-band (no autoMigrate). Without
  // this, find()/create() would throw "Unknown table" until a migration ran.
  sanitized.db.register?.(schema)
  if (options.autoMigrate) await sanitized.db.migrate(schema)

  // Real-time: seed the monotonic seq counter from the highest `seq` already in `_changes`
  // (so cursors stay ordered across restarts). Done after register/migrate so the table
  // exists; a missing table degrades gracefully (counter starts at 0).
  if (changeFeedCtx) changeFeedCtx.seq = await createSeqCounter(sanitized.db)

  // Content analytics: a per-kernel capture ctx whose monotonic seq is seeded from the
  // highest `seq` already in `_analytics` (so ordering + trim survive restarts). Built
  // only when analytics is enabled; writes go to the RAW db (a system table), never
  // through the content ops, so `track` can NEVER touch a content collection.
  let analyticsCtx: AnalyticsCtx | null = null
  if (sanitized.analytics.enabled) {
    analyticsCtx = {
      db: sanitized.db,
      retain: sanitized.analytics.retain,
      seq: await createAnalyticsSeq(sanitized.db),
      logger,
    }
  }

  // Optional read-through cache. The operation core runs against `opDb`; when a
  // cache adapter is configured and collections opt in, that is a cache-wrapping
  // adapter, otherwise the raw db. Access control still runs on every call.
  let opDb: DatabaseAdapter = sanitized.db
  if (sanitized.cache && sanitized.cacheableSlugs.length > 0) {
    await sanitized.cache.init({ logger, db: sanitized.db })
    opDb = createCachedDb(sanitized.db, sanitized.cache, {
      cacheableSlugs: new Set(sanitized.cacheableSlugs),
      ttlMs: sanitized.cacheDefaultTtl,
      ttlBySlug: sanitized.cacheTtlBySlug,
    })
  }
  if (sanitized.search) await sanitized.search.init({ logger, db: sanitized.db })
  if (sanitized.vector) await sanitized.vector.init({ logger, db: sanitized.db })

  const ops = createOperations({ config: sanitized, db: opDb, logger })

  // Agentic workflows: build the engine (needs ops), bind its drain handler onto the
  // reserved job placeholder so `runDueJobs` executes enqueued runs, and attach the
  // create/update trigger hooks (they enqueue durable runs via the jobs queue). The
  // engine writes its run log against the RAW db (a system table), while every content
  // op inside a run flows through `ops` AS the scoped agent principal.
  const workflowEngine = createWorkflowEngine({ config: sanitized, db: sanitized.db, ops, logger })
  if (sanitized.workflows.length > 0) {
    const drainJob = sanitized.jobs?.find((j) => j.slug === WORKFLOW_JOB_TASK)
    if (drainJob) drainJob.handler = workflowEngine.drainJobHandler
    attachWorkflowTriggers(
      sanitized.collections,
      sanitized.workflows,
      ops.enqueue,
      new Set([JOBS_SLUG, CACHE_SLUG]),
      logger,
    )
  }

  // AI-discoverability / GEO generators. They read PUBLISHED, publicly-readable content
  // through the access-checked ops as an anonymous principal (never overrideAccess), so
  // drafts/private docs can never leak. Built unconditionally; the ops throw cleanly when
  // `config.discoverability` is not enabled.
  const discoverability = createDiscoverability(sanitized, {
    find: ops.find,
    provenance: ops.provenance,
    getContentCredential: ops.getContentCredential,
    verifyContentCredential: ops.verifyContentCredential,
  })

  // schema.org structured data (JSON-LD). Reads each document through the same access-
  // checked path with the CALLER's principal (anonymous for public embedding, never
  // overrideAccess from an untrusted boundary), so drafts/private docs + read-denied
  // fields can never appear. Built unconditionally; the ops return null/'' when
  // `config.structuredData` is not enabled.
  const structuredData = createStructuredData(sanitized, { find: ops.find })

  // RBAC boot: reconcile the runtime store with the `_roles` table. On first boot
  // (table empty) the config-seeded roles are written so they're persisted/editable;
  // on later boots the persisted rows are merged into the store so runtime edits made
  // in a previous run survive. The store was already seeded from config at compile, so
  // the injected access rules work even if this step is skipped (e.g. table not yet
  // migrated) — hence failures are logged, never fatal.
  if (sanitized.rbac.enabled) {
    try {
      const existing = await sanitized.db.find({ collection: ROLES_TABLE, limit: 1000, page: 1 })
      if (existing.docs.length === 0) {
        // First boot: persist the config-seeded roles.
        for (const [name, def] of Object.entries(sanitized.rbacStore.roles)) {
          await sanitized.db.create({ collection: ROLES_TABLE, data: { id: name, name, def: cloneRoleDef(def) } })
        }
      } else {
        // Persisted rows are authoritative for roles they define; merge them over the
        // config seed so runtime edits/additions take effect.
        for (const row of existing.docs) {
          const name = typeof row.name === 'string' ? row.name : String(row.id)
          const def = (row.def ?? {}) as import('./types').RoleDef
          sanitized.rbacStore.roles[name] = cloneRoleDef(def)
        }
      }
    } catch (err) {
      logger.warn('RBAC: could not load `_roles` (run a migration to enable persistence)', err)
    }
  }

  // The access filter shared by the pull feed AND the SSE stream: a non-delete event is
  // gated by re-loading the doc through the access-checked read path; a delete is gated by
  // the collection's read access. A forbidden event is dropped ENTIRELY (never leaked).
  const changeFilter = makeChangeFilter(sanitized, (collection, id, req) =>
    ops.findByID({ collection, id, req, overrideAccess: false }),
  )
  // A minimal req builder for the pull feed: the read path (ops.findByID) re-builds its
  // own request internally, so this only needs to carry the user/locale forward.
  const buildChangeReq = (partial?: Partial<RequestContext>): RequestContext => {
    const defaultLocale = sanitized.localization ? sanitized.localization.defaultLocale : 'en'
    return {
      user: partial?.user ?? null,
      locale: partial?.locale ?? defaultLocale,
      fallbackLocale: partial?.fallbackLocale ?? false,
      context: partial?.context ?? {},
    }
  }

  // -------------------------------------------------------------------------
  // Content analytics: capture + insights + (opt-in) auto-capture
  // -------------------------------------------------------------------------

  /** Append a sanitized analytics event. No-op when analytics is off or the `type` is
   *  invalid; resilient (never throws into the caller). NO PII is ever read off `opts`. */
  const track = async (opts: TrackOptions): Promise<void> => {
    if (!analyticsCtx) return
    const event = buildAnalyticsRow(opts)
    if (!event) {
      logger.warn(`Ignoring analytics event with invalid type "${String(opts?.type)}"`)
      return
    }
    await appendAnalytics(analyticsCtx, event)
  }

  /** Fire an analytics event WITHOUT awaiting it, swallowing any rejection — the
   *  best-effort auto-capture path inside search / assignVariant must add no latency and
   *  never affect the operation's result. No-op unless `autoCapture` is on. */
  const autoEmit = (opts: TrackOptions): void => {
    if (!analyticsCtx || !sanitized.analytics.autoCapture) return
    void track(opts).catch(() => {})
  }

  /** Auto-emit an `ai_retrieval` event per access-checked doc a search returned — the
   *  "AI retrieved this content" signal. Off unless `autoCapture` is on. */
  const emitRetrieval = (collection: string, query: string, docs: Doc[]): void => {
    if (!analyticsCtx || !sanitized.analytics.autoCapture) return
    const terms = String(query ?? '')
    for (const doc of docs) {
      autoEmit({ type: 'ai_retrieval', collection, documentId: String(doc.id), query: terms })
    }
  }

  const insights = async (opts: InsightsOptions): Promise<InsightsResult> => {
    if (!sanitized.analytics.enabled) {
      return computeInsights(sanitized.analytics, sanitized.db, () => true, opts)
    }
    const override = opts.overrideAccess === true
    // Restrict insight rows to collections the caller can READ. A trusted (override)
    // call sees everything; otherwise a collection passes only when its read access
    // evaluates to a global `true` for this principal (a row-scoped `Where` can't gate
    // an aggregate count, so it fails closed — the editor never learns its counts).
    let readable: (collection: string) => boolean = () => true
    if (!override) {
      const allowed = new Set<string>()
      const req = buildChangeReq(opts.req)
      for (const collection of sanitized.collections) {
        // System / hidden collections are never analytics subjects worth leaking.
        const decision = await evalAccess(collection.access?.read, { req, id: undefined as never })
        if (decision === true) allowed.add(collection.slug)
      }
      readable = (collection: string) => allowed.has(collection)
    }
    return computeInsights(sanitized.analytics, sanitized.db, readable, opts)
  }

  const kernel: Kernel = {
    config: sanitized,
    db: sanitized.db,
    track,
    insights,
    async changes(opts: ChangesOptions = {}): Promise<ChangesResult> {
      return readChanges(sanitized, sanitized.db, changeFilter, buildChangeReq, opts)
    },
    subscribe(listener: (event: ChangeEvent) => void): () => void {
      return changeBus.subscribe(listener)
    },
    async changeVisibleTo(
      event: ChangeEvent,
      opts: { req?: Partial<RequestContext>; overrideAccess?: boolean } = {},
    ): Promise<boolean> {
      if (!sanitized.realtime.enabled) return false
      return changeFilter(event, buildChangeReq(opts.req), opts.overrideAccess ?? false)
    },
    cacheTags(opts: CacheTagsOptions): string[] {
      // Pure, access-free: the caller passes only docs it may see; tags name a
      // (collection,id) and never a body. No-op when edge delivery is disabled.
      if (!sanitized.edge.enabled) return []
      return computeCacheTags(sanitized, opts)
    },
    async purgeFeed(opts: PurgeFeedOptions = {}): Promise<PurgeFeedResult> {
      // Requires edge delivery; computePurge additionally no-ops without realtime
      // (the change feed is its source of truth). Reads `_changes` (a system table)
      // directly off the raw db — never through content ops.
      if (!sanitized.edge.enabled) return { tags: [], cursor: opts.since ?? 0 }
      return computePurge(sanitized, sanitized.db, opts)
    },
    onPurge(listener: (tags: string[]) => void): () => void {
      // A thin push helper over the realtime bus: each live change yields its doc +
      // collection tags. No-op (no-op unsubscribe) when edge delivery is off.
      if (!sanitized.edge.enabled) return () => {}
      return changeBus.subscribe((event) => {
        const tags = purgeTagsForEvent(event)
        if (tags.length > 0) listener(tags)
      })
    },
    ...(sanitized.cache ? { cache: sanitized.cache } : {}),
    ...(sanitized.search ? { search: sanitized.search } : {}),
    schema,
    async searchDocs<T extends Doc = Doc>(opts: import('./types').SearchDocsOptions): Promise<{ docs: T[] }> {
      const search = sanitized.search
      if (!search) throw new Error('No search adapter configured (config.search).')
      if (!sanitized.searchableFields[opts.collection]) {
        throw new Error(`Collection "${opts.collection}" does not have search enabled.`)
      }
      const limit = Math.max(1, opts.limit ?? 25)
      // Over-fetch hits so access filtering on load does not starve the result.
      const { hits } = await search.search({ collection: opts.collection, query: opts.query, limit: limit * 4 })
      const docs: T[] = []
      for (const hit of hits) {
        // Load through the access-checked read path. A hit the caller may not read
        // either returns null or raises an access error — both are skipped, so the
        // index never surfaces a forbidden document.
        let doc: T | null = null
        try {
          doc = await ops.findByID<T>({
            collection: opts.collection,
            id: hit.id,
            req: opts.req,
            overrideAccess: opts.overrideAccess,
            depth: opts.depth,
          })
        } catch (err) {
          if (!isKernelError(err)) throw err
        }
        if (doc) docs.push(doc)
        if (docs.length >= limit) break
      }
      return { docs }
    },
    async semanticSearch<T extends Doc = Doc>(opts: import('./types').SemanticSearchOptions): Promise<{ docs: T[] }> {
      const { embeddings, vector } = sanitized
      if (!embeddings || !vector) throw new Error('Semantic search requires `config.embeddings` (and a vector store).')
      const fields = sanitized.semanticFields[opts.collection]
      if (!fields) throw new Error(`Collection "${opts.collection}" does not have semantic search enabled.`)
      const limit = clampLimit(opts.limit)
      // Validate the metadata filter against the collection (reject unknown /
      // prototype-pollution keys) BEFORE it reaches the vector store.
      const filter = validateVectorFilter(sanitized, opts.collection, opts.filter)
      const query = String(opts.query ?? '')
      if (query.trim().length === 0) return { docs: [] }
      const vec = await embedQuery(embeddings.embed, query)
      if (!vec) return { docs: [] }
      // Over-fetch so access filtering on load does not starve the result.
      const { hits } = await vector.query({ collection: opts.collection, vector: vec, limit: limit * 4, filter })
      const docs = await loadAccessChecked<T>(
        ops,
        opts.collection,
        hits.map((h) => h.id),
        limit,
        opts,
      )
      // Auto-capture (opt-in): one `ai_retrieval` per returned doc. The set is already
      // access-filtered (loadAccessChecked dropped anything the caller can't read), so
      // we never emit for content the caller couldn't see. `query` = the search terms.
      emitRetrieval(opts.collection, query, docs)
      return { docs }
    },
    async hybridSearch<T extends Doc = Doc>(opts: import('./types').HybridSearchOptions): Promise<{ docs: T[] }> {
      const { search, embeddings, vector } = sanitized
      const hasFullText = Boolean(search && sanitized.searchableFields[opts.collection])
      const hasSemantic = Boolean(embeddings && vector && sanitized.semanticFields[opts.collection])
      if (!hasFullText && !hasSemantic) {
        throw new Error(`Collection "${opts.collection}" has neither full-text nor semantic search enabled.`)
      }
      const limit = clampLimit(opts.limit)
      const query = String(opts.query ?? '')
      const over = limit * 4
      const rankedLists: string[][] = []
      // Run both available signals (in parallel) and collect their ranked id-lists.
      const [textHits, semHits] = await Promise.all([
        hasFullText && query.trim().length > 0
          ? search!.search({ collection: opts.collection, query, limit: over })
          : Promise.resolve({ hits: [] as { id: string }[] }),
        hasSemantic && query.trim().length > 0
          ? (async () => {
              const vec = await embedQuery(embeddings!.embed, query)
              if (!vec) return { hits: [] as { id: string }[] }
              return vector!.query({ collection: opts.collection, vector: vec, limit: over })
            })()
          : Promise.resolve({ hits: [] as { id: string }[] }),
      ])
      if (textHits.hits.length > 0) rankedLists.push(textHits.hits.map((h) => h.id))
      if (semHits.hits.length > 0) rankedLists.push(semHits.hits.map((h) => h.id))
      const fused = reciprocalRankFusion(rankedLists)
      const docs = await loadAccessChecked<T>(
        ops,
        opts.collection,
        fused.map((f) => f.id),
        limit,
        opts,
      )
      emitRetrieval(opts.collection, query, docs)
      return { docs }
    },
    async relatedContent<T extends Doc = Doc>(opts: RelatedContentOptions): Promise<{ docs: T[] }> {
      const { embeddings, vector } = sanitized
      if (!embeddings || !vector) {
        throw new Error('Related content requires `config.embeddings` (and a vector store).')
      }
      const fields = sanitized.semanticFields[opts.collection]
      const collection = sanitized.collectionsBySlug[opts.collection]
      if (!fields || !collection) {
        throw new Error(`Collection "${opts.collection}" does not have semantic search enabled.`)
      }
      if (typeof opts.id !== 'string' || opts.id.length === 0) {
        throw new BadRequestError('relatedContent requires a document id.')
      }
      const limit = clampLimit(opts.limit)
      const filter = validateVectorFilter(sanitized, opts.collection, opts.filter)
      // The seed must itself be readable by the caller — otherwise we neither embed nor
      // return anything (a forbidden/missing seed yields no related docs, never a leak).
      const seed = await loadAccessChecked<T>(ops, opts.collection, [opts.id], 1, opts)
      if (seed.length === 0) return { docs: [] }
      // Re-embed the seed's CURRENT content (always fresh — no stale stored vector) using
      // the same enriched-text + embed path as index-on-write. embedQuery converts any
      // provider error into a generic one (the embed closure may hold an API key).
      const text = enrichedEmbeddingText(collection, fields, seed[0] as Doc)
      const vec = await embedQuery(embeddings.embed, text)
      if (!vec) return { docs: [] }
      // Over-fetch: +1 covers dropping the seed, ×4 covers access filtering on load.
      const { hits } = await vector.query({
        collection: opts.collection,
        vector: vec,
        limit: (limit + 1) * 4,
        filter,
      })
      const ids = hits.map((h) => h.id).filter((id) => id !== opts.id)
      const docs = await loadAccessChecked<T>(ops, opts.collection, ids, limit, opts)
      return { docs }
    },
    async findDuplicates(opts: FindDuplicatesOptions): Promise<{ pairs: DuplicatePairResult[] }> {
      const { embeddings, vector } = sanitized
      if (!embeddings || !vector) {
        throw new Error('Duplicate detection requires `config.embeddings` (and a vector store).')
      }
      if (!sanitized.semanticFields[opts.collection] || !sanitized.collectionsBySlug[opts.collection]) {
        throw new Error(`Collection "${opts.collection}" does not have semantic search enabled.`)
      }
      const threshold = clampThreshold(opts.threshold)
      const pairLimit = clampPairLimit(opts.limit)
      // Pull a BOUNDED snapshot of the collection's vectors (cap MAX_DEDUP_DOCS) — the
      // O(n²) scan below is bounded by this cap, not by the (unbounded) collection size.
      const entries = await vector.list({ collection: opts.collection, limit: MAX_DEDUP_DOCS })
      // Over-fetch candidate pairs (cap MAX_CANDIDATE_PAIRS) so dropping pairs that touch
      // an unreadable doc can't starve the result — readable pairs ranked below the limit
      // still surface. The final slice to `pairLimit` happens AFTER the access filter.
      const candidates = findDuplicatePairs(entries, threshold, MAX_CANDIDATE_PAIRS)
      if (candidates.length === 0) return { pairs: [] }
      // Access-check every id that appears in a candidate pair through the read path, then
      // keep only pairs whose BOTH ids are readable. A pair touching a doc the caller can't
      // read is dropped entirely, so dedup never reveals hidden content or its id.
      const ids = new Set<string>()
      for (const p of candidates) {
        ids.add(p.a)
        ids.add(p.b)
      }
      const idList = [...ids]
      const loaded = await loadAccessChecked<Doc>(ops, opts.collection, idList, idList.length, opts)
      const readable = new Set(loaded.map((d) => String(d.id)))
      // Filter to pairs the caller can fully read, THEN slice to the requested limit.
      const pairs = filterReadablePairs(candidates, readable).slice(0, pairLimit)
      return { pairs }
    },
    find: ops.find,
    findByID: ops.findByID,
    create: ops.create,
    upload: ops.upload,
    signedAssetUrl: ops.signedAssetUrl,
    update: ops.update,
    updateLocales: ops.updateLocales,
    translationStatus: ops.translationStatus,
    translationStatusList: ops.translationStatusList,
    translateDocument: ops.translateDocument,
    translateMissing: ops.translateMissing,
    updateMany: ops.updateMany,
    delete: ops.delete,
    deleteMany: ops.deleteMany,
    count: ops.count,
    login: ops.login,
    authenticate: ops.authenticate,
    createAPIKey: ops.createAPIKey,
    authenticateAPIKey: ops.authenticateAPIKey,
    forgotPassword: ops.forgotPassword,
    resetPassword: ops.resetPassword,
    verifyEmail: ops.verifyEmail,
    requestEmailVerification: ops.requestEmailVerification,
    setupTwoFactor: ops.setupTwoFactor,
    enableTwoFactor: ops.enableTwoFactor,
    disableTwoFactor: ops.disableTwoFactor,
    loginWithOAuth: ops.loginWithOAuth,
    findGlobal: ops.findGlobal,
    updateGlobal: ops.updateGlobal,
    findVersions: ops.findVersions,
    restoreVersion: ops.restoreVersion,
    history: ops.history,
    documentActivity: ops.documentActivity,
    diffVersions: ops.diffVersions,
    restoreAsOf: ops.restoreAsOf,
    publish: ops.publish,
    unpublish: ops.unpublish,
    processScheduledPublishes: ops.processScheduledPublishes,
    processContentLifecycle: ops.processContentLifecycle,
    findAuditLog: ops.findAuditLog,
    enqueue: ops.enqueue,
    runDueJobs: ops.runDueJobs,
    runWorkflow: workflowEngine.runWorkflow,
    workflowRuns: workflowEngine.workflowRuns,
    findRoles: ops.findRoles,
    createRole: ops.createRole,
    updateRole: ops.updateRole,
    deleteRole: ops.deleteRole,
    findReviewQueue: ops.findReviewQueue,
    submitReview: ops.submitReview,
    addComment: ops.addComment,
    listComments: ops.listComments,
    resolveComment: ops.resolveComment,
    deleteComment: ops.deleteComment,
    commentCount: ops.commentCount,
    saveView: ops.saveView,
    listViews: ops.listViews,
    getView: ops.getView,
    updateView: ops.updateView,
    deleteView: ops.deleteView,
    applyView: ops.applyView,
    createSubscription: ops.createSubscription,
    listSubscriptions: ops.listSubscriptions,
    deleteSubscription: ops.deleteSubscription,
    processSubscriptions: ops.processSubscriptions,
    createBranch: ops.createBranch,
    listBranches: ops.listBranches,
    stageChange: ops.stageChange,
    previewBranch: ops.previewBranch,
    diffBranch: ops.diffBranch,
    mergeBranch: ops.mergeBranch,
    discardBranch: ops.discardBranch,
    exportContent: ops.exportContent,
    syncContent: ops.syncContent,
    lintDocument: ops.lintDocument,
    processWebhooks: ops.processWebhooks,
    listWebhooks: ops.listWebhooks,
    webhookDeliveries: ops.webhookDeliveries,
    retryWebhookDelivery: ops.retryWebhookDelivery,
    createRelease: ops.createRelease,
    addToRelease: ops.addToRelease,
    removeFromRelease: ops.removeFromRelease,
    listReleases: ops.listReleases,
    getRelease: ops.getRelease,
    previewRelease: ops.previewRelease,
    publishRelease: ops.publishRelease,
    scheduleRelease: ops.scheduleRelease,
    cancelRelease: ops.cancelRelease,
    processScheduledReleases: ops.processScheduledReleases,
    composePage: ops.composePage,
    listTemplates: ops.listTemplates,
    createFromTemplate: ops.createFromTemplate,
    acquireLock: ops.acquireLock,
    releaseLock: ops.releaseLock,
    getLock: ops.getLock,
    listLocks: ops.listLocks,
    heartbeat: ops.heartbeat,
    getPresence: ops.getPresence,
    provenance: ops.provenance,
    getContentCredential: ops.getContentCredential,
    verifyContentCredential: ops.verifyContentCredential,
    llmsTxt: discoverability.llmsTxt,
    llmsFullTxt: discoverability.llmsFullTxt,
    contentChunks: discoverability.contentChunks,
    geoDocument: discoverability.geoDocument,
    jsonLd: structuredData.jsonLd,
    jsonLdScript: structuredData.jsonLdScript,
    assignVariant(opts) {
      const result = ops.assignVariant(opts)
      // Auto-capture (opt-in): a `variant_impression` for the assignment. ONLY the
      // experiment + variant are recorded — never the raw visitor `key` (no PII).
      autoEmit({ type: 'variant_impression', experiment: result.experiment, variant: result.variant })
      return result
    },
    async migrate(opts?: MigrateRunOptions): Promise<MigrationReport> {
      const dryRun = opts?.dryRun === true
      const report = await sanitized.db.migrate(schema, { dryRun })
      // Record ONE journal row per real, non-empty migration — the single chokepoint
      // so every adapter gets journaling for free. A dry run writes nothing; an empty
      // migration (no tables created, no columns added) is skipped so rollback never
      // sees a no-op entry. The journal row is itself a normal insert into the always-
      // provisioned `_migrations` table.
      const applied = report.createdTables.length > 0 || report.addedColumns.length > 0
      if (!dryRun && applied) {
        try {
          await sanitized.db.create({
            collection: MIGRATIONS_TABLE,
            data: {
              id: randomUUID(),
              at: new Date().toISOString(),
              createdTables: report.createdTables,
              addedColumns: report.addedColumns,
              statements: report.statements,
            },
          })
        } catch (err) {
          // The schema change already succeeded; a journal-write failure must not
          // unwind it. Warn loudly — rollback won't be able to undo this migration.
          logger.warn('Migration applied but the journal row could not be written (rollback unavailable for it)', err)
        }
      }
      return report
    },
    async rollbackMigration(opts?: RollbackOptions): Promise<RollbackResult> {
      const dryRun = opts?.dryRun === true
      // Clamp steps to a finite positive integer — a NaN/Infinity would otherwise reach
      // the adapter as `limit` and throw an opaque datatype error before any drop.
      const rawSteps = Math.floor(Number(opts?.steps))
      const steps = Number.isFinite(rawSteps) ? Math.max(1, rawSteps) : 1
      if (typeof sanitized.db.rollback !== 'function') {
        throw new BadRequestError('The configured database adapter does not support rollback.')
      }
      // Read the last `steps` journal rows, newest-first. These are the ONLY source of
      // truth for what may be dropped — rollback never infers drops from a schema diff.
      const found = await sanitized.db.find({
        collection: MIGRATIONS_TABLE,
        sort: [{ field: 'at', direction: 'desc' }],
        limit: steps,
        page: 1,
      })
      const entries: MigrationJournalEntry[] = found.docs.map((row) => ({
        id: String(row.id),
        at: String(row.at ?? ''),
        createdTables: asStringArray(row.createdTables),
        addedColumns: asStringArray(row.addedColumns),
        statements: asStringArray(row.statements),
      }))
      const { statements } = await sanitized.db.rollback(entries, { dryRun })
      // Consume the journal rows only after a real (non-dry-run) rollback succeeds, so a
      // dry run leaves the journal intact and a failed drop leaves the entry to retry.
      if (!dryRun) {
        for (const entry of entries) {
          await sanitized.db.delete({ collection: MIGRATIONS_TABLE, id: entry.id })
        }
      }
      return { reverted: entries.map((e) => e.id), statements }
    },
    async backfill<T extends Doc = Doc>(opts: BackfillOptions<T>): Promise<BackfillResult> {
      const collection = sanitized.collectionsBySlug[opts.collection]
      if (!collection) throw new BadRequestError(`Unknown collection "${opts.collection}".`)
      // Validate the target field: it must be a real, storage-bearing field of the
      // collection. This rejects system/internal columns (id, _status, timestamps, …)
      // and prototype-pollution keys, so a backfill can never clobber server-owned state.
      const field = opts.field
      if (FORBIDDEN_BACKFILL_KEYS.has(field) || !storageFields(collection.fields).some((f) => f.name === field)) {
        throw new BadRequestError(`"${field}" is not a writable field of "${opts.collection}".`)
      }
      if (opts.value === undefined && typeof opts.set !== 'function') {
        throw new BadRequestError('Provide either `value` or a `set(doc)` function to backfill.')
      }
      const dryRun = opts.dryRun === true
      const batchSize = Math.min(Math.max(Math.floor(opts.batchSize ?? 500), 1), 1000)

      // Count up front for the `matched` total; on a dry run that's the whole answer.
      const matched = await ops.count({ collection: opts.collection, where: opts.where, overrideAccess: true })
      if (dryRun) return { matched, updated: 0 }

      // Two phases, so the write phase can't perturb its own pagination: first read every
      // matching doc id by paging the STABLE filter (a backfill update may or may not keep
      // a row in the filter, so paging WHILE writing could skip or revisit). Then update
      // each id via the trusted maintenance path. Memory is bounded by `matched`, itself a
      // count the operator chose to backfill.
      const targets: T[] = []
      let page = 1
      for (;;) {
        const result = await ops.find<T>({
          collection: opts.collection,
          where: opts.where,
          sort: 'id',
          limit: batchSize,
          page,
          // Backfill is maintenance over ALL existing rows — include drafts, which the
          // normal read path hides. Without this, draft rows are silently skipped and
          // the add→backfill→tighten-to-NOT-NULL sequence breaks on the still-null drafts.
          draft: true,
          overrideAccess: true,
          req: opts.req,
        })
        targets.push(...result.docs)
        if (!result.hasNextPage || result.docs.length === 0) break
        page++
      }

      let updated = 0
      for (const doc of targets) {
        const next = typeof opts.set === 'function' ? opts.set(doc) : opts.value
        const res = await ops.update({
          collection: opts.collection,
          id: doc.id,
          data: { [field]: next },
          overrideAccess: true,
          req: opts.req,
        })
        if (res) updated++
      }
      return { matched, updated }
    },
    async graph(opts: GraphOptions): Promise<GraphResult> {
      return runGraph(ops, sanitized, opts)
    },
    async graphSearch<T extends Doc = Doc>(opts: GraphSearchOptions): Promise<GraphSearchResult<T>> {
      // Seed search: prefer hybrid (semantic + full-text) when embeddings are present,
      // fall back to full-text `searchDocs`, and finally to a plain `find` so graphSearch
      // still works (sans relevance ranking) when no search adapter is configured. Each
      // path is already access-checked — non-readable seeds never appear.
      const seedSearch = async (collection: string, query: string, limit: number): Promise<{ docs: T[] }> => {
        const hasSemantic = Boolean(sanitized.embeddings && sanitized.vector && sanitized.semanticFields[collection])
        const hasFullText = Boolean(sanitized.search && sanitized.searchableFields[collection])
        const searchOpts = { collection, query, limit, req: opts.req, overrideAccess: opts.overrideAccess }
        if (hasSemantic) return kernel.hybridSearch<T>(searchOpts)
        if (hasFullText) return kernel.searchDocs<T>(searchOpts)
        const result = await ops.find<T>({
          collection,
          limit,
          req: opts.req,
          overrideAccess: opts.overrideAccess,
          depth: 0,
        })
        return { docs: result.docs }
      }
      const result = await runGraphSearch<T>(ops, sanitized, seedSearch, opts)
      // Auto-capture (opt-in): an `ai_retrieval` per access-checked SEED doc (the content
      // the GraphRAG answer was grounded in). Seeds carry their source collection in the
      // node `ref` ("collection:id"); emit per seed using that collection.
      if (analyticsCtx && sanitized.analytics.autoCapture) {
        const query = String(opts.query ?? '')
        for (const seed of result.seeds) {
          const node = result.nodes.find((n) => n.id === String(seed.id))
          const collection = node?.collection
          if (collection) autoEmit({ type: 'ai_retrieval', collection, documentId: String(seed.id), query })
        }
      }
      return result
    },
    async destroy() {
      if (sanitized.cache) await sanitized.cache.destroy()
      if (sanitized.search) await sanitized.search.destroy()
      if (sanitized.vector) await sanitized.vector.destroy()
      await sanitized.db.destroy()
    },
  }
  return kernel
}
