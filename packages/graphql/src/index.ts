/** @kernel/graphql — a GraphQL API generated from the kernel content model. */
import { graphql, type ExecutionResult } from 'graphql'
import type { Kernel } from '@kernel/core'
import { buildGraphQLSchema, type GraphQLContext } from './schema'

export { buildGraphQLSchema, JSONScalar } from './schema'
export type { GraphQLContext } from './schema'

export interface ExecuteOptions {
  query: string
  variables?: Record<string, unknown> | null
  operationName?: string | null
  context: GraphQLContext
}

/**
 * A request executor that caches the generated schema per kernel. Returns the
 * standard `{ data, errors }` envelope; resolver errors carry the kernel's
 * error messages but never throw out of this function.
 */
export function createGraphQL(kernel: Kernel): (opts: ExecuteOptions) => Promise<ExecutionResult> {
  const schema = buildGraphQLSchema(kernel)
  return (opts) =>
    graphql({
      schema,
      source: opts.query,
      variableValues: opts.variables ?? undefined,
      operationName: opts.operationName ?? undefined,
      contextValue: opts.context,
    })
}
