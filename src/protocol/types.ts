/**
 * 协作协议 v1 的公共类型。
 *
 * 这里的类型只描述"已经通过校验"的数据形状。任何来自网络、消息或
 * 其他智能体的 JSON 在进入领域层之前，都必须先经 protocol/parse.ts 校验；
 * TypeScript 类型不会在运行时提供任何保护。
 */

export const ROLES = ['admin', 'owner', 'agent', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/** 主体：人、服务账号或智能体在本工作空间中的身份。 */
export type Principal = {
  id: string;
  workspace: string;
  roles: Role[];
  /** did:wba 标识，预留给 anpio-key / anpio-cli 身份，当前可为空。 */
  did: string | null;
  displayName: string;
  description: string;
  capabilities: string[];
  active: boolean;
};

export const TASK_STATUSES = ['pending', 'running', 'review', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const SUBTASK_STATUSES = [
  'invited',
  'accepted',
  'submitted',
  'verified',
  'returned',
  'rejected',
  'timed_out',
  'outcome_unknown',
  'cancelled',
] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 任务输入：业务字段由任务类型约定，平台只保证它是一个 JSON 对象。 */
export type TaskInput = Record<string, unknown>;

/** 业务结果：至少给出一个数值或摘要，并必须带来源与观测时间。 */
export type SubtaskResult = {
  quantity?: number;
  summary?: string;
  source: string;
  observedAt: string;
  reference?: string;
};

export type Task = {
  id: string;
  workspace: string;
  type: string;
  title: string;
  goal: string;
  acceptance: string;
  priority: Priority;
  dueAt: string;
  ownerId: string;
  status: TaskStatus;
  input: TaskInput;
  result: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type Subtask = {
  id: string;
  taskId: string;
  agentId: string;
  kind: string;
  status: SubtaskStatus;
  result: SubtaskResult | { reason: string } | null;
  dueAt: string;
  dependsOn: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type TaskEvent = {
  seq: number;
  id: string;
  taskId: string;
  actorId: string;
  type: string;
  payload: Record<string, unknown>;
  recordedAt: string;
};

export const KNOWLEDGE_STATES = ['candidate', 'published', 'revoked'] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];

/** 知识可见范围：workspace 表示全工作空间，restricted 表示仅授权主体。 */
export type AccessMode = 'workspace' | 'restricted';

export type Knowledge = {
  id: string;
  workspace: string;
  sourceTaskId: string;
  content: string;
  conditions: string;
  state: KnowledgeState;
  version: number;
  authorId: string;
  reviewerId: string | null;
  expiresAt: string | null;
  accessMode: AccessMode;
  createdAt: string;
  updatedAt: string;
};

export type Notification = {
  id: string;
  recipientId: string;
  taskId: string;
  subtaskId: string;
  type: string;
  createdAt: string;
  acknowledgedAt: string | null;
};

/** 任务事件类型。用于事件时间线的展示与审计检索。 */
export type EventType =
  | 'task_created'
  | 'task_cancelled'
  | 'coordinator_delegated'
  | 'coordinator_removed'
  | 'subtask_invited'
  | 'subtask_accepted'
  | 'subtask_rejected'
  | 'subtask_progress'
  | 'subtask_submitted'
  | 'subtask_outcome_unknown'
  | 'subtask_timed_out'
  | 'subtask_returned'
  | 'subtask_cancelled'
  | 'summary_submitted'
  | 'task_accepted'
  | 'task_returned'
  | 'stage_summary_recorded'
  | 'knowledge_candidate'
  | 'knowledge_published'
  | 'knowledge_revoked'
  | 'knowledge_revised'
  | 'knowledge_access_changed'
  | 'knowledge_referenced';
