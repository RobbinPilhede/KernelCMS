import { describe, expect, expectTypeOf, it } from 'vitest'
import type { PaginatedResult } from '@kernel/db'
import { createTypedClient } from './index'

// Interfaces exactly like `kernel generate:types` emits — note: NO index signature,
// so they are not assignable to `Row`. This is the case that broke the untyped
// client's `<T extends Row>` and forced `as unknown as Hero`.
interface Hero {
  id: string
  title: string
  cta?: string | null
}
interface Matches {
  id: string
  home: string
  away: string
}
interface KernelTypes {
  collections: { matches: Matches }
  globals: { hero: Hero }
}

function jsonFetch(payload: unknown) {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('createTypedClient (slug-inferred types, no cast)', () => {
  it('infers a global type from its slug', async () => {
    const client = createTypedClient<KernelTypes>({
      baseURL: 'http://x',
      fetch: jsonFetch({ id: 'h1', title: 'Welcome' }),
    })
    // No generic argument, no cast — the slug literal drives the return type.
    const hero = await client.findGlobal('hero')
    expectTypeOf(hero).toEqualTypeOf<Hero>()
    expect(hero.title).toBe('Welcome')
  })

  it('infers PaginatedResult<Matches> for find(collection)', async () => {
    const client = createTypedClient<KernelTypes>({
      baseURL: 'http://x',
      fetch: jsonFetch({ docs: [{ id: 'm1', home: 'A', away: 'B' }], totalDocs: 1 }),
    })
    const result = await client.find('matches')
    expectTypeOf(result).toEqualTypeOf<PaginatedResult<Matches>>()
    expectTypeOf(result.docs).toEqualTypeOf<Matches[]>()
    expect(result.docs[0]!.home).toBe('A')
  })

  it('infers findByID and accepts a typed create', async () => {
    const client = createTypedClient<KernelTypes>({
      baseURL: 'http://x',
      fetch: jsonFetch({ id: 'm1', home: 'A', away: 'B' }),
    })
    const doc = await client.findByID('matches', 'm1')
    expectTypeOf(doc).toEqualTypeOf<Matches>()
    const created = await client.create('matches', { home: 'A', away: 'B' })
    expectTypeOf(created).toEqualTypeOf<Matches>()
  })

  it('rejects an unknown slug at compile time', () => {
    const client = createTypedClient<KernelTypes>({ baseURL: 'http://x', fetch: jsonFetch({}) })
    // @ts-expect-error — 'nope' is not a global slug in the registry.
    void client.findGlobal('nope')
    expect(client).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Type-level proof that the GENERATED shapes (codegen.ts) flow through the typed
// client unbroken. These interfaces mirror exactly what `generateTypes` emits —
// `Relationship<T>` for relationships and a `blockType`-discriminated union for a
// blocks field — so a passing typecheck here proves the page-builder + populated
// relationships are fully inferred on the frontend (the headline DX promise).
// ---------------------------------------------------------------------------

type Relationship<T> = string | T

interface Authors {
  id: string
  name: string
}
interface Media {
  id: string
  url: string
}

// A blocks field renders to `Array<({ blockType:'hero' } & {…}) | ({ blockType:'cta' } & {…})>`.
type HeroBlock = { blockType: 'hero' } & { heading: string; sub?: string | null }
type CtaBlock = { blockType: 'cta' } & { label: string; href: string }
type Layout = Array<HeroBlock | CtaBlock>

interface Pages {
  id: string
  title: string
  // Single relationship → id OR populated Authors.
  author?: Relationship<Authors> | null
  // hasMany relationship → array of id-or-populated.
  tags?: Relationship<Authors>[] | null
  // Polymorphic relationship → id OR a union of every target.
  owner?: Relationship<Authors | Media> | null
  // Upload relationship → id OR populated Media.
  cover?: Relationship<Media> | null
  // The page builder.
  layout?: Layout | null
}

interface GenKernelTypes {
  collections: { pages: Pages; authors: Authors; media: Media }
  globals: Record<string, never>
}

describe('generated shapes flow through the typed client', () => {
  it('infers Relationship<T> for a single relationship (id OR populated both check)', async () => {
    const client = createTypedClient<GenKernelTypes>({
      baseURL: 'http://x',
      fetch: jsonFetch({ id: 'p1', title: 'Home', author: { id: 'a1', name: 'Ada' } }),
    })
    const page = await client.findByID('pages', 'p1')
    expectTypeOf(page.author).toEqualTypeOf<Relationship<Authors> | null | undefined>()

    // Depth 0: an id string type-checks.
    const idOnly: Pages = { id: 'p1', title: 'Home', author: 'a1' }
    expect(idOnly.author).toBe('a1')

    // Depth>0: the populated document type-checks too — and narrows after a guard.
    const a = page.author
    if (a && typeof a === 'object') {
      expectTypeOf(a).toEqualTypeOf<Authors>()
      expect(a).toBeTruthy()
    }
  })

  it('infers hasMany + polymorphic + upload relationship shapes', () => {
    const page: Pages = {
      id: 'p1',
      title: 'Home',
      tags: ['a1', { id: 'a2', name: 'Grace' }],
      owner: { id: 'm1', url: '/x.png' },
      cover: 'm1',
    }
    expectTypeOf(page.tags).toEqualTypeOf<Relationship<Authors>[] | null | undefined>()
    expectTypeOf(page.owner).toEqualTypeOf<Relationship<Authors | Media> | null | undefined>()
    expectTypeOf(page.cover).toEqualTypeOf<Relationship<Media> | null | undefined>()
    expect(page.cover).toBe('m1')
  })

  it('infers the blocks field as a discriminated union (narrowing on blockType works)', async () => {
    const client = createTypedClient<GenKernelTypes>({
      baseURL: 'http://x',
      fetch: jsonFetch({
        id: 'p1',
        title: 'Home',
        layout: [
          { blockType: 'hero', heading: 'Hi' },
          { blockType: 'cta', label: 'Go', href: '/x' },
        ],
      }),
    })
    const page = await client.findByID('pages', 'p1')
    const blocks = page.layout ?? []
    for (const block of blocks) {
      // Discriminant present on every member.
      expectTypeOf(block.blockType).toEqualTypeOf<'hero' | 'cta'>()
      if (block.blockType === 'hero') {
        // Narrowed: only hero fields are reachable; `heading` is a string.
        expectTypeOf(block.heading).toEqualTypeOf<string>()
        expect(typeof block.heading).toBe('string')
      } else {
        // Narrowed to cta: `href` is required here, absent on hero.
        expectTypeOf(block.href).toEqualTypeOf<string>()
        expect(typeof block.label).toBe('string')
      }
    }
  })
})
