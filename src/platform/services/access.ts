/**
 * 访问控制。
 *
 * 平台的授权只回答"这个主体能不能对这个资源做这个动作"，不判断业务结论是否正确。
 * 所有检查都基于数据库中的当前状态，而不是请求方声明的角色或消息内容。
 */

import { forbidden, notFound } from '../../protocol/errors.ts';
import type { AgentScope, Principal, Role, Subtask, Task } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import { toSubtask, toTask } from '../db/mappers.ts';

export const hasAnyRole = (principal: Principal, ...roles: Role[]): boolean =>
  roles.some(role => principal.roles.includes(role));

export function requireRole(principal: Principal, ...roles: Role[]): void {
  if (!hasAnyRole(principal, ...roles)) throw forbidden(`需要 ${roles.join(' / ')} 角色`);
}

/** 按工作空间隔离读取任务；不存在与跨工作空间一律 404。 */
export async function loadTask(ctx: Context, principal: Principal, taskId: string): Promise<Task> {
  const row = await ctx.db.read.one('SELECT * FROM tasks WHERE id = :id AND workspace = :workspace', {
    id: taskId,
    workspace: principal.workspace,
  });
  if (!row) throw notFound('任务不存在');
  return toTask(row);
}

export async function isCoordinator(ctx: Context, principal: Principal, taskId: string): Promise<boolean> {
  const row = await ctx.db.read.one(
    'SELECT 1 AS present FROM task_coordinators WHERE task_id = :taskId AND principal_id = :principal',
    { taskId, principal: principal.id },
  );
  return Boolean(row);
}

/** 可读 = 管理员 / 负责人 / 委派协调者 / 受派智能体。 */
export async function readTask(ctx: Context, principal: Principal, taskId: string): Promise<Task> {
  const task = await loadTask(ctx, principal, taskId);
  if (hasAnyRole(principal, 'admin') || task.ownerId === principal.id) return task;
  if (await isCoordinator(ctx, principal, taskId)) return task;
  const assigned = await ctx.db.read.one(
    'SELECT 1 AS present FROM subtasks WHERE task_id = :taskId AND agent_id = :principal LIMIT 1',
    { taskId, principal: principal.id },
  );
  if (assigned) return task;
  throw forbidden('无权访问该任务');
}

/** 只有负责人和管理员可以验收、取消、指派。 */
export function assertOwner(principal: Principal, task: Task): void {
  if (task.ownerId !== principal.id && !hasAnyRole(principal, 'admin')) {
    throw forbidden('只有任务负责人或管理员可以执行该操作');
  }
}

/** 负责人、管理员或已委派的协调者可以提议分工与汇总。 */
export async function assertCoordinator(
  ctx: Context,
  principal: Principal,
  task: Task,
): Promise<void> {
  if (task.ownerId === principal.id || hasAnyRole(principal, 'admin')) return;
  if (await isCoordinator(ctx, principal, task.id)) return;
  throw forbidden('只有负责人、协调者或管理员可以执行该操作');
}

/** 读取子任务并确认调用方就是受派智能体。 */
export async function agentSubtask(
  ctx: Context,
  principal: Principal,
  subtaskId: string,
): Promise<Subtask> {
  const row = await ctx.db.read.one(
    `SELECT s.* FROM subtasks s
     JOIN tasks t ON t.id = s.task_id
     WHERE s.id = :id AND t.workspace = :workspace`,
    { id: subtaskId, workspace: principal.workspace },
  );
  if (!row) throw notFound('子任务不存在');
  const subtask = toSubtask(row);
  if (subtask.agentId !== principal.id) throw forbidden('只有受派智能体可以执行该操作');
  requireRole(principal, 'agent', 'admin');
  return subtask;
}

/** 读取任意子任务（负责人视角），仍受工作空间隔离。 */
export async function loadSubtask(
  ctx: Context,
  principal: Principal,
  subtaskId: string,
): Promise<Subtask> {
  const row = await ctx.db.read.one(
    `SELECT s.* FROM subtasks s
     JOIN tasks t ON t.id = s.task_id
     WHERE s.id = :id AND t.workspace = :workspace`,
    { id: subtaskId, workspace: principal.workspace },
  );
  if (!row) throw notFound('子任务不存在');
  return toSubtask(row);
}

/**
 * Agent 授权范围检查。
 *
 * 只对"通过设备授权码接入"的 Agent 生效：它们有 `agent_grants` 记录。
 * 用静态令牌或 DID 直接登记的老主体没有这条记录，保持原有行为——
 * 这是一次有意的兼容取舍，不是遗漏；迁移到设备授权的 Agent 都会走检查。
 */
export async function requireAgentScope(
  ctx: Context,
  principal: Principal,
  scope: AgentScope,
): Promise<void> {
  if (principal.kind !== 'agent' && principal.kind !== 'service') return;
  const grant = await ctx.db.read.one<{ scopes: string; status: string; expires_at: string | null }>(
    'SELECT scopes, status, expires_at FROM agent_grants WHERE agent_principal_id = :id',
    { id: principal.id },
  );
  if (!grant) return;
  if (String(grant.status) !== 'active') throw forbidden('该智能体的授权已被撤销');
  if (grant.expires_at !== null && String(grant.expires_at) <= ctx.now()) {
    throw forbidden('该智能体的授权已过期，请让主人重新批准');
  }
  let scopes: string[] = [];
  try {
    scopes = JSON.parse(String(grant.scopes)) as string[];
  } catch {
    scopes = [];
  }
  if (!scopes.includes(scope)) throw forbidden(`缺少授权范围 ${scope}`);
}
