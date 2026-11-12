import axios, { type AxiosInstance } from 'axios'

export interface HttpRequest {
  url: string
  method?: 'GET' | 'HEAD' | 'POST'
  headers?: Record<string, string>
  params?: Record<string, string | number | boolean>
  data?: unknown
  responseType?: 'json' | 'text' | 'arraybuffer'
  signal?: AbortSignal
}

export interface HttpResponse<T> {
  /** JSON syntax is checked; feed adapters must still validate their own schemas. */
  data: T
  status: number
  headers: Record<string, string>
}

export interface RateLimit {
  maxRequests: number
  windowMs: number
}

export interface HttpClientOptions {
  rateLimit?: RateLimit
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Overall deadline, including rate-limit/backoff waits. Default: 120 seconds. */
  timeoutMs?: number
  /** Per-network-attempt timeout. Default: 30 seconds. */
  attemptTimeoutMs?: number
  maxResponseBytes?: number
  maxRequestBytes?: number
}

export type HttpErrorCode = 'HTTP_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED'
  | 'INVALID_REQUEST' | 'INVALID_RESPONSE'

/** Deliberately contains no Axios cause/config, URL, headers or response body. */
export class HttpClientError extends Error {
  constructor(
    readonly code: HttpErrorCode,
    readonly attempts: number,
    readonly status?: number
  ) {
    super(status === undefined ? `HTTP request failed: ${code}` : `HTTP request failed: ${status}`)
    this.name = 'HttpClientError'
  }
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const RETRY_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
  'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_NETWORK'])

function retryAfterMs(value: unknown): number {
  if (typeof value !== 'string') return 0
  const text = value.trim()
  const delay = /^\d+$/.test(text) ? Number(text) * 1_000
    : /^[A-Za-z]{3}, /.test(text) ? Date.parse(text) - Date.now() : NaN
  return Number.isFinite(delay) ? Math.max(0, delay) : 0
}

function checkAborted(signal: AbortSignal | undefined, attempts: number): void {
  if (signal?.aborted) throw new HttpClientError('ABORTED', attempts)
}

function wait(ms: number, signal: AbortSignal | undefined, attempts: number): Promise<void> {
  checkAborted(signal, attempts)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new HttpClientError('ABORTED', attempts))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.min(Math.ceil(ms), 2_147_483_647))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Project policy; select the authenticated budget only when an API key is present.
export const NVD_RATE_LIMITS = {
  anonymous: { maxRequests: 5, windowMs: 30_000 },
  authenticated: { maxRequests: 50, windowMs: 30_000 }
} as const

/** Main-process network access. Keep one instance per source/credential scope and
 * share it across concurrent calls. Creating an instance per call bypasses its budget.
 * Redirects are rejected. GET/HEAD may retry; POST is never automatically repeated.
 * The optional transport is the external HTTP seam used by deterministic tests. */
export class HttpClient {
  private readonly rateLimit: RateLimit
  private readonly maxRetries: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly timeoutMs: number
  private readonly attemptTimeoutMs: number
  private readonly maxResponseBytes: number
  private readonly maxRequestBytes: number
  private starts: number[] = []
  private cooldownUntil = 0

  constructor(
    options: HttpClientOptions = {},
    private readonly transport: AxiosInstance = axios.create({ adapter: 'http' })
  ) {
    this.rateLimit = { ...(options.rateLimit ?? NVD_RATE_LIMITS.anonymous) }
    this.maxRetries = options.maxRetries ?? 3
    this.baseDelayMs = options.baseDelayMs ?? 1_000
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 30_000
    this.maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024
    this.maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024
    const positiveIntegers = [this.rateLimit.maxRequests, this.rateLimit.windowMs,
      this.baseDelayMs, this.maxDelayMs, this.timeoutMs, this.attemptTimeoutMs,
      this.maxResponseBytes, this.maxRequestBytes]
    if (positiveIntegers.some((value) => !Number.isSafeInteger(value) || value <= 0
      || value > 2_147_483_647) || !Number.isSafeInteger(this.maxRetries)
      || this.maxRetries < 0 || this.maxRetries > 10 || this.maxDelayMs < this.baseDelayMs) {
      throw new RangeError('Invalid HTTP client policy')
    }
  }

  private async acquire(signal: AbortSignal | undefined, attempts: number): Promise<void> {
    while (true) {
      checkAborted(signal, attempts)
      const now = performance.now()
      this.starts = this.starts.filter((start) => now - start < this.rateLimit.windowMs)
      let delay = Math.max(0, this.cooldownUntil - now)
      if (this.starts.length >= this.rateLimit.maxRequests) {
        delay = Math.max(delay, this.starts[0] + this.rateLimit.windowMs - now)
      }
      if (delay <= 0) {
        this.starts.push(now)
        return
      }
      await wait(delay, signal, attempts)
    }
  }

  async request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    checkAborted(request.signal, 0)
    try {
      const url = new URL(request.url)
      if (!/^https?:\/\//i.test(request.url) || !['http:', 'https:'].includes(url.protocol)
        || url.username || url.password) throw new Error()
    } catch {
      throw new HttpClientError('INVALID_REQUEST', 0)
    }
    const controller = new AbortController()
    let expired = false
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, this.timeoutMs)
    try {
      return await this.execute<T>(request, controller.signal)
    } catch (error) {
      if (expired) {
        throw new HttpClientError('TIMEOUT', error instanceof HttpClientError ? error.attempts : 0)
      }
      throw error
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  private async execute<T>(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      await this.acquire(signal, attempt)
      checkAborted(signal, attempt)
      let failure: HttpClientError
      let retryable = false
      try {
        const response = await this.transport.request<T>({
          url: request.url,
          method: request.method,
          headers: request.headers,
          params: request.params,
          data: request.data,
          signal,
          responseType: request.responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
          timeout: this.attemptTimeoutMs, maxRedirects: 0, maxContentLength: this.maxResponseBytes,
          maxBodyLength: this.maxRequestBytes,
          validateStatus: () => true
        })
        const headers = Object.fromEntries(Object.entries(response.headers)
          .map(([key, value]) => [key.toLowerCase(), String(value)]))
        if ((response.status >= 200 && response.status < 300) || response.status === 304) {
          let data = response.data
          if ((request.responseType ?? 'json') === 'json' && typeof data === 'string'
            && data.length > 0 && response.status !== 304) {
            try {
              data = JSON.parse(data) as T
            } catch {
              throw new HttpClientError('INVALID_RESPONSE', attempt + 1)
            }
          }
          return { data, status: response.status, headers }
        }
        failure = new HttpClientError('HTTP_ERROR', attempt + 1, response.status)
        retryable = RETRY_STATUSES.has(response.status)
        if (retryable) {
          this.cooldownUntil = Math.max(this.cooldownUntil, performance.now()
            + retryAfterMs(headers['retry-after']))
        }
      } catch (error) {
        if (error instanceof HttpClientError) throw error
        if (signal.aborted || axios.isCancel(error)) {
          throw new HttpClientError('ABORTED', attempt + 1)
        }
        const code = axios.isAxiosError(error) ? error.code : undefined
        failure = new HttpClientError(code === 'ETIMEDOUT' || code === 'ECONNABORTED'
          ? 'TIMEOUT' : code === 'ERR_BAD_RESPONSE' ? 'INVALID_RESPONSE'
            : code === 'ERR_BAD_REQUEST' ? 'INVALID_REQUEST' : 'NETWORK_ERROR', attempt + 1)
        retryable = code !== undefined && RETRY_CODES.has(code)
      }
      if (request.method === 'POST' || !retryable || attempt >= this.maxRetries) throw failure
      const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt)
      await wait(ceiling * (0.5 + Math.random() * 0.5), signal, attempt + 1)
    }
  }
}
