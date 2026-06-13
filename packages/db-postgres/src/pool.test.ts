import { describe, expect, it } from 'vitest'
import type { Pool as PgPool } from 'pg'
import type { KernelSchema, Logger } from '@kernel/db'
import { postgresAdapter } from './index'

/**
 * Pool-lifecycle unit tests using a FAKE pool injected via the adapter's
 * `poolFactory` seam. The fake answers `pg`'s Pool/PoolClient surface with an
 * in-memory rowset and, crucially, COUNTS client checkouts against releases —
 * so we can prove the adapter never leaks a checked-out client, releases even
 * when an operation throws mid-transaction, creates the pool exactly once, and
 * shuts down idempotently. No real Postgres required.
 */

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const schema: KernelSchema = {
  tables: [
    {
      table: 'widgets',
      slug: 'widgets',
      columns: [
        { name: 'name', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'qty', type: 'integer', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    },
  ],
}

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number | null }

/** A minimal in-memory Postgres stand-in: enough SQL shape for the adapter's
 *  statements (CREATE/ALTER/INDEX, INSERT … RETURNING, SELECT, UPDATE, DELETE,
 *  COUNT, information_schema, BEGIN/COMMIT/SAVEPOINT). It is deliberately loose
 *  — the point is lifecycle accounting, not a SQL engine. */
class FakePool {
  checkouts = 0
  releases = 0
  ended = 0
  queries = 0
  private readonly rows = new Map<string, Record<string, unknown>>()

  private run(text: string, params: unknown[] = []): QueryResult {
    this.queries++
    const sql = text.trim()
    const upper = sql.toUpperCase()
    // Transaction/DDL control statements: no rows.
    if (
      upper.startsWith('BEGIN') ||
      upper.startsWith('COMMIT') ||
      upper.startsWith('ROLLBACK') ||
      upper.startsWith('SAVEPOINT') ||
      upper.startsWith('RELEASE SAVEPOINT') ||
      upper.startsWith('CREATE TABLE') ||
      upper.startsWith('CREATE INDEX') ||
      upper.startsWith('ALTER TABLE') ||
      upper.startsWith('SELECT 1')
    ) {
      return { rows: [], rowCount: 0 }
    }
    // Schema introspection during migrate: report "table does not exist yet".
    if (upper.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return { rows: [], rowCount: 0 }
    }
    if (upper.startsWith('INSERT')) {
      // Columns + values are positional; reconstruct a row from the params.
      const colsMatch = sql.match(/\(([^)]*)\)\s+VALUES/i)
      const cols = (colsMatch?.[1] ?? '').split(',').map((c) => c.trim().replace(/"/g, ''))
      const row: Record<string, unknown> = {}
      let pi = 0
      for (const c of cols) {
        // now() literals aren't parameters; synthesize a timestamp.
        row[c] = c === 'createdAt' || c === 'updatedAt' ? new Date() : params[pi++]
      }
      this.rows.set(String(row.id), row)
      return { rows: [row], rowCount: 1 }
    }
    if (upper.startsWith('UPDATE')) {
      const id = String(params[params.length - 1])
      const row = this.rows.get(id)
      if (!row) return { rows: [], rowCount: 0 }
      // Apply "col = $n" assignments in order.
      const setPart = sql.slice(sql.toUpperCase().indexOf('SET') + 3, sql.toUpperCase().indexOf('WHERE'))
      const assigns = setPart.split(',').map((s) => s.trim())
      let pi = 0
      for (const a of assigns) {
        const name = a.split('=')[0]!.trim().replace(/"/g, '')
        if (a.includes('now()')) row[name] = new Date()
        else row[name] = params[pi++]
      }
      return { rows: [{ ...row }], rowCount: 1 }
    }
    if (upper.startsWith('DELETE')) {
      const id = String(params[0])
      const row = this.rows.get(id)
      this.rows.delete(id)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (upper.includes('COUNT(*)')) {
      return { rows: [{ c: this.rows.size }], rowCount: 1 }
    }
    if (upper.startsWith('SELECT')) {
      // findByID carries a WHERE "id" = $1; a plain find selects all.
      if (sql.includes('"id" = $1')) {
        const row = this.rows.get(String(params[0]))
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
      }
      return { rows: [...this.rows.values()].map((r) => ({ ...r })), rowCount: this.rows.size }
    }
    return { rows: [], rowCount: 0 }
  }

  async connect(): Promise<{ query: (t: string, p?: unknown[]) => Promise<QueryResult>; release: () => void }> {
    this.checkouts++
    let released = false
    return {
      query: async (text: string, params?: unknown[]) => this.run(text, params),
      release: () => {
        // pg throws on double-release; mirror that so a bug surfaces.
        if (released) throw new Error('client released twice')
        released = true
        this.releases++
      },
    }
  }

  async query(text: string, params?: unknown[]): Promise<QueryResult> {
    return this.run(text, params)
  }

  async end(): Promise<void> {
    this.ended++
  }
}

function adapterWithFake(fake: FakePool) {
  return postgresAdapter({
    url: 'postgres://fake/db',
    poolFactory: () => fake as unknown as PgPool,
  })
}

describe('postgres pool lifecycle (fake pool)', () => {
  it('creates the pool exactly once and reuses it across operations', async () => {
    let factoryCalls = 0
    const fake = new FakePool()
    const db = postgresAdapter({
      url: 'postgres://fake/db',
      poolFactory: () => {
        factoryCalls++
        return fake as unknown as PgPool
      },
    })
    await db.init({ logger: silent })
    await db.migrate(schema)
    await db.create({ collection: 'widgets', data: { id: 'a', name: 'one', qty: 1 } })
    await db.find({ collection: 'widgets', limit: 10, page: 1 })
    await db.findByID({ collection: 'widgets', id: 'a' })
    await db.count({ collection: 'widgets' })

    expect(factoryCalls).toBe(1)
    await db.destroy()
  })

  it('leaks zero clients across a full batch of operations', async () => {
    const fake = new FakePool()
    const db = adapterWithFake(fake)
    await db.init({ logger: silent }) // probe: 1 checkout
    await db.migrate(schema) // 1 checkout (single-client transaction)
    await db.create({ collection: 'widgets', data: { id: '1', name: 'a', qty: 1 } }) // pool query, no checkout
    await db.find({ collection: 'widgets', limit: 10, page: 1 })
    await db.findByID({ collection: 'widgets', id: '1' })
    await db.update({ collection: 'widgets', id: '1', data: { qty: 2 } })
    await db.count({ collection: 'widgets' })
    await db.transaction(async (tx) => {
      // 1 checkout for the transaction; savepoints reuse the same client.
      await tx.create({ collection: 'widgets', data: { id: '2', name: 'b', qty: 5 } })
      await tx.transaction(async (inner) => {
        await inner.update({ collection: 'widgets', id: '2', data: { qty: 6 } })
      })
    })
    await db.delete({ collection: 'widgets', id: '1' })

    expect(fake.checkouts).toBeGreaterThan(0)
    expect(fake.releases).toBe(fake.checkouts)
    await db.destroy()
  })

  it('releases the client when an operation throws mid-transaction', async () => {
    const fake = new FakePool()
    const db = adapterWithFake(fake)
    await db.init({ logger: silent })
    await db.migrate(schema)
    const before = fake.checkouts

    await expect(
      db.transaction(async (tx) => {
        await tx.create({ collection: 'widgets', data: { id: 'x', name: 'doomed', qty: 1 } })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // The failed transaction checked out exactly one more client and released it.
    expect(fake.checkouts).toBe(before + 1)
    expect(fake.releases).toBe(fake.checkouts)
    await db.destroy()
  })

  it('destroy() ends the pool exactly once and a second destroy() is a no-op', async () => {
    const fake = new FakePool()
    const db = adapterWithFake(fake)
    await db.init({ logger: silent })

    await db.destroy()
    await db.destroy()

    expect(fake.ended).toBe(1)
  })
})
