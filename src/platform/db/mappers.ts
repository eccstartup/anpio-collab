/**
 * 行 → 领域对象映射。
 *
 * 数据库列用 snake_case，协议用 camelCase；转换集中在这一个文件里，
 * 服务层因此不需要重复 `String(row.x)` 这类噪音。
 */

import type {
  Knowledge,
  Notification,
  Principal,
  Priority,
  Role,
  Subtask,
  SubtaskResult,
  SubtaskStatus,
  Task,
  TaskEvent,
  TaskStatus,
} from '../../protocol/types.ts';
import type { Row } from './driver.ts';

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const number = (value: unknown): number => (typeof value === 'number' ? value : Number(value));
const bool = (value: unknown): boolean => Number(value) === 1 || value === true;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toPrincipal(row: Row): Principal {
  const tenantRole =
    row.tenant_role === 'owner' || row.tenant_role === 'admin' || row.tenant_role === 'guest'
      ? row.tenant_role
      : 'member';
  return {
    id: text(row.id),
    workspace: text(row.workspace),
    roles: parseJson<Role[]>(row.roles, []),
    accountId: row.account_id === null || row.account_id === undefined ? null : text(row.account_id),
    tenantRole,
    did: row.did === null || row.did === undefined ? null : text(row.did),
    kind: (row.kind === 'agent' || row.kind === 'service' ? row.kind : 'human') as Principal['kind'],
    handle: row.handle === null || row.handle === undefined ? null : text(row.handle),
    displayName: text(row.display_name),
    avatar: text(row.avatar),
    title: text(row.title),
    bio: text(row.bio),
    description: text(row.description),
    capabilities: parseJson<string[]>(row.capabilities, []),
    active: bool(row.active),
  };
}

export function toTask(row: Row): Task {
  return {
    id: text(row.id),
    workspace: text(row.workspace),
    type: text(row.type),
    title: text(row.title),
    goal: text(row.goal),
    acceptance: text(row.acceptance),
    priority: text(row.priority) as Priority,
    dueAt: text(row.due_at),
    ownerId: text(row.owner_id),
    status: text(row.status) as TaskStatus,
    input: parseJson<Record<string, unknown>>(row.input, {}),
    result: parseJson<unknown>(row.result, null),
    version: number(row.version),
    origin: row.origin === 'agent' ? 'agent' : 'human',
    originPrincipalId:
      row.origin_principal_id === null || row.origin_principal_id === undefined
        ? null
        : text(row.origin_principal_id),
    adoptedAt: row.adopted_at === null || row.adopted_at === undefined ? null : text(row.adopted_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export function toSubtask(row: Row): Subtask {
  return {
    id: text(row.id),
    taskId: text(row.task_id),
    agentId: text(row.agent_id),
    kind: text(row.kind),
    status: text(row.status) as SubtaskStatus,
    result: parseJson<SubtaskResult | { reason: string } | null>(row.result, null),
    dueAt: text(row.due_at),
    dependsOn: [],
    version: number(row.version),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export function toEvent(row: Row): TaskEvent {
  return {
    seq: number(row.seq),
    id: text(row.id),
    taskId: text(row.task_id),
    actorId: text(row.actor_id),
    type: text(row.type),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    recordedAt: text(row.recorded_at),
  };
}

export function toKnowledge(row: Row, accessMode: 'workspace' | 'restricted' = 'restricted'): Knowledge {
  return {
    id: text(row.id),
    workspace: text(row.workspace),
    sourceTaskId: text(row.task_id),
    content: text(row.content),
    conditions: text(row.conditions),
    state: text(row.state) as Knowledge['state'],
    version: number(row.version),
    authorId: text(row.author_id),
    reviewerId: row.reviewer_id === null || row.reviewer_id === undefined ? null : text(row.reviewer_id),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : text(row.expires_at),
    accessMode,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export function toNotification(row: Row): Notification {
  return {
    id: text(row.id),
    recipientId: text(row.recipient_id),
    taskId: text(row.task_id),
    subtaskId: text(row.subtask_id),
    type: text(row.type),
    createdAt: text(row.created_at),
    acknowledgedAt:
      row.acknowledged_at === null || row.acknowledged_at === undefined ? null : text(row.acknowledged_at),
  };
}

export const encode = (value: unknown): string => JSON.stringify(value);
