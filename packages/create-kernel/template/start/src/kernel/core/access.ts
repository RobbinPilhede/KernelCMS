import type { AccessArgs, AccessFn, AccessResult } from './types'

/**
 * Evaluate an access rule. When no rule is defined, KernelCMS is secure by
 * default: the operation is allowed only for authenticated users. Collections
 * that should be publicly readable must opt in with `access.read: () => true`.
 */
export async function evalAccess(fn: AccessFn | undefined, args: AccessArgs): Promise<AccessResult> {
  if (!fn) return Boolean(args.req.user)
  return fn(args)
}

/** A result is "allowed" unless it is explicitly `false`. A `Where` means allowed-but-scoped. */
export function isAllowed(result: AccessResult): boolean {
  return result !== false
}

export function asWhere(result: AccessResult): import('@kernel/db').Where | undefined {
  return result === true || result === false ? undefined : result
}
