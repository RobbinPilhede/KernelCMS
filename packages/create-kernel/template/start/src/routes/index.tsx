import { Link, createFileRoute } from '@tanstack/react-router'
import { getSettings, listItems } from '../server/cms'
import { view } from '../server/config'

export const Route = createFileRoute('/')({
  loader: async () => ({ items: await listItems(), settings: await getSettings() }),
  component: Home,
})

function field(item: Record<string, unknown>, name?: string): string {
  if (!name) return ''
  const v = item[name]
  return v == null ? '' : String(v)
}

function Home() {
  const { items, settings } = Route.useLoaderData()
  const site = settings as Record<string, unknown>
  const siteName = String(site?.site_name ?? 'KernelCMS')
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
        {items.map((raw) => {
          const item = raw as Record<string, unknown>
          const title = field(item, view.title)
          const excerpt = field(item, view.excerpt)
          const dateStr = view.date && item[view.date] ? new Date(field(item, view.date)).toLocaleDateString() : null
          return (
            <li
              key={String(item.id)}
              className="rounded-xl border border-zinc-200 bg-white p-6 transition hover:border-indigo-300 hover:shadow-sm"
            >
              <Link to="/posts/$slug" params={{ slug: field(item, view.slug) }} className="block">
                <h2 className="text-xl font-semibold text-zinc-900">{title}</h2>
                {excerpt ? <p className="mt-2 text-zinc-600">{excerpt}</p> : null}
                {dateStr ? <div className="mt-3 text-sm text-zinc-400">{dateStr}</div> : null}
              </Link>
            </li>
          )
        })}
        {items.length === 0 ? <li className="text-zinc-500">No content yet.</li> : null}
      </ul>

      <footer className="mt-12 border-t border-zinc-100 pt-6 text-sm text-zinc-400">
        Server-rendered by TanStack Start · content from the KernelCMS Local API · stored in SQLite.
      </footer>
    </main>
  )
}
