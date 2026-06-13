# Live verification harness

Boots a **real** kernel and exercises every recently-shipped feature end-to-end —
across the Local API, the REST HTTP handler, the MCP server (stdio + HTTP), and the
`kernel mcp` CLI — asserting real outcomes with evidence. This is acceptance testing
that complements the unit suite: it proves the features actually work when wired
together and run, not just in isolation.

```bash
pnpm verify          # run the whole chain (fails on the first failure)
pnpm tsx verify/run.ts        # Local API: agents, drafts/publish gate, onDelete,
                              #   N+1 batching, FK auto-index, scheduled publish, globals
pnpm tsx verify/richtext.ts   # richtext: fromHTML/fromMarkdown importers + sanitizer
pnpm tsx verify/http.ts       # REST + server-side agent bearer auth (resolveAuth)
pnpm tsx verify/mcp.ts        # MCP server over a real in-memory client: tools, agent
                              #   enforcement, resources (no secret leakage), endpoint tools
pnpm tsx verify/mcp-http.ts   # MCP HTTP transport: multi-agent per-request tokens, 401s
pnpm tsx verify/cli.ts        # spawns `kernel mcp` and connects a real stdio MCP client
```

Each file boots a fresh SQLite kernel from `config.ts` (a config that uses every
feature: agents with field scopes, drafts + `access.publish`, relationship `onDelete`,
the blocks page-builder, an `mcp:true` endpoint). `config.ts` exports `makeConfig(dbUrl)`;
`kernel.config.ts` is a default-export wrapper for the CLI.

Every check is a `PASS`/`FAIL` line with evidence. A non-zero exit means something
the engine does is broken — fix it, then re-run until clean.
