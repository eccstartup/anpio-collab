/**
 * 邮件投递。
 *
 * 本地只做两件事：写进 `mail_outbox`（可查、可测），以及在控制台打印。
 * 生产把 `deliver()` 换成 SMTP/邮件服务即可，调用方不需要改。
 *
 * 邮件只承载链接，不承载权限：链接被转发不会泄露任务内容，点的仍然要过
 * 邮箱或会话验证。
 */

import { randomUUID } from 'node:crypto';
import type { Context } from '../context.ts';

export type MailMode = 'outbox' | 'console';

export type MailInput = {
  to: string;
  subject: string;
  body: string;
  link?: string;
  kind: 'login' | 'invite' | 'agent-approval';
};

export type MailRecord = MailInput & {
  id: string;
  createdAt: string;
};

export type MailOptions = {
  mode: MailMode;
  /** 拼链接用；本地默认 127.0.0.1。 */
  baseUrl: string;
  /** 开发模式：允许接口把最近邮件读出来，方便本机演示。生产必须关。 */
  exposeOutbox: boolean;
};

export class MailService {
  private readonly ctx: Context;
  private readonly options: MailOptions;

  constructor(ctx: Context, options: MailOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  get exposeOutbox(): boolean {
    return this.options.exposeOutbox;
  }

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  link(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async send(input: MailInput): Promise<MailRecord> {
    const record: MailRecord = {
      ...input,
      to: input.to.trim().toLowerCase(),
      link: input.link ?? '',
      id: randomUUID(),
      createdAt: this.ctx.now(),
    };
    if (this.options.mode === 'console') {
      console.log(
        `\n[mail:${record.kind}] → ${record.to}\n${record.subject}\n${record.body}\n` +
          (record.link ? `${record.link}\n` : ''),
      );
    }
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO mail_outbox(id, to_email, subject, body, link, kind, created_at)
         VALUES(:id, :to, :subject, :body, :link, :kind, :at)`,
        {
          id: record.id,
          to: record.to,
          subject: record.subject,
          body: record.body,
          link: record.link,
          kind: record.kind,
          at: record.createdAt,
        },
      );
    });
    return record;
  }

  /** 开发模式专用：最近发给某个地址的邮件。 */
  async recent(to: string, limit = 10): Promise<MailRecord[]> {
    const rows = await this.ctx.db.read.all(
      `SELECT * FROM mail_outbox WHERE to_email = :to ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(50, limit))}`,
      { to: to.trim().toLowerCase() },
    );
    return rows.map(row => ({
      id: String(row.id),
      to: String(row.to_email),
      subject: String(row.subject),
      body: String(row.body),
      link: String(row.link),
      kind: String(row.kind) as MailRecord['kind'],
      createdAt: String(row.created_at),
    }));
  }
}
