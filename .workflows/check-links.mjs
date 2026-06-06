import { readFileSync, existsSync } from 'node:fs'
import { globSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

const root = 'C:/Users/robin/Desktop/KernelCMS'
const files = globSync('docs/**/*.md', { cwd: root }).map((f) => join(root, f))

const linkRe = /\]\((\.[^)]+?\.md)(#[^)]*)?\)/g
let total = 0
let broken = 0
const brokenByFile = {}

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  let m
  while ((m = linkRe.exec(text)) !== null) {
    total++
    const target = resolve(dirname(file), m[1])
    if (!existsSync(target)) {
      broken++
      ;(brokenByFile[file] ||= []).push(m[1])
    }
  }
}

console.log('files scanned:', files.length)
console.log('relative .md links:', total)
console.log('broken links:', broken)
console.log('files with broken links:', Object.keys(brokenByFile).length)
console.log('--- sample (first 12 files) ---')
for (const f of Object.keys(brokenByFile).slice(0, 12)) {
  console.log(f.replace(root + '/', '').replace(root + '\\', ''))
  for (const l of brokenByFile[f]) console.log('   ->', l)
}
