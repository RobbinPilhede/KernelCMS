# Content lifecycle

Scheduled publish makes a draft go live at a future instant. **Content lifecycle** is the
inverse: give a *published* document an expiry date, and when that date passes KernelCMS
retires it for you — unpublishing, archiving, or deleting it on the next cron drain.

It is built for embargoes (a press release that may not stay live past a date), time-limited
campaigns (a promo that should fall offline on its own), retention and compliance (content
that must not outlive a window), and auto-retiring stale content. You set an expiry on the
content you can already edit; KernelCMS handles the rest on a schedule.

## Opt in

Lifecycle is off until you configure it. Add a `lifecycle` block listing the collections
that should expire content, and how:

```ts
export default defineConfig({
  lifecycle: {
    collections: [
      { slug: 'promos', expireField: 'expire_at', onExpire: 'unpublish' },
      { slug: 'press',  expireField: 'embargo_until', onExpire: 'archive' },
      { slug: 'tmp',    onExpire: 'delete' }, // expireField defaults to 'expire_at'
    ],
  },
  collections: [/* … */],
})
```

Each entry has:

| Key | Meaning |
| --- | ------- |
| `slug` | The collection that expires content. Must be a real, **drafts-enabled** collection. |
| `expireField` | The **`date` field** holding when a document expires. Default `'expire_at'`. |
| `onExpire` | What to do when it passes: `'unpublish'` \| `'archive'` \| `'delete'`. Default `'unpublish'`. |

Two requirements the config enforces:

- The `slug` must be a **drafts-enabled** collection (`versions: { drafts: true }`). Expiry
  acts on the published/draft lifecycle, so a collection without drafts has nothing to retire.
- The `expireField` must already be a **declared `date` field** on that collection. **You own
  the schema** — KernelCMS never auto-adds the column. Declare it yourself:

```ts
{
  slug: 'promos',
  versions: { drafts: true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'expire_at', type: 'date' }, // YOU declare the expiry field
  ],
}
```

## The three actions

When a **published** document's `expireField` date has passed, the next drain retires it
according to `onExpire`:

- **`unpublish`** (the default) — the document goes **back to draft**. Exactly the inverse of
  a publish: it leaves the read view but the content stays put, ready to re-publish or edit.
- **`archive`** — the document goes to draft **and** gets a server-managed `_archived_at`
  timestamp. An archived document is **hidden from public reads** like any draft, but the
  `_archived_at` stamp makes it **distinguishable from a plain draft** — so "expired and
  retired" reads differently from "never published" or "manually unpublished".
- **`delete`** — the document is **removed**.

`unpublish` and `archive` are recoverable (the content is still there); `delete` is not. Pick
per collection based on whether you need retention or cleanup.

### What `_archived_at` is

`_archived_at` is a **server-managed** column. It is written *only* by the lifecycle drain
when it archives a document, and cleared only when the document is re-published through the
normal lifecycle. It is hidden from public reads, and it is the marker that separates an
archived document from a draft that simply hasn't been published yet — useful for an admin
"Archived" view or a retention audit.

## Running the drain

Expiry is applied by a single Local-API operation:

```ts
const { processed } = await kernel.processContentLifecycle({ now, limit })
// processed: Array<{ collection, id, action }>
```

`processContentLifecycle` scans the configured lifecycle collections for published documents
whose `expireField` is at or before `now` (defaults to the current time) and retires each per
its `onExpire`. It returns a `processed` array of `{ collection, id, action }` describing what
it did. Both arguments are optional:

- `now?` — the instant to evaluate expiry against (defaults to "now"). Validated.
- `limit?` — an upper bound on how many documents to retire in one drain. Clamped.

Like `processScheduledPublishes`, this is a **trusted, cron-driven maintenance operation** —
it runs under override, and there is **no HTTP trigger** for it. Drive it from a cron in one
of two ways:

```bash
# the dedicated lifecycle drain
* * * * * cd /app && npx kernel lifecycle:run

# or jobs:run, which now drains scheduled publishes, releases, AND content lifecycle
* * * * * cd /app && npx kernel jobs:run
```

`kernel lifecycle:run` runs only the lifecycle drain; `kernel jobs:run` drains everything due
(background jobs, scheduled publishes, scheduled releases, and lifecycle) in one pass — use it
when you want a single cron line for all due maintenance.

Each retire is **audited** with a `content.expire` entry, so an expiry is traceable the same
way a publish or a delete is.

## The guarantees

Content lifecycle is deliberately narrow, and its safety rests on a few properties:

- **The drain is cron/operator-only.** `processContentLifecycle` is a trusted maintenance op
  with **no HTTP trigger** — it is never reachable from an untrusted caller. That is precisely
  *why* it can run under `overrideAccess` safely: the only way to invoke it is from operator
  code or a cron you control.
- **`_archived_at` is client-immutable.** It is server-managed: a normal user can **never set
  it** (to fake an archive) or **clear it** (to un-archive) through the API. Only the trusted
  drain writes it. There is no client path to forge or erase the archived marker.
- **`expireField` is an ordinary editor field.** Setting an expiry is a normal write — you can
  only put an expiry on content you can already write. There is nothing privileged about
  scheduling expiry; the privilege lives entirely in the drain that *applies* it.
- **Scope is confined.** The drain **only ever touches the configured lifecycle collections**.
  A collection you didn't list is never expired, archived, or deleted.
- **It is bounded and resilient.** `now` and `limit` are validated and clamped, and the drain
  is resilient per-document — one document failing to retire doesn't abort the rest of the
  pass.

Pairs naturally with the
[draft/publish lifecycle](conventions.md#drafts-publish-and-the-default-read-view) (the
forward direction is scheduled publish) and [content releases](releases.md).
