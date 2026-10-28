/**
 * Agent 设备授权（Device Authorization Grant）。
 *
 * 为什么不是"填个绑定码就完事"：绑定让 Agent 变成主人的另一个登录方式，
 * 权限等于本人，撤不回来。这里给 Agent 建**独立主体**，只拿被勾选的范围，
 * 可以单独撤销，不影响任何人登录。
 *
 * 流程：
 *   Agent 申请 → 拿到 user_code（给人看）与 device_code（自己留着）
 *   人登录后在控制台批准 → 选范围与期限
 *   Agent 轮询换令牌 → 得到与其它登录方式同构的会话
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import { asInteger, asObject, asString } from '../../protocol/parse.ts';
import type { AgentGrant, AgentScope, Principal } from '../../protocol/types.ts';
import { isDid } from '../../anp/did.ts';
import type { Context } from '../context.ts';
import { toPrincipal } from '../db/mappers.ts';
import type { IdentityService } from './identity.ts';
import { hashToken } from './principals.ts';
import type { TenantService } from './tenants.ts';
import { rolesFor } from './tenants.ts';

const DEFAULT_SCOPES: AgentScope[] = ['tasks:read', 'tasks:submit', 'offers:claim', 'comments:write'];
const DEVICE_TTL_SECONDS = 600;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class AgentAuthService {
  private readonly ctx: Context;
  private readonly tenants: TenantService;
  private readonly identity: IdentityService;

  constructor(ctx: Context, tenants: TenantService, identity: IdentityService) {
    this.ctx = ctx;
    this.tenants = tenants;
    this.identity = identity;
  }

  // ---------------------------------------------------------------- Agent 侧

  async request(body: unknown) {
    const input = asObject(body);
    const did = asString(input.did, 'did', { max: 300, min: 8 });
    if (!isDid(did)) throw invalid('did 必须是 did:wba 标识');
    const name = input.name === undefined ? '' : asString(input.name, 'name', { max: 120, min: 0 });
    const capabilities = Array.isArray(input.capabilities)
      ? input.capabilities.slice(0, 20).map(item => String(item).slice(0, 60))
      : [];

    const deviceCode = randomBytes(32).toString('base64url');
    const userCode = await this.freshUserCode();
    const now = this.ctx.now();
    const expiresAt = new Date(Date.parse(now) + DEVICE_TTL_SECONDS * 1000).toISOString();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO agent_requests(id, device_code_hash, user_code, requested_did, name, capabilities,
                                    status, expires_at, created_at)
         VALUES(:id, :hash, :code, :did, :name, :capabilities, 'pending', :expiresAt, :at)`,
        {
          id: randomUUID(),
          hash: hashToken(deviceCode),
          code: userCode,
          did,
          name,
          capabilities: JSON.stringify(capabilities),
          expiresAt,
          at: now,
        },
      );
    });
    return {
      deviceCode,
      userCode,
      expiresIn: DEVICE_TTL_SECONDS,
      expiresAt,
      verificationUri: '/agents/approve',
    };
  }

  async poll(body: unknown) {
    const input = asObject(body);
    const deviceCode = asString(input.deviceCode, 'deviceCode', { max: 512, min: 16 });
    const hash = hashToken(deviceCode);
    const row = await this.ctx.db.read.one('SELECT * FROM agent_requests WHERE device_code_hash = :hash', { hash });
    if (!row) throw invalid('deviceCode 无效');
    const status = String(row.status);
    if (status === 'pending') {
      if (String(row.expires_at) <= this.ctx.now()) throw conflict('授权码已过期，请重新发起');
      return { status: 'pending' as const, expiresAt: String(row.expires_at) };
    }
    if (status === 'denied') throw forbidden('授权请求已被拒绝');
    if (status === 'consumed') throw conflict('授权码已使用，请重新发起');
    if (status !== 'approved') throw conflict('授权请求状态异常');

    // 批准后第一次轮询才签发令牌：数据库里始终没有明文会话令牌。
    const principalId = row.approved_principal_id === null ? '' : String(row.approved_principal_id);
    const principalRow = await this.ctx.db.read.one(
      'SELECT * FROM principals WHERE id = :id AND workspace IS NOT NULL',
      { id: principalId },
    );
    if (!principalRow) throw notFound('授权对应的主体不存在');
    const principal = toPrincipal(principalRow);
    if (!principal.active) throw forbidden('该智能体已被停用');

    const changed = await this.ctx.db.transaction(async tx =>
      tx.run(`UPDATE agent_requests SET status = 'consumed' WHERE id = :id AND status = 'approved'`, {
        id: String(row.id),
      }),
    );
    if (changed === 0) throw conflict('授权码已使用，请重新发起');

    const grant = await this.grantOf(principal.id);
    const session = await this.identity.openSession(principal, String(row.requested_did), 'agent');
    return {
      status: 'ok' as const,
      token: session.token,
      tokenType: 'Bearer' as const,
      expiresAt: session.expiresAt,
      principal,
      scopes: grant?.scopes ?? DEFAULT_SCOPES,
      grantExpiresAt: grant?.expiresAt ?? null,
    };
  }

  // ---------------------------------------------------------------- 人侧

  /** 页面上要显示"最近发起、还没批准的请求"，这样不用手输也能点。 */
  async pendingRequests(actor: Principal) {
    // 请求在批准前不属于任何租户，列表会暴露 DID 与名称，因此只给管理员看；
    // 普通成员仍然可以通过输入批准码完成绑定，只是看不到别人的请求。
    if (!this.tenants.isAdmin(actor)) throw forbidden('只有所有者或管理员可以查看待批准的智能体');
    const rows = await this.ctx.db.read.all(
      `SELECT user_code, requested_did, name, capabilities, expires_at, created_at
       FROM agent_requests WHERE status = 'pending' AND expires_at > :now
       ORDER BY created_at DESC LIMIT 20`,
      { now: this.ctx.now() },
    );
    return rows.map(row => ({
      userCode: String(row.user_code),
      did: String(row.requested_did),
      name: String(row.name ?? ''),
      capabilities: JSON.parse(String(row.capabilities ?? '[]')) as string[],
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      mine: false,
    }));
  }

  async approve(actor: Principal, body: unknown) {
    const input = asObject(body);
    const userCode = normalizeCode(asString(input.userCode, 'userCode', { max: 32, min: 4 }));
    const mode = input.mode === undefined ? 'own' : String(input.mode);
    if (mode !== 'own' && mode !== 'link') throw invalid('mode 只能是 own 或 link');
    const scopes = this.tenants.parseScopes(input.scopes, DEFAULT_SCOPES);
    const hours = input.expiresInHours === undefined ? 24 * 30 : asInteger(Number(input.expiresInHours), 'expiresInHours', { min: 1, max: 24 * 365 });
    const displayName = input.name === undefined ? '' : asString(input.name, 'name', { max: 120, min: 0 });

    const request = await this.ctx.db.read.one(
      `SELECT * FROM agent_requests WHERE user_code = :code AND status = 'pending' AND expires_at > :now`,
      { code: userCode, now: this.ctx.now() },
    );
    if (!request) throw notFound('批准码不存在、已使用或已过期');

    const did = String(request.requested_did);
    const name = displayName || String(request.name ?? '') || `Agent ${did.slice(-6)}`;
    const now = this.ctx.now();
    const expiresAt = new Date(Date.parse(now) + hours * 3600 * 1000).toISOString();

    if (mode === 'link') {
      // 共用账号：DID 挂到本人主体上，Agent 从此以"我"的身份行动。
      const taken = await this.ctx.db.read.one(
        'SELECT principal_id FROM identities WHERE workspace = :workspace AND did = :did',
        { workspace: actor.workspace, did },
      );
      if (taken && String(taken.principal_id) !== actor.id) {
        throw conflict('这条 DID 已属于另一个主体');
      }
      await this.ctx.db.transaction(async tx => {
        if (!taken) {
          await tx.run(
            `INSERT INTO identities(id, workspace, did, principal_id, fingerprint, client, created_at, last_login_at, login_count)
             VALUES(:id, :workspace, :did, :principal, NULL, 'agent', :at, NULL, 0)`,
            { id: randomUUID(), workspace: actor.workspace, did, principal: actor.id, at: now },
          );
        }
        await tx.run(
          `UPDATE agent_requests SET status = 'approved', approved_principal_id = :principal,
             approved_by = :by WHERE id = :id AND status = 'pending'`,
          { principal: actor.id, by: actor.id, id: String(request.id) },
        );
      });
      await this.upsertGrant({
        tenantId: actor.workspace,
        agentPrincipalId: actor.id,
        ownerId: actor.id,
        scopes,
        expiresAt,
        now,
      });
      return {
        principalId: actor.id,
        agentName: actor.displayName,
        did,
        mode,
        scopes,
        expiresAt,
        note: '已绑定到你的账号：该 Agent 拥有你本人的全部权限，撤销时请直接删除绑定。',
      };
    }

    // 同一个 DID 可能是"撤销后又来申请"：智能体主体可以复用，人不行——不能把一个人的身份
    // 悄悄换成智能体。复用时要停掉旧会话，避免旧令牌借着重新批准复活。
    const clash = await this.ctx.db.read.one(
      `SELECT p.id, p.kind FROM identities i JOIN principals p ON p.id = i.principal_id
       WHERE i.workspace = :workspace AND i.did = :did`,
      { workspace: actor.workspace, did },
    );
    if (clash && String(clash.kind) !== 'agent') throw conflict('这条 DID 已属于本组织中的另一个主体');

    const principalId = await this.ctx.db.transaction(async tx => {
      let id: string;
      if (clash) {
        id = String(clash.id);
        await tx.run(
          `UPDATE principals SET active = 1, display_name = :name, capabilities = :capabilities,
             tenant_role = 'member', roles = :roles WHERE id = :id AND workspace = :workspace`,
          {
            name,
            capabilities: String(request.capabilities ?? '[]'),
            roles: JSON.stringify(rolesFor('member', 'agent')),
            id,
            workspace: actor.workspace,
          },
        );
        await tx.run(
          `UPDATE anp_sessions SET revoked_at = :at
           WHERE workspace = :workspace AND principal_id = :id AND revoked_at IS NULL`,
          { at: now, workspace: actor.workspace, id },
        );
      } else {
        id = await this.tenants.insertPrincipal(tx, {
          workspace: actor.workspace,
          accountId: actor.accountId,
          kind: 'agent',
          tenantRole: 'member',
          displayName: name,
          did,
          capabilities: JSON.parse(String(request.capabilities ?? '[]')) as string[],
        });
        await tx.run(
          `INSERT INTO identities(id, workspace, did, principal_id, fingerprint, client, created_at, last_login_at, login_count)
           VALUES(:id, :workspace, :did, :principal, NULL, 'agent', :at, NULL, 0)`,
          { id: randomUUID(), workspace: actor.workspace, did, principal: id, at: now },
        );
      }
      const changed = await tx.run(
        `UPDATE agent_requests SET status = 'approved', approved_principal_id = :principal,
           approved_by = :by WHERE id = :id AND status = 'pending'`,
        { principal: id, by: actor.id, id: String(request.id) },
      );
      if (changed === 0) throw conflict('这条授权请求已被处理');
      return id;
    });

    await this.upsertGrant({
      tenantId: actor.workspace,
      agentPrincipalId: principalId,
      ownerId: actor.id,
      scopes,
      expiresAt,
      now,
    });
    return { principalId, agentName: name, did, mode, scopes, expiresAt };
  }

  async list(actor: Principal): Promise<AgentGrant[]> {
    const rows = await this.ctx.db.read.all(
      `SELECT g.*, p.display_name AS agent_name, p.did AS agent_did, s.last_seen_at AS last_seen
       FROM agent_grants g
       JOIN principals p ON p.id = g.agent_principal_id
       LEFT JOIN (
         SELECT principal_id, MAX(last_seen_at) AS last_seen_at FROM anp_sessions GROUP BY principal_id
       ) s ON s.principal_id = g.agent_principal_id
       WHERE g.tenant_id = :tenant AND g.owner_principal_id = :owner
       ORDER BY g.created_at DESC`,
      { tenant: actor.workspace, owner: actor.id },
    );
    return rows.map(row => this.toGrant(row));
  }

  async revoke(actor: Principal, grantId: string) {
    const row = await this.ctx.db.read.one(
      'SELECT * FROM agent_grants WHERE id = :id AND tenant_id = :tenant',
      { id: grantId, tenant: actor.workspace },
    );
    if (!row) throw notFound('授权不存在');
    const isOwner = String(row.owner_principal_id) === actor.id;
    if (!isOwner && !this.tenants.isAdmin(actor)) throw forbidden('只有授权人或管理员可以撤销');
    if (String(row.status) !== 'active') throw conflict('该授权已被撤销');
    const agentId = String(row.agent_principal_id);
    await this.ctx.db.transaction(async tx => {
      await tx.run(`UPDATE agent_grants SET status = 'revoked', revoked_at = :at WHERE id = :id`, {
        at: this.ctx.now(),
        id: grantId,
      });
      // 共用账号模式下 agentId 就是本人：停用账号会把人自己踢出去，
      // 因此只撤销"以智能体身份登录"的那批会话。
      if (agentId === actor.id) {
        await tx.run(
          `UPDATE anp_sessions SET revoked_at = :at
           WHERE workspace = :tenant AND principal_id = :principal AND client = 'agent' AND revoked_at IS NULL`,
          { at: this.ctx.now(), tenant: actor.workspace, principal: agentId },
        );
      } else {
        await tx.run('UPDATE principals SET active = 0 WHERE id = :id AND workspace = :tenant', {
          id: agentId,
          tenant: actor.workspace,
        });
        await tx.run(
          `UPDATE anp_sessions SET revoked_at = :at
           WHERE workspace = :tenant AND principal_id = :principal AND revoked_at IS NULL`,
          { at: this.ctx.now(), tenant: actor.workspace, principal: agentId },
        );
      }
    });
    return { id: grantId, revoked: true };
  }

  // ---------------------------------------------------------------- 内部

  private async upsertGrant(input: {
    tenantId: string;
    agentPrincipalId: string;
    ownerId: string;
    scopes: AgentScope[];
    expiresAt: string;
    now: string;
  }): Promise<void> {
    await this.ctx.db.transaction(async tx => {
      const existing = await tx.one('SELECT id FROM agent_grants WHERE agent_principal_id = :agent', {
        agent: input.agentPrincipalId,
      });
      if (existing) {
        await tx.run(
          `UPDATE agent_grants SET scopes = :scopes, status = 'active', expires_at = :expiresAt,
             revoked_at = NULL, owner_principal_id = :owner
           WHERE id = :id`,
          {
            scopes: JSON.stringify(input.scopes),
            expiresAt: input.expiresAt,
            owner: input.ownerId,
            id: String(existing.id),
          },
        );
        return;
      }
      await tx.run(
        `INSERT INTO agent_grants(id, tenant_id, agent_principal_id, owner_principal_id, scopes,
                                  status, expires_at, created_at)
         VALUES(:id, :tenant, :agent, :owner, :scopes, 'active', :expiresAt, :at)`,
        {
          id: `grant_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          tenant: input.tenantId,
          agent: input.agentPrincipalId,
          owner: input.ownerId,
          scopes: JSON.stringify(input.scopes),
          expiresAt: input.expiresAt,
          at: input.now,
        },
      );
      await tx.run('UPDATE principals SET active = 1 WHERE id = :id AND workspace = :tenant', {
        id: input.agentPrincipalId,
        tenant: input.tenantId,
      });
    });
  }

  private async grantOf(agentPrincipalId: string): Promise<AgentGrant | null> {
    const row = await this.ctx.db.read.one(
      `SELECT g.*, p.display_name AS agent_name, p.did AS agent_did
       FROM agent_grants g JOIN principals p ON p.id = g.agent_principal_id
       WHERE g.agent_principal_id = :id`,
      { id: agentPrincipalId },
    );
    return row ? this.toGrant(row) : null;
  }

  private toGrant(row: Record<string, unknown>): AgentGrant {
    return {
      id: String(row.id),
      agentPrincipalId: String(row.agent_principal_id),
      agentName: String(row.agent_name ?? ''),
      agentDid: row.agent_did === null || row.agent_did === undefined ? null : String(row.agent_did),
      ownerId: String(row.owner_principal_id),
      scopes: JSON.parse(String(row.scopes ?? '[]')) as AgentScope[],
      status: String(row.status) === 'revoked' ? 'revoked' : 'active',
      expiresAt: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
      createdAt: String(row.created_at),
      revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
      lastSeenAt: row.last_seen === null || row.last_seen === undefined ? null : String(row.last_seen),
    };
  }

  private async freshUserCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length]).join('');
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const clash = await this.ctx.db.read.one(
        `SELECT 1 AS present FROM agent_requests WHERE user_code = :code AND status = 'pending'`,
        { code },
      );
      if (!clash) return code;
    }
    throw conflict('生成批准码失败，请重试');
  }
}

function normalizeCode(raw: string): string {
  const compact = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}
