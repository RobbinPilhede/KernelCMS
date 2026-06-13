import { createServerFn } from '@tanstack/react-start'

// Server functions: these always execute on the server (even during client-side
// navigation), so it is safe to touch the KernelCMS Local API + SQLite here. They
// read the `view` descriptor from your content model, so they work unchanged for
// whichever starter model you scaffolded.

export const listItems = createServerFn({ method: 'GET' }).handler(async () => {
  const { getKernel } = await import('./kernel')
  const { view } = await import('./config')
  const kernel = await getKernel()
  const result = await kernel.find({
    collection: view.primary,
    sort: view.date ? `-${view.date}` : '-createdAt',
    depth: 1,
    limit: 50,
    overrideAccess: true,
  })
  return result.docs
})

export const getItem = createServerFn({ method: 'GET' })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }) => {
    const { getKernel } = await import('./kernel')
    const { view } = await import('./config')
    const kernel = await getKernel()
    const result = await kernel.find({
      collection: view.primary,
      where: { [view.slug]: { equals: slug } },
      depth: 1,
      limit: 1,
      overrideAccess: true,
    })
    return result.docs[0] ?? null
  })

export const getSettings = createServerFn({ method: 'GET' }).handler(async () => {
  const { getKernel } = await import('./kernel')
  const { view } = await import('./config')
  const kernel = await getKernel()
  return kernel.findGlobal({ slug: view.settings, overrideAccess: true })
})
