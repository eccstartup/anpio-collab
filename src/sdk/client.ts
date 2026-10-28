/**
 * 接入 SDK。
 *
 * 设计要点：
 *  - 不自动重试写请求。网络失败时结果为"未知"，调用方必须用同一个
 *    operationId 与同一个请求体重放，或先查询当前状态；
 *  - 所有方法都返回平台已校验过的结构，但调用方仍应把返回值当作不可信数据；
 *  - 只依赖 fetch，任何语言都可以照此实现协议，Node 客户端只是参考实现。
 */

export class CollabError extends Error {
  readonly status: number;
  readonly code: string;
  /** 写请求在传输层失败：请求可能已经生效，结果未知。 */
  readonly uncertain: boolean;

  constructor(message: string, options: { status?: number; code?: string; uncertain?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'CollabError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 'network';
    this.uncertain = options.uncertain ?? false;
  }
}

export type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  operationId?: string;
  expectedVersion?: number;
};

export type ClientOptions = { timeoutMs?: number };

export class CollabClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token: string, options: ClientOptions = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('期望不带凭据的 HTTP(S) 服务地址');
    }
    this.baseUrl = url.origin;
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('超时设置不合法');
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    if (path.startsWith('/') || path.includes('://') || path.includes('#')) {
      throw new Error('期望 /v1 之下的相对路径');
    }
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      if (!options.operationId) throw new Error('写请求需要 operationId');
      headers['idempotency-key'] = options.operationId;
    }
    if (options.expectedVersion !== undefined) headers['if-match'] = `"${options.expectedVersion}"`;

    let response: Response;
    try {
      response = await fetch(new URL(`/v1/${path}`, this.baseUrl), {
        method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new CollabError(
        method === 'POST'
          ? '写请求结果未知：请用同一 operationId 重放，或先查询当前状态'
          : '读请求失败',
        { uncertain: method === 'POST', cause: error },
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new CollabError(`服务返回了非 JSON 响应（HTTP ${response.status}）`, { status: response.status });
      }
    }
    if (!response.ok) {
      const detail = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new CollabError(detail?.message ?? `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        code: detail?.code ?? 'http_error',
      });
    }
    return payload as T;
  }

  // ------------------------------------------------------------ 身份与目录
  me() {
    return this.request<{ id: string; workspace: string; roles: string[]; displayName: string }>('me');
  }

  directory(capability?: string) {
    return this.request<unknown[]>(`principals${capability ? `?capability=${encodeURIComponent(capability)}` : ''}`);
  }

  registerPrincipal(input: { id: string; roles: string[]; token: string; displayName?: string; capabilities?: string[]; did?: string }, operationId: string) {
    return this.request('principals', { body: input, operationId });
  }

  deactivatePrincipal(id: string, operationId: string) {
    return this.request(`principals/${encodeURIComponent(id)}/deactivate`, { body: {}, operationId });
  }

  // ------------------------------------------------------------ 任务
  tasks(filters: { status?: string; q?: string } = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.q) params.set('q', filters.q);
    const suffix = params.size ? `?${params}` : '';
    return this.request<unknown[]>(`tasks${suffix}`);
  }

  tasksPage(limit = 20, offset = 0) {
    return this.request<{ items: unknown[]; nextOffset: number | null }>(`tasks/page?limit=${limit}&offset=${offset}`);
  }

  task(id: string) {
    return this.request(`tasks/${encodeURIComponent(id)}`);
  }

  context(id: string) {
    return this.request(`tasks/${encodeURIComponent(id)}/context`);
  }

  createTask(input: Record<string, unknown>, operationId: string) {
    return this.request('tasks', { body: input, operationId });
  }

  delegate(taskId: string, principal: string, operationId: string, expectedVersion?: number) {
    return this.request(`tasks/${encodeURIComponent(taskId)}/coordinators`, {
      body: { principal },
      operationId,
      expectedVersion,
    });
  }

  undelegate(taskId: string, principal: string, operationId: string, expectedVersion?: number) {
    return this.request(`tasks/${encodeURIComponent(taskId)}/remove-coordinator`, {
      body: { principal },
      operationId,
      expectedVersion,
    });
  }

  assign(taskId: string, input: { agent: string; kind: string; dependsOn?: string[]; dueAt?: string }, operationId: string, expectedVersion?: number) {
    return this.request(`tasks/${encodeURIComponent(taskId)}/assign`, { body: input, operationId, expectedVersion });
  }

  stageSummary(taskId: string, input: { text: string; pending: string }, operationId: string, expectedVersion?: number) {
    return this.request(`tasks/${encodeURIComponent(taskId)}/stage-summaries`, {
      body: input,
      operationId,
      expectedVersion,
    });
  }

  summary(taskId: string, text: string, operationId: string, expectedVersion?: number) {
    return this.request(`tasks/${encodeURIComponent(taskId)}/summary`, {
      body: { text },
      operationId,
      expectedVersion,
    });
  }

  review(taskId: string, decision: 'accept' | 'return', note: string, operationId: string, expectedVersion?: number) {
    return this.request(`tasks/${encodeURIComponent(taskId)}/review`, {
      body: { decision, note },
      operationId,
      expectedVersion,
    });
  }

  cancel(taskId: string, note: string, operationId: string, expectedVersion?: number) {
    return this.request(`tasks/${encodeURIComponent(taskId)}/cancel`, { body: { note }, operationId, expectedVersion });
  }

  // ------------------------------------------------------------ 子任务
  inbox() {
    return this.request<unknown[]>('inbox');
  }

  accept(subtaskId: string, operationId: string, expectedVersion?: number) {
    return this.request(`subtasks/${encodeURIComponent(subtaskId)}/accept`, {
      body: {},
      operationId,
      expectedVersion,
    });
  }

  reject(subtaskId: string, reason: string, operationId: string, expectedVersion?: number) {
    return this.request(`subtasks/${encodeURIComponent(subtaskId)}/reject`, {
      body: { reason },
      operationId,
      expectedVersion,
    });
  }

  submit(subtaskId: string, result: Record<string, unknown>, operationId: string, expectedVersion?: number) {
    return this.request(`subtasks/${encodeURIComponent(subtaskId)}/submit`, {
      body: { result },
      operationId,
      expectedVersion,
    });
  }

  progress(subtaskId: string, text: string, operationId: string, expectedVersion?: number) {
    return this.request(`subtasks/${encodeURIComponent(subtaskId)}/progress`, {
      body: { text },
      operationId,
      expectedVersion,
    });
  }

  outcomeUnknown(subtaskId: string, input: { reason: string; externalOperationId: string }, operationId: string, expectedVersion?: number) {
    return this.request(`subtasks/${encodeURIComponent(subtaskId)}/outcome-unknown`, {
      body: input,
      operationId,
      expectedVersion,
    });
  }

  timeoutSubtask(subtaskId: string, note: string, operationId: string, expectedVersion?: number) {
    return this.request(`subtasks/${encodeURIComponent(subtaskId)}/timeout`, {
      body: { note },
      operationId,
      expectedVersion,
    });
  }

  returnSubtask(subtaskId: string, note: string, operationId: string, expectedVersion?: number) {
    return this.request(`subtasks/${encodeURIComponent(subtaskId)}/return`, {
      body: { note },
      operationId,
      expectedVersion,
    });
  }

  notifications() {
    return this.request<unknown[]>('notifications');
  }

  acknowledge(notificationId: string, operationId: string) {
    return this.request(`notifications/${encodeURIComponent(notificationId)}/ack`, { body: {}, operationId });
  }

  // ------------------------------------------------------------ 知识
  knowledge(query = '') {
    return this.request<unknown[]>(`knowledge${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  }

  searchKnowledge(query: string, limit = 10, budget = 4000) {
    return this.request(`knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}&budget=${budget}`);
  }

  knowledgeEvidence(id: string) {
    return this.request(`knowledge/${encodeURIComponent(id)}/evidence`);
  }

  candidates() {
    return this.request<unknown[]>('knowledge/candidates');
  }

  versions(id: string) {
    return this.request<unknown[]>(`knowledge/${encodeURIComponent(id)}/versions`);
  }

  candidate(taskId: string, input: { content: string; conditions: string }, operationId: string) {
    return this.request(`tasks/${encodeURIComponent(taskId)}/knowledge`, { body: input, operationId });
  }

  publish(id: string, input: { expiresAt: string; audience?: 'workspace' | string[] }, operationId: string, expectedVersion?: number) {
    return this.request(`knowledge/${encodeURIComponent(id)}/publish`, { body: input, operationId, expectedVersion });
  }

  revoke(id: string, reason: string, operationId: string, expectedVersion?: number) {
    return this.request(`knowledge/${encodeURIComponent(id)}/revoke`, { body: { reason }, operationId, expectedVersion });
  }

  revise(id: string, input: { content: string; conditions: string; reason: string }, operationId: string, expectedVersion?: number) {
    return this.request(`knowledge/${encodeURIComponent(id)}/revise`, { body: input, operationId, expectedVersion });
  }

  setKnowledgeAccess(id: string, audience: 'workspace' | string[], operationId: string, expectedVersion?: number) {
    return this.request(`knowledge/${encodeURIComponent(id)}/access`, { body: { audience }, operationId, expectedVersion });
  }

  reference(taskId: string, knowledgeId: string, operationId: string, expectedVersion?: number) {
    return this.request(`tasks/${encodeURIComponent(taskId)}/references`, {
      body: { knowledgeId },
      operationId,
      expectedVersion,
    });
  }

  evidence(taskId: string, knowledgeId: string, version: number) {
    return this.request(
      `tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(knowledgeId)}/${version}`,
    );
  }

  // ------------------------------------------------------------ 运维
  expire() {
    return this.request<{ expired: number; checkedAt: string }>('maintenance/expire', {
      body: {},
      operationId: `maintenance:expire:${Date.now()}`,
    });
  }

  audit() {
    return this.request<unknown[]>('audit');
  }
}
