// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      // Generated, single-line inlined admin bundle.
      'packages/server/src/admin-assets.generated.ts',
      // Vendored template shipped by the scaffolder.
      'packages/create-kernel/template/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Keep formatting concerns to Prettier; turn off rules that would conflict.
  prettier,
  {
    rules: {
      // TypeScript already reports undefined identifiers; the base rule false-positives
      // on platform globals in a mixed Node/browser/edge codebase.
      'no-undef': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  // React hooks linting for the admin app.
  {
    files: ['apps/admin/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
