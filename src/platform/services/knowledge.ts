/**
 * 知识服务：候选 → 审核 → 发布 → 引用 → 修订 / 撤销。
 *
 * 平台区分事实、任务成果、经验和业务规则。这里只处理"经验"：
 * 它必须来自一个已验收的任务，必须有人审核，必须有适用条件和有效期，
 * 不能被智能体自动升级成强制规则，也不会自动进入模型训练。
 */

import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import type { Knowledge, Principal } from '../../protocol/types.ts';
import { asObject, asString, asStringArray, asTimestamp } from '../../protocol/parse.ts';
import type { Context } from '../context.ts';
import { toKnowledge } from '../db/mappers.ts';
import { assertOwner, hasAnyRole, readTask, requireAgentScope } from './access.ts';
import { appendEvent } from './events.ts';

export type KnowledgeAudience = 'workspace' | string[];

export type RankedKnowledge = {
  id: string;
  version: number;
  content: string;
  conditions: string;
  reviewerId: string | null;
  expiresAt: string;
  sourceTaskId: string;
  reference: string;
  score: number;
  contentTruncated: boolean;
};

/** 目标团队是否被分享过这条知识；目标租户必须是正常团队。 */
async function hasShareTo(ctx: Context, workspace: string, knowledgeId: string): Promise<boolean> {
  const row = await ctx.db.read.one(
    `SELECT 1 AS present FROM knowledge_shares s
     JOIN tenants t ON t.id = s.team_workspace
     WHERE s.knowledge_id = :id AND s.team_workspace = :workspace
       AND t.status = 'active' AND t.personal = 0`,
    { id: knowledgeId, workspace },
  );
  return Boolean(row);
}

/** 判断主体能否读取某条知识。跨空间只看分享，同空间沿用范围/授权规则。 */
export async function canViewKnowledge(
  ctx: Context,
  principal: Principal,
  item: Knowledge,
): Promise<boolean> {
  // 管理员/审核人的放行只能用于自己所在的空间，不能成为跨租户后门。
  if (item.workspace !== principal.workspace) {
    return hasShareTo(ctx, principal.workspace, item.id);
  }
  if (hasAnyRole(principal, 'admin', 'reviewer')) return true;
  if (item.state === 'candidate') return item.authorId === principal.id;
  if (item.accessMode === 'workspace') return true;
  const grant = await ctx.db.read.one(
    'SELECT 1 AS present FROM knowledge_grants WHERE knowledge_id = :id AND principal_id = :principal',
    { id: item.id, principal: principal.id },
  );
  return Boolean(grant);
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** 把查询切成拉丁词与中文字二元组，避免对中文分词器产生硬依赖。 */
function terms(query: string): string[] {
  const normalized = normalize(query.trim());
  if (!normalized) return [];
  const result = new Set(normalized.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) result.add(run.slice(index, index + 2));
  }
  return [...result];
}

/**
 * 词法排序基线（不使用向量）。评分只看内容与适用条件的命中，
 * 相似度不是事实置信度，调用方仍需自行核对来源与时效。
 */
export function rankKnowledge(
  rows: Knowledge[],
  query: string,
  limit: number,
  budgetChars: number,
): { items: RankedKnowledge[]; truncated: boolean; usedChars: number } {
  const query_ = normalize(query.trim());
  const list = terms(query);
  const scored = rows
    .map(row => {
      const content = normalize(row.content);
      const conditions = normalize(row.conditions);
      let score = 0;
      for (const term of list) {
        if (content.includes(term)) score += 1;
        if (conditions.includes(term)) score += 2;
      }
      if (query_) {
        if (content.includes(query_)) score += 3;
        if (conditions.includes(query_)) score += 6;
      }
      return { row, score: query_ ? score : 1 };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));

  const items: RankedKnowledge[] = [];
  let used = 0;
  let truncated = scored.length > limit;
  for (const { row, score } of scored) {
    if (items.length >= limit) break;
    const item: RankedKnowledge = {
      id: row.id,
      version: row.version,
      content: row.content,
      conditions: row.conditions,
      reviewerId: row.reviewerId,
      expiresAt: row.expiresAt ?? '',
      sourceTaskId: row.sourceTaskId,
      reference: `knowledge:${row.id}:${row.version}`,
      score,
      contentTruncated: false,
    };
    const cost = (value: RankedKnowledge) => [...JSON.stringify(value)].length;
    const remaining = budgetChars - used;
    if (cost(item) > remaining) {
      // 二分截断正文，尽量保留能放进预算的片段。
      const characters = [...row.content];
      let low = 0;
      let high = characters.length;
      item.contentTruncated = true;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        item.content = characters.slice(0, mid).join('');
        if (cost(item) <= remaining) low = mid;
        else high = mid - 1;
      }
      item.content = characters.slice(0, low).join('');
      truncated = true;
      if (!item.content || cost(item) > remaining) continue;
    }
    used += cost(item);
    items.push(item);
  }
  return { items, truncated, usedChars: used };
}

export class KnowledgeService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 原始读取（不做授权判断），供内部可见性计算使用。 */
  async load(workspace: string, id: string): Promise<Knowledge | null> {
    const row = await this.ctx.db.read.one('SELECT * FROM knowledge WHERE id = :id AND workspace = :workspace', {
      id,
      workspace,
    });
    return row ? toKnowledge(row, String(row.access_mode) as 'workspace' | 'restricted') : null;
  }

  /** 按 id 读取并检查当前主体能否看见；跨团队时只认分享。 */
  async loadReadable(actor: Principal, id: string): Promise<Knowledge | null> {
    const row = await this.ctx.db.read.one('SELECT * FROM knowledge WHERE id = :id', { id });
    if (!row) return null;
    const item = toKnowledge(row, String(row.access_mode) as 'workspace' | 'restricted');
    return (await canViewKnowledge(this.ctx, actor, item)) ? item : null;
  }

  /** 从任务提取候选经验：负责人要求已验收；受派智能体提交结果后即可沉淀。 */
  async createCandidate(actor: Principal, taskId: string, body: unknown): Promise<Knowledge> {
    const task = await readTask(this.ctx, actor, taskId);
    const owner = task.ownerId === actor.id || hasAnyRole(actor, 'admin');
    if (owner) {
      if (task.status !== 'completed') throw conflict('只有已验收的任务可以沉淀经验');
    } else {
      if (actor.kind !== 'agent' && actor.kind !== 'service') {
        throw forbidden('只有任务负责人或已提交结果的智能体可以沉淀经验');
      }
      if (task.status === 'cancelled') throw conflict('任务已取消，无法沉淀经验');
      const submitted = await this.ctx.db.read.one(
        `SELECT 1 AS present FROM subtasks
         WHERE task_id = :taskId AND agent_id = :agent AND status IN ('submitted','verified') LIMIT 1`,
        { taskId, agent: actor.id },
      );
      if (!submitted) throw forbidden('只有已提交结果的受派智能体可以沉淀经验');
    }
    const input = asObject(body);
    const content = asString(input.content, 'content', { max: 8000 });
    const conditions = asString(input.conditions, 'conditions', { max: 4000 });

    const id = this.ctx.newId();
    const now = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO knowledge(id, workspace, task_id, content, conditions, state, version, author_id,
                               reviewer_id, expires_at, access_mode, created_at, updated_at)
         VALUES(:id, :workspace, :taskId, :content, :conditions, 'candidate', 1, :author,
                NULL, NULL, 'restricted', :at, :at)`,
        {
          id,
          workspace: actor.workspace,
          taskId,
          content,
          conditions,
          author: actor.id,
          at: now,
        },
      );
      await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'knowledge_candidate',
        payload: { id, version: 1 },
      });
    });
    return {
      id,
      workspace: actor.workspace,
      sourceTaskId: taskId,
      content,
      conditions,
      state: 'candidate',
      version: 1,
      authorId: actor.id,
      reviewerId: null,
      expiresAt: null,
      accessMode: 'restricted',
      createdAt: now,
      updatedAt: now,
    };
  }

  private async requireItem(actor: Principal, id: string): Promise<Knowledge> {
    const item = await this.load(actor.workspace, id);
    if (!item) throw notFound('知识不存在');
    return item;
  }

  /** 发布：审核人显式给出有效期与共享范围，平台写入版本快照。 */
  async publish(actor: Principal, id: string, body: unknown): Promise<{ id: string; state: string; version: number }> {
    if (!hasAnyRole(actor, 'reviewer', 'admin')) throw forbidden('只有审核人或管理员可以发布知识');
    const item = await this.requireItem(actor, id);
    if (item.state !== 'candidate') throw conflict('只有候选经验可以发布');
    const input = asObject(body);
    const expiresAt = asTimestamp(input.expiresAt, 'expiresAt');
    if (Date.parse(expiresAt) <= Date.parse(this.ctx.now())) throw invalid('expiresAt 必须晚于当前时间');
    const audience = this.parseAudience(input.audience);

    await this.ctx.db.transaction(async tx => {
      await this.applyAudience(tx, actor, item.id, audience);
      await tx.run(
        "UPDATE knowledge SET state = 'published', reviewer_id = :reviewer, expires_at = :expiresAt, updated_at = :at WHERE id = :id",
        { reviewer: actor.id, expiresAt, at: this.ctx.now(), id: item.id },
      );
      await tx.run(
        `INSERT INTO knowledge_versions(knowledge_id, version, content, conditions, reviewer_id, expires_at, published_at)
         VALUES(:id, :version, :content, :conditions, :reviewer, :expiresAt, :at)`,
        {
          id: item.id,
          version: item.version,
          content: item.content,
          conditions: item.conditions,
          reviewer: actor.id,
          expiresAt,
          at: this.ctx.now(),
        },
      );
      await appendEvent(this.ctx, tx, {
        taskId: item.sourceTaskId,
        actorId: actor.id,
        type: 'knowledge_published',
        payload: { id: item.id, version: item.version, expiresAt },
      });
    });
    return { id: item.id, state: 'published', version: item.version };
  }

  async revoke(actor: Principal, id: string, body: unknown): Promise<{ id: string; state: string; version: number }> {
    if (!hasAnyRole(actor, 'reviewer', 'admin')) throw forbidden('只有审核人或管理员可以撤销知识');
    const item = await this.requireItem(actor, id);
    if (item.state !== 'published') throw conflict('只有已发布的知识可以撤销');
    const reason = asString(asObject(body).reason, 'reason', { max: 2000 });
    await this.ctx.db.transaction(async tx => {
      await tx.run("UPDATE knowledge SET state = 'revoked', updated_at = :at WHERE id = :id", {
        at: this.ctx.now(),
        id: item.id,
      });
      await appendEvent(this.ctx, tx, {
        taskId: item.sourceTaskId,
        actorId: actor.id,
        type: 'knowledge_revoked',
        payload: { id: item.id, version: item.version, reason },
      });
    });
    return { id: item.id, state: 'revoked', version: item.version };
  }

  /** 修订：生成新版本候选，重新审核前不再作为有效经验返回。 */
  async revise(actor: Principal, id: string, body: unknown): Promise<{ id: string; state: string; version: number }> {
    if (!hasAnyRole(actor, 'reviewer', 'admin')) throw forbidden('只有审核人或管理员可以修订知识');
    const item = await this.requireItem(actor, id);
    if (!['published', 'revoked'].includes(item.state)) throw conflict('只有已发布或已撤销的知识可以修订');
    const input = asObject(body);
    const content = asString(input.content, 'content', { max: 8000 });
    const conditions = asString(input.conditions, 'conditions', { max: 4000 });
    const reason = asString(input.reason, 'reason', { max: 2000 });
    const version = item.version + 1;

    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE knowledge
         SET content = :content, conditions = :conditions, state = 'candidate', version = :version,
             author_id = :author, reviewer_id = NULL, expires_at = NULL, updated_at = :at
         WHERE id = :id`,
        { content, conditions, version, author: actor.id, at: this.ctx.now(), id: item.id },
      );
      await appendEvent(this.ctx, tx, {
        taskId: item.sourceTaskId,
        actorId: actor.id,
        type: 'knowledge_revised',
        payload: { id: item.id, version, reason },
      });
    });
    return { id: item.id, state: 'candidate', version };
  }

  /** 调整共享范围：立即影响后续读取与引用，但不能收回已被复制出去的内容。 */
  async changeAccess(actor: Principal, id: string, body: unknown): Promise<{ id: string; audience: KnowledgeAudience }> {
    if (!hasAnyRole(actor, 'reviewer', 'admin')) throw forbidden('只有审核人或管理员可以调整共享范围');
    const item = await this.requireItem(actor, id);
    const input = asObject(body);
    if (input.audience === undefined) throw invalid('audience 必填；可传 "workspace" 或主体 ID 数组');
    const audience = this.parseAudience(input.audience);
    await this.ctx.db.transaction(async tx => {
      await this.applyAudience(tx, actor, item.id, audience);
      await appendEvent(this.ctx, tx, {
        taskId: item.sourceTaskId,
        actorId: actor.id,
        type: 'knowledge_access_changed',
        payload: { id: item.id, version: item.version, audience },
      });
    });
    return { id: item.id, audience };
  }

  private parseAudience(value: unknown): KnowledgeAudience {
    if (value === undefined || value === 'workspace') return 'workspace';
    if (value === 'restricted') return [];
    return asStringArray(value, 'audience', { max: 100 });
  }

  private async applyAudience(
    tx: { run: (sql: string, params?: Record<string, unknown>) => Promise<number> },
    actor: Principal,
    knowledgeId: string,
    audience: KnowledgeAudience,
  ): Promise<void> {
    const mode = audience === 'workspace' ? 'workspace' : 'restricted';
    const principals = audience === 'workspace' ? [] : audience;
    for (const principal of principals) {
      const row = await this.ctx.db.read.one(
        'SELECT 1 AS present FROM principals WHERE id = :id AND workspace = :workspace AND active = 1',
        { id: principal, workspace: actor.workspace },
      );
      if (!row) throw invalid(`共享对象 ${principal} 不存在或已停用`);
    }
    await tx.run("UPDATE knowledge SET access_mode = :mode, updated_at = :at WHERE id = :id", {
      mode,
      at: this.ctx.now(),
      id: knowledgeId,
    });
    await tx.run('DELETE FROM knowledge_grants WHERE knowledge_id = :id', { id: knowledgeId });
    for (const principal of principals) {
      await tx.run('INSERT INTO knowledge_grants(knowledge_id, principal_id) VALUES(:id, :principal)', {
        id: knowledgeId,
        principal,
      });
    }
  }

  /** 来源空间看到的分享集合；已停用团队也会返回，便于撤回。 */
  async shares(actor: Principal, id: string): Promise<{ teams: { id: string; name: string; status: string }[] }> {
    await requireAgentScope(this.ctx, actor, 'knowledge:read');
    const item = await this.requireItem(actor, id);
    const rows = await this.ctx.db.read.all(
      `SELECT t.id, t.name, t.status
       FROM knowledge_shares s JOIN tenants t ON t.id = s.team_workspace
       WHERE s.knowledge_id = :id
       ORDER BY t.name`,
      { id: item.id },
    );
    return {
      teams: rows.map(row => ({
        id: String(row.id),
        name: String(row.name),
        status: String(row.status),
      })),
    };
  }

  /** 个人经验分享给团队：整单替换，只有来源空间里本人能改。 */
  async setShares(
    actor: Principal,
    id: string,
    body: unknown,
  ): Promise<{ id: string; teamIds: string[] }> {
    const item = await this.requireItem(actor, id);
    const accountId = actor.accountId;
    if (actor.kind !== 'human' || !accountId) throw forbidden('只有人可以分享经验');

    const source = await this.ctx.db.read.one(
      `SELECT t.personal, t.status, p.account_id
       FROM tenants t JOIN principals p ON p.id = :author AND p.workspace = t.id
       WHERE t.id = :workspace`,
      { author: item.authorId, workspace: item.workspace },
    );
    if (
      !source ||
      Number(source.personal) !== 1 ||
      String(source.status) !== 'active' ||
      String(source.account_id ?? '') !== accountId
    ) {
      throw forbidden('团队经验不能分享到团队之外');
    }

    const teamIds = asStringArray(asObject(body).teamIds, 'teamIds', { max: 50, maxLength: 128 });
    const currentRows = await this.ctx.db.read.all(
      'SELECT team_workspace AS id FROM knowledge_shares WHERE knowledge_id = :id',
      { id: item.id },
    );
    const current = new Set(currentRows.map(row => String(row.id)));
    const requested = new Set(teamIds);

    // 非发布状态只能撤回已有分享；新增分享必须先把经验发布出去。
    if (item.state !== 'published' && teamIds.some(teamId => !current.has(teamId))) {
      throw conflict('只有已发布的经验可以分享');
    }

    // 只校验新增目标：人退出团队后仍要能撤回已有分享。
    for (const teamId of requested) {
      if (current.has(teamId)) continue;
      const target = await this.ctx.db.read.one('SELECT status, personal FROM tenants WHERE id = :id', {
        id: teamId,
      });
      if (!target || Number(target.personal) === 1 || String(target.status) !== 'active') {
        throw invalid('分享目标必须是正常团队，不能是个人空间');
      }
      const membership = await this.ctx.db.read.one(
        `SELECT tenant_role FROM principals
         WHERE workspace = :tenant AND account_id = :account AND kind = 'human' AND active = 1
         LIMIT 1`,
        { tenant: teamId, account: accountId },
      );
      if (!membership) throw forbidden('你不是目标团队的成员');
      if (String(membership.tenant_role) === 'guest') throw forbidden('访客不能接收分享');
    }

    const unchanged = requested.size === current.size && teamIds.every(teamId => current.has(teamId));
    if (unchanged) return { id: item.id, teamIds };

    const now = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run('DELETE FROM knowledge_shares WHERE knowledge_id = :id', { id: item.id });
      for (const teamId of teamIds) {
        await tx.run(
          `INSERT INTO knowledge_shares(knowledge_id, team_workspace, shared_by, created_at)
           VALUES(:id, :team, :actor, :at)`,
          { id: item.id, team: teamId, actor: actor.id, at: now },
        );
      }
      await appendEvent(this.ctx, tx, {
        taskId: item.sourceTaskId,
        actorId: actor.id,
        type: 'knowledge_shared',
        payload: { id: item.id, teamIds },
      });
    });
    return { id: item.id, teamIds };
  }

  /** 已发布、未过期、且对调用方可见的经验（含分享给当前团队的个人经验）。 */
  async list(actor: Principal, query = '', limit = 100): Promise<Knowledge[]> {
    if (query.length > 200) throw invalid('查询过长');
    await requireAgentScope(this.ctx, actor, 'knowledge:read');
    const pattern = `%${query.toLowerCase()}%`;
    const rows = await this.ctx.db.read.all(
      `SELECT k.*,
              a.display_name AS author_name,
              st.name AS source_name,
              st.personal AS source_personal
       FROM knowledge k
       LEFT JOIN principals a ON a.id = k.author_id AND a.workspace = k.workspace
       LEFT JOIN tenants st ON st.id = k.workspace
       WHERE k.state = 'published' AND k.expires_at > :now
         AND (
           (k.workspace = :workspace AND (
              :privileged = 1 OR k.access_mode = 'workspace'
              OR EXISTS (SELECT 1 FROM knowledge_grants g
                         WHERE g.knowledge_id = k.id AND g.principal_id = :actor)))
           OR
           (k.workspace <> :workspace AND EXISTS (
              SELECT 1 FROM knowledge_shares s JOIN tenants t ON t.id = s.team_workspace
              WHERE s.knowledge_id = k.id AND s.team_workspace = :workspace
                AND t.status = 'active' AND t.personal = 0))
         )
         AND (:q = '' OR LOWER(k.content) LIKE :pattern OR LOWER(k.conditions) LIKE :pattern)
       ORDER BY k.created_at DESC, k.id
       LIMIT :limit`,
      {
        workspace: actor.workspace,
        now: this.ctx.now(),
        privileged: hasAnyRole(actor, 'admin', 'reviewer') ? 1 : 0,
        actor: actor.id,
        q: query,
        pattern,
        limit,
      },
    );
    const items = rows.map(row => {
      const item = toKnowledge(row, String(row.access_mode) as 'workspace' | 'restricted');
      item.authorName =
        row.author_name === null || row.author_name === undefined ? undefined : String(row.author_name);
      item.sourceName = row.source_name ? String(row.source_name) : item.workspace;
      item.sourcePersonal = Number(row.source_personal) === 1;
      if (item.workspace === actor.workspace) item.sharedTeams = [];
      return item;
    });

    const sourceIds = items.filter(item => item.workspace === actor.workspace).map(item => item.id);
    if (sourceIds.length > 0) {
      const placeholders = sourceIds.map((_, index) => `:id${index}`).join(', ');
      const params: Record<string, unknown> = {};
      sourceIds.forEach((id, index) => {
        params[`id${index}`] = id;
      });
      const shareRows = await this.ctx.db.read.all(
        `SELECT s.knowledge_id, t.id AS team_id, t.name AS team_name
         FROM knowledge_shares s JOIN tenants t ON t.id = s.team_workspace
         WHERE s.knowledge_id IN (${placeholders}) AND t.status = 'active' AND t.personal = 0
         ORDER BY t.name`,
        params,
      );
      const byId = new Map(items.map(item => [item.id, item]));
      for (const row of shareRows) {
        byId.get(String(row.knowledge_id))?.sharedTeams?.push({
          id: String(row.team_id),
          name: String(row.team_name),
        });
      }
    }
    return items;
  }

  async search(
    actor: Principal,
    query: string,
    limit: number,
    budgetChars: number,
  ): Promise<Record<string, unknown>> {
    if (query.length > 200) throw invalid('查询过长');
    const candidates = await this.list(actor, '', 500);
    const ranked = rankKnowledge(candidates, query, limit, budgetChars);
    return {
      items: ranked.items,
      truncated: ranked.truncated,
      usedChars: ranked.usedChars,
      budgetChars,
      budgetUnit: 'characters',
      retrieval: 'lexical',
      note: '词法检索基线；不含向量召回与重排，相似度不代表事实置信度',
    };
  }

  /** 待审核候选。 */
  async candidates(actor: Principal): Promise<Knowledge[]> {
    if (!hasAnyRole(actor, 'reviewer', 'admin')) throw forbidden('只有审核人或管理员可以查看候选');
    const rows = await this.ctx.db.read.all(
      `SELECT k.*, p.display_name AS author_name
       FROM knowledge k
       LEFT JOIN principals p ON p.id = k.author_id AND p.workspace = k.workspace
       WHERE k.workspace = :workspace AND k.state = 'candidate' ORDER BY k.created_at`,
      { workspace: actor.workspace },
    );
    return rows.map(row => ({
      ...toKnowledge(row, 'restricted'),
      authorName: row.author_name == null ? undefined : String(row.author_name),
    }));
  }

  async versions(actor: Principal, id: string): Promise<Record<string, unknown>[]> {
    if (!hasAnyRole(actor, 'reviewer', 'admin')) throw forbidden('只有审核人或管理员可以查看版本历史');
    const item = await this.requireItem(actor, id);
    const rows = await this.ctx.db.read.all(
      'SELECT * FROM knowledge_versions WHERE knowledge_id = :id ORDER BY version',
      { id: item.id },
    );
    return rows.map(row => ({
      version: Number(row.version),
      content: String(row.content),
      conditions: String(row.conditions),
      reviewerId: String(row.reviewer_id),
      expiresAt: String(row.expires_at),
      publishedAt: String(row.published_at),
    }));
  }

  /** 当前有效版本的证据包。 */
  async currentEvidence(actor: Principal, id: string): Promise<Record<string, unknown>> {
    await requireAgentScope(this.ctx, actor, 'knowledge:read');
    const item = await this.loadReadable(actor, id);
    if (
      !item ||
      item.state !== 'published' ||
      !item.expiresAt ||
      Date.parse(item.expiresAt) <= Date.parse(this.ctx.now())
    ) {
      throw notFound('知识不可用');
    }
    return {
      id: item.id,
      version: item.version,
      content: item.content,
      conditions: item.conditions,
      reviewerId: item.reviewerId,
      expiresAt: item.expiresAt,
      sourceTaskId: item.sourceTaskId,
      reference: `knowledge:${item.id}:${item.version}`,
    };
  }

  /** 任务引用过的历史版本；即使知识已撤销或收窄范围，历史引用仍可被授权者追溯。 */
  async taskEvidence(
    actor: Principal,
    taskId: string,
    knowledgeId: string,
    version: number,
  ): Promise<Record<string, unknown>> {
    await requireAgentScope(this.ctx, actor, 'knowledge:read');
    const task = await readTask(this.ctx, actor, taskId);
    if (task.ownerId !== actor.id && !hasAnyRole(actor, 'admin')) {
      throw forbidden('只有负责人或管理员可以读取任务证据');
    }
    if (!Number.isSafeInteger(version) || version < 1) throw invalid('version 必须是正整数');
    const item = await this.loadReadable(actor, knowledgeId);
    if (!item) throw notFound('证据不可用');
    const reference = await this.ctx.db.read.one(
      'SELECT 1 AS present FROM knowledge_refs WHERE task_id = :taskId AND knowledge_id = :id AND version = :version',
      { taskId, id: knowledgeId, version },
    );
    if (!reference) throw notFound('该任务未引用此版本');
    const snapshot = await this.ctx.db.read.one(
      `SELECT version, content, conditions, reviewer_id, expires_at, published_at
       FROM knowledge_versions WHERE knowledge_id = :id AND version = :version`,
      { id: knowledgeId, version },
    );
    if (!snapshot) throw notFound('证据不可用');
    return {
      knowledgeId,
      taskId,
      sourceTaskId: item.sourceTaskId,
      currentState: item.state,
      currentVersion: item.version,
      version: Number(snapshot.version),
      content: String(snapshot.content),
      conditions: String(snapshot.conditions),
      reviewerId: String(snapshot.reviewer_id),
      expiresAt: String(snapshot.expires_at),
      publishedAt: String(snapshot.published_at),
    };
  }

  /** 任务引用一条当前有效的经验，固定到具体版本。 */
  async reference(actor: Principal, taskId: string, body: unknown): Promise<{ id: string; version: number }> {
    await requireAgentScope(this.ctx, actor, 'knowledge:read');
    const task = await readTask(this.ctx, actor, taskId);
    assertOwner(actor, task);
    if (task.status === 'cancelled') throw conflict('已取消的任务不能引用知识');
    const knowledgeId = asString(asObject(body).knowledgeId, 'knowledgeId', { max: 128 });
    const item = await this.loadReadable(actor, knowledgeId);
    if (
      !item ||
      item.state !== 'published' ||
      !item.expiresAt ||
      Date.parse(item.expiresAt) <= Date.parse(this.ctx.now())
    ) {
      throw notFound('知识不可用');
    }
    const exists = await this.ctx.db.read.one(
      'SELECT 1 AS present FROM knowledge_refs WHERE task_id = :taskId AND knowledge_id = :id AND version = :version',
      { taskId, id: item.id, version: item.version },
    );
    if (exists) throw conflict('该版本已被引用');

    await this.ctx.db.transaction(async tx => {
      await tx.run(
        'INSERT INTO knowledge_refs(task_id, knowledge_id, version) VALUES(:taskId, :id, :version)',
        { taskId, id: item.id, version: item.version },
      );
      await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'knowledge_referenced',
        payload: { id: item.id, version: item.version },
      });
    });
    return { id: item.id, version: item.version };
  }
}
