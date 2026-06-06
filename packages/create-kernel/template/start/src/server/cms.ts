import { createServerFn } from '@tanstack/react-start'

// Server functions: these always execute on the server (even during client-side
// navigation), so it is safe to touch the KernelCMS Local API + SQLite here.

export const listPosts = createServerFn({ method: 'GET' }).handler(async () => {
  const { getKernel } = await import('./kernel')
  const kernel = await getKernel()
  const result = await kernel.find({
    collection: 'posts',
    where: { status: { equals: 'published' } },
    sort: '-published_at',
    depth: 1,
    limit: 50,
    overrideAccess: true,
  })
  return result.docs
})

export const getPost = createServerFn({ method: 'GET' })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }) => {
    const { getKernel } = await import('./kernel')
    const kernel = await getKernel()
    const result = await kernel.find({
      collection: 'posts',
      where: { slug: { equals: slug } },
      depth: 1,
      limit: 1,
      overrideAccess: true,
    })
    return result.docs[0] ?? null
  })

export const getSettings = createServerFn({ method: 'GET' }).handler(async () => {
  const { getKernel } = await import('./kernel')
  const kernel = await getKernel()
  return kernel.findGlobal({ slug: 'site_settings', overrideAccess: true })
})
