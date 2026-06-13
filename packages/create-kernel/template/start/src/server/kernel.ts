import { initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { config, seed, view } from './config'

// Boot the kernel once per server process and reuse it.
let kernelPromise: Promise<Kernel> | null = null

export function getKernel(): Promise<Kernel> {
  if (!kernelPromise) kernelPromise = boot()
  return kernelPromise
}

async function boot(): Promise<Kernel> {
  const kernel = await initKernel(config, { autoMigrate: true, logLevel: 'warn' })
  const count = await kernel.count({ collection: view.primary, overrideAccess: true })
  if (count === 0) await seed(kernel)
  return kernel
}
