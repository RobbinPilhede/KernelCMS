# Competitive Analysis: Payload

Payload is the closest competitor to KernelCMS in spirit: a TypeScript-first, config-as-code headless CMS that generates a React admin panel and typed APIs from a single content definition. It is the benchmark we measure against on developer experience, type inference, and the "code is the source of truth" thesis. This teardown covers how Payload is built, where it is strong, where it leaves gaps, and the specific decisions KernelCMS makes to adopt the good parts and beat the rest. Where Payload defines the category, we match it; where it has architectural debt (a custom server, a forked editor, a bolted-on ORM), we route around it by going TanStack-native and adapter-first.

## Payload architecture overview

Payload v3 collapsed into the Next.js App Router. The admin panel, the REST and GraphQL endpoints, and the Local API all run inside a Next.js app, mounted under a catch-all route. This was the headline change from v2 — Payload stopped being a standalone Express server and became a library you install into a Next.js project.

```
┌─────────────────────────────────────────────┐
│  Next.js App Router                          │
│                                              │
│  /(payload)/admin/[[...segments]]  ← React   │
│  /(payload)/api/[...slug]          ← REST    │
│  /(payload)/api/graphql            ← GraphQL │
│                                              │
│  ┌────────────────────────────────────────┐ │
│  │  Local API (in-process operation core)  │ │
│  │  payload.find / create / update / ...   │ │
│  └────────────────────────────────────────┘ │
│              │                               │
│         Database Adapter                     │
│   (Postgres / SQLite via Drizzle, MongoDB)   │
└─────────────────────────────────────────────┘
```

The content model lives in `payload.config.ts`: an array of `collections` and `globals`, each with a `fields` array. Field types cover text, number, relationship, array, blocks, group, tabs, richText, upload, and more. Hooks (`beforeChange`, `afterRead`, and so on) and `access` functions hang off each collection and field. From that config Payload generates the database schema, the REST and GraphQL surface, a TypeScript types file (`payload-types.ts`), and the admin UI.

Persistence is pluggable but narrow. Payload ships `@payloadcms/db-postgres`, `@payloadcms/db-sqlite` (both Drizzle), and `@payloadcms/db-mongodb` (Mongoose). The Drizzle adapters generate migrations from schema diffs. The admin panel is React Server Components heavy, with field components resolved on the server and hydrated on the client. Rich text runs on a Payload-maintained Lexical integration.

The defining strength is the Local API: the same operation core the REST and GraphQL layers call, exposed in-process with full types, so a server function can call `payload.find({ collection: 'posts', where: { ... } })` and get a typed result with zero network hop. KernelCMS's Local/RPC API is a direct response to this — see APIs and Query Language.

## Strengths

**Config-as-code with real type inference.** Payload proved the model: define fields once, get a typed admin, typed APIs, and a generated types file. Drift between schema, API, and UI is structurally impossible because there is one source. This is the bar, and it is high.

**The Local API.** Calling the operation core in-process — same access control, same hooks, same validation as the HTTP layer, but no serialization tax — is the right primitive. It makes Payload genuinely usable as a backend library, not just a CMS with an API.

**Access control granularity.** Payload evaluates access at the operation, document, and field level with functions that receive the request, the user, and the document. Field-level access that can hide or lock individual fields per user is something Strapi's role UI cannot express and Sanity handles only through its separate, GROQ-based document filters.

**Hooks everywhere.** A predictable hook pipeline (`beforeValidate`, `beforeChange`, `afterChange`, `afterRead`, `beforeRead`) at collection and field granularity covers most business logic without ejecting.

**Self-hosting honesty.** You own the database and the deployment. Compared to Sanity — where content lives in Sanity's hosted Content Lake and GROQ is the only query language — Payload's "your Postgres, your server" stance is a real differentiator that we share.

The table below frames where each incumbent sits.

| Capability            | Payload            | Sanity              | Strapi              | KernelCMS                          |
| --------------------- | ------------------ | ------------------- | ------------------- | ---------------------------------- |
| Config-as-code        | Yes                | Schema in JS, content hosted | Partial (UI + code) | Yes (`kernel.config.ts`)           |
| Typed in-process API  | Local API          | Client only         | No                  | Local/RPC API                      |
| Server framework      | Next.js (locked)   | Custom + hosted     | Koa                 | TanStack Start                     |
| Default ORM           | Drizzle / Mongoose | Proprietary         | Knex                | Drizzle (`@kernel/db`)             |
| Swappable infra adapters | DB only         | None                | DB + upload         | DB, storage, auth, email, search, cache, queue |
| Hosted option         | Payload Cloud      | Sanity (default)    | Strapi Cloud        | KernelCMS Cloud (portable)         |

## Weaknesses and gaps

**Next.js is load-bearing and non-optional.** Payload v3 is married to the Next.js App Router. If you want a different router, a different SSR strategy, or to run the admin and the API on different runtimes, you fight the framework. The catch-all-route mounting model leaks Next.js concerns (RSC boundaries, route groups, `generateMetadata`) into CMS configuration. This is the single biggest architectural bet, and it is not yours to change.

KernelCMS makes the opposite bet. The entire stack — admin and API host — is built on TanStack Start, using TanStack Router for type-safe routing, TanStack Query for all data fetching, TanStack Table for list views, TanStack Form for edit forms, TanStack Store for UI state, and TanStack Virtual for long lists and documents. The router is the type-safe surface, not an opaque catch-all.

**Infrastructure beyond the database is not swappable.** Payload's adapter story is essentially the database and a storage plugin. Email, auth strategy, search, cache, and queue are either baked in or left to userland glue. KernelCMS treats every infrastructure concern as a first-class adapter behind one contract:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { s3 } from '@kernel/storage'
import { auth } from '@kernel/auth'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  storage: s3({ bucket: 'media', region: 'eu-north-1' }),
  auth: auth({ strategies: ['password', 'oauth'] }),
  // email, search, cache, queue are adapters too — swap freely
})
```

Swapping SQLite for Postgres, or local disk for S3, is a one-line change. Nothing is hard-wired. See Adapters and the Adapter Contract.

**The richtext editor is a maintenance liability.** Payload maintains its own Lexical integration. Lexical is powerful but heavy, and the integration surface (custom features, serialization, converters) is large and Payload-specific. KernelCMS ships `@kernel/richtext` as a block-based editor with a stable, serializable document model and a converter API, decoupled from any single editor framework so the storage format outlives the editor implementation.

**Migrations and multi-driver parity.** Payload's Drizzle migrations are solid on Postgres but the SQLite and MongoDB stories diverge in capability (MongoDB is schemaless, so "migrations" mean something different). KernelCMS standardizes on one Adapter contract across Postgres (default), SQLite/libSQL, MySQL, and MongoDB, with migrations generated from schema diffs and a documented capability matrix per driver, so you know up front what each backend supports.

**Admin extensibility is React-component injection.** Payload lets you replace field components and views by passing component paths. It works, but it is coupling to Payload's internal component contracts and RSC model. KernelCMS exposes a typed `@kernel/plugin-sdk` and `@kernel/ui` primitives, with TanStack Form field binding as the extension seam, so custom fields are ordinary Form components rather than framework-internal slots.

**No reactive client-side data layer.** Neither Payload nor Strapi offers a live/offline client collection model out of the box; you reach for your own state library. KernelCMS exposes optional TanStack DB collections via `@kernel/client` for reactive, live, and offline-capable admin and frontend experiences — closer to what Sanity's real-time Content Lake offers, but on infrastructure you own.

## What we adopt versus beat

We are deliberate about borrowing what Payload got right and discarding what it got wrong.

| Decision                         | Payload                          | KernelCMS                                              | Verdict |
| -------------------------------- | -------------------------------- | ------------------------------------------------------ | ------- |
| Config-as-code single source     | `payload.config.ts`              | `kernel.config.ts`, same principle                     | Adopt   |
| Typed in-process operation core  | Local API                        | Local/RPC API over TanStack Start server functions     | Adopt + extend |
| Operation/document/field access  | Access functions                 | Same three-level model, evaluated server-side          | Adopt   |
| Field types and hooks            | Rich field set + hook pipeline   | Matched field set, equivalent hook pipeline            | Match   |
| Server framework                 | Next.js App Router (locked)      | TanStack Start, router-first                            | Beat    |
| Infra adapters                   | DB + storage plugin              | DB, storage, auth, email, search, cache, queue         | Beat    |
| Rich text                        | Forked Lexical integration       | `@kernel/richtext` block model + converters            | Beat    |
| Reactive client collections      | None                             | TanStack DB via `@kernel/client`                       | Beat    |
| Hosting portability              | Payload Cloud (some lock-in)     | KernelCMS Cloud, content/config portable both ways     | Beat    |

**Adopt:** the config-as-code thesis, the Local API as the operation core, the three-level access model, and Drizzle as the default SQL ORM. These are correct and we will not reinvent them.

**Extend:** the in-process API becomes a typed RPC surface via TanStack Start server functions, so the same operation core that runs in-process is exposed over the wire with end-to-end inference — `@kernel/rpc` on the server, `@kernel/client` on the consumer. One shared query language (`where` / `sort` / pagination / `depth`) spans REST, GraphQL, Local, and RPC, so you learn it once.

**Beat:** the framework lock-in, the narrow adapter surface, the forked editor, and the absence of a reactive client layer. By standing on TanStack Start rather than Next.js, we keep the router type-safe and the runtime portable across Node, Bun, and edge. By making every infrastructure concern an adapter, "choose everything" is real, not aspirational.

```ts
// The Local API and RPC share one operation core and one query language.
import { kernel } from '@kernel/server'

// In-process (server function) — fully typed, no network hop.
const posts = await kernel.find({
  collection: 'posts',
  where: { status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
})

// Same call, same types, exposed as typed RPC to the client via @kernel/client.
```

For the full positioning against Sanity and Strapi, see [Competitive Analysis: Sanity](./04-competitive-analysis-sanity.md) and [Competitive Analysis: Strapi](./05-competitive-analysis-strapi.md).

## Open questions

- **Hook pipeline parity.** Do we mirror Payload's exact hook names (`beforeChange`, `afterRead`) for migration familiarity, or use clearer names and provide a codemod? Familiarity lowers the switching cost from Payload; clarity serves new users. Leaning toward Payload-compatible names with documented aliases.
- **RSC stance.** TanStack Start supports server functions and SSR but the admin's server-component strategy (how much renders on the server vs. client islands) is not finalized. This affects field-component extensibility and the plugin contract.
- **MongoDB in the capability matrix.** How prominently do we position the MongoDB adapter given that the SQL drivers get richer migration and relational `depth` semantics? Payload treats Mongo as first-class; we may document it as a deliberate trade-off for document-oriented workflows.
- **Payload import path.** A `create-kernel` migration codemod that reads a `payload.config.ts` and emits a `kernel.config.ts` would be a strong adoption lever. Scope and fidelity are undecided.
