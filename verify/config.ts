/**
 * Verification config — a real kernel that exercises every feature shipped today:
 * agent principals (fieldScope + draft-only), access.publish gate, onDelete
 * (setNull/cascade/restrict), relationship/upload auto-indexing, N+1 populate,
 * versions/attribution, the blocks page-builder, and an mcp:true custom endpoint.
 *
 * Run via the harness in verify/run.ts (tsx). Not part of the test suite.
 */
import { defineConfig, defineEndpoint } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

const isEditor = ({ req }: { req: { user?: { roles?: string[] } } }) =>
  Boolean(req.user?.roles?.includes('editor') || req.user?.roles?.includes('admin'))
const isAdmin = ({ req }: { req: { user?: { roles?: string[] } } }) => Boolean(req.user?.roles?.includes('admin'))
const authed = ({ req }: { req: { user?: unknown } }) => Boolean(req.user)

export function makeConfig(dbUrl: string) {
  return defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: dbUrl }),
    audit: true,

    // Two scoped agents with different field allow-lists (multi-agent proof).
    agents: [
      {
        id: 'content-bot',
        token: 'tok-content',
        roles: ['editor'],
        fieldScope: { allow: ['title', 'body', 'layout'] },
      },
      { id: 'tags-bot', token: 'tok-tags', roles: ['editor'], fieldScope: { allow: ['categories'] } },
    ],

    collections: [
      {
        slug: 'users',
        auth: true,
        access: { read: authed, create: isAdmin, update: authed, delete: isAdmin },
        fields: [
          { name: 'name', type: 'text' },
          {
            name: 'roles',
            type: 'select',
            hasMany: true,
            options: ['admin', 'editor', 'viewer'],
            defaultValue: ['viewer'],
          },
        ],
      },
      {
        slug: 'authors',
        access: { read: () => true, create: authed, update: authed, delete: authed },
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'email', type: 'email', unique: true },
        ],
      },
      {
        slug: 'categories',
        access: { read: () => true, create: authed, update: authed, delete: authed },
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true },
        ],
      },
      {
        slug: 'media',
        upload: true,
        access: { read: () => true, create: authed, update: authed, delete: authed },
        fields: [{ name: 'alt', type: 'text' }],
      },
      {
        slug: 'posts',
        versions: { drafts: true },
        access: {
          read: () => true,
          create: authed,
          update: authed,
          publish: isEditor, // distinct publish gate (today's feature)
          delete: isAdmin,
        },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'body', type: 'richText' },
          { name: 'featured', type: 'checkbox', defaultValue: false },
          // relationship + onDelete (today's feature) + auto-index (today's feature)
          { name: 'author', type: 'relationship', relationTo: 'authors', onDelete: 'setNull' },
          { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true, onDelete: 'restrict' },
          { name: 'cover', type: 'upload', relationTo: 'media', onDelete: 'setNull' },
          // blocks page-builder (the agent composes this)
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              {
                slug: 'hero',
                fields: [
                  { name: 'heading', type: 'text' },
                  { name: 'sub', type: 'text' },
                ],
              },
              {
                slug: 'cta',
                fields: [
                  { name: 'label', type: 'text' },
                  { name: 'href', type: 'text' },
                ],
              },
            ],
          },
        ],
      },
      {
        slug: 'comments',
        access: { read: () => true, create: () => true, update: authed, delete: authed },
        fields: [
          { name: 'body', type: 'text', required: true },
          // cascade: deleting a post deletes its comments (today's feature)
          { name: 'post', type: 'relationship', relationTo: 'posts', onDelete: 'cascade' },
        ],
      },
    ],

    globals: [
      {
        slug: 'settings',
        access: { read: () => true, update: isAdmin },
        fields: [{ name: 'site_name', type: 'text' }],
      },
    ],

    // An mcp:true custom endpoint — exposed as an agent tool, gated by its own access.
    endpoints: [
      defineEndpoint({
        method: 'POST',
        path: '/posts/:id/touch',
        access: authed,
        mcp: true,
        summary: 'Touch a post (verification endpoint)',
        handler: async ({ input, ctx }: any) => {
          const id = input?.params?.id
          return { touched: id, by: ctx.req.user?.id ?? null }
        },
      }),
    ],
  })
}
