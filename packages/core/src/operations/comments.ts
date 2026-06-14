import { randomUUID } from 'node:crypto'
import type { Row, Where } from '@kernel/db'
import { evalAccess, isAllowed, asWhere } from '../access'
import { matchesWhere } from '../query'
import { storageFields } from '../fields'
import { COMMENTS_TABLE } from '../schema'
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../errors'
import type {
  AddCommentOptions,
  CollectionConfig,
  CommentCountOptions,
  CommentDoc,
  DeleteCommentOptions,
  ListCommentsOptions,
  RequestContext,
  ResolveCommentOptions,
} from '../types'
import type { OpsContext } from './context'

/**
 * Editorial comments / annotations.
 *
 * Threaded review feedback on content documents, persisted in `_comments` (never on the
 * document, never reachable via generic CRUD). The security model is "you can only comment
 * on / see comments for a document you can READ": every op resolves the target document
 * through the ACCESS-CHECKED read path first, so a comment never leaks content (body/author/
 * even existence) the caller couldn't otherwise see. The author is recorded from the
 * authenticated principal — NEVER client input — so a comment can't be forged.
 */
export function createCommentOps(ctx: OpsContext) {
  const {
    config,
    db,
    MAX_LIMIT,
    collectionOrThrow,
    buildReq,
    principalOf,
    recordAudit,
    isReviewerPrincipal,
    isAdminPrincipal,
    normalizePrincipalType,
  } = ctx

  // Per-field cap on a comment body (untrusted, agent/MCP-reachable storage-growth guard).
  const MAX_COMMENT_BODY = 10_000
  // Prototype-pollution guard for an untrusted id/field string used as a key/lookup.
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

  /** Shape a raw `_comments` row into a public CommentDoc. */
  function rowToComment(row: Row): CommentDoc {
    return {
      id: String(row.id),
      collection: String(row.collection),
      documentId: String(row.documentId),
      field: row.field != null ? String(row.field) : null,
      parentId: row.parentId != null ? String(row.parentId) : null,
      body: String(row.body ?? ''),
      authorId: row.authorId != null ? String(row.authorId) : null,
      authorType: normalizePrincipalType(row.authorType),
      resolved: row.resolved === true,
      createdAt: row.createdAt != null ? String(row.createdAt) : '',
      updatedAt: row.updatedAt != null ? String(row.updatedAt) : '',
    }
  }

  /**
   * Access-check a READ on the target document, exactly like `assertTarget`/the read path:
   * the document must exist AND the caller must be able to read it (rule + row-scope). A
   * denial (or a missing doc) throws — so a caller can never add/list/resolve comments for a
   * document outside their read scope, and the comment surface can't be used to probe for
   * hidden documents. Only an `overrideAccess` (service/internal) call skips the check —
   * an anonymous Local-API caller (no `req.user`) is still held to the document's read rule,
   * exactly like `assertCanReadDoc`, so comment bodies/authors/counts never leak.
   */
  async function assertCanCommentOn(
    collection: CollectionConfig,
    id: string,
    req: RequestContext,
    override: boolean,
  ): Promise<void> {
    if (typeof id !== 'string' || id.length === 0 || FORBIDDEN_KEYS.has(id)) {
      throw new BadRequestError('A valid document `id` is required.')
    }
    const row = await db.findByID({ collection: collection.slug, id })
    if (!row) throw new NotFoundError()
    if (override) return
    const access = await evalAccess(collection.access?.read, { req, id })
    if (!isAllowed(access)) throw new ForbiddenError()
    const scope = asWhere(access)
    if (scope && !matchesWhere(row, scope)) throw new ForbiddenError()
  }

  /** The single comment row by id, or null. */
  async function commentRowById(commentId: string): Promise<Row | null> {
    if (typeof commentId !== 'string' || commentId.length === 0 || FORBIDDEN_KEYS.has(commentId)) {
      throw new BadRequestError('A valid `commentId` is required.')
    }
    return (await db.findByID({ collection: COMMENTS_TABLE, id: commentId })) ?? null
  }

  async function addComment(opts: AddCommentOptions): Promise<CommentDoc> {
    if (!config.comments.enabled) {
      throw new BadRequestError('Editorial comments are not enabled (set `config.comments`).')
    }
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    // Anonymous principals can't comment — a comment must be attributable to a user/agent.
    if (!override && !req.user) throw new UnauthorizedError('Authentication is required to comment.')

    // Gate on the TARGET DOCUMENT's read access. A caller who can't read it gets
    // Forbidden/NotFound — never a stored comment, and never a hint the doc exists.
    await assertCanCommentOn(collection, opts.id, req, override)

    // Body is untrusted: require a non-empty trimmed string, bound its length.
    const body = typeof opts.body === 'string' ? opts.body.trim() : ''
    if (body.length === 0) throw new ValidationError([{ path: 'body', message: 'A comment `body` is required.' }])
    if (body.length > MAX_COMMENT_BODY) {
      throw new ValidationError([
        { path: 'body', message: `Comment is too long (max ${MAX_COMMENT_BODY} characters).` },
      ])
    }

    // `field` (if given) must be a REAL field of the collection — reject prototype-pollution
    // keys and any name that isn't an actual field so the anchor can't be a poisoned key or
    // a probe. We match against the storage fields (the columns content actually has).
    let field: string | null = null
    if (opts.field != null) {
      const name = String(opts.field)
      if (FORBIDDEN_KEYS.has(name) || !storageFields(collection.fields).some((f) => f.name === name)) {
        throw new ValidationError([{ path: 'field', message: `"${name}" is not a field of "${collection.slug}".` }])
      }
      field = name
    }

    // `parentId` (if given) must be an EXISTING comment on the SAME (collection, document) —
    // no cross-document/cross-collection threading (which would leak ids / attach a reply to
    // a doc the caller couldn't otherwise touch).
    let parentId: string | null = null
    if (opts.parentId != null) {
      const parent = await commentRowById(String(opts.parentId))
      if (!parent || String(parent.collection) !== collection.slug || String(parent.documentId) !== String(opts.id)) {
        throw new ValidationError([{ path: 'parentId', message: 'Parent comment must be on the same document.' }])
      }
      parentId = String(parent.id)
    }

    // Author is the AUTHENTICATED PRINCIPAL — never client input. A forged `authorId` in the
    // call has no effect (we don't read it); the stored author is `principalOf(req)`.
    const me = principalOf(req)
    const id = randomUUID()
    await db.create({
      collection: COMMENTS_TABLE,
      data: {
        id,
        collection: collection.slug,
        documentId: String(opts.id),
        field,
        parentId,
        body,
        authorId: override ? null : me.id,
        authorType: override ? 'system' : me.type,
        resolved: false,
      },
    })

    await recordAudit({
      action: 'comment.create',
      collection: collection.slug,
      documentId: String(opts.id),
      req,
      overrideAccess: override,
      ...(field ? { fields: [field] } : {}),
      meta: { commentId: id, ...(parentId ? { parentId } : {}) },
    })

    const saved = await db.findByID({ collection: COMMENTS_TABLE, id })
    return rowToComment(saved ?? { id })
  }

  async function listComments(opts: ListCommentsOptions): Promise<CommentDoc[]> {
    if (!config.comments.enabled) return []
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    // NEVER list comments for a document the caller can't read (Forbidden — no leak).
    await assertCanCommentOn(collection, opts.id, req, override)

    const and: Where[] = [{ collection: { equals: collection.slug } }, { documentId: { equals: String(opts.id) } }]
    if (opts.field != null) and.push({ field: { equals: String(opts.field) } })
    // Resolved comments are hidden unless explicitly requested.
    if (opts.includeResolved !== true) and.push({ resolved: { not_equals: true } })

    const res = await db.find({
      collection: COMMENTS_TABLE,
      where: { and },
      sort: [{ field: 'createdAt', direction: 'asc' }],
      limit: MAX_LIMIT,
      page: 1,
    })
    return res.docs.map(rowToComment)
  }

  async function resolveComment(opts: ResolveCommentOptions): Promise<CommentDoc> {
    if (!config.comments.enabled) {
      throw new BadRequestError('Editorial comments are not enabled (set `config.comments`).')
    }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const row = await commentRowById(opts.commentId)
    if (!row) throw new NotFoundError()

    const collection = collectionOrThrow(String(row.collection))
    // Re-check the document read access (the comment's doc could now be out of scope).
    await assertCanCommentOn(collection, String(row.documentId), req, override)

    // Only the comment's AUTHOR or a reviewer (admin/editor) may resolve it. A random user
    // who merely shares read access to the document cannot touch someone else's comment.
    if (!override) {
      const me = principalOf(req)
      const isAuthor = row.authorId != null && String(row.authorId) === me.id
      if (!isAuthor && !isReviewerPrincipal(req)) {
        throw new ForbiddenError('Only the comment author or a reviewer can resolve this comment.')
      }
    }

    const resolved = opts.resolved !== false
    await db.update({ collection: COMMENTS_TABLE, id: String(row.id), data: { resolved } })

    await recordAudit({
      action: 'comment.resolve',
      collection: collection.slug,
      documentId: String(row.documentId),
      req,
      overrideAccess: override,
      meta: { commentId: String(row.id), resolved },
    })

    const saved = await db.findByID({ collection: COMMENTS_TABLE, id: String(row.id) })
    return rowToComment(saved ?? row)
  }

  async function deleteComment(opts: DeleteCommentOptions): Promise<{ id: string }> {
    if (!config.comments.enabled) {
      throw new BadRequestError('Editorial comments are not enabled (set `config.comments`).')
    }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const row = await commentRowById(opts.commentId)
    if (!row) throw new NotFoundError()

    const collection = collectionOrThrow(String(row.collection))
    await assertCanCommentOn(collection, String(row.documentId), req, override)

    // Only the comment's AUTHOR or an admin may delete it.
    if (!override) {
      const me = principalOf(req)
      const isAuthor = row.authorId != null && String(row.authorId) === me.id
      if (!isAuthor && !isAdminPrincipal(req)) {
        throw new ForbiddenError('Only the comment author or an admin can delete this comment.')
      }
    }

    await db.delete({ collection: COMMENTS_TABLE, id: String(row.id) })

    await recordAudit({
      action: 'comment.delete',
      collection: collection.slug,
      documentId: String(row.documentId),
      req,
      overrideAccess: override,
      meta: { commentId: String(row.id) },
    })

    return { id: String(row.id) }
  }

  async function commentCount(opts: CommentCountOptions): Promise<number> {
    if (!config.comments.enabled) return 0
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    await assertCanCommentOn(collection, opts.id, req, override)

    const and: Where[] = [{ collection: { equals: collection.slug } }, { documentId: { equals: String(opts.id) } }]
    if (opts.includeResolved !== true) and.push({ resolved: { not_equals: true } })
    return db.count({ collection: COMMENTS_TABLE, where: { and } })
  }

  return { addComment, listComments, resolveComment, deleteComment, commentCount }
}
