import { Link, createFileRoute } from '@tanstack/react-router'
import { getItem } from '../server/cms'
import { view } from '../server/config'

export const Route = createFileRoute('/posts/$slug')({
  loader: async ({ params }) => ({ item: await getItem({ data: params.slug }) }),
  component: ItemPage,
})

function field(item: Record<string, unknown>, name?: string): string {
  if (!name) return ''
  const v = item[name]
  return v == null ? '' : String(v)
}

function ItemPage() {
  const { item } = Route.useLoaderData()

  if (!item) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-zinc-500">Not found.</p>
        <Link to="/" className="text-indigo-600 hover:underline">
          ← Back to all content
        </Link>
      </main>
    )
  }

  const doc = item as Record<string, unknown>
  const title = field(doc, view.title)
  const excerpt = field(doc, view.excerpt)
  const dateStr = view.date && doc[view.date] ? new Date(field(doc, view.date)).toLocaleDateString() : null
  const body = field(doc, 'body')

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link to="/" className="text-sm text-indigo-600 hover:underline">
        ← All content
      </Link>
      <article className="mt-6">
        <h1 className="text-4xl font-bold tracking-tight text-zinc-900">{title}</h1>
        {dateStr ? <div className="mt-3 text-sm text-zinc-500">{dateStr}</div> : null}
        {excerpt ? <p className="mt-6 text-lg text-zinc-600">{excerpt}</p> : null}
        {body ? (
          <div className="prose prose-zinc mt-6 max-w-none whitespace-pre-wrap text-zinc-800">{body}</div>
        ) : null}
      </article>
    </main>
  )
}
