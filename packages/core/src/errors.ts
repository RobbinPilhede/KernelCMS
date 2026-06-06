/** Typed error hierarchy. Every failure crossing an API boundary is a KernelError. */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL'

export interface FieldError {
  path: string
  message: string
}

export interface ErrorMeta {
  /** A translation key. When set, the boundary renders the localized message for
   *  the request locale (interpolating `context`), falling back to `.message`. */
  messageKey?: string
  /** Interpolation values for the localized template, e.g. `{ retryAfter: 30 }`. */
  context?: Record<string, unknown>
}

export class KernelError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: unknown
  readonly messageKey?: string
  readonly context?: Record<string, unknown>

  constructor(message: string, code: ErrorCode, status: number, details?: unknown, meta?: ErrorMeta) {
    super(message)
    this.name = 'KernelError'
    this.code = code
    this.status = status
    this.details = details
    this.messageKey = meta?.messageKey
    this.context = meta?.context
    Object.setPrototypeOf(this, new.target.prototype)
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    }
  }
}

export class ValidationError extends KernelError {
  readonly errors: FieldError[]

  constructor(errors: FieldError[]) {
    super(`Validation failed: ${errors.map((e) => e.path).join(', ')}`, 'VALIDATION', 400, errors)
    this.name = 'ValidationError'
    this.errors = errors
  }
}

export class NotFoundError extends KernelError {
  constructor(message = 'The requested resource was not found.') {
    super(message, 'NOT_FOUND', 404)
    this.name = 'NotFoundError'
  }
}

export class ForbiddenError extends KernelError {
  constructor(message = 'You are not allowed to perform this action.') {
    super(message, 'FORBIDDEN', 403)
    this.name = 'ForbiddenError'
  }
}

export class UnauthorizedError extends KernelError {
  constructor(message = 'Authentication is required.') {
    super(message, 'UNAUTHORIZED', 401)
    this.name = 'UnauthorizedError'
  }
}

export class BadRequestError extends KernelError {
  constructor(message = 'The request was malformed.', details?: unknown) {
    super(message, 'BAD_REQUEST', 400, details)
    this.name = 'BadRequestError'
  }
}

export class ConflictError extends KernelError {
  constructor(message = 'The resource already exists.', details?: unknown) {
    super(message, 'CONFLICT', 409, details)
    this.name = 'ConflictError'
  }
}

export class PayloadTooLargeError extends KernelError {
  constructor(message = 'Request body too large.', details?: unknown) {
    super(message, 'PAYLOAD_TOO_LARGE', 413, details)
    this.name = 'PayloadTooLargeError'
  }
}

export class TooManyRequestsError extends KernelError {
  /** Seconds the client should wait before retrying, surfaced as Retry-After. */
  readonly retryAfter?: number

  constructor(message = 'Too many requests. Please try again later.', retryAfter?: number) {
    super(message, 'TOO_MANY_REQUESTS', 429, retryAfter === undefined ? undefined : { retryAfter })
    this.name = 'TooManyRequestsError'
    this.retryAfter = retryAfter
  }
}

export function isKernelError(err: unknown): err is KernelError {
  return err instanceof KernelError
}

// ---------------------------------------------------------------------------
// Localized error messages
//
// A small registry mapping `locale -> messageKey -> template`. Errors carry a
// `messageKey` + `context`; the message is rendered at the HTTP boundary for the
// request's locale, so throw sites stay locale-agnostic. Plugins/modules and the
// app contribute messages via `registerErrorMessages`. Templates interpolate
// `{name}` placeholders from the error's `context`.
// ---------------------------------------------------------------------------

const messageRegistry = new Map<string, Map<string, string>>()

/** Register (merge) localized error templates: `{ en: { 'x.locked': '…{n}…' } }`. */
export function registerErrorMessages(messages: Record<string, Record<string, string>>): void {
  for (const [locale, map] of Object.entries(messages)) {
    const bucket = messageRegistry.get(locale) ?? new Map<string, string>()
    for (const [key, template] of Object.entries(map)) bucket.set(key, template)
    messageRegistry.set(locale, bucket)
  }
}

/** Test/util hook: drop all registered templates. */
export function clearErrorMessages(): void {
  messageRegistry.clear()
}

function interpolate(template: string, context?: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) =>
    context && key in context ? String(context[key]) : `{${key}}`,
  )
}

/** Resolve a localized error message: exact locale, then its base (`en-US`→`en`),
 *  then the supplied fallback, then the key itself. Placeholders are interpolated. */
export function renderErrorMessage(
  messageKey: string,
  locale: string,
  context?: Record<string, unknown>,
  fallback?: string,
): string {
  const base = locale.split('-')[0]!
  const template = messageRegistry.get(locale)?.get(messageKey) ?? messageRegistry.get(base)?.get(messageKey)
  return interpolate(template ?? fallback ?? messageKey, context)
}
