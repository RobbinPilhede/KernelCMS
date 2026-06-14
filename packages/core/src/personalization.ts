/**
 * Personalization + A/B experiments.
 *
 * The personalization parallel of localization (`fields.ts`'s per-locale maps): a
 * `personalized` field stores a `{ [segment]: value }` JSON map keyed by AUDIENCE
 * SEGMENT instead of locale. On write the value is merged into the segment being written
 * (other segments are never clobbered); on read it resolves to the active audience
 * segment, then the default segment, then null. Experiments bucket a caller-supplied
 * visitor key deterministically to a variant — and a variant IS a segment id.
 *
 * SECURITY — the properties that matter:
 *
 *  1. SEGMENT KEYS ARE GUARDED. `audience` is an untrusted request value. Only a
 *     configured segment is ever honoured (unknown → default), and segment ids are
 *     checked against the prototype-pollution vectors `__proto__`/`constructor`/
 *     `prototype` at sanitize AND whenever one is used as a map key — so a hostile
 *     `audience` can never poison the per-segment map or the output document.
 *
 *  2. NO CROSS-SEGMENT LEAK. Resolution returns ONLY the requested segment's value (or
 *     the documented default-segment fallback) — never another segment's content. A
 *     personalized field is still filtered by field read-access in the operations layer,
 *     so a read-denied personalized field is stripped regardless of audience.
 *
 *  3. NO RAW VISITOR KEYS. `assignVariant` hashes (`seed`+experiment+key) with a fast,
 *     non-cryptographic, NON-reversible-to-PII hash; the raw key is never returned or
 *     recorded. The hash is stable, so assignments are sticky.
 */

/** Object property keys that must never be used as a segment map key (prototype
 *  pollution vectors). Shared by sanitize and every runtime map access. */
export const FORBIDDEN_SEGMENT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** True when a string is a safe, usable segment-map key (not a pollution vector). */
export function isSafeSegmentKey(key: string): boolean {
  return !FORBIDDEN_SEGMENT_KEYS.has(key)
}

/** Options threaded into {@link resolvePersonalized} (parallel to DeserializeOptions). */
export interface ResolvePersonalizedOptions {
  /** The active audience segment to resolve to. */
  segment: string
  /** The configured default segment, used when `segment` has no stored value. */
  defaultSegment: string
}

/**
 * Resolve a stored `{ [segment]: value }` map to a single value:
 *   1. the active `segment` (when present and the key is safe),
 *   2. else the `defaultSegment`,
 *   3. else null.
 * A non-object raw value (legacy / non-personalized storage) is returned as-is. Never
 * reads through a prototype-pollution key, and never reveals a segment other than the
 * one asked for (beyond the documented default fallback).
 */
export function resolvePersonalized(raw: unknown, opts: ResolvePersonalizedOptions): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const map = raw as Record<string, unknown>
    if (isSafeSegmentKey(opts.segment) && Object.prototype.hasOwnProperty.call(map, opts.segment)) {
      return map[opts.segment]
    }
    if (isSafeSegmentKey(opts.defaultSegment) && Object.prototype.hasOwnProperty.call(map, opts.defaultSegment)) {
      return map[opts.defaultSegment]
    }
    return null
  }
  return raw ?? null
}

/** Resolve an untrusted audience value to a KNOWN, safe segment id. Anything not configured
 *  (absent, unknown, or a prototype-pollution key) collapses to the default segment, so a
 *  hostile `audience` can never inject a map key or read another segment's content. Returns
 *  `''` when audiences are disabled. (The pure twin of operations' internal `resolveSegment`,
 *  exported so the decision engine and tests share one definition.) */
export function resolveAudienceSegment(
  audiences: { enabled: boolean; segments: string[]; default: string },
  raw: unknown,
): string {
  if (!audiences.enabled) return ''
  if (typeof raw === 'string' && isSafeSegmentKey(raw) && audiences.segments.includes(raw)) return raw
  return audiences.default
}

/** A defensive copy of a stored per-segment map (so callers can't mutate storage). */
export function segmentMapCopy(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (isSafeSegmentKey(key)) out[key] = value
    }
    return out
  }
  return {}
}

// ---------------------------------------------------------------------------
// Deterministic A/B bucketing
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit: a fast, stable, non-cryptographic string hash. We only need a uniform,
 *  deterministic spread over the variant buckets — not collision resistance — and it is
 *  NOT reversible to the input PII. Returns an unsigned 32-bit integer. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // hash *= 16777619, kept in 32-bit space via the >>> 0 below.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/** A bucketing experiment: variants with parallel non-negative weights (sum > 0) and a
 *  seed namespacing the hash. */
export interface BucketExperiment {
  slug: string
  variants: string[]
  weights: number[]
  seed: string
}

/**
 * Deterministically pick a variant for a visitor `key`. Maps the stable hash of
 * `seed:slug:key` to a point in `[0, totalWeight)` and walks the cumulative weights, so
 * the SAME key always lands in the SAME variant and the distribution matches the weights.
 * Only the hash of `key` is used — the raw key is never retained.
 */
export function bucketVariant(experiment: BucketExperiment, key: string): string {
  const { variants, weights } = experiment
  // Defensive: an empty variant list can't happen post-sanitize, but never index undefined.
  if (variants.length === 0) return ''
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total <= 0) return variants[0]!
  // Map the 32-bit hash into [0, total) deterministically.
  const hash = fnv1a32(`${experiment.seed}:${experiment.slug}:${key}`)
  const point = (hash / 0x100000000) * total
  let cumulative = 0
  for (let i = 0; i < variants.length; i++) {
    cumulative += weights[i]!
    if (point < cumulative) return variants[i]!
  }
  // Floating-point edge: point === total. Fall to the last variant.
  return variants[variants.length - 1]!
}
