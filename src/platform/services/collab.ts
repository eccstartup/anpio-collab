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

import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import { asObject, asString } from '../../protocol/parse.ts';
import { PRESENCE_STATES } from '../../protocol/types.ts';
import type { OfferStatus, Presence, Principal, TaskComment, TaskOffer } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';
import { encode } from '../db/mappers.ts';
import { hasAnyRole, loadTask, readTask, requireAgentScope } from './access.ts';
import { appendEvent } from './events.ts';
import { NotificationService } from './notifications.ts';

const MENTION = /@([A-Za-z0-9][A-Za-z0-9._:-]{0,63})/g;
const DEFAULT_OFFER_DAYS = 3;

function toComment(row: Record<string, unknown>): TaskComment {
  let mentions: string[] = [];
  try {
    mentions = JSON.parse(String(row.mentions ?? '[]')) as string[];
  } catch {
    mentions = [];
  }
  const kind = row.author_kind === 'agent' ? 'agent' : row.author_kind === 'service' ? 'service' : 'human';
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    authorId: String(row.author_id),
    authorName: String(row.author_name ?? row.author_id),
    authorKind: kind,
    body: String(row.body),
    mentions,
    createdAt: String(row.created_at),
    ...(row.task_title === undefined ? {} : { taskTitle: String(row.task_title) }),
  };
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
        `INSERT INTO task_comments(id, workspace, task_id, author_id, body, mentions, created_at)
         VALUES(:id, :workspace, :taskId, :author, :body, :mentions, :at)`,
        {
          id: commentId,
          workspace: actor.workspace,
          taskId: task.id,
          author: actor.id,
          body: text,
          mentions: encode(recipients.map(item => item.id)),
          at,
        },
      );
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
        type: 'comment_added',
        payload: { commentId, mentions: recipients.map(item => item.id), preview: text.slice(0, 120) },
      });
    });

    return {
      id: commentId,
      taskId: task.id,
      authorId: actor.id,
      authorName: actor.displayName,
      authorKind: actor.kind,
      body: text,
      mentions: recipients.map(item => item.id),
      createdAt: at,
    };
  }

  async listComments(actor: Principal, taskId: string): Promise<TaskComment[]> {
    const task = await readTask(this.ctx, actor, taskId);
    const rows = await this.ctx.db.read.all(
      `SELECT c.*, p.display_name AS author_name, p.kind AS author_kind
       FROM task_comments c JOIN principals p ON p.id = c.author_id
       WHERE c.task_id = :taskId ORDER BY c.created_at, c.id LIMIT 500`,
      { taskId: task.id },
    );
    return rows.map(toComment);
  }

  /** 我被提及但还没读的评论。 */
  async mentions(actor: Principal): Promise<TaskComment[]> {
    const rows = await this.ctx.db.read.all(
      `SELECT c.*, m.id AS mention_id, p.display_name AS author_name, p.kind AS author_kind,
              t.title AS task_title
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
