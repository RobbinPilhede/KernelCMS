import { Link, createFileRoute } from '@tanstack/react-router'
import { getSettings, listPosts } from '../server/cms'

export const Route = createFileRoute('/')({
  loader: async () => ({ posts: await listPosts(), settings: await getSettings() }),
  component: Home,
})

function Home() {
  const { posts, settings } = Route.useLoaderData()
  const site = settings as Record<string, unknown>
  const siteName = String(site?.site_name ?? 'The Kernel Blog')
  const tagline = String(site?.tagline ?? '')

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-10">
        <div className="text-sm font-semibold uppercase tracking-wider text-indigo-600">
          KernelCMS · TanStack Start
        </div>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-zinc-900">{siteName}</h1>
        {tagline ? <p className="mt-2 text-lg text-zinc-500">{tagline}</p> : null}
      </header>

      <ul className="space-y-6">
        {posts.map((post) => {
          const author = post.author as { name?: string } | null
          const published = post.published_at
            ? new Date(String(post.published_at)).toLocaleDateString()
            : null
          return (
            <li
              key={String(post.id)}
              className="rounded-xl border border-zinc-200 bg-white p-6 transition hover:border-indigo-300 hover:shadow-sm"
            >
              <Link to="/posts/$slug" params={{ slug: String(post.slug) }} className="block">
                <h2 className="text-xl font-semibold text-zinc-900">{String(post.title)}</h2>
                <p className="mt-2 text-zinc-600">{String(post.excerpt ?? '')}</p>
                <div className="mt-3 flex items-center gap-2 text-sm text-zinc-400">
                  {author?.name ? <span>{author.name}</span> : null}
                  {published ? <span>· {published}</span> : null}
                </div>
              </Link>
            </li>
          )
        })}
        {posts.length === 0 ? <li className="text-zinc-500">No published posts yet.</li> : null}
      </ul>

      <footer className="mt-12 border-t border-zinc-100 pt-6 text-sm text-zinc-400">
        Server-rendered by TanStack Start · content from the KernelCMS Local API · stored in SQLite.
      </footer>
    </main>
  )
}
