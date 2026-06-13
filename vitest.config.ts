import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'examples/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    environment: 'node',
    pool: 'forks',
    // node:sqlite is a recent built-in; keep it external so Node resolves it.
    server: { deps: { external: ['node:sqlite', /node:sqlite/] } },
  },
  ssr: {
    external: ['node:sqlite'],
  },
  optimizeDeps: {
    exclude: ['node:sqlite'],
  },
  resolve: {
    alias: {
      '@kernel/db': pkg('./packages/db/src/index.ts'),
      '@kernel/core': pkg('./packages/core/src/index.ts'),
      '@kernel/db-sqlite': pkg('./packages/db-sqlite/src/index.ts'),
      '@kernel/db-postgres': pkg('./packages/db-postgres/src/index.ts'),
      '@kernel/server': pkg('./packages/server/src/index.ts'),
      '@kernel/client': pkg('./packages/client/src/index.ts'),
      '@kernel/richtext': pkg('./packages/richtext/src/index.ts'),
      '@kernel/storage': pkg('./packages/storage/src/index.ts'),
      '@kernel/plugin-seo': pkg('./packages/plugin-seo/src/index.ts'),
      '@kernel/graphql': pkg('./packages/graphql/src/index.ts'),
      '@kernel/testing': pkg('./packages/testing/src/index.ts'),
    },
  },
})
