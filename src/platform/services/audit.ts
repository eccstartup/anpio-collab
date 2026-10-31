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

export type AuditReport = {
  days: number;
  since: string;
  generatedAt: string;
  totals: { entries: number; denied: number; byOutcome: Record<string, number> };
  byAction: { action: string; total: number; denied: number }[];
  byDay: { day: string; total: number; denied: number }[];
  topPrincipals: { principalId: string; total: number }[];
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

  /** 按动作、结果、日期与主体聚合最近 N 天的审计；只做统计，不改数据。 */
  async report(actor: Principal, days = 7): Promise<AuditReport> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以查看审计');
    const generatedAt = this.ctx.now();
    const since = new Date(Date.parse(generatedAt) - days * 86_400_000).toISOString();
    const rows = await this.ctx.db.read.all(
      `SELECT action, outcome, principal_id, substr(recorded_at, 1, 10) AS day, COUNT(*) AS count
       FROM audit
       WHERE workspace = :workspace AND recorded_at >= :since
       GROUP BY action, outcome, principal_id, substr(recorded_at, 1, 10)`,
      { workspace: actor.workspace, since },
    );

    const totals = { entries: 0, denied: 0, byOutcome: {} as Record<string, number> };
    const actions = new Map<string, { total: number; denied: number }>();
    const daysMap = new Map<string, { total: number; denied: number }>();
    const principals = new Map<string, number>();
    for (const row of rows) {
      const count = Number(row.count);
      const action = String(row.action);
      const outcome = String(row.outcome);
      const day = String(row.day);
      const principalId = String(row.principal_id);
      const denied = outcome.startsWith('denied') ? count : 0;
      totals.entries += count;
      totals.denied += denied;
      totals.byOutcome[outcome] = (totals.byOutcome[outcome] ?? 0) + count;
      const actionRow = actions.get(action) ?? { total: 0, denied: 0 };
      actionRow.total += count;
      actionRow.denied += denied;
      actions.set(action, actionRow);
      const dayRow = daysMap.get(day) ?? { total: 0, denied: 0 };
      dayRow.total += count;
      dayRow.denied += denied;
      daysMap.set(day, dayRow);
      principals.set(principalId, (principals.get(principalId) ?? 0) + count);
    }

    return {
      days,
      since,
      generatedAt,
      totals,
      byAction: [...actions.entries()]
        .map(([action, value]) => ({ action, ...value }))
        .sort((a, b) => b.total - a.total || a.action.localeCompare(b.action)),
      byDay: [...daysMap.entries()]
        .map(([day, value]) => ({ day, ...value }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      topPrincipals: [...principals.entries()]
        .map(([principalId, total]) => ({ principalId, total }))
        .sort((a, b) => b.total - a.total || a.principalId.localeCompare(b.principalId))
        .slice(0, 20),
    };
  }
}
