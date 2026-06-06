/**
 * Plugin system — plugins are config transformers, not lifecycle objects. Each
 * receives the config-so-far and returns the next config; composition is a left
 * fold over a dependency-ordered list. Ordering is explicit (array order +
 * `dependsOn` edges via topological sort); conflicts and cycles are fatal at
 * resolve time, never last-write-wins. See docs/08-extensibility/00.
 */
import type { Logger } from '@kernel/db'
import type { CollectionConfig, EndpointConfig, GlobalConfig, JobDefinition, KernelConfig } from './types'

export class PluginConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginConflictError'
  }
}
export class PluginCycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginCycleError'
  }
}
export class PluginSetupError extends Error {
  constructor(pluginName: string, cause: unknown) {
    super(`Plugin "${pluginName}" failed during setup: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'PluginSetupError'
    this.cause = cause
  }
}

/** The structured, validated mutation surface a plugin is allowed to touch. */
export interface PluginExtensions {
  /** Transform selected collections (by slug). Unknown slugs are a conflict error. */
  collections(slugs: string[], fn: (collection: CollectionConfig) => CollectionConfig): KernelConfig
  /** Append new collections. A duplicate slug raises PluginConflictError. */
  addCollections(...collections: CollectionConfig[]): KernelConfig
  /** Append new globals. A duplicate slug raises PluginConflictError. */
  addGlobals(...globals: GlobalConfig[]): KernelConfig
  /** Append custom endpoints. A duplicate `method path` raises PluginConflictError. */
  addEndpoints(...endpoints: EndpointConfig[]): KernelConfig
  /** Append background-job handlers. A duplicate slug raises PluginConflictError. */
  addJobs(...jobs: JobDefinition[]): KernelConfig
}

export interface PluginContext {
  /** The config produced so far. Treat as immutable. */
  readonly config: KernelConfig
  /** Validated mutation helpers — the only sanctioned mutation path. */
  readonly extend: PluginExtensions
  /** Logger scoped to this plugin's name. */
  readonly log: Logger
}

export interface KernelPlugin {
  /** Stable, namespaced id. Used for ordering, dedupe, and diagnostics. */
  name: string
  /** Semver of the plugin package (optional, surfaced in diagnostics). */
  version?: string
  /** Plugins that must run before this one. Resolved topologically. */
  dependsOn?: readonly string[]
  /** The transform. Receives the config-so-far, returns the next config. */
  setup: (ctx: PluginContext) => KernelConfig | Promise<KernelConfig>
}

/** Identity helper so plugin authors get full inference on their options. */
export function definePlugin<TOptions = void>(factory: (options: TOptions) => KernelPlugin) {
  return factory
}

/**
 * A module is a vertical slice: collections + globals + endpoints + jobs that
 * ship and install as one unit. It compiles to a plugin, so it participates in
 * the same dependency-ordered, conflict-checked fold — `dependsOn` another module
 * by name, and any duplicate slug/path/job is a fatal conflict, never last-write.
 */
export interface ModuleConfig {
  /** Stable, namespaced id (used for ordering, dedupe, diagnostics). */
  name: string
  version?: string
  dependsOn?: readonly string[]
  collections?: CollectionConfig[]
  globals?: GlobalConfig[]
  endpoints?: EndpointConfig[]
  jobs?: JobDefinition[]
}

/** Compile a module into a plugin. Add via `config.plugins: [comments]`. */
export function defineModule(mod: ModuleConfig): KernelPlugin {
  return {
    name: mod.name,
    version: mod.version,
    dependsOn: mod.dependsOn,
    setup: (ctx) => {
      let next = ctx.config
      const who = `Module "${mod.name}"`
      if (mod.collections?.length) next = mergeCollections(next, mod.collections, who)
      if (mod.globals?.length) next = mergeGlobals(next, mod.globals, who)
      if (mod.endpoints?.length) next = mergeEndpoints(next, mod.endpoints, who)
      if (mod.jobs?.length) next = mergeJobs(next, mod.jobs, who)
      return next
    },
  }
}

const DEFAULT_TIMEOUT_MS = 10_000

/** Order plugins by array position, honoring `dependsOn` edges. Stable; cycle-safe. */
export function orderPlugins(plugins: KernelPlugin[]): KernelPlugin[] {
  const byName = new Map<string, KernelPlugin>()
  for (const p of plugins) byName.set(p.name, p)

  const visited = new Set<string>()
  const onStack = new Set<string>()
  const ordered: KernelPlugin[] = []

  const visit = (plugin: KernelPlugin, trail: string[]): void => {
    if (visited.has(plugin.name)) return
    if (onStack.has(plugin.name)) {
      throw new PluginCycleError(`Plugin dependency cycle: ${[...trail, plugin.name].join(' → ')}`)
    }
    onStack.add(plugin.name)
    for (const dep of plugin.dependsOn ?? []) {
      const depPlugin = byName.get(dep)
      if (!depPlugin) {
        throw new PluginConflictError(`Plugin "${plugin.name}" dependsOn "${dep}", which is not in the plugins array.`)
      }
      visit(depPlugin, [...trail, plugin.name])
    }
    onStack.delete(plugin.name)
    visited.add(plugin.name)
    ordered.push(plugin)
  }

  for (const plugin of plugins) visit(plugin, [])
  return ordered
}

// Pure merge helpers — the conflict-checked append logic, shared by the plugin
// `extend` surface and by `defineModule` (which threads them to compose a whole
// vertical slice in one setup pass).
function mergeCollections(config: KernelConfig, collections: CollectionConfig[], who: string): KernelConfig {
  const existing = new Set(config.collections.map((c) => c.slug))
  for (const c of collections) {
    if (existing.has(c.slug)) throw new PluginConflictError(`${who} adds collection "${c.slug}", which already exists.`)
    existing.add(c.slug)
  }
  return { ...config, collections: [...config.collections, ...collections] }
}
function mergeGlobals(config: KernelConfig, globals: GlobalConfig[], who: string): KernelConfig {
  const existing = new Set((config.globals ?? []).map((g) => g.slug))
  for (const g of globals) {
    if (existing.has(g.slug)) throw new PluginConflictError(`${who} adds global "${g.slug}", which already exists.`)
    existing.add(g.slug)
  }
  return { ...config, globals: [...(config.globals ?? []), ...globals] }
}
function mergeEndpoints(config: KernelConfig, endpoints: EndpointConfig[], who: string): KernelConfig {
  const existing = new Set((config.endpoints ?? []).map((e) => `${e.method} ${e.path}`))
  for (const e of endpoints) {
    const key = `${e.method} ${e.path}`
    if (existing.has(key)) throw new PluginConflictError(`${who} adds endpoint "${key}", which already exists.`)
    existing.add(key)
  }
  return { ...config, endpoints: [...(config.endpoints ?? []), ...endpoints] }
}
function mergeJobs(config: KernelConfig, jobs: JobDefinition[], who: string): KernelConfig {
  const existing = new Set((config.jobs ?? []).map((j) => j.slug))
  for (const j of jobs) {
    if (existing.has(j.slug)) throw new PluginConflictError(`${who} adds job "${j.slug}", which already exists.`)
    existing.add(j.slug)
  }
  return { ...config, jobs: [...(config.jobs ?? []), ...jobs] }
}

function buildExtensions(getConfig: () => KernelConfig, pluginName: string): PluginExtensions {
  return {
    collections(slugs, fn) {
      const config = getConfig()
      const targets = new Set(slugs)
      for (const slug of slugs) {
        if (!config.collections.some((c) => c.slug === slug)) {
          throw new PluginConflictError(`Plugin "${pluginName}" targets collection "${slug}", which does not exist.`)
        }
      }
      return { ...config, collections: config.collections.map((c) => (targets.has(c.slug) ? fn(c) : c)) }
    },
    addCollections: (...collections) => mergeCollections(getConfig(), collections, `Plugin "${pluginName}"`),
    addGlobals: (...globals) => mergeGlobals(getConfig(), globals, `Plugin "${pluginName}"`),
    addEndpoints: (...endpoints) => mergeEndpoints(getConfig(), endpoints, `Plugin "${pluginName}"`),
    addJobs: (...jobs) => mergeJobs(getConfig(), jobs, `Plugin "${pluginName}"`),
  }
}

function scopedLogger(base: Logger, name: string): Logger {
  const tag = (msg: string) => `[plugin:${name}] ${msg}`
  return {
    debug: (m, meta) => base.debug(tag(m), meta),
    info: (m, meta) => base.info(tag(m), meta),
    warn: (m, meta) => base.warn(tag(m), meta),
    error: (m, meta) => base.error(tag(m), meta),
  }
}

/** Apply all plugins as a left fold over the dependency-ordered list. */
export async function applyPlugins(config: KernelConfig, logger: Logger): Promise<KernelConfig> {
  const plugins = config.plugins ?? []
  if (plugins.length === 0) return config

  const ordered = orderPlugins(plugins)
  let current: KernelConfig = { ...config, plugins: undefined }

  for (const plugin of ordered) {
    const ctx: PluginContext = {
      config: current,
      extend: buildExtensions(() => current, plugin.name),
      log: scopedLogger(logger, plugin.name),
    }
    try {
      const next = await withTimeout(plugin.setup(ctx), DEFAULT_TIMEOUT_MS, plugin.name)
      current = { ...next, plugins: undefined }
    } catch (err) {
      if (err instanceof PluginConflictError || err instanceof PluginCycleError) throw err
      throw new PluginSetupError(plugin.name, err)
    }
  }
  return current
}

async function withTimeout<T>(value: T | Promise<T>, ms: number, name: string): Promise<T> {
  if (!(value instanceof Promise)) return value
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Plugin "${name}" setup exceeded ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([value, timeout])
  } finally {
    clearTimeout(timer!)
  }
}
