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
