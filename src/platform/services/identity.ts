/**
 * ANP 身份服务：挑战、验签登录、会话、DID 绑定。
 *
 * 职责边界：
 *  - 平台**验证**签名，不保管私钥、不代签；
 *  - 一个主体可以绑定多个 DID（人与智能体共用账号），但审计始终记录具体 DID；
 *  - 陌生 DID 的落位由 `COLLAB_ANP_ENROLL` 决定，默认 `open`（本机验证友好），
 *    企业部署应改为 `pending`，由管理员在控制台批准。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { conflict, forbidden, invalid, notFound, unauthenticated } from '../../protocol/errors.ts';
import { asObject, asString } from '../../protocol/parse.ts';
import type { Principal, PrincipalKind, Role } from '../../protocol/types.ts';
import { ROLES } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import { toPrincipal } from '../db/mappers.ts';
import type { Queryable } from '../db/driver.ts';
import { didShortId, handleFromDid, isDid, resolveVerificationKey } from '../../anp/did.ts';
import { verifySignature } from '../../anp/signature.ts';
import { hashToken } from './principals.ts';
import type { AccountService } from './accounts.ts';

export type EnrollMode = 'open' | 'pending' | 'off';

export type IdentityOptions = {
  workspace: string;
  enroll: EnrollMode;
  sessionTtlHours: number;
  nonceTtlSeconds: number;
};

/** 服务器要求客户端使用它签发的 nonce 重签一次。 */
export class ChallengeRequiredError extends Error {
  readonly nonce: string;
  readonly expiresAt: string;

  constructor(nonce: string, expiresAt: string, message = '请使用服务器签发的 nonce 重新签名') {
    super(message);
    this.name = 'ChallengeRequiredError';
    this.nonce = nonce;
    this.expiresAt = expiresAt;
  }
}

export class EnrollmentPendingError extends Error {
  readonly principalId: string;

  constructor(principalId: string) {
    super('该身份已登记，等待管理员批准');
    this.name = 'EnrollmentPendingError';
    this.principalId = principalId;
  }
}

export type LoginRequest = {
  method: string;
  /** 实际请求 URL，必须与签名覆盖的 `@target-uri` 完全一致。 */
  url: string;
  /** 请求头的原样副本（键小写）。 */
  headers: Record<string, string>;
  /** 请求体原始字节，验签与 content-digest 都基于它。 */
  rawBody: string;
};

export type LoginResult = {
  token: string;
  tokenType: 'Bearer';
  did: string;
  subject: string;
  keyid: string;
  principal: Principal;
  sessionExpiresAt: string;
  /** auto：首次登录自动登记；bound：绑定到已有账号；existing：已有身份。 */
  enrollment: 'auto' | 'bound' | 'existing';
};

export type IdentityView = {
  id: string;
  did: string;
  keyid: string;
  fingerprint: string | null;
  client: string;
  createdAt: string;
  lastLoginAt: string | null;
  loginCount: number;
};

export type BindResult = IdentityView & {
  /** true 表示这条 DID 本来就在本账号下，本次没有新增。 */
  existing: boolean;
  /** true 表示同时被设成了主体的主 DID（之前没有主 DID）。 */
  primary: boolean;
};

export class IdentityService {
  private readonly ctx: Context;
  private readonly options: IdentityOptions;
  private readonly accounts: AccountService | null;

  constructor(ctx: Context, options: IdentityOptions, accounts: AccountService | null = null) {
    this.ctx = ctx;
    this.options = options;
    this.accounts = accounts;
  }

  // ---------------------------------------------------------------- 挑战

  async issueNonce(purpose = 'login', expiresInSeconds = this.options.nonceTtlSeconds) {
    const nonce = randomBytes(24).toString('base64url');
    const now = this.ctx.now();
    const expiresAt = new Date(Date.parse(now) + expiresInSeconds * 1000).toISOString();
    await this.ctx.db.transaction(async tx => {
      // 顺手清掉过期挑战：这张表只服务于很短的时间窗，不需要保留历史。
      await tx.run('DELETE FROM anp_nonces WHERE expires_at < :now', { now });
      await tx.run(
        `INSERT INTO anp_nonces(nonce, purpose, issued_at, expires_at, consumed_at, issued_to)
         VALUES(:nonce, :purpose, :at, :expiresAt, NULL, NULL)`,
        { nonce, purpose, at: now, expiresAt },
      );
    });
    return { nonce, expiresAt, purpose };
  }

  /**
   * 消费 nonce。返回 false 表示没消费成功——不存在、过期、已用过，
   * 或者用途对不上（登录的挑战不能拿去绑定 DID，反之亦然）。
   *
   * 单次使用是这里唯一的防重放手段，因此"查"和"改"必须在同一个事务里，
   * 否则两个并发请求会同时看到未消费状态。
   */
  private async consumeNonce(nonce: string, purpose = 'login'): Promise<boolean> {
    const now = this.ctx.now();
    return this.ctx.db.transaction(async tx => {
      const row = await tx.one<{ consumed_at: string | null; expires_at: string; purpose: string }>(
        'SELECT consumed_at, expires_at, purpose FROM anp_nonces WHERE nonce = :nonce',
        { nonce },
      );
      if (!row || row.consumed_at !== null || String(row.expires_at) < now) return false;
      if (String(row.purpose) !== purpose) return false;
      await tx.run('UPDATE anp_nonces SET consumed_at = :at WHERE nonce = :nonce', { at: now, nonce });
      return true;
    });
  }

  // ---------------------------------------------------------------- 登录

  /**
   * 验证一次 ANP 登录。
   *
   * 顺序：形状 → 公钥 → 签名 → nonce → 主体。把 nonce 放在签名之后，
   * 是为了不让未通过签名的请求消耗掉合法客户端的挑战。
   */
  async login(request: LoginRequest): Promise<LoginResult> {
    const payload = this.parseBody(request.rawBody);
    const did = payload.did;
    if (!isDid(did)) throw invalid('did 必须是 did:wba 标识');

    let resolved;
    try {
      resolved = resolveVerificationKey(did, String(payload.keyid ?? '#key-1'), payload.didDocument);
    } catch (error) {
      throw unauthenticated(`DID 文档不可用：${messageOf(error)}`);
    }

    let verified;
    try {
      verified = verifySignature(
        { method: request.method, url: request.url, headers: request.headers, body: request.rawBody },
        resolved.key,
        resolved.keyid,
        did,
      );
    } catch (error) {
      throw unauthenticated(`签名校验失败：${messageOf(error)}`);
    }

    const bodyNonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    // 请求体里的 nonce 和签名参数里的 nonce 必须一致，否则"签一个、填另一个"能绕过重放控制。
    if (verified.nonce && bodyNonce && verified.nonce !== bodyNonce) {
      throw unauthenticated('请求体 nonce 与签名参数不一致');
    }
    const nonce = verified.nonce || bodyNonce;
    if (!nonce) {
      const issued = await this.issueNonce();
      throw new ChallengeRequiredError(issued.nonce, issued.expiresAt);
    }
    if (!(await this.consumeNonce(nonce, 'login'))) {
      const issued = await this.issueNonce();
      throw new ChallengeRequiredError(issued.nonce, issued.expiresAt, 'nonce 无效、已使用或已过期');
    }

    const client: 'browser' | 'agent' = payload.client === 'browser' ? 'browser' : 'agent';
    const bindCode = typeof payload.bindCode === 'string' ? payload.bindCode.trim() : '';
    const outcome = await this.resolvePrincipal({
      did,
      keyid: resolved.keyid,
      fingerprint: resolved.fingerprint,
      client,
      bindCode,
    });

    if (!outcome.principal.active) throw new EnrollmentPendingError(outcome.principal.id);

    const session = await this.createSession(outcome.principal, did, client);
    return {
      token: session.token,
      tokenType: 'Bearer',
      did,
      subject: did,
      keyid: resolved.keyid,
      principal: outcome.principal,
      sessionExpiresAt: session.expiresAt,
      enrollment: outcome.enrollment,
    };
  }

  private parseBody(rawBody: string): Record<string, unknown> & { did?: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw invalid('请求体不是合法 JSON');
    }
    return asObject(parsed, '登录请求') as Record<string, unknown> & { did?: string };
  }

  // ---------------------------------------------------------------- 主体

  private async resolvePrincipal(input: {
    did: string;
    keyid: string;
    fingerprint: string;
    client: 'browser' | 'agent';
    bindCode: string;
  }): Promise<{ principal: Principal; enrollment: LoginResult['enrollment'] }> {
    // 账号查询必须在事务外：它自己会开事务，嵌套会自锁。
    const account = this.accounts
      ? await this.accounts.ensure('did', input.did, {
          verified: true,
          displayName: handleFromDid(input.did) ?? undefined,
        })
      : null;
    const accountId = account?.id ?? null;

    return this.ctx.db.transaction(async tx => {
      const existing = await tx.one<{ id: string; principal_id: string }>(
        'SELECT id, principal_id FROM identities WHERE workspace = :workspace AND did = :did',
        { workspace: this.options.workspace, did: input.did },
      );
      if (existing) {
        const row = await tx.one('SELECT * FROM principals WHERE id = :id', { id: existing.principal_id });
        if (!row) throw notFound('身份绑定的主体已不存在');
        await tx.run(
          `UPDATE identities SET last_login_at = :at, login_count = login_count + 1,
             fingerprint = :fingerprint, client = :client
           WHERE id = :id`,
          { at: this.ctx.now(), fingerprint: input.fingerprint, client: input.client, id: existing.id },
        );
        // 老数据没有账号：登录时补上，之后才能在多个租户之间切换。
        if (accountId && (row.account_id === null || row.account_id === undefined)) {
          await tx.run('UPDATE principals SET account_id = :account WHERE id = :id', {
            account: accountId,
            id: existing.principal_id,
          });
          row.account_id = accountId;
        }
        return { principal: toPrincipal(row), enrollment: 'existing' as const };
      }

      if (input.bindCode) {
        const bound = await this.bindWithCode(tx, { ...input, accountId });
        // 填了绑定码却对不上，就不要顺手给一个新账号：那会让人以为自己进对了地方。
        if (!bound) throw invalid('绑定码无效，或者不属于当前工作空间');
        return { principal: bound, enrollment: 'bound' as const };
      }

      if (this.options.enroll === 'off') {
        throw forbidden('该 DID 未登记，且平台不接受自动登记');
      }

      const principal = await this.enrollPrincipal(tx, { ...input, accountId });
      await this.insertIdentity(tx, input, principal.id);
      return { principal, enrollment: 'auto' as const };
    });
  }

  private async bindWithCode(
    tx: Queryable,
    input: { did: string; fingerprint: string; client: 'browser' | 'agent'; bindCode: string; accountId: string | null },
  ): Promise<Principal | null> {
    const now = this.ctx.now();
    const invite = await tx.one<{
      code: string;
      principal_id: string;
      role: string;
      expires_at: string;
      used_at: string | null;
    }>('SELECT * FROM identity_invites WHERE code = :code AND workspace = :workspace', {
      code: input.bindCode,
      workspace: this.options.workspace,
    });
    if (!invite) return null;
    if (invite.used_at !== null || String(invite.expires_at) < now) {
      throw forbidden('绑定码已使用或已过期');
    }
    const row = await tx.one('SELECT * FROM principals WHERE id = :id', { id: invite.principal_id });
    if (!row) throw notFound('绑定码指向的主体已不存在');
    await tx.run(
      `UPDATE identity_invites SET used_at = :at, used_by_did = :did WHERE code = :code`,
      { at: now, did: input.did, code: invite.code },
    );
    // 共用账号：DID 挂到主人的账号上，之后同一个账号在多租户里也是同一个身份。
    if (input.accountId && (row.account_id === null || row.account_id === undefined)) {
      await tx.run('UPDATE principals SET account_id = :account WHERE id = :id', {
        account: input.accountId,
        id: invite.principal_id,
      });
    }
    await this.insertIdentity(tx, input, invite.principal_id);
    return toPrincipal(row);
  }

  private async enrollPrincipal(
    tx: Queryable,
    input: { did: string; client: 'browser' | 'agent'; accountId: string | null },
  ): Promise<Principal> {
    const kind: PrincipalKind = input.client === 'agent' ? 'agent' : 'human';
    const roles: Role[] = kind === 'agent' ? ['agent'] : ['owner'];
    const active = this.options.enroll === 'open';
    // 一个空工作空间里的第一个人类就是这个组织的所有者；之后自动登记的都是成员。
    const humans = await tx.one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM principals WHERE workspace = :workspace AND kind = 'human'`,
      { workspace: this.options.workspace },
    );
    const tenantRole = kind === 'human' && Number(humans?.count ?? 0) === 0 ? 'owner' : 'member';
    const base = didShortId(input.did);
    let id = base;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const clash = await tx.one('SELECT id FROM principals WHERE id = :id AND workspace = :workspace', {
        id,
        workspace: this.options.workspace,
      });
      if (!clash) break;
      id = `${base}-${randomBytes(2).toString('hex')}`;
    }
    const handle = handleFromDid(input.did);
    await tx.run(
      `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name, description,
                              capabilities, active, created_at, account_id, tenant_role)
       VALUES(:id, :workspace, :roles, :hash, :did, :kind, :handle, :displayName, :description,
              :capabilities, :active, :at, :accountId, :tenantRole)`,
      {
        id,
        workspace: this.options.workspace,
        roles: JSON.stringify(roles),
        // ANP 主体没有静态令牌：给一个不可知的随机摘要占位，静态令牌通道对它永远不成立。
        hash: hashToken(`anp:${randomUUID()}:${randomBytes(16).toString('hex')}`),
        did: input.did,
        kind,
        handle,
        displayName: handle ?? id,
        description: kind === 'agent' ? '首次 ANP 登录自动登记' : '首次 ANP 登录自动登记（人类）',
        capabilities: JSON.stringify([]),
        active: active ? 1 : 0,
        at: this.ctx.now(),
        accountId: input.accountId,
        tenantRole,
      },
    );
    const row = await tx.one('SELECT * FROM principals WHERE id = :id', { id });
    return toPrincipal(row!);
  }

  /**
   * 登记一条 DID。
   *
   * `countsAsLogin` 区分两种来路：登录时顺手登记（计数 1），还是已登录之后
   * 补绑（这条 DID 还没登录过，记 0 才和界面上的"登录 N 次"对得上）。
   */
  private async insertIdentity(
    tx: Queryable,
    input: { did: string; fingerprint: string; client: 'browser' | 'agent' },
    principalId: string,
    countsAsLogin = true,
  ): Promise<void> {
    const at = this.ctx.now();
    await tx.run(
      `INSERT INTO identities(id, workspace, did, principal_id, fingerprint, client, created_at, last_login_at, login_count)
       VALUES(:id, :workspace, :did, :principal, :fingerprint, :client, :at, :lastLoginAt, :loginCount)`,
      {
        id: randomUUID(),
        workspace: this.options.workspace,
        did: input.did,
        principal: principalId,
        fingerprint: input.fingerprint,
        client: input.client,
        at,
        lastLoginAt: countsAsLogin ? at : null,
        loginCount: countsAsLogin ? 1 : 0,
      },
    );
  }

  // ---------------------------------------------------------------- 会话

  /**
   * 签发会话。邮箱登录与 Agent 轮询都复用它，保证三种登录方式产出同一种令牌，
   * 后续授权只认主体，不认登录方式。
   */
  async openSession(
    principal: Principal,
    did: string | null,
    client: 'browser' | 'agent',
  ): Promise<{ token: string; expiresAt: string }> {
    return this.createSession(principal, did ?? '', client);
  }

  private async createSession(
    principal: Principal,
    did: string,
    client: 'browser' | 'agent',
  ): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString('base64url');
    const now = this.ctx.now();
    const expiresAt = new Date(
      Date.parse(now) + this.options.sessionTtlHours * 60 * 60 * 1000,
    ).toISOString();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO anp_sessions(id, token_hash, principal_id, did, workspace, client, label,
                                  created_at, expires_at, last_seen_at, revoked_at)
         VALUES(:id, :hash, :principal, :did, :workspace, :client, '', :at, :expiresAt, :at, NULL)`,
        {
          id: randomUUID(),
          hash: hashToken(token),
          principal: principal.id,
          did,
          workspace: principal.workspace,
          client,
          at: now,
          expiresAt,
        },
      );
    });
    return { token, expiresAt };
  }

  async logout(token: string): Promise<{ revoked: boolean }> {
    // 必须走事务包装：退出登录本身由写执行器包在事务里，直接用 db.run 会
    // 等写互斥量，而那个互斥量正被外层事务持有——那就成了自锁。
    const changed = await this.ctx.db.transaction(async tx =>
      tx.run('UPDATE anp_sessions SET revoked_at = :at WHERE token_hash = :hash AND revoked_at IS NULL', {
        at: this.ctx.now(),
        hash: hashToken(token),
      }),
    );
    return { revoked: changed > 0 };
  }

  async listSessions(actor: Principal) {
    const rows = await this.ctx.db.read.all(
      `SELECT id, did, client, created_at, expires_at, last_seen_at, revoked_at
       FROM anp_sessions WHERE workspace = :workspace AND principal_id = :principal
       ORDER BY created_at DESC LIMIT 50`,
      { workspace: actor.workspace, principal: actor.id },
    );
    return rows.map(row => ({
      id: String(row.id),
      did: String(row.did),
      client: String(row.client),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      lastSeenAt: String(row.last_seen_at),
      active: row.revoked_at === null && String(row.expires_at) > this.ctx.now(),
    }));
  }

  async revokeSession(actor: Principal, sessionId: string) {
    const changed = await this.ctx.db.transaction(async tx =>
      tx.run(
        `UPDATE anp_sessions SET revoked_at = :at
         WHERE id = :id AND workspace = :workspace AND principal_id = :principal AND revoked_at IS NULL`,
        { at: this.ctx.now(), id: sessionId, workspace: actor.workspace, principal: actor.id },
      ),
    );
    if (changed === 0) throw notFound('会话不存在或已失效');
    return { id: sessionId, revoked: true };
  }

  // ---------------------------------------------------------------- 绑定与邀请

  /** 签发绑定码：让另一个 DID（通常是智能体）登进同一个主体。 */
  async createInvite(actor: Principal, body: unknown) {
    const input = asObject(body);
    const role = input.role === undefined ? (actor.roles.includes('agent') ? 'agent' : 'owner') : String(input.role);
    if (!ROLES.includes(role as Role)) throw invalid(`role 必须是 ${ROLES.join(' / ')} 之一`);
    // 绑定码只登记"这条 DID 属于谁"，不改主体角色，因此它不是提权通道；
    // role 只用于邀请记录与界面提示。
    const hours = input.expiresInHours === undefined ? 24 : Number(input.expiresInHours);
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 30) {
      throw invalid('expiresInHours 必须在 1..720 之间');
    }
    const now = this.ctx.now();
    const code = randomBytes(9).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toUpperCase();
    const expiresAt = new Date(Date.parse(now) + hours * 3600 * 1000).toISOString();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO identity_invites(code, workspace, principal_id, role, note, created_at, expires_at, used_at, used_by_did)
         VALUES(:code, :workspace, :principal, :role, :note, :at, :expiresAt, NULL, NULL)`,
        {
          code,
          workspace: actor.workspace,
          principal: actor.id,
          role,
          note: input.note === undefined ? '' : asString(input.note, 'note', { max: 200, min: 0 }),
          at: now,
          expiresAt,
        },
      );
    });
    return { code, role, expiresAt, expiresInHours: hours };
  }

  async listIdentities(actor: Principal) {
    const rows = await this.ctx.db.read.all(
      `SELECT i.*, p.display_name AS principal_name
       FROM identities i JOIN principals p ON p.id = i.principal_id
       WHERE i.workspace = :workspace AND i.principal_id = :principal
       ORDER BY i.created_at`,
      { workspace: actor.workspace, principal: actor.id },
    );
    return rows.map(row => toIdentityView(row));
  }

  async revokeIdentity(actor: Principal, identityId: string) {
    const row = await this.ctx.db.read.one<{ did: string }>(
      'SELECT did FROM identities WHERE id = :id AND workspace = :workspace AND principal_id = :principal',
      { id: identityId, workspace: actor.workspace, principal: actor.id },
    );
    if (!row) throw notFound('身份不存在');
    const remaining = await this.ctx.db.read.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM identities WHERE workspace = :workspace AND principal_id = :principal',
      { workspace: actor.workspace, principal: actor.id },
    );
    if (Number(remaining?.count ?? 0) <= 1) throw conflict('不能解绑主体唯一的身份');
    await this.ctx.db.transaction(async tx => {
      await tx.run('DELETE FROM identities WHERE id = :id', { id: identityId });
      await tx.run(
        `UPDATE anp_sessions SET revoked_at = :at
         WHERE workspace = :workspace AND did = :did AND revoked_at IS NULL`,
        { at: this.ctx.now(), workspace: actor.workspace, did: String(row.did) },
      );
    });
    return { id: identityId, revoked: true };
  }

  // ---------------------------------------------------------------- 补绑 DID

  /**
   * 给已登录的主体签发一次"补绑 DID"的挑战。
   *
   * 用途单独记为 `bind`：登录挑战不能拿去补绑，补绑挑战也不能拿去换会话。
   */
  async issueBindChallenge(origin = '') {
    const issued = await this.issueNonce('bind');
    return {
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
      purpose: issued.purpose,
      audience: origin ? `${origin}/v1/me/identities/bind` : null,
    };
  }

  /**
   * 把一条 DID 补绑到**当前已登录主体**上。
   *
   * 两个条件必须同时成立，缺一不可：
   *  - 会话令牌有效——否则任何人都能把自己的 DID 挂到别人的账号上；
   *  - 请求被该 DID 的私钥签过——否则把自己的账号挂到一条不属于自己的 DID 上。
   *
   * 绑定只增加"这条 DID 登进来会落到这个主体"，不改变任何角色：
   * 它既不是提权通道，也不能借此让别的账号继承现有权限。
   */
  async bindDid(
    actor: Principal,
    request: { method: string; url: string; headers: Record<string, string>; rawBody: string },
  ): Promise<BindResult> {
    const payload = this.parseBody(request.rawBody);
    const did = payload.did;
    if (!isDid(did)) throw invalid('did 必须是 did:wba 标识');

    let resolved;
    try {
      resolved = resolveVerificationKey(did, String(payload.keyid ?? '#key-1'), payload.didDocument);
    } catch (error) {
      throw unauthenticated(`DID 文档不可用：${messageOf(error)}`);
    }

    let verified;
    try {
      verified = verifySignature(
        { method: request.method, url: request.url, headers: request.headers, body: request.rawBody },
        resolved.key,
        resolved.keyid,
        did,
      );
    } catch (error) {
      throw unauthenticated(`签名校验失败：${messageOf(error)}`);
    }

    const bodyNonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (verified.nonce && bodyNonce && verified.nonce !== bodyNonce) {
      throw unauthenticated('请求体 nonce 与签名参数不一致');
    }
    const nonce = verified.nonce || bodyNonce;
    if (!nonce) throw invalid('补绑 DID 必须带上服务端签发的挑战');
    if (!(await this.consumeNonce(nonce, 'bind'))) {
      throw unauthenticated('挑战无效、已使用、已过期或用途不符，请重新获取');
    }

    const client = payload.client === 'agent' ? 'agent' : 'browser';

    // 账号级凭证是全局唯一的：这条 DID 若已属于别的账号，绑进来也会在下次
    // 登录时把会话发到那个账号，界面显示与实际行为不一致，不如当场说清楚。
    if (this.accounts) {
      const owner = await this.accounts.findByLink('did', did);
      if (owner && owner.id !== actor.accountId) {
        throw conflict('这条 DID 已属于另一个账号，请先用它登录后解绑，或换一条 DID');
      }
    }

    const outcome = await this.ctx.db.transaction(async tx => {
      const bound = await tx.one<{ id: string; principal_id: string }>(
        'SELECT id, principal_id FROM identities WHERE workspace = :workspace AND did = :did',
        { workspace: actor.workspace, did },
      );
      if (bound && String(bound.principal_id) !== actor.id) {
        // 一条 DID 在一个组织里只能属于一个主体；否则"谁签的"就没有唯一答案。
        throw conflict('这条 DID 已绑定到本组织的另一个主体，请先用它登录并解绑');
      }

      const primary = await tx.one<{ id: string }>(
        'SELECT id FROM principals WHERE workspace = :workspace AND did = :did',
        { workspace: actor.workspace, did },
      );
      if (primary && String(primary.id) !== actor.id) {
        throw conflict('这条 DID 已经是本组织另一个主体的主身份');
      }

      // 已经有这条绑定：不重复插入，按幂等成功返回，但不动 login_count。
      if (bound) {
        const row = await tx.one('SELECT * FROM identities WHERE id = :id', { id: bound.id });
        return { identity: toIdentityView(row!), existing: true, primary: false };
      }

      await this.insertIdentity(tx, { did, fingerprint: resolved.fingerprint, client }, actor.id, false);

      // 主体还没有主 DID 时，把这条设为主身份：侧栏、/v1/me 与目录里都认得出来。
      let becamePrimary = false;
      if (!actor.did) {
        await tx.run('UPDATE principals SET did = :did WHERE id = :id AND workspace = :workspace', {
          did,
          id: actor.id,
          workspace: actor.workspace,
        });
        if (!actor.handle) {
          const handle = handleFromDid(did);
          if (handle) {
            await tx.run('UPDATE principals SET handle = :handle WHERE id = :id AND workspace = :workspace', {
              handle,
              id: actor.id,
              workspace: actor.workspace,
            });
          }
        }
        becamePrimary = true;
      }

      // 账号级凭证：让这条 DID 以后登录时落到同一个账号，而不是新建一个。
      if (actor.accountId) await this.accounts?.attach(tx, actor.accountId, 'did', did);

      const row = await tx.one(
        `SELECT * FROM identities WHERE workspace = :workspace AND did = :did`,
        { workspace: actor.workspace, did },
      );
      return { identity: toIdentityView(row!), existing: false, primary: becamePrimary };
    });

    return {
      ...outcome.identity,
      existing: outcome.existing,
      primary: outcome.primary,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toIdentityView(row: Record<string, unknown>): IdentityView {
  return {
    id: String(row.id),
    did: String(row.did),
    // 目前只支持 e1 的单钥身份；回显时补全成完整引用，方便别的实现照着验。
    keyid: `${String(row.did)}#key-1`,
    fingerprint: row.fingerprint === null || row.fingerprint === undefined ? null : String(row.fingerprint),
    client: String(row.client),
    createdAt: String(row.created_at),
    lastLoginAt: row.last_login_at === null || row.last_login_at === undefined ? null : String(row.last_login_at),
    loginCount: Number(row.login_count ?? 0),
  };
}
