/**
 * 通知投递。
 *
 * 通知是"任务绑定的提醒"，信箱是"跨任务、可推送的信"。
 * 两者写在同一事务里：状态变了就两者都有，回滚就两者都没有。
 * 通知表保持原样，现有控制台与接口不受影响。
 */

import { notFound } from '../../protocol/errors.ts';
import type { MailPriority, Notification, Principal } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';
import { toNotification } from '../db/mappers.ts';
import type { MailboxService } from './mailbox.ts';

export type DeliveryInput = {
  workspace: string;
  recipientId: string;
  taskId: string;
  subtaskId: string;
  type: 'invited' | 'returned' | 'cancelled' | 'claimed';
  /** 覆盖默认的邮件摘要与优先级（可选）。 */
  summary?: string;
  priority?: MailPriority;
};

const MAIL_KIND: Record<DeliveryInput['type'], string> = {
  invited: 'task.assigned',
  returned: 'task.returned',
  cancelled: 'task.cancelled',
  claimed: 'offer.claimed',
};

const MAIL_PRIORITY: Record<DeliveryInput['type'], MailPriority> = {
  invited: 'next',
  returned: 'interrupt',
  cancelled: 'interrupt',
  claimed: 'next',
};

export class NotificationService {
  private readonly ctx: Context;
  private readonly mailbox: MailboxService;

  constructor(ctx: Context, mailbox: MailboxService) {
    this.ctx = ctx;
    this.mailbox = mailbox;
  }

  /** 在业务事务内写入通知与信箱消息，保证"状态变了就有提醒"或两者都不发生。 */
  async deliver(tx: Queryable, input: DeliveryInput): Promise<void> {
    const at = this.ctx.now();
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
        at,
      },
    );

    const task = await tx.one<{ title: string; owner_id: string }>(
      'SELECT title, owner_id FROM tasks WHERE id = :id',
      { id: input.taskId },
    );
    const title = task ? String(task.title) : '任务';
    const summary =
      input.summary ??
      (input.type === 'invited'
        ? `新任务：${title}`
        : input.type === 'returned'
          ? `任务被退回：${title}`
          : input.type === 'cancelled'
            ? `任务已取消：${title}`
            : `开放子任务已被认领：${title}`);

    await this.mailbox.publish(tx, {
      workspace: input.workspace,
      topic: `ws:${input.workspace}:principal:${input.recipientId}`,
      kind: MAIL_KIND[input.type],
      priority: input.priority ?? MAIL_PRIORITY[input.type],
      summary,
      ref: { type: 'subtask', id: input.subtaskId, taskId: input.taskId },
      publisherId: task ? String(task.owner_id) : input.recipientId,
      audience: { principals: [input.recipientId] },
    });
  }

  async list(principal: Principal): Promise<Notification[]> {
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
    const row = await this.ctx.db.read.one(
      `SELECT n.* FROM notifications n
       WHERE n.id = :id AND n.workspace = :workspace AND n.recipient_id = :recipient`,
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
