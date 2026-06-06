import type { Row, SortSpec, Where, WhereCondition } from '@kernel/db'

/** Parse Payload-style sort strings ("-createdAt,title") into a SortSpec list. */
export function parseSort(sort: string | string[] | undefined): SortSpec[] {
  if (!sort) return []
  const tokens = (Array.isArray(sort) ? sort : [sort])
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean)
  return tokens.map((token) =>
    token.startsWith('-')
      ? { field: token.slice(1), direction: 'desc' as const }
      : { field: token, direction: 'asc' as const },
  )
}

export function mergeWhere(a: Where | undefined, b: Where | undefined): Where | undefined {
  if (a && b) return { and: [a, b] }
  return a ?? b
}

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v]
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return String(a) === String(b)
}

function compare(a: unknown, b: unknown): number {
  const an = Number(a)
  const bn = Number(b)
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an < bn ? -1 : an > bn ? 1 : 0
  return String(a).localeCompare(String(b))
}

function matchesCondition(value: unknown, cond: WhereCondition): boolean {
  for (const [op, operand] of Object.entries(cond)) {
    switch (op) {
      case 'equals':
        if (!looseEq(value, operand)) return false
        break
      case 'not_equals':
        if (looseEq(value, operand)) return false
        break
      case 'in':
        if (!toArray(operand).some((o) => looseEq(value, o))) return false
        break
      case 'not_in':
        if (toArray(operand).some((o) => looseEq(value, o))) return false
        break
      case 'greater_than':
        if (!(compare(value, operand) > 0)) return false
        break
      case 'greater_than_equal':
        if (!(compare(value, operand) >= 0)) return false
        break
      case 'less_than':
        if (!(compare(value, operand) < 0)) return false
        break
      case 'less_than_equal':
        if (!(compare(value, operand) <= 0)) return false
        break
      case 'like':
      case 'contains':
        if (!String(value ?? '').toLowerCase().includes(String(operand).toLowerCase())) return false
        break
      case 'exists': {
        const exists = value !== null && value !== undefined
        if (Boolean(operand) !== exists) return false
        break
      }
      default:
        return false
    }
  }
  return true
}

/** In-memory evaluation of a Where clause against a row (used for access guards/population). */
export function matchesWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true
  if (where.and && !where.and.every((w) => matchesWhere(row, w))) return false
  if (where.or && where.or.length > 0 && !where.or.some((w) => matchesWhere(row, w))) return false
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'and' || key === 'or' || cond === undefined) continue
    if (!matchesCondition(row[key], cond as WhereCondition)) return false
  }
  return true
}
