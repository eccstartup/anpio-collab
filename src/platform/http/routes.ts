/**
 * 接口清单。
 *
 * 每个接口一行。处理函数只做"解析参数 → 调用服务 → 返回结果"，
 * 授权细节在 authorize 与服务内部完成，事务由执行器负责。
 *
 * 版本语义：带 If-Match 的写操作，authorize 必须返回被操作资源的版本。
 * 任务级操作比任务版本，子任务级操作比子任务版本。
 */

import { forbidden, invalid } from '../../protocol/errors.ts';
import { asEnum, asInteger, asObject, asString } from '../../protocol/parse.ts';
import { TASK_STATUSES } from '../../protocol/types.ts';
import {
  agentSubtask,
  assertCoordinator,
  assertOwner,
  loadSubtask,
  readTask,
} from '../services/access.ts';
import type { ReadContext, Route, WriteContext } from './router.ts';
import type { Authorized } from './router.ts';

const parseLimit = (query: URLSearchParams, fallback: number): number =>
  asInteger(Number(query.get('limit') ?? fallback), 'limit', { min: 1, max: 100 });

const parseOffset = (query: URLSearchParams): number =>
  asInteger(Number(query.get('offset') ?? 0), 'offset', { min: 0, max: 1_000_000 });

const parseQuery = (query: URLSearchParams, name = 'q', max = 200): string => {
  const value = (query.get(name) ?? '').trim();
  if (value.length > max) throw invalid(`${name} 过长`);
  return value;
};

const parseStatus = (query: URLSearchParams) => {
  const raw = query.get('status');
  return raw === null || raw === '' ? undefined : asEnum(raw, 'status', TASK_STATUSES);
};

/** 任务级写操作的授权与版本。 */
const onTask = async (ctx: WriteContext, mode: 'owner' | 'coordinator'): Promise<Authorized> => {
  const task = await readTask(ctx.app.ctx, ctx.principal, ctx.params.id ?? '');
  if (mode === 'owner') assertOwner(ctx.principal, task);
  else await assertCoordinator(ctx.app.ctx, ctx.principal, task);
  return { version: task.version };
};

/** 智能体操作自己的子任务。 */
const onOwnSubtask = async (ctx: WriteContext): Promise<Authorized> => {
  const subtask = await agentSubtask(ctx.app.ctx, ctx.principal, ctx.params.id ?? '');
  return { version: subtask.version };
};

/** 负责人操作子任务（超时、退回）。 */
const onSubtaskAsOwner = async (ctx: WriteContext): Promise<Authorized> => {
  const subtask = await loadSubtask(ctx.app.ctx, ctx.principal, ctx.params.id ?? '');
  const task = await readTask(ctx.app.ctx, ctx.principal, subtask.taskId);
  assertOwner(ctx.principal, task);
  return { version: subtask.version };
};

const parseVersion = (raw: string | undefined): number => {
  if (!raw || !/^\d{1,9}$/.test(raw)) throw invalid('version 必须是正整数');
  return Number(raw);
};

export const routes: Route[] = [
  // ------------------------------------------------------------ 身份
  {
    method: 'GET',
    path: '/v1/me',
    description: '当前主体及其角色、租户与 Agent 授权范围',
    read: async ({ app, principal }) => {
      const grant = await app.ctx.db.read.one<{ scopes: string; expires_at: string | null; status: string }>(
        'SELECT scopes, expires_at, status FROM agent_grants WHERE agent_principal_id = :id',
        { id: principal.id },
      );
      const active =
        grant && grant.status === 'active' && (grant.expires_at === null || String(grant.expires_at) > app.ctx.now());
      return {
        id: principal.id,
        workspace: principal.workspace,
        roles: principal.roles,
        tenantRole: principal.tenantRole,
        accountId: principal.accountId,
        did: principal.did,
        kind: principal.kind,
        handle: principal.handle,
        displayName: principal.displayName,
        avatar: principal.avatar,
        title: principal.title,
        bio: principal.bio,
        capabilities: principal.capabilities,
        scopes: active ? (JSON.parse(String(grant.scopes)) as string[]) : null,
        grantExpiresAt: active ? (grant.expires_at === null ? null : String(grant.expires_at)) : null,
      };
    },
  },
  {
    method: 'POST',
    path: '/v1/me/profile',
    description: '更新我的个人资料：姓名、头像、头衔与简介',
    write: {
      execute: async ({ app, principal, body }) => app.principals.updateMyProfile(principal, body),
    },
  },
  {
    method: 'GET',
    path: '/v1/me/tenants',
    description: '我所属的全部租户（跨租户，按账号）',
    read: async ({ app, principal }) => {
      const tenants = await app.tenants.listFor(principal.accountId);
      // 遗留主体没有账号：至少让它看到自己当前所在的那一个。
      if (tenants.length === 0) {
        const detail = await app.tenants.detail(principal);
        return [{ id: detail.id, name: detail.name, personal: detail.personal, role: principal.tenantRole }];
      }
      return tenants;
    },
  },
  {
    method: 'POST',
    path: '/v1/me/switch',
    description: '切换到另一个租户，换发会话并作废当前会话',
    write: {
      execute: async ({ app, principal, body, token }) => {
        const tenantId = asString(asObject(body).tenantId, 'tenantId', { max: 100, min: 1 });
        if (!principal.accountId) throw forbidden('当前主体未绑定账号，无法切换组织');
        const memberships = await app.tenants.listFor(principal.accountId);
        if (!memberships.some(item => item.id === tenantId)) throw forbidden('你不属于这个组织');
        const account = await app.accounts.findById(principal.accountId);
        if (!account) throw forbidden('账号不存在');
        const target = await app.tenants.principalFor(account, tenantId);
        const session = await app.identity.openSession(target, target.did, 'browser');
        await app.identity.logout(token);
        return {
          token: session.token,
          expiresAt: session.expiresAt,
          tenant: { id: tenantId, role: target.tenantRole },
        };
      },
    },
  },
  {
    method: 'POST',
    path: '/v1/tenants',
    description: '新建团队：创建者成为所有者，并换发到这个团队的会话',
    write: {
      execute: async ({ app, principal, body, token }) => {
        const name = asString(asObject(body).name, 'name', { max: 120, min: 1 });
        if (!principal.accountId) throw forbidden('当前主体未绑定账号，无法新建团队');
        const account = await app.accounts.findById(principal.accountId);
        if (!account) throw forbidden('账号不存在');
        const target = await app.tenants.createTenant(account, name);
        const session = await app.identity.openSession(target, target.did, 'browser');
        await app.identity.logout(token);
        return {
          token: session.token,
          expiresAt: session.expiresAt,
          tenant: { id: target.workspace, name, role: target.tenantRole },
        };
      },
    },
  },
  {
    method: 'POST',
    path: '/v1/me/logout',
    description: '退出当前会话（只撤销这一个令牌）',
    write: {
      execute: async ({ app, token }) => {
        await app.identity.logout(token);
        return { ok: true };
      },
    },
  },
  {
    method: 'GET',
    path: '/v1/me/links',
    description: '当前账号绑定的登录方式（邮箱与 DID），用于设置页的账号总览',
    read: async ({ app, principal }) => {
      if (!principal.accountId) return { accountId: null, links: [] };
      const links = await app.accounts.links(principal.accountId);
      return { accountId: principal.accountId, links };
    },
  },
  {
    method: 'POST',
    path: '/v1/me/emails/start',
    description: '给当前账号补绑一个邮箱：发一封确认信，点开链接才算绑定',
    write: {
      execute: async ({ app, principal, body, origin, headers }) => {
        if (!principal.accountId) throw forbidden('当前主体还没有账号，无法绑定邮箱');
        const input = asObject(body);
        return app.emailAuth.startBind({
          accountId: principal.accountId,
          email: input.email,
          origin: origin || undefined,
          userAgent: String(headers['user-agent'] ?? ''),
        });
      },
    },
  },
  {
    method: 'GET',
    path: '/v1/me/identities',
    description: '当前主体绑定的 DID',
    read: async ({ app, principal }) => app.identity.listIdentities(principal),
  },
  {
    method: 'GET',
    path: '/v1/me/identities/challenge',
    description: '签发一次补绑 DID 的挑战（已登录后把钱包身份挂到本账号）',
    read: async ({ app, principal, origin }) => app.identity.issueBindChallenge(origin),
  },
  {
    method: 'POST',
    path: '/v1/me/identities/bind',
    description: '用钱包对挑战签名，把该 DID 补绑到当前主体（签名请求）',
    write: {
      execute: async ({ app, principal, path, origin, headers, rawBody }) =>
        app.identity.bindDid(principal, {
          method: 'POST',
          // 签名覆盖 `@target-uri`，必须与客户端实际请求的地址逐字一致。
          url: `${origin}${path}`,
          headers,
          rawBody,
        }),
    },
  },
  {
    method: 'POST',
    path: '/v1/me/identities/invite',
    description: '签发绑定码：让另一个 DID（通常是智能体）登进同一账号',
    write: { execute: async ({ app, principal, body }) => app.identity.createInvite(principal, body) },
  },
  {
    method: 'POST',
    path: '/v1/me/identities/:id/revoke',
    description: '解绑一个 DID 并撤销它的会话',
    write: {
      execute: async ({ app, principal, params }) =>
        app.identity.revokeIdentity(principal, params.id ?? ''),
    },
  },
  {
    method: 'GET',
    path: '/v1/me/sessions',
    description: '当前主体的会话列表',
    read: async ({ app, principal }) => app.identity.listSessions(principal),
  },
  {
    method: 'POST',
    path: '/v1/me/sessions/:id/revoke',
    description: '撤销指定会话',
    write: {
      execute: async ({ app, principal, params }) =>
        app.identity.revokeSession(principal, params.id ?? ''),
    },
  },
  {
    method: 'GET',
    path: '/v1/me/mentions',
    description: '我被提及但尚未处理的评论',
    read: async ({ app, principal }) => app.collab.mentions(principal),
  },
  {
    method: 'POST',
    path: '/v1/me/mentions/:id/read',
    description: '把一条提及标记为已读',
    write: {
      execute: async ({ app, principal, params }) => app.collab.readMention(principal, params.id ?? ''),
    },
  },

  // ------------------------------------------------------------ 租户与成员
  {
    method: 'GET',
    path: '/v1/tenants/current',
    description: '当前租户详情与成员计数',
    read: async ({ app, principal }) => app.tenants.detail(principal),
  },
  {
    method: 'POST',
    path: '/v1/tenants/current/rename',
    description: '重命名当前租户（所有者、管理员）',
    write: {
      execute: async ({ app, principal, body }) => app.tenants.rename(principal, body),
    },
  },
  {
    method: 'GET',
    path: '/v1/tenants/current/members',
    description: '成员列表：人、Agent 与待接受邀请（所有者、管理员）',
    read: async ({ app, principal }) => app.tenants.members(principal),
  },
  {
    method: 'POST',
    path: '/v1/members/:id/role',
    description: '调整成员在租户中的角色（所有者、管理员）',
    write: {
      execute: async ({ app, principal, params, body }) =>
        app.tenants.setMemberRole(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/members/:id/remove',
    description: '移除成员：停用主体并作废会话（所有者、管理员）',
    write: {
      execute: async ({ app, principal, params }) => app.tenants.removeMember(principal, params.id ?? ''),
    },
  },
  {
    method: 'POST',
    path: '/v1/tenants/current/invites',
    description: '邀请人加入租户，发送一次性链接（所有者、管理员）',
    write: {
      execute: async ({ app, principal, body }) => app.tenants.invite(principal, body),
    },
  },
  {
    method: 'GET',
    path: '/v1/tenants/current/invites',
    description: '尚未接受的邀请（所有者、管理员）',
    read: async ({ app, principal }) => app.tenants.invites(principal),
  },
  {
    method: 'POST',
    path: '/v1/tenants/current/invites/:id/revoke',
    description: '撤销一个尚未接受的邀请',
    write: {
      execute: async ({ app, principal, params }) =>
        app.tenants.revokeInvite(principal, params.id ?? ''),
    },
  },
  {
    method: 'POST',
    path: '/v1/tenants/current/agent-invites',
    description: '签发智能体邀请码：智能体拿着短码即可自己加入团队（所有者、管理员）',
    write: {
      execute: async ({ app, principal, body }) => app.agentAuth.createInvite(principal, body),
    },
  },

  // ------------------------------------------------------------ Agent 授权
  {
    method: 'GET',
    path: '/v1/agents',
    description: '我授权出去的智能体及其范围',
    read: async ({ app, principal }) => app.agentAuth.list(principal),
  },
  {
    method: 'GET',
    path: '/v1/agents/pending',
    description: '最近发起、尚未批准的 Agent 授权请求',
    read: async ({ app, principal }) => app.agentAuth.pendingRequests(principal),
  },
  {
    method: 'POST',
    path: '/v1/agents/approve',
    description: '用批准码批准一个 Agent：新建独立主体，或绑定到本人账号',
    write: {
      execute: async ({ app, principal, body }) => app.agentAuth.approve(principal, body),
    },
  },
  {
    method: 'POST',
    path: '/v1/agents/:id/revoke',
    description: '撤销 Agent 授权：停用主体并作废其会话',
    write: {
      execute: async ({ app, principal, params }) => app.agentAuth.revoke(principal, params.id ?? ''),
    },
  },

  // ------------------------------------------------------------ 主体目录
  {
    method: 'GET',
    path: '/v1/activity',
    description: '跨任务最近事件（负责人、审核人、管理员）',
    read: async ({ app, principal, query }) => app.tasks.activity(principal, parseLimit(query, 30)),
  },

  {
    method: 'GET',
    path: '/v1/principals',
    description: '参与者目录，可按能力过滤',
    read: async ({ app, principal, query }) =>
      app.principals.directory(principal, query.get('capability') ?? undefined),
  },
  {
    method: 'GET',
    path: '/v1/principals/pending',
    description: '待批准的自动登记主体（管理员、监管者）',
    read: async ({ app, principal }) => app.principals.pending(principal),
  },
  {
    method: 'POST',
    path: '/v1/principals/:id/activate',
    description: '批准一个待登记主体（管理员）',
    write: {
      execute: async ({ app, principal, params }) => app.principals.activate(principal, params.id ?? ''),
    },
  },
  {
    method: 'POST',
    path: '/v1/principals/:id/roles',
    description: '调整主体角色（管理员）',
    write: {
      execute: async ({ app, principal, params, body }) =>
        app.principals.setRoles(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/principals',
    description: '登记主体（管理员）',
    write: { execute: async ({ app, principal, body }) => app.principals.create(principal, body) },
  },
  {
    method: 'POST',
    path: '/v1/principals/:id/profile',
    description: '更新主体资料与能力声明（管理员）',
    write: {
      execute: async ({ app, principal, params, body }) =>
        app.principals.updateProfile(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/principals/:id/rotate-token',
    description: '轮换访问令牌（管理员）',
    write: {
      execute: async ({ app, principal, params, body }) =>
        app.principals.rotateToken(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/principals/:id/deactivate',
    description: '停用主体并立即拒绝其令牌（管理员）',
    write: {
      execute: async ({ app, principal, params }) => app.principals.deactivate(principal, params.id ?? ''),
    },
  },

  // ------------------------------------------------------------ 任务
  {
    method: 'GET',
    path: '/v1/tasks',
    description: '可见任务列表，支持 status / q 过滤',
    read: async ({ app, principal, query }) =>
      app.tasks.list(principal, { status: parseStatus(query), q: parseQuery(query) || undefined }),
  },
  {
    method: 'GET',
    path: '/v1/tasks/page',
    description: '分页任务列表，返回 items 与 nextOffset',
    read: async ({ app, principal, query }) =>
      app.tasks.page(principal, {
        limit: parseLimit(query, 20),
        offset: parseOffset(query),
        status: parseStatus(query),
        q: parseQuery(query) || undefined,
      }),
  },
  {
    method: 'POST',
    path: '/v1/tasks',
    description: '创建任务（负责人或管理员）',
    write: { execute: async ({ app, principal, body }) => app.tasks.create(principal, body) },
  },
  {
    method: 'GET',
    path: '/v1/tasks/:id',
    description: '任务详情；智能体只看到自己的子任务',
    read: async ({ app, principal, params }) => app.tasks.detail(principal, params.id ?? ''),
  },
  {
    method: 'GET',
    path: '/v1/tasks/:id/context',
    description: '长任务恢复上下文：状态、未决事项、阶段摘要、最近事件',
    read: async ({ app, principal, params }) => app.tasks.context(principal, params.id ?? ''),
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/coordinators',
    description: '委派协调智能体（负责人）',
    write: {
      authorize: ctx => onTask(ctx, 'owner'),
      execute: async ({ app, principal, params, body }) => app.tasks.delegate(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/remove-coordinator',
    description: '撤销协调委派（负责人）',
    write: {
      authorize: ctx => onTask(ctx, 'owner'),
      execute: async ({ app, principal, params, body }) => app.tasks.undelegate(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/assign',
    description: '指派子任务给智能体（负责人、协调者或管理员）',
    write: {
      authorize: ctx => onTask(ctx, 'coordinator'),
      execute: async ({ app, principal, params, body }) => app.tasks.assign(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/stage-summaries',
    description: '记录阶段摘要与未决事项',
    write: {
      authorize: ctx => onTask(ctx, 'coordinator'),
      execute: async ({ app, principal, params, body }) =>
        app.tasks.recordStageSummary(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/summary',
    description: '所有子任务提交后汇总，任务进入待验收',
    write: {
      authorize: ctx => onTask(ctx, 'coordinator'),
      execute: async ({ app, principal, params, body }) => app.tasks.submitSummary(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/review',
    description: '人工验收或退回（负责人）',
    write: {
      authorize: ctx => onTask(ctx, 'owner'),
      execute: async ({ app, principal, params, body }) => app.tasks.review(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/cancel',
    description: '取消任务（负责人）',
    write: {
      authorize: ctx => onTask(ctx, 'owner'),
      execute: async ({ app, principal, params, body }) => app.tasks.cancel(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/adopt',
    description: '接管智能体发起的提案（负责人、监管者或管理员）',
    write: {
      execute: async ({ app, principal, params }) => app.tasks.adopt(principal, params.id ?? ''),
    },
  },
  {
    method: 'GET',
    path: '/v1/tasks/:id/comments',
    description: '任务评论流（人与智能体共用）',
    read: async ({ app, principal, params }) => app.collab.listComments(principal, params.id ?? ''),
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/comments',
    description: '追加评论，支持 @ 提及',
    write: {
      execute: async ({ app, principal, params, body }) =>
        app.collab.addComment(principal, params.id ?? '', body),
    },
  },
  {
    method: 'GET',
    path: '/v1/tasks/:id/offers',
    description: '任务下挂出的开放子任务',
    read: async ({ app, principal, params }) => app.collab.listOffers(principal, params.id ?? ''),
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/offers',
    description: '发布开放子任务，等待能力匹配的智能体认领',
    write: {
      execute: async ({ app, principal, params, body }) =>
        app.collab.createOffer(principal, params.id ?? '', body),
    },
  },
  {
    method: 'GET',
    path: '/v1/offers',
    description: '与我能力匹配的开放子任务',
    read: async ({ app, principal }) => app.collab.openOffers(principal),
  },
  {
    method: 'POST',
    path: '/v1/offers/:id/claim',
    description: '认领开放子任务（智能体）',
    write: {
      execute: async ({ app, principal, params }) => app.collab.claimOffer(principal, params.id ?? ''),
    },
  },
  {
    method: 'POST',
    path: '/v1/offers/:id/withdraw',
    description: '撤回开放子任务（负责人）',
    write: {
      execute: async ({ app, principal, params }) => app.collab.withdrawOffer(principal, params.id ?? ''),
    },
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/knowledge',
    description: '从已验收任务提取候选经验（负责人）',
    write: {
      authorize: ctx => onTask(ctx, 'owner'),
      execute: async ({ app, principal, params, body }) =>
        app.knowledge.createCandidate(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/tasks/:id/references',
    description: '任务引用一条有效经验（负责人）',
    write: {
      authorize: ctx => onTask(ctx, 'owner'),
      execute: async ({ app, principal, params, body }) => app.knowledge.reference(principal, params.id ?? '', body),
    },
  },
  {
    method: 'GET',
    path: '/v1/tasks/:id/evidence/:knowledgeId/:version',
    description: '任务引用过的历史版本及其当前状态',
    read: async ({ app, principal, params }) =>
      app.knowledge.taskEvidence(
        principal,
        params.id ?? '',
        params.knowledgeId ?? '',
        parseVersion(params.version),
      ),
  },

  // ------------------------------------------------------------ 子任务
  {
    method: 'GET',
    path: '/v1/inbox',
    description: '智能体待办：依赖已满足的邀请、进行中与被退回的子任务',
    read: async ({ app, principal }) => app.subtasks.inbox(principal),
  },
  {
    method: 'POST',
    path: '/v1/subtasks/:id/accept',
    description: '接受子任务',
    write: {
      authorize: onOwnSubtask,
      execute: async ({ app, principal, params }) => app.subtasks.accept(principal, params.id ?? ''),
    },
  },
  {
    method: 'POST',
    path: '/v1/subtasks/:id/reject',
    description: '拒绝子任务并说明原因',
    write: {
      authorize: onOwnSubtask,
      execute: async ({ app, principal, params, body }) => app.subtasks.reject(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/subtasks/:id/submit',
    description: '提交结果与来源',
    write: {
      authorize: onOwnSubtask,
      execute: async ({ app, principal, params, body }) => app.subtasks.submit(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/subtasks/:id/progress',
    description: '记录进展（不改变状态）',
    write: {
      authorize: onOwnSubtask,
      execute: async ({ app, principal, params, body }) => app.subtasks.progress(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/subtasks/:id/outcome-unknown',
    description: '标记结果未知，等待人工核对',
    write: {
      authorize: onOwnSubtask,
      execute: async ({ app, principal, params, body }) =>
        app.subtasks.outcomeUnknown(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/subtasks/:id/timeout',
    description: '人工标记超时（负责人，不推断业务失败）',
    write: {
      authorize: onSubtaskAsOwner,
      execute: async ({ app, principal, params, body }) => app.subtasks.timeout(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/subtasks/:id/return',
    description: '退回子任务重新处理（负责人）',
    write: {
      authorize: onSubtaskAsOwner,
      execute: async ({ app, principal, params, body }) =>
        app.subtasks.returnToAgent(principal, params.id ?? '', body),
    },
  },

  // ------------------------------------------------------------ 通知
  {
    method: 'GET',
    path: '/v1/notifications',
    description: '未确认通知（最多 100 条）',
    read: async ({ app, principal }) => app.notifications.list(principal),
  },
  {
    method: 'POST',
    path: '/v1/notifications/:id/ack',
    description: '确认通知；不改变业务状态',
    write: {
      execute: async ({ app, principal, params }) => app.notifications.acknowledge(principal, params.id ?? ''),
    },
  },

  // ------------------------------------------------------------ 知识
  {
    method: 'GET',
    path: '/v1/knowledge',
    description: '已发布且未过期、对当前主体可见的经验',
    read: async ({ app, principal, query }) =>
      app.knowledge.list(principal, parseQuery(query), parseLimit(query, 100)),
  },
  {
    method: 'GET',
    path: '/v1/knowledge/search',
    description: '带字符预算的词法检索',
    auditRead: true,
    read: async ({ app, principal, query }) =>
      app.knowledge.search(
        principal,
        parseQuery(query),
        parseLimit(query, 10),
        asInteger(Number(query.get('budget') ?? 4000), 'budget', { min: 256, max: 100_000 }),
      ),
  },
  {
    method: 'GET',
    path: '/v1/knowledge/candidates',
    description: '待审核候选经验（审核人或管理员）',
    read: async ({ app, principal }) => app.knowledge.candidates(principal),
  },
  {
    method: 'GET',
    path: '/v1/knowledge/:id/versions',
    description: '已发布版本快照（审核人或管理员）',
    read: async ({ app, principal, params }) => app.knowledge.versions(principal, params.id ?? ''),
  },
  {
    method: 'GET',
    path: '/v1/knowledge/:id/evidence',
    description: '当前有效版本的证据包',
    auditRead: true,
    read: async ({ app, principal, params }) => app.knowledge.currentEvidence(principal, params.id ?? ''),
  },
  {
    method: 'POST',
    path: '/v1/knowledge/:id/publish',
    description: '发布候选经验（审核人或管理员）',
    write: {
      execute: async ({ app, principal, params, body }) =>
        app.knowledge.publish(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/knowledge/:id/revoke',
    description: '撤销已发布经验（审核人或管理员）',
    write: {
      execute: async ({ app, principal, params, body }) => app.knowledge.revoke(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/knowledge/:id/revise',
    description: '生成新版本候选（审核人或管理员）',
    write: {
      execute: async ({ app, principal, params, body }) => app.knowledge.revise(principal, params.id ?? '', body),
    },
  },
  {
    method: 'POST',
    path: '/v1/knowledge/:id/access',
    description: '调整共享范围（审核人或管理员）',
    write: {
      execute: async ({ app, principal, params, body }) =>
        app.knowledge.changeAccess(principal, params.id ?? '', body),
    },
  },

  // ------------------------------------------------------------ 在线状态
  {
    method: 'POST',
    path: '/v1/agent/heartbeat',
    description: '智能体上报心跳（只表示还在，不表示做对了）',
    write: {
      execute: async ({ app, principal, body }) => app.collab.heartbeat(principal, body),
    },
  },
  {
    method: 'GET',
    path: '/v1/agent/presence',
    description: '智能体在线表（负责人、监管者、管理员）',
    read: async ({ app, principal }) => app.collab.presenceBoard(principal),
  },

  // ------------------------------------------------------------ 监管
  {
    method: 'GET',
    path: '/v1/oversight',
    description: '监管总览：告警、计数、风险任务、待批准主体',
    read: async ({ app, principal }) => app.oversight.overview(principal),
  },
  {
    method: 'POST',
    path: '/v1/oversight/scan',
    description: '按当前数据重新评估告警规则（监管者、管理员、调度器）',
    write: {
      execute: async ({ app, principal }) => app.oversight.scanFor(principal),
    },
  },
  {
    method: 'POST',
    path: '/v1/oversight/alerts/:id/ack',
    description: '确认告警（表示人已看到）',
    write: {
      execute: async ({ app, principal, params }) => app.oversight.acknowledge(principal, params.id ?? ''),
    },
  },
  {
    method: 'POST',
    path: '/v1/oversight/alerts/:id/resolve',
    description: '解决告警（人工结论，扫描器不会立刻重开）',
    write: {
      execute: async ({ app, principal, params }) => app.oversight.resolve(principal, params.id ?? ''),
    },
  },

  // ------------------------------------------------------------ 运维
  {
    method: 'POST',
    path: '/v1/maintenance/expire',
    description: '把过期未提交的子任务标记为超时（管理员）',
    write: { execute: async ({ app, principal }) => app.tasks.expireOverdue(principal) },
  },
  {
    method: 'GET',
    path: '/v1/audit',
    description: '最近的操作审计（管理员）',
    read: async ({ app, principal, query }) =>
      app.audit.list(principal, asInteger(Number(query.get('limit') ?? 200), 'limit', { min: 1, max: 500 })),
  },
];
