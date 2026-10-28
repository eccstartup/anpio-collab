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
import { KnowledgeService } from './services/knowledge.ts';
import { NotificationService } from './services/notifications.ts';
import { PrincipalService } from './services/principals.ts';
import { SubtaskService } from './services/subtasks.ts';
import { TaskService } from './services/tasks.ts';

export type App = {
  ctx: Context;
  principals: PrincipalService;
  tasks: TaskService;
  subtasks: SubtaskService;
  knowledge: KnowledgeService;
  notifications: NotificationService;
  audit: AuditService;
};

export async function createApp(
  db: Database,
  options: { now?: () => string; newId?: () => string } = {},
): Promise<App> {
  const ctx = createContext(db, options);
  await migrate(db, ctx.now);

  const audit = new AuditService(ctx);
  const notifications = new NotificationService(ctx);
  const knowledge = new KnowledgeService(ctx);
  const tasks = new TaskService(ctx, notifications, knowledge);
  const subtasks = new SubtaskService(ctx, notifications);
  const principals = new PrincipalService(ctx);

  return { ctx, principals, tasks, subtasks, knowledge, notifications, audit };
}
