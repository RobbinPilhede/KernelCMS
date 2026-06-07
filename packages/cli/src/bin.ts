#!/usr/bin/env node
// Silence Node's "SQLite is an experimental feature" ExperimentalWarning so the
// CLI output stays clean. The built-in node:sqlite adapter emits it on load; it
// is informational and not actionable for CLI users. All other warnings pass
// through unchanged.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message
  const name = typeof warning === 'string' ? (args[0] as string | undefined) : warning.name
  if (name === 'ExperimentalWarning' && message.includes('SQLite')) return
  return (emitWarning as (w: string | Error, ...a: unknown[]) => void)(warning, ...args)
}) as typeof process.emitWarning

import { run } from './index'

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
