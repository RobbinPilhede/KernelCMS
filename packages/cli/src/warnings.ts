/**
 * Decide whether a process warning is CLI noise we suppress. Two cases, both
 * non-actionable for CLI users:
 *   - ExperimentalWarning: SQLite — emitted by the built-in node:sqlite adapter.
 *   - MODULE_TYPELESS_PACKAGE_JSON — Node reparsing the .ts config when the project
 *     package.json has no `"type"`. Node emits this via the options form
 *     `emitWarning(message, { code })`, so the code is NOT in the message — match
 *     the structured `code`, not the text.
 *
 * `process.emitWarning` is called either as (message, type, code) with positional
 * strings or as (message, { type, code }); handle both, plus an Error warning.
 */
export function isSuppressedWarning(warning: string | Error, args: unknown[]): boolean {
  const message = typeof warning === 'string' ? warning : warning.message
  const opts = args.find((a) => a !== null && typeof a === 'object') as { type?: string; code?: string } | undefined
  const strings = args.filter((a) => typeof a === 'string') as string[]
  const type = opts?.type ?? strings[0] ?? (typeof warning !== 'string' ? warning.name : undefined)
  const code =
    opts?.code ?? strings[1] ?? (typeof warning !== 'string' ? (warning as { code?: string }).code : undefined)
  if (type === 'ExperimentalWarning' && message.includes('SQLite')) return true
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return true
  return false
}

/**
 * Install the warning filter on `process.emitWarning`. Call this once at CLI start
 * (before the user config is dynamically imported). Idempotent. Both the bundled
 * `kernelcms` bin and the workspace `@kernel/cli` bin use it, so the published CLI
 * gets the same quiet output as dev.
 */
let installed = false
export function installWarningFilter(): void {
  if (installed) return
  installed = true
  const original = process.emitWarning.bind(process)
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    if (isSuppressedWarning(warning, args)) return
    return (original as (w: string | Error, ...a: unknown[]) => void)(warning, ...args)
  }) as typeof process.emitWarning
}
