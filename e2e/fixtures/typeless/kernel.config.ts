import { defineConfig } from 'kernelcms'
import { sqliteAdapter } from 'kernelcms/sqlite'

export default defineConfig({
  secret: 'a-sufficiently-long-secret-value',
  db: sqliteAdapter({ url: ':memory:' }),
  collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
})
