/**
 * 租户与成员。
 *
 * 租户就是原先的 workspace：所有任务、知识、审计查询本来就带 workspace，
 * 因此引入租户不需要改这些查询，跨租户隔离自动成立。
 *
 * 这里管三件事：
 *  1. 一个账号在租户里的主体（principal）——加入、创建、查找；
 *  2. 成员与角色——谁能管这个组织；
 *  3. 邀请——邮件里那条一次性链接。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import { asEnum, asObject, asString } from '../../protocol/parse.ts';
import { PRINCIPAL_KINDS, TENANT_ROLES } from '../../protocol/types.ts';
import type { AgentScope, Principal, PrincipalKind, Role, Tenant, TenantInvite, TenantMember, TenantRole } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';
import { toPrincipal } from '../db/mappers.ts';
import { hashToken } from './principals.ts';
import type { Account, AccountService } from './accounts.ts';
import type { MailService } from './mail.ts';

const INVITE_TTL_HOURS = 72;

/** 租户角色 → 业务角色。Agent 只拿 agent，永远不因主人是管理员而获得管理权。 */
export function rolesFor(tenantRole: TenantRole, kind: PrincipalKind): Role[] {
  if (kind === 'agent' || kind === 'service') return ['agent'];
  switch (tenantRole) {
    case 'owner':
    case 'admin':
      return ['admin', 'owner', 'reviewer'];
    case 'member':
      return ['owner', 'reviewer'];
    default:
      return ['reviewer'];
  }
}

export class TenantService {
  private readonly ctx: Context;
  private readonly accounts: AccountService;
  private readonly mail: MailService;

  constructor(ctx: Context, accounts: AccountService, mail: MailService) {
    this.ctx = ctx;
    this.accounts = accounts;
    this.mail = mail;
  }

  // ---------------------------------------------------------------- 租户

  /** 兼容旧数据：workspace 早于租户表存在，第一次访问时补一条。 */
  async ensureTenant(id: string, name = id, createdBy: string | null = null): Promise<void> {
    const existing = await this.ctx.db.read.one('SELECT id FROM tenants WHERE id = :id', { id });
    if (existing) return;
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO tenants(id, name, status, personal, created_by, created_at)
         VALUES(:id, :name, 'active', 0, :createdBy, :at)`,
        { id, name, createdBy, at: this.ctx.now() },
      );
    });
  }

  async listFor(accountId: string | null): Promise<Tenant[]> {
    if (!accountId) return [];
    const rows = await this.ctx.db.read.all(
      `SELECT t.*, p.tenant_role AS role
       FROM principals p JOIN tenants t ON t.id = p.workspace
       WHERE p.account_id = :account AND p.active = 1
       ORDER BY t.created_at`,
      { account: accountId },
    );
    return rows.map(row => ({
      id: String(row.id),
      name: String(row.name),
      status: String(row.status) === 'suspended' ? 'suspended' : 'active',
      personal: Number(row.personal) === 1,
      createdAt: String(row.created_at),
      role: row.role as TenantRole,
    }));
  }

  async detail(actor: Principal) {
    await this.ensureTenant(actor.workspace);
    const tenant = await this.ctx.db.read.one('SELECT * FROM tenants WHERE id = :id', { id: actor.workspace });
    if (!tenant) throw notFound('租户不存在');
    const counts = await this.ctx.db.read.one<{ members: number; agents: number; pending: number }>(
      `SELECT
         (SELECT COUNT(*) FROM principals WHERE workspace = :id AND active = 1 AND kind <> 'agent') AS members,
         (SELECT COUNT(*) FROM principals WHERE workspace = :id AND active = 1 AND kind = 'agent') AS agents,
         (SELECT COUNT(*) FROM tenant_invites WHERE tenant_id = :id AND accepted_at IS NULL AND expires_at > :now) AS pending`,
      { id: actor.workspace, now: this.ctx.now() },
    );
    return {
      id: String(tenant.id),
      name: String(tenant.name),
      status: String(tenant.status),
      personal: Number(tenant.personal) === 1,
      createdAt: String(tenant.created_at),
      role: actor.tenantRole,
      counts: {
        members: Number(counts?.members ?? 0),
        agents: Number(counts?.agents ?? 0),
        pendingInvites: Number(counts?.pending ?? 0),
      },
    };
  }

  async rename(actor: Principal, body: unknown) {
    this.requireAdmin(actor);
    const name = asString(asObject(body).name, 'name', { max: 120, min: 1 });
    await this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE tenants SET name = :name WHERE id = :id', { name, id: actor.workspace });
    });
    return this.detail(actor);
  }

  /** 新建组织：创建者成为所有者。也用于首次邮箱登录时的个人组织。 */
  async createTenant(account: Account, name: string, personal = false): Promise<Principal> {
    const id = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const principalId = `p_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO tenants(id, name, status, personal, created_by, created_at)
         VALUES(:id, :name, 'active', :personal, :account, :at)`,
        { id, name, personal: personal ? 1 : 0, account: account.id, at: now },
      );
      await tx.run(
        `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name,
                                description, capabilities, active, created_at, account_id, tenant_role)
         VALUES(:id, :workspace, :roles, :hash, NULL, 'human', NULL, :name, '', '[]', 1, :at, :account, 'owner')`,
        {
          id: principalId,
          workspace: id,
          roles: JSON.stringify(rolesFor('owner', 'human')),
          // 邮箱登录的主体没有静态令牌：令牌通道对它永不成立。
          hash: hashToken(`email:${randomUUID()}:${randomBytes(16).toString('hex')}`),
          name: account.displayName,
          at: now,
          account: account.id,
        },
      );
    });
    const row = await this.ctx.db.read.one('SELECT * FROM principals WHERE id = :id', { id: principalId });
    return toPrincipal(row!);
  }

  /** 账号在租户里的主体：有就返回，没有就按角色新建。 */
  async principalFor(
    account: Account,
    tenantId: string,
    options: { role?: TenantRole; kind?: PrincipalKind; displayName?: string } = {},
  ): Promise<Principal> {
    await this.ensureTenant(tenantId);
    const existing = await this.ctx.db.read.one(
      'SELECT * FROM principals WHERE workspace = :tenant AND account_id = :account LIMIT 1',
      { tenant: tenantId, account: account.id },
    );
    if (existing) {
      const principal = toPrincipal(existing);
      if (principal.active) return principal;
      throw forbidden('你在这个组织的成员资格已被停用');
    }
    const role = options.role ?? 'member';
    const kind = options.kind ?? 'human';
    const id = `p_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name,
                                description, capabilities, active, created_at, account_id, tenant_role)
         VALUES(:id, :tenant, :roles, :hash, NULL, :kind, NULL, :name, '', '[]', 1, :at, :account, :role)`,
        {
          id,
          tenant: tenantId,
          roles: JSON.stringify(rolesFor(role, kind)),
          hash: hashToken(`email:${randomUUID()}:${randomBytes(16).toString('hex')}`),
          kind,
          name: options.displayName ?? account.displayName,
          at: this.ctx.now(),
          account: account.id,
          role,
        },
      );
    });
    const row = await this.ctx.db.read.one('SELECT * FROM principals WHERE id = :id', { id });
    return toPrincipal(row!);
  }

  // ---------------------------------------------------------------- 成员

  async members(actor: Principal): Promise<TenantMember[]> {
    if (!this.isAdmin(actor)) throw forbidden('只有所有者或管理员可以查看成员');
    await this.ensureTenant(actor.workspace);
    const rows = await this.ctx.db.read.all(
      // 最近登录取会话时间：邮箱登录不写 identities，只有会话能同时覆盖两种登录方式。
      `SELECT p.*, e.value AS email, s.last_login_at AS last_login_at, g.owner_principal_id AS owner_id
       FROM principals p
       LEFT JOIN account_links e ON e.account_id = p.account_id AND e.kind = 'email'
       LEFT JOIN (
         SELECT principal_id, MAX(created_at) AS last_login_at FROM anp_sessions
         WHERE workspace = :workspace GROUP BY principal_id
       ) s ON s.principal_id = p.id
       LEFT JOIN agent_grants g ON g.agent_principal_id = p.id
       WHERE p.workspace = :workspace
       ORDER BY p.kind, p.created_at`,
      { workspace: actor.workspace },
    );
    return rows.map(row => ({
      principalId: String(row.id),
      displayName: String(row.display_name),
      kind: String(row.kind) as PrincipalKind,
      tenantRole: (row.tenant_role ?? 'member') as TenantRole,
      roles: JSON.parse(String(row.roles ?? '[]')) as Role[],
      email: row.email === null || row.email === undefined ? null : String(row.email),
      did: row.did === null || row.did === undefined ? null : String(row.did),
      active: Number(row.active) === 1,
      createdAt: String(row.created_at),
      lastLoginAt: row.last_login_at === null || row.last_login_at === undefined ? null : String(row.last_login_at),
      ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
      capabilities: JSON.parse(String(row.capabilities ?? '[]')) as string[],
    }));
  }

  async setMemberRole(actor: Principal, memberId: string, body: unknown) {
    this.requireAdmin(actor);
    if (memberId === actor.id) throw conflict('不能修改自己的角色');
    const role = asEnum(asObject(body).role, 'role', TENANT_ROLES);
    const target = await this.member(actor.workspace, memberId);
    if (target.tenantRole === 'owner') throw forbidden('所有者需要先转让所有权，不能直接改角色');
    // 智能体永远只能当普通成员：先拦这一条，否则 `role = owner` 会走转让分支把组织交出去。
    if (target.kind === 'agent' && role !== 'member' && role !== 'guest') {
      throw conflict('智能体成员不能拥有组织管理角色');
    }
    if (role === 'owner') {
      if (actor.tenantRole !== 'owner') throw forbidden('只有所有者可以转让所有权');
      await this.transferOwnership(actor, target);
      return { id: memberId, role };
    }
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        'UPDATE principals SET tenant_role = :role, roles = :roles WHERE id = :id AND workspace = :workspace',
        {
          role,
          roles: JSON.stringify(rolesFor(role, target.kind)),
          id: memberId,
          workspace: actor.workspace,
        },
      );
    });
    return { id: memberId, role };
  }

  /** 所有者唯一：转让是两行更新，必须在同一事务里。 */
  private async transferOwnership(actor: Principal, target: Principal): Promise<void> {
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE principals SET tenant_role = 'admin', roles = :roles WHERE id = :id AND workspace = :workspace`,
        {
          roles: JSON.stringify(rolesFor('admin', actor.kind)),
          id: actor.id,
          workspace: actor.workspace,
        },
      );
      await tx.run(
        `UPDATE principals SET tenant_role = 'owner', roles = :roles WHERE id = :id AND workspace = :workspace`,
        {
          roles: JSON.stringify(rolesFor('owner', target.kind)),
          id: target.id,
          workspace: actor.workspace,
        },
      );
    });
  }

  async removeMember(actor: Principal, memberId: string) {
    this.requireAdmin(actor);
    if (memberId === actor.id) throw conflict('不能移除自己');
    const target = await this.member(actor.workspace, memberId);
    if (target.tenantRole === 'owner') throw forbidden('不能移除所有者，请先转让所有权');
    await this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE principals SET active = 0 WHERE id = :id AND workspace = :workspace', {
        id: memberId,
        workspace: actor.workspace,
      });
      await tx.run(
        `UPDATE anp_sessions SET revoked_at = :at
         WHERE workspace = :workspace AND principal_id = :principal AND revoked_at IS NULL`,
        { at: this.ctx.now(), workspace: actor.workspace, principal: memberId },
      );
      await tx.run(
        `UPDATE agent_grants SET status = 'revoked', revoked_at = :at
         WHERE tenant_id = :workspace AND agent_principal_id = :principal AND status = 'active'`,
        { at: this.ctx.now(), workspace: actor.workspace, principal: memberId },
      );
    });
    return { id: memberId, removed: true };
  }

  private async member(workspace: string, id: string): Promise<Principal> {
    const row = await this.ctx.db.read.one('SELECT * FROM principals WHERE id = :id AND workspace = :workspace', {
      id,
      workspace,
    });
    if (!row) throw notFound('成员不存在');
    return toPrincipal(row);
  }

  // ---------------------------------------------------------------- 邀请

  async invite(actor: Principal, body: unknown): Promise<TenantInvite> {
    this.requireAdmin(actor);
    // 旧库的 workspace 早于租户表存在：发邀请前把它补成正式租户，
    // 否则外键会以一句很难懂的话失败。
    await this.ensureTenant(actor.workspace);
    const input = asObject(body);
    const email = normalizeEmail(asString(input.email, 'email', { max: 254, min: 3 }));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid('email 格式不正确');
    const role = asEnum(input.role ?? 'member', 'role', TENANT_ROLES);
    if (role === 'owner') throw conflict('不能邀请第二个所有者；请先邀请为管理员再转让所有权');
    if (role === 'admin' && !this.isAdmin(actor)) throw forbidden('只有所有者或管理员可以邀请管理员');
    const kind = input.kind === undefined ? 'human' : asEnum(input.kind, 'kind', PRINCIPAL_KINDS);
    if (kind === 'agent' && role !== 'member') throw conflict('智能体只能以成员身份加入');

    const token = randomBytes(32).toString('base64url');
    const now = this.ctx.now();
    const expiresAt = new Date(Date.parse(now) + INVITE_TTL_HOURS * 3600 * 1000).toISOString();
    const id = `inv_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const link = this.mail.link(`/login?ticket=${encodeURIComponent(token)}`);
    const tenant = await this.ctx.db.read.one<{ name: string }>('SELECT name FROM tenants WHERE id = :id', {
      id: actor.workspace,
    });
    const tenantName = tenant ? String(tenant.name) : actor.workspace;

    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO tenant_invites(id, tenant_id, email, role, kind, token_hash, invited_by, expires_at, created_at)
         VALUES(:id, :tenant, :email, :role, :kind, :hash, :by, :expiresAt, :at)`,
        {
          id,
          tenant: actor.workspace,
          email,
          role,
          kind,
          hash: hashToken(token),
          by: actor.id,
          expiresAt,
          at: now,
        },
      );
      // 邀请链接本身就是一个登录票据：点开即完成"验证邮箱 + 入组 + 登录"。
      await tx.run(
        `INSERT INTO login_tickets(id, token_hash, email, purpose, invite_id, account_id, expires_at, created_at)
         VALUES(:id, :hash, :email, 'invite', :invite, NULL, :expiresAt, :at)`,
        { id: randomUUID(), hash: hashToken(token), email, invite: id, expiresAt, at: now },
      );
    });

    const roleLabel = { owner: '所有者', admin: '管理员', member: '成员', guest: '访客' }[role];
    const kindLabel = kind === 'agent' ? '智能体' : '成员';
    await this.mail.send({
      to: email,
      subject: `[Anpio Collab] 邀请你加入「${tenantName}」`,
      body:
        `${actor.displayName} 邀请你以「${roleLabel}」身份加入「${tenantName}」（${kindLabel}）。\n\n` +
        `点此接受（${INVITE_TTL_HOURS} 小时内有效，仅可使用一次）：\n${link}\n\n` +
        '如果这不是你预期的邀请，忽略这封邮件即可。',
      link,
      kind: 'invite',
    });
    return {
      id,
      email,
      role,
      kind,
      invitedBy: actor.id,
      expiresAt,
      acceptedAt: null,
      createdAt: now,
      ...(this.mail.exposeOutbox ? { link } : {}),
    };
  }

  async invites(actor: Principal) {
    this.requireAdmin(actor);
    await this.ensureTenant(actor.workspace);
    const rows = await this.ctx.db.read.all(
      `SELECT * FROM tenant_invites
       WHERE tenant_id = :tenant AND accepted_at IS NULL AND expires_at > :now
       ORDER BY created_at DESC LIMIT 100`,
      { tenant: actor.workspace, now: this.ctx.now() },
    );
    return rows.map(row => ({
      id: String(row.id),
      email: String(row.email),
      role: String(row.role) as TenantRole,
      kind: String(row.kind) as PrincipalKind,
      invitedBy: String(row.invited_by),
      expiresAt: String(row.expires_at),
      acceptedAt: null,
      createdAt: String(row.created_at),
    }));
  }

  async revokeInvite(actor: Principal, id: string) {
    this.requireAdmin(actor);
    const row = await this.ctx.db.read.one(
      'SELECT id FROM tenant_invites WHERE id = :id AND tenant_id = :tenant AND accepted_at IS NULL',
      { id, tenant: actor.workspace },
    );
    if (!row) throw notFound('邀请不存在或已被接受');
    await this.ctx.db.transaction(async tx => {
      await tx.run('DELETE FROM login_tickets WHERE invite_id = :id', { id });
      await tx.run('DELETE FROM tenant_invites WHERE id = :id', { id });
    });
    return { id, revoked: true };
  }

  /**
   * 接受邀请：票据验证通过后调用。
   *
   * 邮箱必须与邀请一致——邀请链接被转发给第三个人时，这里挡住。
   */
  async acceptInvite(
    inviteId: string,
    account: Account,
    email: string,
  ): Promise<{ principal: Principal; tenantId: string }> {
    const invite = await this.ctx.db.read.one(
      'SELECT * FROM tenant_invites WHERE id = :id AND accepted_at IS NULL',
      { id: inviteId },
    );
    if (!invite) throw conflict('邀请已失效或已被接受');
    if (String(invite.expires_at) <= this.ctx.now()) throw conflict('邀请已过期');
    if (normalizeEmail(String(invite.email)) !== normalizeEmail(email)) {
      throw forbidden('这条邀请属于另一个邮箱，请用收到邮件的那一个登录');
    }
    const tenantId = String(invite.tenant_id);
    await this.ensureTenant(tenantId);
    const role = String(invite.role) as TenantRole;
    const kind = String(invite.kind) as PrincipalKind;
    const principal = await this.principalFor(account, tenantId, { role, kind });
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE tenant_invites SET accepted_at = :at, accepted_principal_id = :principal WHERE id = :id`,
        { at: this.ctx.now(), principal: principal.id, id: inviteId },
      );
    });
    return { principal, tenantId };
  }

  // ---------------------------------------------------------------- 权限

  isAdmin(actor: Principal): boolean {
    return actor.tenantRole === 'owner' || actor.tenantRole === 'admin';
  }

  requireAdmin(actor: Principal): void {
    if (!this.isAdmin(actor)) throw forbidden('只有所有者或管理员可以管理成员');
  }

  /** Agent 授权范围校验：只允许声明的几项。 */
  parseScopes(raw: unknown, fallback: AgentScope[]): AgentScope[] {
    if (raw === undefined) return fallback;
    if (!Array.isArray(raw) || raw.length === 0) throw invalid('scopes 不能为空');
    const allowed: AgentScope[] = [
      'tasks:read',
      'tasks:submit',
      'offers:claim',
      'knowledge:read',
      'comments:write',
      'presence:write',
    ];
    return raw.map(item => {
      const scope = String(item);
      if (!allowed.includes(scope as AgentScope)) throw invalid(`未知授权范围：${scope}`);
      return scope as AgentScope;
    });
  }

  /** 供其它服务在同一事务里建主体。 */
  async insertPrincipal(
    tx: Queryable,
    input: {
      workspace: string;
      accountId: string | null;
      kind: PrincipalKind;
      tenantRole: TenantRole;
      displayName: string;
      did?: string | null;
      capabilities?: string[];
    },
  ): Promise<string> {
    const id = `p_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await tx.run(
      `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name,
                              description, capabilities, active, created_at, account_id, tenant_role)
       VALUES(:id, :workspace, :roles, :hash, :did, :kind, NULL, :name, '', :capabilities, 1, :at, :account, :role)`,
      {
        id,
        workspace: input.workspace,
        roles: JSON.stringify(rolesFor(input.tenantRole, input.kind)),
        hash: hashToken(`agent:${randomUUID()}:${randomBytes(16).toString('hex')}`),
        did: input.did ?? null,
        kind: input.kind,
        name: input.displayName,
        capabilities: JSON.stringify(input.capabilities ?? []),
        at: this.ctx.now(),
        account: input.accountId,
        role: input.tenantRole,
      },
    );
    return id;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
