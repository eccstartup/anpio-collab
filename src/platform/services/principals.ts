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
import { ROLES } from '../../protocol/types.ts';
import type { Principal, Role } from '../../protocol/types.ts';
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
  displayName?: string;
  description?: string;
  capabilities?: string[];
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
    return this.insert(workspace, input);
  }

  /** 令牌 → 主体。每次请求重新读取，停用或改角色立即生效。 */
  async authenticate(token: string): Promise<Principal> {
    if (!token) throw unauthenticated('缺少访问令牌');
    const row = await this.ctx.db.read.one('SELECT * FROM principals WHERE token_hash = :hash', {
      hash: hashToken(token),
    });
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
      displayName: input.displayName === undefined ? asId(input.id, 'id') : asString(input.displayName, 'displayName', { max: 120 }),
      description:
        input.description === undefined
          ? ''
          : asString(input.description, 'description', { max: 1000, min: 0 }),
      capabilities:
        input.capabilities === undefined
          ? []
          : asStringArray(input.capabilities, 'capabilities', { max: 50, maxLength: 100 }),
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
      did: input.did ?? null,
      displayName: input.displayName ?? input.id,
      description: input.description ?? '',
      capabilities: input.capabilities ?? [],
      active: true,
    };
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO principals(id, workspace, roles, token_hash, did, display_name, description, capabilities, active, created_at)
         VALUES(:id, :workspace, :roles, :hash, :did, :displayName, :description, :capabilities, 1, :at)`,
        {
          id: principal.id,
          workspace: principal.workspace,
          roles: JSON.stringify(principal.roles),
          hash: hashToken(input.token),
          did: principal.did,
          displayName: principal.displayName,
          description: principal.description,
          capabilities: JSON.stringify(principal.capabilities),
          at: this.ctx.now(),
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
    });
    return { id: target.id, active: false };
  }

  /** 参与者目录：能力声明只用于发现，不构成授权，也不代表质量。 */
  async directory(actor: Principal, capability?: string): Promise<Principal[]> {
    if (capability !== undefined && capability.length > 100) throw conflict('capability 过长');
    const rows = await this.ctx.db.read.all(
      'SELECT * FROM principals WHERE workspace = :workspace ORDER BY id',
      { workspace: actor.workspace },
    );
    const principals = rows.map(toPrincipal);
    return capability === undefined
      ? principals
      : principals.filter(item => item.capabilities.includes(capability));
  }
}
