# Competitive Analysis: Sanity

Sanity is the most architecturally distinct competitor KernelCMS faces. Where Payload is a code-first monolith and Strapi is a plugin-driven Node app, Sanity is a _hosted query engine_ wrapped in a configurable editing client. Its two crown jewels — GROQ (a query language for arbitrary JSON) and Portable Text (a serializable rich-text format) — are genuinely good engineering that solved real problems. This teardown separates what Sanity got right (and we should steal) from the lock-in and architectural choices we deliberately reject. The short version: we want GROQ's expressiveness without GROQ's runtime, Studio's configurability without its proprietary query layer, and Portable Text's portability as a first-class output of `@kernel/richtext`.

## GROQ and the Content Lake

Sanity's data lives in a **content lake**: a schemaless, append-style JSON document store hosted by Sanity. You don't model tables; you write documents with a `_type` discriminator and query across all of them with GROQ (Graph-Relational Object Queries).

GROQ is the best part of Sanity. It reads like a projection language over a single global collection:

```groq
*[_type == "post" && publishedAt < now()] | order(publishedAt desc) [0...10] {
  title,
  "slug": slug.current,
  "authorName": author->name,
  "categories": categories[]->title
}
```

Three things make this powerful:

1. **Joins as dereferences.** `author->name` follows a reference inline. `categories[]->title` follows an array of references and projects a field. There is no `JOIN` ceremony.
2. **Projections shape the response.** The `{ ... }` block returns exactly the shape you asked for, computed fields included (`"slug": slug.current`).
3. **One namespace.** `*` is every document. Filters discriminate by `_type`. There is no schema barrier between collections at query time.

The cost is real, though. GROQ runs only against Sanity's content lake (or `@sanity/client` hitting their API). It is a proprietary query language with a proprietary runtime. If you self-host, you don't get GROQ — you get nothing. Your content is portable as JSON export, but your _queries_ are not. Every GROQ query in your frontend is a line tying you to Sanity's hosted service.

KernelCMS rejects the proprietary-runtime model. We give you one query language — the same `where` / `sort` / pagination / `depth` shape — across REST, GraphQL, the Local API, and typed RPC, and it runs on _your_ database through `@kernel/db`. Depth-based dereferencing is our answer to `author->name`:

```ts
import { getPayload } from '@kernel/client'

const posts = await kernel.find({
  collection: 'posts',
  where: {
    and: [{ _status: { equals: 'published' } }, { publishedAt: { less_than: new Date() } }],
  },
  sort: '-publishedAt',
  limit: 10,
  depth: 1, // resolves `author` and `categories` relationships one level deep
})
// posts.docs[0].author.name is fully typed — no GROQ string to parse
```

The tradeoff is honest: GROQ is more expressive for ad-hoc graph traversal than our `depth` model. We win on type safety (GROQ projections are strings; ours are inferred from config), on running against any adapter, and on not coupling your frontend to a vendor. Where users genuinely need GROQ-class traversal, the answer is the GraphQL surface from `@kernel/graphql`, which is also auto-generated from config and runs everywhere.

| Concern        | Sanity (GROQ + content lake) | KernelCMS                                                   |
| -------------- | ---------------------------- | ----------------------------------------------------------- |
| Query language | GROQ (proprietary)           | Unified `where`/`sort`/`depth` over REST/GraphQL/RPC        |
| Runtime        | Sanity-hosted only           | Any `@kernel/db` adapter (Postgres, SQLite, MySQL, MongoDB) |
| Joins          | `->` dereference             | `depth` resolution + relationship fields                    |
| Type safety    | String projections, codegen  | Inferred from `kernel.config.ts`, zero `any`                |
| Self-host      | Not available                | First-class                                                 |

See [Persistence and the Adapter contract](../03-persistence/00-persistence-overview-and-adapter-contract.md) for how `depth` resolution maps onto each backend.

## Sanity Studio

Studio is Sanity's admin app: an open-source, MIT-licensed, single-page React application you configure with `sanity.config.ts` and deploy yourself (or to Sanity's hosting). This is the part of Sanity most worth studying, because it's the closest competitor to `@kernel/admin`.

What Studio gets right:

- **Schema-driven UI.** You declare document types and fields in TypeScript; Studio renders the editor. This is the same config-as-code tenet KernelCMS holds.
- **Structure Builder.** Studio lets you fully reshape the navigation and list/detail panes via a desk structure API. It's an escape hatch we respect.
- **Custom input components.** Any field can be overridden with a React component.
- **Real-time collaboration.** Multiple editors, live cursors, conflict-free merges — backed by the content lake's real-time API.

Where Studio is weaker, and where KernelCMS wins:

- **No native data-grid story.** Studio's list views are functional but it has no equivalent of a virtualized, sortable, resizable table. `@kernel/admin` builds list views on **TanStack Table** with **TanStack Virtual**, so a 100k-row collection scrolls at 60fps with column sizing and server-driven sorting.
- **Bespoke form runtime.** Studio's form engine is custom. We build document edit forms on **TanStack Form** for per-field binding and validation, so the same primitives power custom fields and the rest of the admin.
- **Bespoke data layer.** Studio wires its own data fetching to the content lake. `@kernel/admin` uses **TanStack Query** for every fetch, cache, and invalidation, and **TanStack Router** for type-safe routing and search-param state. **TanStack Store** holds reactive UI state; **TanStack DB** powers optional live/offline collections.

```ts
// kernel.config.ts — Studio-class configurability, TanStack-native rendering
import { buildConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'

export default buildConfig({
  collections: [
    {
      slug: 'posts',
      admin: {
        useAsTitle: 'title',
        defaultColumns: ['title', 'author', '_status', 'publishedAt'],
        // TanStack Table list view, virtualized by default
        listView: { virtualized: true, pageSize: 50 },
      },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        {
          name: 'body',
          type: 'richText',
          // custom field component is an escape hatch, like Studio's inputs
          admin: { components: { Field: './fields/BodyEditor' } },
        },
      ],
    },
  ],
  db: postgresAdapter({ connectionString: process.env.DATABASE_URL! }),
})
```

The architectural lesson from Studio is that **configurability and escape hatches sell**. Strapi's admin is comparatively rigid; Payload's is good but its rendering stack is its own. By standardizing on the TanStack suite, `@kernel/admin` gets a battle-tested data grid, form engine, router, and cache for free — and any team that already knows TanStack can extend the admin without learning a bespoke runtime. See Admin architecture for the full component map.

## Hosted versus Self-Host Tradeoffs

Sanity's commercial model is the content lake. Studio is open source and free; the _data_ lives in Sanity's hosted, metered API. Pricing scales on API requests, bandwidth, document count, and seats. There is no self-hosted content lake — the GROQ engine and real-time API are not products you can run.

```
SANITY                                  KERNELCMS
┌─────────────┐                         ┌─────────────┐
│ Studio (OSS)│  you deploy             │ @kernel/    │  you deploy
│  React SPA  │                         │  admin      │
└──────┬──────┘                         └──────┬──────┘
       │ HTTPS (proprietary API)               │ REST / GraphQL / RPC
┌──────▼──────────────┐                 ┌──────▼──────────────┐
│  Content Lake       │  Sanity-hosted  │  @kernel/server     │  YOUR infra
│  GROQ + real-time   │  (only option)  │  + @kernel/db       │  OR KernelCMS
│  (closed source)    │                 │  (any adapter)      │  Cloud (managed)
└─────────────────────┘                 └─────────────────────┘
```

This is the single biggest strategic gap KernelCMS exploits. Sanity's bet is "you'll never want to run the database." That bet excludes:

- Teams with data-residency or compliance requirements that forbid third-party storage.
- Teams that need the content in _their_ Postgres for joins with application data.
- Teams that want predictable infra cost instead of per-request metering.

KernelCMS offers **two ways to run with full portability between them**:

1. **Self-host.** Docker, Compose, or Kubernetes on Node, Bun, or edge runtimes. Your database, your storage, your queries. Nothing phones home.
2. **KernelCMS Cloud.** Managed multi-tenant hosting with billing, observability, backups, and a global content CDN — the Sanity-style convenience tier.

The guarantee Sanity cannot make: **content and config are always portable between the two.** Your `kernel.config.ts` is the source of truth; your data lives in a standard database you can `pg_dump`. Moving from Cloud to self-host is an export/import, not a migration off a proprietary lake. This is the "no lock-in" wedge stated plainly. See [Deployment topologies](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) and [KernelCMS Cloud](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md).

| Dimension     | Sanity                          | KernelCMS self-host    | KernelCMS Cloud           |
| ------------- | ------------------------------- | ---------------------- | ------------------------- |
| Data location | Sanity content lake only        | Your database          | Managed, exportable       |
| Query engine  | Proprietary GROQ                | Runs on your adapter   | Runs on managed adapter   |
| Pricing model | Per request / bandwidth / seats | Your infra cost        | Metered, but portable out |
| Lock-in       | High (queries + runtime)        | None                   | None (config is portable) |
| Real-time     | Built in                        | Opt-in via TanStack DB | Built in                  |

## Portable Text Lessons

Portable Text is Sanity's rich-text format: rich text as an array of typed blocks and spans, with marks stored as references rather than inline HTML. It is the best-designed rich-text serialization in the CMS space, and we adopt its core ideas directly in `@kernel/richtext`.

```ts
// Portable-Text-style structured output from @kernel/richtext
type RichTextNode =
  | { type: 'block'; style: 'normal' | 'h2' | 'blockquote'; children: SpanNode[] }
  | { type: 'image'; ref: string; alt: string }
  | { type: 'callout'; tone: 'info' | 'warn'; children: RichTextNode[] }

interface SpanNode {
  type: 'span'
  text: string
  marks: string[] // keys into markDefs — links/annotations live out of band
}
```

The lessons we take:

1. **Rich text is data, not HTML.** Storing structured JSON (not an HTML blob like much of Strapi's ecosystem does) means the same content renders to HTML, React, native, AMP, or plain text without re-parsing. It survives format changes.
2. **Marks as references, not inline tags.** Links and annotations are defined once and referenced by key, which keeps spans clean and makes annotations queryable.
3. **Custom blocks are first-class.** A `callout` or an embedded `image` is just another node type. This maps directly onto our **blocks** field type, so the rich-text editor and the block-based page builder share one model.

Where KernelCMS improves on Portable Text:

- **Typed renderers, zero `any`.** Our serializers are typed against the node union, so an unhandled block type is a compile error, not a runtime blank. Sanity's `@portabletext/react` is good but the component map is loosely typed.
- **Editor and storage co-designed.** `@kernel/richtext` ships the block-based editor _and_ the schema, both driven from `kernel.config.ts`. You don't wire a separate editor library to a separate serializer.
- **Portable Text export.** Because we treat rich text as data, `@kernel/richtext` can emit a Portable-Text-compatible document for teams migrating off Sanity — concrete proof of the no-lock-in tenet, in the inbound direction this time.

The takeaway across all four areas: Sanity's _formats and editor_ are excellent and worth matching or beating; its _runtime and hosting_ are a lock-in surface we route around by running the same expressive query model on any database, self-hosted or on KernelCMS Cloud, with content and config portable in both directions.

## Open Questions

- **GROQ parity.** Do we ship a GROQ-compatible read endpoint in `@kernel/graphql` or a dedicated package to ease Sanity migrations, or is GraphQL parity sufficient? A compatibility shim could be a strong migration lever but adds a query surface to maintain.
- **Real-time default.** Sanity makes real-time collaboration default. Should `@kernel/admin` enable TanStack DB live collections by default, or keep it opt-in for performance budget reasons?
- **Annotation model.** Portable Text stores annotations in `markDefs`. We need to decide whether annotations are a richText-internal concern or promoted to queryable relationship fields, which affects how the database adapter indexes them.
