/** @kernel/graphql — a GraphQL API generated from the kernel content model. */
import {
  GraphQLError,
  Kind,
  NoSchemaIntrospectionCustomRule,
  execute,
  parse,
  specifiedRules,
  validate,
  type ASTVisitor,
  type ExecutionResult,
  type FieldNode,
  type ValidationContext,
} from 'graphql'
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

export interface GraphQLOptions {
  /** Max selection-set nesting allowed in a query (DoS guard). Default 10. */
  maxDepth?: number
  /** Max total field selections — including aliases — allowed in one request. A
   *  shallow query can still fan out enormously through aliasing (e.g. 200 aliases
   *  of the same list), so depth alone is not enough. Default 100. */
  maxFields?: number
  /** Disable schema introspection. Defaults to true when NODE_ENV=production. */
  disableIntrospection?: boolean
}

const DEFAULT_MAX_DEPTH = 10
const DEFAULT_MAX_FIELDS = 100

/**
 * Validation rule that rejects queries nested deeper than `maxDepth`. Recursive
 * relationship resolvers mean an unbounded query can fan out into thousands of
 * DB reads; capping depth closes that amplification/DoS vector.
 */
function depthLimitRule(maxDepth: number): (context: ValidationContext) => ASTVisitor {
  return (context: ValidationContext): ASTVisitor => ({
    Field(node: FieldNode) {
      const depth = fieldDepth(node)
      if (depth > maxDepth) {
        context.reportError(new GraphQLError(`Query exceeds maximum depth of ${maxDepth}.`, { nodes: [node] }))
      }
    },
  })
}

/**
 * Validation rule that rejects a request selecting more than `maxFields` fields in
 * total (aliases included). Closes the breadth/aliasing amplification a depth cap
 * misses: 200 aliases of one list is shallow but huge.
 */
function complexityLimitRule(maxFields: number): (context: ValidationContext) => ASTVisitor {
  return (context: ValidationContext): ASTVisitor => {
    let count = 0
    let reported = false
    return {
      Field() {
        count += 1
        if (count > maxFields && !reported) {
          reported = true
          context.reportError(new GraphQLError(`Query is too complex: more than ${maxFields} fields selected.`))
        }
      },
    }
  }
}

/** Deepest selection-set nesting under (and including) a field. */
function fieldDepth(node: FieldNode): number {
  const selections = node.selectionSet?.selections
  if (!selections || selections.length === 0) return 1
  let deepest = 0
  for (const sel of selections) {
    if (sel.kind === Kind.FIELD) deepest = Math.max(deepest, fieldDepth(sel))
  }
  return deepest + 1
}

/**
 * A request executor that caches the generated schema per kernel. Returns the
 * standard `{ data, errors }` envelope; resolver errors carry the kernel's
 * error messages but never throw out of this function.
 */
export function createGraphQL(
  kernel: Kernel,
  options: GraphQLOptions = {},
): (opts: ExecuteOptions) => Promise<ExecutionResult> {
  const schema = buildGraphQLSchema(kernel)
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxFields = options.maxFields ?? DEFAULT_MAX_FIELDS
  const disableIntrospection = options.disableIntrospection ?? process.env.NODE_ENV === 'production'
  const rules = [...specifiedRules, depthLimitRule(maxDepth), complexityLimitRule(maxFields)]
  if (disableIntrospection) rules.push(NoSchemaIntrospectionCustomRule)

  return async (opts) => {
    let document
    try {
      document = parse(opts.query)
    } catch (err) {
      return { errors: [err as GraphQLError] }
    }
    const errors = validate(schema, document, rules)
    if (errors.length > 0) return { errors }
    return execute({
      schema,
      document,
      variableValues: opts.variables ?? undefined,
      operationName: opts.operationName ?? undefined,
      contextValue: opts.context,
    })
  }
}
