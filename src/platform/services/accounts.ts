/**
 * 全局账号。
 *
 * 账号回答"这是谁"，不回答"他能做什么"。前者跨租户稳定，后者由主体在
 * 某个租户里的角色决定。把两者拆开，同一个人加入第二个组织时不需要第二套登录。
 *
 * 一个账号可以有多个凭证：邮箱用于人，DID 用于人或智能体。凭证本身不带权限，
 * 只用于把登录结果映射到账号。
 */

import { randomUUID } from 'node:crypto';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';

export type AccountLinkKind = 'email' | 'did';

export type Account = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
};

export type AccountLink = {
  accountId: string;
  kind: AccountLinkKind;
  value: string;
  verifiedAt: string | null;
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const normalizeDid = (did: string): string => did.trim();

const normalizeValue = (kind: AccountLinkKind, value: string): string =>
  kind === 'email' ? normalizeEmail(value) : normalizeDid(value);

export class AccountService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async findById(id: string): Promise<Account | null> {
    const row = await this.ctx.db.read.one('SELECT * FROM accounts WHERE id = :id', { id });
    return row ? this.toAccount(row) : null;
  }

  async findByLink(kind: AccountLinkKind, value: string): Promise<Account | null> {
    const row = await this.ctx.db.read.one(
      `SELECT a.* FROM account_links l JOIN accounts a ON a.id = l.account_id
       WHERE l.kind = :kind AND l.value = :value`,
      { kind, value: normalizeValue(kind, value) },
    );
    return row ? this.toAccount(row) : null;
  }

  /** 账号下所有已登记凭证，用于"我有哪些登录方式"。 */
  async links(accountId: string): Promise<AccountLink[]> {
    const rows = await this.ctx.db.read.all(
      'SELECT account_id, kind, value, verified_at FROM account_links WHERE account_id = :id ORDER BY created_at',
      { id: accountId },
    );
    return rows.map(row => ({
      accountId: String(row.account_id),
      kind: String(row.kind) === 'did' ? 'did' : 'email',
      value: String(row.value),
      verifiedAt: row.verified_at === null ? null : String(row.verified_at),
    }));
  }

  /**
   * 找到或创建一个账号，并把凭证挂上去。
   *
   * `verified` 只在"刚刚证明了邮箱/私钥"时传 true；从邀请或后台补建时传 false，
   * 免得把没证明过的地址记成已验证。
   */
  async ensure(
    kind: AccountLinkKind,
    value: string,
    options: { displayName?: string; verified?: boolean } = {},
  ): Promise<Account> {
    const normalized = normalizeValue(kind, value);
    const existing = await this.findByLink(kind, normalized);
    if (existing) {
      if (options.verified) await this.markVerified(existing.id, kind, normalized);
      return existing;
    }
    const now = this.ctx.now();
    const account: Account = {
      id: `acc_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      displayName: options.displayName ?? defaultDisplayName(kind, normalized),
      status: 'active',
      createdAt: now,
    };
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        'INSERT INTO accounts(id, display_name, status, created_at) VALUES(:id, :name, :status, :at)',
        { id: account.id, name: account.displayName, status: account.status, at: now },
      );
      await tx.run(
        `INSERT INTO account_links(id, account_id, kind, value, verified_at, created_at)
         VALUES(:id, :account, :kind, :value, :verifiedAt, :at)`,
        {
          id: randomUUID(),
          account: account.id,
          kind,
          value: normalized,
          verifiedAt: options.verified ? now : null,
          at: now,
        },
      );
    });
    return account;
  }

  async markVerified(accountId: string, kind: AccountLinkKind, value: string): Promise<void> {
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE account_links SET verified_at = COALESCE(verified_at, :at)
         WHERE account_id = :account AND kind = :kind AND value = :value`,
        { at: this.ctx.now(), account: accountId, kind, value: normalizeValue(kind, value) },
      );
    });
  }

  /** 把一条凭证挂到已有账号（例如一个人第二个邮箱、或一个 Agent 的 DID）。 */
  async attach(tx: Queryable, accountId: string, kind: AccountLinkKind, value: string): Promise<void> {
    const normalized = normalizeValue(kind, value);
    const taken = await tx.one('SELECT account_id FROM account_links WHERE kind = :kind AND value = :value', {
      kind,
      value: normalized,
    });
    if (taken) return;
    await tx.run(
      `INSERT INTO account_links(id, account_id, kind, value, verified_at, created_at)
       VALUES(:id, :account, :kind, :value, :at, :at)`,
      { id: randomUUID(), account: accountId, kind, value: normalized, at: this.ctx.now() },
    );
  }

  private toAccount(row: Record<string, unknown>): Account {
    return {
      id: String(row.id),
      displayName: String(row.display_name ?? ''),
      status: String(row.status ?? 'active'),
      createdAt: String(row.created_at),
    };
  }
}

function defaultDisplayName(kind: AccountLinkKind, value: string): string {
  if (kind === 'email') return value.split('@')[0] ?? value;
  const tail = value.split(':').pop() ?? value;
  return tail.length > 12 ? tail.slice(-12) : tail;
}
