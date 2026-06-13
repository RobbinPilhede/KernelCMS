import { defineConfig } from 'tsup'

// One published package, several entry points. The @kernel/* workspace packages
// are inlined into the bundle (noExternal) so the published artifact has zero
// runtime dependencies. node:sqlite stays external — it is a Node built-in that
// the SQLite adapter loads lazily via createRequire.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    postgres: 'src/postgres.ts',
    sqlite: 'src/sqlite.ts',
    server: 'src/server.ts',
    client: 'src/client.ts',
    richtext: 'src/richtext.ts',
    storage: 'src/storage.ts',
    graphql: 'src/graphql.ts',
    testing: 'src/testing.ts',
    'plugin-seo': 'src/plugin-seo.ts',
    mcp: 'src/mcp.ts',
    bin: 'src/bin.ts',
  },
  format: ['esm'],
  target: 'node22',
  dts: { resolve: [/^@kernel\//] },
  clean: true,
  noExternal: [/^@kernel\//],
  // `pg` is a real third-party dependency; keep it external. node:sqlite is a
  // Node built-in the SQLite adapter loads lazily. The MCP SDK is an OPTIONAL
  // peer — keep it (and its subpaths/transitive runtime deps) external so the
  // base install stays lean and only MCP users pull it in.
  external: [/^@modelcontextprotocol\/sdk/, '@hono/node-server', 'node:sqlite', 'pg'],
})
