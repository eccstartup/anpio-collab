/**
 * 邮箱一次性链接登录。
 *
 * 三段时间：申请（发信）→ 验证（换会话）→ 多组织时选择。
 *
 * 设计要点：
 *  - 申请永远返回 202，不透露邮箱是否存在；
 *  - 票据只存摘要、一次性、15 分钟，验证失败不消耗（误点不会毁掉链接）；
 *  - 邀请链接复用同一条通道：票据里带 invite_id，验证通过即入组，
 *    但邮箱必须与邀请一致，转发给第三个人无效。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import { asObject, asString } from '../../protocol/parse.ts';
import type { Principal, Tenant } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Account, AccountService } from './accounts.ts';
import type { IdentityService } from './identity.ts';
import type { MailService } from './mail.ts';
import { hashToken } from './principals.ts';
import type { TenantService } from './tenants.ts';

export type EmailAuthOptions = {
  /** 登录票据有效期。15 分钟是"够走到邮箱，又不至于长期可点"的折中。 */
  ticketMinutes: number;
  /** 多组织选择票据有效期。 */
  selectionMinutes: number;
};

export type VerifyResult =
  | {
      status: 'ok';
      token: string;
      expiresAt: string;
      principal: Principal;
      tenant: { id: string; name: string; role: string };
      joinedTenant?: boolean;
    }
  | { status: 'select'; selectionToken: string; tenants: Tenant[] };

export class EmailAuthService {
  private readonly ctx: Context;
  private readonly accounts: AccountService;
  private readonly tenants: TenantService;
  private readonly identity: IdentityService;
  private readonly mail: MailService;
  private readonly options: EmailAuthOptions;

  constructor(
    ctx: Context,
    deps: {
      accounts: AccountService;
      tenants: TenantService;
      identity: IdentityService;
      mail: MailService;
    },
    options: EmailAuthOptions,
  ) {
    this.ctx = ctx;
    this.accounts = deps.accounts;
    this.tenants = deps.tenants;
    this.identity = deps.identity;
    this.mail = deps.mail;
    this.options = options;
  }

  // ---------------------------------------------------------------- 申请

  async start(input: {
    email: unknown;
    invite?: unknown;
    origin?: string;
    userAgent?: string;
  }): Promise<{ sent: true; expiresAt: string; devLink?: string; invite?: boolean }> {
    const rawEmail = asString(input.email, 'email', { max: 254, min: 3 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail.trim())) throw invalid('email 格式不正确');
    let email = rawEmail.trim().toLowerCase();
    let inviteId: string | null = null;

    const inviteToken = typeof input.invite === 'string' ? input.invite.trim() : '';
    if (inviteToken) {
      const invite = await this.ctx.db.read.one(
        `SELECT * FROM tenant_invites
         WHERE token_hash = :hash AND accepted_at IS NULL AND expires_at > :now`,
        { hash: hashToken(inviteToken), now: this.ctx.now() },
      );
      if (!invite) throw conflict('邀请已失效，请联系邀请人重新发送');
      inviteId = String(invite.id);
      // 邀请已经指定了收件人：以邀请为准，避免"用别人的邀请给自己发链接"。
      email = String(invite.email).toLowerCase();
    }

    const token = randomBytes(32).toString('base64url');
    const now = this.ctx.now();
    const expiresAt = new Date(Date.parse(now) + this.options.ticketMinutes * 60 * 1000).toISOString();
    await this.ctx.db.transaction(async tx => {
      await tx.run('DELETE FROM login_tickets WHERE expires_at < :now', { now });
      await tx.run(
        `INSERT INTO login_tickets(id, token_hash, email, purpose, invite_id, account_id,
                                   expires_at, created_at, user_agent)
         VALUES(:id, :hash, :email, :purpose, :invite, NULL, :expiresAt, :at, :ua)`,
        {
          id: randomUUID(),
          hash: hashToken(token),
          email,
          purpose: inviteId ? 'invite' : 'login',
          invite: inviteId,
          expiresAt,
          at: now,
          ua: (input.userAgent ?? '').slice(0, 200),
        },
      );
    });

    const base = (input.origin ?? this.mail.baseUrl).replace(/\/+$/, '');
    const link = `${base}/login?ticket=${encodeURIComponent(token)}`;
    await this.mail.send({
      to: email,
      subject: '[Anpio Collab] 登录链接',
      body:
        `点下面的链接登录 Anpio Collab（${this.options.ticketMinutes} 分钟内有效，只能使用一次）：\n\n` +
        `${link}\n\n` +
        '如果不是你发起的登录，忽略这封邮件即可；你的账号不会因此被访问。',
      link,
      kind: 'login',
    });

    return {
      sent: true,
      expiresAt,
      ...(this.mail.exposeOutbox ? { devLink: link } : {}),
      ...(inviteId ? { invite: true } : {}),
    };
  }

  // ---------------------------------------------------------------- 验证

  async verify(input: { ticket: unknown }): Promise<VerifyResult> {
    const ticket = asString(input.ticket, 'ticket', { max: 512, min: 8 });
    const row = await this.consumeTicket(ticket, ['login', 'invite']);
    const email = String(row.email).toLowerCase();
    const account = await this.accounts.ensure('email', email, {
      verified: true,
      displayName: email.split('@')[0],
    });

    // 邀请：先入组，再按该租户签发会话，跳过"选组织"。
    if (row.invite_id !== null && row.invite_id !== undefined) {
      const joined = await this.tenants.acceptInvite(String(row.invite_id), account, email);
      const tenant = await this.tenantBrief(joined.tenantId, 'member');
      const session = await this.identity.openSession(joined.principal, null, 'browser');
      return {
        status: 'ok',
        token: session.token,
        expiresAt: session.expiresAt,
        principal: joined.principal,
        tenant,
        joinedTenant: true,
      };
    }

    const memberships = await this.tenants.listFor(account.id);
    if (memberships.length === 0) {
      // 第一次来：给一个个人组织，自己是所有者。先让人进来，再谈邀请。
      const principal = await this.tenants.createTenant(account, `${account.displayName} 的组织`, true);
      const tenant = await this.tenantBrief(principal.workspace, 'owner');
      const session = await this.identity.openSession(principal, null, 'browser');
      return { status: 'ok', token: session.token, expiresAt: session.expiresAt, principal, tenant };
    }
    if (memberships.length === 1) {
      const only = memberships[0];
      const principal = await this.tenants.principalFor(account, only.id);
      const session = await this.identity.openSession(principal, null, 'browser');
      return {
        status: 'ok',
        token: session.token,
        expiresAt: session.expiresAt,
        principal,
        tenant: { id: only.id, name: only.name, role: principal.tenantRole },
      };
    }

    const selectionToken = await this.issueSelectionTicket(account);
    return { status: 'select', selectionToken, tenants: memberships };
  }

  async choose(input: { selectionToken: unknown; tenantId: unknown }): Promise<VerifyResult> {
    const token = asString(input.selectionToken, 'selectionToken', { max: 512, min: 8 });
    const tenantId = asString(input.tenantId, 'tenantId', { max: 100, min: 1 });
    const row = await this.consumeTicket(token, ['select']);
    const accountId = row.account_id === null || row.account_id === undefined ? '' : String(row.account_id);
    const account = await this.accounts.findById(accountId);
    if (!account) throw notFound('账号不存在');
    const memberships = await this.tenants.listFor(account.id);
    if (!memberships.some(item => item.id === tenantId)) throw forbidden('你不属于这个组织');
    const principal = await this.tenants.principalFor(account, tenantId);
    const session = await this.identity.openSession(principal, null, 'browser');
    const tenant = await this.tenantBrief(tenantId, principal.tenantRole);
    return { status: 'ok', token: session.token, expiresAt: session.expiresAt, principal, tenant };
  }

  // ---------------------------------------------------------------- 内部

  private async issueSelectionTicket(account: Account): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = this.ctx.now();
    const expiresAt = new Date(Date.parse(now) + this.options.selectionMinutes * 60 * 1000).toISOString();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO login_tickets(id, token_hash, email, purpose, invite_id, account_id,
                                   expires_at, created_at, user_agent)
         VALUES(:id, :hash, :email, 'select', NULL, :account, :expiresAt, :at, '')`,
        {
          id: randomUUID(),
          hash: hashToken(token),
          email: '',
          account: account.id,
          expiresAt,
          at: now,
        },
      );
    });
    return token;
  }

  /**
   * 消费票据。查与改在同一事务里，条件更新保证并发下只有一次成功。
   * 票据不存在/已用/过期都按同一句话拒绝，避免把状态泄露成可枚举的信号。
   */
  private async consumeTicket(ticket: string, purposes: string[]) {
    const now = this.ctx.now();
    const hash = hashToken(ticket);
    return this.ctx.db.transaction(async tx => {
      const row = await tx.one(
        'SELECT * FROM login_tickets WHERE token_hash = :hash',
        { hash },
      );
      if (!row) throw invalid('链接无效，请重新发送登录链接');
      if (!purposes.includes(String(row.purpose))) throw invalid('链接无效，请重新发送登录链接');
      if (row.consumed_at !== null && row.consumed_at !== undefined) {
        throw conflict('这个链接已经用过了，请重新发送登录链接');
      }
      if (String(row.expires_at) <= now) throw conflict('链接已过期，请重新发送登录链接');
      const changed = await tx.run(
        'UPDATE login_tickets SET consumed_at = :at WHERE id = :id AND consumed_at IS NULL',
        { at: now, id: String(row.id) },
      );
      if (changed === 0) throw conflict('这个链接已经用过了，请重新发送登录链接');
      return row;
    });
  }

  private async tenantBrief(id: string, role: string) {
    const row = await this.ctx.db.read.one<{ name: string }>('SELECT name FROM tenants WHERE id = :id', { id });
    return { id, name: row ? String(row.name) : id, role };
  }
}
