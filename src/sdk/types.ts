/**
 * SDK 的返回视图。
 *
 * 这些类型描述平台实际返回的 JSON，供调用方直接使用；
 * 它们仍不构成运行时保证——服务端已校验请求，但客户端不能假设
 * 返回内容一定符合预期（例如版本升级后的旧服务端）。
 */

import type {
  Knowledge,
  MessageKind,
  Notification,
  Principal,
  Priority,
  SpaceFile,
  Subtask,
  SubtaskStatus,
  Task,
  TaskComment,
  TaskEvent,
  TaskRoom,
  TaskStatus,
  TaskThread,
} from '../protocol/types.ts';

export type TaskRef = { id: string; status: TaskStatus; version: number; workspace?: string };

export type SubtaskRef = {
  id: string;
  taskId?: string;
  agentId?: string;
  kind?: string;
  status: SubtaskStatus;
  version: number;
  dueAt?: string;
  dependsOn?: string[];
  result?: unknown;
};

export type StatusChange = { status: TaskStatus; version: number };
export type TaskParticipantView = {
  id: string;
  taskId: string;
  humanPrincipalId: string;
  displayName: string;
  email: string | null;
  invitedBy: string;
  status: 'invited' | 'accepted' | 'declined' | 'revoked';
  agentId: string | null;
  agentName: string | null;
  note: string;
  createdAt: string;
  respondedAt: string | null;
  /** 仅 /v1/task-invitations 返回。 */
  taskTitle?: string;
  taskStatus?: TaskStatus;
  invitedByName?: string;
};

export type TaskRequestView = {
  id: string;
  taskId: string;
  fromPrincipal: string;
  toPrincipal: string;
  role: 'coordinate' | 'subtask';
  payload: Record<string, unknown>;
  counter: Record<string, unknown> | null;
  status: 'proposed' | 'accepted' | 'declined' | 'countered' | 'withdrawn';
  subtaskId: string | null;
  createdAt: string;
  respondedAt: string | null;
  taskTitle: string;
  fromName: string;
  toName: string;
};
/** 跨任务动态：工作台的「最近活动」直接消费这个结构。 */
export type ActivityItem = {
  seq: number;
  taskId: string;
  taskTitle: string;
  actorId: string;
  type: string;
  payload: Record<string, unknown>;
  recordedAt: string;
};

export type TaskListItem = {
  id: string;
  title: string;
  type: string;
  status: TaskStatus;
  priority: Priority;
  ownerId: string;
  ownerName: string;
  dueAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  subtaskCount: number;
  subtaskDone: number;
  archivedAt?: string | null;
};

/** 任务引用的经验：正文取自被钉住的那一版，修订后仍能看到当时的依据。 */
export type KnowledgeRef = {
  knowledgeId: string;
  version: number;
  content: string | null;
  conditions: string | null;
};

/** 任务材料：创建任务时随任务提交的文件，可见性跟随任务。 */
export type MaterialMeta = {
  id: string;
  name: string;
  mime: string;
  size: number;
  uploadedBy: string;
  createdAt: string;
};

export type MaterialContent = MaterialMeta & { data: string };

export type TaskDetail = {
  /** 任务本体，附带负责人显示名，省去调用方再查目录。 */
  task: Task & { ownerName: string };
  subtasks: Subtask[];
  coordinators: string[];
  events: TaskEvent[];
  knowledgeRefs: KnowledgeRef[];
  materials: MaterialMeta[];
  /** 调用方是否能看到全部子任务与事件（负责人、协调者、管理员为 true）。 */
  unrestricted: boolean;
};

export type StageSummary = {
  version: number;
  text: string;
  pending: string;
  throughSeq: number;
  authorId: string;
  createdAt: string;
  stale: boolean;
};

export type TaskContext = {
  task: Pick<Task, 'id' | 'title' | 'type' | 'status' | 'version' | 'acceptance' | 'dueAt'>;
  subtasks: { id: string; kind: string; agentId: string; status: SubtaskStatus; version: number; dueAt: string }[];
  pending: { id: string; status: SubtaskStatus; kind: string }[];
  result: unknown;
  references: KnowledgeRef[];
  stageSummary: StageSummary | null;
  events: TaskEvent[];
  eventsTruncated: boolean;
};

export type InboxItem = {
  id: string;
  taskId: string;
  kind: string;
  status: SubtaskStatus;
  version: number;
  dueAt: string;
  dependsOn: string[];
  task: {
    id: string;
    title: string;
    type: string;
    priority: Priority;
    acceptance: string;
    dueAt: string;
    input: Record<string, unknown>;
  };
};

export type KnowledgeSummary = Pick<
  Knowledge,
  | 'id'
  | 'workspace'
  | 'version'
  | 'content'
  | 'conditions'
  | 'state'
  | 'expiresAt'
  | 'sourceTaskId'
  | 'reviewerId'
  | 'authorId'
  | 'authorName'
  | 'sourceName'
  | 'sourcePersonal'
  | 'sharedTeams'
>;

export type KnowledgeSearchItem = KnowledgeSummary & {
  reference: string;
  score: number;
  contentTruncated: boolean;
};

export type KnowledgeSearch = {
  items: KnowledgeSearchItem[];
  truncated: boolean;
  usedChars: number;
  budgetChars: number;
  budgetUnit: string;
  retrieval: string;
  note: string;
};

export type Evidence = {
  id?: string;
  knowledgeId?: string;
  version: number;
  content: string;
  conditions: string;
  reviewerId?: string | null;
  expiresAt: string;
  sourceTaskId: string;
  reference?: string;
  currentState?: string;
  currentVersion?: number;
};

export type NotificationView = Notification;
export type PrincipalView = Principal;
export type { MessageKind, SpaceFile, TaskComment, TaskRoom, TaskThread };
export type { MailEnvelope, MailMessage, MailSession, MailSubscription } from '../protocol/types.ts';
export type AuditEntry = {
  seq: number;
  principalId: string;
  action: string;
  outcome: string;
  recordedAt: string;
};

export type AuditReport = {
  days: number;
  since: string;
  generatedAt: string;
  totals: { entries: number; denied: number; byOutcome: Record<string, number> };
  byAction: { action: string; total: number; denied: number }[];
  byDay: { day: string; total: number; denied: number }[];
  topPrincipals: { principalId: string; total: number }[];
};

export type RetentionResult = {
  days: number;
  cutoff: string;
  applied: boolean;
  candidates: { objectKey: string; sha256: string; storage: string; size: number; fileCount: number; lastDeleted: string }[];
  candidatesTruncated: boolean;
  removed: number;
  removedBytes: number;
  skipped: { objectKey: string; reason: string }[];
};
