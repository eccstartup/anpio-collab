/**
 * 邮箱一次性链接登录。
 *
 * 三段时间：申请（发信）→ 验证（换会话）→ 多组织时选择。
 *
 * 设计要点：
 *  - 申请永远返回 202，不透露邮箱是否存在；
 *  - 票据只存摘要、一次性、15 分钟，验证失败不消耗（误点不会毁掉链接）；
 *  - 邀请链接复用同一条通道：票据里带 invite_id，验证通过即入组，
 *    但邮箱必须与邀请一致，转发给第三个人无效；
 *  - 补绑邮箱也走这条通道（purpose=bind_email + account_id）：DID 先登录的人
 *    可以反过来把邮箱挂到账号上，验证只确认地址归属，不换发会话。
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
  | { status: 'select'; selectionToken: string; tenants: Tenant[] }
  /** 补绑邮箱的链接被点开：只登记凭证，不签发会话。 */
  | { status: 'bound'; email: string };

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

  // ---------------------------------------------------------------- 补绑邮箱

  /**
   * 已登录的人补绑邮箱：钱包先登录、再反过来把邮箱挂到账号上。
   *
   * 与登录共用同一条通道——发一封带票据的信，点开才算数。直接把用户填的邮箱
   * 写进账号，等于允许任何人把别人的邮箱挂到自己名下，之后就能用它登录。
   * 票据里记着 account_id：链接只能确认这个地址，不能换来另一个会话。
   */
  async startBind(input: {
    accountId: string;
    email: unknown;
    origin?: string;
    userAgent?: string;
  }): Promise<{ sent: true; email: string; expiresAt: string; devLink?: string }> {
    const rawEmail = asString(input.email, 'email', { max: 254, min: 3 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail.trim())) throw invalid('email 格式不正确');
    const email = rawEmail.trim().toLowerCase();
    if (!input.accountId) throw conflict('当前主体还没有账号，无法绑定邮箱');

    // 先查冲突，别让人白点一封注定失败的邮件。
    const owner = await this.accounts.findByLink('email', email);
    if (owner && owner.id !== input.accountId) throw conflict('这个邮箱已经绑定在另一个账号上');
    if (owner) throw conflict('这个邮箱已经绑定在本账号上了');

    const token = randomBytes(32).toString('base64url');
    const now = this.ctx.now();
    const expiresAt = new Date(Date.parse(now) + this.options.ticketMinutes * 60 * 1000).toISOString();
    await this.ctx.db.transaction(async tx => {
      await tx.run('DELETE FROM login_tickets WHERE expires_at < :now', { now });
      await tx.run(
        `INSERT INTO login_tickets(id, token_hash, email, purpose, invite_id, account_id,
                                   expires_at, created_at, user_agent)
         VALUES(:id, :hash, :email, 'bind_email', NULL, :account, :expiresAt, :at, :ua)`,
        {
          id: randomUUID(),
          hash: hashToken(token),
          email,
          account: input.accountId,
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
      subject: '[Anpio Collab] 绑定邮箱',
      body:
        `点下面的链接把这个邮箱绑定到你的账号（${this.options.ticketMinutes} 分钟内有效，只能使用一次）：\n\n` +
        `${link}\n\n` +
        '绑定后可以用这个邮箱登录，进入的是同一个账号。不是你发起的就忽略这封邮件。',
      link,
      kind: 'bind',
    });

    return {
      sent: true,
      email,
      expiresAt,
      ...(this.mail.exposeOutbox ? { devLink: link } : {}),
    };
  }

  // ---------------------------------------------------------------- 验证

  async verify(input: { ticket: unknown }): Promise<VerifyResult> {
    const ticket = asString(input.ticket, 'ticket', { max: 512, min: 8 });
    const row = await this.consumeTicket(ticket, ['login', 'invite', 'bind_email']);
    const email = String(row.email).toLowerCase();

    // 补绑邮箱：票据只证明"这个地址归你"，会话保持不变。
    if (String(row.purpose) === 'bind_email') {
      const accountId = row.account_id === null || row.account_id === undefined ? '' : String(row.account_id);
      const account = await this.accounts.findById(accountId);
      if (!account) throw notFound('账号不存在');
      const owner = await this.accounts.findByLink('email', email);
      if (owner && owner.id !== account.id) throw conflict('这个邮箱已经绑定在另一个账号上');
      if (!owner) {
        await this.ctx.db.transaction(async tx => {
          await this.accounts.attach(tx, account.id, 'email', email);
        });
      }
      return { status: 'bound', email };
    }

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
