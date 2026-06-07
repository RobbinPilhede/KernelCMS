#!/usr/bin/env node
// Keep CLI output clean by silencing two noisy, non-actionable warnings Node emits
// for the way the config is loaded:
//   - ExperimentalWarning: SQLite — the built-in node:sqlite adapter on load.
//   - MODULE_TYPELESS_PACKAGE_JSON — reparsing a .ts/.js config without "type".
// Everything else passes through unchanged.
import { isSuppressedWarning } from './warnings'

const emitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  if (isSuppressedWarning(warning, args)) return
  return (emitWarning as (w: string | Error, ...a: unknown[]) => void)(warning, ...args)
}) as typeof process.emitWarning

import { run } from './index'

run(process.argv.slice(2))
  .then(() => {
    // Let the event loop drain naturally so adapters (e.g. node:sqlite) finish
    // closing. Calling process.exit() here can abort with a libuv
    // `UV_HANDLE_CLOSING` assertion on Windows while a handle is mid-close.
  })
  .catch((err: unknown) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
    // Signal failure via the exit code, but don't hard-kill: a hard process.exit()
    // during teardown triggers the Windows libuv assertion. The process exits once
    // the loop is idle (commands that keep running, like `dev`, manage their own).
    process.exitCode = 1
  })
