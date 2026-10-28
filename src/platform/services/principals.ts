/**
 * 主体目录与身份。
 *
 * 当前的身份方式是本机演示用的高熵 Bearer 令牌（只保存 SHA-256 摘要）。
 * 这是一个可替换的接缝：接入 anpio-key / did:wba 时，新增一个验证器，
 * 把签名验证结果映射成同样的 Principal 即可，平台不保存私钥、不代签。
 */

import { createHash } from 'node:crypto';
import { conflict, forbidden, notFound, unauthenticated } from '../../protocol/errors.ts';
import { asEnum, asId, asObject, asString, asStringArray } from '../../protocol/parse.ts';
import { PRINCIPAL_KINDS, ROLES } from '../../protocol/types.ts';
import type { Principal, PrincipalKind, Role, TenantRole } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import { toPrincipal } from '../db/mappers.ts';
import { hasAnyRole } from './access.ts';

const MIN_TOKEN_LENGTH = 24;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export type CreatePrincipalInput = {
  id: string;
  roles: Role[];
  token: string;
  did?: string | null;
  kind?: PrincipalKind;
  handle?: string | null;
  displayName?: string;
  description?: string;
  capabilities?: string[];
  accountId?: string | null;
  tenantRole?: TenantRole;
};

export class PrincipalService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async isEmpty(): Promise<boolean> {
    const row = await this.ctx.db.read.one('SELECT id FROM principals LIMIT 1');
    return !row;
  }

  /** 首次启动创建管理员。已存在任何主体时拒绝，避免被用来重置权限。 */
  async bootstrap(workspace: string, input: CreatePrincipalInput): Promise<Principal> {
    if (!(await this.isEmpty())) throw conflict('平台已完成初始化');
    if (!input.roles.includes('admin')) throw forbidden('初始化主体必须是管理员');
    return this.insert(workspace, { ...input, tenantRole: input.tenantRole ?? 'owner' });
  }

  /** 令牌 → 主体。每次请求重新读取，停用或改角色立即生效。 */
  async authenticate(token: string): Promise<Principal> {
    if (!token) throw unauthenticated('缺少访问令牌');
    const hash = hashToken(token);

    // 先查 ANP 会话：它带过期与撤销，且一个主体可以有多个并发会话。
    const session = await this.ctx.db.read.one<{
      principal_id: string;
      workspace: string;
      expires_at: string;
      last_seen_at: string;
      revoked_at: string | null;
    }>('SELECT principal_id, workspace, expires_at, last_seen_at, revoked_at FROM anp_sessions WHERE token_hash = :hash', {
      hash,
    });
    if (session) {
      if (session.revoked_at !== null) throw unauthenticated('会话已退出，请重新登录');
      if (String(session.expires_at) <= this.ctx.now()) throw unauthenticated('会话已过期，请重新登录');
      const row = await this.ctx.db.read.one(
        'SELECT * FROM principals WHERE id = :id AND workspace = :workspace',
        { id: session.principal_id, workspace: session.workspace },
      );
      if (!row) throw unauthenticated('会话对应的主体不存在');
      const principal = toPrincipal(row);
      if (!principal.active) throw unauthenticated('主体已停用');
      // 心跳式更新，最多每分钟一次，避免每个读请求都写库。
      if (Date.parse(this.ctx.now()) - Date.parse(String(session.last_seen_at)) > 60_000) {
        this.ctx.db
          .run('UPDATE anp_sessions SET last_seen_at = :at WHERE token_hash = :hash', {
            at: this.ctx.now(),
            hash,
          })
          .catch(() => undefined);
      }
      return principal;
    }

    const row = await this.ctx.db.read.one('SELECT * FROM principals WHERE token_hash = :hash', { hash });
    if (!row) throw unauthenticated('访问令牌无效');
    const principal = toPrincipal(row);
    if (!principal.active) throw unauthenticated('主体已停用');
    return principal;
  }

  async get(actor: Principal, id: string): Promise<Principal> {
    const row = await this.ctx.db.read.one(
      'SELECT * FROM principals WHERE id = :id AND workspace = :workspace',
      { id, workspace: actor.workspace },
    );
    if (!row) throw notFound('主体不存在');
    return toPrincipal(row);
  }

  /** 管理员登记新主体，例如一个新的业务智能体。 */
  async create(actor: Principal, body: unknown): Promise<Principal> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以登记主体');
    const input = asObject(body);
    const roles = asStringArray(input.roles, 'roles', { max: ROLES.length }).map(role =>
      asEnum(role, 'roles[]', ROLES),
    );
    if (roles.length === 0) throw conflict('roles 不能为空');
    const did = input.did === undefined || input.did === null ? null : asString(input.did, 'did', { max: 300 });
    if (did !== null && !DID_PATTERN.test(did)) throw conflict('did 格式不合法，应为 did:wba:...');
    return this.insert(actor.workspace, {
      id: asId(input.id, 'id'),
      roles,
      token: asString(input.token, 'token', { max: 512 }),
      did,
      kind:
        input.kind === undefined
          ? roles.includes('agent')
            ? 'agent'
            : 'human'
          : asEnum(input.kind, 'kind', PRINCIPAL_KINDS),
      handle:
        input.handle === undefined || input.handle === null
          ? null
          : asString(input.handle, 'handle', { max: 200, min: 0 }),
      displayName: input.displayName === undefined ? asId(input.id, 'id') : asString(input.displayName, 'displayName', { max: 120 }),
      description:
        input.description === undefined
          ? ''
          : asString(input.description, 'description', { max: 1000, min: 0 }),
      capabilities:
        input.capabilities === undefined
          ? []
          : asStringArray(input.capabilities, 'capabilities', { max: 50, maxLength: 100 }),
      // 管理员登记的主体默认只给业务角色；组织管理权要在成员页显式授予，
      // 避免"登记一个人"顺手把成员管理权限也送出去。
      tenantRole: roles.includes('admin') ? 'admin' : 'member',
    });
  }

  private async insert(workspace: string, input: CreatePrincipalInput): Promise<Principal> {
    if (input.token.length < MIN_TOKEN_LENGTH) {
      throw conflict(`令牌至少 ${MIN_TOKEN_LENGTH} 个字符`);
    }
    // 不用 `:did IS NOT NULL AND did = :did`：PostgreSQL 无法推断裸 NULL 参数的类型。
    // 分支写法在两种方言下都成立，也更容易读。
    const clash = input.did
      ? `SELECT id FROM principals WHERE workspace = :workspace AND (id = :id OR token_hash = :hash OR did = :did)`
      : `SELECT id FROM principals WHERE workspace = :workspace AND (id = :id OR token_hash = :hash)`;
    const taken = await this.ctx.db.read.one(clash, {
      workspace,
      id: input.id,
      hash: hashToken(input.token),
      ...(input.did ? { did: input.did } : {}),
    });
    if (taken) throw conflict('主体 ID、令牌或 DID 已被占用');

    const principal: Principal = {
      id: input.id,
      workspace,
      roles: input.roles,
      accountId: input.accountId ?? null,
      tenantRole: input.tenantRole ?? 'member',
      did: input.did ?? null,
      kind: input.kind ?? 'human',
      handle: input.handle ?? null,
      displayName: input.displayName ?? input.id,
      description: input.description ?? '',
      capabilities: input.capabilities ?? [],
      active: true,
    };
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name, description, capabilities, active, created_at, account_id, tenant_role)
         VALUES(:id, :workspace, :roles, :hash, :did, :kind, :handle, :displayName, :description, :capabilities, 1, :at, :accountId, :tenantRole)`,
        {
          id: principal.id,
          workspace: principal.workspace,
          roles: JSON.stringify(principal.roles),
          hash: hashToken(input.token),
          did: principal.did,
          kind: principal.kind,
          handle: principal.handle,
          displayName: principal.displayName,
          description: principal.description,
          capabilities: JSON.stringify(principal.capabilities),
          at: this.ctx.now(),
          accountId: principal.accountId,
          tenantRole: principal.tenantRole,
        },
      );
    });
    return principal;
  }

  /** 更新资料：只改展示与能力声明，不动角色、令牌和状态。 */
  async updateProfile(actor: Principal, id: string, body: unknown): Promise<Principal> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以修改主体资料');
    const input = asObject(body);
    const current = await this.get(actor, id);
    const capabilities =
      input.capabilities === undefined
        ? current.capabilities
        : asStringArray(input.capabilities, 'capabilities', { max: 50, maxLength: 100 });
    const description =
      input.description === undefined
        ? current.description
        : asString(input.description, 'description', { max: 1000, min: 0 });
    const displayName =
      input.displayName === undefined
        ? current.displayName
        : asString(input.displayName, 'displayName', { max: 120 });
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE principals
         SET capabilities = :capabilities, description = :description, display_name = :displayName
         WHERE id = :id AND workspace = :workspace`,
        {
          capabilities: JSON.stringify(capabilities),
          description,
          displayName,
          id: current.id,
          workspace: actor.workspace,
        },
      );
    });
    return { ...current, capabilities, description, displayName };
  }

  async rotateToken(actor: Principal, id: string, body: unknown): Promise<{ id: string; rotated: true }> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以轮换令牌');
    const token = asString(asObject(body).token, 'token', { max: 512 });
    if (token.length < MIN_TOKEN_LENGTH) throw conflict(`令牌至少 ${MIN_TOKEN_LENGTH} 个字符`);
    const current = await this.get(actor, id);
    const clash = await this.ctx.db.read.one('SELECT id FROM principals WHERE token_hash = :hash', {
      hash: hashToken(token),
    });
    if (clash) throw conflict('令牌已被占用');
    await this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE principals SET token_hash = :hash WHERE id = :id AND workspace = :workspace', {
        hash: hashToken(token),
        id: current.id,
        workspace: actor.workspace,
      });
    });
    return { id: current.id, rotated: true };
  }

  /** 停用主体：下一次请求即被拒绝，历史结果与审计保留。 */
  async deactivate(actor: Principal, id: string): Promise<{ id: string; active: false }> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以停用主体');
    if (id === actor.id) throw conflict('不能停用自己');
    const target = await this.get(actor, id);
    await this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE principals SET active = 0 WHERE id = :id AND workspace = :workspace', {
        id: target.id,
        workspace: actor.workspace,
      });
      // 停用即刻失效：不等会话自然过期。
      await tx.run(
        `UPDATE anp_sessions SET revoked_at = :at
         WHERE workspace = :workspace AND principal_id = :principal AND revoked_at IS NULL`,
        { at: this.ctx.now(), workspace: actor.workspace, principal: target.id },
      );
    });
    return { id: target.id, active: false };
  }

  /** 批准一个待登记主体（ANP 首次登录但平台处于 pending 模式）。 */
  async activate(actor: Principal, id: string): Promise<{ id: string; active: true }> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以批准主体');
    const target = await this.get(actor, id);
    await this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE principals SET active = 1 WHERE id = :id AND workspace = :workspace', {
        id: target.id,
        workspace: actor.workspace,
      });
    });
    return { id: target.id, active: true };
  }

  /** 待批准主体：ANP 自动登记但未启用的那些。 */
  async pending(actor: Principal): Promise<Principal[]> {
    if (!hasAnyRole(actor, 'admin', 'supervisor')) throw forbidden('只有管理员或监管者可以查看待批准主体');
    const rows = await this.ctx.db.read.all(
      `SELECT * FROM principals WHERE workspace = :workspace AND active = 0 ORDER BY created_at DESC LIMIT 100`,
      { workspace: actor.workspace },
    );
    return rows.map(toPrincipal);
  }

  /** 调整角色：管理员专用；不能改自己的角色，避免把自己锁在外面。 */
  async setRoles(actor: Principal, id: string, body: unknown): Promise<Principal> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以调整角色');
    if (id === actor.id) throw conflict('不能修改自己的角色');
    const roles = asStringArray(asObject(body).roles, 'roles', { max: ROLES.length }).map(role =>
      asEnum(role, 'roles[]', ROLES),
    );
    if (roles.length === 0) throw conflict('roles 不能为空');
    const target = await this.get(actor, id);
    await this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE principals SET roles = :roles WHERE id = :id AND workspace = :workspace', {
        roles: JSON.stringify(roles),
        id: target.id,
        workspace: actor.workspace,
      });
    });
    return { ...target, roles };
  }

  /**
   * 参与者目录：能力声明只用于发现，不构成授权，也不代表质量。
   *
   * 只有智能体角色的主体看不到全量目录：它只应认识自己、以及和自己
   * 在同一个任务里出现过的人。这不是保密需求，而是"只看自己的事"的边界——
   * 一个业务智能体没有任何理由需要知道别的部门有哪些智能体。
   */
  async directory(actor: Principal, capability?: string): Promise<Principal[]> {
    if (capability !== undefined && capability.length > 100) throw conflict('capability 过长');
    const limited = actor.kind === 'agent' && !hasAnyRole(actor, 'admin', 'supervisor', 'owner', 'reviewer');
    const rows = limited
      ? await this.ctx.db.read.all(
          `SELECT * FROM principals p
           WHERE p.workspace = :workspace AND (
             p.id = :actor
             OR p.id IN (SELECT t.owner_id FROM tasks t WHERE t.id IN (SELECT task_id FROM subtasks WHERE agent_id = :actor))
             OR p.id IN (
               SELECT s.agent_id FROM subtasks s
               WHERE s.task_id IN (SELECT task_id FROM subtasks WHERE agent_id = :actor)
             )
             OR p.id IN (
               SELECT tc.principal_id FROM task_coordinators tc
               WHERE tc.task_id IN (SELECT task_id FROM subtasks WHERE agent_id = :actor)
             )
           )
           ORDER BY p.id`,
          { workspace: actor.workspace, actor: actor.id },
        )
      : await this.ctx.db.read.all(
          'SELECT * FROM principals WHERE workspace = :workspace ORDER BY id',
          { workspace: actor.workspace },
        );
    const principals = rows.map(toPrincipal);
    return capability === undefined
      ? principals
      : principals.filter(item => item.capabilities.includes(capability));
  }
}
