/**
 * kernelcms/postgres — the default storage adapter: PostgreSQL via node-postgres
 * (`pg`), with real connection pooling and concurrent transactions.
 *
 *   import { postgresAdapter } from 'kernelcms/postgres'
 *   // reads DATABASE_URL by default
 *   db: postgresAdapter()
 */
export * from '@kernel/db-postgres'
