import { test, expect } from '@playwright/test'

// In-practice test of the knowledge graph + GraphRAG against the LIVE server:
// relate two articles, then traverse the graph and run a graph-search over HTTP.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('graph traversal returns connected nodes + edges over the live server', async ({ request }) => {
  // Two articles, A relates to B.
  const b = await request.post('/api/articles', { headers: AUTH, data: { title: 'Target node', _status: 'published' } })
  const bId = (await b.json()).id
  const a = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Source node', related: [bId], _status: 'published' },
  })
  const aId = (await a.json()).id

  const res = await request.get(`/api/articles/${aId}/graph?depth=1`, { headers: AUTH })
  expect(res.ok()).toBeTruthy()
  const g = await res.json()
  const refs = g.nodes.map((n: { ref: string }) => n.ref)
  expect(refs).toContain(`articles:${aId}`)
  expect(refs).toContain(`articles:${bId}`)
  // An edge from A to B via the `related` field.
  const edge = g.edges.find(
    (e: { from: string; to: string }) => e.from === `articles:${aId}` && e.to === `articles:${bId}`,
  )
  expect(edge).toBeTruthy()
  expect(edge.field).toBe('related')
})

test('graph-search returns semantic seeds with their connected context', async ({ request }) => {
  // Seed a recognizable topic.
  await request.post('/api/articles', {
    headers: AUTH,
    data: {
      title: 'Quantum computing primer',
      summary: 'qubits superposition entanglement quantum',
      _status: 'published',
    },
  })
  const res = await request.get(
    '/api/graph-search?q=' + encodeURIComponent('quantum qubits') + '&collection=articles&limit=3',
    { headers: AUTH },
  )
  expect(res.ok()).toBeTruthy()
  const g = await res.json()
  expect(Array.isArray(g.seeds)).toBeTruthy()
  expect(g.seeds.length).toBeGreaterThan(0)
  expect(g.seeds.some((s: { title: string }) => s.title === 'Quantum computing primer')).toBeTruthy()
  // context array is present for grounding an LLM.
  expect(Array.isArray(g.context)).toBeTruthy()
})
