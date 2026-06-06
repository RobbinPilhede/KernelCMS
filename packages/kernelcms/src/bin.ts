#!/usr/bin/env node
/**
 * The `kernel` CLI (migrate / seed / generate:types / dev).
 *
 * Config loading uses a dynamic `import()` of your `kernel.config.ts`, so run on
 * Node >= 22.6 with type stripping (or point --config at a compiled .js/.mjs).
 */
import { run } from '@kernel/cli'

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
