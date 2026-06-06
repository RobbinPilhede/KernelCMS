import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Build to a single self-contained index.html (JS + CSS inlined). The kernel
// server embeds that one file and serves it as the admin — no asset routes.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: false, cssCodeSplit: false, assetsInlineLimit: 100_000_000 },
})
