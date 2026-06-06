# KernelCMS — Enterprise DXP Parity (Amplience & Bloomreach)

Completes the competitive picture above Payload by inventorying the two enterprise
DXPs the team named: **Amplience** (headless content + DAM/Dynamic Media, commerce-
focused) and **Bloomreach** (a suite: **Content** [brXM/Hippo lineage], **Discovery**
[AI search & merchandising], **Engagement** [CDP/marketing automation]).

These are closed commercial platforms; this is our own analysis of their *publicly
positioned* capabilities, not a copy of their docs. Verify specifics against their
current documentation before committing scope — these products change quickly.

**Legend** — Status: ✅ have · 🟡 partial/planned · ❌ missing. Scope: **Core**
(belongs in the CMS), **Module** (optional first-party package/adapter), **Adjacent**
(separate product or third-party integration, expose via adapter). Priority P0–P3.

> Framing: Payload parity (see `PAYLOAD-PARITY.md`) makes KernelCMS a great headless
> CMS. The items here make it a **DXP** — campaign scheduling, DAM with dynamic
> media, personalization, experimentation, visual experience management, search/
> merchandising, and customer data. We treat CMS-class features as Core/Module and
> the CDP/search products as Adjacent (adapter + optional modules), so the platform
> stays focused but nothing is left unplanned.

---

## Part A — Amplience

### A1. Content modeling
- **Schema-driven content types** — content types defined by JSON-Schema-style
  definitions with validation, partials/reusable fragments, and content references
  (links between content items). KernelCMS: 🟡 config-as-code collections/fields +
  validation; missing reusable partials and a content-reference graph beyond
  relationships. → Build: reusable field-group "partials", a content reference/link
  type, schema validation parity. **Core, P1.**
- **Content items vs slots** — content "items" placed into named **slots** on pages.
  KernelCMS: 🟡 blocks-in-pages is analogous; no first-class slot abstraction across
  channels. → Build: named slots/regions a page exposes, fillable per channel.
  **Core, P1.**
- **Localization** — per-locale content + fallbacks. KernelCMS: ✅. **Core.**
- **Hierarchies / content graph** — nestable content, parent/child, graph delivery.
  KernelCMS: 🟡 (hierarchy planned, parity doc §17). → Build: hierarchy + graph query.
  **Core, P1.**

### A2. Campaign scheduling — "Events" & "Editions" (signature feature)
- **Edition/Event planning** — plan a campaign as an **Event** containing
  **Editions**; each Edition stages a set of content/slot changes scheduled to go
  live (and expire) at exact times across slots/channels; visual planning calendar.
  KernelCMS: ❌ (we have basic scheduled publish planned in Spec 02). → Build: a
  **campaign/editions model** layered on versions+jobs: group document/slot changes
  into a named, scheduled, previewable, atomically-publishable bundle with a planning
  calendar and timed expiry. This is a major differentiator beyond Payload. **Core, P1, XL.**
- **Timed publishing / go-live & end** — start+end timestamps per scheduled change.
  KernelCMS: 🟡 (publish/unpublish scheduling in Spec 02). → Extend to bundles. **Core.**

### A3. Real-time Visualization & Preview
- **Visualizations** — preview content in the real site context, multiple device
  views, and **time-travel preview** (preview the site as of a future Edition/date).
  KernelCMS: ✅ live preview (built-in + real frontend) and device widths; 🟡 missing
  time-travel/as-of-date preview and multi-visualization configs. → Build: as-of-date
  preview (render the site at a scheduled future state), named visualizations. **Core, P1.**

### A4. Dynamic Media / DAM (signature feature)
- **Digital Asset Management** — central asset library, folders, metadata, search,
  versioning, usage tracking. KernelCMS: ❌ (media library planned, Spec 03). → Build
  the media library (Spec 03) and grow it toward DAM (folders, metadata schemas,
  rights, usage). **Module, P1.**
- **Dynamic Media transforms** — on-the-fly image transformation via URL params
  (resize/crop/format/quality), **point-of-interest cropping**, format negotiation
  (webp/avif), named presets/templates, and **video** transcoding/streaming. KernelCMS:
  ❌. → Build: an image-transform service/URL API (resize/crop/format/quality, focal
  point, presets) on top of the storage adapter; video later. **Module, P1, L.**
- **Image Studio / AI media** — background removal, generative expand, auto-tagging,
  alt-text. KernelCMS: ❌. → Build via media-AI hooks (opt-in). **Module, P3.**

### A5. Personalization
- **Content targeting** — serve different content by audience/segment/rules at the
  slot level. KernelCMS: ❌. → Build a targeting layer (rules → variant resolution at
  delivery), see cross-cutting §X1. **Module, P2.**

### A6. Experimentation / A-B testing
- Slot/content-level experiments with metrics. KernelCMS: ❌. → §X2. **Module, P2.**

### A7. Governance
- **Workflow & content states**, roles/permissions, approvals. KernelCMS: 🟡 (RBAC
  basics; no workflow). → Build: configurable workflow states + transitions +
  approvals + role gating; audit (with versions). **Core, P1.**

### A8. Delivery & performance
- **Content Delivery API + global CDN**, fast read SLA, content graph delivery,
  filtering. KernelCMS: 🟡 (REST; no edge CDN story/SLA). → Build: cacheable delivery
  endpoints, CDN guidance/edge adapter, content-graph query. **Core, P1.**

### A9. Extensibility
- **Dashboard UI extensions / custom field extensions**, webhooks, integrations
  (SFCC/commercetools). KernelCMS: ❌ (plugin system planned). → Build: plugin +
  custom-field-component API (parity doc §15/§19), webhooks (§19/Spec), commerce
  adapters. **Module, P1.**

---

## Part B — Bloomreach Content (brXM / Hippo lineage + SaaS Content)

### B1. Content types & documents
- **Document/content types, compound fields, content blocks**, validation. KernelCMS:
  🟡 (fields/blocks/group cover most; compound = our group/array). → minor parity gaps.
  **Core, P1.**
- **Multi-site / channels / multi-language** — one repository powering many sites/
  channels. KernelCMS: 🟡 (multi-tenant planned; no channel abstraction). → Build:
  channels (a site/brand context) + per-channel content + multi-tenant (parity §17/
  Track K). **Core, P1, L.**

### B2. Experience Manager (visual page building, signature feature)
- **Component/container page model** — pages composed of **containers** holding
  **components**; editors drag components onto the page, configure parameters, in a
  visual canvas bound to the live site. KernelCMS: 🟡 — our blocks/section builder +
  live preview is the same idea; missing the container/component parameter model and
  in-canvas drag-on-the-real-site editing. → Build: a container/component model
  (sections already cover components), in-preview drag/drop + click-to-edit (parity
  Track E #51), component parameters. **Core, P0/P1 — this is our wedge; go past them.**
- **Page Model API / Delivery API** — JSON page model for headless rendering;
  REST + GraphQL delivery. KernelCMS: ✅ REST page rendering (home→`/`); 🟡 a formal
  "page model" contract + GraphQL. → Build: a documented page-model delivery format +
  GraphQL. **Core, P1.**

### B3. Personalization & targeting
- **Segments/audiences, relevance/targeting, rules**, deliver personalized
  components. KernelCMS: ❌. → §X1. **Module, P2.**

### B4. Experimentation
- **A/B experiments** on pages/components with goals/metrics. KernelCMS: ❌. → §X2.
  **Module, P2.**

### B5. Editorial workflow
- **Versioning, publication states, scheduled publication**, review/approval. KernelCMS:
  🟡 (Spec 02 covers versions/drafts/scheduled). → Build workflow/approval on top.
  **Core, P1.**
- **Projects / content branching** — group changes into a project/branch, work in
  isolation, review, then publish together (campaign branching). KernelCMS: ❌. →
  Build: content "projects" (a branch/changeset over documents), overlaps Amplience
  Editions; unify both into one **Changesets** primitive. **Core, P1, XL.**

### B6. Assets
- **Image/asset management + rendering variants**. KernelCMS: ❌ (Spec 03). → Build
  media (Spec 03) + variants (overlaps A4). **Module, P1.**

### B7. AI authoring
- **AI content generation / content copilot** (draft copy, summarize, translate).
  KernelCMS: ❌ (natural fit for our MCP/AI direction). → Build: AI authoring assist
  (generate/rewrite/translate field/section content), MCP-first. **Module, P2 —
  potential leapfrog.**

---

## Part C — Bloomreach Discovery (AI search & merchandising) — **Adjacent**

Expose via a **search adapter** + optional first-party module; not core CMS.
- **AI site search** (keyword + **semantic/vector**), typo tolerance, did-you-mean. ❌ → Adapter+Module, P2.
- **Autosuggest / typeahead**. ❌ → Module, P2.
- **Browse/category merchandising** — ranking rules, **pin/boost/bury**, facets. ❌ → Module, P3.
- **Recommendations** — similar, recently viewed, personalized, cross-sell. ❌ → Module, P3.
- **Product catalog & attributes / facets** management. ❌ (ecommerce-adjacent) → Module, P3.
- **SEO tooling** — managed category pages, redirects, synonyms. 🟡 (redirects/SEO as plugins) → Module, P2.
- **Search analytics & A/B** of results. ❌ → Module, P3.
- **Build path:** a `search` adapter contract (index docs on change via jobs +
  webhooks) with adapters for OpenSearch/Meilisearch/Typesense/vector DBs; an
  optional merchandising UI. KernelCMS already has the adapter philosophy to make
  this clean.

---

## Part D — Bloomreach Engagement (CDP / marketing automation) — **Adjacent**

A separate product domain; expose via integration/adapter, do **not** absorb into core.
- **Unified customer profiles**, real-time event ingestion. ❌ → Adjacent/integration, P3.
- **Segmentation** (real-time + predictive). ❌ → P3.
- **Omnichannel campaigns** — email/SMS/push/in-app/web layers. ❌ → P3.
- **Predictions** (churn, CLV), recommendations. ❌ → P3.
- **Web personalization / weblayers / experiments**. ❌ → overlaps §X1/§X2, P3.
- **Customer journeys / scenarios** (automation flows). ❌ → P3.
- **Consent management, analytics, attribution**. ❌ → P3.
- **Build path:** an events/webhooks + customer-profile **integration adapter**
  (Segment/RudderStack/Bloomreach Engagement/Klaviyo). KernelCMS contributes content
  + personalization signals; the CDP owns customer data. Keep out of core.

---

## Part X — Cross-cutting capabilities (the connective tissue)

### X1. Personalization framework
A delivery-time variant-resolution layer: define **audiences/segments** (rule-based
now; CDP-fed later), attach **variants/targeting rules** to sections/slots/documents,
resolve the right variant per request (edge-cacheable by segment). Powers Amplience
content targeting and Bloomreach personalization with one model. **Module, P2, L.**

### X2. Experimentation framework
A/B/n experiments on sections/pages/variants with assignment, goals, and stats;
integrates with personalization (X1) and analytics. **Module, P2, L.**

### X3. Changesets (unify Editions + Projects)
One primitive: a named, schedulable, previewable, reviewable **bundle of changes**
across many documents/slots, atomically publishable and revertible — covering
Amplience Editions/Events *and* Bloomreach Projects/branching. Built on versions
(Spec 02) + jobs (Spec 18). **Core, P1, XL — a flagship enterprise feature.**

### X4. Channels & multi-site/tenant
A channel/brand context selecting content, theme, locale, and section library;
multi-tenant isolation. **Core, P1, L.**

### X5. Workflow & governance
Configurable states/transitions, role-gated approvals, scheduled transitions,
audit log, content locking (already specced). **Core, P1.**

### X6. AI / agent (MCP-first)
AI authoring assist (generate/rewrite/translate/summarize content & sections),
auto-tagging/alt-text for media, and **MCP** exposure so agents can operate the CMS.
A natural leapfrog given our TanStack/adapters stack. **Module, P2.**

### X7. Delivery, CDN & performance
Cacheable, edge-friendly delivery (page model + content graph), per-segment caching,
fast read SLA, image transform CDN (A4). **Core, P1.**

### X8. Analytics & insights
Content/page analytics surfaced in-admin (views, experiment results, search
analytics via Discovery), pluggable to external analytics. **Module, P3.**

---

## Unified capability map ("nothing more to write")

The complete KernelCMS target = **Payload parity** (PAYLOAD-PARITY.md) **+** the
DXP layer here. Consolidated, deduped backlog by tier:

**Core (the CMS/DXP product itself)**
1. Rich text (Spec 01) · 2. Versions/drafts/autosave/scheduled (Spec 02) ·
3. Uploads/media → DAM (Spec 03) · 4. Auth depth · 5. Migrations workflow ·
6. Read-side field access · 7. GraphQL + page-model delivery · 8. Hierarchy/folders/
trash/query-presets/join · 9. **Changesets** (Editions+Projects, X3) · 10. **Channels
& multi-tenant** (X4) · 11. **Workflow/governance** (X5) · 12. **Experience-manager
in-canvas editing** (sections++; Track E) · 13. **As-of-date/time-travel preview** ·
14. Delivery/CDN/perf (X7).

**Module (optional first-party packages/adapters)**
15. Plugin system → SEO/Search/Form Builder/Redirects/Multi-tenant · 16. **Dynamic
media transforms** (A4) · 17. **Personalization** (X1) · 18. **Experimentation**
(X2) · 19. **Search adapter + merchandising** (Discovery, Part C) · 20. **AI/MCP
authoring** (X6) · 21. Email · 22. Jobs queue (enabler for 9/13/19) · 23. Webhooks ·
24. Analytics (X8).

**Adjacent (integration adapters, not core)**
25. CDP / marketing automation (Bloomreach Engagement, Part D) · 26. Commerce
(catalog/payments) · 27. External DAM / search / analytics integrations.

**Sequencing principle:** finish Payload-parity Core (1–8) → land the DXP wedges
that build on it (9 Changesets, 12 Experience Manager, 13 time-travel preview, 16
dynamic media) since they reuse versions+jobs+blocks+preview we already have → then
personalization/experimentation/search as Modules → keep CDP/commerce Adjacent.

> Honesty note: Parts C and D are different product categories (search/merchandising
> and CDP). Trying to *build* all of them into one CMS would dilute the product. The
> right "nothing more to write" answer is: **build the Core + Modules; integrate the
> Adjacent via adapters.** That captures every listed capability without becoming a
> bloated clone of three separate enterprise suites.
