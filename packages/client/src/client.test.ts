import { describe, expect, it } from 'vitest'
import { createClient } from './index'

function captureFetch() {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('client.endpoint', () => {
  it('substitutes :params, appends query, and sends a JSON body', async () => {
    const { calls, fetchImpl } = captureFetch()
    const client = createClient({ baseURL: 'http://x', fetch: fetchImpl })
    const res = await client.endpoint<{ ok: boolean }>('POST', '/comments/:postId', {
      params: { postId: 'p1' },
      query: { preview: true },
      body: { text: 'hi' },
    })
    expect(res).toEqual({ ok: true })
    expect(calls[0]!.url).toBe('http://x/api/comments/p1?preview=true')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: 'hi' })
  })

  it('attaches the bearer token', async () => {
    const { calls, fetchImpl } = captureFetch()
    const client = createClient({ baseURL: 'http://x', token: 't0ken', fetch: fetchImpl })
    await client.endpoint('GET', '/me/profile')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer t0ken')
  })
})
