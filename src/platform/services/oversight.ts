/**
 * 监管与报警。
 *
 * 监管者要回答的问题不是"任务写到哪一步了"，而是**哪里不对**：
 * 谁卡住了、谁失联了、哪件事没人接、哪类操作在被反复拒绝。
 *
 * 设计约定：
 *  - 规则是**幂等**的：同一主体同一条规则只有一条告警，重复命中只累加次数；
 *  - 条件消失时自动解决（`resolved_by = auto`），条件重现时自动重开；
 *  - 人工解决的不会被扫描器立刻重开——人被叫醒过一次，不该被同一件事反复叫醒；
 *  - 扫描不改变任何业务状态：它只写 `alerts`。
 */

import { forbidden, notFound } from '../../protocol/errors.ts';
import type { Alert, AlertSeverity, Principal } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import { toPrincipal } from '../db/mappers.ts';
import { hasAnyRole } from './access.ts';
import { humanAge } from './collab.ts';

export type OversightThresholds = {
  /** 已接受但无进展多久算卡住（小时）。 */
  stalledSubtaskHours: number;
  /** 已提交但未核验多久算积压（小时）。 */
  unverifiedHours: number;
  /** 任务多久没有事件算停滞（小时）。 */
  stalledTaskHours: number;
  /** 待验收多久算积压（小时）。 */
  reviewBacklogHours: number;
  /** 心跳多久没上报算失联（分钟）。 */
  offlineMinutes: number;
  /** 智能体提案多久没人接管算积压（小时）。 */
  unadoptedHours: number;
  /** 一小时内被拒请求多少次算异常。 */
  deniedThreshold: number;
  /** 经验到期前多少天提醒。 */
  knowledgeExpiryDays: number;
  /** 提问与 @ 超过多少小时没人回应算积压。 */
  pendingMessageHours: number;
};

export const DEFAULT_THRESHOLDS: OversightThresholds = {
  stalledSubtaskHours: 24,
  unverifiedHours: 12,
  stalledTaskHours: 48,
  reviewBacklogHours: 24,
  offlineMinutes: 15,
  unadoptedHours: 12,
  deniedThreshold: 8,
  knowledgeExpiryDays: 3,
  pendingMessageHours: 4,
};

export type Finding = {
  rule: string;
  severity: AlertSeverity;
  subjectType: 'subtask' | 'task' | 'principal' | 'workspace' | 'knowledge' | 'message' | 'mention';
  subjectId: string;
  taskId: string | null;
  title: string;
  detail: string;
};

export type ScanResult = { opened: number; updated: number; resolved: number; total: number };

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, high: 1, normal: 2, low: 3 };

const hoursAgo = (now: string, hours: number): string =>
  new Date(Date.parse(now) - hours * 3_600_000).toISOString();
const minutesAgo = (now: string, minutes: number): string =>
  new Date(Date.parse(now) - minutes * 60_000).toISOString();
const daysAhead = (now: string, days: number): string =>
  new Date(Date.parse(now) + days * 86_400_000).toISOString();

function toAlert(row: Record<string, unknown>): Alert {
  return {
    id: String(row.id),
    rule: String(row.rule),
    severity: String(row.severity) as AlertSeverity,
    status: String(row.status) as Alert['status'],
    title: String(row.title),
    detail: String(row.detail),
    subjectType: String(row.subject_type),
    subjectId: String(row.subject_id),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    occurrences: Number(row.occurrences),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    acknowledgedBy: row.acknowledged_by === null ? null : String(row.acknowledged_by),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
  };
}

export class OversightService {
  private readonly ctx: Context;
  private readonly thresholds: OversightThresholds;

  constructor(ctx: Context, thresholds: Partial<OversightThresholds> = {}) {
    this.ctx = ctx;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  // ---------------------------------------------------------------- 规则

  private async collect(workspace: string): Promise<Finding[]> {
    const now = this.ctx.now();
    const findings: Finding[] = [];
    const t = this.thresholds;

    // 1. 子任务逾期：仍在等人动手的那些才算。
    const overdue = await this.ctx.db.read.all(
      `SELECT s.*, t.title AS task_title FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE t.workspace = :workspace AND s.status IN ('invited','accepted','returned')
         AND s.due_at < :now AND t.status IN ('pending','running')
       ORDER BY s.due_at`,
      { workspace, now },
    );
    for (const row of overdue) {
      findings.push({
        rule: 'subtask_overdue',
        severity: 'high',
        subjectType: 'subtask',
        subjectId: String(row.id),
        taskId: String(row.task_id),
        title: `子任务逾期：${String(row.kind)}（${String(row.agent_id)}）`,
        detail: `所属任务「${String(row.task_title)}」，截止 ${String(row.due_at)}，当前状态 ${String(row.status)}。`,
      });
    }

    // 2. 接单后长时间没有进展。
    const stalled = await this.ctx.db.read.all(
      `SELECT s.*, t.title AS task_title FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE t.workspace = :workspace AND s.status = 'accepted' AND s.updated_at < :before
       ORDER BY s.updated_at`,
      { workspace, before: hoursAgo(now, t.stalledSubtaskHours) },
    );
    for (const row of stalled) {
      findings.push({
        rule: 'subtask_stalled',
        severity: 'high',
        subjectType: 'subtask',
        subjectId: String(row.id),
        taskId: String(row.task_id),
        title: `子任务停滞：${String(row.kind)}（${String(row.agent_id)}）`,
        detail: `已接受但 ${humanAge(Date.parse(now) - Date.parse(String(row.updated_at)))} 没有更新，任务「${String(row.task_title)}」。`,
      });
    }

    // 3. 已提交待核验。
    const unverified = await this.ctx.db.read.all(
      `SELECT s.*, t.title AS task_title FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE t.workspace = :workspace AND s.status = 'submitted' AND s.updated_at < :before
       ORDER BY s.updated_at`,
      { workspace, before: hoursAgo(now, t.unverifiedHours) },
    );
    for (const row of unverified) {
      findings.push({
        rule: 'subtask_unverified',
        severity: 'normal',
        subjectType: 'subtask',
        subjectId: String(row.id),
        taskId: String(row.task_id),
        title: `结果待核验：${String(row.kind)}`,
        detail: `任务「${String(row.task_title)}」的结果已提交超过 ${t.unverifiedHours} 小时，仍未有人核验。`,
      });
    }

    // 4. 任务整体停滞。
    const stalledTasks = await this.ctx.db.read.all(
      `SELECT t.* FROM tasks t
       WHERE t.workspace = :workspace AND t.status = 'running' AND t.updated_at < :before`,
      { workspace, before: hoursAgo(now, t.stalledTaskHours) },
    );
    for (const row of stalledTasks) {
      findings.push({
        rule: 'task_stalled',
        severity: 'high',
        subjectType: 'task',
        subjectId: String(row.id),
        taskId: String(row.id),
        title: `任务停滞：${String(row.title)}`,
        detail: `已进行 ${humanAge(Date.parse(now) - Date.parse(String(row.updated_at)))} 没有任何事件。`,
      });
    }

    // 5. 待验收积压。
    const backlog = await this.ctx.db.read.all(
      `SELECT t.* FROM tasks t
       WHERE t.workspace = :workspace AND t.status = 'review' AND t.updated_at < :before`,
      { workspace, before: hoursAgo(now, t.reviewBacklogHours) },
    );
    for (const row of backlog) {
      findings.push({
        rule: 'review_backlog',
        severity: 'normal',
        subjectType: 'task',
        subjectId: String(row.id),
        taskId: String(row.id),
        title: `待验收积压：${String(row.title)}`,
        detail: `等待验收 ${humanAge(Date.parse(now) - Date.parse(String(row.updated_at)))}，负责人 ${String(row.owner_id)}。`,
      });
    }

    // 6. 有活没干完却已失联的智能体。
    const agents = await this.ctx.db.read.all(
      `SELECT p.id, p.display_name, a.last_seen_at,
              (SELECT COUNT(*) FROM subtasks s JOIN tasks t2 ON t2.id = s.task_id
               WHERE s.agent_id = p.id AND s.status IN ('invited','accepted','returned')
                 AND t2.status IN ('pending','running')) AS open_count
       FROM principals p LEFT JOIN agent_presence a ON a.principal_id = p.id
       WHERE p.workspace = :workspace AND p.kind = 'agent' AND p.active = 1`,
      { workspace },
    );
    for (const row of agents) {
      if (Number(row.open_count) === 0) continue;
      const seen = row.last_seen_at === null || row.last_seen_at === undefined ? null : String(row.last_seen_at);
      const silent = seen === null ? null : Math.round((Date.parse(now) - Date.parse(seen)) / 1000);
      if (silent !== null && silent < t.offlineMinutes * 60) continue;
      findings.push({
        rule: 'agent_offline',
        severity: 'high',
        subjectType: 'principal',
        subjectId: String(row.id),
        taskId: null,
        title: `智能体失联：${String(row.display_name)}`,
        detail:
          seen === null
            ? `有 ${Number(row.open_count)} 个未完成子任务，但从未上报心跳。`
            : `有 ${Number(row.open_count)} 个未完成子任务，最近一次心跳在 ${humanAge(silent! * 1000)} 前。`,
      });
    }

    // 7. 智能体发起的提案没人接管。
    const unadopted = await this.ctx.db.read.all(
      `SELECT t.* FROM tasks t
       WHERE t.workspace = :workspace AND t.origin = 'agent' AND t.adopted_at IS NULL
         AND t.status IN ('pending','running') AND t.created_at < :before`,
      { workspace, before: hoursAgo(now, t.unadoptedHours) },
    );
    for (const row of unadopted) {
      findings.push({
        rule: 'agent_task_unadopted',
        severity: 'normal',
        subjectType: 'task',
        subjectId: String(row.id),
        taskId: String(row.id),
        title: `智能体提案无人接管：${String(row.title)}`,
        detail: `由 ${String(row.origin_principal_id ?? row.owner_id)} 发起，已放置 ${t.unadoptedHours} 小时。`,
      });
    }

    // 8. 一小时内的拒绝请求激增。
    const denied = await this.ctx.db.read.one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM audit
       WHERE workspace = :workspace AND outcome LIKE 'denied:%' AND recorded_at > :before`,
      { workspace, before: hoursAgo(now, 1) },
    );
    const deniedCount = Number(denied?.count ?? 0);
    if (deniedCount >= t.deniedThreshold) {
      findings.push({
        rule: 'denied_spike',
        severity: 'high',
        subjectType: 'workspace',
        subjectId: workspace,
        taskId: null,
        title: `越权请求激增：近一小时 ${deniedCount} 次被拒`,
        detail: '可能是权限配置有误，也可能是凭据被滥用。请对照审计逐条核对。',
      });
    }

    // 9. 经验即将过期。
    const expiring = await this.ctx.db.read.all(
      `SELECT k.* FROM knowledge k
       WHERE k.workspace = :workspace AND k.state = 'published'
         AND k.expires_at IS NOT NULL AND k.expires_at > :now AND k.expires_at < :before`,
      { workspace, now, before: daysAhead(now, t.knowledgeExpiryDays) },
    );
    for (const row of expiring) {
      findings.push({
        rule: 'knowledge_expiring',
        severity: 'low',
        subjectType: 'knowledge',
        subjectId: String(row.id),
        taskId: String(row.task_id),
        title: `经验即将过期：${String(row.content).slice(0, 40)}`,
        detail: `有效期至 ${String(row.expires_at)}。过期后不再出现在检索结果里，需要复审或修订。`,
      });
    }

    // 10. 提问长时间没有回答。线程已解决的不再追问。
    const questions = await this.ctx.db.read.all(
      `SELECT c.*, t.title AS task_title FROM task_comments c JOIN tasks t ON t.id = c.task_id
       WHERE t.workspace = :workspace AND c.kind = 'question' AND c.created_at < :before
         AND NOT EXISTS (
           SELECT 1 FROM task_comments a WHERE a.task_id = c.task_id AND a.reply_to = c.id)
         AND NOT EXISTS (
           SELECT 1 FROM task_threads th WHERE th.id = c.thread_id AND th.status = 'resolved')
       ORDER BY c.created_at`,
      { workspace, before: hoursAgo(now, t.pendingMessageHours) },
    );
    for (const row of questions) {
      findings.push({
        rule: 'question_unanswered',
        severity: 'normal',
        subjectType: 'message',
        subjectId: String(row.id),
        taskId: String(row.task_id),
        title: `提问无人回答：${String(row.body).slice(0, 60)}`,
        detail: `任务「${String(row.task_title)}」，由 ${String(row.author_id)} 提出已超过 ${t.pendingMessageHours} 小时。`,
      });
    }

    // 11. @ 提醒长时间未读。
    const mentions = await this.ctx.db.read.all(
      `SELECT m.*, c.body, c.kind, t.title AS task_title
       FROM task_mentions m
       JOIN task_comments c ON c.id = m.comment_id
       JOIN tasks t ON t.id = m.task_id
       WHERE t.workspace = :workspace AND m.read_at IS NULL AND m.created_at < :before
       ORDER BY m.created_at`,
      { workspace, before: hoursAgo(now, t.pendingMessageHours) },
    );
    for (const row of mentions) {
      findings.push({
        rule: 'mention_unread',
        severity: 'low',
        subjectType: 'mention',
        subjectId: String(row.id),
        taskId: String(row.task_id),
        title: `@ 提醒未读：${String(row.body).slice(0, 60)}`,
        detail: `任务「${String(row.task_title)}」，收件人 ${String(row.recipient_id)} 超过 ${t.pendingMessageHours} 小时未读。`,
      });
    }

    return findings;
  }

  // ---------------------------------------------------------------- 扫描

  /**
   * 把当前条件同步成告警。
   *
   * 不做"删了重建"：告警的 `firstSeenAt` 与确认人是有价值的信息，
   * 重建会把"这件事已经被人看过"抹掉。
   */
  /** 带授权的扫描入口：只有监管者与管理员能主动触发。 */
  async scanFor(actor: Principal): Promise<ScanResult> {
    this.assertSupervisor(actor);
    return this.scan(actor.workspace);
  }

  /** 无主体的扫描：供调度器与运维脚本使用，不经过 HTTP。 */
  async scan(workspace: string): Promise<ScanResult> {
    const now = this.ctx.now();
    const findings = await this.collect(workspace);
    const current = await this.ctx.db.read.all(
      'SELECT * FROM alerts WHERE workspace = :workspace',
      { workspace },
    );
    const byKey = new Map(
      current.map(row => [`${String(row.rule)}|${String(row.subject_type)}|${String(row.subject_id)}`, row]),
    );

    let opened = 0;
    let updated = 0;
    let resolved = 0;
    const seen = new Set<string>();

    await this.ctx.db.transaction(async tx => {
      for (const finding of findings) {
        const key = `${finding.rule}|${finding.subjectType}|${finding.subjectId}`;
        seen.add(key);
        const existing = byKey.get(key);
        if (!existing) {
          await tx.run(
            `INSERT INTO alerts(id, workspace, rule, subject_type, subject_id, task_id, severity, status,
                                title, detail, occurrences, first_seen_at, last_seen_at,
                                acknowledged_by, acknowledged_at, resolved_at, resolved_by)
             VALUES(:id, :workspace, :rule, :subjectType, :subjectId, :taskId, :severity, 'open',
                    :title, :detail, 1, :at, :at, NULL, NULL, NULL, NULL)`,
            {
              id: this.ctx.newId(),
              workspace,
              rule: finding.rule,
              subjectType: finding.subjectType,
              subjectId: finding.subjectId,
              taskId: finding.taskId,
              severity: finding.severity,
              title: finding.title,
              detail: finding.detail,
              at: now,
            },
          );
          opened += 1;
          continue;
        }

        if (String(existing.status) === 'resolved' && String(existing.resolved_by ?? '') === 'manual') {
          // 人工解决过：保持结论，只更新最后观测时间。
          await tx.run('UPDATE alerts SET last_seen_at = :at WHERE id = :id', { at: now, id: String(existing.id) });
          continue;
        }

        const reopened = String(existing.status) === 'resolved';
        await tx.run(
          `UPDATE alerts SET status = 'open', severity = :severity, title = :title, detail = :detail,
             occurrences = occurrences + 1, last_seen_at = :at,
             resolved_at = NULL, resolved_by = NULL
           WHERE id = :id`,
          {
            severity: finding.severity,
            title: finding.title,
            detail: finding.detail,
            at: now,
            id: String(existing.id),
          },
        );
        if (reopened) opened += 1;
        else updated += 1;
      }

      for (const [key, row] of byKey) {
        if (seen.has(key)) continue;
        if (String(row.status) === 'resolved') continue;
        await tx.run(
          `UPDATE alerts SET status = 'resolved', resolved_at = :at, resolved_by = 'auto'
           WHERE id = :id`,
          { at: now, id: String(row.id) },
        );
        resolved += 1;
      }
    });

    return { opened, updated, resolved, total: findings.length };
  }

  // ---------------------------------------------------------------- 读

  async list(actor: Principal): Promise<Alert[]> {
    this.assertSupervisor(actor);
    const rows = await this.ctx.db.read.all(
      `SELECT * FROM alerts WHERE workspace = :workspace AND status <> 'resolved'
       ORDER BY last_seen_at DESC LIMIT 200`,
      { workspace: actor.workspace },
    );
    return rows
      .map(toAlert)
      .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
  }

  /** 监管总览：告警 + 计数 + 风险任务 + 待批准主体。 */
  async overview(actor: Principal) {
    this.assertSupervisor(actor);
    const workspace = actor.workspace;
    const now = this.ctx.now();

    const counts = await this.ctx.db.read.one<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM tasks WHERE workspace = :workspace AND status IN ('pending','running','review')) AS open_tasks,
         (SELECT COUNT(*) FROM tasks WHERE workspace = :workspace AND status = 'review') AS in_review,
         (SELECT COUNT(*) FROM subtasks s JOIN tasks t ON t.id = s.task_id
          WHERE t.workspace = :workspace AND s.status IN ('invited','accepted','returned') AND s.due_at < :now) AS overdue_subtasks,
         (SELECT COUNT(*) FROM subtasks s JOIN tasks t ON t.id = s.task_id
          WHERE t.workspace = :workspace AND s.status IN ('invited','accepted')) AS active_subtasks,
         (SELECT COUNT(*) FROM principals WHERE workspace = :workspace AND active = 0) AS pending_principals,
         (SELECT COUNT(*) FROM alerts WHERE workspace = :workspace AND status <> 'resolved') AS open_alerts`,
      { workspace, now },
    );

    const alerts = await this.list(actor);
    const bySeverity = { critical: 0, high: 0, normal: 0, low: 0 } as Record<AlertSeverity, number>;
    for (const alert of alerts) bySeverity[alert.severity] += 1;

    const riskRows = await this.ctx.db.read.all(
      `SELECT t.id, t.title, t.status, t.owner_id, t.updated_at, t.due_at, t.origin, t.adopted_at,
              (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status IN ('invited','accepted','returned') AND s.due_at < :now) AS overdue,
              (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status IN ('invited','accepted')) AS active
       FROM tasks t
       WHERE t.workspace = :workspace AND t.status IN ('pending','running','review')
       ORDER BY t.due_at LIMIT 100`,
      { workspace, now },
    );
    const riskyTasks = riskRows
      .map(row => ({
        id: String(row.id),
        title: String(row.title),
        status: String(row.status),
        ownerId: String(row.owner_id),
        dueAt: String(row.due_at),
        updatedAt: String(row.updated_at),
        origin: String(row.origin),
        adopted: row.adopted_at !== null,
        overdueSubtasks: Number(row.overdue),
        activeSubtasks: Number(row.active),
        staleHours: Math.round((Date.parse(now) - Date.parse(String(row.updated_at))) / 3_600_000),
      }))
      .filter(item => item.overdueSubtasks > 0 || item.staleHours >= this.thresholds.stalledTaskHours || item.dueAt < now)
      .sort((left, right) => right.overdueSubtasks - left.overdueSubtasks || right.staleHours - left.staleHours);

    const pendingRows = await this.ctx.db.read.all(
      `SELECT * FROM principals WHERE workspace = :workspace AND active = 0 ORDER BY created_at DESC LIMIT 50`,
      { workspace },
    );

    return {
      generatedAt: now,
      thresholds: this.thresholds,
      counts: {
        openTasks: Number(counts?.open_tasks ?? 0),
        inReview: Number(counts?.in_review ?? 0),
        overdueSubtasks: Number(counts?.overdue_subtasks ?? 0),
        activeSubtasks: Number(counts?.active_subtasks ?? 0),
        pendingPrincipals: Number(counts?.pending_principals ?? 0),
        openAlerts: alerts.length,
      },
      bySeverity,
      alerts,
      riskyTasks,
      pendingPrincipals: pendingRows.map(toPrincipal),
    };
  }

  async acknowledge(actor: Principal, alertId: string): Promise<Alert> {
    this.assertSupervisor(actor);
    const at = this.ctx.now();
    // 结果必须在事务内构造：事务未提交时，只读连接看不到刚写的行，
    // 读回来会得到"还是 open"的旧值。
    return this.ctx.db.transaction(async tx => {
      const row = await tx.one('SELECT * FROM alerts WHERE id = :id AND workspace = :workspace', {
        id: alertId,
        workspace: actor.workspace,
      });
      if (!row) throw notFound('告警不存在');
      if (String(row.status) === 'open') {
        await tx.run(
          `UPDATE alerts SET status = 'acknowledged', acknowledged_by = :actor, acknowledged_at = :at
           WHERE id = :id AND status = 'open'`,
          { actor: actor.id, at, id: alertId },
        );
        return toAlert({ ...row, status: 'acknowledged', acknowledged_by: actor.id, acknowledged_at: at });
      }
      return toAlert(row);
    });
  }

  async resolve(actor: Principal, alertId: string): Promise<Alert> {
    this.assertSupervisor(actor);
    const at = this.ctx.now();
    return this.ctx.db.transaction(async tx => {
      const row = await tx.one('SELECT * FROM alerts WHERE id = :id AND workspace = :workspace', {
        id: alertId,
        workspace: actor.workspace,
      });
      if (!row) throw notFound('告警不存在');
      await tx.run(
        `UPDATE alerts SET status = 'resolved', resolved_at = :at, resolved_by = 'manual',
           acknowledged_by = COALESCE(acknowledged_by, :actor)
         WHERE id = :id`,
        { at, actor: actor.id, id: alertId },
      );
      return toAlert({
        ...row,
        status: 'resolved',
        resolved_at: at,
        resolved_by: 'manual',
        acknowledged_by: row.acknowledged_by ?? actor.id,
      });
    });
  }

  private assertSupervisor(actor: Principal): void {
    if (!hasAnyRole(actor, 'admin', 'supervisor')) {
      throw forbidden('需要监管者或管理员角色');
    }
  }
}
