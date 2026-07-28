/** See ./index.ts header — this package is vendorable: zero deps, types duplicated. */

export interface NodoClientOptions {
  apiKey: string
  /** Default: https://webhook.usenodo.com */
  baseUrl?: string
  fetchFn?: typeof fetch
}

export interface ApiSendResponse {
  conversation_id: string
  message_id: string
  accepted_at: string
  deduplicated?: boolean
}

export interface ApiMessage {
  id: string
  conversation_id: string
  content: string | null
  direction: string
  sender_type: string
  external_message_id: string | null
  status: string
  media_url: string | null
  media_type: string | null
  created_at: string
}

export interface GetMessagesResponse {
  messages: ApiMessage[]
}

interface ApiErrorBody {
  error?: { code?: string; message?: string }
}

export class NodoApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'NodoApiError'
    this.status = status
    this.code = code
  }
}

const DEFAULT_BASE_URL = 'https://webhook.usenodo.com'

export class NodoClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch

  constructor(opts: NodoClientOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    // Bind explícito: guardar `fetch` suelto y llamarlo como this.fetchFn(...)
    // lanza "Illegal invocation" en workerd (Pages Functions/Workers).
    this.fetchFn = opts.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  }

  async sendMessage(args: {
    sessionId: string
    text: string
    clientMessageId?: string
  }): Promise<ApiSendResponse> {
    return this.request<ApiSendResponse>('POST', '/v1/messages', {
      session_id: args.sessionId,
      text: args.text,
      ...(args.clientMessageId ? { client_message_id: args.clientMessageId } : {}),
    })
  }

  async getMessages(
    conversationId: string,
    opts?: { since?: string; limit?: number },
  ): Promise<GetMessagesResponse> {
    const params = new URLSearchParams()
    if (opts?.since) params.set('since', opts.since)
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    const qs = params.size > 0 ? `?${params.toString()}` : ''
    return this.request<GetMessagesResponse>(
      'GET',
      `/v1/conversations/${conversationId}/messages${qs}`,
    )
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    if (!res.ok) {
      let code = 'internal_error'
      let message = `HTTP ${res.status}`
      try {
        const parsed = (await res.json()) as ApiErrorBody
        if (parsed.error?.code) code = parsed.error.code
        if (parsed.error?.message) message = parsed.error.message
      } catch {
        // non-JSON error body — keep the fallback envelope
      }
      throw new NodoApiError(res.status, code, message)
    }

    return (await res.json()) as T
  }
}
