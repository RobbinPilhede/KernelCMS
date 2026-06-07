#!/usr/bin/env node
/**
 * The `kernel` CLI (migrate / seed / generate:types / dev).
 *
 * Config loading uses a dynamic `import()` of your `kernel.config.ts`, so run on
 * Node >= 22.6 with type stripping (or point --config at a compiled .js/.mjs).
 */
import { installWarningFilter, run } from '@kernel/cli'

// Quiet Node's non-actionable config-load warnings (SQLite experimental,
// MODULE_TYPELESS_PACKAGE_JSON) before the config is dynamically imported.
installWarningFilter()

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
  // Signal failure via the exit code rather than a hard process.exit(), which can
  // abort with a libuv UV_HANDLE_CLOSING assertion on Windows during teardown.
  process.exitCode = 1
})
