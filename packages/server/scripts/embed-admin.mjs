// Reads the single-file admin build (apps/admin/dist/index.html) and writes it
// into a TS module that @kernel/server imports and serves. Run after the admin
// builds and before bundling the server. Keeps the published package
// self-contained (no runtime asset paths).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const htmlPath = resolve(here, '../../../apps/admin/dist/index.html')
const outPath = resolve(here, '../src/admin-assets.generated.ts')

if (!existsSync(htmlPath)) {
  throw new Error(`Admin build not found at ${htmlPath}. Build @kernel/admin-app first.`)
}

const html = readFileSync(htmlPath, 'utf8')
const banner = '// AUTO-GENERATED from apps/admin build — do not edit by hand.\n'
writeFileSync(outPath, `${banner}export const ADMIN_HTML = ${JSON.stringify(html)}\n`)
console.log(`embed-admin: wrote ${outPath} (${(html.length / 1024).toFixed(1)} KB)`)
