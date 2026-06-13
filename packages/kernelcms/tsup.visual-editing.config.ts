import { defineConfig } from 'tsup'

// The visual-editing SDK is browser code (DOM globals, optional React peer), so
// it builds in a second pass with a DOM-enabled tsconfig — mixing DOM and Node
// libs in the main node-targeted bundle breaks the server entry's dts. Runs after
// the main build with `clean: false` so it adds to, rather than wipes, dist/.
export default defineConfig({
  entry: {
    'visual-editing': 'src/visual-editing.ts',
    'visual-editing/react': 'src/visual-editing-react.ts',
  },
  format: ['esm'],
  target: 'es2022',
  tsconfig: 'tsconfig.visual-editing.json',
  dts: { resolve: [/^@kernel\//] },
  clean: false,
  noExternal: [/^@kernel\//],
  // React is a peer dep only the /react subpath touches — never bundle it.
  external: ['react'],
})
