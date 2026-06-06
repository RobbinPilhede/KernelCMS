/**
 * kernelcms — the engine entry point.
 *
 * Re-exports the full @kernel/core surface (config, fields, operations, auth,
 * access, codegen, the Local API, the typed error hierarchy) plus the storage
 * contract types. Pair it with an adapter from `kernelcms/sqlite`.
 *
 *   import { defineConfig, initKernel } from 'kernelcms'
 *   import { sqliteAdapter } from 'kernelcms/sqlite'
 */
export * from '@kernel/core'
