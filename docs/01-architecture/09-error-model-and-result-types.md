# Error Model & Result Types

KernelCMS treats failure as a first-class, typed value rather than an afterthought. Every operation in the core — create, read, update, delete, validation, access checks, adapter calls — either returns a value or a structured `KernelError`. This document specifies the typed error base class, the `Result<T, E>` pattern that the operation core uses internally, how errors serialize consistently across REST, GraphQL, and RPC, and the firm boundary we draw between user-facing and internal errors. The goal is that a developer writing a hook, a custom field, or a plugin never has to guess what a thrown thing is, and an end user never sees a stack trace or a leaked SQL fragment.

## Why typed errors at all

Payload, Sanity, and Strapi all lean on thrown exceptions with loosely structured shapes. Payload throws `APIError` subclasses and relies on a Boom-style status code; Strapi wraps everything in Koa context errors and a `strapi-utils` error factory; Sanity surfaces transaction errors as opaque HTTP payloads from the hosted backend. In all three, the error *type* is not part of the function signature, so a hook author discovers failure modes by reading source or by crashing in production.

KernelCMS makes the contract explicit. The `@kernel/core` operation surface is fully typed end-to-end (see [the type-safety overview](./07-content-schema-and-type-generation.md)), and that includes the failure channel. A handler knows at compile time that `findByID` can fail with `NotFound`, `Forbidden`, or `AdapterError`, and nothing else.

## The typed error base class

All errors descend from a single abstract base, `KernelError`, exported from `@kernel/core`. Raw `throw new Error()` is banned across the codebase and in plugin authoring guidance — the base class carries the metadata every layer downstream needs.

```ts
// @kernel/core
export type ErrorVisibility = 'public' | 'internal'

export interface KernelErrorJSON {
  code: string            // stable machine code, e.g. 'NOT_FOUND'
  message: string         // safe, user-facing message
  status: number          // HTTP status for REST surface
  details?: unknown       // structured, code-specific payload
  path?: (string | number)[] // field path for validation errors
}

export abstract class KernelError extends Error {
  abstract readonly code: string
  abstract readonly status: number
  readonly visibility: ErrorVisibility = 'public'
  readonly details?: unknown
  readonly path?: (string | number)[]

  constructor(message: string, options?: { cause?: unknown; details?: unknown }) {
    super(message, { cause: options?.cause })
    this.name = this.constructor.name
    this.details = options?.details
  }

  /** Only public fields cross a network boundary. */
  toJSON(): KernelErrorJSON {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.visibility === 'public' ? this.details : undefined,
      path: this.path,
    }
  }
}
```

The concrete catalogue lives in `@kernel/core` so every adapter and API surface shares it:

| Class | `code` | `status` | `visibility` | When |
| --- | --- | --- | --- | --- |
| `ValidationError` | `VALIDATION` | 422 | public | Field-level or cross-field validation failed |
| `NotFoundError` | `NOT_FOUND` | 404 | public | Document or global does not exist |
| `ForbiddenError` | `FORBIDDEN` | 403 | public | Access control denied the operation |
| `UnauthenticatedError` | `UNAUTHENTICATED` | 401 | public | No valid session/token |
| `ConflictError` | `CONFLICT` | 409 | public | Version mismatch, unique constraint, optimistic-lock clash |
| `RateLimitError` | `RATE_LIMIT` | 429 | public | Throttle exceeded |
| `AdapterError` | `ADAPTER` | 500 | internal | Database/storage/queue adapter failed |
| `ConfigError` | `CONFIG` | 500 | internal | Invalid `kernel.config.ts` at boot |
| `InternalError` | `INTERNAL` | 500 | internal | Catch-all for unexpected failures |

`ValidationError` is the most heavily used and carries a typed `details` payload — an array of per-field issues that maps cleanly onto TanStack Form's field error model in the admin:

```ts
export interface FieldIssue {
  path: (string | number)[]   // ['meta', 'tags', 2, 'slug']
  code: string                // 'REQUIRED' | 'TOO_LONG' | custom
  message: string
}

export class ValidationError extends KernelError {
  readonly code = 'VALIDATION'
  readonly status = 422
  constructor(public readonly issues: FieldIssue[]) {
    super('Validation failed', { details: issues })
  }
}
```

Because the field `path` is structured (not a dotted string), the admin maps issues straight onto nested array/blocks/group fields without re-parsing. Payload and Strapi both return dotted-string paths that break on array indices; KernelCMS keeps the path machine-addressable.

## The Result type pattern

Internally, the operation core does not `throw` between layers. It threads a `Result<T, E>` so that control flow is explicit and exhaustively checked. Exceptions are reserved for genuinely unexpected, unrecoverable conditions (a panicking adapter), which the boundary then converts into an `InternalError`.

```ts
// @kernel/core
export type Result<T, E extends KernelError = KernelError> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E extends KernelError>(error: E): Result<never, E> =>
  ({ ok: false, error })

/** Run a Result-returning step; short-circuit on the first error. */
export function chain<A, B, E extends KernelError>(
  r: Result<A, E>,
  f: (a: A) => Result<B, E>,
): Result<B, E> {
  return r.ok ? f(r.value) : r
}
```

A `create` operation reads as a pipeline of fallible steps, each narrowing the error union:

```ts
async function create(args: CreateArgs): Promise<Result<Doc, KernelError>> {
  const access = await checkAccess(args)          // Result<true, ForbiddenError>
  if (!access.ok) return access

  const validated = await runValidation(args.data) // Result<Doc, ValidationError>
  if (!validated.ok) return validated

  const written = await adapter.create(validated.value) // Result<Doc, AdapterError>
  if (!written.ok) return written

  await runHooks('afterChange', written.value)
  return ok(written.value)
}
```

```
 args ──► checkAccess ──► runValidation ──► adapter.create ──► afterChange
            │ err            │ err              │ err
            ▼                ▼                  ▼
        Forbidden       Validation          Adapter ──► Result.error
```

### Where Result ends and exceptions begin

The Result pattern is an internal discipline, not a public API we force on every consumer. There are two front doors:

- **Local API (`@kernel/client` in-process):** throws by default — `await kernel.collections.posts.create(...)` resolves the doc or throws a `KernelError`, which is the ergonomic choice for application code and matches Payload's Local API feel. A `.safe.create(...)` variant returns the raw `Result` for callers who prefer it.
- **RPC over the wire:** TanStack Start server functions never throw across the boundary. They serialize the `Result` so the network protocol stays uniform (see below). The generated `@kernel/client` re-throws on the consumer side so the developer ergonomics match the in-process API.

This dual surface is deliberate: internal code gets exhaustive, no-`any` error handling; application code gets idiomatic `try/catch`; and the wire stays purely data.

## Error serialization across APIs

One error model, three projections. The shared serializer in `@kernel/core` produces `KernelErrorJSON`; each surface package adapts it to its own conventions while preserving `code`, `message`, and `details`.

```
KernelError
   │  toJSON()  ──► KernelErrorJSON (code, message, status, details, path)
   ├──────────────► @kernel/rest    → HTTP status + JSON body
   ├──────────────► @kernel/graphql → errors[].extensions.code
   └──────────────► @kernel/rpc     → { ok:false, error } envelope
```

**REST (`@kernel/rest`).** The HTTP status is `error.status`; the body is the JSON object. We do not invent envelope keys — the body *is* the error.

```json
{
  "code": "VALIDATION",
  "message": "Validation failed",
  "status": 422,
  "details": [{ "path": ["title"], "code": "REQUIRED", "message": "Title is required" }]
}
```

**GraphQL (`@kernel/graphql`).** GraphQL forces HTTP 200, so the signal moves into `extensions`. We never put a raw message in `errors[].message` for internal errors — only the stable code travels, with the safe message:

```json
{
  "errors": [{
    "message": "Validation failed",
    "path": ["createPost"],
    "extensions": { "code": "VALIDATION", "details": [/* FieldIssue[] */] }
  }]
}
```

This beats Strapi's GraphQL plugin, which historically leaked internal messages into `errors[].message`, and Sanity's GROQ errors, which are stringly-typed. KernelCMS gives clients a stable `extensions.code` to branch on.

**RPC (`@kernel/rpc`).** Server functions return the `Result` envelope verbatim, and `@kernel/client` re-hydrates `error` into the correct `KernelError` subclass by `code` so `instanceof ValidationError` works on the client. TanStack Query then keys off the typed error in its `error` state, and the admin renders the matching UI without a translation layer.

## User-facing versus internal errors

The `visibility` flag on every error is the single most important security control in this model. The rule is enforced at the serialization boundary, not left to each call site:

- `visibility: 'public'` — the `message` and `details` are written by us, contain no infrastructure detail, and are safe to show end users and to localize.
- `visibility: 'internal'` — the boundary replaces the message with a generic safe string, drops `details`, attaches a correlation `requestId`, and logs the full error (including `cause` and stack) server-side only.

```ts
// boundary serializer in @kernel/server
function serialize(error: KernelError, requestId: string): KernelErrorJSON {
  if (error.visibility === 'internal') {
    logger.error({ requestId, err: error, cause: error.cause })
    return {
      code: error.code,
      message: 'An unexpected error occurred.',
      status: error.status,
      details: { requestId },
    }
  }
  return error.toJSON()
}
```

Any non-`KernelError` thrown anywhere — a TypeError in a hook, an unhandled adapter rejection — is caught at the boundary and wrapped as `InternalError` (visibility `internal`) with the original attached as `cause`. The client gets `INTERNAL` + a `requestId`; the operator gets the stack in structured logs (see [observability & logging](../10-cloud-operations/05-observability-logging-metrics-tracing.md)). This is exactly the failure mode where Strapi and self-hosted Payload have historically leaked stack traces in development-style error responses left on in production.

### Localization and overrides

Public messages are i18n keys resolvable by the admin and clients. The `code` is the stable contract; the `message` is presentation. Authors can remap or localize messages in `kernel.config.ts` without touching error-handling logic:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  errors: {
    // Mask everything 5xx unless explicitly allowlisted.
    exposeInternalDetails: false,
    messages: {
      NOT_FOUND: { en: 'Nothing here.', da: 'Intet her.' },
      RATE_LIMIT: { en: 'Slow down and try again shortly.' },
    },
    onError: (error, ctx) => {
      // ctx carries requestId, user, operation, collection.
      if (error.visibility === 'internal') ctx.report(error) // Sentry, etc.
    },
  },
})
```

`exposeInternalDetails` is `false` by default and we recommend it stay that way in production; the only effect of `true` is that `internal` errors keep their original message in the response, which is a development convenience.

## Open questions

- **Result vs. throw as the *default* Local API surface.** We currently throw by default with `.safe.*` returning `Result`. An alternative is Result-first with a `.orThrow()` escape hatch. The trade-off is ergonomics (most app code wants throw) versus making fallibility impossible to ignore.
- **Aggregate validation vs. fail-fast.** `ValidationError` collects all `FieldIssue`s today. For very large `blocks` documents this can be expensive; whether to offer a fail-fast mode per operation is undecided.
- **GraphQL partial success.** GraphQL allows partial data with errors. Whether KernelCMS ever returns partial collection results (e.g. one document in a list failing field-level access) or always fails the whole field is not settled — it interacts with [field-level access control](../06-auth-security/01-authorization-and-access-control.md).
- **Stable code namespacing for plugins.** Custom errors from `@kernel/plugin-sdk` need collision-free codes. A `PLUGIN_<name>_<code>` convention is proposed but not finalized.
