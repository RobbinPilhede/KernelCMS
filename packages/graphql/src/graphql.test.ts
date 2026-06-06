import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { createGraphQL } from './index'

let kernel: Kernel
let gql: ReturnType<typeof createGraphQL>
const sys = { user: { id: 'system', roles: ['admin'], collection: 'system' }, overrideAccess: true }
const anon = { user: null, overrideAccess: false }

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'gql-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'authors',
          access: { read: () => true },
          fields: [{ name: 'name', type: 'text', required: true }],
        },
        {
          slug: 'posts',
          access: { read: () => true },
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'views', type: 'number', defaultValue: 0 },
            { name: 'author', type: 'relationship', relationTo: 'authors' },
          ],
        },
        {
          slug: 'secrets',
          access: { read: () => false },
          fields: [{ name: 'code', type: 'text' }],
        },
      ],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
  gql = createGraphQL(kernel)
})
afterEach(async () => {
  await kernel.destroy()
})

describe('GraphQL API', () => {
  it('creates and queries documents through generated types', async () => {
    const created = await gql({
      query: 'mutation($d: JSON!) { createPosts(data: $d) { id title views } }',
      variables: { d: { title: 'Hello GraphQL' } },
      context: sys,
    })
    expect(created.errors).toBeUndefined()
    expect((created.data as { createPosts: { title: string; views: number } }).createPosts.title).toBe('Hello GraphQL')

    const list = await gql({ query: '{ posts { docs { title } totalDocs } }', context: sys })
    const data = list.data as { posts: { docs: { title: string }[]; totalDocs: number } }
    expect(data.posts.totalDocs).toBe(1)
    expect(data.posts.docs[0]!.title).toBe('Hello GraphQL')
  })

  it('fetches a single document by id', async () => {
    const created = await gql({
      query: 'mutation($d: JSON!) { createPosts(data: $d) { id } }',
      variables: { d: { title: 'One' } },
      context: sys,
    })
    const id = (created.data as { createPosts: { id: string } }).createPosts.id
    const one = await gql({
      query: 'query($id: ID!) { postsById(id: $id) { title } }',
      variables: { id },
      context: sys,
    })
    expect((one.data as { postsById: { title: string } }).postsById.title).toBe('One')
  })

  it('populates a relationship field to the related object type', async () => {
    const author = await gql({
      query: 'mutation($d: JSON!){ createAuthors(data:$d){ id } }',
      variables: { d: { name: 'Ada Lovelace' } },
      context: sys,
    })
    const authorId = (author.data as { createAuthors: { id: string } }).createAuthors.id
    await gql({
      query: 'mutation($d: JSON!){ createPosts(data:$d){ id } }',
      variables: { d: { title: 'Notes', author: authorId } },
      context: sys,
    })
    // Selecting nested `author { name }` triggers a per-selection fetch of the related doc.
    const res = await gql({ query: '{ posts { docs { title author { name } } } }', context: sys })
    const docs = (res.data as { posts: { docs: { title: string; author: { name: string } | null }[] } }).posts.docs
    expect(docs[0]!.author?.name).toBe('Ada Lovelace')
  })

  it('enforces collection read access through resolvers', async () => {
    await gql({
      query: 'mutation($d: JSON!) { createSecrets(data: $d) { id } }',
      variables: { d: { code: 'x' } },
      context: sys,
    })
    // Anonymous caller: `secrets` read access is false → the list resolver errors.
    const res = await gql({ query: '{ secrets { totalDocs } }', context: anon })
    expect(res.errors?.length).toBeGreaterThan(0)
  })

  it('surfaces validation errors from the mutation pipeline', async () => {
    const res = await gql({ query: 'mutation { createPosts(data: {}) { id } }', context: sys })
    expect(res.errors?.length).toBeGreaterThan(0)
    expect(res.errors?.[0]?.message ?? '').toMatch(/required|Validation/i)
  })
})
