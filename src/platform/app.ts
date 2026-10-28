/**
 * 应用装配。
 *
 * 服务之间只通过构造函数注入，HTTP 层只依赖这里的 App 类型。
 * 这样领域逻辑可以在没有 HTTP 的情况下被测试，也可以换一前端或换一种传输。
 */

import type { Database } from './db/driver.ts';
import { migrate } from './db/schema.ts';
import { createContext, type Context } from './context.ts';
import { AuditService } from './services/audit.ts';
import { CollabService } from './services/collab.ts';
import { IdentityService, type EnrollMode } from './services/identity.ts';
import { KnowledgeService } from './services/knowledge.ts';
import { NotificationService } from './services/notifications.ts';
import { OversightService, type OversightThresholds } from './services/oversight.ts';
import { PrincipalService } from './services/principals.ts';
import { SubtaskService } from './services/subtasks.ts';
import { TaskService } from './services/tasks.ts';

export type IdentitySettings = {
  workspace: string;
  enroll: EnrollMode;
  sessionTtlHours: number;
  nonceTtlSeconds: number;
};

export type App = {
  ctx: Context;
  principals: PrincipalService;
  identity: IdentityService;
  tasks: TaskService;
  subtasks: SubtaskService;
  knowledge: KnowledgeService;
  notifications: NotificationService;
  collab: CollabService;
  oversight: OversightService;
  audit: AuditService;
};

export type AppOptions = {
  now?: () => string;
  newId?: () => string;
  /** ANP 身份默认值面向本机验证；企业部署应显式配置。 */
  identity?: Partial<IdentitySettings>;
  oversight?: Partial<OversightThresholds>;
};

export async function createApp(db: Database, options: AppOptions = {}): Promise<App> {
  const ctx = createContext(db, options);
  await migrate(db, ctx.now);

  const audit = new AuditService(ctx);
  const notifications = new NotificationService(ctx);
  const knowledge = new KnowledgeService(ctx);
  const tasks = new TaskService(ctx, notifications, knowledge);
  const subtasks = new SubtaskService(ctx, notifications);
  const principals = new PrincipalService(ctx);
  const workspace = process.env.COLLAB_WORKSPACE ?? 'local';

  const identity = new IdentityService(ctx, {
    workspace: options.identity?.workspace ?? process.env.COLLAB_WORKSPACE ?? 'local',
    enroll: options.identity?.enroll ?? 'open',
    sessionTtlHours: options.identity?.sessionTtlHours ?? 24 * 7,
    nonceTtlSeconds: options.identity?.nonceTtlSeconds ?? 300,
  });
  const collab = new CollabService(ctx, notifications);
  const oversight = new OversightService(ctx, options.oversight);

  return { ctx, principals, identity, tasks, subtasks, knowledge, notifications, collab, oversight, audit };
}
