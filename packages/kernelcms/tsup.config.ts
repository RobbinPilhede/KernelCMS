import { defineConfig } from 'tsup'

// One published package, several entry points. The @kernel/* workspace packages
// are inlined into the bundle (noExternal). Every heavy third-party library is an
// OPTIONAL peer dependency kept external (see below), so the base install is lean
// and only the users of a given feature pull its dependency in.
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
  // Optional peers, kept external so only the users of a given feature pull them in:
  //   • pg          — only `kernelcms/postgres`
  //   • @aws-sdk/*  — only the S3 storage adapter (loaded lazily on first use)
  //   • graphql     — only when the GraphQL endpoint is enabled (loaded lazily)
  //   • MCP SDK     — only MCP users
  // node:sqlite is a Node built-in the SQLite adapter loads lazily via createRequire.
  external: [/^@modelcontextprotocol\/sdk/, /^@aws-sdk\//, 'graphql', '@hono/node-server', 'node:sqlite', 'pg'],
})
