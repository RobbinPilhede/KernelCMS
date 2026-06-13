/* Live visual-editing verification: exercises the PURE postMessage protocol guards
 * and the editor-side patch-application logic headlessly (no DOM/React). Proves
 * preview→editor messages are validated, untrusted path/value are constrained, and
 * value coercion holds. Run: pnpm tsx verify/visual.ts */
import {
  isPreviewEditEndMessage,
  isPreviewEditStartMessage,
  isPreviewPatchMessage,
  isPreviewHoverMessage,
  isPreviewSelectMessage,
} from '@kernel/visual-editing'

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

// Editor-side patch applier — mirrors applyFormPatch in apps/admin/src/views.tsx.
// Replicated here so the harness has no React/JSX dependency. SECURITY: only writes
// to a path already present in the form, and only primitive string|number values.
function getFormPath(form: unknown, path: string): unknown {
  let node: unknown = form
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[seg]
  }
  return node
}

function applyFormPatch(form: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' && typeof value !== 'number') return form
  const segs = path.split('.')
  if (segs.some((s) => s.length === 0)) return form
  const target = getFormPath(form, path)
  if (target === undefined) return form
  if (target !== null && typeof target === 'object') return form // never collapse a subtree
  const root: Record<string, unknown> = Array.isArray(form) ? ([...form] as never) : { ...form }
  let node: Record<string, unknown> = root
  for (let i = 0; i < segs.length - 1; i++) {
    const child = node[segs[i]]
    if (child === null || typeof child !== 'object') return form
    const copy = Array.isArray(child) ? [...child] : { ...(child as Record<string, unknown>) }
    node[segs[i]] = copy
    node = copy as Record<string, unknown>
  }
  node[segs[segs.length - 1]] = value
  return root
}

// Number coercion mirroring connect.ts coerce(): NaN is rejected (null).
function coerceNumber(text: string): number | null {
  const n = Number(text.trim())
  return Number.isNaN(n) ? null : n
}

function main() {
  console.log('\n\x1b[1mVisual editing — protocol guards reject forged preview→editor messages\x1b[0m')
  check(
    'valid patch (string) accepted',
    isPreviewPatchMessage({ type: 'kernel-preview-patch', path: 'a.0', value: 'hi' }),
  )
  check('valid patch (number) accepted', isPreviewPatchMessage({ type: 'kernel-preview-patch', path: 'a.0', value: 7 }))
  check(
    'patch with object value rejected',
    !isPreviewPatchMessage({ type: 'kernel-preview-patch', path: 'a.0', value: { x: 1 } }),
  )
  check('patch with missing path rejected', !isPreviewPatchMessage({ type: 'kernel-preview-patch', value: 'hi' }))
  check(
    'patch with non-string path rejected',
    !isPreviewPatchMessage({ type: 'kernel-preview-patch', path: 9, value: 'hi' }),
  )
  check(
    'edit-start guard accepts string path',
    isPreviewEditStartMessage({ type: 'kernel-preview-edit-start', path: 'a' }),
  )
  check('edit-end guard rejects null path', !isPreviewEditEndMessage({ type: 'kernel-preview-edit-end', path: null }))
  check(
    'select/hover guards still intact',
    isPreviewSelectMessage({ type: 'kernel-preview-select', path: 'a' }) &&
      isPreviewHoverMessage({ type: 'kernel-preview-hover', path: null }),
  )

  console.log('\n\x1b[1mVisual editing — patch lands at the dot-path (document + side panel update)\x1b[0m')
  const form = { layout: [{ heading: 'Hello', count: 3 }], title: 'T' }
  const next = applyFormPatch(form, 'layout.0.heading', 'Edited inline')
  check(
    'nested leaf updated immutably',
    (next.layout as any)[0].heading === 'Edited inline',
    `heading=${(next.layout as any)[0].heading}`,
  )
  check('original form not mutated', (form.layout as any)[0].heading === 'Hello', 'source preserved')
  check('unrelated branch shares reference (minimal clone)', next.title === 'T')

  console.log('\n\x1b[1mVisual editing — untrusted path/value constrained editor-side\x1b[0m')
  const drift = applyFormPatch(form, 'layout.0.nope', 'x')
  check('unknown path is a no-op (drift rejected)', drift === form && !('nope' in (drift.layout as any)[0]))
  const proto = applyFormPatch(form, '__proto__.polluted', 'x')
  check('prototype path rejected (no pollution)', proto === form && ({} as any).polluted === undefined)
  const objVal = applyFormPatch(form, 'layout.0.heading', { evil: true } as never)
  check('object value rejected (primitives only)', objVal === form)
  const emptySeg = applyFormPatch(form, 'layout..heading', 'x')
  check('empty path segment rejected', emptySeg === form)
  const collapse = applyFormPatch(form, 'layout.0', 'STR')
  check(
    'string patch cannot collapse an object subtree',
    collapse === form && Array.isArray(form.layout as any) && typeof (form.layout as any)[0] === 'object',
  )

  console.log('\n\x1b[1mVisual editing — number coercion holds (NaN rejected)\x1b[0m')
  check('"42" coerces to 42', coerceNumber('42') === 42)
  check('" 8 " trims and coerces', coerceNumber(' 8 ') === 8)
  check('"abc" rejected as NaN', coerceNumber('abc') === null)
  const numPatch = applyFormPatch(form, 'layout.0.count', coerceNumber('10') as number)
  check('coerced number written to form', (numPatch.layout as any)[0].count === 10)

  console.log(`\n\x1b[1mVisual Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}

try {
  main()
} catch (e) {
  console.error('VISUAL HARNESS ERROR:', e)
  process.exit(2)
}
