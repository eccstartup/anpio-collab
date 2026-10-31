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

import { createHash } from 'node:crypto';
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

const MENTION = /@([A-Za-z0-9][A-Za-z0-9._:-]{0,63})/g;
const DEFAULT_OFFER_DAYS = 3;
const MAX_INLINE_BYTES = 256 * 1024;

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
    taskId: String(row.task_id),
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
    kind: (['input', 'intermediate', 'output', 'evidence'] as const).includes(String(row.kind) as 'input')
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
  knowledge_published: '发布 AICD',
  knowledge_revoked: '撤销 AICD',
  knowledge_revised: '修订 AICD',
  knowledge_access_changed: '调整共享范围',
  knowledge_referenced: '引用 AICD',
  knowledge_shared: '分享 AICD',
  thread_opened: '开启线程',
  thread_resolved: '结束线程',
  file_uploaded: '上传文件',
  file_deleted: '删除文件',
  offer_published: '发布开放子任务',
  offer_claimed: '认领开放子任务',
  offer_withdrawn: '撤回开放子任务',
  aicd_created: '创建 AICD',
  aicd_updated: '编辑 AICD',
  aicd_submitted: '提交 AICD 审核',
  aicd_archived: '归档 AICD',
  aicd_copied: '复制 AICD',
  aicd_copy_invited: '发起复制邀请',
  aicd_copy_accepted: '接受复制邀请',
  aicd_copy_declined: '拒绝复制邀请',
};

function eventSummary(type: string, payload: Record<string, unknown>): string {
  const label = EVENT_LABELS[type] ?? type;
  const subject = payload.name ?? payload.title ?? payload.topic ?? payload.preview;
  return subject === undefined ? label : `${label}：${String(subject).slice(0, 80)}`;
}

function toOffer(row: Record<string, unknown>): TaskOffer {
  return {
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

  constructor(ctx: Context, notifications: NotificationService) {
    this.ctx = ctx;
    this.notifications = notifications;
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

    const commentId = this.ctx.newId();
    const at = this.ctx.now();
    const recipients: Principal[] = [];
    for (const id of mentioned) {
      if (id === actor.id) continue;
      const row = await this.ctx.db.read.one(
        'SELECT * FROM principals WHERE id = :id AND workspace = :workspace AND active = 1',
        { id, workspace: actor.workspace },
      );
      if (row) recipients.push({ id: String(row.id) } as Principal);
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
        : asEnum(input.kind, 'kind', ['input', 'intermediate', 'output', 'evidence'] as const);
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
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const task = await readTask(this.ctx, actor, taskId);
    const row = await this.ctx.db.read.one(
      `SELECT f.*, p.display_name AS produced_by_name
       FROM space_files f LEFT JOIN principals p ON p.id = f.produced_by
       WHERE f.id = :id AND f.task_id = :taskId AND f.status = 'ready'`,
      { id: fileId, taskId: task.id },
    );
    if (!row) throw notFound('文件不存在');
    if (String(row.storage) !== 'inline' || !row.data) throw notFound('对象存储尚未接入，无法读取该文件');
    return { file: toSpaceFile(row), data: String(row.data) };
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

  /** 把任务进展、对话、文件与 AICD 合并成一条时间线。 */
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
      copyPolicy: String(row.copy_policy) as TaskRoom['knowledge'][number]['copyPolicy'],
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
    };
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
