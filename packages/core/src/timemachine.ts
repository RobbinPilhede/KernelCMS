import type { Row } from '@kernel/db'
import type { VersionDiff } from './types'

/**
 * Deterministic deep-equality for two field values. Compares structurally: primitives by
 * `Object.is` (so `NaN` equals `NaN` and `-0 !== 0` is not treated as a change either way),
 * arrays element-wise, and plain objects key-by-key (order-independent). RichText and other
 * nested object/array shapes are therefore compared by full structural identity and reported
 * changed on ANY nested difference. Dates/values that aren't plain objects fall back to a
 * canonical JSON comparison, keeping the result stable and side-effect free.
 */
// Recursion cap: a pathologically deep value (already rejected at write time by the
// adapter's JSON encoding, so unreachable via stored snapshots) falls back to a JSON
// compare instead of overflowing the stack. Defense-in-depth for an unexpected caller.
const MAX_EQUAL_DEPTH = 100

export function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (depth >= MAX_EQUAL_DEPTH) {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }

  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr !== bArr) return false
  if (aArr && bArr) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], depth + 1)) return false
    return true
  }

  // Non-plain objects (Date, etc.): compare by canonical JSON so the result is deterministic.
  const aProto = Object.getPrototypeOf(a)
  const bProto = Object.getPrototypeOf(b)
  const aPlain = aProto === Object.prototype || aProto === null
  const bPlain = bProto === Object.prototype || bProto === null
  if (!aPlain || !bPlain) {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }

  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth + 1)) return false
  }
  return true
}

/**
 * Field-level diff between two documents over an explicit set of field names. Pure and
 * deterministic: a field appears in the result iff its `a` and `b` values are not
 * structurally equal (see {@link deepEqual}). Restricting to `fieldNames` lets the caller
 * pass only the fields the principal may read AND only real schema fields, so system/volatile
 * keys and read-denied fields never leak into a diff. Missing keys read as `undefined`.
 */
export function diffDocs(a: Row, b: Row, fieldNames: readonly string[]): VersionDiff {
  const diff: VersionDiff = {}
  for (const name of fieldNames) {
    const from = a[name]
    const to = b[name]
    if (!deepEqual(from, to)) diff[name] = { from, to }
  }
  return diff
}

/** The set of field names that changed between two docs (the keys of {@link diffDocs}). */
export function changedFieldNames(a: Row, b: Row, fieldNames: readonly string[]): string[] {
  const names: string[] = []
  for (const name of fieldNames) {
    if (!deepEqual(a[name], b[name])) names.push(name)
  }
  return names
}

/**
 * Validate + parse an ISO-ish timestamp into epoch millis, or throw via `onBad`. Accepts
 * anything `Date` can parse to a finite time (ISO 8601 in practice); rejects garbage,
 * non-strings, and `Invalid Date`. Used to harden every `asOf`/`from`/`to` boundary so a
 * malformed value is a clean 400, never an adapter error or an unbounded query input.
 */
export function parseTimestamp(value: unknown, onBad: (v: unknown) => never): number {
  if (typeof value !== 'string') return onBad(value)
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return onBad(value)
  return t
}
