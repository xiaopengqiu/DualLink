export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}

export class ApiClient {
  private csrfToken = '';
  private sessionGeneration = 0;
  setCsrfToken(token: string) {
    if (this.csrfToken !== token) this.sessionGeneration++;
    this.csrfToken = token;
  }
  async request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const generation = this.sessionGeneration;
    const assertCurrentSession = () => {
      if (generation !== this.sessionGeneration || options.signal?.aborted) throw new DOMException('The account session changed while the request was in flight', 'AbortError');
    };
    const method = options.method || 'GET';
    const headers: Record<string, string> = {};
    const isForm = options.body instanceof FormData;
    if (options.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD'].includes(method) && this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    let response: Response;
    try {
      response = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', signal: options.signal, body: options.body === undefined ? undefined : isForm ? options.body as FormData : JSON.stringify(options.body) });
    } catch (error) {
      assertCurrentSession();
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError('无法连接云端服务，请检查网络后重试', 0);
    }
    assertCurrentSession();
    // Reverse proxies can return HTML/plain text instead of JSON.
    const text = await response.text();
    assertCurrentSession();
    let data: Record<string, unknown> = {};
    let invalidJson = false;
    if (text) {
      try { data = JSON.parse(text) as Record<string, unknown>; }
      catch { invalidJson = true; data = { error: text.trim() }; }
    }
    assertCurrentSession();
    if (response.ok && (invalidJson || data === null || typeof data !== 'object' || Array.isArray(data))) {
      throw new ApiError(`接口 ${path} 返回无效响应（${response.status}）`, response.status);
    }
    if (!response.ok) {
      const serverMessage = data && typeof data === 'object' && !Array.isArray(data) && typeof data.error === 'string' ? data.error.trim() : '';
      const safeMessage = serverMessage && !/<(?:html|body|script)\b/i.test(serverMessage) ? serverMessage.slice(0, 240) : '';
      throw new ApiError(safeMessage || `请求 ${path} 失败（${response.status}）`, response.status, data && typeof data === 'object' && !Array.isArray(data) && typeof data.code === 'string' ? data.code : undefined);
    }
    return data as T;
  }
}
export const api = new ApiClient();
