/**
 * @kernel/testing — ergonomic helpers for testing a Kernel. Spin up a throwaway
 * in-memory instance, seed fixtures, and run operations as a trusted caller,
 * without the boilerplate every test file otherwise repeats.
 *
 *   const kernel = await createTestKernel({ collections: [Posts] })
 *   const { posts } = await seed(kernel, { posts: [{ title: 'Hi' }] })
 */
import { initKernel, type Doc, type Kernel, type KernelConfig, type Row } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

/** Config for a test kernel — `db` and `secret` default to in-memory SQLite + a fixed secret. */
export type TestKernelConfig = Omit<KernelConfig, 'db' | 'secret'> & {
  db?: KernelConfig['db']
  secret?: string
}

export interface TestKernel extends Kernel {
  /** Bulk-insert fixtures as a trusted caller. Returns created docs keyed by slug. */
  seed(fixtures: Record<string, Row[]>): Promise<Record<string, Doc[]>>
}

/** Override flag for running operations as a trusted system caller in tests. */
export const asSystem = { overrideAccess: true } as const

/** Boot a migrated, in-memory Kernel for a test. Remember to `await kernel.destroy()`. */
export async function createTestKernel(config: TestKernelConfig): Promise<TestKernel> {
  const kernel = await initKernel(
    {
      secret: config.secret ?? 'test-secret-aaaaaaaaaaaaaaaa',
      db: config.db ?? sqliteAdapter({ url: ':memory:' }),
      ...config,
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
  return Object.assign(kernel, {
    seed: (fixtures: Record<string, Row[]>) => seed(kernel, fixtures),
  })
}

/** Insert fixtures with `overrideAccess`, preserving order; returns docs by slug. */
export async function seed(kernel: Kernel, fixtures: Record<string, Row[]>): Promise<Record<string, Doc[]>> {
  const out: Record<string, Doc[]> = {}
  for (const [slug, rows] of Object.entries(fixtures)) {
    out[slug] = []
    for (const data of rows) {
      out[slug]!.push(await kernel.create({ collection: slug, data, ...asSystem }))
    }
  }
  return out
}

/** Assert that an async operation rejects (optionally with a specific error class). */
export async function expectRejection(
  promise: Promise<unknown>,
  ErrorClass?: new (...args: never[]) => Error,
): Promise<Error> {
  try {
    await promise
  } catch (err) {
    if (ErrorClass && !(err instanceof ErrorClass)) {
      throw new Error(`Expected rejection with ${ErrorClass.name}, got ${(err as Error)?.constructor?.name}`)
    }
    return err as Error
  }
  throw new Error('Expected the promise to reject, but it resolved.')
}
