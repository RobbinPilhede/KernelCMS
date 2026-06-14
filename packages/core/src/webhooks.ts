/**
 * Outbound webhooks: a signed HTTP POST fired when a document changes. Wired in
 * by attaching afterChange/afterDelete hooks to matching collections, so the
 * normal operation pipeline (access, validation, hooks) runs first and the
 * webhook only sees the committed document.
 *
 * Two delivery modes (per endpoint):
 *  - **inline** (default): the POST is awaited with a short timeout so failures are
 *    observable, but a failing or slow receiver never fails or hangs the write (errors
 *    are caught and logged; the request aborts at `timeoutMs`). Best-effort — an event
 *    is dropped if the receiver is down.
 *  - **durable** (`durable: true`): the event is appended to the `_webhook_deliveries`
 *    outbox and delivered by the cron drain (`kernel.processWebhooks`) with retry +
 *    backoff, so a down receiver no longer drops events.
 *
 * The destination URL is SSRF-guarded at config load (private/loopback hosts are rejected
 * unless the endpoint opts into `allowPrivateNetwork`), so delivery here trusts the URL.
 */
import { createHmac } from 'node:crypto'
import type { Logger } from '@kernel/db'
import type { CollectionConfig, Doc, SanitizedWebhook, WebhookConfig, WebhookEvent } from './types'

export interface WebhookPayload {
  event: WebhookEvent
  collection: string
  id: string
  /** The document after the change (absent for deletes when unavailable). */
  doc?: Doc
  /** Epoch milliseconds when the event fired. */
  timestamp: number
}

/** The outcome of one delivery attempt. Never thrown — always returned. */
export interface WebhookDeliveryResult {
  ok: boolean
  /** The HTTP status code, when a response was received. */
  status?: number
  /** A short error string when the request failed/timed out (never the secret). */
  error?: string
}

/** A durable-delivery enqueue sink — writes one `pending` row to the outbox. */
export type WebhookEnqueue = (delivery: {
  webhook: string
  event: WebhookEvent
  collection: string
  documentId: string
  payload: WebhookPayload
}) => Promise<void>

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** The headers for a webhook POST, including the HMAC signature when a secret is set. */
export function webhookHeaders(cfg: WebhookConfig, payload: WebhookPayload, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-kernel-event': payload.event,
    'x-kernel-timestamp': String(payload.timestamp),
    ...(cfg.headers ?? {}),
  }
  if (cfg.secret) headers['x-kernel-signature'] = sign(cfg.secret, body)
  return headers
}

/** Deliver one webhook. Never throws: network/timeouts are caught and returned as `ok:false`. */
export async function deliverWebhook(
  cfg: WebhookConfig,
  payload: WebhookPayload,
  logger: Logger,
): Promise<WebhookDeliveryResult> {
  const body = JSON.stringify(payload)
  const headers = webhookHeaders(cfg, payload, body)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 5000)
  try {
    // `redirect: 'manual'` so a receiver can't 3xx-redirect the POST into a private/metadata
    // host AFTER the config-time SSRF guard ran on the literal URL. A 3xx is `!res.ok`, so it
    // is recorded as a non-delivery (and retried for durable hooks) rather than followed.
    const res = await fetch(cfg.url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' })
    if (!res.ok) logger.warn(`webhook ${payload.event} ${payload.collection} -> ${cfg.url} responded ${res.status}`)
    return { ok: res.ok, status: res.status }
  } catch (err) {
    logger.warn(`webhook ${payload.event} ${payload.collection} -> ${cfg.url} failed`, err)
    return { ok: false, error: err instanceof Error ? err.message : 'delivery failed' }
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
 *
 * A `durable` endpoint enqueues to the outbox via `enqueue` instead of delivering inline;
 * inline endpoints POST best-effort as before. `enqueue` is required only if any durable
 * webhook is configured.
 */
export function attachWebhooks(
  collections: CollectionConfig[],
  webhooks: SanitizedWebhook[],
  systemSlugs: ReadonlySet<string>,
  logger: Logger,
  enqueue?: WebhookEnqueue,
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

    const fire = async (event: WebhookEvent, documentId: string, doc: Doc | undefined): Promise<void> => {
      const payload: WebhookPayload = { event, collection: slug, id: documentId, timestamp: Date.now() }
      if (doc) payload.doc = doc
      await Promise.all(
        relevant
          .filter((w) => matches(w, slug, event))
          .map(async (w) => {
            if (w.durable && enqueue) {
              // Durable: append to the outbox; the cron drain delivers with retry. A failed
              // enqueue is logged but never fails the write (matches inline best-effort).
              try {
                await enqueue({ webhook: w.slug, event, collection: slug, documentId, payload })
              } catch (err) {
                logger.warn(`webhook ${event} ${slug} -> ${w.slug} enqueue failed`, err)
              }
            } else {
              await deliverWebhook(w, payload, logger)
            }
          }),
      )
    }

    const onChange = async (args: { operation: 'create' | 'update'; doc: Doc }): Promise<Doc> => {
      await fire(args.operation, args.doc.id, args.doc)
      return args.doc
    }
    hooks.afterChange = [...(hooks.afterChange ?? []), onChange as never]

    const onDelete = async (args: { id: string; doc: Doc }): Promise<void> => {
      await fire('delete', args.id, args.doc)
    }
    hooks.afterDelete = [...(hooks.afterDelete ?? []), onDelete as never]
  }
}
