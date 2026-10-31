/**
 * 协作协议 v1 的公共类型。
 *
 * 这里的类型只描述"已经通过校验"的数据形状。任何来自网络、消息或
 * 其他智能体的 JSON 在进入领域层之前，都必须先经 protocol/parse.ts 校验；
 * TypeScript 类型不会在运行时提供任何保护。
 */

export const ROLES = ['admin', 'supervisor', 'owner', 'agent', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * 主体类型只影响展示与默认角色，**不参与授权**。
 * 授权永远看 roles 与资源归属，避免"声明自己是人就多拿权限"。
 */
export const PRINCIPAL_KINDS = ['human', 'agent', 'service'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/**
 * 租户角色与能力角色是两回事：
 *  - `tenantRole` 决定"能不能管这个组织"（加人、改角色、撤销 Agent）；
 *  - `roles` 决定"能做什么业务"（建任务、验收、看监管）。
 * 分开是为了避免"把某人设成管理员"顺手把全部业务权限也送出去。
 */
export const TENANT_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** 主体：人、服务账号或智能体在某个租户中的身份。 */
export type Principal = {
  id: string;
  workspace: string;
  roles: Role[];
  /** 全局账号：同一账号在不同租户里是不同主体。 */
  accountId: string | null;
  tenantRole: TenantRole;
  /** did:wba 标识；一个主体可以绑定多个 DID（人与智能体共用账号）。 */
  did: string | null;
  kind: PrincipalKind;
  /** 注册服务器上的短名，例如 alice.awiki.ai。 */
  handle: string | null;
  displayName: string;
  /** 头像：https 图片地址，或上传后压缩成的小尺寸 data URL；空表示用姓名首字。 */
  avatar: string;
  /** 一句话头衔，例如「履约负责人」。 */
  title: string;
  /** 个人简介，仅本人填写与展示。 */
  bio: string;
  description: string;
  capabilities: string[];
  active: boolean;
};

// ---------------------------------------------------------------- 租户

export type Tenant = {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  personal: boolean;
  createdAt: string;
  /** 当前账号在这个租户里的角色；列表接口会带上。 */
  role?: TenantRole;
};

export type TenantMember = {
  principalId: string;
  displayName: string;
  avatar: string;
  title: string;
  kind: PrincipalKind;
  tenantRole: TenantRole;
  roles: Role[];
  email: string | null;
  did: string | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Agent 成员显示持有者，人成员为空。 */
  ownerId: string | null;
  capabilities: string[];
};

export type TenantInvite = {
  id: string;
  email: string;
  role: TenantRole;
  kind: PrincipalKind;
  invitedBy: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  /** 只在开发模式返回，便于本地演示时直接复制。 */
  link?: string;
};

/** Agent 授权范围。默认最小集合，界面上逐项勾选。 */
export const AGENT_SCOPES = [
  'tasks:read',
  'tasks:submit',
  'offers:claim',
  'knowledge:read',
  'comments:write',
  'presence:write',
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export type AgentGrant = {
  id: string;
  agentPrincipalId: string;
  agentName: string;
  agentDid: string | null;
  ownerId: string;
  scopes: AgentScope[];
  status: 'active' | 'revoked';
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  /** 它手上还没结束的子任务：人据此知道自己的智能体在做什么。 */
  doing: AgentDoing[];
};

export type AgentDoing = {
  taskId: string;
  title: string;
  kind: string;
  status: SubtaskStatus;
  updatedAt: string;
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
  /** 谁发起的：人，还是某个智能体的自主提案。 */
  origin: TaskOrigin;
  originPrincipalId: string | null;
  /** 智能体提案被人接管的时间；为空表示仍在提案池里。 */
  adoptedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const TASK_ORIGINS = ['human', 'agent'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

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

export const KNOWLEDGE_STATES = ['draft', 'candidate', 'published', 'archived', 'revoked'] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];

/** AICD 的普通文档类型；其余 kind 只是可选的用途标签，不附带额外生命周期。 */
export const AICD_KINDS = ['document', 'experience', 'playbook', 'checklist', 'decision', 'report', 'handoff'] as const;
export type AicdKind = (typeof AICD_KINDS)[number];

/** 来路：任务验收沉淀、人手动编写、智能体候选。 */
export const AICD_SOURCES = ['task', 'manual', 'agent'] as const;
export type AicdSource = (typeof AICD_SOURCES)[number];

export const EVIDENCE_LEVELS = ['task_verified', 'manual', 'imported'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/** 知识可见范围：workspace 表示全工作空间，restricted 表示仅授权主体。 */
export type AccessMode = 'workspace' | 'restricted';

export type Knowledge = {
  id: string;
  workspace: string;
  /** 手动经验不绑任务，因此可空。 */
  sourceTaskId: string | null;
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
  kind: AicdKind;
  title: string;
  summary: string;
  tags: string[];
  source: AicdSource;
  evidenceLevel: EvidenceLevel;
  archivedAt: string | null;
  /** 列表补充的展示信息：作者姓名与来源空间。 */
  authorName?: string;
  sourceName?: string;
  sourcePersonal?: boolean;
  /** 仅来源空间条目携带：已分享到的团队。 */
  sharedTeams?: { id: string; name: string }[];
  /** 副本的来源链；根条目为空。 */
  copiedFrom?: CopiedFrom | null;
  /** 来源已被撤销：副本仍可用，但必须提示复核。 */
  sourceRevoked?: boolean;
  /** 来源空间可见：被复制到哪些空间。 */
  copies?: AicdCopyTarget[];
};

export type CopiedFrom = {
  id: string;
  version: number;
  workspace: string;
  workspaceName: string;
  personal: boolean;
  authorName: string;
  state: KnowledgeState;
  revoked: boolean;
};

export type AicdCopyTarget = {
  workspace: string;
  workspaceName: string;
  personal: boolean;
  knowledgeId: string;
  copiedAt: string;
  state: KnowledgeState;
};

export type KnowledgeVersion = {
  version: number;
  title: string;
  summary: string;
  content: string;
  conditions: string;
  tags: string[];
  reviewerId: string;
  expiresAt: string | null;
  publishedAt: string;
};

export const COPY_INVITE_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const;
export type CopyInviteStatus = (typeof COPY_INVITE_STATUSES)[number];

/** 复制给他人：对方接受后才落库。 */
export type CopyInvite = {
  id: string;
  knowledgeId: string;
  version: number;
  fromPrincipal: string;
  fromName: string;
  targetPrincipal: string;
  targetWorkspace: string;
  note: string;
  status: CopyInviteStatus;
  acceptedKnowledgeId: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  /** 邀请里展示来源摘要，不必先读来源才能判断。 */
  title?: string;
  summary?: string;
  kind?: AicdKind;
  sourceName?: string;
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
  | 'task_adopted'
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
  | 'knowledge_referenced'
  | 'knowledge_shared'
  | 'comment_added'
  | 'message_added'
  | 'thread_opened'
  | 'thread_resolved'
  | 'file_uploaded'
  | 'file_deleted'
  | 'aicd_created'
  | 'aicd_updated'
  | 'aicd_submitted'
  | 'aicd_archived'
  | 'aicd_copied'
  | 'aicd_copy_invited'
  | 'aicd_copy_accepted'
  | 'aicd_copy_declined'
  | 'offer_published'
  | 'offer_claimed'
  | 'offer_withdrawn';

// ---------------------------------------------------------------- 协作

export const MESSAGE_KINDS = [
  'comment',
  'question',
  'answer',
  'handoff',
  'decision',
  'status',
  'system',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** 任务房间消息：人和智能体共用一条时间线，提及者收到通知。 */
export type TaskComment = {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  authorKind: PrincipalKind;
  body: string;
  mentions: string[];
  createdAt: string;
  /** 消息类型；决定 UI 呈现与通知方式。 */
  kind: MessageKind;
  threadId: string | null;
  replyTo: string | null;
  /** 结构化字段：to / blocking / subtaskId / decision 等。 */
  payload: Record<string, unknown>;
  editedAt: string | null;
  /** 消息附带的文件。 */
  fileIds?: string[];
  /** 仅在"我的提醒"里出现，避免为它多造一个类型。 */
  taskTitle?: string;
  /** 提醒行自身的 ID；确认已读时用它，而不是评论 ID。 */
  mentionId?: string;
};

export const THREAD_STATUSES = ['open', 'resolved'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export type TaskThread = {
  id: string;
  workspace: string;
  taskId: string;
  topic: string;
  status: ThreadStatus;
  openedBy: string;
  openedByName: string;
  assigneeId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  messageCount: number;
};

export const SPACE_FILE_KINDS = ['input', 'intermediate', 'output', 'evidence', 'attachment'] as const;
export type SpaceFileKind = (typeof SPACE_FILE_KINDS)[number];

export type SpaceFile = {
  id: string;
  workspace: string;
  /** 独立附件（例如 AICD 的附件）不属于任何任务。 */
  taskId: string | null;
  subtaskId: string | null;
  messageId: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  storage: 'inline' | 'fs' | 's3';
  kind: SpaceFileKind;
  version: number;
  supersedesId: string | null;
  producedBy: string;
  producedByName: string;
  source: 'human_upload' | 'agent_upload' | 'tool_output';
  status: 'pending' | 'ready' | 'quarantined' | 'deleted';
  createdAt: string;
  deletedAt: string | null;
};

export type RoomActivity = {
  at: string;
  /** event / message / file / knowledge */
  stream: 'event' | 'message' | 'file' | 'knowledge';
  type: string;
  actorId: string;
  actorName: string;
  summary: string;
  taskId: string;
  payload: Record<string, unknown>;
};

export type TaskRoom = {
  task: Task;
  participants: { id: string; displayName: string; kind: PrincipalKind; avatar: string; role: string }[];
  counts: { messages: number; threadsOpen: number; files: number; knowledge: number };
  threads: TaskThread[];
  messages: TaskComment[];
  files: SpaceFile[];
  activity: RoomActivity[];
  knowledge: Knowledge[];
  /** 自上次已读以来的新消息；question 只统计点名问我的那些。 */
  unread: { messages: number; questions: number; mentions: number };
  lastReadAt: string | null;
};

export const OFFER_STATUSES = ['open', 'claimed', 'withdrawn'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** 开放子任务：负责人把工作挂出来，能力匹配的智能体自行认领。 */
export type TaskOffer = {
  id: string;
  taskId: string;
  kind: string;
  description: string;
  capability: string | null;
  dueAt: string;
  status: OfferStatus;
  createdBy: string;
  claimedBy: string | null;
  claimedAt: string | null;
  subtaskId: string | null;
  createdAt: string;
  /** 只在开放池列表里出现：让智能体知道这是哪件事，但不给目标与输入。 */
  taskTitle?: string;
};

export const PRESENCE_STATES = ['online', 'busy', 'offline'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export type Presence = {
  principalId: string;
  state: PresenceState;
  note: string;
  client: string;
  lastSeenAt: string;
  /** 距上次心跳的秒数；从未上报时为空。 */
  silentSeconds: number | null;
  /** 监管看板用；单条心跳响应不带。 */
  displayName?: string;
};

// ---------------------------------------------------------------- 监管

export const ALERT_SEVERITIES = ['critical', 'high', 'normal', 'low'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export type Alert = {
  id: string;
  rule: string;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  detail: string;
  subjectType: string;
  subjectId: string;
  taskId: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
};
