/**
 * Email is an *adapter*, never a hard dependency. Core ships three zero-dependency
 * adapters (console, memory, http); anything heavier (SMTP/nodemailer) lives in an
 * optional package. This keeps `@kernel/core` free of native/transport deps while
 * still powering password reset, email verification, and (later) notifications.
 */

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text?: string
  /** Overrides the adapter's default sender. */
  from?: string
}

export interface EmailAdapter {
  /** Stable identifier, surfaced in logs/diagnostics. */
  name: string
  send(message: EmailMessage): Promise<void>
}

/** Dev default: logs the message instead of sending. Frictionless local flows. */
export function consoleEmail(opts: { from?: string } = {}): EmailAdapter {
  const from = opts.from ?? 'KernelCMS <no-reply@kernelcms.local>'
  return {
    name: 'console',
    async send(message) {
      console.log(
        `\n[KernelCMS email] (console adapter — not actually sent)\n` +
          `  from:    ${message.from ?? from}\n` +
          `  to:      ${message.to}\n` +
          `  subject: ${message.subject}\n` +
          `  text:    ${message.text ?? stripHtml(message.html)}\n`,
      )
    },
  }
}

/** Records sent messages in-memory. For tests and previews. */
export interface MemoryEmailAdapter extends EmailAdapter {
  readonly sent: EmailMessage[]
  clear(): void
}

export function memoryEmail(opts: { from?: string } = {}): MemoryEmailAdapter {
  const from = opts.from ?? 'KernelCMS <no-reply@kernelcms.local>'
  const sent: EmailMessage[] = []
  return {
    name: 'memory',
    sent,
    clear() {
      sent.length = 0
    },
    async send(message) {
      sent.push({ ...message, from: message.from ?? from })
    },
  }
}

/**
 * Sends via a provider's HTTP API (Resend/Postmark-shaped) using `fetch` only —
 * no SDK. Defaults target Resend's `POST /emails`; override `endpoint`/`headers`/
 * `body` for any JSON email API.
 */
export function httpEmail(opts: {
  apiKey: string
  from: string
  endpoint?: string
  headers?: Record<string, string>
  /** Map a message to the provider's JSON body. Defaults to Resend's shape. */
  toBody?: (message: EmailMessage, from: string) => unknown
}): EmailAdapter {
  const endpoint = opts.endpoint ?? 'https://api.resend.com/emails'
  const toBody =
    opts.toBody ??
    ((message: EmailMessage, from: string) => ({
      from: message.from ?? from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      ...(message.text ? { text: message.text } : {}),
    }))
  return {
    name: 'http',
    async send(message) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
          ...opts.headers,
        },
        body: JSON.stringify(toBody(message, opts.from)),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Email send failed (${res.status}): ${detail.slice(0, 300)}`)
      }
    },
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
