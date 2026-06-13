/* Verify the @kernel/richtext converters (the stored model + the HTML/Markdown
 * importers the migration skills rely on, and the sanitizer). Run: pnpm tsx verify/richtext.ts */
import {
  sanitizeRichText,
  toHTML,
  toPlainText,
  fromHTML,
  fromMarkdown,
  resolveRichTextSchema,
  emptyRichText,
} from '@kernel/richtext'

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, e = '') => {
  if (c) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  } else {
    fails.push(n)
    console.log(`  \x1b[31mFAIL\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  }
}
const schema = resolveRichTextSchema({ preset: 'full' })

console.log('\n\x1b[1mrichtext — converters + sanitizer\x1b[0m')

// fromHTML round-trip
const html1 = '<h2>Title</h2><p>Hello <strong>bold</strong> and <em>italic</em></p><ul><li>one</li><li>two</li></ul>'
const doc1 = fromHTML(html1)
check(
  'fromHTML produces a doc',
  doc1?.type === 'doc' && doc1.children.length >= 3,
  `children=${doc1?.children?.length}`,
)
const back = toHTML(doc1)
check(
  'toHTML round-trips structure',
  /<h2>/.test(back) && /<strong>/.test(back) && /<li>/.test(back),
  back.slice(0, 70),
)
check('toPlainText extracts text', toPlainText(doc1).includes('Hello bold'), toPlainText(doc1).slice(0, 40))

// fromMarkdown (Gutenberg/WordPress + Strapi legacy rely on this path)
const docMd = fromMarkdown('# Heading\n\nA paragraph with **bold**.\n\n- a\n- b')
check(
  'fromMarkdown produces a doc',
  docMd?.type === 'doc' && docMd.children.some((n: any) => n.type === 'heading'),
  `children=${docMd?.children?.length}`,
)

// sanitizer neutralizes dangerous links (security guarantee)
const dirty = {
  v: 1,
  type: 'doc',
  children: [
    {
      type: 'paragraph',
      children: [{ type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', text: 'x' }] }],
    },
  ],
}
const clean = sanitizeRichText(dirty, schema).doc
const cleanHtml = toHTML(clean)
check('sanitizer neutralizes javascript: links', !cleanHtml.includes('javascript:'), cleanHtml.slice(0, 80))

// sanitizer strips a disallowed mark not in the schema
const minimal = resolveRichTextSchema({ preset: 'minimal' }) // bold/italic only
const withCode = {
  v: 1,
  type: 'doc',
  children: [{ type: 'paragraph', children: [{ type: 'text', text: 'x', marks: [{ type: 'code' }] }] }],
}
const strippedCode = sanitizeRichText(withCode, minimal).doc
check('sanitizer strips marks outside the schema', !toHTML(strippedCode).includes('<code>'), toHTML(strippedCode))

check('emptyRichText is a valid empty doc', emptyRichText().type === 'doc', '')

console.log(`\n\x1b[1mrichtext Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
if (fails.length) {
  console.log('Failures:\n  ' + fails.join('\n  '))
  process.exit(1)
}
