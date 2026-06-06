/**
 * Build a GraphQL schema from the kernel's content model. Types, queries, and
 * mutations are generated from collections; resolvers delegate to the Local API,
 * so access control, hooks, and validation are enforced exactly as over REST.
 * The schema is a pure function of the config — same model, same schema.
 */
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type ValueNode,
} from 'graphql'
import { describeConfig, type AdminCollection, type AdminField, type AuthUser, type Kernel, type Row } from '@kernel/core'

/** Per-request context: the resolved caller identity. */
export interface GraphQLContext {
  user: AuthUser | null
  overrideAccess: boolean
}

// A permissive JSON scalar for rich text, json, arrays, blocks, and mutation input.
export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value.',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: function parse(node: ValueNode): unknown {
    switch (node.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return node.value
      case Kind.INT:
      case Kind.FLOAT:
        return Number(node.value)
      case Kind.NULL:
        return null
      case Kind.LIST:
        return node.values.map(parse)
      case Kind.OBJECT: {
        const obj: Record<string, unknown> = {}
        for (const field of node.fields) obj[field.name.value] = parse(field.value)
        return obj
      }
      default:
        return null
    }
  },
})

function pascalCase(slug: string): string {
  return slug.replace(/(^|[_-])([a-z])/g, (_m, _s, c: string) => c.toUpperCase())
}

function scalarType(field: AdminField) {
  switch (field.type) {
    case 'number':
      return GraphQLFloat
    case 'boolean':
    case 'checkbox':
      return GraphQLBoolean
    case 'relationship':
    case 'upload':
      // Polymorphic refs ({ relationTo, value }) surface as JSON.
      if (Array.isArray(field.relationTo)) return JSONScalar
      return field.hasMany ? new GraphQLList(GraphQLID) : GraphQLID
    case 'select':
    case 'radio':
      return field.hasMany ? new GraphQLList(GraphQLString) : GraphQLString
    case 'json':
    case 'richText':
    case 'group':
    case 'array':
    case 'blocks':
    case 'point':
      return JSONScalar
    default:
      return GraphQLString // text, email, slug, textarea, code, date, password
  }
}

const ctxBase = (ctx: GraphQLContext) => ({ req: { user: ctx.user }, overrideAccess: ctx.overrideAccess })

/**
 * Build the type for one collection. Relationship/upload fields resolve to the
 * *related object type* (not just an ID) by fetching through the kernel — bounded
 * naturally by the query's selection set, and access-checked per fetch. Cross-
 * references resolve because fields are thunked against the shared `types` map.
 */
function buildObjectType(
  collection: AdminCollection,
  types: Map<string, GraphQLObjectType>,
  kernel: Kernel,
): GraphQLObjectType {
  return new GraphQLObjectType({
    name: pascalCase(collection.slug),
    fields: () => {
      const fields: GraphQLFieldConfigMap<Row, GraphQLContext> = {
        id: { type: new GraphQLNonNull(GraphQLID) },
        createdAt: { type: GraphQLString },
        updatedAt: { type: GraphQLString },
      }
      if (collection.versions?.drafts) fields._status = { type: GraphQLString }
      for (const field of collection.fields) {
        if (field.type === 'password') continue
        // Only single-target relationships get a typed resolver; polymorphic
        // (`string[]`) refs fall through to the JSON scalar branch below.
        const singleRelTo =
          (field.type === 'relationship' || field.type === 'upload') && typeof field.relationTo === 'string'
            ? field.relationTo
            : undefined
        const relType = singleRelTo ? types.get(singleRelTo) : undefined
        if (relType && singleRelTo) {
          const relSlug = singleRelTo
          fields[field.name] = field.hasMany
            ? {
                type: new GraphQLList(relType),
                resolve: (src, _args, ctx) =>
                  Promise.all(
                    (Array.isArray(src[field.name]) ? (src[field.name] as unknown[]) : [])
                      .map((v) => relId(v))
                      .filter((id): id is string => Boolean(id))
                      .map((id) => kernel.findByID({ collection: relSlug, id, ...ctxBase(ctx) })),
                  ),
              }
            : {
                type: relType,
                resolve: (src, _args, ctx) => {
                  const id = relId(src[field.name])
                  return id ? kernel.findByID({ collection: relSlug, id, ...ctxBase(ctx) }) : null
                },
              }
        } else {
          fields[field.name] = { type: scalarType(field) as never }
        }
      }
      return fields
    },
  })
}

/** A relationship value may be a raw id or an already-populated doc. */
function relId(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'id' in value) return String((value as { id: unknown }).id)
  return null
}

function listType(name: string, objectType: GraphQLObjectType): GraphQLObjectType {
  return new GraphQLObjectType({
    name: `${name}List`,
    fields: {
      docs: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))) },
      totalDocs: { type: new GraphQLNonNull(GraphQLInt) },
      page: { type: GraphQLInt },
      totalPages: { type: GraphQLInt },
      hasNextPage: { type: GraphQLBoolean },
      hasPrevPage: { type: GraphQLBoolean },
    },
  })
}

/** Build the executable schema. Resolvers call the kernel with the request context. */
export function buildGraphQLSchema(kernel: Kernel): GraphQLSchema {
  const schema = describeConfig(kernel.config)
  const collections = schema.collections.filter((c) => !c.hidden)

  const queryFields: GraphQLFieldConfigMap<unknown, GraphQLContext> = {}
  const mutationFields: GraphQLFieldConfigMap<unknown, GraphQLContext> = {}

  // Build all object types up front so relationship fields can reference each
  // other (and themselves) through the shared map.
  const types = new Map<string, GraphQLObjectType>()
  for (const collection of collections) types.set(collection.slug, buildObjectType(collection, types, kernel))

  for (const collection of collections) {
    const objectType = types.get(collection.slug)!
    const list = listType(pascalCase(collection.slug), objectType)
    const base = (ctx: GraphQLContext) => ({ req: { user: ctx.user }, overrideAccess: ctx.overrideAccess })

    queryFields[`${collection.slug}ById`] = {
      type: objectType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) }, draft: { type: GraphQLBoolean } },
      resolve: (_src, args, ctx) =>
        kernel.findByID({ collection: collection.slug, id: String(args.id), draft: Boolean(args.draft), ...base(ctx) }),
    } satisfies GraphQLFieldConfig<unknown, GraphQLContext>

    queryFields[collection.slug] = {
      type: new GraphQLNonNull(list),
      args: {
        where: { type: JSONScalar },
        limit: { type: GraphQLInt },
        page: { type: GraphQLInt },
        sort: { type: GraphQLString },
        draft: { type: GraphQLBoolean },
      },
      resolve: (_src, args, ctx) =>
        kernel.find({
          collection: collection.slug,
          where: (args.where as never) ?? undefined,
          limit: (args.limit as number) ?? undefined,
          page: (args.page as number) ?? undefined,
          sort: (args.sort as string) ?? undefined,
          draft: Boolean(args.draft),
          ...base(ctx),
        }),
    } satisfies GraphQLFieldConfig<unknown, GraphQLContext>

    const Name = pascalCase(collection.slug)
    mutationFields[`create${Name}`] = {
      type: objectType,
      args: { data: { type: new GraphQLNonNull(JSONScalar) } },
      resolve: (_src, args, ctx) => kernel.create({ collection: collection.slug, data: args.data as Row, ...base(ctx) }),
    }
    mutationFields[`update${Name}`] = {
      type: objectType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) }, data: { type: new GraphQLNonNull(JSONScalar) } },
      resolve: (_src, args, ctx) =>
        kernel.update({ collection: collection.slug, id: String(args.id), data: args.data as Row, ...base(ctx) }),
    }
    mutationFields[`delete${Name}`] = {
      type: objectType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: (_src, args, ctx) => kernel.delete({ collection: collection.slug, id: String(args.id), ...base(ctx) }),
    }
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    mutation: new GraphQLObjectType({ name: 'Mutation', fields: mutationFields }),
  })
}
