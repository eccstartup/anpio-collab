/**
 * 访问审计。
 *
 * 只记录"谁在何时对哪个路径做了什么、结果如何"，不记录请求正文和令牌。
 * 本地实现的审计不具备防篡改能力，不能替代企业的集中审计与留存策略。
 */

import { forbidden } from '../../protocol/errors.ts';
import type { Principal } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';
import { hasAnyRole } from './access.ts';

export type AuditEntry = {
  seq: number;
  principalId: string;
  action: string;
  outcome: string;
  recordedAt: string;
};

export type AuditActor = { id: string; workspace: string };

export class AuditService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 在业务事务内记录，保证"操作成功"与"有审计"一致。 */
  async recordIn(tx: Queryable, actor: AuditActor, action: string, outcome: string): Promise<void> {
    await tx.run(
      `INSERT INTO audit(workspace, principal_id, action, outcome, recorded_at)
       VALUES(:workspace, :principal, :action, :outcome, :at)`,
      { workspace: actor.workspace, principal: actor.id, action, outcome, at: this.ctx.now() },
    );
  }

  /** 独立记录：用于业务事务已回滚后的拒绝、读取操作与重放。 */
  async record(actor: AuditActor, action: string, outcome: string): Promise<void> {
    await this.ctx.db.transaction(async tx => {
      await this.recordIn(tx, actor, action, outcome);
    });
  }

  async list(actor: Principal, limit = 200): Promise<AuditEntry[]> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以查看审计');
    const rows = await this.ctx.db.read.all(
      `SELECT seq, principal_id, action, outcome, recorded_at
       FROM audit WHERE workspace = :workspace ORDER BY seq DESC LIMIT :limit`,
      { workspace: actor.workspace, limit },
    );
    return rows.map(row => ({
      seq: Number(row.seq),
      principalId: String(row.principal_id),
      action: String(row.action),
      outcome: String(row.outcome),
      recordedAt: String(row.recorded_at),
    }));
  }
}
