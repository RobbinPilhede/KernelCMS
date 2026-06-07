import { describe, expect, it } from 'vitest'
import { isSuppressedWarning } from './warnings'

describe('isSuppressedWarning', () => {
  it('suppresses MODULE_TYPELESS_PACKAGE_JSON via the options form (code, not message)', () => {
    // This is exactly how Node emits it: message text + { code }.
    const message = "Module type of file:///app/kernel.config.ts is not specified and it doesn't parse as CommonJS."
    expect(isSuppressedWarning(message, [{ code: 'MODULE_TYPELESS_PACKAGE_JSON' }])).toBe(true)
  })

  it('also handles the positional (message, type, code) form', () => {
    expect(isSuppressedWarning('msg', ['Warning', 'MODULE_TYPELESS_PACKAGE_JSON'])).toBe(true)
  })

  it('suppresses the SQLite experimental warning', () => {
    expect(
      isSuppressedWarning('SQLite is an experimental feature and might change at any time', ['ExperimentalWarning']),
    ).toBe(true)
    expect(isSuppressedWarning('SQLite is an experimental feature', [{ type: 'ExperimentalWarning' }])).toBe(true)
  })

  it('does NOT suppress unrelated warnings', () => {
    expect(isSuppressedWarning('something deprecated', ['DeprecationWarning'])).toBe(false)
    expect(isSuppressedWarning('a custom experimental thing', ['ExperimentalWarning'])).toBe(false) // not SQLite
    expect(isSuppressedWarning(new Error('boom'), [])).toBe(false)
  })
})
