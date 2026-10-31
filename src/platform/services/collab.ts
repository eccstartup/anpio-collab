/**
 * 协作扩展：评论、开放认领、心跳。
 *
 * 这里补的是"谁先动"的问题。第一轮只有人分派、智能体接受；真实协作里
 * 智能体也会自己发现工作（认领开放子任务）、自己提出问题（评论），
 * 人则负责接管它发起的提案。
 *
 * 所有写方法都假定自己已在事务中执行（HTTP 执行器负责开启），
 * 因此"状态 + 事件 + 通知"要么一起生效，要么一起回滚。
 */

import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import { asEnum, asObject, asOptionalString, asString, asStringArray } from '../../protocol/parse.ts';
import { MESSAGE_KINDS, PRESENCE_STATES } from '../../protocol/types.ts';
import type {
  MessageKind,
  OfferStatus,
  Presence,
  Principal,
  RoomActivity,
  SpaceFile,
  SpaceFileKind,
  TaskComment,
  TaskOffer,
  TaskRoom,
  TaskThread,
  ThreadStatus,
} from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';
import { encode } from '../db/mappers.ts';
import { hasAnyRole, loadTask, readTask, requireAgentScope } from './access.ts';
import { appendEvent } from './events.ts';
import { NotificationService } from './notifications.ts';
import type { BlobStore } from '../storage.ts';

const MENTION = /@([A-Za-z0-9][A-Za-z0-9._:-]{0,63})/g;
const DEFAULT_OFFER_DAYS = 3;
const MAX_INLINE_BYTES = 256 * 1024;
const MAX_INLINE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const UPLOAD_TTL_MINUTES = 15;

function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw invalid('Range 只支持单段 bytes=start-end');
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) throw invalid('Range 不合法');
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw invalid('Range 不合法');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    throw invalid('Range 不合法');
  }
  if (start >= size) throw invalid('Range 超出文件大小');
  return { start, end: Math.min(end, size - 1) };
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toComment(row: Record<string, unknown>): TaskComment {
  const mentions = parseJson(row.mentions, []) as string[];
  const kind = row.author_kind === 'agent' ? 'agent' : row.author_kind === 'service' ? 'service' : 'human';
  const declared = String(row.kind ?? 'comment');
  const messageKind: MessageKind = (MESSAGE_KINDS as readonly string[]).includes(declared)
    ? (declared as MessageKind)
    : 'comment';
  const payload = parseJson(row.payload, {});
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    authorId: String(row.author_id),
    authorName: String(row.author_name ?? row.author_id),
    authorAvatar: String(row.author_avatar ?? ''),
    authorKind: kind,
    body: String(row.body),
    mentions,
    createdAt: String(row.created_at),
    kind: messageKind,
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    replyTo: row.reply_to === null || row.reply_to === undefined ? null : String(row.reply_to),
    payload: payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {},
    editedAt: row.edited_at === null || row.edited_at === undefined ? null : String(row.edited_at),
    ...(row.task_title === undefined ? {} : { taskTitle: String(row.task_title) }),
  };
}

function toThread(row: Record<string, unknown>): TaskThread {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    taskId: String(row.task_id),
    topic: String(row.topic),
    status: (String(row.status) === 'resolved' ? 'resolved' : 'open') as ThreadStatus,
    openedBy: String(row.opened_by),
    openedByName: String(row.opened_by_name ?? row.opened_by),
    assigneeId:
      row.assignee_id === null || row.assignee_id === undefined ? null : String(row.assignee_id),
    createdAt: String(row.created_at),
    resolvedAt:
      row.resolved_at === null || row.resolved_at === undefined ? null : String(row.resolved_at),
    messageCount: Number(row.message_count ?? 0),
  };
}

function toSpaceFile(row: Record<string, unknown>): SpaceFile {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    subtaskId: row.subtask_id === null || row.subtask_id === undefined ? null : String(row.subtask_id),
    messageId:
      row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    name: String(row.name),
    mime: String(row.mime),
    size: Number(row.size),
    sha256: String(row.sha256),
    storage: (['inline', 'fs', 's3'] as const).includes(String(row.storage) as 'inline')
      ? (String(row.storage) as SpaceFile['storage'])
      : 'inline',
    kind: (['input', 'intermediate', 'output', 'evidence', 'attachment'] as const).includes(String(row.kind) as 'input')
      ? (String(row.kind) as SpaceFileKind)
      : 'intermediate',
    version: Number(row.version),
    supersedesId:
      row.supersedes_id === null || row.supersedes_id === undefined
        ? null
        : String(row.supersedes_id),
    producedBy: String(row.produced_by),
    producedByName: String(row.produced_by_name ?? row.produced_by),
    source: (['human_upload', 'agent_upload', 'tool_output'] as const).includes(
      String(row.source) as 'human_upload',
    )
      ? (String(row.source) as SpaceFile['source'])
      : 'human_upload',
    status: (['pending', 'ready', 'quarantined', 'deleted'] as const).includes(
      String(row.status) as 'ready',
    )
      ? (String(row.status) as SpaceFile['status'])
      : 'ready',
    createdAt: String(row.created_at),
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
  };
}

const EVENT_LABELS: Record<string, string> = {
  task_created: '创建任务',
  task_cancelled: '取消任务',
  task_adopted: '接管任务',
  coordinator_delegated: '委派协调者',
  coordinator_removed: '移除协调者',
  subtask_invited: '指派子任务',
  subtask_accepted: '接受子任务',
  subtask_rejected: '拒绝子任务',
  subtask_progress: '子任务进展',
  subtask_submitted: '提交结果',
  subtask_outcome_unknown: '结果未知',
  subtask_timed_out: '子任务超时',
  subtask_returned: '退回子任务',
  subtask_cancelled: '取消子任务',
  summary_submitted: '提交阶段摘要',
  task_accepted: '验收通过',
  task_returned: '验收退回',
  stage_summary_recorded: '记录阶段摘要',
  knowledge_candidate: '沉淀候选经验',
  knowledge_published: '发布经验',
  knowledge_revoked: '撤销经验',
  knowledge_revised: '修订经验',
  knowledge_access_changed: '调整共享范围',
  knowledge_referenced: '引用经验',
  knowledge_shared: '分享经验',
  thread_opened: '开启线程',
  thread_resolved: '结束线程',
  file_uploaded: '上传文件',
  file_deleted: '删除文件',
  offer_published: '发布开放子任务',
  offer_claimed: '认领开放子任务',
  offer_withdrawn: '撤回开放子任务',
  participant_invited: '邀请参与任务',
  participant_accepted: '接受任务邀请',
  participant_declined: '拒绝任务邀请',
  participant_agent_selected: '选定参与智能体',
  participant_revoked: '撤销任务参与',
  request_proposed: '发起协作请求',
  request_accepted: '接受协作请求',
  request_declined: '拒绝协作请求',
  request_countered: '协作请求还价',
  request_confirmed: '确认还价',
  request_withdrawn: '撤回协作请求',
  aicd_created: '创建经验',
  aicd_updated: '编辑经验',
  aicd_submitted: '提交经验审核',
  aicd_archived: '归档经验',
  aicd_copied: '复制经验',
  aicd_copy_invited: '发起复制邀请',
  aicd_copy_accepted: '接受复制邀请',
  aicd_copy_declined: '拒绝复制邀请',
};

function eventSummary(type: string, payload: Record<string, unknown>): string {
  const label = EVENT_LABELS[type] ?? type;
  const subject = payload.name ?? payload.title ?? payload.topic ?? payload.preview;
  return subject === undefined ? label : `${label}：${String(subject).slice(0, 80)}`;
}

/** 结构化收件人：`payload.to` 可以是单个主体 ID，也可以是数组。 */
function addressedTo(payload: Record<string, unknown>): string[] {
  const raw = payload.to;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  return [];
}

function toOffer(row: Record<string, unknown>): TaskOffer {  return {
    id: String(row.id),
    taskId: String(row.task_id),
    kind: String(row.kind),
    description: String(row.description ?? ''),
    capability: row.capability === null || row.capability === undefined ? null : String(row.capability),
    dueAt: String(row.due_at),
    status: String(row.status) as OfferStatus,
    createdBy: String(row.created_by),
    claimedBy: row.claimed_by === null || row.claimed_by === undefined ? null : String(row.claimed_by),
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : String(row.claimed_at),
    subtaskId: row.subtask_id === null || row.subtask_id === undefined ? null : String(row.subtask_id),
    createdAt: String(row.created_at),
  };
}

export class CollabService {
  private readonly ctx: Context;
  private readonly notifications: NotificationService;
  private readonly storage: BlobStore;

  constructor(ctx: Context, notifications: NotificationService, storage: BlobStore) {
    this.ctx = ctx;
    this.notifications = notifications;
    this.storage = storage;
  }

  // ---------------------------------------------------------------- 评论

  /**
   * 追加一条评论。
   *
   * 评论不进任务版本：它是讨论，不是状态变更。事件仍然追加一条，
   * 于是时间线与动态流能看到"谁在什么时候说了什么"，但不会因为
   * 一句评论把别人手上的 `If-Match` 全部打回。
   */
  async addComment(actor: Principal, taskId: string, body: unknown): Promise<TaskComment> {
    const task = await readTask(this.ctx, actor, taskId);
    await requireAgentScope(this.ctx, actor, 'comments:write');
    const input = asObject(body);
    const text = asString(input.body, 'body', { max: 4000 });
    const kind = input.kind === undefined ? 'comment' : asEnum(input.kind, 'kind', MESSAGE_KINDS);
    if (kind === 'system' && !hasAnyRole(actor, 'admin')) {
      throw forbidden('只有管理员可以写入 system 消息');
    }
    let threadId = input.threadId === undefined ? null : asString(input.threadId, 'threadId', { max: 128 });
    const replyTo = input.replyTo === undefined ? null : asString(input.replyTo, 'replyTo', { max: 128 });
    const payload = input.payload === undefined ? {} : asObject(input.payload, 'payload');
    if (encode(payload).length > 4000) throw invalid('payload 过大（上限 4000 字符）');
    const fileIds =
      input.fileIds === undefined
        ? []
        : asStringArray(input.fileIds, 'fileIds', { max: 20, maxLength: 128 });

    if (threadId) {
      const thread = await this.ctx.db.read.one(
        'SELECT id FROM task_threads WHERE id = :id AND task_id = :taskId AND workspace = :workspace',
        { id: threadId, taskId: task.id, workspace: actor.workspace },
      );
      if (!thread) throw notFound('线程不存在');
    }
    if (replyTo) {
      const parent = await this.ctx.db.read.one(
        'SELECT id, thread_id FROM task_comments WHERE id = :id AND task_id = :taskId',
        { id: replyTo, taskId: task.id },
      );
      if (!parent) throw notFound('被回复的消息不存在');
      if (!threadId && parent.thread_id !== null && parent.thread_id !== undefined) {
        threadId = String(parent.thread_id);
      }
    }
    for (const fileId of fileIds) {
      const file = await this.ctx.db.read.one(
        `SELECT id FROM space_files
         WHERE id = :id AND task_id = :taskId AND workspace = :workspace AND status = 'ready'`,
        { id: fileId, taskId: task.id, workspace: actor.workspace },
      );
      if (!file) throw notFound(`文件 ${fileId} 不存在或不可用`);
    }

    const mentioned = [...new Set([...text.matchAll(MENTION)].map(match => match[1]!))].slice(0, 20);
    // 结构化收件人：`payload.to` 让 question / handoff 不必依赖正文里的 @。
    const addressed: string[] = [];
    if (payload.to !== undefined) {
      const raw = typeof payload.to === 'string' ? [payload.to] : payload.to;
      for (const item of asStringArray(raw, 'payload.to', { max: 20, maxLength: 128 })) {
        if (!addressed.includes(item)) addressed.push(item);
      }
    }

    const commentId = this.ctx.newId();
    const at = this.ctx.now();
    const recipients: Principal[] = [];
    for (const id of [...new Set([...mentioned, ...addressed])]) {
      if (id === actor.id) continue;
      const row = await this.ctx.db.read.one(
        'SELECT * FROM principals WHERE id = :id AND workspace = :workspace AND active = 1',
        { id, workspace: actor.workspace },
      );
      if (row) recipients.push({ id: String(row.id) } as Principal);
      else if (addressed.includes(id)) throw invalid(`收件人 ${id} 不存在或已停用`);
    }

    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO task_comments(id, workspace, task_id, author_id, body, mentions, created_at,
                                   kind, thread_id, reply_to, payload, edited_at)
         VALUES(:id, :workspace, :taskId, :author, :body, :mentions, :at,
                :kind, :threadId, :replyTo, :payload, NULL)`,
        {
          id: commentId,
          workspace: actor.workspace,
          taskId: task.id,
          author: actor.id,
          body: text,
          mentions: encode(recipients.map(item => item.id)),
          at,
          kind,
          threadId,
          replyTo,
          payload: encode(payload),
        },
      );
      for (const fileId of fileIds) {
        await tx.run(
          'UPDATE space_files SET message_id = :comment WHERE id = :id AND task_id = :taskId',
          { comment: commentId, id: fileId, taskId: task.id },
        );
      }
      for (const recipient of recipients) {
        await tx.run(
          `INSERT INTO task_mentions(id, workspace, task_id, comment_id, recipient_id, created_at, read_at)
           VALUES(:id, :workspace, :taskId, :comment, :recipient, :at, NULL)`,
          {
            id: this.ctx.newId(),
            workspace: actor.workspace,
            taskId: task.id,
            comment: commentId,
            recipient: recipient.id,
            at,
          },
        );
      }
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: kind === 'comment' && !threadId ? 'comment_added' : 'message_added',
        payload: {
          commentId,
          kind,
          threadId,
          mentions: recipients.map(item => item.id),
          preview: text.slice(0, 120),
        },
      });
    });

    return {
      id: commentId,
      taskId: task.id,
      authorId: actor.id,
      authorName: actor.displayName,
      authorAvatar: actor.avatar,
      authorKind: actor.kind,
      body: text,
      mentions: recipients.map(item => item.id),
      createdAt: at,
      kind,
      threadId,
      replyTo,
      payload,
      editedAt: null,
      fileIds,
    };
  }

  async listComments(
    actor: Principal,
    taskId: string,
    options: { threadId?: string; limit?: number } = {},
  ): Promise<TaskComment[]> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const task = await readTask(this.ctx, actor, taskId);
    const threadId = options.threadId ?? '';
    const limit = options.limit ?? 500;
    const rows = await this.ctx.db.read.all(
      `SELECT c.*, p.display_name AS author_name, p.avatar AS author_avatar, p.kind AS author_kind
       FROM task_comments c JOIN principals p ON p.id = c.author_id
       WHERE c.task_id = :taskId AND (:threadId = '' OR c.thread_id = :threadId)
       ORDER BY c.created_at, c.id LIMIT :limit`,
      { taskId: task.id, threadId, limit },
    );
    return this.attachFileIds(rows.map(toComment), task.id);
  }

  /** 把文件挂回消息，列表里才能直接看到"这条消息带了什么"。 */
  private async attachFileIds(comments: TaskComment[], taskId: string): Promise<TaskComment[]> {
    if (comments.length === 0) return comments;
    const rows = await this.ctx.db.read.all(
      `SELECT id, message_id FROM space_files
       WHERE task_id = :taskId AND message_id IS NOT NULL AND status <> 'deleted'`,
      { taskId },
    );
    const byMessage = new Map<string, string[]>();
    for (const row of rows) {
      const messageId = String(row.message_id);
      const list = byMessage.get(messageId) ?? [];
      list.push(String(row.id));
      byMessage.set(messageId, list);
    }
    for (const comment of comments) {
      const fileIds = byMessage.get(comment.id);
      if (fileIds) comment.fileIds = fileIds;
    }
    return comments;
  }

  // ---------------------------------------------------------------- 线程

  async openThread(actor: Principal, taskId: string, body: unknown): Promise<TaskThread> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const task = await readTask(this.ctx, actor, taskId);
    const input = asObject(body);
    const topic = asString(input.topic, 'topic', { max: 200 });
    const assigneeId =
      input.assigneeId === undefined ? null : asString(input.assigneeId, 'assigneeId', { max: 128 });
    if (assigneeId) {
      const assignee = await this.ctx.db.read.one(
        'SELECT id FROM principals WHERE id = :id AND workspace = :workspace AND active = 1',
        { id: assigneeId, workspace: actor.workspace },
      );
      if (!assignee) throw invalid('指派人不存在或已停用');
    }
    const id = this.ctx.newId();
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO task_threads(id, workspace, task_id, topic, status, opened_by, assignee_id,
                                  created_at, resolved_at)
         VALUES(:id, :workspace, :taskId, :topic, 'open', :openedBy, :assignee, :at, NULL)`,
        {
          id,
          workspace: actor.workspace,
          taskId: task.id,
          topic,
          openedBy: actor.id,
          assignee: assigneeId,
          at,
        },
      );
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: 'thread_opened',
        payload: { threadId: id, topic, assigneeId },
      });
    });
    return {
      id,
      workspace: actor.workspace,
      taskId: task.id,
      topic,
      status: 'open',
      openedBy: actor.id,
      openedByName: actor.displayName,
      assigneeId,
      createdAt: at,
      resolvedAt: null,
      messageCount: 0,
    };
  }

  async listThreads(actor: Principal, taskId: string): Promise<TaskThread[]> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const task = await readTask(this.ctx, actor, taskId);
    const rows = await this.ctx.db.read.all(
      `SELECT th.*, p.display_name AS opened_by_name,
              (SELECT COUNT(*) FROM task_comments c WHERE c.thread_id = th.id) AS message_count
       FROM task_threads th LEFT JOIN principals p ON p.id = th.opened_by
       WHERE th.task_id = :taskId
       ORDER BY th.status = 'open' DESC, th.created_at DESC`,
      { taskId: task.id },
    );
    return rows.map(toThread);
  }

  async resolveThread(
    actor: Principal,
    taskId: string,
    threadId: string,
  ): Promise<TaskThread> {
    const task = await readTask(this.ctx, actor, taskId);
    const thread = await this.ctx.db.read.one(
      'SELECT * FROM task_threads WHERE id = :id AND task_id = :taskId',
      { id: threadId, taskId: task.id },
    );
    if (!thread) throw notFound('线程不存在');
    if (String(thread.status) === 'resolved') throw conflict('线程已解决');
    const allowed =
      String(thread.opened_by) === actor.id ||
      (thread.assignee_id !== null && String(thread.assignee_id) === actor.id) ||
      task.ownerId === actor.id ||
      hasAnyRole(actor, 'admin', 'reviewer');
    if (!allowed) throw forbidden('只有发起人、指派人或负责人可以结束线程');
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run("UPDATE task_threads SET status = 'resolved', resolved_at = :at WHERE id = :id", {
        at,
        id: threadId,
      });
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: 'thread_resolved',
        payload: { threadId },
      });
    });
    return {
      ...toThread(thread),
      status: 'resolved',
      resolvedAt: at,
    };
  }

  // ---------------------------------------------------------------- 文件

  async uploadFile(actor: Principal, taskId: string, body: unknown): Promise<SpaceFile> {
    const task = await readTask(this.ctx, actor, taskId);
    if (actor.kind !== 'human') await requireAgentScope(this.ctx, actor, 'tasks:submit');
    const input = asObject(body);
    const name = asString(input.name, 'name', { max: 200 });
    const mime = asOptionalString(input.mime, 'mime', { max: 200 }) ?? 'application/octet-stream';
    const kind =
      input.kind === undefined
        ? 'intermediate'
        : asEnum(input.kind, 'kind', ['input', 'intermediate', 'output', 'evidence', 'attachment'] as const);
    const data = asString(input.data, 'data', { max: 360_000 });
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw invalid('data 必须是 base64');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.byteLength === 0) throw invalid('文件不能为空');
    if (bytes.byteLength > MAX_INLINE_BYTES) throw invalid('单文件上限 256 KiB，超出请走对象存储');

    const subtaskId =
      input.subtaskId === undefined ? null : asString(input.subtaskId, 'subtaskId', { max: 128 });
    if (subtaskId) {
      const subtask = await this.ctx.db.read.one(
        'SELECT id FROM subtasks WHERE id = :id AND task_id = :taskId',
        { id: subtaskId, taskId: task.id },
      );
      if (!subtask) throw notFound('子任务不存在');
    }
    const messageId =
      input.messageId === undefined ? null : asString(input.messageId, 'messageId', { max: 128 });
    if (messageId) {
      const message = await this.ctx.db.read.one(
        'SELECT id FROM task_comments WHERE id = :id AND task_id = :taskId',
        { id: messageId, taskId: task.id },
      );
      if (!message) throw notFound('消息不存在');
    }
    const supersedesId =
      input.supersedesId === undefined
        ? null
        : asString(input.supersedesId, 'supersedesId', { max: 128 });
    let version = 1;
    if (supersedesId) {
      const prior = await this.ctx.db.read.one(
        'SELECT version FROM space_files WHERE id = :id AND task_id = :taskId',
        { id: supersedesId, taskId: task.id },
      );
      if (!prior) throw notFound('被替代的文件不存在');
      version = Number(prior.version) + 1;
    }
    const source =
      input.source === undefined
        ? actor.kind === 'human'
          ? 'human_upload'
          : 'agent_upload'
        : asEnum(input.source, 'source', ['human_upload', 'agent_upload', 'tool_output'] as const);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const size = bytes.byteLength;
    const id = this.ctx.newId();
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO space_files(id, workspace, task_id, subtask_id, message_id, name, mime, size,
                                 sha256, storage, object_key, data, kind, version, supersedes_id,
                                 produced_by, source, status, created_at, deleted_at)
         VALUES(:id, :workspace, :taskId, :subtask, :message, :name, :mime, :size,
                :sha256, 'inline', :objectKey, :data, :kind, :version, :supersedes,
                :producedBy, :source, 'ready', :at, NULL)`,
        {
          id,
          workspace: actor.workspace,
          taskId: task.id,
          subtask: subtaskId,
          message: messageId,
          name,
          mime,
          size,
          sha256,
          objectKey: `inline/${sha256}`,
          data,
          kind,
          version,
          supersedes: supersedesId,
          producedBy: actor.id,
          source,
          at,
        },
      );
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: 'file_uploaded',
        payload: { fileId: id, name, mime, size, sha256, kind, version },
      });
    });
    return {
      id,
      workspace: actor.workspace,
      taskId: task.id,
      subtaskId,
      messageId,
      name,
      mime,
      size,
      sha256,
      storage: 'inline',
      kind,
      version,
      supersedesId,
      producedBy: actor.id,
      producedByName: actor.displayName,
      source,
      status: 'ready',
      createdAt: at,
      deletedAt: null,
    };
  }

  async listFiles(actor: Principal, taskId: string): Promise<SpaceFile[]> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const task = await readTask(this.ctx, actor, taskId);
    const rows = await this.ctx.db.read.all(
      `SELECT f.*, p.display_name AS produced_by_name
       FROM space_files f LEFT JOIN principals p ON p.id = f.produced_by
       WHERE f.task_id = :taskId AND f.status <> 'deleted'
       ORDER BY f.created_at DESC, f.id LIMIT 200`,
      { taskId: task.id },
    );
    return rows.map(toSpaceFile);
  }

  async downloadFile(
    actor: Principal,
    taskId: string,
    fileId: string,
  ): Promise<{ file: SpaceFile; data: string }> {
    await readTask(this.ctx, actor, taskId);
    return this.downloadWorkspaceFile(actor, fileId, taskId);
  }

  /** 文件内容的 JSON 版本；大文件请走 `/content` 流式接口。 */
  async downloadWorkspaceFile(
    actor: Principal,
    fileId: string,
    taskId?: string,
  ): Promise<{ file: SpaceFile; data: string }> {
    const opened = taskId
      ? await this.openTaskContent(actor, taskId, fileId)
      : await this.openContent(actor, fileId);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of opened.stream) {
      const buffer = chunk as Buffer;
      total += buffer.byteLength;
      if (total > MAX_INLINE_DOWNLOAD_BYTES) {
        opened.stream.destroy();
        throw invalid('文件超过 8 MiB，请使用 /content 流式接口下载');
      }
      chunks.push(buffer);
    }
    return { file: opened.file, data: Buffer.concat(chunks).toString('base64') };
  }

  async deleteFile(actor: Principal, taskId: string, fileId: string): Promise<{ id: string; status: string }> {
    const task = await readTask(this.ctx, actor, taskId);
    const row = await this.ctx.db.read.one(
      'SELECT * FROM space_files WHERE id = :id AND task_id = :taskId AND status <> \'deleted\'',
      { id: fileId, taskId: task.id },
    );
    if (!row) throw notFound('文件不存在');
    const allowed =
      String(row.produced_by) === actor.id || task.ownerId === actor.id || hasAnyRole(actor, 'admin');
    if (!allowed) throw forbidden('只有上传者、负责人或管理员可以删除文件');
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        "UPDATE space_files SET status = 'deleted', deleted_at = :at WHERE id = :id AND status <> 'deleted'",
        { at, id: fileId },
      );
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: 'file_deleted',
        payload: { fileId, name: String(row.name) },
      });
    });
    return { id: fileId, status: 'deleted' };
  }

  /**
   * 回收超过保留期的软删除对象。
   *
   * 只处理"所有引用它的文件都已软删除、且最后一条删除时间早于保留期"的对象；
   * 默认只预览（apply=false），真正删除前先移除对象字节，再删对象记录。
   */
  async retention(actor: Principal, days = 30, apply = false): Promise<{
    days: number;
    cutoff: string;
    applied: boolean;
    candidates: { objectKey: string; sha256: string; storage: string; size: number; fileCount: number; lastDeleted: string }[];
    candidatesTruncated: boolean;
    removed: number;
    removedBytes: number;
    skipped: { objectKey: string; reason: string }[];
  }> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以回收文件对象');
    const cutoff = new Date(Date.parse(this.ctx.now()) - days * 86_400_000).toISOString();
    const rows = await this.ctx.db.read.all(
      `SELECT o.sha256, o.storage, o.size, o.object_key,
         (SELECT COUNT(*) FROM space_files f
           WHERE f.workspace = o.workspace AND f.object_key = o.object_key AND f.status = 'ready') AS ready_files,
         (SELECT COUNT(*) FROM space_files f
           WHERE f.workspace = o.workspace AND f.object_key = o.object_key) AS file_count,
         (SELECT MAX(f.deleted_at) FROM space_files f
           WHERE f.workspace = o.workspace AND f.object_key = o.object_key) AS last_deleted
       FROM space_objects o
       WHERE o.workspace = :workspace AND o.deleted_at IS NULL`,
      { workspace: actor.workspace },
    );
    const all = rows
      .filter(row => Number(row.ready_files) === 0
        && Number(row.file_count) > 0
        && row.last_deleted !== null
        && row.last_deleted !== undefined
        && Date.parse(String(row.last_deleted)) <= Date.parse(cutoff))
      .map(row => ({
        objectKey: String(row.object_key),
        sha256: String(row.sha256),
        storage: String(row.storage),
        size: Number(row.size),
        fileCount: Number(row.file_count),
        lastDeleted: String(row.last_deleted),
      }));

    const skipped: { objectKey: string; reason: string }[] = [];
    let removed = 0;
    let removedBytes = 0;
    if (apply) {
      for (const candidate of all) {
        if (candidate.storage !== this.storage.kind) {
          skipped.push({ objectKey: candidate.objectKey, reason: `对象由 ${candidate.storage} 存储保存，当前后端为 ${this.storage.kind}` });
          continue;
        }
        try {
          await this.storage.remove(candidate.objectKey);
          await this.ctx.db.transaction(async tx => {
            await tx.run(
              `DELETE FROM space_objects
               WHERE workspace = :workspace AND sha256 = :sha256 AND storage = :storage`,
              { workspace: actor.workspace, sha256: candidate.sha256, storage: candidate.storage },
            );
          });
          removed += 1;
          removedBytes += candidate.size;
        } catch (error) {
          skipped.push({
            objectKey: candidate.objectKey,
            reason: error instanceof Error ? error.message : '删除对象失败',
          });
        }
      }
    }

    return {
      days,
      cutoff,
      applied: apply,
      candidates: all.slice(0, 200),
      candidatesTruncated: all.length > 200,
      removed,
      removedBytes,
      skipped,
    };
  }

  // ---------------------------------------------------------------- 对象存储上传

  /**
   * 申请上传地址。
   *
   * 本地磁盘驱动返回本服务的 PUT 地址，服务端边收边算哈希；S3 驱动返回
   * 预签名地址，客户端直接把字节送到对象存储。两种方式都只给 15 分钟。
   */
  async createUpload(actor: Principal, body: unknown): Promise<Record<string, unknown>> {
    await requireAgentScope(this.ctx, actor, 'tasks:submit');
    const input = asObject(body);
    const name = asString(input.name, 'name', { max: 200 });
    const mime = asOptionalString(input.mime, 'mime', { max: 200 }) ?? 'application/octet-stream';
    const kind =
      input.kind === undefined
        ? 'intermediate'
        : asEnum(input.kind, 'kind', ['input', 'intermediate', 'output', 'evidence', 'attachment'] as const);
    const size =
      input.size === undefined
        ? null
        : (() => {
            const value = Number(input.size);
            if (!Number.isSafeInteger(value) || value < 0) throw invalid('size 必须是非负整数');
            if (value > this.storage.maxUploadBytes) throw invalid('文件超过大小上限');
            return value;
          })();
    const sha256 =
      input.sha256 === undefined
        ? null
        : (() => {
            const value = asString(input.sha256, 'sha256', { max: 64 }).toLowerCase();
            if (!/^[a-f0-9]{64}$/.test(value)) throw invalid('sha256 必须是 64 位十六进制');
            return value;
          })();
    const taskId =
      input.taskId === undefined || input.taskId === null
        ? null
        : asString(input.taskId, 'taskId', { max: 128 });
    const subtaskId =
      input.subtaskId === undefined || input.subtaskId === null
        ? null
        : asString(input.subtaskId, 'subtaskId', { max: 128 });
    const messageId =
      input.messageId === undefined || input.messageId === null
        ? null
        : asString(input.messageId, 'messageId', { max: 128 });
    const supersedesId =
      input.supersedesId === undefined || input.supersedesId === null
        ? null
        : asString(input.supersedesId, 'supersedesId', { max: 128 });
    const source =
      input.source === undefined
        ? actor.kind === 'human'
          ? 'human_upload'
          : 'agent_upload'
        : asEnum(input.source, 'source', ['human_upload', 'agent_upload', 'tool_output'] as const);

    if (taskId) {
      const task = await readTask(this.ctx, actor, taskId);
      if (subtaskId) {
        const subtask = await this.ctx.db.read.one(
          'SELECT id FROM subtasks WHERE id = :id AND task_id = :taskId',
          { id: subtaskId, taskId: task.id },
        );
        if (!subtask) throw notFound('子任务不存在');
      }
      if (messageId) {
        const message = await this.ctx.db.read.one(
          'SELECT id FROM task_comments WHERE id = :id AND task_id = :taskId',
          { id: messageId, taskId: task.id },
        );
        if (!message) throw notFound('消息不存在');
      }
      if (supersedesId) {
        const prior = await this.ctx.db.read.one(
          'SELECT id FROM space_files WHERE id = :id AND task_id = :taskId AND status <> \'deleted\'',
          { id: supersedesId, taskId: task.id },
        );
        if (!prior) throw notFound('被替代的文件不存在');
      }
    } else if (subtaskId || messageId || supersedesId) {
      throw invalid('没有任务的文件不能关联子任务、消息或被替代版本');
    }

    if (this.storage.kind === 's3' && !sha256) {
      throw invalid('S3 直传需要预先提供 sha256，才能确定对象键');
    }

    const token = randomBytes(32).toString('hex');
    const id = this.ctx.newId();
    const at = this.ctx.now();
    const expiresAt = new Date(Date.parse(at) + UPLOAD_TTL_MINUTES * 60_000).toISOString();
    const objectKey = sha256 ? this.storage.objectKey(actor.workspace, sha256) : null;
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO space_uploads(id, workspace, principal_id, token_hash, name, mime, size, sha256,
                                   storage, object_key, kind, task_id, subtask_id, message_id,
                                   supersedes_id, source, status, created_at, expires_at, completed_file_id)
         VALUES(:id, :workspace, :principal, :tokenHash, :name, :mime, :size, :sha256,
                :storage, :objectKey, :kind, :taskId, :subtaskId, :messageId,
                :supersedesId, :source, 'pending', :at, :expiresAt, NULL)`,
        {
          id,
          workspace: actor.workspace,
          principal: actor.id,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          name,
          mime,
          size,
          sha256,
          storage: this.storage.kind,
          objectKey,
          kind,
          taskId,
          subtaskId,
          messageId,
          supersedesId,
          source,
          at,
          expiresAt,
        },
      );
    });

    const target = objectKey
      ? await this.storage.uploadTarget({ objectKey, mime, size })
      : null;
    const uploadUrl = target?.url ?? `/v1/space/uploads/${token}`;
    return {
      id,
      storage: this.storage.kind,
      method: target?.method ?? 'PUT',
      url: uploadUrl,
      headers: target?.headers ?? { 'content-type': mime, ...(size != null ? { 'content-length': String(size) } : {}) },
      expiresAt,
    };
  }

  /** 无 Bearer 的 PUT 落点：上传令牌本身是能力凭证，且只能写这一份对象。 */
  async receiveUpload(
    token: string,
    source: AsyncIterable<Buffer | string>,
    declaredSize: number | null,
  ): Promise<{ id: string; status: string; size: number; sha256: string }> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw notFound('上传地址无效');
    const row = await this.ctx.db.read.one(
      `SELECT * FROM space_uploads WHERE token_hash = :hash`,
      { hash: createHash('sha256').update(token).digest('hex') },
    );
    if (!row) throw notFound('上传地址无效');
    if (String(row.status) === 'complete') throw conflict('这次上传已经完成');
    if (String(row.status) === 'expired' || Date.parse(String(row.expires_at)) <= Date.parse(this.ctx.now())) {
      await this.ctx.db.run("UPDATE space_uploads SET status = 'expired' WHERE id = :id", { id: String(row.id) });
      throw conflict('上传地址已过期，请重新申请');
    }
    if (declaredSize !== null && declaredSize > this.storage.maxUploadBytes) {
      throw invalid('文件超过大小上限');
    }
    if (declaredSize !== null && row.size !== null && Number(row.size) !== declaredSize) {
      throw invalid('Content-Length 与申请时声明的大小不一致');
    }
    let result;
    try {
      result = await this.storage.put(String(row.workspace), source, this.storage.maxUploadBytes);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : '上传失败');
    }
    if (row.sha256 && String(row.sha256) !== result.sha256) {
      // 内容寻址下，这个对象键可能已被其他文件引用；不能在这里删对象。
      throw invalid('文件哈希与申请时声明的不一致');
    }
    const at = this.ctx.now();
    await this.ctx.db.run(
      `UPDATE space_uploads
       SET status = 'uploaded', size = :size, sha256 = :sha256, object_key = :objectKey
       WHERE id = :id AND status = 'pending'`,
      { id: String(row.id), size: result.size, sha256: result.sha256, objectKey: result.objectKey },
    );
    return { id: String(row.id), status: 'uploaded', size: result.size, sha256: result.sha256 };
  }

  async uploadStatus(actor: Principal, uploadId: string): Promise<Record<string, unknown>> {
    const row = await this.ctx.db.read.one(
      'SELECT * FROM space_uploads WHERE id = :id AND workspace = :workspace AND principal_id = :principal',
      { id: uploadId, workspace: actor.workspace, principal: actor.id },
    );
    if (!row) throw notFound('上传不存在');
    return {
      id: String(row.id),
      status: String(row.status),
      name: String(row.name),
      mime: String(row.mime),
      size: row.size === null || row.size === undefined ? null : Number(row.size),
      sha256: row.sha256 === null || row.sha256 === undefined ? null : String(row.sha256),
      fileId: row.completed_file_id === null || row.completed_file_id === undefined ? null : String(row.completed_file_id),
      expiresAt: String(row.expires_at),
    };
  }

  /** 确认上传并生成文件记录。重复调用返回同一个文件。 */
  async completeUpload(actor: Principal, uploadId: string): Promise<SpaceFile> {
    await requireAgentScope(this.ctx, actor, 'tasks:submit');
    const row = await this.ctx.db.read.one(
      'SELECT * FROM space_uploads WHERE id = :id AND workspace = :workspace AND principal_id = :principal',
      { id: uploadId, workspace: actor.workspace, principal: actor.id },
    );
    if (!row) throw notFound('上传不存在');
    if (String(row.status) === 'expired' || Date.parse(String(row.expires_at)) <= Date.parse(this.ctx.now())) {
      throw conflict('上传地址已过期，请重新申请');
    }
    if (String(row.status) === 'pending') throw conflict('文件还没有上传完成');
    const existingId = row.completed_file_id ? String(row.completed_file_id) : null;
    if (existingId) {
      const existing = await this.ctx.db.read.one('SELECT * FROM space_files WHERE id = :id', { id: existingId });
      if (existing) return toSpaceFile(existing);
    }
    if (String(row.storage) !== this.storage.kind) throw conflict('存储后端已经变化，请重新上传');
    if (!row.object_key) throw conflict('上传缺少对象键，请重新上传');
    const objectKey = String(row.object_key);
    let verified: { size: number; sha256: string };
    try {
      verified = await this.storage.verify(objectKey, {
        size: row.size === null ? null : Number(row.size),
        sha256: row.sha256 === null ? null : String(row.sha256),
      });
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : '对象校验失败');
    }

    const id = this.ctx.newId();
    const at = this.ctx.now();
    const taskId = row.task_id === null || row.task_id === undefined ? null : String(row.task_id);
    if (taskId) await readTask(this.ctx, actor, taskId);
    let version = 1;
    if (row.supersedes_id && taskId) {
      const prior = await this.ctx.db.read.one(
        'SELECT version FROM space_files WHERE id = :id AND task_id = :taskId',
        { id: String(row.supersedes_id), taskId },
      );
      if (!prior) throw notFound('被替代的文件不存在');
      version = Number(prior.version) + 1;
    }

    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO space_objects(workspace, sha256, storage, size, object_key, created_at, deleted_at)
         VALUES(:workspace, :sha256, :storage, :size, :objectKey, :at, NULL)
         ON CONFLICT(workspace, sha256, storage) DO NOTHING`,
        {
          workspace: actor.workspace,
          sha256: verified.sha256,
          storage: this.storage.kind,
          size: verified.size,
          objectKey,
          at,
        },
      );
      await tx.run(
        `INSERT INTO space_files(id, workspace, task_id, subtask_id, message_id, name, mime, size,
                                 sha256, storage, object_key, data, kind, version, supersedes_id,
                                 produced_by, source, status, created_at, deleted_at)
         VALUES(:id, :workspace, :taskId, :subtask, :message, :name, :mime, :size,
                :sha256, :storage, :objectKey, NULL, :kind, :version, :supersedes,
                :producedBy, :source, 'ready', :at, NULL)`,
        {
          id,
          workspace: actor.workspace,
          taskId,
          subtask: row.subtask_id === null || row.subtask_id === undefined ? null : String(row.subtask_id),
          message: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
          name: String(row.name),
          mime: String(row.mime),
          size: verified.size,
          sha256: verified.sha256,
          storage: this.storage.kind,
          objectKey,
          kind: String(row.kind),
          version,
          supersedes: row.supersedes_id === null || row.supersedes_id === undefined ? null : String(row.supersedes_id),
          producedBy: actor.id,
          source: String(row.source),
          at,
        },
      );
      await tx.run(
        "UPDATE space_uploads SET status = 'complete', completed_file_id = :file WHERE id = :id",
        { id: uploadId, file: id },
      );
      if (taskId) {
        await appendEvent(this.ctx, tx, {
          taskId,
          actorId: actor.id,
          type: 'file_uploaded',
          payload: { fileId: id, name: String(row.name), mime: String(row.mime), size: verified.size, sha256: verified.sha256, kind: String(row.kind), version },
        });
      }
    });

    return {
      id,
      workspace: actor.workspace,
      taskId,
      subtaskId: row.subtask_id === null || row.subtask_id === undefined ? null : String(row.subtask_id),
      messageId: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
      name: String(row.name),
      mime: String(row.mime),
      size: verified.size,
      sha256: verified.sha256,
      storage: this.storage.kind,
      kind: String(row.kind) as SpaceFileKind,
      version,
      supersedesId: row.supersedes_id === null || row.supersedes_id === undefined ? null : String(row.supersedes_id),
      producedBy: actor.id,
      producedByName: actor.displayName,
      source: String(row.source) as SpaceFile['source'],
      status: 'ready',
      createdAt: at,
      deletedAt: null,
    };
  }

  /** 读取文件字节流。任务文件沿用任务可见性；独立附件按团队空间可见。 */
  async openContent(
    actor: Principal,
    fileId: string,
    rangeHeader?: string,
  ): Promise<{
    file: SpaceFile;
    stream: Readable;
    size: number;
    range: { start: number; end: number } | null;
  }> {
    const row = await this.ctx.db.read.one(
      `SELECT f.*, p.display_name AS produced_by_name
       FROM space_files f LEFT JOIN principals p ON p.id = f.produced_by
       WHERE f.id = :id AND f.workspace = :workspace AND f.status = 'ready'`,
      { id: fileId, workspace: actor.workspace },
    );
    if (!row) throw notFound('文件不存在');
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    if (row.task_id !== null && row.task_id !== undefined) {
      await readTask(this.ctx, actor, String(row.task_id));
    } else if (String(row.produced_by) !== actor.id && !hasAnyRole(actor, 'admin', 'reviewer')) {
      // 独立附件默认只对上传者与管理员可见；挂到文档后，按文档的可见性放行。
      const docs = await this.ctx.db.read.all(
        `SELECT k.* FROM knowledge_assets a JOIN knowledge k ON k.id = a.knowledge_id
         WHERE a.file_id = :file`,
        { file: fileId },
      );
      let readable = false;
      for (const doc of docs) {
        if (await this.canReadKnowledge(actor, String(doc.id), doc)) {
          readable = true;
          break;
        }
      }
      if (!readable) throw forbidden('无权读取该附件');
    }
    const file = toSpaceFile(row);
    const total = Number(row.size);
    const range = parseByteRange(rangeHeader, total);
    if (String(row.storage) === 'inline') {
      const bytes = Buffer.from(String(row.data ?? ''), 'base64');
      const slice = range ? bytes.subarray(range.start, range.end + 1) : bytes;
      return { file, stream: Readable.from(slice), size: total, range };
    }
    if (!row.object_key) throw notFound('文件对象不存在');
    try {
      const opened = await this.storage.open(String(row.object_key), range ?? undefined);
      return { file, stream: opened.stream, size: total, range };
    } catch {
      throw notFound('文件对象不存在');
    }
  }

  async openTaskContent(
    actor: Principal,
    taskId: string,
    fileId: string,
    rangeHeader?: string,
  ): Promise<{ file: SpaceFile; stream: Readable; size: number; range: { start: number; end: number } | null }> {
    await readTask(this.ctx, actor, taskId);
    const result = await this.openContent(actor, fileId, rangeHeader);
    if (result.file.taskId !== taskId) throw notFound('文件不存在');
    return result;
  }

  /** 独立附件的软删除；任务文件仍走任务权限。 */
  async deleteWorkspaceFile(actor: Principal, fileId: string): Promise<{ id: string; status: string }> {
    await requireAgentScope(this.ctx, actor, 'tasks:submit');
    const row = await this.ctx.db.read.one(
      'SELECT * FROM space_files WHERE id = :id AND workspace = :workspace AND status <> \'deleted\'',
      { id: fileId, workspace: actor.workspace },
    );
    if (!row) throw notFound('文件不存在');
    if (row.task_id !== null && row.task_id !== undefined) {
      return this.deleteFile(actor, String(row.task_id), fileId);
    }
    const allowed = String(row.produced_by) === actor.id || hasAnyRole(actor, 'admin');
    if (!allowed) throw forbidden('只有上传者或管理员可以删除附件');
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        "UPDATE space_files SET status = 'deleted', deleted_at = :at WHERE id = :id AND status <> 'deleted'",
        { at: this.ctx.now(), id: fileId },
      );
    });
    return { id: fileId, status: 'deleted' };
  }

  /** 我被提及但还没读的评论。 */
  async mentions(actor: Principal): Promise<TaskComment[]> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const rows = await this.ctx.db.read.all(
      `SELECT c.*, m.id AS mention_id, p.display_name AS author_name, p.avatar AS author_avatar,
              p.kind AS author_kind, t.title AS task_title
       FROM task_mentions m
       JOIN task_comments c ON c.id = m.comment_id
       JOIN tasks t ON t.id = m.task_id
       JOIN principals p ON p.id = c.author_id
       WHERE m.workspace = :workspace AND m.recipient_id = :actor AND m.read_at IS NULL
       ORDER BY m.created_at DESC LIMIT 100`,
      { workspace: actor.workspace, actor: actor.id },
    );
    return rows.map(row => ({ ...toComment(row), mentionId: String(row.mention_id) }));
  }

  async readMention(actor: Principal, mentionId: string): Promise<{ id: string; read: true }> {
    const changed = await this.ctx.db.transaction(async tx =>
      tx.run(
        `UPDATE task_mentions SET read_at = :at
         WHERE id = :id AND workspace = :workspace AND recipient_id = :actor AND read_at IS NULL`,
        { at: this.ctx.now(), id: mentionId, workspace: actor.workspace, actor: actor.id },
      ),
    );
    if (changed === 0) throw notFound('提醒不存在或已读');
    return { id: mentionId, read: true };
  }

  // ---------------------------------------------------------------- 任务房间

  /** 把任务进展、对话、文件与经验合并成一条时间线。 */
  async room(actor: Principal, taskId: string): Promise<TaskRoom> {
    const task = await readTask(this.ctx, actor, taskId);
    const [threads, messages, files] = await Promise.all([
      this.listThreads(actor, task.id),
      this.listComments(actor, task.id, { limit: 200 }),
      this.listFiles(actor, task.id),
    ]);

    const participantRows = await this.ctx.db.read.all(
      `SELECT p.id, p.display_name, p.kind, p.avatar,
              CASE
                WHEN p.id = :owner THEN 'owner'
                WHEN EXISTS (SELECT 1 FROM task_coordinators c
                             WHERE c.task_id = :taskId AND c.principal_id = p.id) THEN 'coordinator'
                WHEN EXISTS (SELECT 1 FROM subtasks s
                             WHERE s.task_id = :taskId AND s.agent_id = p.id) THEN 'agent'
                ELSE 'participant'
              END AS role
       FROM principals p
       WHERE p.workspace = :workspace AND (
         p.id = :owner
         OR EXISTS (SELECT 1 FROM task_coordinators c
                    WHERE c.task_id = :taskId AND c.principal_id = p.id)
         OR EXISTS (SELECT 1 FROM subtasks s
                    WHERE s.task_id = :taskId AND s.agent_id = p.id)
         OR EXISTS (SELECT 1 FROM task_comments c
                    WHERE c.task_id = :taskId AND c.author_id = p.id)
       )
       ORDER BY p.display_name`,
      { workspace: actor.workspace, taskId: task.id, owner: task.ownerId },
    );

    const knowledgeRows = await this.ctx.db.read.all(
      `SELECT k.*, p.display_name AS author_name FROM knowledge k
       LEFT JOIN principals p ON p.id = k.author_id
       WHERE k.workspace = :workspace AND k.state = 'published'
         AND (k.expires_at IS NULL OR k.expires_at > :now)
         AND (k.task_id = :taskId OR EXISTS (
              SELECT 1 FROM knowledge_refs r WHERE r.task_id = :taskId AND r.knowledge_id = k.id)
            OR EXISTS (
              SELECT 1 FROM knowledge_assets a JOIN space_files f ON f.id = a.file_id
              WHERE f.task_id = :taskId AND f.deleted_at IS NULL AND a.knowledge_id = k.id))
       ORDER BY k.updated_at DESC LIMIT 50`,
      { workspace: actor.workspace, taskId: task.id, now: this.ctx.now() },
    );
    const knowledge = knowledgeRows.map(row => ({
      id: String(row.id),
      workspace: String(row.workspace),
      sourceTaskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
      content: String(row.content),
      conditions: String(row.conditions),
      state: String(row.state) as TaskRoom['knowledge'][number]['state'],
      version: Number(row.version),
      authorId: String(row.author_id),
      reviewerId: row.reviewer_id === null || row.reviewer_id === undefined ? null : String(row.reviewer_id),
      expiresAt: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
      accessMode: String(row.access_mode) as 'workspace' | 'restricted',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      kind: String(row.kind) as TaskRoom['knowledge'][number]['kind'],
      title: String(row.title ?? ''),
      summary: String(row.summary ?? ''),
      tags: typeof row.tags === 'string' ? (parseJson(row.tags, []) as string[]) : [],
      source: String(row.source) as TaskRoom['knowledge'][number]['source'],
      evidenceLevel: String(row.evidence_level) as TaskRoom['knowledge'][number]['evidenceLevel'],
      archivedAt: row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
      authorName: String(row.author_name ?? row.author_id),
    }));

    const counts = {
      messages: messages.length,
      threadsOpen: threads.filter(thread => thread.status === 'open').length,
      files: files.length,
      knowledge: knowledge.length,
    };

    const eventRows = await this.ctx.db.read.all(
      `SELECT e.*, p.display_name AS actor_name
       FROM events e LEFT JOIN principals p ON p.id = e.actor_id
       WHERE e.task_id = :taskId AND e.type NOT IN ('comment_added','message_added')
       ORDER BY e.seq DESC LIMIT 100`,
      { taskId: task.id },
    );
    const activity: RoomActivity[] = eventRows.map(row => {
      const payload = parseJson(row.payload, {}) as Record<string, unknown>;
      return {
        at: String(row.recorded_at),
        stream: 'event',
        type: String(row.type),
        actorId: String(row.actor_id),
        actorName: String(row.actor_name ?? row.actor_id),
        summary: eventSummary(String(row.type), payload),
        taskId: task.id,
        payload,
      };
    });
    for (const message of messages) {
      activity.push({
        at: message.createdAt,
        stream: 'message',
        type: message.kind,
        actorId: message.authorId,
        actorName: message.authorName,
        summary: message.body.slice(0, 140),
        taskId: task.id,
        payload: { messageId: message.id, threadId: message.threadId },
      });
    }
    for (const file of files) {
      activity.push({
        at: file.createdAt,
        stream: 'file',
        type: 'file_uploaded',
        actorId: file.producedBy,
        actorName: file.producedByName,
        summary: `${file.name}（${file.kind}）`,
        taskId: task.id,
        payload: { fileId: file.id, sha256: file.sha256, size: file.size },
      });
    }
    for (const item of knowledge) {
      activity.push({
        at: item.updatedAt,
        stream: 'knowledge',
        type: `aicd_${item.state}`,
        actorId: item.authorId,
        actorName: item.authorName ?? item.authorId,
        summary: item.title,
        taskId: task.id,
        payload: { id: item.id, version: item.version },
      });
    }
    activity.sort((left, right) => left.at.localeCompare(right.at) || left.type.localeCompare(right.type));
    const unread = await this.unreadFor(actor, task.id, messages);

    return {
      task,
      participants: participantRows.map(row => ({
        id: String(row.id),
        displayName: String(row.display_name),
        kind: String(row.kind) as 'human' | 'agent' | 'service',
        avatar: String(row.avatar ?? ''),
        role: String(row.role),
      })),
      counts,
      threads,
      messages,
      files,
      activity: activity.slice(-200),
      knowledge,
      unread: { messages: unread.messages, questions: unread.questions, mentions: unread.mentions },
      lastReadAt: unread.lastReadAt,
    };
  }

  /** 房间未读：按每人每任务的游标计算，不改变任务版本。 */
  private async unreadFor(
    actor: Principal,
    taskId: string,
    messages?: TaskComment[],
  ): Promise<{ messages: number; questions: number; mentions: number; lastReadAt: string | null }> {
    const read = await this.ctx.db.read.one(
      'SELECT last_read_at FROM task_reads WHERE task_id = :taskId AND principal_id = :principal',
      { taskId, principal: actor.id },
    );
    const lastReadAt = read ? String(read.last_read_at) : null;
    const rows = messages ?? (await this.listComments(actor, taskId, { limit: 500 }));
    const others = rows.filter(item => item.authorId !== actor.id);
    const fresh = others.filter(item => !lastReadAt || item.createdAt > lastReadAt);
    const answered = new Set(rows.map(item => item.replyTo).filter((id): id is string => Boolean(id)));
    const questions = fresh.filter(
      item => item.kind === 'question' && addressedTo(item.payload).includes(actor.id) && !answered.has(item.id),
    );
    const mention = await this.ctx.db.read.one(
      `SELECT COUNT(*) AS count FROM task_mentions
       WHERE task_id = :taskId AND recipient_id = :principal AND read_at IS NULL`,
      { taskId, principal: actor.id },
    );
    return {
      messages: fresh.length,
      questions: questions.length,
      mentions: Number(mention?.count ?? 0),
      lastReadAt,
    };
  }

  /** 把房间标为已读：只移动游标，不产生事件，也不推进任务版本。 */
  async markRead(
    actor: Principal,
    taskId: string,
  ): Promise<{ taskId: string; lastReadAt: string; unread: { messages: number; questions: number; mentions: number } }> {
    const task = await readTask(this.ctx, actor, taskId);
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO task_reads(workspace, task_id, principal_id, last_read_at)
         VALUES(:workspace, :taskId, :principal, :at)
         ON CONFLICT(task_id, principal_id) DO UPDATE SET last_read_at = :at`,
        { workspace: actor.workspace, taskId: task.id, principal: actor.id, at },
      );
      await tx.run(
        `UPDATE task_mentions SET read_at = :at
         WHERE task_id = :taskId AND recipient_id = :principal AND read_at IS NULL`,
        { at, taskId: task.id, principal: actor.id },
      );
    });
    return { taskId: task.id, lastReadAt: at, unread: { messages: 0, questions: 0, mentions: 0 } };
  }

  /** 点名问我的、尚未回答的问题；供智能体待办与 CLI 使用。 */
  async questionsFor(actor: Principal): Promise<TaskComment[]> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const teamVisible = await this.teamVisible(actor);
    const rows = await this.ctx.db.read.all(
      `SELECT c.*, p.display_name AS author_name, p.avatar AS author_avatar, p.kind AS author_kind,
              t.title AS task_title
       FROM task_comments c
       JOIN tasks t ON t.id = c.task_id
       LEFT JOIN principals p ON p.id = c.author_id
       WHERE t.workspace = :workspace AND c.kind = 'question' AND c.payload LIKE :needle
         AND ${this.visibleTaskSql}
       ORDER BY c.created_at DESC LIMIT 200`,
      { workspace: actor.workspace, principal: actor.id, teamVisible, needle: `%"${actor.id}"%` },
    );
    const replies = new Set<string>();
    const answered = await this.ctx.db.read.all(
      `SELECT c.task_id, c.reply_to FROM task_comments c JOIN tasks t ON t.id = c.task_id
       WHERE t.workspace = :workspace AND c.reply_to IS NOT NULL`,
      { workspace: actor.workspace },
    );
    for (const row of answered) replies.add(`${String(row.task_id)}|${String(row.reply_to)}`);

    return rows
      .map(toComment)
      .filter(item => !replies.has(`${item.taskId}|${item.id}`))
      .filter(item => {
        // payload 可能含有相似字符串，最终仍以解析后的收件人为准。
        return addressedTo(item.payload).includes(actor.id);
      });
  }

  /** 当前主体能看到的任务集合；与 readTask 的规则保持一致。 */
  private async teamVisible(actor: Principal): Promise<number> {
    if (actor.kind !== 'human' || actor.tenantRole === 'guest') return 0;
    const tenant = await this.ctx.db.read.one('SELECT personal, status FROM tenants WHERE id = :id', {
      id: actor.workspace,
    });
    return tenant && Number(tenant.personal) === 0 && String(tenant.status) === 'active' ? 1 : 0;
  }

  private readonly visibleTaskSql = `(t.owner_id = :principal
    OR EXISTS (SELECT 1 FROM task_coordinators tc WHERE tc.task_id = t.id AND tc.principal_id = :principal)
    OR EXISTS (SELECT 1 FROM subtasks ts WHERE ts.task_id = t.id AND ts.agent_id = :principal)
    OR :teamVisible = 1)`;

  /** 跨任务检索消息、文件与已发布文档；结果只含调用方有权读取的内容。 */
  async search(
    actor: Principal,
    query: string,
  ): Promise<{
    query: string;
    messages: (TaskComment & { taskTitle: string })[];
    files: (SpaceFile & { taskTitle: string | null })[];
    knowledge: { id: string; title: string; summary: string; kind: string; version: number; state: string }[];
  }> {
    const text = query.trim();
    if (!text) throw invalid('检索词不能为空');
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const needle = `%${text.toLowerCase()}%`;
    const teamVisible = await this.teamVisible(actor);

    const messageRows = await this.ctx.db.read.all(
      `SELECT c.*, p.display_name AS author_name, p.avatar AS author_avatar, p.kind AS author_kind,
              t.title AS task_title
       FROM task_comments c
       JOIN tasks t ON t.id = c.task_id
       LEFT JOIN principals p ON p.id = c.author_id
       WHERE t.workspace = :workspace AND LOWER(c.body) LIKE :needle
         AND ${this.visibleTaskSql}
       ORDER BY c.created_at DESC LIMIT 50`,
      { workspace: actor.workspace, principal: actor.id, teamVisible, needle },
    );
    const fileRows = await this.ctx.db.read.all(
      `SELECT f.*, t.title AS task_title, p.display_name AS produced_by_name
       FROM space_files f
       JOIN tasks t ON t.id = f.task_id
       LEFT JOIN principals p ON p.id = f.produced_by
       WHERE f.workspace = :workspace AND f.status = 'ready'
         AND (LOWER(f.name) LIKE :needle OR LOWER(f.mime) LIKE :needle)
         AND ${this.visibleTaskSql}
       ORDER BY f.created_at DESC LIMIT 50`,
      { workspace: actor.workspace, principal: actor.id, teamVisible, needle },
    );

    const knowledgeRows = await this.ctx.db.read.all(
      `SELECT k.* FROM knowledge k
       WHERE k.workspace = :workspace AND k.state = 'published'
         AND (k.expires_at IS NULL OR k.expires_at > :now)
         AND (LOWER(k.title) LIKE :needle OR LOWER(k.summary) LIKE :needle OR LOWER(k.content) LIKE :needle)
       ORDER BY k.updated_at DESC LIMIT 50`,
      { workspace: actor.workspace, needle, now: this.ctx.now() },
    );
    const knowledge: { id: string; title: string; summary: string; kind: string; version: number; state: string }[] = [];
    for (const row of knowledgeRows) {
      const id = String(row.id);
      if (!(await this.canReadKnowledge(actor, id, row))) continue;
      knowledge.push({
        id,
        title: String(row.title ?? ''),
        summary: String(row.summary ?? ''),
        kind: String(row.kind ?? 'document'),
        version: Number(row.version),
        state: String(row.state),
      });
      if (knowledge.length >= 20) break;
    }

    return {
      query: text,
      messages: messageRows.map(row => { const item = toComment(row) as TaskComment & { taskTitle: string }; item.taskTitle = String(row.task_title); return item; }).slice(0, 20),
      files: fileRows.map(row => { const item = toSpaceFile(row) as SpaceFile & { taskTitle: string | null }; item.taskTitle = row.task_title === null || row.task_title === undefined ? null : String(row.task_title); return item; }).slice(0, 20),
      knowledge,
    };
  }

  /** 文档可见性：管理员/审核人、公开范围、授权名单或作者本人。 */
  private async canReadKnowledge(
    actor: Principal,
    knowledgeId: string,
    row: Record<string, unknown>,
  ): Promise<boolean> {
    if (hasAnyRole(actor, 'admin', 'reviewer')) return true;
    if (String(row.author_id) === actor.id) return true;
    if (String(row.access_mode ?? 'workspace') === 'workspace') return true;
    const grant = await this.ctx.db.read.one(
      'SELECT 1 AS present FROM knowledge_grants WHERE knowledge_id = :id AND principal_id = :principal',
      { id: knowledgeId, principal: actor.id },
    );
    return Boolean(grant);
  }

  /**
   * 团队首页的「需要你」队列：提问、未读提醒、待验收与我可接管的提案。
   * 只汇总已有事实，不改任何状态。
   */
  async home(actor: Principal): Promise<{
    totals: { questions: number; mentions: number; reviews: number; proposals: number };
    needsYou: { taskId: string; taskTitle: string; kind: 'question' | 'mention' | 'review' | 'proposal'; id: string; title: string; at: string }[];
    generatedAt: string;
  }> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const teamVisible = await this.teamVisible(actor);
    const canReview = hasAnyRole(actor, 'admin', 'reviewer') ? 1 : 0;
    const params = { workspace: actor.workspace, principal: actor.id, teamVisible, canReview, needle: `%"${actor.id}"%` };

    const questionRows = await this.ctx.db.read.all(
      `SELECT c.id, c.body, c.payload, c.created_at, c.task_id, t.title AS task_title
       FROM task_comments c JOIN tasks t ON t.id = c.task_id
       WHERE t.workspace = :workspace AND c.kind = 'question' AND c.payload LIKE :needle
         AND t.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM task_comments a WHERE a.task_id = c.task_id AND a.reply_to = c.id)
         AND NOT EXISTS (SELECT 1 FROM task_threads th WHERE th.id = c.thread_id AND th.status = 'resolved')
         AND ${this.visibleTaskSql}
       ORDER BY c.created_at DESC LIMIT 50`,
      params,
    );
    const questions = questionRows.filter(row => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(row.payload ?? '{}')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // payload 不是 JSON 时按无收件人处理。
      }
      return addressedTo(payload).includes(actor.id);
    });

    const mentionRows = await this.ctx.db.read.all(
      `SELECT m.id, m.created_at, c.body, c.task_id, t.title AS task_title
       FROM task_mentions m
       JOIN task_comments c ON c.id = m.comment_id
       JOIN tasks t ON t.id = m.task_id
       WHERE m.workspace = :workspace AND m.recipient_id = :principal AND m.read_at IS NULL
         AND c.kind <> 'question'
         AND t.archived_at IS NULL
         AND ${this.visibleTaskSql}
       ORDER BY m.created_at DESC LIMIT 50`,
      params,
    );

    const reviewRows = await this.ctx.db.read.all(
      `SELECT t.id, t.title, t.updated_at FROM tasks t
       WHERE t.workspace = :workspace AND t.status = 'review'
         AND t.archived_at IS NULL
         AND (t.owner_id = :principal
           OR EXISTS (SELECT 1 FROM task_coordinators tc WHERE tc.task_id = t.id AND tc.principal_id = :principal)
           OR :canReview = 1)
       ORDER BY t.updated_at DESC LIMIT 50`,
      params,
    );

    const proposalRows = await this.ctx.db.read.all(
      `SELECT t.id, t.title, t.created_at FROM tasks t
       WHERE t.workspace = :workspace AND t.origin = 'agent' AND t.status = 'pending'
         AND t.adopted_at IS NULL AND t.archived_at IS NULL
         AND (t.owner_id = :principal OR :teamVisible = 1 OR :canReview = 1)
       ORDER BY t.created_at DESC LIMIT 50`,
      params,
    );

    const needsYou = [
      ...questions.map(row => ({
        taskId: String(row.task_id),
        taskTitle: String(row.task_title),
        kind: 'question' as const,
        id: String(row.id),
        title: String(row.body).replace(/\s+/g, ' ').slice(0, 140),
        at: String(row.created_at),
      })),
      ...mentionRows.map(row => ({
        taskId: String(row.task_id),
        taskTitle: String(row.task_title),
        kind: 'mention' as const,
        id: String(row.id),
        title: String(row.body).replace(/\s+/g, ' ').slice(0, 140),
        at: String(row.created_at),
      })),
      ...reviewRows.map(row => ({
        taskId: String(row.id),
        taskTitle: String(row.title),
        kind: 'review' as const,
        id: String(row.id),
        title: `任务「${String(row.title)}」等你验收`,
        at: String(row.updated_at),
      })),
      ...proposalRows.map(row => ({
        taskId: String(row.id),
        taskTitle: String(row.title),
        kind: 'proposal' as const,
        id: String(row.id),
        title: `智能体提案「${String(row.title)}」等你接管`,
        at: String(row.created_at),
      })),
    ].sort((left, right) => right.at.localeCompare(left.at));

    return {
      totals: {
        questions: questions.length,
        mentions: mentionRows.length,
        reviews: reviewRows.length,
        proposals: proposalRows.length,
      },
      needsYou: needsYou.slice(0, 30),
      generatedAt: this.ctx.now(),
    };
  }

  /**
   * 交接包：给"换一个进程接着做"的智能体一份紧凑事实。
   * 与 UI 同源，不另造一套状态；文件给出带令牌访问的下载地址。
   */
  async contextPack(
    actor: Principal,
    taskId: string,
    origin: string,
  ): Promise<{ markdown: string; manifest: Record<string, unknown> }> {
    const room = await this.room(actor, taskId);
    const { task } = room;
    const summaryRow = await this.ctx.db.read.one(
      'SELECT * FROM task_summaries WHERE task_id = :taskId ORDER BY version DESC LIMIT 1',
      { taskId: task.id },
    );
    const base = origin.replace(/\/+$/, '');
    const files = room.files.map(file => ({
      ...file,
      downloadUrl: `${base}/v1/tasks/${encodeURIComponent(task.id)}/files/${encodeURIComponent(file.id)}/content`,
    }));
    const recent = room.messages.slice(-20);
    const pendingRow = await this.ctx.db.read.one(
      `SELECT COUNT(*) AS count FROM subtasks
       WHERE task_id = :taskId AND status IN ('invited','accepted','returned')`,
      { taskId: task.id },
    );
    const manifest = {
      task: {
        id: task.id,
        title: task.title,
        type: task.type,
        status: task.status,
        version: task.version,
        goal: task.goal,
        acceptance: task.acceptance,
        dueAt: task.dueAt,
        ownerId: task.ownerId,
      },
      generatedAt: this.ctx.now(),
      generatedBy: actor.id,
      stageSummary: summaryRow
        ? {
            version: Number(summaryRow.version),
            text: String(summaryRow.text),
            pending: String(summaryRow.pending),
            createdAt: String(summaryRow.created_at),
          }
        : null,
      pendingSubtasks: Number(pendingRow?.count ?? 0),
      threads: room.threads,
      messages: recent,
      files,
      knowledge: room.knowledge.map(item => ({
        id: item.id,
        version: item.version,
        title: item.title,
        summary: item.summary,
        kind: item.kind,
        state: item.state,
      })),
      unread: room.unread,
    };

    const lines: string[] = [];
    lines.push(`# 任务交接包：${task.title}`, '');
    lines.push(`- 任务 ID：${task.id}`);
    lines.push(`- 类型：${task.type}`);
    lines.push(`- 状态：${task.status}（v${task.version}）`);
    lines.push(`- 负责人：${task.ownerId}`);
    if (task.dueAt) lines.push(`- 截止：${task.dueAt}`);
    lines.push(`- 生成时间：${manifest.generatedAt}`);
    lines.push('', '## 目标', '', task.goal || '（未填写）');
    lines.push('', '## 验收条件', '', task.acceptance || '（未填写）');
    if (summaryRow) {
      lines.push(
        '',
        `## 当前阶段摘要（v${Number(summaryRow.version)}）`,
        '',
        String(summaryRow.text),
        '',
        `未决：${String(summaryRow.pending) || '无'}`,
      );
    }
    const openThreads = room.threads.filter(item => item.status === 'open');
    lines.push('', '## 未决线程', '');
    lines.push(openThreads.length ? openThreads.map(item => `- ${item.topic}（${item.id}）`).join('\n') : '无');
    lines.push('', `## 最近对话（${recent.length} 条）`, '');
    lines.push(
      recent.length
        ? recent
            .map(
              item =>
                `- ${item.createdAt} [${item.kind}] ${item.authorName}：${item.body.replace(/\s+/g, ' ').slice(0, 300)}`,
            )
            .join('\n')
        : '无',
    );
    lines.push('', `## 文件（${files.length} 个）`, '');
    lines.push(
      files.length
        ? files
            .map(
              file =>
                `- ${file.name}（${file.kind}，${file.size} 字节，sha256 ${file.sha256.slice(0, 16)}…）` +
                `\n  下载：${file.downloadUrl}`,
            )
            .join('\n')
        : '无',
    );
    lines.push('', `## 相关文档（${room.knowledge.length} 份）`, '');
    lines.push(
      room.knowledge.length
        ? room.knowledge
            .map(item => `- ${item.title || item.id}（v${item.version}，${item.kind}）`)
            .join('\n')
        : '无',
    );
    lines.push('', '## 未读', '', `- 消息：${room.unread.messages}，点我问：${room.unread.questions}`);

    return { markdown: lines.join('\n'), manifest };
  }

  // ---------------------------------------------------------------- 开放认领

  /**
   * 把一个子任务挂到开放池。
   *
   * 与"指派"的区别是**谁发起**：指派是人点名，认领是智能体自己举手。
   * 认领产生的子任务仍然是 `invited`，仍要接受、执行、提交、验收——
   * 认领改变的是分工方式，不改变责任链。
   */
  async createOffer(actor: Principal, taskId: string, body: unknown): Promise<TaskOffer> {
    const task = await readTask(this.ctx, actor, taskId);
    if (task.ownerId !== actor.id && !hasAnyRole(actor, 'admin')) {
      const coordinator = await this.ctx.db.read.one(
        'SELECT 1 AS present FROM task_coordinators WHERE task_id = :taskId AND principal_id = :actor',
        { taskId: task.id, actor: actor.id },
      );
      if (!coordinator) throw forbidden('只有负责人、协调者或管理员可以发布开放子任务');
    }
    const input = asObject(body);
    const kind = asString(input.kind, 'kind', { max: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ });
    const description =
      input.description === undefined ? '' : asString(input.description, 'description', { max: 1000, min: 0 });
    const capability =
      input.capability === undefined || input.capability === null || input.capability === ''
        ? null
        : asString(input.capability, 'capability', { max: 100 });
    const dueAt =
      input.dueAt === undefined
        ? new Date(Date.parse(this.ctx.now()) + DEFAULT_OFFER_DAYS * 86_400_000).toISOString()
        : asString(input.dueAt, 'dueAt', { max: 64 });

    const id = this.ctx.newId();
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO task_offers(id, workspace, task_id, kind, description, capability, due_at, status,
                                 created_by, claimed_by, claimed_at, subtask_id, created_at)
         VALUES(:id, :workspace, :taskId, :kind, :description, :capability, :dueAt, 'open',
                :createdBy, NULL, NULL, NULL, :at)`,
        {
          id,
          workspace: actor.workspace,
          taskId: task.id,
          kind,
          description,
          capability,
          dueAt,
          createdBy: actor.id,
          at,
        },
      );
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: 'offer_published',
        payload: { offerId: id, kind, capability, dueAt },
      });
    });
    return {
      id,
      taskId: task.id,
      kind,
      description,
      capability,
      dueAt,
      status: 'open',
      createdBy: actor.id,
      claimedBy: null,
      claimedAt: null,
      subtaskId: null,
      createdAt: at,
    };
  }

  async listOffers(actor: Principal, taskId: string): Promise<TaskOffer[]> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const task = await readTask(this.ctx, actor, taskId);
    const rows = await this.ctx.db.read.all(
      'SELECT * FROM task_offers WHERE task_id = :taskId ORDER BY created_at DESC LIMIT 100',
      { taskId: task.id },
    );
    return rows.map(toOffer);
  }

  /**
   * 开放池。
   *
   * 这是平台里**唯一**的广播面，也是有意的例外：智能体看不到别人的任务，
   * 但"有人挂了一份我还不知道的工作"必须能被它发现，否则认领就不成立。
   * 广播的只有 offer 自己的字段与任务标题，不含目标、输入、其他人的结果。
   */
  async openOffers(actor: Principal): Promise<TaskOffer[]> {
    const rows = await this.ctx.db.read.all(
      `SELECT o.*, t.title AS task_title FROM task_offers o JOIN tasks t ON t.id = o.task_id
       WHERE o.workspace = :workspace AND o.status = 'open' AND t.status IN ('pending','running')
       ORDER BY o.due_at LIMIT 100`,
      { workspace: actor.workspace },
    );
    const offers = rows.map(row => ({ ...toOffer(row), taskTitle: String(row.task_title ?? '') }));
    if (!actor.roles.includes('agent')) return [];
    return offers.filter(offer => !offer.capability || actor.capabilities.includes(offer.capability));
  }

  async claimOffer(actor: Principal, offerId: string): Promise<{ offerId: string; subtaskId: string }> {
    if (!hasAnyRole(actor, 'agent')) throw forbidden('只有智能体可以认领开放子任务');
    await requireAgentScope(this.ctx, actor, 'offers:claim');
    const offer = await this.ctx.db.read.one('SELECT * FROM task_offers WHERE id = :id AND workspace = :workspace', {
      id: offerId,
      workspace: actor.workspace,
    });
    if (!offer) throw notFound('开放子任务不存在');
    if (String(offer.status) !== 'open') throw conflict('该子任务已被认领或已撤回');
    if (offer.capability && !actor.capabilities.includes(String(offer.capability))) {
      throw forbidden(`该子任务要求能力 ${String(offer.capability)}，你的能力声明里没有`);
    }

    // 认领本身就是"加入这个任务"的动作，所以这里只校验工作空间与任务状态，
    // 不要求事先读得到它；认领成功后子任务建立，任务详情自然对认领者可见。
    const task = await loadTask(this.ctx, actor, String(offer.task_id));
    if (task.status !== 'pending' && task.status !== 'running') throw conflict('该任务已不再接受新的子任务');

    const existing = await this.ctx.db.read.one(
      'SELECT id FROM subtasks WHERE task_id = :taskId AND agent_id = :actor AND kind = :kind',
      { taskId: String(offer.task_id), actor: actor.id, kind: String(offer.kind) },
    );
    if (existing) throw conflict('你已经承担了这个任务的同类子任务');

    const subtaskId = this.ctx.newId();
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      const claimed = await tx.run(
        `UPDATE task_offers SET status = 'claimed', claimed_by = :actor, claimed_at = :at, subtask_id = :subtask
         WHERE id = :id AND status = 'open'`,
        { actor: actor.id, at, subtask: subtaskId, id: offerId },
      );
      if (claimed === 0) throw conflict('该子任务刚刚被别人认领');
      if (task.status === 'pending') {
        // 与"指派"一致：第一个子任务落地，任务才真正开始执行。
        await tx.run("UPDATE tasks SET status = 'running', updated_at = :at WHERE id = :taskId", {
          at,
          taskId: String(offer.task_id),
        });
      }
      await tx.run(
        `INSERT INTO subtasks(id, task_id, agent_id, kind, status, result, due_at, version, created_at, updated_at)
         VALUES(:id, :taskId, :agent, :kind, 'invited', NULL, :dueAt, 0, :at, :at)`,
        {
          id: subtaskId,
          taskId: String(offer.task_id),
          agent: actor.id,
          kind: String(offer.kind),
          dueAt: String(offer.due_at),
          at,
        },
      );
      await appendEvent(this.ctx, tx, {
        taskId: String(offer.task_id),
        actorId: actor.id,
        type: 'offer_claimed',
        payload: { offerId, subtaskId, kind: String(offer.kind) },
      });
      await this.notifications.deliver(tx, {
        workspace: actor.workspace,
        recipientId: String(offer.created_by),
        taskId: String(offer.task_id),
        subtaskId,
        type: 'claimed',
      });
    });
    return { offerId, subtaskId };
  }

  async withdrawOffer(actor: Principal, offerId: string): Promise<{ offerId: string; status: OfferStatus }> {
    const offer = await this.ctx.db.read.one('SELECT * FROM task_offers WHERE id = :id AND workspace = :workspace', {
      id: offerId,
      workspace: actor.workspace,
    });
    if (!offer) throw notFound('开放子任务不存在');
    const task = await readTask(this.ctx, actor, String(offer.task_id));
    if (task.ownerId !== actor.id && !hasAnyRole(actor, 'admin')) {
      throw forbidden('只有负责人或管理员可以撤回开放子任务');
    }
    if (String(offer.status) !== 'open') throw conflict('只有还在开放池里的子任务可以撤回');
    await this.ctx.db.transaction(async tx => {
      await tx.run(`UPDATE task_offers SET status = 'withdrawn' WHERE id = :id AND status = 'open'`, {
        id: offerId,
      });
      await appendEvent(this.ctx, tx, {
        taskId: String(offer.task_id),
        actorId: actor.id,
        type: 'offer_withdrawn',
        payload: { offerId },
      });
    });
    return { offerId, status: 'withdrawn' };
  }

  // ---------------------------------------------------------------- 心跳

  /**
   * 智能体心跳。用于"它还在不在"这一件事，不表示它在做什么、更不表示做对了。
   * 心跳过期只会触发监管告警，不会自动改变任何子任务状态。
   */
  async heartbeat(actor: Principal, body: unknown): Promise<Presence> {
    if (actor.kind !== 'agent' && actor.kind !== 'service' && !hasAnyRole(actor, 'admin')) {
      throw forbidden('只有智能体或服务账号上报心跳');
    }
    await requireAgentScope(this.ctx, actor, 'presence:write');
    const input = body && typeof body === 'object' ? asObject(body) : {};
    const state = input.state === undefined ? 'online' : (String(input.state) as Presence['state']);
    if (!PRESENCE_STATES.includes(state)) throw invalid(`state 必须是 ${PRESENCE_STATES.join(' / ')} 之一`);
    const note = input.note === undefined ? '' : asString(input.note, 'note', { max: 200, min: 0 });
    const client = input.client === undefined ? '' : asString(input.client, 'client', { max: 100, min: 0 });
    const at = this.ctx.now();

    await this.ctx.db.transaction(async tx => {
      const existing = await tx.one('SELECT principal_id FROM agent_presence WHERE principal_id = :id', {
        id: actor.id,
      });
      if (existing) {
        await tx.run(
          `UPDATE agent_presence SET state = :state, note = :note, client = :client, last_seen_at = :at
           WHERE principal_id = :id`,
          { state, note, client, at, id: actor.id },
        );
      } else {
        await tx.run(
          `INSERT INTO agent_presence(principal_id, workspace, state, note, client, last_seen_at, created_at)
           VALUES(:id, :workspace, :state, :note, :client, :at, :at)`,
          { id: actor.id, workspace: actor.workspace, state, note, client, at },
        );
      }
    });

    return { principalId: actor.id, state, note, client, lastSeenAt: at, silentSeconds: 0 };
  }

  /** 监管视角：所有智能体 + 在线状态。没有心跳记录的显示为 offline / 未知。 */
  async presenceBoard(actor: Principal): Promise<Presence[]> {
    if (!hasAnyRole(actor, 'admin', 'supervisor', 'owner')) throw forbidden('需要负责人、监管者或管理员角色');
    const rows = await this.ctx.db.read.all(
      `SELECT p.id AS principal_id, p.display_name, a.state, a.note, a.client, a.last_seen_at
       FROM principals p LEFT JOIN agent_presence a ON a.principal_id = p.id
       WHERE p.workspace = :workspace AND p.kind IN ('agent','service')
       ORDER BY p.id`,
      { workspace: actor.workspace },
    );
    const now = Date.parse(this.ctx.now());
    const board = rows.map(row => {
      const lastSeen = row.last_seen_at === null || row.last_seen_at === undefined ? null : String(row.last_seen_at);
      const silent = lastSeen ? Math.max(0, Math.round((now - Date.parse(lastSeen)) / 1000)) : null;
      const declared = row.state === null || row.state === undefined ? 'offline' : String(row.state);
      const state: Presence['state'] =
        declared === 'online' && silent !== null && silent > 900 ? 'offline' : (declared as Presence['state']);
      return {
        principalId: String(row.principal_id),
        displayName: String(row.display_name ?? ''),
        state,
        note: String(row.note ?? ''),
        client: String(row.client ?? ''),
        lastSeenAt: lastSeen ?? '',
        silentSeconds: silent,
      };
    });
    // 最近有动静的排在前面，从未上报的沉底。
    return board.sort((left, right) => (left.silentSeconds ?? Number.MAX_SAFE_INTEGER) - (right.silentSeconds ?? Number.MAX_SAFE_INTEGER));
  }
}

/** 供监管服务复用：把一段毫秒数说成"多久没动"。 */
export function humanAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}
