/**
 * 接入 SDK。
 *
 * 设计要点：
 *  - 不自动重试写请求。网络失败时结果为"未知"，调用方必须用同一个
 *    operationId 与同一个请求体重放，或先查询当前状态；
 *  - 所有方法都返回平台已校验过的结构，但调用方仍应把返回值当作不可信数据；
 *  - 只依赖 fetch，任何语言都可以照此实现协议，Node 客户端只是参考实现。
 */

import type {
  ActivityItem,
  AuditEntry,
  AuditReport,
  Evidence,
  InboxItem,
  KnowledgeSearch,
  KnowledgeSummary,
  MailEnvelope,
  MailMessage,
  MailSession,
  MailSubscription,
  MaterialContent,
  MaterialMeta,
  MessageKind,
  NotificationView,
  PrincipalView,
  RetentionResult,
  SpaceFile,
  StatusChange,
  SubtaskRef,
  TaskComment,
  TaskContext,
  TaskDetail,
  TaskListItem,
  TaskParticipantView,
  TaskRef,
  TaskRequestView,
  TaskRoom,
  TaskThread,
} from './types.ts';

export type {
  ActivityItem,
  AuditEntry,
  AuditReport,
  Evidence,
  InboxItem,
  KnowledgeSearch,
  KnowledgeSummary,
  MailEnvelope,
  MailMessage,
  MailSession,
  MailSubscription,
  MaterialContent,
  MaterialMeta,
  MessageKind,
  NotificationView,
  PrincipalView,
  RetentionResult,
  SpaceFile,
  StatusChange,
  SubtaskRef,
  TaskComment,
  TaskContext,
  TaskDetail,
  TaskListItem,
  TaskParticipantView,
  TaskRef,
  TaskRequestView,
  TaskRoom,
  TaskThread,
};

export type UploadSession = {
  id: string;
  storage: 'fs' | 's3';
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type ContextPack = { markdown: string; manifest: Record<string, unknown> };

export type SpaceHome = {
  totals: { questions: number; mentions: number; reviews: number; proposals: number };
  needsYou: {
    taskId: string;
    taskTitle: string;
    kind: 'question' | 'mention' | 'review' | 'proposal';
    id: string;
    title: string;
    at: string;
  }[];
  generatedAt: string;
};

export type SpaceSearch = {
  query: string;
  messages: (TaskComment & { taskTitle: string })[];
  files: (SpaceFile & { taskTitle: string | null })[];
  knowledge: { id: string; title: string; summary: string; kind: string; version: number; state: string }[];
};

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
    return this.request<{
      id: string;
      workspace: string;
      roles: string[];
      did: string | null;
      kind: string;
      handle: string | null;
      displayName: string;
      capabilities: string[];
    }>('me');
  }

  logout(operationId = `logout:${Date.now()}`) {
    return this.request<{ ok: true }>('me/logout', { body: {}, operationId });
  }

  identities() {
    return this.request<{ id: string; did: string; client: string; lastLoginAt: string | null; loginCount: number }[]>(
      'me/identities',
    );
  }

  inviteIdentity(input: { role?: string; note?: string; expiresInHours?: number }, operationId: string) {
    return this.request<{ code: string; role: string; expiresAt: string }>('me/identities/invite', {
      body: input,
      operationId,
    });
  }

  revokeIdentity(id: string, operationId: string) {
    return this.request<{ id: string; revoked: true }>(`me/identities/${encodeURIComponent(id)}/revoke`, {
      body: {},
      operationId,
    });
  }

  sessions() {
    return this.request<{ id: string; did: string; client: string; expiresAt: string; active: boolean }[]>('me/sessions');
  }

  revokeSession(id: string, operationId: string) {
    return this.request<{ id: string; revoked: true }>(`me/sessions/${encodeURIComponent(id)}/revoke`, {
      body: {},
      operationId,
    });
  }

  mentions() {
    return this.request<{ id: string; mentionId: string; taskId: string; taskTitle?: string; body: string; authorName: string }[]>('me/mentions');
  }

  readMention(id: string, operationId: string) {
    return this.request<{ id: string; read: true }>(`me/mentions/${encodeURIComponent(id)}/read`, {
      body: {},
      operationId,
    });
  }

  pendingPrincipals() {
    return this.request<PrincipalView[]>('principals/pending');
  }

  activatePrincipal(id: string, operationId: string) {
    return this.request<{ id: string; active: true }>(`principals/${encodeURIComponent(id)}/activate`, {
      body: {},
      operationId,
    });
  }

  setRoles(id: string, roles: string[], operationId: string) {
    return this.request<PrincipalView>(`principals/${encodeURIComponent(id)}/roles`, {
      body: { roles },
      operationId,
    });
  }

  directory(capability?: string) {
    return this.request<PrincipalView[]>(
      `principals${capability ? `?capability=${encodeURIComponent(capability)}` : ''}`,
    );
  }

  registerPrincipal(input: { id: string; roles: string[]; token: string; displayName?: string; capabilities?: string[]; did?: string; kind?: string }, operationId: string) {
    return this.request<PrincipalView>('principals', { body: input, operationId });
  }

  deactivatePrincipal(id: string, operationId: string) {
    return this.request<{ id: string; active: false }>(`principals/${encodeURIComponent(id)}/deactivate`, {
      body: {},
      operationId,
    });
  }

  // ------------------------------------------------------------ 任务
  tasks(filters: { status?: string; q?: string; includeArchived?: boolean } = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.q) params.set('q', filters.q);
    if (filters.includeArchived) params.set('includeArchived', '1');
    const suffix = params.size ? `?${params}` : '';
    return this.request<TaskListItem[]>(`tasks${suffix}`);
  }

  tasksPage(limit = 20, offset = 0) {
    return this.request<{ items: TaskListItem[]; nextOffset: number | null }>(
      `tasks/page?limit=${limit}&offset=${offset}`,
    );
  }

  activity(limit = 30) {
    return this.request<ActivityItem[]>(`activity?limit=${limit}`);
  }

  task(id: string) {
    return this.request<TaskDetail>(`tasks/${encodeURIComponent(id)}`);
  }

  context(id: string) {
    return this.request<TaskContext>(`tasks/${encodeURIComponent(id)}/context`);
  }

  // ------------------------------------------------------------ 房间与文件
  room(taskId: string) {
    return this.request<TaskRoom>(`tasks/${encodeURIComponent(taskId)}/room`);
  }

  messages(taskId: string, filters: { threadId?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (filters.threadId) params.set('threadId', filters.threadId);
    if (filters.limit) params.set('limit', String(filters.limit));
    const suffix = params.size ? `?${params}` : '';
    return this.request<TaskComment[]>(`tasks/${encodeURIComponent(taskId)}/messages${suffix}`);
  }

  sendMessage(
    taskId: string,
    input: {
      body: string;
      kind?: MessageKind;
      threadId?: string;
      replyTo?: string;
      payload?: Record<string, unknown>;
      fileIds?: string[];
    },
    operationId: string,
  ) {
    return this.request<TaskComment>(`tasks/${encodeURIComponent(taskId)}/messages`, {
      body: input,
      operationId,
    });
  }

  threads(taskId: string) {
    return this.request<TaskThread[]>(`tasks/${encodeURIComponent(taskId)}/threads`);
  }

  openThread(taskId: string, input: { topic: string; assigneeId?: string }, operationId: string) {
    return this.request<TaskThread>(`tasks/${encodeURIComponent(taskId)}/threads`, {
      body: input,
      operationId,
    });
  }

  resolveThread(taskId: string, threadId: string, operationId: string) {
    return this.request<TaskThread>(
      `tasks/${encodeURIComponent(taskId)}/threads/${encodeURIComponent(threadId)}/resolve`,
      { body: {}, operationId },
    );
  }

  markRead(taskId: string, operationId: string) {
    return this.request<{
      taskId: string;
      lastReadAt: string;
      unread: { messages: number; questions: number; mentions: number };
    }>(`tasks/${encodeURIComponent(taskId)}/read`, { body: {}, operationId });
  }

  /** 点名问我、尚未回答的问题。 */
  questions() {
    return this.request<TaskComment[]>('agent/questions');
  }

  /** 交接包：markdown 给智能体读，manifest 给程序用。 */
  contextPack(taskId: string) {
    return this.request<ContextPack>(`tasks/${encodeURIComponent(taskId)}/context-pack`);
  }

  search(query: string) {
    return this.request<SpaceSearch>(`space/search?q=${encodeURIComponent(query)}`);
  }

  /** 团队首页「需要你」队列：提问、未读提醒、待验收与可接管提案。 */
  home() {
    return this.request<SpaceHome>('space/home');
  }

  file(id: string) {
    return this.request<SpaceFile>(`space/files/${encodeURIComponent(id)}`);
  }

  /** 申请上传地址。本地驱动返回服务端 PUT 地址，S3 驱动返回预签名地址。 */
  uploadUrl(
    input: {
      name: string;
      mime: string;
      size?: number;
      sha256?: string;
      taskId?: string;
      subtaskId?: string;
      messageId?: string;
      supersedesId?: string;
      kind?: string;
      source?: string;
    },
    operationId: string,
  ) {
    return this.request<UploadSession>('space/files/upload-url', { body: input, operationId });
  }

  uploadStatus(uploadId: string) {
    return this.request<{ id: string; status: string; fileId: string | null; expiresAt: string }>(
      `space/uploads/${encodeURIComponent(uploadId)}`,
    );
  }

  completeUpload(uploadId: string, operationId: string) {
    return this.request<SpaceFile>(`space/uploads/${encodeURIComponent(uploadId)}/complete`, {
      body: {},
      operationId,
    });
  }

  /** 把字节 PUT 到上传地址。S3 返回空响应，本地驱动返回哈希与大小。 */
  async putUpload(session: UploadSession, bytes: Uint8Array): Promise<Record<string, unknown>> {
    const target = session.url.startsWith('http')
      ? session.url
      : new URL(session.url, this.baseUrl).toString();
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'PUT',
        headers: {
          ...session.headers,
          'content-length': String(bytes.byteLength),
        },
        body: bytes,
        redirect: 'error',
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new CollabError('上传失败：网络中断', { uncertain: true, cause: error });
    }
    if (!response.ok) {
      const text = await response.text();
      let message = `上传失败（HTTP ${response.status}）`;
      try {
        const payload = JSON.parse(text) as { error?: { message?: string } };
        if (payload.error?.message) message = payload.error.message;
      } catch {
        // S3 的错误体不是 JSON，保留 HTTP 状态即可。
      }
      throw new CollabError(message, { status: response.status });
    }
    const type = response.headers.get('content-type') ?? '';
    return type.includes('json') ? ((await response.json()) as Record<string, unknown>) : { ok: true };
  }

  /** 三步上传的便捷封装：申请 → PUT → 确认。 */
  async uploadBytes(
    input: {
      name: string;
      mime: string;
      size?: number;
      sha256?: string;
      taskId?: string;
      subtaskId?: string;
      messageId?: string;
      supersedesId?: string;
      kind?: string;
      source?: string;
    },
    bytes: Uint8Array,
    operationId: string,
  ) {
    const session = await this.uploadUrl({ ...input, size: input.size ?? bytes.byteLength }, operationId);
    await this.putUpload(session, bytes);
    return this.completeUpload(session.id, `${operationId}:complete`);
  }

  /** 流式读取文件字节；比 base64 JSON 接口更适合大文件。 */
  async download(path: string): Promise<{ data: Uint8Array; mime: string; name: string | null }> {
    const response = await fetch(new URL(`/v1/${path}`, this.baseUrl), {
      headers: { authorization: `Bearer ${this.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      let message = `下载失败（HTTP ${response.status}）`;
      try {
        const payload = (await response.json()) as { error?: { message?: string } };
        if (payload.error?.message) message = payload.error.message;
      } catch {
        // 非 JSON 错误体。
      }
      throw new CollabError(message, { status: response.status });
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const match =
      /filename\*=UTF-8''([^;]+)/i.exec(disposition) ?? /filename="?([^";]+)"?/i.exec(disposition);
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mime: response.headers.get('content-type') ?? 'application/octet-stream',
      name: match?.[1] ? decodeURIComponent(match[1]) : null,
    };
  }

  downloadFile(fileId: string) {
    return this.download(`space/files/${encodeURIComponent(fileId)}/content`);
  }

  downloadTaskFile(taskId: string, fileId: string) {
    return this.download(
      `tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}/content`,
    );
  }

  /** 任务材料目录。 */
  taskMaterials(taskId: string) {
    return this.request<MaterialMeta[]>(`tasks/${encodeURIComponent(taskId)}/materials`);
  }

  /** 任务材料正文；data 是 base64，由调用方自行解码。 */
  taskMaterial(taskId: string, materialId: string) {
    return this.request<MaterialContent>(
      `tasks/${encodeURIComponent(taskId)}/materials/${encodeURIComponent(materialId)}`,
    );
  }

  createTask(
    input: Record<string, unknown> & { ownership?: 'personal' | 'team'; teamId?: string },
    operationId: string,
  ) {
    return this.request<TaskRef>('tasks', { body: input, operationId });
  }

  delegate(taskId: string, principal: string, operationId: string, expectedVersion?: number) {
    return this.request<{ principal: string }>(`tasks/${encodeURIComponent(taskId)}/coordinators`, {
      body: { principal },
      operationId,
      expectedVersion,
    });
  }

  undelegate(taskId: string, principal: string, operationId: string, expectedVersion?: number) {
    return this.request<{ principal: string; delegated: false }>(`tasks/${encodeURIComponent(taskId)}/remove-coordinator`, {
      body: { principal },
      operationId,
      expectedVersion,
    });
  }

  assign(taskId: string, input: { agent: string; kind: string; dependsOn?: string[]; dueAt?: string }, operationId: string, expectedVersion?: number) {
    return this.request<SubtaskRef>(`tasks/${encodeURIComponent(taskId)}/assign`, {
      body: input,
      operationId,
      expectedVersion,
    });
  }

  // ------------------------------------------------------------ 参与人与协商

  inviteParticipant(
    taskId: string,
    input: { principal?: string; email?: string; note?: string },
    operationId: string,
  ) {
    return this.request<TaskParticipantView>(`tasks/${encodeURIComponent(taskId)}/participants`, {
      body: input,
      operationId,
    });
  }

  participants(taskId: string) {
    return this.request<TaskParticipantView[]>(`tasks/${encodeURIComponent(taskId)}/participants`);
  }

  taskInvitations() {
    return this.request<TaskParticipantView[]>('task-invitations');
  }

  acceptTaskInvitation(participantId: string, agent: string, operationId: string) {
    return this.request<TaskParticipantView>(`task-invitations/${encodeURIComponent(participantId)}/accept`, {
      body: { agent },
      operationId,
    });
  }

  declineTaskInvitation(participantId: string, note: string, operationId: string) {
    return this.request<TaskParticipantView>(`task-invitations/${encodeURIComponent(participantId)}/decline`, {
      body: { note },
      operationId,
    });
  }

  selectParticipantAgent(taskId: string, participantId: string, agent: string, operationId: string) {
    return this.request<TaskParticipantView>(
      `tasks/${encodeURIComponent(taskId)}/participants/${encodeURIComponent(participantId)}/agent`,
      { body: { agent }, operationId },
    );
  }

  revokeParticipant(taskId: string, participantId: string, operationId: string) {
    return this.request<TaskParticipantView>(
      `tasks/${encodeURIComponent(taskId)}/participants/${encodeURIComponent(participantId)}/revoke`,
      { body: {}, operationId },
    );
  }

  proposeRequest(
    taskId: string,
    input: { to: string; role: 'coordinate' | 'subtask'; kind?: string; dueAt?: string; dependsOn?: string[]; note?: string },
    operationId: string,
  ) {
    return this.request<TaskRequestView>(`tasks/${encodeURIComponent(taskId)}/requests`, {
      body: input,
      operationId,
    });
  }

  taskRequests(taskId: string) {
    return this.request<TaskRequestView[]>(`tasks/${encodeURIComponent(taskId)}/requests`);
  }

  requests(options: { box?: 'inbox' | 'outbox'; taskId?: string; status?: string } = {}) {
    const query = new URLSearchParams();
    if (options.box) query.set('box', options.box);
    if (options.taskId) query.set('taskId', options.taskId);
    if (options.status) query.set('status', options.status);
    const encoded = query.toString();
    const suffix = encoded ? `?${encoded}` : '';
    return this.request<TaskRequestView[]>(`requests${suffix}`);
  }

  acceptRequest(requestId: string, operationId: string) {
    return this.request<{ id: string; status: 'accepted'; subtaskId: string | null }>(
      `requests/${encodeURIComponent(requestId)}/accept`,
      { body: {}, operationId },
    );
  }

  declineRequest(requestId: string, reason: string, operationId: string) {
    return this.request<TaskRequestView>(`requests/${encodeURIComponent(requestId)}/decline`, {
      body: { reason },
      operationId,
    });
  }

  counterRequest(
    requestId: string,
    input: { kind?: string; dueAt?: string; dependsOn?: string[]; note?: string },
    operationId: string,
  ) {
    return this.request<TaskRequestView>(`requests/${encodeURIComponent(requestId)}/counter`, {
      body: input,
      operationId,
    });
  }

  confirmRequest(requestId: string, operationId: string) {
    return this.request<{ id: string; status: 'accepted'; subtaskId: string | null }>(
      `requests/${encodeURIComponent(requestId)}/confirm`,
      { body: {}, operationId },
    );
  }

  withdrawRequest(requestId: string, operationId: string) {
    return this.request<TaskRequestView>(`requests/${encodeURIComponent(requestId)}/withdraw`, {
      body: {},
      operationId,
    });
  }

  stageSummary(taskId: string, input: { text: string; pending: string }, operationId: string, expectedVersion?: number) {
    return this.request<{ taskId: string; version: number; throughSeq: number }>(`tasks/${encodeURIComponent(taskId)}/stage-summaries`, {
      body: input,
      operationId,
      expectedVersion,
    });
  }

  summary(taskId: string, text: string, operationId: string, expectedVersion?: number) {
    return this.request<StatusChange>(`tasks/${encodeURIComponent(taskId)}/summary`, {
      body: { text },
      operationId,
      expectedVersion,
    });
  }

  review(taskId: string, decision: 'accept' | 'return', note: string, operationId: string, expectedVersion?: number) {
    return this.request<StatusChange>(`tasks/${encodeURIComponent(taskId)}/review`, {
      body: { decision, note },
      operationId,
      expectedVersion,
    });
  }

  cancel(taskId: string, note: string, operationId: string, expectedVersion?: number) {
    return this.request<StatusChange>(`tasks/${encodeURIComponent(taskId)}/cancel`, {
      body: { note },
      operationId,
      expectedVersion,
    });
  }

  archiveTask(taskId: string, operationId: string) {
    return this.request<{ archivedAt: string; version: number }>(
      `tasks/${encodeURIComponent(taskId)}/archive`,
      { body: {}, operationId },
    );
  }

  unarchiveTask(taskId: string, operationId: string) {
    return this.request<{ archivedAt: null; version: number }>(
      `tasks/${encodeURIComponent(taskId)}/unarchive`,
      { body: {}, operationId },
    );
  }

  // ------------------------------------------------------------ 子任务
  inbox() {
    return this.request<InboxItem[]>('inbox');
  }

  accept(subtaskId: string, operationId: string, expectedVersion?: number) {
    return this.request<SubtaskRef>(`subtasks/${encodeURIComponent(subtaskId)}/accept`, {
      body: {},
      operationId,
      expectedVersion,
    });
  }

  reject(subtaskId: string, reason: string, operationId: string, expectedVersion?: number) {
    return this.request<SubtaskRef>(`subtasks/${encodeURIComponent(subtaskId)}/reject`, {
      body: { reason },
      operationId,
      expectedVersion,
    });
  }

  submit(subtaskId: string, result: Record<string, unknown>, operationId: string, expectedVersion?: number) {
    return this.request<SubtaskRef>(`subtasks/${encodeURIComponent(subtaskId)}/submit`, {
      body: { result },
      operationId,
      expectedVersion,
    });
  }

  progress(subtaskId: string, text: string, operationId: string, expectedVersion?: number) {
    return this.request<SubtaskRef>(`subtasks/${encodeURIComponent(subtaskId)}/progress`, {
      body: { text },
      operationId,
      expectedVersion,
    });
  }

  outcomeUnknown(subtaskId: string, input: { reason: string; externalOperationId: string }, operationId: string, expectedVersion?: number) {
    return this.request<SubtaskRef>(`subtasks/${encodeURIComponent(subtaskId)}/outcome-unknown`, {
      body: input,
      operationId,
      expectedVersion,
    });
  }

  timeoutSubtask(subtaskId: string, note: string, operationId: string, expectedVersion?: number) {
    return this.request<SubtaskRef>(`subtasks/${encodeURIComponent(subtaskId)}/timeout`, {
      body: { note },
      operationId,
      expectedVersion,
    });
  }

  returnSubtask(subtaskId: string, note: string, operationId: string, expectedVersion?: number) {
    return this.request<SubtaskRef>(`subtasks/${encodeURIComponent(subtaskId)}/return`, {
      body: { note },
      operationId,
      expectedVersion,
    });
  }

  notifications() {
    return this.request<NotificationView[]>('notifications');
  }

  acknowledge(notificationId: string, operationId: string) {
    return this.request<{ id: string; acknowledged: true }>(
      `notifications/${encodeURIComponent(notificationId)}/ack`,
      { body: {}, operationId },
    );
  }

  // ------------------------------------------------------------ 知识
  knowledge(query = '') {
    return this.request<KnowledgeSummary[]>(
      `knowledge${query ? `?q=${encodeURIComponent(query)}` : ''}`,
    );
  }

  searchKnowledge(query: string, limit = 10, budget = 4000) {
    return this.request<KnowledgeSearch>(
      `knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}&budget=${budget}`,
    );
  }

  knowledgeEvidence(id: string) {
    return this.request<Evidence>(`knowledge/${encodeURIComponent(id)}/evidence`);
  }

  candidates() {
    return this.request<KnowledgeSummary[]>('knowledge/candidates');
  }

  versions(id: string) {
    return this.request<
      { version: number; content: string; conditions: string; reviewerId: string; expiresAt: string; publishedAt: string }[]
    >(`knowledge/${encodeURIComponent(id)}/versions`);
  }

  candidate(taskId: string, input: { content: string; conditions: string }, operationId: string) {
    return this.request<{ id: string; state: string; version: number }>(
      `tasks/${encodeURIComponent(taskId)}/knowledge`,
      { body: input, operationId },
    );
  }

  publish(id: string, input: { expiresAt: string; audience?: 'workspace' | string[] }, operationId: string, expectedVersion?: number) {
    return this.request<{ id: string; state: string; version: number }>(
      `knowledge/${encodeURIComponent(id)}/publish`,
      { body: input, operationId, expectedVersion },
    );
  }

  revoke(id: string, reason: string, operationId: string, expectedVersion?: number) {
    return this.request<{ id: string; state: string; version: number }>(
      `knowledge/${encodeURIComponent(id)}/revoke`,
      { body: { reason }, operationId, expectedVersion },
    );
  }

  revise(id: string, input: { content: string; conditions: string; reason: string }, operationId: string, expectedVersion?: number) {
    return this.request<{ id: string; state: string; version: number }>(
      `knowledge/${encodeURIComponent(id)}/revise`,
      { body: input, operationId, expectedVersion },
    );
  }

  setKnowledgeAccess(id: string, audience: 'workspace' | string[], operationId: string, expectedVersion?: number) {
    return this.request<{ id: string; audience: string | string[] }>(
      `knowledge/${encodeURIComponent(id)}/access`,
      { body: { audience }, operationId, expectedVersion },
    );
  }

  knowledgeShares(id: string) {
    return this.request<{ teams: { id: string; name: string }[] }>(
      `knowledge/${encodeURIComponent(id)}/shares`,
    );
  }

  shareKnowledge(id: string, teamIds: string[], operationId: string) {
    return this.request<{ id: string; teamIds: string[] }>(
      `knowledge/${encodeURIComponent(id)}/shares`,
      { body: { teamIds }, operationId },
    );
  }

  reference(taskId: string, knowledgeId: string, operationId: string, expectedVersion?: number) {
    return this.request<{ id: string; version: number }>(`tasks/${encodeURIComponent(taskId)}/references`, {
      body: { knowledgeId },
      operationId,
      expectedVersion,
    });
  }

  evidence(taskId: string, knowledgeId: string, version: number) {
    return this.request<Evidence>(
      `tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(knowledgeId)}/${version}`,
    );
  }

  // ------------------------------------------------------------ 协作
  comments(taskId: string) {
    return this.request<{ id: string; authorId: string; authorName: string; authorKind: string; body: string; mentions: string[]; createdAt: string }[]>(
      `tasks/${encodeURIComponent(taskId)}/comments`,
    );
  }

  comment(taskId: string, body: string, operationId: string) {
    return this.request<{ id: string; body: string }>(`tasks/${encodeURIComponent(taskId)}/comments`, {
      body: { body },
      operationId,
    });
  }

  offers(taskId: string) {
    return this.request<unknown[]>(`tasks/${encodeURIComponent(taskId)}/offers`);
  }

  openOffers() {
    return this.request<unknown[]>('offers');
  }

  publishOffer(taskId: string, input: { kind: string; description?: string; capability?: string; dueAt?: string }, operationId: string) {
    return this.request<{ id: string; status: string }>(`tasks/${encodeURIComponent(taskId)}/offers`, {
      body: input,
      operationId,
    });
  }

  claimOffer(offerId: string, operationId: string) {
    return this.request<{ offerId: string; subtaskId: string }>(`offers/${encodeURIComponent(offerId)}/claim`, {
      body: {},
      operationId,
    });
  }

  withdrawOffer(offerId: string, operationId: string) {
    return this.request<{ offerId: string; status: string }>(`offers/${encodeURIComponent(offerId)}/withdraw`, {
      body: {},
      operationId,
    });
  }

  adopt(taskId: string, operationId: string) {
    return this.request<{ id: string; ownerId: string; version: number }>(`tasks/${encodeURIComponent(taskId)}/adopt`, {
      body: {},
      operationId,
    });
  }

  heartbeat(input: { state?: 'online' | 'busy' | 'offline'; note?: string; client?: string } = {}) {
    return this.request<{ principalId: string; state: string; lastSeenAt: string }>('agent/heartbeat', {
      body: input,
      operationId: `heartbeat:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  presence() {
    return this.request<{ principalId: string; displayName: string; state: string; silentSeconds: number | null }[]>(
      'agent/presence',
    );
  }

  // ------------------------------------------------------------ 信箱
  createMailSession(
    input: {
      label?: string;
      kind?: 'external' | 'embedded';
      ttlSeconds?: number;
      subscriptions?: { topic: string; mode?: 'fanout' | 'queue' }[];
    },
    operationId: string,
  ) {
    return this.request<MailSession>('mail/sessions', { body: input, operationId });
  }

  mailSession(sessionId: string) {
    return this.request<MailSession>(`mail/sessions/${encodeURIComponent(sessionId)}`);
  }

  heartbeatMailSession(sessionId: string) {
    return this.request<MailSession>(`mail/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
      body: {},
      operationId: `mail:heartbeat:${sessionId}:${Date.now()}`,
    });
  }

  closeMailSession(sessionId: string) {
    return this.request<{ id: string; status: 'closed' }>(
      `mail/sessions/${encodeURIComponent(sessionId)}/close`,
      { body: {}, operationId: `mail:close:${sessionId}:${Date.now()}` },
    );
  }

  pullMail(
    sessionId: string,
    options: { limit?: number; leaseSeconds?: number; includeDigest?: boolean; since?: number; waitMs?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.leaseSeconds !== undefined) params.set('leaseSeconds', String(options.leaseSeconds));
    if (options.includeDigest) params.set('include', 'digest');
    if (options.since !== undefined) params.set('since', String(options.since));
    if (options.waitMs !== undefined) params.set('waitMs', String(options.waitMs));
    const suffix = params.size ? `?${params}` : '';
    return this.request<{ items: MailEnvelope[]; cursor: number; session: MailSession }>(
      `mail/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,
    );
  }

  mailMessage(messageId: string) {
    return this.request<MailMessage>(`mail/messages/${encodeURIComponent(messageId)}`);
  }

  ackMail(messageId: string, deliveryId: string, operationId = `mail:ack:${messageId}:${deliveryId}`) {
    return this.request<{ id: string; state: string; duplicate: boolean }>(
      `mail/messages/${encodeURIComponent(messageId)}/ack`,
      { body: { deliveryId }, operationId },
    );
  }

  nackMail(
    messageId: string,
    input: { deliveryId: string; retryAfterSeconds?: number; reason?: string },
    operationId = `mail:nack:${messageId}:${input.deliveryId}:${Date.now()}`,
  ) {
    return this.request<{ id: string; state: string; attempts: number }>(
      `mail/messages/${encodeURIComponent(messageId)}/nack`,
      { body: input, operationId },
    );
  }

  mailSubscriptions(sessionId: string) {
    return this.request<MailSubscription[]>(`mail/sessions/${encodeURIComponent(sessionId)}/subscriptions`);
  }

  subscribeMail(
    sessionId: string,
    input: { topic: string; mode?: 'fanout' | 'queue' },
    operationId: string,
  ) {
    return this.request<MailSubscription>(`mail/sessions/${encodeURIComponent(sessionId)}/subscriptions`, {
      body: input,
      operationId,
    });
  }

  unsubscribeMail(subscriptionId: string, operationId: string) {
    return this.request<{ id: string; removed: true }>(
      `mail/subscriptions/${encodeURIComponent(subscriptionId)}/delete`,
      { body: {}, operationId },
    );
  }

  /** SSE 长连接：逐个信封产出；会话关闭时结束。调用方负责 abort。 */
  async *streamMail(
    sessionId: string,
    options: { lastEventId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<MailEnvelope> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'text/event-stream',
    };
    if (options.lastEventId) headers['last-event-id'] = options.lastEventId;
    const response = await fetch(
      new URL(`/v1/mail/sessions/${encodeURIComponent(sessionId)}/events`, this.baseUrl),
      { headers, signal: options.signal },
    );
    if (!response.ok || !response.body) {
      throw new CollabError(`信箱推送连接失败（HTTP ${response.status}）`, { status: response.status });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of chunk.split('\n')) {
          if (!line || line.startsWith(':') || line.startsWith('retry:')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
        if (event === 'closed') return;
        if (event === 'mail' && data.length > 0) yield JSON.parse(data.join('\n')) as MailEnvelope;
        index = buffer.indexOf('\n\n');
      }
    }
  }

  // ------------------------------------------------------------ 监管
  oversight() {
    return this.request<Record<string, unknown>>('oversight');
  }

  scanAlerts() {
    return this.request<{ opened: number; updated: number; resolved: number; total: number }>('oversight/scan', {
      body: {},
      operationId: `scan:${Date.now()}`,
    });
  }

  acknowledgeAlert(alertId: string, operationId: string) {
    return this.request<Record<string, unknown>>(`oversight/alerts/${encodeURIComponent(alertId)}/ack`, {
      body: {},
      operationId,
    });
  }

  resolveAlert(alertId: string, operationId: string) {
    return this.request<Record<string, unknown>>(`oversight/alerts/${encodeURIComponent(alertId)}/resolve`, {
      body: {},
      operationId,
    });
  }

  // ------------------------------------------------------------ 运维
  expire() {
    return this.request<{ expired: number; checkedAt: string }>('maintenance/expire', {
      body: {},
      operationId: `maintenance:expire:${Date.now()}`,
    });
  }

  audit() {
    return this.request<AuditEntry[]>('audit');
  }

  auditReport(days = 7) {
    return this.request<AuditReport>(`audit/report?days=${encodeURIComponent(String(days))}`);
  }

  retention(days = 30, apply = false, operationId = `maintenance:retention:${Date.now()}`) {
    return this.request<RetentionResult>('maintenance/retention', { body: { days, apply }, operationId });
  }
}
