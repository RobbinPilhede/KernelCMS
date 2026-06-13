import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of the RAG-native search feature against the LIVE dev server:
// seed topically-distinct articles over real HTTP, then drive the actual
// /semantic and /hybrid endpoints and assert real ranking + access behaviour.
// (The demo config wires a deterministic bag-of-words embedder; a production app
// plugs in OpenAI/Cohere/local. This proves the end-to-end pipeline, not embed
// quality.)

const HEADERS = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

const SEED = [
  { title: 'Caring for your house cat', summary: 'cat kitten feline grooming litter vet care pet' },
  { title: 'Adopting a rescue kitten', summary: 'kitten cat feline shelter adoption pet care vaccination' },
  { title: 'Rebuilding a diesel engine', summary: 'car automobile engine diesel piston repair garage motor' },
  { title: 'Sourdough bread basics', summary: 'bread sourdough flour yeast baking oven dough loaf' },
]

async function seed(request: APIRequestContext) {
  for (const data of SEED) {
    const res = await request.post('/api/articles', { headers: HEADERS, data: { ...data, _status: 'published' } })
    expect(res.ok(), `seed "${data.title}"`).toBeTruthy()
  }
}

const titles = (body: { docs: Array<{ title: string }> }) => body.docs.map((d) => d.title)

test('semantic search ranks topically-related content first over the live server', async ({ request }) => {
  await seed(request)

  // A query that shares the "cat/kitten/feline pet care" vocabulary — the two cat
  // articles should surface ahead of the engine and bread ones.
  const res = await request.get(
    '/api/articles/semantic?q=' + encodeURIComponent('feline pet care for my cat') + '&limit=3',
  )
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  const ranked = titles(body)

  // Both cat-topic articles rank above the unrelated diesel-engine one.
  const catTop = ranked.indexOf('Caring for your house cat')
  const kittenTop = ranked.indexOf('Adopting a rescue kitten')
  const engine = ranked.indexOf('Rebuilding a diesel engine')
  expect(catTop, 'cat article present').toBeGreaterThanOrEqual(0)
  expect(kittenTop, 'kitten article present').toBeGreaterThanOrEqual(0)
  // The diesel article either ranks last or is pushed out of the top-3 entirely.
  expect(engine === -1 || (engine > catTop && engine > kittenTop)).toBeTruthy()
})

test('hybrid search fuses keyword + semantic over the live server', async ({ request }) => {
  await seed(request)

  // "engine" is a strong lexical + semantic hit for the diesel article.
  const res = await request.get('/api/articles/hybrid?q=' + encodeURIComponent('diesel engine repair') + '&limit=3')
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  const ranked = titles(body)
  expect(ranked.length).toBeGreaterThan(0)
  expect(ranked[0]).toBe('Rebuilding a diesel engine')
})

test('semantic search returns no results for an empty query (no crash)', async ({ request }) => {
  const res = await request.get('/api/articles/semantic?q=')
  expect(res.ok()).toBeTruthy()
  expect((await res.json()).docs).toEqual([])
})
