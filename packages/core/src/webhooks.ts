/**
 * Outbound webhooks: a signed HTTP POST fired when a document changes. Wired in
 * by attaching afterChange/afterDelete hooks to matching collections, so the
 * normal operation pipeline (access, validation, hooks) runs first and the
 * webhook only sees the committed document.
 *
 * Delivery is awaited with a short timeout so failures are observable, but a
 * failing or slow receiver never fails or hangs the write (errors are caught and
 * logged; the request aborts at `timeoutMs`). Durable retry via the job queue is
 * a future enhancement.
 */
import { createHmac } from 'node:crypto'
import type { Logger } from '@kernel/db'
import type { CollectionConfig, Doc, WebhookConfig, WebhookEvent } from './types'

export interface WebhookPayload {
  event: WebhookEvent
  collection: string
  id: string
  /** The document after the change (absent for deletes when unavailable). */
  doc?: Doc
  /** Epoch milliseconds when the event fired. */
  timestamp: number
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** Deliver one webhook. Never throws: network/timeouts are caught and logged. */
export async function deliverWebhook(cfg: WebhookConfig, payload: WebhookPayload, logger: Logger): Promise<void> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-kernel-event': payload.event,
    'x-kernel-timestamp': String(payload.timestamp),
    ...(cfg.headers ?? {}),
  }
  if (cfg.secret) headers['x-kernel-signature'] = sign(cfg.secret, body)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 5000)
  try {
    const res = await fetch(cfg.url, { method: 'POST', headers, body, signal: controller.signal })
    if (!res.ok) logger.warn(`webhook ${payload.event} ${payload.collection} -> ${cfg.url} responded ${res.status}`)
  } catch (err) {
    logger.warn(`webhook ${payload.event} ${payload.collection} -> ${cfg.url} failed`, err)
  } finally {
    clearTimeout(timeout)
  }
}

function matches(cfg: WebhookConfig, slug: string, event: WebhookEvent): boolean {
  if (cfg.collections && !cfg.collections.includes(slug)) return false
  if (cfg.events && !cfg.events.includes(event)) return false
  return true
}

/**
 * Append webhook-firing hooks to every collection a webhook targets. System
 * collections (jobs queue, cache table) are excluded so internal writes never
 * emit webhooks (and can't loop). Mutates the provided collections in place.
 */
export function attachWebhooks(
  collections: CollectionConfig[],
  webhooks: WebhookConfig[],
  systemSlugs: ReadonlySet<string>,
  logger: Logger,
): void {
  if (webhooks.length === 0) return
  for (const collection of collections) {
    if (systemSlugs.has(collection.slug)) continue
    const slug = collection.slug
    const relevant = webhooks.filter(
      (w) => matches(w, slug, 'create') || matches(w, slug, 'update') || matches(w, slug, 'delete'),
    )
    if (relevant.length === 0) continue

    const hooks = (collection.hooks ??= {})

    const onChange = async (args: { operation: 'create' | 'update'; doc: Doc }): Promise<Doc> => {
      const event: WebhookEvent = args.operation
      const ts = Date.now()
      await Promise.all(
        relevant
          .filter((w) => matches(w, slug, event))
          .map((w) =>
            deliverWebhook(w, { event, collection: slug, id: args.doc.id, doc: args.doc, timestamp: ts }, logger),
          ),
      )
      return args.doc
    }
    hooks.afterChange = [...(hooks.afterChange ?? []), onChange as never]

    const onDelete = async (args: { id: string; doc: Doc }): Promise<void> => {
      const ts = Date.now()
      await Promise.all(
        relevant
          .filter((w) => matches(w, slug, 'delete'))
          .map((w) =>
            deliverWebhook(w, { event: 'delete', collection: slug, id: args.id, doc: args.doc, timestamp: ts }, logger),
          ),
      )
    }
    hooks.afterDelete = [...(hooks.afterDelete ?? []), onDelete as never]
  }
}
