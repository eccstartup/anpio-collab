/**
 * 应用装配。
 *
 * 服务之间只通过构造函数注入，HTTP 层只依赖这里的 App 类型。
 * 这样领域逻辑可以在没有 HTTP 的情况下被测试，也可以换一前端或换一种传输。
 */

import type { Database } from './db/driver.ts';
import { migrate } from './db/schema.ts';
import { createHttpDidResolver, type DidResolver } from '../anp/resolver.ts';
import { createContext, type Context } from './context.ts';
import { AccountService } from './services/accounts.ts';
import { AgentAuthService } from './services/agentAuth.ts';
import { AuditService } from './services/audit.ts';
import { CollabService } from './services/collab.ts';
import { EmailAuthService } from './services/emailAuth.ts';
import { IdentityService, type EnrollMode } from './services/identity.ts';
import { KnowledgeService } from './services/knowledge.ts';
import { MailService, type MailMode } from './services/mail.ts';
import { NotificationService } from './services/notifications.ts';
import { OversightService, type OversightThresholds } from './services/oversight.ts';
import { PrincipalService } from './services/principals.ts';
import { SubtaskService } from './services/subtasks.ts';
import { TaskService } from './services/tasks.ts';
import { TenantService } from './services/tenants.ts';

export type IdentitySettings = {
  workspace: string;
  enroll: EnrollMode;
  sessionTtlHours: number;
  nonceTtlSeconds: number;
  /** 内网部署没有证书时打开，允许用 http 取 did.json。默认只对本机回环放行。 */
  didAllowHttp?: boolean;
  /** 自定义解析器（测试注入）；不传就按 didAllowHttp 建一个 HTTP 解析器。 */
  didResolver?: DidResolver;
};

export type MailSettings = {
  mode: MailMode;
  baseUrl: string;
  exposeOutbox: boolean;
};

export type App = {
  ctx: Context;
  principals: PrincipalService;
  identity: IdentityService;
  accounts: AccountService;
  tenants: TenantService;
  emailAuth: EmailAuthService;
  agentAuth: AgentAuthService;
  mail: MailService;
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
  mail?: Partial<MailSettings>;
};

export async function createApp(db: Database, options: AppOptions = {}): Promise<App> {
  const ctx = createContext(db, options);
  await migrate(db, ctx.now);

  const audit = new AuditService(ctx);
  const notifications = new NotificationService(ctx);
  const principals = new PrincipalService(ctx);
  const workspace = process.env.COLLAB_WORKSPACE ?? 'local';

  const accounts = new AccountService(ctx);
  const mail = new MailService(ctx, {
    mode: options.mail?.mode ?? 'outbox',
    baseUrl: options.mail?.baseUrl ?? process.env.COLLAB_PUBLIC_URL ?? 'http://127.0.0.1:8787',
    // 本地参考实现默认开放"看最近邮件"，否则第一次跑起来根本收不到登录链接。
    // 生产部署必须设置 COLLAB_DEV_MAIL=0。
    exposeOutbox:
      options.mail?.exposeOutbox ?? (process.env.COLLAB_DEV_MAIL ?? '1') !== '0',
  });
  const tenants = new TenantService(ctx, accounts, mail);
  const knowledge = new KnowledgeService(ctx, tenants, accounts);
  const tasks = new TaskService(ctx, notifications, knowledge);
  const subtasks = new SubtaskService(ctx, notifications);

  const identity = new IdentityService(
    ctx,
    {
      workspace: options.identity?.workspace ?? process.env.COLLAB_WORKSPACE ?? 'local',
      enroll: options.identity?.enroll ?? 'open',
      sessionTtlHours: options.identity?.sessionTtlHours ?? 24 * 7,
      nonceTtlSeconds: options.identity?.nonceTtlSeconds ?? 300,
      didResolver:
        options.identity?.didResolver ??
        createHttpDidResolver({ allowInsecureHttp: options.identity?.didAllowHttp ?? false }),
    },
    accounts,
  );
  const emailAuth = new EmailAuthService(
    ctx,
    { accounts, tenants, identity, mail },
    { ticketMinutes: 15, selectionMinutes: 30 },
  );
  const agentAuth = new AgentAuthService(ctx, tenants, identity);
  const collab = new CollabService(ctx, notifications);
  const oversight = new OversightService(ctx, options.oversight);

  return {
    ctx,
    principals,
    identity,
    accounts,
    tenants,
    emailAuth,
    agentAuth,
    mail,
    tasks,
    subtasks,
    knowledge,
    notifications,
    collab,
    oversight,
    audit,
  };
}
