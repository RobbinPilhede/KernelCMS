# @kernel/mcp

Expose a KernelCMS instance as a [Model Context Protocol](https://modelcontextprotocol.io)
server — the agent-safe way to hand your CMS to an AI.

Tools are **auto-generated** from the same content-model descriptor that drives the
OpenAPI spec, so the agent surface never drifts from the HTTP surface. Every tool
call is routed through the in-process **Local API** as an **agent principal**, which
means agents flow through the _exact same_ access-control pipeline as humans — no
parallel permission system to keep in sync, nothing to get wrong.

## What gets generated

For each non-hidden, non-auth collection:

- `<slug>_list` → `find`
- `<slug>_get` → `findByID`
- `<slug>_create` → `create`
- `<slug>_update` → `update`
- `<slug>_delete` → `delete`

For each global:

- `<slug>_get_global` → `findGlobal`
- `<slug>_update_global` → `updateGlobal`

Input schemas come from the shared `@kernel/core` JSON-Schema mapper, so they match
the field definitions exactly and omit server-managed columns (`hash`, `api_key`, …).

## Wiring (stdio)

```ts
import { initKernel } from '@kernel/core'
import { serveStdio } from '@kernel/mcp'
import config from './kernel.config'

const kernel = await initKernel(config, { autoMigrate: true })

await serveStdio(kernel, {
  principal: {
    id: 'content-bot',
    roles: ['editor'],
    fieldScope: { allow: ['title', 'body'] },
  },
})
```

Point your MCP client (e.g. Claude Desktop) at the script that runs this and it can
list and call the generated tools over stdin/stdout.

## Safety guarantees

These hold because the MCP layer **does not enforce access itself** — it only passes
the principal into the Local API and lets the core engine decide:

- **Access is enforced per call.** Each tool call runs the collection's `read` /
  `create` / `update` / `delete` access rules against the agent principal.
  `overrideAccess` is **never** set, so nothing bypasses those rules.
- **Agents can't publish.** Agents are draft-only at the core level. A create with
  `_status: 'published'`, a `PATCH { _status: 'published' }`, or a `publish()` call
  is rejected by the engine, regardless of how permissive the collection's rules are.
- **Agents can't write outside their scope.** `fieldScope.allow` / `deny` is applied
  by the core engine before per-field rules; unscoped fields are stripped from every
  write. An agent scoped to `['title']` simply cannot set `roles`, even if no field
  rule mentions it.
- **No secrets leak.** Hidden/auth collections are excluded from the tool set, and
  errors are returned as clean MCP tool errors — never stacks or internals.

The guarantees live in `@kernel/core`, not here. This package is a thin, faithful
adapter onto that pipeline.
