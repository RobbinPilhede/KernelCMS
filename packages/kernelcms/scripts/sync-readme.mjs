/**
 * Sync the repo-root README into this package before build/publish.
 *
 * npm resolves `files: ["README.md"]` relative to the PACKAGE directory, not the
 * repo root — so without this the published tarball would carry a stale stub
 * instead of the real README. Relative brand-asset paths (which only resolve on
 * GitHub) are rewritten to absolute raw.githubusercontent URLs so the logo and
 * other images render on the npm package page too.
 *
 * Root README.md is the single source of truth; this file is generated.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rootReadme = resolve(here, '../../../README.md')
const pkgReadme = resolve(here, '../README.md')

// Absolute base for assets committed to the repo, so images work off-GitHub (npm).
const RAW_BASE = 'https://raw.githubusercontent.com/RobbinPilhede/KernelCMS/main/'

const source = readFileSync(rootReadme, 'utf8')
const synced = source
  .replace(/srcset="brand\//g, `srcset="${RAW_BASE}brand/`)
  .replace(/src="brand\//g, `src="${RAW_BASE}brand/`)

writeFileSync(pkgReadme, synced)
console.log(`[sync-readme] synced root README -> packages/kernelcms/README.md (${synced.length} bytes)`)
