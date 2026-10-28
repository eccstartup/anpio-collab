/**
 * 通知投递。
 *
 * 当前实现是平台内的持久队列：通知与触发它的状态变更写在同一事务，
 * 智能体通过 HTTP 拉取并确认。投递成功只表示"平台已记录通知"，
 * 不代表智能体已经执行；执行结果仍以子任务状态为准。
 *
 * 后续接入 ANP（anpio-cli 的 AnpioAgent）时，替换这里的 deliver 实现，
 * 保持"投递状态与业务状态分离"的语义即可。
 */

import { forbidden, notFound } from '../../protocol/errors.ts';
import type { Notification, Principal } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';
import { toNotification } from '../db/mappers.ts';
import { hasAnyRole } from './access.ts';

export type DeliveryInput = {
  workspace: string;
  recipientId: string;
  taskId: string;
  subtaskId: string;
  type: 'invited' | 'returned' | 'cancelled';
};

export class NotificationService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 在业务事务内写入通知，保证"状态变了就有通知"或两者都不发生。 */
  async deliver(tx: Queryable, input: DeliveryInput): Promise<void> {
    await tx.run(
      `INSERT INTO notifications(id, workspace, recipient_id, task_id, subtask_id, type, created_at, acknowledged_at)
       VALUES(:id, :workspace, :recipientId, :taskId, :subtaskId, :type, :at, NULL)`,
      {
        id: this.ctx.newId(),
        workspace: input.workspace,
        recipientId: input.recipientId,
        taskId: input.taskId,
        subtaskId: input.subtaskId,
        type: input.type,
        at: this.ctx.now(),
      },
    );
  }

  async list(principal: Principal): Promise<Notification[]> {
    if (!hasAnyRole(principal, 'agent')) throw forbidden('只有智能体主体有通知');
    const rows = await this.ctx.db.read.all(
      `SELECT * FROM notifications
       WHERE workspace = :workspace AND recipient_id = :recipient AND acknowledged_at IS NULL
       ORDER BY created_at, id
       LIMIT 100`,
      { workspace: principal.workspace, recipient: principal.id },
    );
    return rows.map(toNotification);
  }

  async acknowledge(principal: Principal, notificationId: string): Promise<{ id: string; acknowledged: true }> {
    if (!hasAnyRole(principal, 'agent')) throw forbidden('只有智能体主体有通知');
    const row = await this.ctx.db.read.one(
      `SELECT n.* FROM notifications n
       JOIN subtasks s ON s.id = n.subtask_id
       WHERE n.id = :id AND n.workspace = :workspace AND n.recipient_id = :recipient
         AND s.agent_id = :recipient`,
      { id: notificationId, workspace: principal.workspace, recipient: principal.id },
    );
    if (!row) throw notFound('通知不存在');
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        'UPDATE notifications SET acknowledged_at = COALESCE(acknowledged_at, :at) WHERE id = :id',
        { at: this.ctx.now(), id: notificationId },
      );
    });
    return { id: notificationId, acknowledged: true };
  }
}
