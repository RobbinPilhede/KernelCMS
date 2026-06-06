/** Typed error hierarchy. Every failure crossing an API boundary is a KernelError. */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL'

export interface FieldError {
  path: string
  message: string
}

export class KernelError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: unknown

  constructor(message: string, code: ErrorCode, status: number, details?: unknown) {
    super(message)
    this.name = 'KernelError'
    this.code = code
    this.status = status
    this.details = details
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
