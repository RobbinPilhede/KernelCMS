#!/usr/bin/env node
import { run } from './index'

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
