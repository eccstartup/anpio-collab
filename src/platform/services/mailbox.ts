/**
 * 跨任务信箱。
 *
 * 三条不变式：
 *  1. 消息只存信封与引用，正文永远回源读取并按当前权限重新判定；
 *  2. 同一主体的多个会话各有游标与投递，一个会话看过不影响另一个；
 *  3. 发布与业务写在同一事务里，崩溃时不会出现"状态变了但没有信"。
 *
 * 投递是 at-least-once：拉取后退避与重试由 nack 控制，ack 只影响当前投递。
 */

import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import {
  asEnum,
  asId,
  asInteger,
  asObject,
  asOptionalString,
  asString,
  asStringArray,
} from '../../protocol/parse.ts';
import {
  MAIL_MODES,
  MAIL_PRIORITIES,
  type MailEnvelope,
  type MailMessage,
  type MailMode,
  type MailPriority,
  type MailSession,
  type MailSessionStatus,
  type MailSubscription,
  type Principal,
} from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable, Row } from '../db/driver.ts';
import { readTask, requireAgentScope, requireRole } from './access.ts';

const SUMMARY_MAX = 200;
const BODY_SUMMARY_MAX = 4000;
const MAX_ATTEMPTS = 5;
const DEFAULT_SESSION_TTL_DAYS = 7;

const PRIORITY_RANK: Record<MailPriority, number> = {
  interrupt: 0,
  next: 1,
  digest: 2,
  silent: 3,
};

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const number = (value: unknown): number => Number(value);
const nullable = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export type PublishAudience = {
  principals?: string[];
  capability?: string;
  taskId?: string;
};

export type PublishInput = {
  workspace: string;
  topic: string;
  kind: string;
  priority?: MailPriority;
  summary: string;
  ref: { type: string; id: string; taskId?: string | null; threadId?: string | null };
  publisherId: string;
  dedupeKey?: string | null;
  expiresAt?: string | null;
  audience: PublishAudience;
};

export type PublishResult = { id: string; recipients: number; duplicate: boolean };

export type PullOptions = {
  limit?: number;
  leaseSeconds?: number;
  includeDigest?: boolean;
  /** 只返回投递序号大于它的信件；SSE 断线重放用它。 */
  since?: number;
};

export type PullResult = { items: MailEnvelope[]; cursor: number; session: MailSession };

type SessionRow = {
  id: string;
  workspace: string;
  principal_id: string;
  kind: string;
  label: string;
  status: string;
  cursor_seq: number;
  expires_at: string | null;
  last_seen_at: string;
  created_at: string;
  closed_at: string | null;
};

export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern.endsWith('*')) return topic.startsWith(pattern.slice(0, -1));
  return pattern === topic;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function priorityOf(value: unknown): MailPriority {
  return (MAIL_PRIORITIES as readonly string[]).includes(String(value))
    ? (String(value) as MailPriority)
    : 'next';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export class MailboxService {
  private readonly ctx: Context;
  /** SSE 清理函数：关闭会话或进程退出时主动断开长连接。 */
  private readonly streams = new Set<{ sessionId: string; cleanup: (reason: 'closed' | 'shutdown') => void }>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  // ------------------------------------------------------------------ 发布

  async publish(tx: Queryable, input: PublishInput): Promise<PublishResult> {
    const at = this.ctx.now();
    if (input.dedupeKey) {
      const existing = await tx.one<{ id: string }>(
        'SELECT id FROM mailbox_messages WHERE workspace = :workspace AND dedupe_key = :key',
        { workspace: input.workspace, key: input.dedupeKey },
      );
      if (existing) return { id: String(existing.id), recipients: 0, duplicate: true };
    }

    const id = this.ctx.newId();
    const priority = input.priority ?? 'next';
    const summary = truncate(input.summary.trim(), SUMMARY_MAX);
    await tx.run(
      `INSERT INTO mailbox_messages(id, workspace, publisher_id, topic, kind, priority, summary,
                                    ref_type, ref_id, task_id, thread_id, dedupe_key, expires_at, created_at)
       VALUES(:id, :workspace, :publisher, :topic, :kind, :priority, :summary,
              :refType, :refId, :taskId, :threadId, :dedupeKey, :expiresAt, :at)`,
      {
        id,
        workspace: input.workspace,
        publisher: input.publisherId,
        topic: input.topic,
        kind: input.kind,
        priority,
        summary,
        refType: input.ref.type,
        refId: input.ref.id,
        taskId: input.ref.taskId ?? null,
        threadId: input.ref.threadId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        expiresAt: input.expiresAt ?? null,
        at,
      },
    );

    const recipients = await this.resolveRecipients(tx, input);
    let delivered = 0;
    for (const recipientId of recipients) {
      if (recipientId === input.publisherId) continue;
      delivered += await this.fanout(tx, {
        workspace: input.workspace,
        messageId: id,
        recipientId,
        topic: input.topic,
        at,
      });
    }
    return { id, recipients: delivered, duplicate: false };
  }

  private async resolveRecipients(tx: Queryable, input: PublishInput): Promise<string[]> {
    const recipients = new Set<string>();
    const audience = input.audience;

    if (audience.principals) {
      for (const candidate of audience.principals) {
        if (!candidate) continue;
        const row = await tx.one(
          'SELECT 1 AS present FROM principals WHERE id = :id AND workspace = :workspace AND active = 1',
          { id: candidate, workspace: input.workspace },
        );
        if (row) recipients.add(candidate);
      }
    }

    if (audience.capability) {
      const rows = await tx.all<{ id: string; capabilities: string }>(
        `SELECT id, capabilities FROM principals
         WHERE workspace = :workspace AND active = 1 AND kind IN ('agent', 'service')`,
        { workspace: input.workspace },
      );
      for (const row of rows) {
        let capabilities: string[] = [];
        try {
          capabilities = JSON.parse(String(row.capabilities)) as string[];
        } catch {
          capabilities = [];
        }
        if (capabilities.includes(audience.capability)) recipients.add(String(row.id));
      }
    }

    if (audience.taskId) {
      const task = await tx.one<{ owner_id: string }>(
        'SELECT owner_id FROM tasks WHERE id = :id AND workspace = :workspace',
        { id: audience.taskId, workspace: input.workspace },
      );
      if (task) recipients.add(String(task.owner_id));
      const agents = await tx.all<{ agent_id: string }>(
        'SELECT DISTINCT agent_id FROM subtasks WHERE task_id = :taskId',
        { taskId: audience.taskId },
      );
      for (const row of agents) recipients.add(String(row.agent_id));
      const participants = await tx.all<{ human_principal_id: string; agent_id: string | null }>(
        `SELECT human_principal_id, agent_id FROM task_participants
         WHERE task_id = :taskId AND status = 'accepted'`,
        { taskId: audience.taskId },
      );
      for (const row of participants) {
        recipients.add(String(row.human_principal_id));
        if (row.agent_id) recipients.add(String(row.agent_id));
      }
    }

    recipients.delete(input.publisherId);
    return [...recipients];
  }
  private async fanout(
    tx: Queryable,
    input: {
      workspace: string;
      messageId: string;
      recipientId: string;
      topic: string;
      at: string;
    },
  ): Promise<number> {
    const sessions = await tx.all<{ id: string }>(
      `SELECT id FROM mailbox_sessions
       WHERE workspace = :workspace AND principal_id = :principal AND status = 'active'
         AND (expires_at IS NULL OR expires_at > :at)`,
      { workspace: input.workspace, principal: input.recipientId, at: input.at },
    );
    const subscriptions = await tx.all<{
      id: string;
      session_id: string;
      topic_pattern: string;
      mode: string;
    }>(
      `SELECT id, session_id, topic_pattern, mode FROM mailbox_subscriptions
       WHERE workspace = :workspace AND principal_id = :principal AND paused = 0
         AND (expires_at IS NULL OR expires_at > :at)`,
      { workspace: input.workspace, principal: input.recipientId, at: input.at },
    );
    const matching = subscriptions.filter(subscription =>
      topicMatches(String(subscription.topic_pattern), input.topic),
    );
    const queue = matching.find(subscription => String(subscription.mode) === 'queue');
    const queueOwner = `queue:${input.recipientId}`;

    if (queue) {
      await this.addDelivery(tx, {
        workspace: input.workspace,
        messageId: input.messageId,
        recipientId: input.recipientId,
        sessionId: null,
        ownerKey: queueOwner,
        mode: 'queue',
        subscriptionId: String(queue.id),
        at: input.at,
      });
      return 1;
    }

    if (sessions.length > 0) {
      let count = 0;
      for (const session of sessions) {
        const allowed =
          matching.length === 0 ||
          matching.some(
            subscription =>
              String(subscription.session_id) === '' ||
              String(subscription.session_id) === String(session.id),
          );
        if (!allowed) continue;
        const inserted = await this.addDelivery(tx, {
          workspace: input.workspace,
          messageId: input.messageId,
          recipientId: input.recipientId,
          sessionId: String(session.id),
          ownerKey: `session:${String(session.id)}`,
          mode: 'fanout',
          subscriptionId: null,
          at: input.at,
        });
        if (inserted) count += 1;
      }
      return count;
    }

    const inserted = await this.addDelivery(tx, {
      workspace: input.workspace,
      messageId: input.messageId,
      recipientId: input.recipientId,
      sessionId: null,
      ownerKey: queueOwner,
      mode: 'queue',
      subscriptionId: null,
      at: input.at,
    });
    return inserted ? 1 : 0;
  }

  private async addDelivery(
    tx: Queryable,
    input: {
      workspace: string;
      messageId: string;
      recipientId: string;
      sessionId: string | null;
      ownerKey: string;
      mode: MailMode;
      subscriptionId: string | null;
      at: string;
    },
  ): Promise<boolean> {
    const existing = await tx.one(
      'SELECT 1 AS present FROM mailbox_deliveries WHERE owner_key = :owner AND message_id = :message',
      { owner: input.ownerKey, message: input.messageId },
    );
    if (existing) return false;
    await tx.run(
      `INSERT INTO mailbox_deliveries(id, workspace, subscription_id, message_id, principal_id,
                                      session_id, owner_key, mode, state, attempts, available_at,
                                      lease_until, last_error, delivered_at, acked_at, created_at, updated_at)
       VALUES(:id, :workspace, :subscription, :message, :principal,
              :session, :owner, :mode, 'pending', 0, :at,
              NULL, NULL, NULL, NULL, :at, :at)`,
      {
        id: this.ctx.newId(),
        workspace: input.workspace,
        subscription: input.subscriptionId,
        message: input.messageId,
        principal: input.recipientId,
        session: input.sessionId,
        owner: input.ownerKey,
        mode: input.mode,
        at: input.at,
      },
    );
    return true;
  }

  // ------------------------------------------------------------------ 会话

  async register(principal: Principal, body: unknown): Promise<MailSession> {
    await requireAgentScope(this.ctx, principal, 'mailbox:write');
    const input = asObject(body);
    const label = asOptionalString(input.label, 'label', { max: 80 }) ?? 'default';
    const kind = input.kind === undefined ? 'external' : asEnum(input.kind, 'kind', ['external', 'embedded']);
    const ttlSeconds = asInteger(Number(input.ttlSeconds ?? DEFAULT_SESSION_TTL_DAYS * 24 * 3600), 'ttlSeconds', {
      min: 60,
      max: 90 * 24 * 3600,
    });
    const requested = input.subscriptions === undefined ? [] : input.subscriptions;
    if (!Array.isArray(requested)) throw invalid('subscriptions 必须是数组');
    if (requested.length > 20) throw invalid('subscriptions 最多 20 项');

    const at = this.ctx.now();
    const id = this.ctx.newId();
    const expiresAt = new Date(Date.parse(at) + ttlSeconds * 1000).toISOString();

    return this.ctx.db.transaction(async tx => {
      await this.sweepSleeping(tx, principal.workspace, at);
      await tx.run(
        `INSERT INTO mailbox_sessions(id, workspace, principal_id, kind, label, status, cursor_seq,
                                      expires_at, last_seen_at, created_at, closed_at)
         VALUES(:id, :workspace, :principal, :kind, :label, 'active', 0, :expiresAt, :at, :at, NULL)`,
        {
          id,
          workspace: principal.workspace,
          principal: principal.id,
          kind,
          label,
          expiresAt,
          at,
        },
      );
      // 主体还没有会话时积压的 queue 投递，注册时一次性认领。
      await tx.run(
        `UPDATE mailbox_deliveries
         SET session_id = :session, owner_key = :owner, updated_at = :at
         WHERE owner_key = :queueOwner AND state = 'pending'`,
        {
          session: id,
          owner: `session:${id}`,
          queueOwner: `queue:${principal.id}`,
          at,
        },
      );
      for (const item of requested) {
        const config = asObject(item, 'subscriptions[]');
        const topic = await this.validateTopic(principal, config.topic);
        const mode = config.mode === undefined ? 'fanout' : asEnum(config.mode, 'mode', MAIL_MODES);
        await tx.run(
          `INSERT INTO mailbox_subscriptions(id, workspace, principal_id, session_id, topic_pattern,
                                             mode, filter, paused, created_at, expires_at)
           VALUES(:id, :workspace, :principal, :session, :topic, :mode, '{}', 0, :at, :expiresAt)`,
          {
            id: this.ctx.newId(),
            workspace: principal.workspace,
            principal: principal.id,
            session: id,
            topic,
            mode,
            at,
            expiresAt,
          },
        );
      }
      const row = await tx.one<SessionRow>('SELECT * FROM mailbox_sessions WHERE id = :id', { id });
      return this.sessionView(tx, row as SessionRow, at);
    });
  }

  async getSession(principal: Principal, sessionId: string): Promise<MailSession> {
    await requireAgentScope(this.ctx, principal, 'mailbox:read');
    const row = await this.sessionRow(principal, sessionId);
    return this.sessionView(this.ctx.db.read, row, this.ctx.now());
  }

  async heartbeat(principal: Principal, sessionId: string): Promise<MailSession> {
    await requireAgentScope(this.ctx, principal, 'mailbox:write');
    const at = this.ctx.now();
    return this.ctx.db.transaction(async tx => {
      const row = await this.sessionRow(principal, sessionId, tx);
      if (String(row.status) === 'closed') throw conflict('会话已关闭');
      await tx.run(
        `UPDATE mailbox_sessions SET last_seen_at = :at, status = 'active' WHERE id = :id`,
        { at, id: row.id },
      );
      const updated = await tx.one<SessionRow>('SELECT * FROM mailbox_sessions WHERE id = :id', { id: row.id });
      return this.sessionView(tx, updated as SessionRow, at);
    });
  }

  async close(principal: Principal, sessionId: string): Promise<{ id: string; status: 'closed' }> {
    await requireAgentScope(this.ctx, principal, 'mailbox:write');
    const at = this.ctx.now();
    const row = await this.sessionRow(principal, sessionId);
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE mailbox_sessions SET status = 'closed', closed_at = COALESCE(closed_at, :at) WHERE id = :id`,
        { at, id: row.id },
      );
      // 未确认的投递退回主体队列，而不是丢弃：关闭会话是一个生命周期动作，
      // 不等于"这些消息处理完了"。at-least-once 由下一次注册的会话继续兑现。
      await tx.run(
        `UPDATE mailbox_deliveries
         SET session_id = NULL, owner_key = :owner, state = 'pending', lease_until = NULL, updated_at = :at
         WHERE session_id = :id AND state IN ('pending', 'leased')`,
        { owner: `queue:${String(row.principal_id)}`, at, id: row.id },
      );
    });
    this.notifyStreams(row.id, 'closed');
    return { id: row.id, status: 'closed' };
  }

  // ------------------------------------------------------------------ 拉取

  async pull(principal: Principal, sessionId: string, options: PullOptions = {}): Promise<PullResult> {
    await requireAgentScope(this.ctx, principal, 'mailbox:read');
    const at = this.ctx.now();
    const limit = clamp(Math.trunc(options.limit ?? 50), 1, 100);
    const leaseSeconds = clamp(Math.trunc(options.leaseSeconds ?? 0), 0, 3600);
    const since = Math.max(0, Math.trunc(options.since ?? 0));

    return this.ctx.db.transaction(async tx => {
      const session = await this.sessionRow(principal, sessionId, tx);
      if (String(session.status) === 'closed') throw conflict('会话已关闭');

      await tx.run(
        `UPDATE mailbox_deliveries SET state = 'pending', lease_until = NULL, updated_at = :at
         WHERE session_id = :session AND state = 'leased' AND lease_until IS NOT NULL AND lease_until <= :at`,
        { session: session.id, at },
      );

      const rows = await tx.all<Row>(
        `SELECT d.seq AS delivery_seq, d.id AS delivery_id, m.*
         FROM mailbox_deliveries d
         JOIN mailbox_messages m ON m.id = d.message_id
         WHERE d.session_id = :session AND d.workspace = :workspace AND d.state = 'pending'
           AND d.available_at <= :at AND d.seq > :since
           AND (m.expires_at IS NULL OR m.expires_at > :at)
           AND (:includeDigest = 1 OR m.priority <> 'digest')
         ORDER BY CASE m.priority
                    WHEN 'interrupt' THEN 0 WHEN 'next' THEN 1 WHEN 'digest' THEN 2 ELSE 3 END,
                  d.seq
         LIMIT :limit`,
        {
          session: session.id,
          workspace: principal.workspace,
          at,
          since,
          includeDigest: options.includeDigest ? 1 : 0,
          limit,
        },
      );

      const items: MailEnvelope[] = [];
      let cursor = session.cursor_seq;
      for (const row of rows) {
        if (leaseSeconds > 0) {
          const leaseUntil = new Date(Date.parse(at) + leaseSeconds * 1000).toISOString();
          const changed = await tx.run(
            `UPDATE mailbox_deliveries
             SET state = 'leased', lease_until = :leaseUntil,
                 delivered_at = COALESCE(delivered_at, :at), updated_at = :at
             WHERE id = :id AND state = 'pending'`,
            { leaseUntil, at, id: String(row.delivery_id) },
          );
          if (changed === 0) continue;
        } else {
          await tx.run(
            `UPDATE mailbox_deliveries SET delivered_at = COALESCE(delivered_at, :at), updated_at = :at
             WHERE id = :id`,
            { at, id: String(row.delivery_id) },
          );
        }
        const seq = number(row.delivery_seq);
        cursor = Math.max(cursor, seq);
        items.push(this.envelope(row));
      }
      if (cursor !== session.cursor_seq) {
        await tx.run('UPDATE mailbox_sessions SET cursor_seq = :cursor WHERE id = :id', {
          cursor,
          id: session.id,
        });
      }
      const updated = await tx.one<SessionRow>('SELECT * FROM mailbox_sessions WHERE id = :id', {
        id: session.id,
      });
      return { items, cursor, session: await this.sessionView(tx, updated as SessionRow, at) };
    });
  }

  // ------------------------------------------------------------------ 正文

  async message(principal: Principal, messageId: string): Promise<MailMessage> {
    await requireAgentScope(this.ctx, principal, 'mailbox:read');
    const row = await this.ctx.db.read.one<Row>(
      'SELECT * FROM mailbox_messages WHERE id = :id AND workspace = :workspace',
      { id: messageId, workspace: principal.workspace },
    );
    if (!row) throw notFound('消息不存在');

    const delivery = await this.ctx.db.read.one(
      `SELECT 1 AS present FROM mailbox_deliveries
       WHERE message_id = :message AND principal_id = :principal LIMIT 1`,
      { message: messageId, principal: principal.id },
    );
    const isPublisher = String(row.publisher_id) === principal.id;
    if (!delivery && !isPublisher && !principal.roles.includes('admin')) {
      throw notFound('消息不存在');
    }

    let content: unknown;
    try {
      content = await this.contentOf(principal, row);
    } catch {
      // 无权读取的用户与"消息不存在"得到同一个答案，不泄露存在性。
      throw notFound('消息正文不可访问');
    }
    return {
      id: text(row.id),
      topic: text(row.topic),
      kind: text(row.kind),
      priority: priorityOf(row.priority),
      summary: text(row.summary),
      ref: {
        type: text(row.ref_type),
        id: text(row.ref_id),
        taskId: nullable(row.task_id),
        threadId: nullable(row.thread_id),
      },
      publisherId: text(row.publisher_id),
      createdAt: text(row.created_at),
      expiresAt: nullable(row.expires_at),
      content,
    };
  }

  private async contentOf(principal: Principal, row: Row): Promise<unknown> {
    const refType = text(row.ref_type);
    const refId = text(row.ref_id);

    if (refType === 'task' || refType === 'subtask') {
      const task = await readTask(this.ctx, principal, nullable(row.task_id) ?? refId);
      if (refType === 'task') return { task };
      const subtask = await this.ctx.db.read.one(
        'SELECT id, task_id, agent_id, kind, status, result, due_at, version FROM subtasks WHERE id = :id',
        { id: refId },
      );
      if (!subtask) throw notFound('子任务不存在');
      return { task, subtask };
    }

    if (refType === 'comment') {
      const comment = await this.ctx.db.read.one<Row>('SELECT * FROM task_comments WHERE id = :id', {
        id: refId,
      });
      if (!comment) throw notFound('消息不存在');
      const task = await readTask(this.ctx, principal, String(comment.task_id));
      return {
        task: { id: task.id, title: task.title, status: task.status },
        comment: {
          id: String(comment.id),
          kind: String(comment.kind),
          authorId: String(comment.author_id),
          body: String(comment.body),
          threadId: nullable(comment.thread_id),
          payload: comment.payload,
          createdAt: String(comment.created_at),
        },
      };
    }

    if (refType === 'offer') {
      const offer = await this.ctx.db.read.one<Row>('SELECT * FROM task_offers WHERE id = :id', { id: refId });
      if (!offer) throw notFound('开放子任务不存在');
      const task = await readTask(this.ctx, principal, String(offer.task_id));
      return { task: { id: task.id, title: task.title, status: task.status }, offer };
    }

    if (refType === 'request') {
      const request = await this.ctx.db.read.one<Row>('SELECT * FROM task_requests WHERE id = :id', {
        id: refId,
      });
      if (!request) throw notFound('协商请求不存在');
      const task = await readTask(this.ctx, principal, String(request.task_id));
      if (
        String(request.from_principal) !== principal.id &&
        String(request.to_principal) !== principal.id &&
        task.ownerId !== principal.id &&
        !principal.roles.includes('admin')
      ) {
        throw forbidden('无权访问该协商请求');
      }
      return { task: { id: task.id, title: task.title, status: task.status }, request };
    }

    if (refType === 'run') {
      const run = await this.ctx.db.read.one<Row>('SELECT * FROM embedded_runs WHERE id = :id', { id: refId });
      if (!run) throw notFound('运行记录不存在');
      if (String(run.principal_id ?? '') !== principal.id && !principal.roles.includes('admin')) {
        const agent = await this.ctx.db.read.one<{ created_by: string | null }>(
          'SELECT created_by FROM embedded_agents WHERE id = :id',
          { id: String(run.agent_id) },
        );
        if (!agent || String(agent.created_by ?? '') !== principal.id) throw forbidden('无权访问该运行');
      }
      return { run };
    }

    return null;
  }

  // ------------------------------------------------------------------ 确认

  async ack(
    principal: Principal,
    messageId: string,
    body: unknown,
  ): Promise<{ id: string; state: 'acked'; duplicate: boolean }> {
    await requireAgentScope(this.ctx, principal, 'mailbox:write');
    const deliveryId = asId(asObject(body).deliveryId, 'deliveryId');
    const at = this.ctx.now();
    return this.ctx.db.transaction(async tx => {
      const row = await tx.one<{ id: string; state: string }>(
        `SELECT id, state FROM mailbox_deliveries
         WHERE id = :id AND message_id = :message AND workspace = :workspace AND principal_id = :principal`,
        { id: deliveryId, message: messageId, workspace: principal.workspace, principal: principal.id },
      );
      if (!row) throw notFound('投递不存在');
      if (String(row.state) === 'acked') return { id: deliveryId, state: 'acked', duplicate: true };
      await tx.run(
        `UPDATE mailbox_deliveries
         SET state = 'acked', acked_at = COALESCE(acked_at, :at), lease_until = NULL, updated_at = :at
         WHERE id = :id`,
        { at, id: deliveryId },
      );
      return { id: deliveryId, state: 'acked', duplicate: false };
    });
  }

  async nack(
    principal: Principal,
    messageId: string,
    body: unknown,
  ): Promise<{ id: string; state: string; attempts: number; availableAt: string | null }> {
    await requireAgentScope(this.ctx, principal, 'mailbox:write');
    const input = asObject(body);
    const deliveryId = asId(input.deliveryId, 'deliveryId');
    const retryAfterSeconds = asInteger(Number(input.retryAfterSeconds ?? 30), 'retryAfterSeconds', {
      min: 1,
      max: 3600,
    });
    const reason = asOptionalString(input.reason, 'reason', { max: 500 }) ?? '';
    const at = this.ctx.now();

    return this.ctx.db.transaction(async tx => {
      const row = await tx.one<{ id: string; state: string; attempts: number }>(
        `SELECT id, state, attempts FROM mailbox_deliveries
         WHERE id = :id AND message_id = :message AND workspace = :workspace AND principal_id = :principal`,
        { id: deliveryId, message: messageId, workspace: principal.workspace, principal: principal.id },
      );
      if (!row) throw notFound('投递不存在');
      if (String(row.state) === 'acked') throw conflict('该消息已经确认');
      const attempts = number(row.attempts) + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const availableAt = dead ? null : new Date(Date.parse(at) + retryAfterSeconds * 1000).toISOString();
      if (dead) {
        await tx.run(
          `UPDATE mailbox_deliveries
           SET state = 'dead', attempts = :attempts, lease_until = NULL,
               last_error = :reason, updated_at = :at
           WHERE id = :id`,
          { attempts, reason, at, id: deliveryId },
        );
      } else {
        await tx.run(
          `UPDATE mailbox_deliveries
           SET state = 'pending', attempts = :attempts, available_at = :availableAt,
               lease_until = NULL, last_error = :reason, updated_at = :at
           WHERE id = :id`,
          { attempts, availableAt, reason, at, id: deliveryId },
        );
      }
      if (dead) {
        const message = await tx.one<Row>('SELECT * FROM mailbox_messages WHERE id = :id', { id: messageId });
        const owner = message?.task_id
          ? await tx.one<{ owner_id: string }>('SELECT owner_id FROM tasks WHERE id = :id', {
              id: String(message.task_id),
            })
          : undefined;
        if (owner) {
          await this.publish(tx, {
            workspace: principal.workspace,
            topic: `ws:${principal.workspace}:principal:${String(owner.owner_id)}`,
            kind: 'mailbox.dead',
            priority: 'next',
            summary: truncate(`消息重试耗尽：${text(message?.summary)}`, SUMMARY_MAX),
            ref: { type: 'mail', id: messageId, taskId: message ? nullable(message.task_id) : null },
            publisherId: principal.id,
            dedupeKey: `mailbox.dead:${messageId}:${principal.id}`,
            audience: { principals: [String(owner.owner_id)] },
          });
        }
      }
      return { id: deliveryId, state: dead ? 'dead' : 'pending', attempts, availableAt };
    });
  }

  // ------------------------------------------------------------------ 订阅

  async subscriptions(principal: Principal, sessionId: string): Promise<MailSubscription[]> {
    await requireAgentScope(this.ctx, principal, 'mailbox:read');
    await this.sessionRow(principal, sessionId);
    const rows = await this.ctx.db.read.all<Row>(
      `SELECT * FROM mailbox_subscriptions
       WHERE workspace = :workspace AND principal_id = :principal AND (session_id = :session OR session_id = '')
       ORDER BY created_at, id`,
      { workspace: principal.workspace, principal: principal.id, session: sessionId },
    );
    return rows.map(row => this.subscriptionView(row));
  }

  async subscribe(principal: Principal, sessionId: string, body: unknown): Promise<MailSubscription> {
    await requireAgentScope(this.ctx, principal, 'mailbox:write');
    const input = asObject(body);
    const topic = await this.validateTopic(principal, input.topic);
    const mode = input.mode === undefined ? 'fanout' : asEnum(input.mode, 'mode', MAIL_MODES);
    const at = this.ctx.now();
    return this.ctx.db.transaction(async tx => {
      const session = await this.sessionRow(principal, sessionId, tx);
      const existing = await tx.one<Row>(
        `SELECT * FROM mailbox_subscriptions
         WHERE workspace = :workspace AND principal_id = :principal AND session_id = :session
           AND topic_pattern = :topic`,
        { workspace: principal.workspace, principal: principal.id, session: session.id, topic },
      );
      if (existing) return this.subscriptionView(existing);
      const id = this.ctx.newId();
      await tx.run(
        `INSERT INTO mailbox_subscriptions(id, workspace, principal_id, session_id, topic_pattern,
                                           mode, filter, paused, created_at, expires_at)
         VALUES(:id, :workspace, :principal, :session, :topic, :mode, '{}', 0, :at, :expiresAt)`,
        {
          id,
          workspace: principal.workspace,
          principal: principal.id,
          session: session.id,
          topic,
          mode,
          at,
          expiresAt: session.expires_at,
        },
      );
      const row = await tx.one<Row>('SELECT * FROM mailbox_subscriptions WHERE id = :id', { id });
      return this.subscriptionView(row as Row);
    });
  }

  async unsubscribe(
    principal: Principal,
    subscriptionId: string,
  ): Promise<{ id: string; removed: true }> {
    await requireAgentScope(this.ctx, principal, 'mailbox:write');
    const row = await this.ctx.db.read.one(
      `SELECT 1 AS present FROM mailbox_subscriptions
       WHERE id = :id AND workspace = :workspace AND principal_id = :principal`,
      { id: subscriptionId, workspace: principal.workspace, principal: principal.id },
    );
    if (!row) throw notFound('订阅不存在');
    await this.ctx.db.transaction(async tx => {
      await tx.run('DELETE FROM mailbox_subscriptions WHERE id = :id', { id: subscriptionId });
    });
    return { id: subscriptionId, removed: true };
  }

  // ------------------------------------------------------------------ 运维

  /** SSE 断流时的清理登记。返回取消函数。 */
  addStream(sessionId: string, cleanup: (reason: 'closed' | 'shutdown') => void): () => void {
    const entry = { sessionId, cleanup };
    this.streams.add(entry);
    return () => this.streams.delete(entry);
  }

  closeStreams(): void {
    for (const stream of [...this.streams]) stream.cleanup('shutdown');
    this.streams.clear();
  }

  private notifyStreams(sessionId: string, reason: 'closed' | 'shutdown'): void {
    for (const stream of [...this.streams]) {
      if (stream.sessionId === sessionId) stream.cleanup(reason);
    }
  }

  /** 心跳超时的会话转 sleeping；由注册与维护调用，不依赖后台线程。 */
  async sweepSleeping(tx: Queryable, workspace: string, at: string): Promise<number> {
    const idleHours = Number(process.env.COLLAB_SESSION_IDLE_HOURS ?? 24);
    const threshold = new Date(Date.parse(at) - idleHours * 3600_000).toISOString();
    return tx.run(
      `UPDATE mailbox_sessions SET status = 'sleeping'
       WHERE workspace = :workspace AND status = 'active' AND last_seen_at < :threshold`,
      { workspace, threshold },
    );
  }

  /**
   * 信箱与内嵌运行的保留期回收。
   *
   * 只删已经过期且全部投递都已结算的消息；关闭且超过保留期的会话连同其订阅、
   * 结算过的投递一起清理；运行记录按 finished_at 计保留期，仍在跑的绝不删。
   * 默认只预览，apply 才真正删除。
   */
  async retention(
    principal: Principal,
    days: number,
    apply: boolean,
  ): Promise<{
    applied: boolean;
    cutoff: string;
    messages: number;
    sessions: number;
    deliveries: number;
    runs: number;
    logs: number;
  }> {
    requireRole(principal, 'admin');
    const at = this.ctx.now();
    const cutoff = new Date(Date.parse(at) - days * 86_400_000).toISOString();
    const workspace = principal.workspace;

    const expiredMessages = await this.ctx.db.read.all<{ id: string }>(
      `SELECT m.id FROM mailbox_messages m
       WHERE m.workspace = :workspace
         AND m.expires_at IS NOT NULL AND m.expires_at <= :at
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_deliveries d
           WHERE d.message_id = m.id AND d.state IN ('pending', 'leased')
         )`,
      { workspace, at },
    );
    const staleSessions = await this.ctx.db.read.all<{ id: string }>(
      `SELECT id FROM mailbox_sessions s
       WHERE s.workspace = :workspace
         AND s.status IN ('closed', 'sleeping')
         AND (COALESCE(s.closed_at, s.last_seen_at) <= :cutoff OR s.expires_at <= :at)
         AND NOT EXISTS (
           SELECT 1 FROM mailbox_deliveries d
           WHERE d.session_id = s.id AND d.state IN ('pending', 'leased')
         )`,
      { workspace, cutoff, at },
    );
    const staleDeliveries = await this.ctx.db.read.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM mailbox_deliveries
       WHERE workspace = :workspace
         AND state IN ('acked', 'dead', 'expired')
         AND updated_at <= :cutoff
         AND (message_id IN (SELECT id FROM mailbox_messages WHERE workspace = :workspace AND expires_at <= :at)
              OR session_id IN (SELECT id FROM mailbox_sessions WHERE workspace = :workspace AND status = 'closed'))`,
      { workspace, cutoff, at },
    );
    const staleRuns = await this.ctx.db.read.all<{ id: string }>(
      `SELECT id FROM embedded_runs
       WHERE workspace = :workspace
         AND status <> 'running'
         AND COALESCE(finished_at, started_at) <= :cutoff`,
      { workspace, cutoff },
    );

    const result = {
      applied: apply,
      cutoff,
      messages: expiredMessages.length,
      sessions: staleSessions.length,
      deliveries: Number(staleDeliveries?.total ?? 0),
      runs: staleRuns.length,
      logs: 0,
    };
    if (!apply) return result;

    await this.ctx.db.transaction(async tx => {
      for (const run of staleRuns) {
        result.logs += await tx.run('DELETE FROM embedded_run_logs WHERE run_id = :id', { id: run.id });
        await tx.run('DELETE FROM embedded_runs WHERE id = :id', { id: run.id });
      }
      for (const message of expiredMessages) {
        result.deliveries += await tx.run(
          `DELETE FROM mailbox_deliveries WHERE message_id = :id AND state IN ('acked', 'dead', 'expired')`,
          { id: message.id },
        );
        await tx.run('DELETE FROM mailbox_messages WHERE id = :id', { id: message.id });
      }
      for (const session of staleSessions) {
        result.deliveries += await tx.run(
          `DELETE FROM mailbox_deliveries WHERE session_id = :id AND state IN ('acked', 'dead', 'expired')`,
          { id: session.id },
        );
        await tx.run('DELETE FROM mailbox_subscriptions WHERE session_id = :id', { id: session.id });
        await tx.run('DELETE FROM mailbox_sessions WHERE id = :id', { id: session.id });
      }
      // 已结算且早于保留期的投递单独清理，避免消息被引用时长期堆积。
      result.deliveries += await tx.run(
        `DELETE FROM mailbox_deliveries
         WHERE workspace = :workspace AND state IN ('acked', 'dead', 'expired') AND updated_at <= :cutoff`,
        { workspace, cutoff },
      );
    });
    return result;
  }

  // ------------------------------------------------------------------ 视图

  private envelope(row: Row): MailEnvelope {
    return {
      id: text(row.id),
      seq: number(row.delivery_seq),
      deliveryId: text(row.delivery_id),
      topic: text(row.topic),
      kind: text(row.kind),
      priority: priorityOf(row.priority),
      summary: text(row.summary),
      ref: {
        type: text(row.ref_type),
        id: text(row.ref_id),
        taskId: nullable(row.task_id),
        threadId: nullable(row.thread_id),
      },
      publisherId: text(row.publisher_id),
      createdAt: text(row.created_at),
      expiresAt: nullable(row.expires_at),
    };
  }

  private subscriptionView(row: Row): MailSubscription {
    return {
      id: text(row.id),
      sessionId: text(row.session_id),
      topicPattern: text(row.topic_pattern),
      mode: String(row.mode) === 'queue' ? 'queue' : 'fanout',
      paused: Number(row.paused) === 1,
      createdAt: text(row.created_at),
      expiresAt: nullable(row.expires_at),
    };
  }

  private async sessionView(db: Queryable, row: SessionRow, at: string): Promise<MailSession> {
    const unread = await db.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM mailbox_deliveries
       WHERE session_id = :id AND state IN ('pending', 'leased')
         AND available_at <= :at`,
      { id: row.id, at },
    );
    const status = String(row.status) as MailSessionStatus;
    return {
      id: text(row.id),
      kind: text(row.kind),
      label: text(row.label),
      status,
      cursorSeq: number(row.cursor_seq),
      unread: number(unread?.total ?? 0),
      createdAt: text(row.created_at),
      lastSeenAt: text(row.last_seen_at),
      expiresAt: nullable(row.expires_at),
      closedAt: nullable(row.closed_at),
    };
  }

  private async sessionRow(principal: Principal, sessionId: string, db: Queryable = this.ctx.db.read): Promise<SessionRow> {
    const row = await db.one<SessionRow>(
      `SELECT * FROM mailbox_sessions
       WHERE id = :id AND workspace = :workspace AND principal_id = :principal`,
      { id: sessionId, workspace: principal.workspace, principal: principal.id },
    );
    if (!row) throw notFound('会话不存在');
    return row;
  }

  private async validateTopic(principal: Principal, value: unknown): Promise<string> {
    const pattern = asString(value, 'topic', { max: 200 });
    const prefix = `ws:${principal.workspace}:`;
    if (!pattern.startsWith(prefix)) throw invalid('订阅主题必须属于当前工作空间');
    const rest = pattern.slice(prefix.length);
    if (rest.startsWith('principal:')) {
      const target = rest.slice('principal:'.length).replace(/\*$/, '');
      if (target !== principal.id) throw forbidden('只能订阅自己的主体主题');
      return pattern;
    }
    if (rest.startsWith('task:')) {
      const taskId = rest.slice('task:'.length).replace(/\*$/, '');
      await readTask(this.ctx, principal, taskId);
      return pattern;
    }
    if (rest.startsWith('capability:')) {
      const capability = rest.slice('capability:'.length).replace(/\*$/, '');
      if (!principal.capabilities.includes(capability)) throw forbidden('只能订阅自己声明的能力');
      return pattern;
    }
    throw invalid('订阅主题必须是 principal / task / capability 之一');
  }
}
