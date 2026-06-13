# KernelCMS app

A **TanStack Start** app powered by **KernelCMS**. It server-renders a small site whose content comes from the KernelCMS **Local API** (an in-process call — no HTTP round-trip), stored in SQLite via `node:sqlite`.

Scaffolded from one of the starter content models (`blog`, `shop`, `docs`, `portfolio`). The generic home + detail routes render whatever model you chose via the `view` descriptor in `src/server/config.ts`.

## Run it

```bash
pnpm dev      # or: npm run dev / yarn dev / bun dev
```

Open the URL the dev server prints (default **http://localhost:3000**). The SQLite database (`kernelcms.db`) and demo content are created automatically on first request.

## Where things live

```
src/
├─ routes/
│  ├─ index.tsx          # home: lists published posts
│  └─ posts.$slug.tsx    # a single post with its author + categories
├─ server/
│  ├─ config.ts          # ← your content model (collections, fields, globals) + seed()
│  ├─ kernel.ts          # boots one KernelCMS instance (auto-migrate + seed)
│  └─ cms.ts             # TanStack Start server functions calling the Local API
└─ kernel/               # the KernelCMS engine (db, core, db-sqlite)
```

## Make it yours

- **Change the content model:** edit `src/server/config.ts`. Add a field, delete `kernelcms.db`, restart — the migration is generated automatically.
- **Add a page:** drop a file in `src/routes/`, and add a server function in `src/server/cms.ts` (the Local API also has `create`, `update`, `delete`, `findGlobal`, …).
- **Reset content:** delete `kernelcms.db*` and reload.

## Notes

- Reads use `overrideAccess: true` because this starter has no login. KernelCMS is secure-by-default: without that flag, writes require authentication.
- The engine in `src/kernel/` makes this app fully self-contained.
