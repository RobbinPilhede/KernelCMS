import { Link, createFileRoute } from '@tanstack/react-router'
import { getPost } from '../server/cms'

export const Route = createFileRoute('/posts/$slug')({
  loader: async ({ params }) => ({ post: await getPost({ data: params.slug }) }),
  component: PostPage,
})

function PostPage() {
  const { post } = Route.useLoaderData()

  if (!post) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-zinc-500">Post not found.</p>
        <Link to="/" className="text-indigo-600 hover:underline">
          ← Back to all posts
        </Link>
      </main>
    )
  }

  const author = post.author as { name?: string } | string | null
  const categories = (post.categories as Array<{ name?: string }>) ?? []
  const published = post.published_at ? new Date(String(post.published_at)).toLocaleDateString() : null

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link to="/" className="text-sm text-indigo-600 hover:underline">
        ← All posts
      </Link>
      <article className="mt-6">
        <h1 className="text-4xl font-bold tracking-tight text-zinc-900">{String(post.title)}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
          {author && typeof author === 'object' && <span>By {author.name}</span>}
          {published && <span>· {published}</span>}
          {categories.map((c) => (
            <span key={c.name} className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
              {c.name}
            </span>
          ))}
        </div>
        {post.excerpt ? <p className="mt-6 text-lg text-zinc-600">{String(post.excerpt)}</p> : null}
        <div className="prose prose-zinc mt-6 max-w-none whitespace-pre-wrap text-zinc-800">{String(post.body ?? '')}</div>
      </article>
    </main>
  )
}
