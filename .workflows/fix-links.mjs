import { readFileSync, writeFileSync, existsSync, globSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'

const root = 'C:/Users/robin/Desktop/KernelCMS'
const APPLY = process.argv.includes('--apply')

const files = globSync('docs/**/*.md', { cwd: root }).map((f) => resolve(root, f))

const STOP = new Set([
  'and','the','of','to','for','a','an','with','overview','guide','docs','doc','md',
  'intro','introduction','index','readme','getting','started','reference','ref','vs',
  'in','on','its','is','how','your','our','using','use','part','core',
])

function tokens(str) {
  return str
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/^\d+[-_]/, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t))
}

function h1Title(text) {
  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1] : ''
}

// Build canonical index of real docs.
const real = files.map((path) => {
  const text = readFileSync(path, 'utf8')
  const rel = path.replace(root + '\\', '').replace(root + '/', '').replace(/\\/g, '/')
  const segs = rel.split('/')
  const base = segs[segs.length - 1]
  const folder = segs.slice(1, -1).join(' ') // drop leading "docs"
  const tk = new Set([...tokens(base), ...tokens(folder), ...tokens(h1Title(text))])
  return { path, rel, tk }
})

// token -> list of real docs containing it (for distinctiveness).
const tokenIndex = new Map()
for (const d of real) {
  for (const t of d.tk) {
    if (!tokenIndex.has(t)) tokenIndex.set(t, [])
    tokenIndex.get(t).push(d)
  }
}

function bestMatch(targetRel, sourcePath) {
  // tokens from the invented path's basename + its folder
  const segs = targetRel.split('/')
  const cand = new Set([
    ...tokens(segs[segs.length - 1]),
    ...tokens(segs.slice(0, -1).join(' ')),
  ])
  if (cand.size === 0) return null

  let best = null
  let bestScore = 0
  let second = 0
  for (const d of real) {
    if (d.path === sourcePath) continue
    let score = 0
    for (const t of cand) {
      if (d.tk.has(t)) {
        // distinctive tokens (appear in few docs) weigh more
        const spread = tokenIndex.get(t)?.length ?? 99
        score += spread <= 2 ? 2 : 1
      }
    }
    if (score > bestScore) { second = bestScore; bestScore = score; best = d }
    else if (score > second) { second = score }
  }
  // Accept if confident: strong score, and a clear lead over the runner-up.
  if (best && bestScore >= 3 && bestScore > second) return best
  if (best && bestScore >= 2 && bestScore >= second + 2) return best
  return null
}

function relLink(fromPath, toPath) {
  let r = relative(dirname(fromPath), toPath).replace(/\\/g, '/')
  if (!r.startsWith('.')) r = './' + r
  return r
}

const linkRe = /\[([^\]]+)\]\((\.[^)]+?\.md)(#[^)]*)?\)/g
let kept = 0, remapped = 0, delinked = 0
const remapSamples = []

for (const d of real) {
  let text = readFileSync(d.path, 'utf8')
  let changed = false
  text = text.replace(linkRe, (full, label, target, frag) => {
    const abs = resolve(dirname(d.path), target)
    if (existsSync(abs)) { kept++; return full } // already valid
    const match = bestMatch(target, d.path)
    if (match) {
      remapped++
      changed = true
      if (remapSamples.length < 20) remapSamples.push(`${d.rel.split('/').pop()}: ${target}  ->  ${relLink(d.path, match.path)}`)
      return `[${label}](${relLink(d.path, match.path)}${frag || ''})`
    }
    delinked++
    changed = true
    return label // drop the dead link, keep the text
  })
  if (changed && APPLY) writeFileSync(d.path, text)
}

console.log(APPLY ? '=== APPLIED ===' : '=== DRY RUN (no files written) ===')
console.log('kept (already valid):', kept)
console.log('remapped to canonical:', remapped)
console.log('de-linked (no confident match):', delinked)
console.log('--- remap samples ---')
for (const s of remapSamples) console.log(s)
