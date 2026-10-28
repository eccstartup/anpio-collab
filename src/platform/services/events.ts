/**
 * 事件追加。
 *
 * 每条事件同时递增任务的 version，因此 version 既是乐观锁，也是
 * "这个任务的协作状态被改过几次"的单调计数。事件与状态变更必须写在
 * 同一个事务里，不能出现状态变了却没有事件、或事件写了却回滚。
 */

import type { EventType } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';
import { encode } from '../db/mappers.ts';

export type AppendEventInput = {
  taskId: string;
  actorId: string;
  type: EventType;
  payload?: Record<string, unknown>;
};

export type AppendEventResult = { seq: number; taskVersion: number };

export async function appendEvent(
  ctx: Context,
  tx: Queryable,
  input: AppendEventInput,
): Promise<AppendEventResult> {
  const id = ctx.newId();
  const at = ctx.now();
  await tx.run(
    `INSERT INTO events(id, task_id, actor_id, type, payload, recorded_at)
     VALUES(:id, :taskId, :actorId, :type, :payload, :at)`,
    {
      id,
      taskId: input.taskId,
      actorId: input.actorId,
      type: input.type,
      payload: encode(input.payload ?? {}),
      at,
    },
  );
  const inserted = await tx.one<{ seq: number }>('SELECT seq FROM events WHERE id = :id', { id });
  await tx.run('UPDATE tasks SET version = version + 1, updated_at = :at WHERE id = :taskId', {
    at,
    taskId: input.taskId,
  });
  const task = await tx.one<{ version: number }>('SELECT version FROM tasks WHERE id = :taskId', {
    taskId: input.taskId,
  });
  return { seq: Number(inserted?.seq ?? 0), taskVersion: Number(task?.version ?? 0) };
}

/** 当前任务的最新事件序号；用于判断阶段摘要是否已过期。 */
export async function latestSeq(ctx: Context, taskId: string): Promise<number> {
  const row = await ctx.db.read.one<{ seq: number | null }>(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = :taskId',
    { taskId },
  );
  return Number(row?.seq ?? 0);
}
