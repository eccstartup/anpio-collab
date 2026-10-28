/**
 * 子任务状态机（智能体侧）与负责人干预。
 *
 * 关键语义：
 *  - 状态流转用 "WHERE status = 期望值 AND version = 期望版本" 的条件更新，
 *    并发提交时只有一方成功，另一方得到 409 而不是覆盖别人的结果；
 *  - 超时不等于失败，结果未知也不等于失败：两者都要求先核对业务状态；
 *  - 智能体只能操作分配给自己的子任务。
 */

import { conflict, invalid } from '../../protocol/errors.ts';
import type { Principal, Subtask, SubtaskResult } from '../../protocol/types.ts';
import { asInteger, asObject, asString, asTimestamp } from '../../protocol/parse.ts';
import type { Context } from '../context.ts';

import { encode, toSubtask } from '../db/mappers.ts';
import { agentSubtask, assertOwner, loadSubtask, readTask, requireAgentScope, requireRole } from './access.ts';
import { appendEvent } from './events.ts';
import { NotificationService } from './notifications.ts';

const DEPENDENCIES_PENDING = `EXISTS (
  SELECT 1 FROM subtask_dependencies d JOIN subtasks p ON p.id = d.depends_on
  WHERE d.subtask_id = s.id AND p.status NOT IN ('submitted','verified')
)`;

export type InboxItem = {
  id: string;
  taskId: string;
  kind: string;
  status: string;
  version: number;
  dueAt: string;
  dependsOn: string[];
  task: {
    id: string;
    title: string;
    type: string;
    priority: string;
    acceptance: string;
    dueAt: string;
    input: Record<string, unknown>;
  };
};

function parseResult(value: unknown): SubtaskResult {
  const input = asObject(value, 'result');
  const quantity = input.quantity === undefined ? undefined : asInteger(input.quantity, 'result.quantity');
  const summary =
    input.summary === undefined ? undefined : asString(input.summary, 'result.summary', { max: 4000 });
  if (quantity === undefined && summary === undefined) {
    throw invalid('result 需要 quantity 或 summary 至少一个');
  }
  const reference =
    input.reference === undefined ? undefined : asString(input.reference, 'result.reference', { max: 1000 });
  return {
    ...(quantity === undefined ? {} : { quantity }),
    ...(summary === undefined ? {} : { summary }),
    source: asString(input.source, 'result.source', { max: 1000 }),
    observedAt: asTimestamp(input.observedAt, 'result.observedAt'),
    ...(reference === undefined ? {} : { reference }),
  };
}

export class SubtaskService {
  private readonly ctx: Context;
  private readonly notifications: NotificationService;

  constructor(ctx: Context, notifications: NotificationService) {
    this.ctx = ctx;
    this.notifications = notifications;
  }

  /** 智能体待办：已邀请、已接受、被退回，且依赖已满足的子任务。 */
  async inbox(actor: Principal): Promise<InboxItem[]> {
    requireRole(actor, 'agent', 'admin');
    const rows = await this.ctx.db.read.all(
      `SELECT s.*, t.title, t.type, t.priority, t.acceptance, t.input,
              (SELECT COUNT(*) FROM subtask_dependencies d WHERE d.subtask_id = s.id) AS dependency_count,
              ${DEPENDENCIES_PENDING} AS blocked
       FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE s.agent_id = :agent AND t.workspace = :workspace AND t.status = 'running'
         AND s.status IN ('invited','accepted','returned')
       ORDER BY s.due_at, s.created_at`,
      { agent: actor.id, workspace: actor.workspace },
    );
    const items: InboxItem[] = [];
    for (const row of rows) {
      if (Number(row.blocked) === 1) continue;
      const subtask = toSubtask(row);
      subtask.dependsOn = await this.dependencies(subtask.id);
      items.push({
        id: subtask.id,
        taskId: subtask.taskId,
        kind: subtask.kind,
        status: subtask.status,
        version: subtask.version,
        dueAt: subtask.dueAt,
        dependsOn: subtask.dependsOn,
        task: {
          id: String(row.task_id),
          title: String(row.title),
          type: String(row.type),
          priority: String(row.priority),
          acceptance: String(row.acceptance),
          dueAt: String(row.due_at),
          input: JSON.parse(String(row.input)) as Record<string, unknown>,
        },
      });
    }
    return items;
  }

  private async dependencies(subtaskId: string): Promise<string[]> {
    const rows = await this.ctx.db.read.all(
      'SELECT depends_on FROM subtask_dependencies WHERE subtask_id = :id ORDER BY depends_on',
      { id: subtaskId },
    );
    return rows.map(row => String(row.depends_on));
  }

  private async hasPendingDependencies(subtaskId: string): Promise<boolean> {
    const row = await this.ctx.db.read.one(
      `SELECT 1 AS present FROM subtask_dependencies d JOIN subtasks p ON p.id = d.depends_on
       WHERE d.subtask_id = :id AND p.status NOT IN ('submitted','verified')`,
      { id: subtaskId },
    );
    return Boolean(row);
  }

  private async applyTransition(
    actor: Principal,
    subtask: Subtask,
    next: Subtask['status'],
    options: { result?: unknown; event: Parameters<typeof appendEvent>[2]['type']; payload?: Record<string, unknown> },
  ): Promise<{ id: string; status: string; version: number }> {
    return this.ctx.db.transaction(async tx => {
      const changed = await tx.run(
        `UPDATE subtasks
         SET status = :next, result = :result, version = version + 1, updated_at = :at
         WHERE id = :id AND status = :expected AND version = :version`,
        {
          next,
          result: options.result === undefined ? null : encode(options.result),
          at: this.ctx.now(),
          id: subtask.id,
          expected: subtask.status,
          version: subtask.version,
        },
      );
      if (changed === 0) throw conflict('子任务状态已变化，请重新读取后再操作');
      await appendEvent(this.ctx, tx, {
        taskId: subtask.taskId,
        actorId: actor.id,
        type: options.event,
        payload: { subtaskId: subtask.id, ...(options.payload ?? {}) },
      });
      return { id: subtask.id, status: next, version: subtask.version + 1 };
    });
  }

  async accept(actor: Principal, subtaskId: string): Promise<{ id: string; status: string; version: number }> {
    const subtask = await agentSubtask(this.ctx, actor, subtaskId);
    await requireAgentScope(this.ctx, actor, 'tasks:submit');
    if (!['invited', 'returned'].includes(subtask.status)) throw conflict('只有已邀请或被退回的子任务可以接受');
    const task = await readTask(this.ctx, actor, subtask.taskId);
    if (task.status !== 'running') throw conflict('任务不在执行中');
    if (await this.hasPendingDependencies(subtaskId)) throw conflict('前置子任务尚未完成');
    return this.applyTransition(actor, subtask, 'accepted', { event: 'subtask_accepted' });
  }

  async reject(actor: Principal, subtaskId: string, body: unknown): Promise<{ id: string; status: string; version: number }> {
    const subtask = await agentSubtask(this.ctx, actor, subtaskId);
    if (!['invited', 'returned'].includes(subtask.status)) throw conflict('只有已邀请或被退回的子任务可以拒绝');
    const reason = asString(asObject(body).reason, 'reason', { max: 2000 });
    return this.applyTransition(actor, subtask, 'rejected', {
      result: { reason },
      event: 'subtask_rejected',
      payload: { reason },
    });
  }

  async submit(actor: Principal, subtaskId: string, body: unknown): Promise<{ id: string; status: string; version: number }> {
    const subtask = await agentSubtask(this.ctx, actor, subtaskId);
    await requireAgentScope(this.ctx, actor, 'tasks:submit');
    if (subtask.status !== 'accepted') throw conflict('只有已接受的子任务可以提交');
    const task = await readTask(this.ctx, actor, subtask.taskId);
    if (task.status !== 'running') throw conflict('任务不在执行中');
    const result = parseResult(asObject(body).result);
    return this.applyTransition(actor, subtask, 'submitted', {
      result,
      event: 'subtask_submitted',
      payload: { source: result.source, observedAt: result.observedAt },
    });
  }

  /** 进度记录不改变状态，只写事件，便于长任务被他人观察。 */
  async progress(actor: Principal, subtaskId: string, body: unknown): Promise<{ id: string; status: string; version: number }> {
    const subtask = await agentSubtask(this.ctx, actor, subtaskId);
    if (subtask.status !== 'accepted') throw conflict('只有已接受的子任务可以记录进度');
    const text = asString(asObject(body).text, 'text', { max: 2000 });
    const task = await readTask(this.ctx, actor, subtask.taskId);
    if (task.status !== 'running') throw conflict('任务不在执行中');
    await this.ctx.db.transaction(async tx => {
      await appendEvent(this.ctx, tx, {
        taskId: subtask.taskId,
        actorId: actor.id,
        type: 'subtask_progress',
        payload: { subtaskId, text },
      });
    });
    return { id: subtaskId, status: subtask.status, version: subtask.version };
  }

  /** 结果未知：已完成可能有副作用的操作但无法确认结果，必须由人核对。 */
  async outcomeUnknown(actor: Principal, subtaskId: string, body: unknown): Promise<{ id: string; status: string; version: number }> {
    const subtask = await agentSubtask(this.ctx, actor, subtaskId);
    if (subtask.status !== 'accepted') throw conflict('只有已接受的子任务可以标记结果未知');
    const input = asObject(body);
    const reason = asString(input.reason, 'reason', { max: 2000 });
    const externalOperationId = asString(input.externalOperationId, 'externalOperationId', { max: 200 });
    return this.applyTransition(actor, subtask, 'outcome_unknown', {
      result: { reason, externalOperationId },
      event: 'subtask_outcome_unknown',
      payload: { reason, externalOperationId },
    });
  }

  /** 负责人标记超时：只改变协作状态，不推断业务结果。 */
  async timeout(actor: Principal, subtaskId: string, body: unknown): Promise<{ id: string; status: string; version: number }> {
    const subtask = await loadSubtask(this.ctx, actor, subtaskId);
    const task = await readTask(this.ctx, actor, subtask.taskId);
    assertOwner(actor, task);
    if (!['invited', 'accepted'].includes(subtask.status)) throw conflict('只有已邀请或已接受的子任务可以标记超时');
    if (task.status !== 'running') throw conflict('任务不在执行中');
    const note = asString(asObject(body).note, 'note', { max: 2000 });
    return this.applyTransition(actor, subtask, 'timed_out', {
      event: 'subtask_timed_out',
      payload: { note },
    });
  }

  /** 退回：重新开放给智能体，会同时写入通知。 */
  async returnToAgent(actor: Principal, subtaskId: string, body: unknown): Promise<{ id: string; status: string; version: number }> {
    const subtask = await loadSubtask(this.ctx, actor, subtaskId);
    const task = await readTask(this.ctx, actor, subtask.taskId);
    assertOwner(actor, task);
    if (!['submitted', 'rejected', 'timed_out', 'outcome_unknown'].includes(subtask.status)) {
      throw conflict('该子任务当前状态不能退回');
    }
    if (task.status !== 'running') throw conflict('任务不在执行中');
    const note = asString(asObject(body).note, 'note', { max: 2000 });

    return this.ctx.db.transaction(async tx => {
      const changed = await tx.run(
        `UPDATE subtasks SET status = 'returned', version = version + 1, updated_at = :at
         WHERE id = :id AND status = :expected AND version = :version`,
        { at: this.ctx.now(), id: subtask.id, expected: subtask.status, version: subtask.version },
      );
      if (changed === 0) throw conflict('子任务状态已变化，请重新读取后再操作');
      await this.notifications.deliver(tx, {
        workspace: actor.workspace,
        recipientId: subtask.agentId,
        taskId: subtask.taskId,
        subtaskId: subtask.id,
        type: 'returned',
      });
      await appendEvent(this.ctx, tx, {
        taskId: subtask.taskId,
        actorId: actor.id,
        type: 'subtask_returned',
        payload: { subtaskId: subtask.id, note },
      });
      return { id: subtask.id, status: 'returned', version: subtask.version + 1 };
    });
  }

}
