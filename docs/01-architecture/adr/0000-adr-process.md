# ADR 0000: Architecture Decision Record Process

This ADR defines how KernelCMS records architectural decisions, how they move through their lifecycle, where they live in the repository, and how they are numbered. It is self-referential: the process described here governs every ADR that follows, including this one. If you are about to make a decision that is expensive to reverse — picking Drizzle as the default ORM, exposing the Local API as RPC through TanStack Start server functions, choosing how field-level localization is stored — you write it down here first.

## Why ADRs at all

A headless CMS accumulates load-bearing decisions fast. KernelCMS exposes REST, GraphQL, and a typed Local/RPC API over a swappable adapter layer (database, storage, email, auth, search, cache, queue). Each of those surfaces inherits assumptions made years earlier. When a contributor asks "why does `depth` resolve relationships breadth-first instead of per-field?" the answer must be discoverable in minutes, not reconstructed from a Git archaeology session or a Discord thread that scrolled away.

Payload, Sanity, and Strapi mostly do not do this in the open. Their architectural rationale lives in maintainers' heads, closed RFC repos, or scattered GitHub discussions. That is a defensible choice for a company-owned product, but KernelCMS is open-source core under MIT with a deliberately swappable architecture. Our wedge — "choose everything" — only holds if the contract each adapter implements is documented and the reasoning behind that contract is permanent. ADRs are how we make the reasoning permanent.

An ADR captures one decision: the context that forced it, the options considered, the choice, and the consequences we accept. It is not a design doc, not a tutorial, and not a spec. A spec tells you *what the Adapter contract is*; the ADR tells you *why it looks like that and what we gave up*.

## The ADR format

Every ADR is a single Markdown file using the template below. We keep the template short on purpose — a heavy format does not get filled in.

```markdown
# ADR NNNN: <Short imperative title>

- Status: Proposed | Accepted | Superseded by ADR-MMMM | Rejected
- Date: YYYY-MM-DD
- Deciders: <github handles>
- Tags: <area, e.g. db, api, admin, auth>

## Context

The forces at play. What problem, constraint, or pressure made a
decision necessary. Reference the brief, prior ADRs, and competitors.

## Decision

The choice, stated as a positive assertion: "We will ...".

## Consequences

What becomes easier, what becomes harder, what we now owe.
Positive and negative, honestly.

## Alternatives considered

Each rejected option and the specific reason it lost.
```

The required sections are **Context**, **Decision**, and **Consequences**. **Alternatives considered** is required whenever more than one credible option existed — which is nearly always. Optional sections (Open questions, Migration impact, Security notes) are added when the decision warrants them.

We enforce a few rules:

| Rule | Reason |
| --- | --- |
| Title is imperative and concrete | "Use Drizzle as default SQL ORM" not "ORM choice" |
| One decision per ADR | Keeps supersession clean; you can replace one without unraveling five |
| Status line is machine-readable | The docs site and CI parse it |
| ADRs are immutable once Accepted | You supersede, you do not silently rewrite history |
| Prose over diagrams, but diagrams welcome | ASCII diagrams render everywhere, including `git log` |

Immutability is the rule contributors find surprising. Once an ADR is **Accepted**, its Context, Decision, and Alternatives sections are frozen. You may append a dated note, and you may flip its status to Superseded, but you do not edit the original argument. The record is a historical fact: *this is what we believed and why, on that date*. Rewriting it destroys the audit trail that makes the corpus trustworthy.

## Lifecycle: proposed, accepted, superseded

An ADR moves through a small state machine. Most ADRs only ever touch three states.

```
                 +-----------+
   open PR  ---> | Proposed  |
                 +-----------+
                   |       |
        approved   |       |  closed without merge
                   v       v
              +----------+  +-----------+
              | Accepted |  | Rejected  |
              +----------+  +-----------+
                   |
   new ADR that    |
   replaces it     v
              +-------------+
              | Superseded  |---> points to ADR-MMMM
              +-------------+
```

**Proposed.** An ADR is born as a pull request against the docs repo, status `Proposed`. The PR is the debate. Reviewers argue the Context and Alternatives sections, not just typos. A proposed ADR has no authority — nothing in the codebase should cite it as settled. We deliberately reuse the normal PR review flow rather than a separate RFC tool (the path Strapi takes with its design RFC repo); keeping decisions in the same PR queue as code means the people writing the adapters are the people reviewing the decisions.

**Accepted.** When the PR merges, status becomes `Accepted` with the merge date. From this point the decision is binding: code reviews can reject a change for violating an Accepted ADR, and the decision is fair to cite in commit messages and comments. Acceptance requires sign-off from a maintainer who owns the affected area — a database ADR needs a `@kernel/db` owner, an admin-routing ADR needs an admin owner.

**Superseded.** Decisions expire. When a new ADR reverses or replaces an older one, the *new* ADR is written, debated, and accepted normally. On merge, the old ADR's status flips to `Superseded by ADR-MMMM` and gains a one-line dated note at the top pointing forward; the new ADR's Context section explains what changed and links back. The chain is bidirectional and never broken. A reader landing on an old ADR via a stale search result always finds the trail to the current truth.

**Rejected** is the terminal state for a Proposed ADR whose PR closes without merging. We keep rejected ADRs — they are valuable. The next person who proposes "let's make MongoDB the default backend instead of Postgres" should find the prior rejection and its reasoning before re-litigating it.

We intentionally omit a `Deprecated` state. A decision is either current (Accepted), replaced (Superseded), or it never landed (Rejected). Adding more states tempts people to leave ADRs in ambiguous limbo.

## Where ADRs live and how they are numbered

ADRs live in the docs tree at `docs/01-architecture/adr/`, one file per decision:

```
docs/
  01-architecture/
    adr/
      0000-adr-process.md          <- this file
      0001-tanstack-start-as-host.md
      0002-drizzle-default-sql-orm.md
      0003-single-adapter-contract.md
      0004-shared-where-sort-depth-query-language.md
      0005-local-api-over-rpc-server-functions.md
```

Filenames follow `NNNN-kebab-title.md`. The number is a **zero-padded four-digit sequence**, assigned at PR time as `max(existing) + 1`. Numbers are never reused, never reordered, and never imply priority — only chronology. Four digits buys headroom; a long-lived CMS will pass a few hundred ADRs across its surfaces.

Number collisions happen when two PRs claim the same next number concurrently. The rule is simple: **the second PR to merge renumbers.** This is a trivial rename plus a link fixup, and CI catches the collision before merge.

ADRs are part of the published documentation, surfaced under the Architecture section of the KernelCMS docs site, and indexed so they cross-link. They sit beside the rest of the architecture docs — the Adapter contract, the query language reference, and the API surfaces overview — and those documents link *down* into the ADRs that justify their shape, while the ADRs link *up* to the living spec.

### Machine-readable index

Because the status line is structured, we generate the ADR index rather than hand-maintaining it. The generator runs in CI and is itself written against `@kernel/core` utilities so the docs pipeline reuses the same parsing the product ships:

```typescript
import { parseFrontmatterStatus } from "@kernel/core/docs";
import { glob } from "node:fs/promises";

interface AdrEntry {
  readonly number: number;
  readonly title: string;
  readonly status: "proposed" | "accepted" | "superseded" | "rejected";
  readonly supersededBy: number | null;
  readonly path: string;
}

async function buildAdrIndex(root: string): Promise<readonly AdrEntry[]> {
  const entries: AdrEntry[] = [];
  for await (const file of glob(`${root}/[0-9][0-9][0-9][0-9]-*.md`)) {
    const parsed = await parseFrontmatterStatus(file);
    entries.push({
      number: parsed.number,
      title: parsed.title,
      status: parsed.status,
      supersededBy: parsed.supersededBy ?? null,
      path: file,
    });
  }
  return entries.sort((a, b) => a.number - b.number);
}
```

CI fails the build when an ADR references a superseding number that does not exist, when two files share a number, or when an Accepted ADR's frozen sections changed in a diff. That last check is what makes immutability real rather than aspirational — a human will eventually "fix a typo" in an old Decision section, and the pipeline stops them.

## What belongs in an ADR (and what does not)

Write an ADR when a decision is **costly to reverse** and **affects more than one package**. Concretely, for KernelCMS that means: the Adapter contract and any change to it; the shape of the shared `where` / `sort` / pagination / `depth` query language; how drafts, versions, and autosave are persisted; the boundary between the Local API and its RPC projection; default choices (Postgres as default backend, Drizzle as default ORM); and anything that changes the portability guarantee between self-host and KernelCMS Cloud.

Do *not* write an ADR for routine code that lives comfortably inside one package, for choices a single owner can reverse in an afternoon, or for naming bikesheds. The brief already fixes the canonical names; that is not an ADR's job.

A useful smell test: if the decision will show up in a `kernel.config.ts` that thousands of users depend on, it is probably ADR-worthy.

```typescript
import { defineConfig } from "@kernel/core";
import { postgres } from "@kernel/db-postgres";

// The defaults below — Postgres as the backend, Drizzle as the ORM
// underneath it, and depth-based relationship resolution — are each
// backed by an Accepted ADR. The config is downstream of the record.
export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [/* ... */],
  api: {
    depth: 2, // see ADR-0004: shared query language
  },
});
```

This is the difference between KernelCMS and a CMS where defaults are folklore. When a user asks why `depth` defaults to `2` and not `0`, the answer is a link, not a shrug.

## Open questions

- **Versioned supersession across major releases.** When KernelCMS ships a breaking major, an ADR may be Accepted on `main` but Superseded on the next release line. We have not decided whether ADRs should carry an `applies-to` version range or whether release branches simply snapshot the ADR set at branch time. The snapshot approach is simpler; the range approach is more precise. Leaning toward snapshot.
- **Cloud-only decisions.** Some decisions affect only `@kernel/cloud` (managed multi-tenant billing, the global content CDN) and never the open-source core. Open question whether those live in the same numbered sequence or a separate `cloud/` ADR namespace. Mixing them keeps one timeline; splitting them keeps the open-source corpus pure.
- **Lightweight decisions.** Whether we want a thinner "decision note" format for choices that are real but smaller than a full ADR, to avoid the failure mode where the format's weight discourages writing anything down at all.
