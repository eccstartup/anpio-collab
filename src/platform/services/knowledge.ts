/**
 * 知识服务：候选 → 审核 → 发布 → 引用 → 修订 / 撤销。
 *
 * 平台区分事实、任务成果、文档和业务规则。这里只处理"文档"：
 * 它必须来自一个已验收的任务，必须有人审核，必须有适用条件和有效期，
 * 不能被智能体自动升级成强制规则，也不会自动进入模型训练。
 */

import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import type {
  DocumentCopyTarget,
  DocumentKind,
  DocumentSource,
  CopiedFrom,
  CopyInvite,
  EventType,
  EvidenceLevel,
  Knowledge,
  KnowledgeState,
  MessageKind,
  Principal,
} from '../../protocol/types.ts';
import {
  DOCUMENT_KINDS,
  COPY_INVITE_STATUSES,
  EVIDENCE_LEVELS,
} from '../../protocol/types.ts';
import {
  asEnum,
  asInteger,
  asObject,
  asOptionalString,
  asString,
  asStringArray,
  asTimestamp,
} from '../../protocol/parse.ts';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';
import { encode, toKnowledge } from '../db/mappers.ts';
import { assertOwner, hasAnyRole, readTask, requireAgentScope } from './access.ts';
import type { Account, AccountService } from './accounts.ts';
import { appendEvent } from './events.ts';
import type { TenantService } from './tenants.ts';

const INVITE_DAYS = 14;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;

export type KnowledgeAudience = 'workspace' | string[];

export type RankedKnowledge = {
  id: string;
  version: number;
  content: string;
  conditions: string;
  reviewerId: string | null;
  expiresAt: string;
  sourceTaskId: string | null;
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
  if (item.state === 'draft' || item.state === 'candidate') return item.authorId === principal.id;
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
  private readonly tenants: TenantService | null;
  private readonly accounts: AccountService | null;

  constructor(ctx: Context, tenants?: TenantService, accounts?: AccountService) {
    this.ctx = ctx;
    this.tenants = tenants ?? null;
    this.accounts = accounts ?? null;
  }

  /** 原始读取（不做授权判断），供内部可见性计算使用。 */
  async load(workspace: string, id: string): Promise<Knowledge | null> {
    const row = await this.ctx.db.read.one('SELECT * FROM knowledge WHERE id = :id AND workspace = :workspace', {
      id,
      workspace,
    });
    return row ? toKnowledge(row, String(row.access_mode) as 'workspace' | 'restricted') : null;
  }

  /** 写事务里读回刚写入的行；`db.read` 是另一条连接，看不到未提交的内容。 */
  private async loadTx(tx: Queryable, workspace: string, id: string): Promise<Knowledge | null> {
    const row = await tx.one('SELECT * FROM knowledge WHERE id = :id AND workspace = :workspace', {
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

  private async workspaceMeta(
    workspace: string,
  ): Promise<{ personal: boolean; status: string; name: string } | null> {
    const row = await this.ctx.db.read.one('SELECT name, status, personal FROM tenants WHERE id = :id', {
      id: workspace,
    });
    if (!row) return null;
    return {
      personal: Number(row.personal) === 1,
      status: String(row.status),
      name: String(row.name),
    };
  }

  /** 同空间里，作者本人或审核人可以改；跨空间一律不行。访客与智能体不能管理。 */
  private async canManage(actor: Principal, item: Knowledge): Promise<boolean> {
    if (item.workspace !== actor.workspace) return false;
    if (actor.kind !== 'human' || actor.tenantRole === 'guest') return false;
    return item.authorId === actor.id || hasAnyRole(actor, 'admin', 'reviewer');
  }

  private async assertManage(actor: Principal, item: Knowledge): Promise<void> {
    if (!(await this.canManage(actor, item))) {
      throw forbidden('只有作者、审核人或管理员可以管理这条文档');
    }
  }

  private parseTags(value: unknown): string[] {
    if (value === undefined) return [];
    return asStringArray(value, 'tags', { max: MAX_TAGS, maxLength: MAX_TAG_LENGTH });
  }

  /** 文档审计走自己的表；绑定了任务时再向任务事件流补一条。 */
  private async record(
    tx: Queryable,
    actor: Principal,
    item: { id: string; workspace: string; sourceTaskId: string | null },
    action: string,
    payload: Record<string, unknown>,
    taskEvent: EventType | null = null,
  ): Promise<void> {
    await tx.run(
      `INSERT INTO knowledge_events(id, workspace, knowledge_id, actor_id, action, payload, recorded_at)
       VALUES(:id, :workspace, :knowledge, :actor, :action, :payload, :at)`,
      {
        id: this.ctx.newId(),
        workspace: item.workspace,
        knowledge: item.id,
        actor: actor.id,
        action,
        payload: encode(payload),
        at: this.ctx.now(),
      },
    );
    if (taskEvent && item.sourceTaskId) {
      await appendEvent(this.ctx, tx, {
        taskId: item.sourceTaskId,
        actorId: actor.id,
        type: taskEvent,
        payload: { id: item.id, ...payload },
      });
    }
  }

  /** 批量补齐作者、来源空间、来源链与副本去向。 */
  private async decorate(items: Knowledge[]): Promise<Knowledge[]> {
    if (items.length === 0) return items;
    const params: Record<string, unknown> = {};
    const placeholders = items
      .map((item, index) => {
        params[`k${index}`] = item.id;
        return `:k${index}`;
      })
      .join(', ');

    const rows = await this.ctx.db.read.all(
      `SELECT k.id, a.display_name AS author_name, t.name AS source_name, t.personal AS source_personal
       FROM knowledge k
       LEFT JOIN principals a ON a.id = k.author_id AND a.workspace = k.workspace
       LEFT JOIN tenants t ON t.id = k.workspace
       WHERE k.id IN (${placeholders})`,
      params,
    );
    const byId = new Map(items.map(item => [item.id, item]));
    for (const row of rows) {
      const item = byId.get(String(row.id));
      if (!item) continue;
      item.authorName =
        row.author_name === null || row.author_name === undefined ? undefined : String(row.author_name);
      item.sourceName = row.source_name ? String(row.source_name) : item.workspace;
      item.sourcePersonal = Number(row.source_personal) === 1;
    }

    const parents = await this.ctx.db.read.all(
      `SELECT l.child_id, l.parent_id, l.parent_version, l.source_workspace,
              pk.state AS parent_state, t.name AS parent_name, t.personal AS parent_personal,
              pp.display_name AS parent_author
       FROM knowledge_lineage l
       JOIN knowledge pk ON pk.id = l.parent_id
       JOIN tenants t ON t.id = l.source_workspace
       LEFT JOIN principals pp ON pp.id = pk.author_id AND pp.workspace = pk.workspace
       WHERE l.child_id IN (${placeholders})`,
      params,
    );
    for (const row of parents) {
      const item = byId.get(String(row.child_id));
      if (!item) continue;
      const revoked = String(row.parent_state) === 'revoked';
      const copiedFrom: CopiedFrom = {
        id: String(row.parent_id),
        version: Number(row.parent_version),
        workspace: String(row.source_workspace),
        workspaceName: String(row.parent_name),
        personal: Number(row.parent_personal) === 1,
        authorName: row.parent_author === null || row.parent_author === undefined ? '' : String(row.parent_author),
        state: String(row.parent_state) as KnowledgeState,
        revoked,
      };
      item.copiedFrom = copiedFrom;
      item.sourceRevoked = revoked;
    }

    const copies = await this.ctx.db.read.all(
      `SELECT l.parent_id, l.child_id, l.target_workspace, l.copied_at, k.state AS target_state,
              t.name AS target_name, t.personal AS target_personal
       FROM knowledge_lineage l
       JOIN knowledge k ON k.id = l.child_id
       JOIN tenants t ON t.id = l.target_workspace
       WHERE l.parent_id IN (${placeholders})`,
      params,
    );
    for (const row of copies) {
      const item = byId.get(String(row.parent_id));
      if (!item) continue;
      item.copies ??= [];
      item.copies.push({
        workspace: String(row.target_workspace),
        workspaceName: String(row.target_name),
        personal: Number(row.target_personal) === 1,
        knowledgeId: String(row.child_id),
        copiedAt: String(row.copied_at),
        state: String(row.target_state) as KnowledgeState,
      });
    }
    return items;
  }

  /** 新建文档：默认草稿，人手动编辑后再提交审核。 */
  async create(actor: Principal, body: unknown): Promise<Knowledge> {
    if (actor.kind !== 'human') throw forbidden('只有人可以创建文档');
    if (actor.tenantRole === 'guest') throw forbidden('访客不能创建文档');
    const input = asObject(body);
    const kind = input.kind === undefined ? 'document' : asEnum(input.kind, 'kind', DOCUMENT_KINDS);
    const title = asString(input.title, 'title', { max: 200 });
    const content = asString(input.content, 'content', { max: 8000 });
    const summary = asOptionalString(input.summary, 'summary', { max: 500 }) ?? '';
    const conditions = asOptionalString(input.conditions, 'conditions', { max: 4000 }) ?? '';
    const tags = this.parseTags(input.tags);
    const meta = await this.workspaceMeta(actor.workspace);
    if (meta && meta.status !== 'active') throw forbidden('当前空间不可用');

    let sourceTaskId: string | null = null;
    let source: DocumentSource = 'manual';
    if (input.taskId !== undefined) {
      const taskId = asString(input.taskId, 'taskId', { max: 128 });
      const task = await readTask(this.ctx, actor, taskId);
      if (task.ownerId !== actor.id && !hasAnyRole(actor, 'admin')) {
        throw forbidden('只有任务负责人或管理员可以挂接任务');
      }
      sourceTaskId = taskId;
      source = 'task';
    }
    const defaultLevel: EvidenceLevel = source === 'task' ? 'task_verified' : 'manual';
    const evidenceLevel =
      input.evidenceLevel === undefined
        ? defaultLevel
        : asEnum(input.evidenceLevel, 'evidenceLevel', EVIDENCE_LEVELS);

    const id = this.ctx.newId();
    const now = this.ctx.now();
    const created = await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO knowledge(id, workspace, task_id, content, conditions, state, version, author_id,
                               reviewer_id, expires_at, access_mode, created_at, updated_at, kind, title,
                               summary, tags, source, evidence_level, archived_at)
         VALUES(:id, :workspace, :taskId, :content, :conditions, 'draft', 1, :author,
                NULL, NULL, 'restricted', :at, :at, :kind, :title, :summary, :tags, :source, :level, NULL)`,
        {
          id,
          workspace: actor.workspace,
          taskId: sourceTaskId,
          content,
          conditions,
          author: actor.id,
          at: now,
          kind,
          title,
          summary,
          tags: encode(tags),
          source,
          level: evidenceLevel,
        },
      );
      await this.record(
        tx,
        actor,
        { id, workspace: actor.workspace, sourceTaskId },
        'document_created',
        { kind, title },
        'document_created',
      );
      return this.loadTx(tx, actor.workspace, id);
    });
    if (!created) throw notFound('文档创建失败');
    return {
      ...created,
      authorName: actor.displayName,
      sourceName: meta?.name ?? actor.workspace,
      sourcePersonal: meta?.personal ?? false,
    };
  }

  /** 编辑草稿或待审核稿；发布后要走修订。 */
  async updateDraft(actor: Principal, id: string, body: unknown): Promise<Knowledge> {
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    if (item.state !== 'draft' && item.state !== 'candidate') {
      throw conflict('只有草稿或待审核的文档可以直接编辑');
    }
    const input = asObject(body);
    const next = {
      title: input.title === undefined ? item.title : asString(input.title, 'title', { max: 200 }),
      summary:
        input.summary === undefined
          ? item.summary
          : (asOptionalString(input.summary, 'summary', { max: 500 }) ?? ''),
      content: input.content === undefined ? item.content : asString(input.content, 'content', { max: 8000 }),
      conditions:
        input.conditions === undefined
          ? item.conditions
          : (asOptionalString(input.conditions, 'conditions', { max: 4000 }) ?? ''),
      tags: input.tags === undefined ? item.tags : this.parseTags(input.tags),
      kind: input.kind === undefined ? item.kind : asEnum(input.kind, 'kind', DOCUMENT_KINDS),
      sourceTaskId: item.sourceTaskId,
      workspace: item.workspace,
    };
    const updated = await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE knowledge
         SET title = :title, summary = :summary, content = :content, conditions = :conditions,
             tags = :tags, kind = :kind, updated_at = :at
         WHERE id = :id`,
        {
          title: next.title,
          summary: next.summary,
          content: next.content,
          conditions: next.conditions,
          tags: encode(next.tags),
          kind: next.kind,
          at: this.ctx.now(),
          id: item.id,
        },
      );
      await this.record(tx, actor, item, 'document_updated', { title: next.title }, 'document_updated');
      return this.loadTx(tx, item.workspace, item.id);
    });
    if (!updated) throw notFound('文档不存在');
    return updated;
  }

  /** 提交审核：draft → candidate。 */
  async submit(actor: Principal, id: string): Promise<Knowledge> {
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    if (item.state !== 'draft') throw conflict('只有草稿可以提交审核');
    if (!item.title.trim()) throw invalid('提交前必须填写标题');
    if (!item.content.trim()) throw invalid('提交前必须填写正文');
    const updated = await this.ctx.db.transaction(async tx => {
      await tx.run("UPDATE knowledge SET state = 'candidate', updated_at = :at WHERE id = :id", {
        at: this.ctx.now(),
        id: item.id,
      });
      await this.record(tx, actor, item, 'document_submitted', { version: item.version }, 'document_submitted');
      return this.loadTx(tx, item.workspace, item.id);
    });
    if (!updated) throw notFound('文档不存在');
    return updated;
  }

  /** 归档：不再出现在常规列表，但保留版本与来源链。 */
  async archive(actor: Principal, id: string, body: unknown): Promise<Knowledge> {
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    if (item.state === 'archived') return item;
    const reason = asOptionalString(asObject(body).reason, 'reason', { max: 2000 }) ?? '';
    const now = this.ctx.now();
    const updated = await this.ctx.db.transaction(async tx => {
      await tx.run("UPDATE knowledge SET state = 'archived', archived_at = :at, updated_at = :at WHERE id = :id", {
        at: now,
        id: item.id,
      });
      await this.record(tx, actor, item, 'document_archived', { reason }, 'document_archived');
      return this.loadTx(tx, item.workspace, item.id);
    });
    if (!updated) throw notFound('文档不存在');
    return updated;
  }

  /** 删除：只允许没有副本、也没有被任务引用的草稿或待审核稿；已发布的请先归档或撤销。 */
  async delete(actor: Principal, id: string): Promise<{ id: string; deleted: true }> {
    if (actor.kind !== 'human') throw forbidden('只有人可以删除文档');
    if (actor.tenantRole === 'guest') throw forbidden('访客不能删除文档');
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    if (item.state !== 'draft' && item.state !== 'candidate') {
      throw conflict('只有草稿或待审核的文档可以删除；已发布的请先归档或撤销');
    }
    const copy = await this.ctx.db.read.one(
      'SELECT 1 AS present FROM knowledge_lineage WHERE parent_id = :id',
      { id: item.id },
    );
    if (copy) throw conflict('已有副本的文档不能删除');
    const referenced = await this.ctx.db.read.one(
      'SELECT 1 AS present FROM knowledge_refs WHERE knowledge_id = :id',
      { id: item.id },
    );
    if (referenced) throw conflict('已被任务引用的文档不能删除');
    await this.ctx.db.transaction(async tx => {
      await tx.run('DELETE FROM knowledge_assets WHERE knowledge_id = :id', { id: item.id });
      await tx.run('DELETE FROM knowledge_versions WHERE knowledge_id = :id', { id: item.id });
      await tx.run('DELETE FROM knowledge_grants WHERE knowledge_id = :id', { id: item.id });
      await tx.run('DELETE FROM knowledge_shares WHERE knowledge_id = :id', { id: item.id });
      await tx.run('DELETE FROM knowledge_events WHERE knowledge_id = :id', { id: item.id });
      await tx.run(
        'DELETE FROM knowledge_copy_invites WHERE knowledge_id = :id OR accepted_knowledge_id = :id',
        { id: item.id },
      );
      await tx.run('DELETE FROM knowledge_lineage WHERE child_id = :id', { id: item.id });
      await tx.run('DELETE FROM knowledge WHERE id = :id AND workspace = :workspace', {
        id: item.id,
        workspace: item.workspace,
      });
    });
    return { id: item.id, deleted: true };
  }

  /** 详情：来源、作者、来源链与副本去向。 */
  async detail(actor: Principal, id: string): Promise<Knowledge> {
    await requireAgentScope(this.ctx, actor, 'knowledge:read');
    const item = await this.loadReadable(actor, id);
    if (!item) throw notFound('文档不存在');
    const [decorated] = await this.decorate([item]);
    return decorated;
  }

  /** 文档列表：本人稿、团队已发布稿与（审核人）全部候选。 */
  async listDocuments(
    actor: Principal,
    options: { state?: string; kind?: string; query?: string; limit?: number } = {},
  ): Promise<Knowledge[]> {
    await requireAgentScope(this.ctx, actor, 'knowledge:read');
    const state = options.state ?? '';
    if (state && !(['draft', 'candidate', 'published', 'archived', 'revoked'] as const).includes(state as never)) {
      throw invalid('state 不合法');
    }
    const kind = options.kind ?? '';
    if (kind) asEnum(kind, 'kind', DOCUMENT_KINDS);
    const query = (options.query ?? '').trim();
    if (query.length > 200) throw invalid('查询过长');
    const limit = asInteger(options.limit ?? 100, 'limit', { min: 1, max: 200 });
    const pattern = `%${query.toLowerCase()}%`;

    const rows = await this.ctx.db.read.all(
      `SELECT k.*, a.display_name AS author_name, st.name AS source_name, st.personal AS source_personal
       FROM knowledge k
       LEFT JOIN principals a ON a.id = k.author_id AND a.workspace = k.workspace
       LEFT JOIN tenants st ON st.id = k.workspace
       WHERE k.workspace = :workspace
         AND (k.author_id = :actor OR k.state = 'published' OR :privileged = 1)
         AND (:state <> '' OR k.state <> 'archived')
         AND (:state = '' OR k.state = :state)
         AND (:kind = '' OR k.kind = :kind)
         AND (:q = '' OR LOWER(k.title) LIKE :pattern OR LOWER(k.summary) LIKE :pattern
              OR LOWER(k.content) LIKE :pattern OR LOWER(k.conditions) LIKE :pattern)
       ORDER BY k.updated_at DESC, k.id
       LIMIT :limit`,
      {
        workspace: actor.workspace,
        actor: actor.id,
        privileged: hasAnyRole(actor, 'admin', 'reviewer') ? 1 : 0,
        state,
        kind,
        q: query,
        pattern,
        limit,
      },
    );
    const items = rows.map(row => toKnowledge(row, String(row.access_mode) as 'workspace' | 'restricted'));
    return this.decorate(items);
  }

  /** 把同一团队里的成果文件挂到文档上；只有 output 可以提升为证据。 */
  async attachAsset(actor: Principal, id: string, body: unknown): Promise<Record<string, unknown>> {
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    const input = asObject(body);
    const fileId = asString(input.fileId, 'fileId', { max: 128 });
    const role = input.role === undefined ? 'evidence' : asEnum(input.role, 'role', ['evidence', 'attachment'] as const);
    const file = await this.ctx.db.read.one(
      `SELECT * FROM space_files
       WHERE id = :id AND workspace = :workspace AND status = 'ready'`,
      { id: fileId, workspace: item.workspace },
    );
    if (!file) throw notFound('文件不存在');
    // 任务成果仍需是 output 才能当证据；独立附件本来就是为文档准备的，不设这个限制。
    const taskId = file.task_id === null || file.task_id === undefined ? null : String(file.task_id);
    if (role === 'evidence' && taskId !== null && String(file.kind) !== 'output') {
      throw notFound('文件不存在，或不是可提升的成果文件');
    }
    const exists = await this.ctx.db.read.one(
      'SELECT 1 AS present FROM knowledge_assets WHERE knowledge_id = :knowledge AND file_id = :file',
      { knowledge: item.id, file: fileId },
    );
    if (exists) return { id: item.id, fileId, role };
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO knowledge_assets(id, knowledge_id, file_id, role, created_at)
         VALUES(:id, :knowledge, :file, :role, :at)`,
        { id: this.ctx.newId(), knowledge: item.id, file: fileId, role, at: this.ctx.now() },
      );
      await this.record(tx, actor, item, 'document_asset_attached', { fileId, role });
    });
    return { id: item.id, fileId, role };
  }

  async assets(actor: Principal, id: string): Promise<Record<string, unknown>[]> {
    const item = await this.requireItem(actor, id);
    const visible = await this.loadReadable(actor, id);
    if (!visible) throw notFound('文档不存在');
    const rows = await this.ctx.db.read.all(
      `SELECT a.id AS asset_id, a.file_id, a.role, a.created_at AS attached_at, f.*
       FROM knowledge_assets a JOIN space_files f ON f.id = a.file_id
       WHERE a.knowledge_id = :id AND f.status = 'ready'
       ORDER BY a.created_at`,
      { id: item.id },
    );
    return rows.map(row => ({
      id: String(row.asset_id),
      role: String(row.role),
      fileId: String(row.file_id),
      taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
      name: String(row.name),
      mime: String(row.mime),
      size: Number(row.size),
      sha256: String(row.sha256),
      kind: String(row.kind),
      createdAt: String(row.attached_at),
    }));
  }

  /** 从任务提取候选文档：负责人要求已验收；受派智能体提交结果后即可沉淀。 */
  async createCandidate(actor: Principal, taskId: string, body: unknown): Promise<Knowledge> {
    const task = await readTask(this.ctx, actor, taskId);
    const owner = task.ownerId === actor.id || hasAnyRole(actor, 'admin');
    if (owner) {
      if (task.status !== 'completed') throw conflict('只有已验收的任务可以沉淀文档');
    } else {
      if (actor.kind !== 'agent' && actor.kind !== 'service') {
        throw forbidden('只有任务负责人或已提交结果的智能体可以沉淀文档');
      }
      if (task.status === 'cancelled') throw conflict('任务已取消，无法沉淀文档');
      const submitted = await this.ctx.db.read.one(
        `SELECT 1 AS present FROM subtasks
         WHERE task_id = :taskId AND agent_id = :agent AND status IN ('submitted','verified') LIMIT 1`,
        { taskId, agent: actor.id },
      );
      if (!submitted) throw forbidden('只有已提交结果的受派智能体可以沉淀文档');
    }
    const input = asObject(body);
    const kind = input.kind === undefined ? 'document' : asEnum(input.kind, 'kind', DOCUMENT_KINDS);
    const content = asString(input.content, 'content', { max: 8000 });
    const conditions = asOptionalString(input.conditions, 'conditions', { max: 4000 }) ?? '';
    const title =
      input.title === undefined ? content.slice(0, 60) : asString(input.title, 'title', { max: 200 });
    const summary = asOptionalString(input.summary, 'summary', { max: 500 }) ?? '';
    const tags = this.parseTags(input.tags);
    const source: DocumentSource = actor.kind === 'human' ? 'task' : 'agent';

    const id = this.ctx.newId();
    const now = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO knowledge(id, workspace, task_id, content, conditions, state, version, author_id,
                               reviewer_id, expires_at, access_mode, created_at, updated_at, kind, title,
                               summary, tags, source, evidence_level, archived_at)
         VALUES(:id, :workspace, :taskId, :content, :conditions, 'candidate', 1, :author,
                NULL, NULL, 'restricted', :at, :at, :kind, :title, :summary, :tags, :source,
                'task_verified', NULL)`,
        {
          id,
          workspace: actor.workspace,
          taskId,
          content,
          conditions,
          author: actor.id,
          at: now,
          kind,
          title,
          summary,
          tags: encode(tags),
          source,
        },
      );
      await this.record(
        tx,
        actor,
        { id, workspace: actor.workspace, sourceTaskId: taskId },
        'document_created',
        { kind, title, version: 1 },
        'knowledge_candidate',
      );
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
      kind,
      title,
      summary,
      tags,
      source,
      evidenceLevel: 'task_verified',
      archivedAt: null,
    };
  }

  private async requireItem(actor: Principal, id: string): Promise<Knowledge> {
    const item = await this.load(actor.workspace, id);
    if (!item) throw notFound('知识不存在');
    return item;
  }

  /** 发布：审核人显式给出有效期与共享范围，平台写入版本快照。 */
  async publish(actor: Principal, id: string, body: unknown): Promise<{ id: string; state: string; version: number }> {
    if (actor.kind !== 'human') throw forbidden('智能体不能发布文档');
    if (actor.tenantRole === 'guest') throw forbidden('访客不能发布文档');
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    if (item.state !== 'candidate' && item.state !== 'draft') {
      throw conflict('只有草稿或待审核的文档可以发布');
    }
    const input = asObject(body);
    const title = input.title === undefined ? item.title : asString(input.title, 'title', { max: 200 });
    const summary =
      input.summary === undefined
        ? item.summary
        : (asOptionalString(input.summary, 'summary', { max: 500 }) ?? '');
    const conditions =
      input.conditions === undefined
        ? item.conditions
        : (asOptionalString(input.conditions, 'conditions', { max: 4000 }) ?? '');
    const tags = input.tags === undefined ? item.tags : this.parseTags(input.tags);
    const kind = input.kind === undefined ? item.kind : asEnum(input.kind, 'kind', DOCUMENT_KINDS);
    if (!title.trim()) throw invalid('发布前必须填写标题');
    if (!item.content.trim()) throw invalid('发布前必须填写正文');

    let expiresAt: string | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      expiresAt = asTimestamp(input.expiresAt, 'expiresAt');
      if (Date.parse(expiresAt) <= Date.parse(this.ctx.now())) throw invalid('expiresAt 必须晚于当前时间');
    }
    const audience = this.parseAudience(input.audience);
    const evidenceLevel =
      input.evidenceLevel === undefined
        ? item.evidenceLevel
        : asEnum(input.evidenceLevel, 'evidenceLevel', EVIDENCE_LEVELS);

    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await this.applyAudience(tx, actor, item.id, audience);
      await tx.run(
        `UPDATE knowledge
         SET state = 'published', reviewer_id = :reviewer, expires_at = :expiresAt, title = :title,
             summary = :summary, conditions = :conditions, tags = :tags, kind = :kind,
             evidence_level = :level, archived_at = NULL, updated_at = :at
         WHERE id = :id`,
        {
          reviewer: actor.id,
          expiresAt,
          title,
          summary,
          conditions,
          tags: encode(tags),
          kind,
          level: evidenceLevel,
          at,
          id: item.id,
        },
      );
      await tx.run(
        `INSERT INTO knowledge_versions(knowledge_id, version, title, summary, tags, content, conditions,
                                        reviewer_id, expires_at, published_at)
         VALUES(:id, :version, :title, :summary, :tags, :content, :conditions, :reviewer, :expiresAt, :at)`,
        {
          id: item.id,
          version: item.version,
          title,
          summary,
          tags: encode(tags),
          content: item.content,
          conditions,
          reviewer: actor.id,
          expiresAt,
          at,
        },
      );
      await this.record(
        tx,
        actor,
        item,
        'document_published',
        { version: item.version, expiresAt },
        'knowledge_published',
      );
    });
    return { id: item.id, state: 'published', version: item.version };
  }

  async revoke(actor: Principal, id: string, body: unknown): Promise<{ id: string; state: string; version: number }> {
    if (actor.kind !== 'human') throw forbidden('智能体不能撤销文档');
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    if (item.state !== 'published') throw conflict('只有已发布的知识可以撤销');
    const reason = asString(asObject(body).reason, 'reason', { max: 2000 });
    await this.ctx.db.transaction(async tx => {
      await tx.run("UPDATE knowledge SET state = 'revoked', updated_at = :at WHERE id = :id", {
        at: this.ctx.now(),
        id: item.id,
      });
      await this.record(tx, actor, item, 'document_revoked', { version: item.version, reason }, 'knowledge_revoked');
    });
    return { id: item.id, state: 'revoked', version: item.version };
  }

  /** 修订：生成新版本候选，重新审核前不再作为有效文档返回。 */
  async revise(actor: Principal, id: string, body: unknown): Promise<{ id: string; state: string; version: number }> {
    if (actor.kind !== 'human') throw forbidden('智能体不能修订文档');
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    if (!['published', 'revoked'].includes(item.state)) throw conflict('只有已发布或已撤销的知识可以修订');
    const input = asObject(body);
    const content = asString(input.content, 'content', { max: 8000 });
    const conditions =
      input.conditions === undefined
        ? item.conditions
        : (asOptionalString(input.conditions, 'conditions', { max: 4000 }) ?? '');
    const reason = asString(input.reason, 'reason', { max: 2000 });
    const title = input.title === undefined ? item.title : asString(input.title, 'title', { max: 200 });
    const summary =
      input.summary === undefined
        ? item.summary
        : (asOptionalString(input.summary, 'summary', { max: 500 }) ?? '');
    const tags = input.tags === undefined ? item.tags : this.parseTags(input.tags);
    const kind = input.kind === undefined ? item.kind : asEnum(input.kind, 'kind', DOCUMENT_KINDS);
    const version = item.version + 1;

    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE knowledge
         SET content = :content, conditions = :conditions, state = 'candidate', version = :version,
             author_id = :author, reviewer_id = NULL, expires_at = NULL, title = :title,
             summary = :summary, tags = :tags, kind = :kind, updated_at = :at
         WHERE id = :id`,
        {
          content,
          conditions,
          version,
          author: actor.id,
          title,
          summary,
          tags: encode(tags),
          kind,
          at: this.ctx.now(),
          id: item.id,
        },
      );
      await this.record(tx, actor, item, 'document_revised', { version, reason }, 'knowledge_revised');
    });
    return { id: item.id, state: 'candidate', version };
  }

  /** 调整共享范围：立即影响后续读取与引用，但不能收回已被复制出去的内容。 */
  async changeAccess(actor: Principal, id: string, body: unknown): Promise<{ id: string; audience: KnowledgeAudience }> {
    if (actor.kind !== 'human') throw forbidden('智能体不能调整共享范围');
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    const input = asObject(body);
    if (input.audience === undefined) throw invalid('audience 必填；可传 "workspace" 或主体 ID 数组');
    const audience = this.parseAudience(input.audience);
    await this.ctx.db.transaction(async tx => {
      await this.applyAudience(tx, actor, item.id, audience);
      await this.record(tx, actor, item, 'document_access_changed', { audience }, 'knowledge_access_changed');
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

  /** 个人文档分享给团队：整单替换，只有来源空间里本人能改。 */
  async setShares(
    actor: Principal,
    id: string,
    body: unknown,
  ): Promise<{ id: string; teamIds: string[] }> {
    const item = await this.requireItem(actor, id);
    const accountId = actor.accountId;
    if (actor.kind !== 'human' || !accountId) throw forbidden('只有人可以分享文档');

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
      throw forbidden('团队文档不能分享到团队之外');
    }

    const teamIds = asStringArray(asObject(body).teamIds, 'teamIds', { max: 50, maxLength: 128 });
    const currentRows = await this.ctx.db.read.all(
      'SELECT team_workspace AS id FROM knowledge_shares WHERE knowledge_id = :id',
      { id: item.id },
    );
    const current = new Set(currentRows.map(row => String(row.id)));
    const requested = new Set(teamIds);

    // 非发布状态只能撤回已有分享；新增分享必须先把文档发布出去。
    if (item.state !== 'published' && teamIds.some(teamId => !current.has(teamId))) {
      throw conflict('只有已发布的文档可以分享');
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
      await this.record(tx, actor, item, 'document_shared', { teamIds }, 'knowledge_shared');
    });
    return { id: item.id, teamIds };
  }

  /** 已发布、未过期、且对调用方可见的文档（含分享给当前团队的个人文档）。 */
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
       WHERE k.state = 'published' AND (k.expires_at IS NULL OR k.expires_at > :now)
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
         AND (:q = '' OR LOWER(k.content) LIKE :pattern OR LOWER(k.conditions) LIKE :pattern
              OR LOWER(k.title) LIKE :pattern OR LOWER(k.summary) LIKE :pattern)
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
      title: String(row.title ?? ''),
      summary: String(row.summary ?? ''),
      tags: (() => {
        try {
          const parsed = JSON.parse(String(row.tags ?? '[]'));
          return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          return [];
        }
      })(),
      content: String(row.content),
      conditions: String(row.conditions),
      reviewerId: String(row.reviewer_id),
      expiresAt: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
      publishedAt: String(row.published_at),
    }));
  }

  /** 使用记录：谁在哪个任务里引用过哪个版本。 */
  async usage(actor: Principal, id: string): Promise<Record<string, unknown>> {
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    const rows = await this.ctx.db.read.all(
      `SELECT task_id, version, used_at FROM knowledge_usage
       WHERE knowledge_id = :id ORDER BY used_at DESC`,
      { id: item.id },
    );
    return {
      id: item.id,
      total: rows.length,
      uses: rows.map(row => ({
        taskId: String(row.task_id),
        version: Number(row.version),
        usedAt: String(row.used_at),
      })),
    };
  }

  /** 当前有效版本的证据包。 */
  async currentEvidence(actor: Principal, id: string): Promise<Record<string, unknown>> {
    await requireAgentScope(this.ctx, actor, 'knowledge:read');
    const item = await this.loadReadable(actor, id);
    if (
      !item ||
      item.state !== 'published' ||
      (item.expiresAt !== null && Date.parse(item.expiresAt) <= Date.parse(this.ctx.now()))
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
      expiresAt: snapshot.expires_at === null || snapshot.expires_at === undefined
        ? null
        : String(snapshot.expires_at),
      publishedAt: String(snapshot.published_at),
    };
  }

  /** 任务引用一条当前有效的文档，固定到具体版本。 */
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
      (item.expiresAt !== null && Date.parse(item.expiresAt) <= Date.parse(this.ctx.now()))
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
      const used = await tx.one(
        `SELECT 1 AS present FROM knowledge_usage
         WHERE knowledge_id = :id AND task_id = :taskId AND version = :version`,
        { id: item.id, taskId, version: item.version },
      );
      if (!used) {
        await tx.run(
          `INSERT INTO knowledge_usage(knowledge_id, task_id, version, used_at)
           VALUES(:id, :taskId, :version, :at)`,
          { id: item.id, taskId, version: item.version, at: this.ctx.now() },
        );
      }
      await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'knowledge_referenced',
        payload: { id: item.id, version: item.version },
      });
    });
    return { id: item.id, version: item.version };
  }

  /** 解析复制目标：默认个人空间，也可以指定自己所在的团队。 */
  private async resolveCopyTarget(
    actor: Principal,
    input: Record<string, unknown>,
  ): Promise<{ workspace: string; principalId: string; personal: boolean }> {
    if (actor.kind !== 'human' || !actor.accountId) throw forbidden('只有绑定账号的人可以复制文档');
    if (!this.tenants || !this.accounts) throw invalid('空间服务不可用');
    const account = await this.accounts.findById(actor.accountId);
    if (!account) throw forbidden('账号不存在');
    const requested = input.targetWorkspace;
    const target =
      requested === undefined ? 'personal' : asString(requested, 'targetWorkspace', { max: 128 });
    if (target === 'personal') {
      const principal = await this.tenants.ensurePersonal(account);
      return { workspace: principal.workspace, principalId: principal.id, personal: true };
    }
    const membership = await this.tenants.humanPrincipalFor(account, target);
    if (!membership) throw forbidden('你不是目标空间的成员');
    if (membership.tenantRole === 'guest') throw forbidden('访客不能接收副本');
    return { workspace: target, principalId: membership.id, personal: false };
  }

  /** 复制一份独立草稿；来源链固定到当前版本。 */
  private async createCopy(
    actor: Principal,
    source: Knowledge,
    target: { workspace: string; principalId: string; personal: boolean },
  ): Promise<Knowledge> {
    const childId = this.ctx.newId();
    const now = this.ctx.now();
    const parent = await this.ctx.db.read.one(
      'SELECT root_id FROM knowledge_lineage WHERE child_id = :id',
      { id: source.id },
    );
    const rootId = parent ? String(parent.root_id) : source.id;
    const includeAssets = target.workspace === source.workspace;

    const created = await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO knowledge(id, workspace, task_id, content, conditions, state, version, author_id,
                               reviewer_id, expires_at, access_mode, created_at, updated_at, kind, title,
                               summary, tags, source, evidence_level, archived_at)
         VALUES(:id, :workspace, NULL, :content, :conditions, 'draft', 1, :author,
                NULL, NULL, 'restricted', :at, :at, :kind, :title, :summary, :tags,
                'manual', 'imported', NULL)`,
        {
          id: childId,
          workspace: target.workspace,
          content: source.content,
          conditions: source.conditions,
          author: target.principalId,
          at: now,
          kind: source.kind,
          title: source.title,
          summary: source.summary,
          tags: encode(source.tags),
        },
      );
      await tx.run(
        `INSERT INTO knowledge_lineage(child_id, parent_id, parent_version, root_id, source_workspace,
                                       target_workspace, copied_by, copied_at, include_assets)
         VALUES(:child, :parent, :version, :root, :source, :target, :by, :at, :assets)`,
        {
          child: childId,
          parent: source.id,
          version: source.version,
          root: rootId,
          source: source.workspace,
          target: target.workspace,
          by: actor.id,
          at: now,
          assets: includeAssets ? 1 : 0,
        },
      );
      if (includeAssets) {
        const assets = await tx.all(
          'SELECT file_id, role FROM knowledge_assets WHERE knowledge_id = :id',
          { id: source.id },
        );
        for (const asset of assets) {
          const fileId = String(asset.file_id);
          const exists = await tx.one(
            'SELECT 1 AS present FROM knowledge_assets WHERE knowledge_id = :id AND file_id = :file',
            { id: childId, file: fileId },
          );
          if (exists) continue;
          await tx.run(
            `INSERT INTO knowledge_assets(id, knowledge_id, file_id, role, created_at)
             VALUES(:id, :knowledge, :file, :role, :at)`,
            {
              id: this.ctx.newId(),
              knowledge: childId,
              file: fileId,
              role: String(asset.role),
              at: now,
            },
          );
        }
      }
      await this.record(
        tx,
        actor,
        { id: childId, workspace: target.workspace, sourceTaskId: null },
        'document_copied',
        { parentId: source.id, version: source.version },
      );
      await this.record(
        tx,
        actor,
        source,
        'document_copied',
        { childId, targetWorkspace: target.workspace },
        'document_copied',
      );
      const child = await this.loadTx(tx, target.workspace, childId);
      if (!child) return null;
      const meta = await tx.one(
        `SELECT t.name AS workspace_name, t.personal, p.display_name AS author_name
         FROM tenants t
         LEFT JOIN principals p ON p.id = :author AND p.workspace = t.id
         WHERE t.id = :id`,
        { id: source.workspace, author: source.authorId },
      );
      return {
        ...child,
        copiedFrom: {
          id: source.id,
          version: source.version,
          workspace: source.workspace,
          workspaceName: meta ? String(meta.workspace_name) : source.workspace,
          personal: meta ? Number(meta.personal) === 1 : false,
          authorName: meta && meta.author_name !== null ? String(meta.author_name) : '',
          state: source.state,
          revoked: source.state === 'revoked',
        },
        sourceRevoked: source.state === 'revoked',
      };
    });
    if (!created) throw notFound('副本创建失败');
    return created;
  }

  /**
   * 复制文档：由用户选择要复制到的团队，确认后生成一份独立草稿；取消即不复制。
   * 复制到他人的个人空间必须走邀请。
   */
  async copy(actor: Principal, id: string, body: unknown): Promise<Knowledge> {
    if (actor.kind !== 'human') throw forbidden('只有人可以复制文档');
    if (actor.tenantRole === 'guest') throw forbidden('访客不能复制文档');
    const source = await this.loadReadable(actor, id);
    if (!source) throw notFound('文档不存在');
    if (source.state !== 'published') throw conflict('只有已发布的文档可以复制');
    if (source.expiresAt && Date.parse(source.expiresAt) <= Date.parse(this.ctx.now())) {
      throw conflict('文档已过期，请先修订');
    }
    const sourceMeta = await this.workspaceMeta(source.workspace);
    if (!sourceMeta) throw notFound('来源空间不存在');
    if (sourceMeta.personal && source.authorId !== actor.id) {
      throw forbidden('只有作者可以复制自己的个人文档');
    }

    const input = asObject(body);
    if (input.targetWorkspace === undefined) throw invalid('请选择要复制到的团队');
    const target = await this.resolveCopyTarget(actor, input);
    if (target.personal) throw invalid('请选择要复制到的团队');
    if (target.workspace === source.workspace && sourceMeta.personal) {
      throw invalid('个人空间内无需复制；请选择目标团队');
    }
    return this.createCopy(actor, source, target);
  }

  /** 来源空间可见的副本去向。 */
  async copies(actor: Principal, id: string): Promise<DocumentCopyTarget[]> {
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    const rows = await this.ctx.db.read.all(
      `SELECT l.child_id, l.target_workspace, l.copied_at, k.state, t.name, t.personal
       FROM knowledge_lineage l
       JOIN knowledge k ON k.id = l.child_id
       JOIN tenants t ON t.id = l.target_workspace
       WHERE l.parent_id = :id
       ORDER BY l.copied_at DESC`,
      { id: item.id },
    );
    return rows.map(row => ({
      workspace: String(row.target_workspace),
      workspaceName: String(row.name),
      personal: Number(row.personal) === 1,
      knowledgeId: String(row.child_id),
      copiedAt: String(row.copied_at),
      state: String(row.state) as KnowledgeState,
    }));
  }

  /** 向上追溯来源链，最多 20 层。 */
  async lineage(actor: Principal, id: string): Promise<Record<string, unknown>[]> {
    const item = await this.detail(actor, id);
    const chain: Record<string, unknown>[] = [];
    let current = item;
    for (let depth = 0; depth < 20; depth += 1) {
      const link = await this.ctx.db.read.one(
        `SELECT l.parent_id, l.parent_version, l.copied_at, l.root_id,
                k.title, k.state, t.name AS workspace_name
         FROM knowledge_lineage l
         JOIN knowledge k ON k.id = l.parent_id
         JOIN tenants t ON t.id = l.source_workspace
         WHERE l.child_id = :id`,
        { id: current.id },
      );
      if (!link) break;
      chain.push({
        id: String(link.parent_id),
        version: Number(link.parent_version),
        title: String(link.title),
        state: String(link.state),
        workspaceName: String(link.workspace_name),
        copiedAt: String(link.copied_at),
        rootId: String(link.root_id),
      });
      const parent = await this.ctx.db.read.one('SELECT * FROM knowledge WHERE id = :id', {
        id: String(link.parent_id),
      });
      if (!parent) break;
      current = toKnowledge(parent, String(parent.access_mode) as 'workspace' | 'restricted');
    }
    return chain;
  }

  private toInvite(row: Record<string, unknown>): CopyInvite {
    return {
      id: String(row.id),
      knowledgeId: String(row.knowledge_id),
      version: Number(row.version),
      fromPrincipal: String(row.from_principal),
      fromName: row.from_name === null || row.from_name === undefined ? '' : String(row.from_name),
      targetPrincipal: String(row.target_principal),
      targetWorkspace: String(row.target_workspace),
      note: String(row.note ?? ''),
      status: String(row.status ?? 'pending') as CopyInvite['status'],
      acceptedKnowledgeId:
        row.accepted_knowledge_id === null || row.accepted_knowledge_id === undefined
          ? null
          : String(row.accepted_knowledge_id),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      resolvedAt:
        row.resolved_at === null || row.resolved_at === undefined ? null : String(row.resolved_at),
      title: row.title === undefined ? undefined : String(row.title),
      summary: row.summary === undefined ? undefined : String(row.summary),
      kind: row.kind === undefined ? undefined : (String(row.kind) as CopyInvite['kind']),
      sourceName: row.source_name === undefined ? undefined : String(row.source_name),
    };
  }

  /** 邀请他人把文档复制到其个人空间；对方接受后才落库。 */
  async inviteCopy(actor: Principal, id: string, body: unknown): Promise<CopyInvite> {
    const item = await this.requireItem(actor, id);
    await this.assertManage(actor, item);
    if (item.state !== 'published') throw conflict('只有已发布的文档可以复制给他人');
    const input = asObject(body);
    const targetPrincipal = asString(input.targetPrincipal, 'targetPrincipal', { max: 128 });
    const note = asOptionalString(input.note, 'note', { max: 500 }) ?? '';
    if (targetPrincipal === actor.id) throw invalid('不能把文档复制给自己');
    const target = await this.ctx.db.read.one(
      `SELECT p.id, p.workspace, t.personal, t.status, p.active
       FROM principals p JOIN tenants t ON t.id = p.workspace
       WHERE p.id = :id AND p.kind = 'human'`,
      { id: targetPrincipal },
    );
    if (
      !target ||
      Number(target.personal) !== 1 ||
      String(target.status) !== 'active' ||
      Number(target.active) !== 1
    ) {
      throw invalid('复制目标必须是活跃的个人空间');
    }
    const now = new Date(this.ctx.now());
    const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString();
    const inviteId = this.ctx.newId();
    const created = await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO knowledge_copy_invites(id, knowledge_id, version, from_principal, target_principal,
                                            target_workspace, note, status, accepted_knowledge_id,
                                            created_at, expires_at, resolved_at)
         VALUES(:id, :knowledge, :version, :from, :target, :workspace, :note, 'pending', NULL,
                :at, :expires, NULL)`,
        {
          id: inviteId,
          knowledge: item.id,
          version: item.version,
          from: actor.id,
          target: targetPrincipal,
          workspace: String(target.workspace),
          note,
          at: this.ctx.now(),
          expires: expiresAt,
        },
      );
      await this.record(tx, actor, item, 'document_copy_invited', { inviteId, targetPrincipal });
      const row = await tx.one(
        `SELECT i.*, p.display_name AS from_name
         FROM knowledge_copy_invites i LEFT JOIN principals p ON p.id = i.from_principal
         WHERE i.id = :id`,
        { id: inviteId },
      );
      if (!row) return null;
      return this.toInvite(row);
    });
    if (!created) throw notFound('邀请创建失败');
    return created;
  }

  /** 收到的 / 发出的复制邀请。 */
  async copyInvites(actor: Principal, direction: 'incoming' | 'outgoing' = 'incoming'): Promise<CopyInvite[]> {
    const column = direction === 'incoming' ? 'i.target_principal' : 'i.from_principal';
    const rows = await this.ctx.db.read.all(
      `SELECT i.*, p.display_name AS from_name, k.title, k.summary, k.kind, t.name AS source_name
       FROM knowledge_copy_invites i
       LEFT JOIN principals p ON p.id = i.from_principal
       LEFT JOIN knowledge k ON k.id = i.knowledge_id
       LEFT JOIN tenants t ON t.id = k.workspace
       WHERE ${column} = :actor
       ORDER BY i.created_at DESC`,
      { actor: actor.id },
    );
    const now = Date.parse(this.ctx.now());
    const invites = rows.map(row => this.toInvite(row));
    for (const invite of invites) {
      if (invite.status === 'pending' && Date.parse(invite.expiresAt) <= now) invite.status = 'expired';
    }
    return invites;
  }

  async acceptInvite(actor: Principal, inviteId: string): Promise<Knowledge> {
    const invite = await this.ctx.db.read.one('SELECT * FROM knowledge_copy_invites WHERE id = :id', {
      id: inviteId,
    });
    if (!invite) throw notFound('邀请不存在');
    if (String(invite.target_principal) !== actor.id) throw forbidden('这不是发给你的邀请');
    if (String(invite.status) !== 'pending') throw conflict('邀请已处理');
    if (Date.parse(String(invite.expires_at)) <= Date.parse(this.ctx.now())) {
      await this.ctx.db.transaction(async tx => {
        await tx.run(
          "UPDATE knowledge_copy_invites SET status = 'expired', resolved_at = :at WHERE id = :id AND status = 'pending'",
          { at: this.ctx.now(), id: inviteId },
        );
      });
      throw conflict('邀请已过期');
    }
    if (String(invite.target_workspace) !== actor.workspace) {
      throw forbidden('请切换到邀请指定的个人空间后接受');
    }
    const sourceRow = await this.ctx.db.read.one('SELECT * FROM knowledge WHERE id = :id', {
      id: String(invite.knowledge_id),
    });
    if (!sourceRow) throw notFound('来源文档不存在');
    const source = toKnowledge(sourceRow, String(sourceRow.access_mode) as 'workspace' | 'restricted');
    if (source.state !== 'published') throw conflict('来源文档已不可用');
    const child = await this.createCopy(
      actor,
      source,
      { workspace: actor.workspace, principalId: actor.id, personal: true },
    );
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE knowledge_copy_invites
         SET status = 'accepted', accepted_knowledge_id = :child, resolved_at = :at
         WHERE id = :id AND status = 'pending'`,
        { child: child.id, at: this.ctx.now(), id: inviteId },
      );
      await this.record(
        tx,
        actor,
        { id: child.id, workspace: child.workspace, sourceTaskId: null },
        'document_copy_accepted',
        { inviteId, parentId: source.id },
      );
    });
    return child;
  }

  async declineInvite(actor: Principal, inviteId: string): Promise<{ id: string; status: string }> {
    const invite = await this.ctx.db.read.one('SELECT * FROM knowledge_copy_invites WHERE id = :id', {
      id: inviteId,
    });
    if (!invite) throw notFound('邀请不存在');
    if (String(invite.target_principal) !== actor.id) throw forbidden('这不是发给你的邀请');
    if (String(invite.status) !== 'pending') throw conflict('邀请已处理');
    const source = await this.ctx.db.read.one('SELECT workspace FROM knowledge WHERE id = :id', {
      id: String(invite.knowledge_id),
    });
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        "UPDATE knowledge_copy_invites SET status = 'declined', resolved_at = :at WHERE id = :id AND status = 'pending'",
        { at: this.ctx.now(), id: inviteId },
      );
      await this.record(
        tx,
        actor,
        {
          id: String(invite.knowledge_id),
          workspace: source ? String(source.workspace) : actor.workspace,
          sourceTaskId: null,
        },
        'document_copy_declined',
        { inviteId },
      );
    });
    return { id: inviteId, status: 'declined' };
  }
}
