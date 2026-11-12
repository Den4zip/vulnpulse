import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpClient, HttpClientError, NVD_RATE_LIMITS } from '@main/services/httpclient'

function reply(config: InternalAxiosRequestConfig, data: unknown = {}, status = 200,
  headers: Record<string, string> = {}) {
  return { config, data, status, headers, statusText: '' }
}

const servers: Server[] = []
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No server address')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('HttpClient.request', () => {
  it('returns feed data, status and headers without exposing request configuration', async () => {
    const adapter: AxiosAdapter = async (config) => ({
      data: { vulnerabilities: ['CVE-2026-0001'] },
      status: 200,
      statusText: 'OK',
      headers: { etag: 'snapshot-1' },
      config
    })
    const client = new HttpClient({}, axios.create({ adapter }))

    expect(await client.request<{ vulnerabilities: string[] }>({
      url: 'https://example.org/feed',
      headers: { apiKey: 'private-key' }
    })).toEqual({
      data: { vulnerabilities: ['CVE-2026-0001'] },
      status: 200,
      headers: { etag: 'snapshot-1' }
    })
  })

  it('shares a rolling request budget across concurrent calls', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const adapter: AxiosAdapter = async (config) => reply(config, Date.now())
    const client = new HttpClient({ rateLimit: { maxRequests: 2, windowMs: 1_000 } },
      axios.create({ adapter }))
    const completed: number[] = []
    const pending = Promise.all(Array.from({ length: 5 }, () =>
      client.request<number>({ url: 'https://example.org/feed' })
        .then(({ data }) => completed.push(data))))

    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toEqual([0, 0])
    await vi.advanceTimersByTimeAsync(999)
    expect(completed).toEqual([0, 0])
    await vi.advanceTimersByTimeAsync(1)
    expect(completed).toEqual([0, 0, 1_000, 1_000])
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    expect(completed).toEqual([0, 0, 1_000, 1_000, 2_000])
  })

  it('retries temporary HTTP and connection failures with exponential backoff', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let attempts = 0
    const adapter: AxiosAdapter = async (config) => {
      attempts++
      if (attempts === 1) return reply(config, {}, 503)
      if (attempts === 2) throw new AxiosError('socket reset', 'ECONNRESET', config)
      return reply(config, { attempts, at: Date.now() })
    }
    const client = new HttpClient({ maxRetries: 2, baseDelayMs: 100 }, axios.create({ adapter }))
    const pending = client.request({ url: 'https://example.org/feed' })
    await vi.advanceTimersByTimeAsync(150)
    expect((await pending).data).toEqual({ attempts: 3, at: 150 })
  })

  it.each(['2', 'Thu, 01 Jan 1970 00:00:02 GMT'])(
    'honors Retry-After %s for retries and concurrent requests', async (retryAfter) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      let calls = 0
      const adapter: AxiosAdapter = async (config) => ++calls === 1
        ? reply(config, {}, 429, { 'retry-after': retryAfter })
        : reply(config, Date.now())
      const client = new HttpClient({ maxRetries: 1, baseDelayMs: 10, maxDelayMs: 10 },
        axios.create({ adapter }))
      const completed: number[] = []
      const first = client.request<number>({ url: 'https://example.org/feed' })
        .then(({ data }) => completed.push(data))
      await vi.advanceTimersByTimeAsync(0)
      const second = client.request<number>({ url: 'https://example.org/feed' })
        .then(({ data }) => completed.push(data))
      await vi.advanceTimersByTimeAsync(1_999)
      expect(completed).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await Promise.all([first, second])
      expect(completed).toEqual([2_000, 2_000])
    })

  it('cancels a queued request immediately without consuming a later request slot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const adapter: AxiosAdapter = async (config) => reply(config, Date.now())
    const client = new HttpClient({ rateLimit: { maxRequests: 1, windowMs: 1_000 } },
      axios.create({ adapter }))
    await client.request({ url: 'https://example.org/feed' })
    const controller = new AbortController()
    let failure: unknown
    const cancelled = client.request({ url: 'https://example.org/feed', signal: controller.signal })
      .catch((error) => { failure = error })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort('a private cancellation reason')
    await vi.advanceTimersByTimeAsync(0)
    expect(failure).toMatchObject({ code: 'ABORTED', attempts: 0 })
    await cancelled
    const next = client.request({ url: 'https://example.org/feed' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await next).data).toBe(1_000)
  })

  it('bounds the entire request including a very long Retry-After wait', async () => {
    vi.useFakeTimers()
    const adapter: AxiosAdapter = async (config) =>
      reply(config, {}, 503, { 'retry-after': '99999999999' })
    const client = new HttpClient({ timeoutMs: 100 }, axios.create({ adapter }))
    let failure: unknown
    const pending = client.request({ url: 'https://example.org/feed' })
      .catch((error) => { failure = error })
    await vi.advanceTimersByTimeAsync(99)
    expect(failure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(failure).toMatchObject({ code: 'TIMEOUT', attempts: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not automatically repeat POST requests', async () => {
    const adapter: AxiosAdapter = async (config) => reply(config, {}, 503)
    const client = new HttpClient({ maxRetries: 1, baseDelayMs: 1 }, axios.create({ adapter }))
    await expect(client.request({ url: 'https://example.org/feed', method: 'POST', data: {} }))
      .rejects.toMatchObject({ code: 'HTTP_ERROR', status: 503, attempts: 1 })
  })

  it.each([
    { rateLimit: { maxRequests: 0, windowMs: 1_000 } },
    { rateLimit: { maxRequests: 1, windowMs: Infinity } },
    { maxRetries: -1 },
    { maxRetries: 1.5 },
    { baseDelayMs: 0 },
    { baseDelayMs: 100, maxDelayMs: 50 },
    { timeoutMs: 0 },
    { attemptTimeoutMs: NaN }
  ])('rejects invalid scheduling settings: %j', (options) => {
    expect(() => new HttpClient(options)).toThrow(RangeError)
  })

  it.each(['redirect', 'oversized', 'invalid-json'])(
    'rejects unsafe response: %s through the real HTTP adapter', async (scenario) => {
      const url = await serve((request, response) => {
        if (scenario === 'redirect' && request.url !== '/target') {
          response.writeHead(302, { location: '/target' }).end()
        } else {
          response.end(scenario === 'oversized' ? 'x'.repeat(32)
            : scenario === 'invalid-json' ? '{broken' : '{}')
        }
      })
      const client = new HttpClient({ maxRetries: 0, maxResponseBytes: 16 })
      await expect(client.request({ url })).rejects.toMatchObject({
        code: scenario === 'redirect' ? 'HTTP_ERROR' : 'INVALID_RESPONSE', attempts: 1
      })
    })

  it('retries temporary HTML error pages before parsing the successful JSON response', async () => {
    let calls = 0
    const url = await serve((_request, response) => {
      if (++calls === 1) response.writeHead(503, { 'retry-after': '0' }).end('<html>busy</html>')
      else response.end('{"ready":true}')
    })
    const client = new HttpClient({ maxRetries: 1, baseDelayMs: 1 })
    expect((await client.request({ url })).data).toEqual({ ready: true })
  })

  it.each(['file:///secret', '/relative', 'https:example.org', 'https://',
    'https://name:password@example.org/feed'])(
    'rejects invalid or credential-bearing URLs before sending: %s', async (url) => {
      const adapter: AxiosAdapter = async (config) => reply(config)
      const client = new HttpClient({}, axios.create({ adapter }))
      await expect(client.request({ url })).rejects.toMatchObject({ code: 'INVALID_REQUEST', attempts: 0 })
    })

  it.each([400, 401, 403, 404, 501])('does not retry permanent HTTP status %s', async (status) => {
    const adapter: AxiosAdapter = async (config) => reply(config, 'private response', status)
    const client = new HttpClient({}, axios.create({ adapter }))
    await expect(client.request({ url: 'https://example.org/feed' }))
      .rejects.toMatchObject({ code: 'HTTP_ERROR', status, attempts: 1 })
  })

  it.each(['ECONNABORTED', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', undefined])(
    'returns a safe error for transport failure %s', async (code) => {
      const adapter: AxiosAdapter = async (config) => {
        throw code === undefined ? new Error('secret-body')
          : new AxiosError('secret-body secret-token', code, config)
      }
      const client = new HttpClient({ maxRetries: 0 }, axios.create({ adapter }))
      const error = await client.request({
        url: 'https://example.org/feed?key=secret-token', headers: { apiKey: 'secret-token' },
        method: 'POST', data: { key: 'secret-body' }
      }).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(HttpClientError)
      expect(error).toMatchObject({ code: code === 'ECONNABORTED' || code === 'ETIMEDOUT'
        ? 'TIMEOUT' : 'NETWORK_ERROR', attempts: 1 })
      expect(JSON.stringify(error) + String(error)).not.toContain('secret-')
      expect(error).not.toHaveProperty('cause')
      expect(error).not.toHaveProperty('config')
    })

  it('preserves conditional requests and exposes 304/ETag through the HTTP adapter', async () => {
    const url = await serve((request, response) => {
      if (request.headers['if-none-match'] === 'snapshot-1') {
        response.writeHead(304, { etag: 'snapshot-1' }).end()
      } else response.end('{}')
    })
    expect(await new HttpClient().request({ url, headers: { 'If-None-Match': 'snapshot-1' } }))
      .toMatchObject({ status: 304, data: '', headers: { etag: 'snapshot-1' } })
  })

  it.each(['text', 'arraybuffer'] as const)('supports %s for non-JSON feed downloads', async (responseType) => {
    const url = await serve((_request, response) => response.end('<feed/>'))
    const result = await new HttpClient().request<string | Buffer>({ url, responseType })
    expect(result.data.toString()).toBe('<feed/>')
  })

  it('times out a stalled active connection', async () => {
    const url = await serve(() => {})
    await expect(new HttpClient({ attemptTimeoutMs: 30, maxRetries: 0 }).request({ url }))
      .rejects.toMatchObject({ code: 'TIMEOUT', attempts: 1 })
  })

  it('cancels a request while the HTTP connection is active', async () => {
    const controller = new AbortController()
    const url = await serve(() => controller.abort('secret-reason'))
    await expect(new HttpClient().request({ url, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED', attempts: 1 })
  })

  it('rejects already cancelled requests without starting the transport', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(new HttpClient().request({ url: 'https://example.org/feed', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED', attempts: 0 })
  })

  it('cancels during backoff and clears all request timers', async () => {
    vi.useFakeTimers()
    const adapter: AxiosAdapter = async (config) => reply(config, {}, 503)
    const controller = new AbortController()
    const client = new HttpClient({}, axios.create({ adapter }))
    const pending = client.request({ url: 'https://example.org/feed', signal: controller.signal })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await pending).toMatchObject({ code: 'ABORTED', attempts: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts retries against the same rolling rate limit', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let calls = 0
    const adapter: AxiosAdapter = async (config) => ++calls === 1
      ? reply(config, {}, 503) : reply(config, Date.now())
    const client = new HttpClient({ baseDelayMs: 1, rateLimit: { maxRequests: 1, windowMs: 1_000 } },
      axios.create({ adapter }))
    const pending = client.request({ url: 'https://example.org/feed' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await pending).data).toBe(1_000)
  })

  it.each([NVD_RATE_LIMITS.anonymous, NVD_RATE_LIMITS.authenticated])(
    'enforces the configured NVD budget %j', async (rateLimit) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const adapter: AxiosAdapter = async (config) => reply(config, Date.now())
      const client = new HttpClient({ rateLimit }, axios.create({ adapter }))
      const pending = Array.from({ length: rateLimit.maxRequests }, () =>
        client.request({ url: 'https://example.org/feed' }))
      expect((await Promise.all(pending)).every(({ data }) => data === 0)).toBe(true)
      const next = client.request({ url: 'https://example.org/feed' })
      await vi.advanceTimersByTimeAsync(30_000)
      expect((await next).data).toBe(30_000)
    })

  it.each(['invalid', '-1', '0.5', 'Thu, not-a-date', '9'.repeat(400), 'Thu, 01 Jan 1970 00:00:00 GMT'])(
    'falls back to bounded backoff for unusable Retry-After %s', async (retryAfter) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      vi.spyOn(Math, 'random').mockReturnValue(0)
      let calls = 0
      const adapter: AxiosAdapter = async (config) => ++calls === 1
        ? reply(config, {}, 503, { 'retry-after': retryAfter }) : reply(config, Date.now())
      const client = new HttpClient({ baseDelayMs: 100 }, axios.create({ adapter }))
      const pending = client.request({ url: 'https://example.org/feed' })
      await vi.advanceTimersByTimeAsync(50)
      expect((await pending).data).toBe(1_050)
    })

  it('bounds outgoing POST bodies through the real HTTP adapter', async () => {
    const url = await serve((_request, response) => response.end('{}'))
    await expect(new HttpClient({ maxRequestBytes: 8 }).request({ url, method: 'POST', data: 'x'.repeat(32) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', attempts: 1 })
  })
})
