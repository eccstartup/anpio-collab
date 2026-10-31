/**
 * 任务生命周期。
 *
 * 任务：pending → running → review → completed，任意未终结状态可 → cancelled。
 * 这里的每个写方法都假定自己已经在一个事务中执行（由 HTTP 执行器负责开启），
 * 因此"改状态 + 写事件 + 发通知"要么一起生效，要么一起回滚。
 */

import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import { PRIORITIES } from '../../protocol/types.ts';
import type { Principal, Subtask, Task, TaskStatus } from '../../protocol/types.ts';
import { asEnum, asId, asObject, asString, asTimestamp, asTaskInput } from '../../protocol/parse.ts';
import { addDays, type Context } from '../context.ts';
import type { Queryable, Row } from '../db/driver.ts';
import { encode, toEvent, toSubtask, toTask } from '../db/mappers.ts';
import {
  assertCoordinator,
  assertOwner,
  hasAnyRole,
  isCoordinator,
  loadTask,
  readTask,
  requireAgentScope,
  requireRole,
} from './access.ts';
import { appendEvent, latestSeq } from './events.ts';
import { KnowledgeService } from './knowledge.ts';
import { insertMaterials, listMaterials, parseMaterialUploads, requireMaterial } from './materials.ts';
import { NotificationService } from './notifications.ts';

const DEFAULT_DUE_DAYS = 7;
const OPEN_TASK_STATUSES: TaskStatus[] = ['pending', 'running', 'review'];
const PENDING_SUBTASK_STATUSES = ['invited', 'accepted', 'returned', 'rejected', 'timed_out', 'outcome_unknown'];

export type TaskFilters = {
  status?: TaskStatus;
  q?: string;
  includeArchived?: boolean;
  limit: number;
  offset: number;
};

export type TaskListItem = {
  id: string;
  title: string;
  type: string;
  status: TaskStatus;
  priority: string;
  ownerId: string;
  ownerName: string;
  dueAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  subtaskCount: number;
  subtaskDone: number;
  /** 任务是人建的还是智能体提案。 */
  origin: 'human' | 'agent';
  /** 提案是否已被人接管。 */
  adopted: boolean;
  /** 归档时间；默认列表不返回归档任务。 */
  archivedAt: string | null;
};

/** 任务可见性：管理员、负责人、协调者、受派智能体；团队任务对本团队成员开放。 */
const VISIBLE_CLAUSE = `(
  t.owner_id = :actor OR :isAdmin = 1 OR :teamMember = 1
  OR EXISTS (SELECT 1 FROM subtasks vs WHERE vs.task_id = t.id AND vs.agent_id = :actor)
  OR EXISTS (SELECT 1 FROM task_coordinators vc WHERE vc.task_id = t.id AND vc.principal_id = :actor)
  OR EXISTS (
    SELECT 1 FROM task_participants vp
    WHERE vp.task_id = t.id AND vp.status = 'accepted'
      AND (vp.human_principal_id = :actor OR vp.agent_id = :actor)
  )
)`;

/** 动态流：一条事件 + 它所属任务的标题，供工作台直接展示。 */
export type ActivityItem = {
  seq: number;
  taskId: string;
  taskTitle: string;
  actorId: string;
  type: string;
  payload: Record<string, unknown>;
  recordedAt: string;
};

const LIST_COLUMNS = `
  t.id, t.title, t.type, t.status, t.priority, t.owner_id, t.due_at, t.version, t.created_at, t.updated_at,
  t.origin, t.adopted_at, t.archived_at,
  p.display_name AS owner_name,
  (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id) AS subtask_count,
  (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.status IN ('submitted','verified')) AS subtask_done
`;

function toListItem(row: Row): TaskListItem {
  return {
    id: String(row.id),
    title: String(row.title),
    type: String(row.type),
    status: String(row.status) as TaskStatus,
    priority: String(row.priority),
    ownerId: String(row.owner_id),
    ownerName: String(row.owner_name ?? ''),
    dueAt: String(row.due_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    subtaskCount: Number(row.subtask_count ?? 0),
    subtaskDone: Number(row.subtask_done ?? 0),
    origin: row.origin === 'agent' ? 'agent' : 'human',
    adopted: row.adopted_at !== null && row.adopted_at !== undefined,
    archivedAt:
      row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
  };
}

export class TaskService {
  private readonly ctx: Context;
  private readonly notifications: NotificationService;
  private readonly knowledge: KnowledgeService;

  constructor(ctx: Context, notifications: NotificationService, knowledge: KnowledgeService) {
    this.ctx = ctx;
    this.notifications = notifications;
    this.knowledge = knowledge;
  }

  // ---------------------------------------------------------------- 创建与查询

  /**
   * 创建任务。
   *
   * 人（负责人 / 管理员）创建的是**任务**，直接归自己负责；
   * 智能体创建的是**提案**（`origin=agent`），同样归自己，但要等人接管
   * 才算真正进入协作流程——这样"智能体自己发现的问题"能进系统，
   * 又不会因为一个误判就变成别人必须处理的正式任务。
   */
  async create(
    actor: Principal,
    body: unknown,
    executor: Principal = actor,
  ): Promise<{ id: string; status: TaskStatus; version: number; workspace: string }> {
    requireRole(executor, 'owner', 'admin', 'agent');
    const byAgent = hasAnyRole(executor, 'agent') && !hasAnyRole(executor, 'owner', 'admin');
    const input = asObject(body);
    const now = this.ctx.now();
    const title = asString(input.title, 'title', { max: 200 });
    const goal = input.goal === undefined ? title : asString(input.goal, 'goal', { max: 4000 });
    const acceptance = asString(input.acceptance, 'acceptance', { max: 4000 });
    const type = input.type === undefined ? 'general' : asId(input.type, 'type');
    const priority = input.priority === undefined ? 'normal' : asEnum(input.priority, 'priority', PRIORITIES);
    const dueAt = input.dueAt === undefined ? addDays(now, DEFAULT_DUE_DAYS) : asTimestamp(input.dueAt, 'dueAt');
    if (Date.parse(dueAt) <= Date.parse(now)) throw invalid('dueAt 必须晚于当前时间');
    const taskInput = input.input === undefined ? {} : asTaskInput(input.input);
    const materials = parseMaterialUploads(input.materials);

    const id = this.ctx.newId();
    let createdVersion = 1;
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO tasks(id, workspace, type, title, goal, acceptance, priority, due_at, owner_id,
                           status, input, result, version, origin, origin_principal_id, adopted_at,
                           created_at, updated_at)
         VALUES(:id, :workspace, :type, :title, :goal, :acceptance, :priority, :dueAt, :owner,
                'pending', :input, NULL, 0, :origin, :originPrincipal, NULL, :at, :at)`,
        {
          id,
          workspace: executor.workspace,
          type,
          title,
          goal,
          acceptance,
          priority,
          dueAt,
          owner: executor.id,
          input: encode(taskInput),
          origin: byAgent ? 'agent' : 'human',
          originPrincipal: byAgent ? executor.id : null,
          at: now,
        },
      );
      await insertMaterials(tx, id, executor.id, materials, now, () => this.ctx.newId());
      // 事件同时把 version 从 0 推到 1，返回值必须与实际存储一致。
      const event = await appendEvent(this.ctx, tx, {
        taskId: id,
        actorId: executor.id,
        type: 'task_created',
        payload: { title, type, acceptance, dueAt, origin: byAgent ? 'agent' : 'human' },
      });
      createdVersion = event.taskVersion;
    });
    return { id, status: 'pending', version: createdVersion, workspace: executor.workspace };
  }

  /**
   * 接管一个智能体发起的提案。
   *
   * 接管改变的是**责任归属**，不是内容：提案的目标、验收条件、输入都保留，
   * 原发起者留在 `origin_principal_id` 里，事件里也留一条。
   */
  async adopt(actor: Principal, taskId: string): Promise<{ id: string; ownerId: string; version: number }> {
    requireRole(actor, 'owner', 'admin', 'supervisor');
    // 接管前读不到是正常的：提案本来就不在别人的任务列表里，
    // 所以这里只按工作空间加载，授权由角色与"未被接管"共同决定。
    const task = await loadTask(this.ctx, actor, taskId);
    if (task.origin !== 'agent') throw conflict('只有智能体发起的提案需要接管');
    if (task.adoptedAt !== null) throw conflict('该提案已经被接管');
    if (task.status === 'cancelled' || task.status === 'completed') throw conflict('该提案已结束，无法接管');
    const now = this.ctx.now();
    let version = task.version;
    await this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE tasks SET owner_id = :owner, adopted_at = :at WHERE id = :id', {
        owner: actor.id,
        at: now,
        id: task.id,
      });
      const event = await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: 'task_adopted',
        payload: { from: task.originPrincipalId ?? task.ownerId, to: actor.id },
      });
      version = event.taskVersion;
    });
    return { id: task.id, ownerId: actor.id, version };
  }

  /** 团队任务对活跃团队里的真人成员可见；访客与智能体仍按原规则。 */
  private async isTeamMember(actor: Principal): Promise<boolean> {
    if (actor.kind !== 'human' || actor.tenantRole === 'guest') return false;
    const row = await this.ctx.db.read.one('SELECT personal, status FROM tenants WHERE id = :id', {
      id: actor.workspace,
    });
    return Boolean(row && Number(row.personal) === 0 && String(row.status) === 'active');
  }

  private buildListSql(
    actor: Principal,
    filters: TaskFilters,
    teamMember: boolean,
  ): { sql: string; params: Record<string, unknown> } {
    const conditions = ['t.workspace = :workspace', VISIBLE_CLAUSE];
    const params: Record<string, unknown> = {
      workspace: actor.workspace,
      actor: actor.id,
      isAdmin: hasAnyRole(actor, 'admin') ? 1 : 0,
      teamMember: teamMember ? 1 : 0,
      limit: filters.limit,
      offset: filters.offset,
    };
    if (filters.status) {
      conditions.push('t.status = :status');
      params.status = filters.status;
    }
    if (!filters.includeArchived) conditions.push('t.archived_at IS NULL');
    if (filters.q) {
      conditions.push('(LOWER(t.title) LIKE :q OR LOWER(t.goal) LIKE :q)');
      params.q = `%${filters.q.toLowerCase()}%`;
    }
    const sql = `SELECT ${LIST_COLUMNS}
      FROM tasks t JOIN principals p ON p.id = t.owner_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.created_at DESC, t.id
      LIMIT :limit OFFSET :offset`;
    return { sql, params };
  }

  async list(actor: Principal, filters: Omit<TaskFilters, 'limit' | 'offset'> = {}): Promise<TaskListItem[]> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const { sql, params } = this.buildListSql(
      actor,
      { ...filters, limit: 500, offset: 0 },
      await this.isTeamMember(actor),
    );
    const rows = await this.ctx.db.read.all(sql, params);
    return rows.map(toListItem);
  }

  async page(actor: Principal, filters: TaskFilters): Promise<{ items: TaskListItem[]; nextOffset: number | null }> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    // 多取一条用来判断是否还有下一页，避免额外 count 查询。
    const { sql, params } = this.buildListSql(
      actor,
      { ...filters, limit: filters.limit + 1 },
      await this.isTeamMember(actor),
    );
    const rows = await this.ctx.db.read.all(sql, params);
    const items = rows.slice(0, filters.limit).map(toListItem);
    return { items, nextOffset: rows.length > filters.limit ? filters.offset + filters.limit : null };
  }

  /**
   * 最近的跨任务事件。
   *
   * 只对负责人、审核人与管理员开放：业务智能体没有控制台，
   * 而事件正文可能包含其他智能体的结果，不适合再放宽。
   */
  async activity(actor: Principal, limit = 30): Promise<ActivityItem[]> {
    requireRole(actor, 'owner', 'reviewer', 'admin');
    const rows = await this.ctx.db.read.all(
      `SELECT e.seq, e.task_id, e.actor_id, e.type, e.payload, e.recorded_at, t.title
       FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE t.workspace = :workspace
         AND (t.owner_id = :actor OR :wide = 1
              OR EXISTS (SELECT 1 FROM task_coordinators c
                         WHERE c.task_id = t.id AND c.principal_id = :actor))
       ORDER BY e.seq DESC
       LIMIT :limit`,
      {
        workspace: actor.workspace,
        actor: actor.id,
        wide: hasAnyRole(actor, 'admin', 'reviewer') ? 1 : 0,
        limit,
      },
    );
    return rows.map(row => ({
      seq: Number(row.seq),
      taskId: String(row.task_id),
      taskTitle: String(row.title),
      actorId: String(row.actor_id),
      type: String(row.type),
      payload: JSON.parse(String(row.payload ?? '{}')) as Record<string, unknown>,
      recordedAt: String(row.recorded_at),
    }));
  }

  async detail(actor: Principal, taskId: string): Promise<Record<string, unknown>> {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    const task = await readTask(this.ctx, actor, taskId);
    const unrestricted =
      hasAnyRole(actor, 'admin') || task.ownerId === actor.id || (await isCoordinator(this.ctx, actor, task.id));

    const subtaskRows = unrestricted
      ? await this.ctx.db.read.all('SELECT * FROM subtasks WHERE task_id = :taskId ORDER BY created_at, id', { taskId })
      : await this.ctx.db.read.all(
          'SELECT * FROM subtasks WHERE task_id = :taskId AND agent_id = :agent ORDER BY created_at, id',
          { taskId, agent: actor.id },
        );
    const subtasks = await this.withDependencies(subtaskRows);

    const coordinators = unrestricted
      ? (
          await this.ctx.db.read.all(
            'SELECT principal_id FROM task_coordinators WHERE task_id = :taskId ORDER BY principal_id',
            { taskId },
          )
        ).map(row => String(row.principal_id))
      : [];

    // 智能体只看到自己的子任务，看不到别人的结果、事件和知识引用。
    let events: ReturnType<typeof toEvent>[] = [];
    let references: {
      knowledgeId: string;
      version: number;
      content: string | null;
      conditions: string | null;
    }[] = [];
    if (unrestricted) {
      const eventRows = await this.ctx.db.read.all(
        'SELECT * FROM events WHERE task_id = :taskId ORDER BY seq',
        { taskId },
      );
      const parsed = eventRows.map(toEvent);
      const knowledgeIds = new Set<string>();
      for (const event of parsed) {
        if (event.type.startsWith('knowledge_') && typeof event.payload.id === 'string') {
          knowledgeIds.add(event.payload.id);
        }
      }
      const visible = await this.visibleKnowledgeIds(actor, knowledgeIds);
      events = parsed.filter(
        event =>
          !event.type.startsWith('knowledge_') ||
          (typeof event.payload.id === 'string' && visible.has(event.payload.id)),
      );

      // 引用是钉在版本上的，所以正文取自 knowledge_versions 而不是当前行：
      // 经验被修订之后，仍要能看清当时依据的是哪一版。
      const refRows = await this.ctx.db.read.all(
        `SELECT r.knowledge_id, r.version, v.content, v.conditions
         FROM knowledge_refs r
         LEFT JOIN knowledge_versions v
           ON v.knowledge_id = r.knowledge_id AND v.version = r.version
         WHERE r.task_id = :taskId
         ORDER BY r.knowledge_id, r.version`,
        { taskId },
      );
      const refIds = new Set(refRows.map(row => String(row.knowledge_id)));
      const visibleRefs = await this.visibleKnowledgeIds(actor, refIds);
      references = refRows
        .filter(row => visibleRefs.has(String(row.knowledge_id)))
        .map(row => ({
          knowledgeId: String(row.knowledge_id),
          version: Number(row.version),
          content: row.content == null ? null : String(row.content),
          conditions: row.conditions == null ? null : String(row.conditions),
        }));
    }

    // 负责人名称与列表保持一致：详情页不必再查一次目录。
    const owner = await this.ctx.db.read.one<{ display_name: string | null }>(
      'SELECT display_name FROM principals WHERE id = :id AND workspace = :workspace',
      { id: task.ownerId, workspace: task.workspace },
    );

    return {
      task: {
        ...task,
        ownerName: String(owner?.display_name ?? '') || task.ownerId,
        result: unrestricted ? task.result : null,
      },
      subtasks,
      coordinators,
      events,
      knowledgeRefs: references,
      materials: await listMaterials(this.ctx.db.read, taskId),
      unrestricted,
    };
  }

  /** 任务材料目录：能读任务的人都能看。 */
  async materials(actor: Principal, taskId: string) {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    await readTask(this.ctx, actor, taskId);
    return listMaterials(this.ctx.db.read, taskId);
  }

  /** 材料正文：下载与智能体取用共用。 */
  async material(actor: Principal, taskId: string, materialId: string) {
    await requireAgentScope(this.ctx, actor, 'tasks:read');
    await readTask(this.ctx, actor, taskId);
    return requireMaterial(this.ctx.db.read, taskId, materialId);
  }

  private async visibleKnowledgeIds(actor: Principal, ids: Set<string>): Promise<Set<string>> {
    const visible = new Set<string>();
    for (const id of ids) {
      if (await this.knowledge.loadReadable(actor, id)) visible.add(id);
    }
    return visible;
  }

  private async withDependencies(rows: Row[]): Promise<Subtask[]> {
    if (rows.length === 0) return [];
    const ids = rows.map(row => String(row.id));
    const placeholders = ids.map((_, index) => `:id${index}`).join(', ');
    const params: Record<string, unknown> = {};
    ids.forEach((id, index) => {
      params[`id${index}`] = id;
    });
    const dependencyRows = await this.ctx.db.read.all(
      `SELECT subtask_id, depends_on FROM subtask_dependencies WHERE subtask_id IN (${placeholders})`,
      params,
    );
    const grouped = new Map<string, string[]>();
    for (const row of dependencyRows) {
      const key = String(row.subtask_id);
      grouped.set(key, [...(grouped.get(key) ?? []), String(row.depends_on)]);
    }
    return rows.map(row => {
      const subtask = toSubtask(row);
      subtask.dependsOn = (grouped.get(subtask.id) ?? []).sort();
      return subtask;
    });
  }

  /**
   * 面向智能体的紧凑上下文：当前状态、未决事项、最新阶段摘要和最近事件。
   * 长任务恢复时先读这里，再按引用展开细节，不必重放整段对话。
   */
  async context(actor: Principal, taskId: string): Promise<Record<string, unknown>> {
    const detail = (await this.detail(actor, taskId)) as {
      task: Task;
      subtasks: Subtask[];
      events: ReturnType<typeof toEvent>[];
      knowledgeRefs: {
        knowledgeId: string;
        version: number;
        content: string | null;
        conditions: string | null;
      }[];
      unrestricted: boolean;
    };
    const { task, subtasks, events, knowledgeRefs, unrestricted } = detail;
    const summaryRow = unrestricted
      ? await this.ctx.db.read.one(
          'SELECT * FROM task_summaries WHERE task_id = :taskId ORDER BY version DESC LIMIT 1',
          { taskId },
        )
      : undefined;
    const seq = await latestSeq(this.ctx, taskId);

    return {
      task: {
        id: task.id,
        title: task.title,
        type: task.type,
        status: task.status,
        version: task.version,
        acceptance: task.acceptance,
        dueAt: task.dueAt,
      },
      subtasks: subtasks.map(item => ({
        id: item.id,
        kind: item.kind,
        agentId: item.agentId,
        status: item.status,
        version: item.version,
        dueAt: item.dueAt,
      })),
      pending: subtasks
        .filter(item => PENDING_SUBTASK_STATUSES.includes(item.status))
        .map(item => ({ id: item.id, status: item.status, kind: item.kind })),
      result: task.result,
      references: knowledgeRefs,
      stageSummary: summaryRow
        ? {
            version: Number(summaryRow.version),
            text: String(summaryRow.text),
            pending: String(summaryRow.pending),
            throughSeq: Number(summaryRow.through_seq),
            authorId: String(summaryRow.author_id),
            createdAt: String(summaryRow.created_at),
            stale: seq > Number(summaryRow.through_seq),
          }
        : null,
      events: events.slice(-20),
      eventsTruncated: events.length > 20,
    };
  }

  // ---------------------------------------------------------------- 分工与指派

  /** 委派协调智能体：可分派子任务、写阶段摘要、提交汇总，但不能验收。 */
  async delegate(actor: Principal, taskId: string, body: unknown): Promise<{ principal: string }> {
    const task = await readTask(this.ctx, actor, taskId);
    assertOwner(actor, task);
    const principal = asId(asObject(body).principal, 'principal');
    if (!OPEN_TASK_STATUSES.includes(task.status)) throw conflict('任务已结束，无法委派协调者');
    const target = await this.ctx.db.read.one(
      'SELECT * FROM principals WHERE id = :id AND workspace = :workspace AND active = 1',
      { id: principal, workspace: actor.workspace },
    );
    if (!target) throw invalid('主体不存在或已停用');
    const roles = JSON.parse(String(target.roles)) as string[];
    if (!roles.includes('agent')) throw invalid('只能委派给智能体主体');
    const exists = await this.ctx.db.read.one(
      'SELECT 1 AS present FROM task_coordinators WHERE task_id = :taskId AND principal_id = :principal',
      { taskId, principal },
    );
    if (exists) throw conflict('该主体已是本任务的协调者');
    await this.ctx.db.transaction(async tx => {
      await tx.run('INSERT INTO task_coordinators(task_id, principal_id) VALUES(:taskId, :principal)', {
        taskId,
        principal,
      });
      await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'coordinator_delegated',
        payload: { principal },
      });
    });
    return { principal };
  }

  async undelegate(actor: Principal, taskId: string, body: unknown): Promise<{ principal: string; delegated: false }> {
    const task = await readTask(this.ctx, actor, taskId);
    assertOwner(actor, task);
    const principal = asId(asObject(body).principal, 'principal');
    await this.ctx.db.transaction(async tx => {
      const changed = await tx.run(
        'DELETE FROM task_coordinators WHERE task_id = :taskId AND principal_id = :principal',
        { taskId, principal },
      );
      if (changed === 0) throw notFound('该主体不是本任务的协调者');
      await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'coordinator_removed',
        payload: { principal },
      });
    });
    return { principal, delegated: false };
  }

  /** 指派子任务：负责人、协调者或管理员。 */
  async assign(actor: Principal, taskId: string, body: unknown): Promise<Subtask> {
    const task = await readTask(this.ctx, actor, taskId);
    await assertCoordinator(this.ctx, actor, task);
    if (!OPEN_TASK_STATUSES.includes(task.status)) throw conflict('任务已结束，无法继续指派');

    const input = asObject(body);
    const agentId = asId(input.agent, 'agent');
    const kind = asString(input.kind, 'kind', { max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/ });
    const agent = await this.ctx.db.read.one(
      'SELECT * FROM principals WHERE id = :id AND workspace = :workspace AND active = 1',
      { id: agentId, workspace: actor.workspace },
    );
    if (!agent) throw invalid('智能体不存在或已停用');
    const roles = JSON.parse(String(agent.roles)) as string[];
    if (!roles.includes('agent')) throw invalid('目标主体没有 agent 角色');

    const duplicate = await this.ctx.db.read.one(
      'SELECT id FROM subtasks WHERE task_id = :taskId AND agent_id = :agent AND kind = :kind',
      { taskId, agent: agentId, kind },
    );
    if (duplicate) throw conflict('该智能体已承担同类子任务');

    const dependencies = input.dependsOn === undefined ? [] : input.dependsOn;
    if (!Array.isArray(dependencies)) throw invalid('dependsOn 必须是子任务 ID 数组');
    const dependencyIds = dependencies.map((item, index) => asId(item, `dependsOn[${index}]`));
    if (new Set(dependencyIds).size !== dependencyIds.length) throw invalid('dependsOn 存在重复项');
    for (const dependency of dependencyIds) {
      const row = await this.ctx.db.read.one(
        'SELECT id FROM subtasks WHERE id = :id AND task_id = :taskId',
        { id: dependency, taskId },
      );
      if (!row) throw invalid('依赖的子任务必须属于同一任务');
    }

    const dueAt = input.dueAt === undefined ? task.dueAt : asTimestamp(input.dueAt, 'dueAt');
    const id = this.ctx.newId();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO subtasks(id, task_id, agent_id, kind, status, result, due_at, version, created_at, updated_at)
         VALUES(:id, :taskId, :agent, :kind, 'invited', NULL, :dueAt, 1, :at, :at)`,
        { id, taskId, agent: agentId, kind, dueAt, at: this.ctx.now() },
      );
      for (const dependency of dependencyIds) {
        await tx.run(
          'INSERT INTO subtask_dependencies(subtask_id, depends_on) VALUES(:subtask, :dependsOn)',
          { subtask: id, dependsOn: dependency },
        );
      }
      if (task.status === 'pending') {
        await tx.run("UPDATE tasks SET status = 'running', updated_at = :at WHERE id = :taskId", {
          at: this.ctx.now(),
          taskId,
        });
      }
      await this.notifications.deliver(tx, {
        workspace: actor.workspace,
        recipientId: agentId,
        taskId,
        subtaskId: id,
        type: 'invited',
      });
      await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'subtask_invited',
        payload: { subtaskId: id, agent: agentId, kind, dependsOn: dependencyIds, dueAt },
      });
    });
    return {
      id,
      taskId,
      agentId,
      kind,
      status: 'invited',
      result: null,
      dueAt,
      dependsOn: dependencyIds,
      version: 1,
      createdAt: this.ctx.now(),
      updatedAt: this.ctx.now(),
    };
  }

  // ---------------------------------------------------------------- 汇总与验收

  /** 阶段摘要：记录"到目前为止发生了什么"，事件序号之后的新事件会使其过期。 */
  async recordStageSummary(actor: Principal, taskId: string, body: unknown): Promise<Record<string, unknown>> {
    const task = await readTask(this.ctx, actor, taskId);
    await assertCoordinator(this.ctx, actor, task);
    const input = asObject(body);
    const text = asString(input.text, 'text', { max: 8000 });
    const pending = asString(input.pending, 'pending', { max: 4000 });
    const throughSeq = await latestSeq(this.ctx, taskId);
    const previous = await this.ctx.db.read.one(
      'SELECT COALESCE(MAX(version), 0) AS version FROM task_summaries WHERE task_id = :taskId',
      { taskId },
    );
    const version = Number(previous?.version ?? 0) + 1;
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO task_summaries(task_id, version, text, pending, through_seq, author_id, created_at)
         VALUES(:taskId, :version, :text, :pending, :throughSeq, :author, :at)`,
        { taskId, version, text, pending, throughSeq, author: actor.id, at: this.ctx.now() },
      );
      await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'stage_summary_recorded',
        payload: { version, throughSeq },
      });
    });
    return { taskId, version, throughSeq };
  }

  /** 提交汇总：所有子任务必须已提交，任务进入待验收。 */
  async submitSummary(actor: Principal, taskId: string, body: unknown): Promise<{ status: TaskStatus; version: number }> {
    const task = await readTask(this.ctx, actor, taskId);
    await assertCoordinator(this.ctx, actor, task);
    if (task.status !== 'running') throw conflict('只有执行中的任务可以提交汇总');
    const text = asString(asObject(body).text, 'text', { max: 8000 });

    const subtasks = await this.ctx.db.read.all('SELECT * FROM subtasks WHERE task_id = :taskId ORDER BY created_at, id', {
      taskId,
    });
    if (subtasks.length === 0) throw conflict('尚未指派任何子任务');
    const incomplete = subtasks.filter(row => String(row.status) !== 'submitted');
    if (incomplete.length > 0) throw conflict('仍有子任务未提交结果');

    const result = {
      text,
      subtasks: subtasks.map(row => ({
        id: String(row.id),
        agentId: String(row.agent_id),
        kind: String(row.kind),
        result: row.result ? JSON.parse(String(row.result)) : null,
      })),
    };
    return this.ctx.db.transaction(async tx => {
      await tx.run(
        "UPDATE tasks SET status = 'review', result = :result, updated_at = :at WHERE id = :taskId",
        { result: encode(result), at: this.ctx.now(), taskId },
      );
      const event = await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'summary_submitted',
        payload: { subtaskCount: result.subtasks.length },
      });
      return { status: 'review' as TaskStatus, version: event.taskVersion };
    });
  }

  /** 人工验收：接受则任务完成并核验子任务；退回则回到执行中。 */
  async review(actor: Principal, taskId: string, body: unknown): Promise<{ status: TaskStatus; version: number }> {
    const task = await readTask(this.ctx, actor, taskId);
    assertOwner(actor, task);
    if (task.status !== 'review') throw conflict('只有待验收的任务可以验收');
    const input = asObject(body);
    const decision = asEnum(input.decision, 'decision', ['accept', 'return'] as const);
    const note = asString(input.note, 'note', { max: 4000 });
    const accepted = decision === 'accept';

    return this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE tasks SET status = :status, updated_at = :at WHERE id = :taskId', {
        status: accepted ? 'completed' : 'running',
        at: this.ctx.now(),
        taskId,
      });
      if (accepted) {
        await tx.run(
          "UPDATE subtasks SET status = 'verified', version = version + 1, updated_at = :at WHERE task_id = :taskId AND status = 'submitted'",
          { at: this.ctx.now(), taskId },
        );
      }
      const event = await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: accepted ? 'task_accepted' : 'task_returned',
        payload: { note },
      });
      return { status: (accepted ? 'completed' : 'running') as TaskStatus, version: event.taskVersion };
    });
  }

  /** 取消任务：未核验的子任务一并取消，并通知受派智能体停止处理。 */
  async cancel(actor: Principal, taskId: string, body: unknown): Promise<{ status: TaskStatus; version: number }> {
    const task = await readTask(this.ctx, actor, taskId);
    assertOwner(actor, task);
    if (task.status === 'completed' || task.status === 'cancelled') throw conflict('任务已结束');
    const note = asString(asObject(body).note, 'note', { max: 4000 });
    const now = this.ctx.now();

    return this.ctx.db.transaction(async tx => {
      await tx.run("UPDATE tasks SET status = 'cancelled', updated_at = :at WHERE id = :taskId", {
        at: now,
        taskId,
      });
      const open = await tx.all(
        "SELECT * FROM subtasks WHERE task_id = :taskId AND status NOT IN ('verified','cancelled')",
        { taskId },
      );
      await tx.run(
        "UPDATE subtasks SET status = 'cancelled', version = version + 1, updated_at = :at WHERE task_id = :taskId AND status NOT IN ('verified','cancelled')",
        { at: now, taskId },
      );
      for (const row of open) {
        await this.notifications.deliver(tx, {
          workspace: actor.workspace,
          recipientId: String(row.agent_id),
          taskId,
          subtaskId: String(row.id),
          type: 'cancelled',
        });
      }
      const event = await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'task_cancelled',
        payload: { note, cancelledSubtasks: open.length },
      });
      return { status: 'cancelled' as TaskStatus, version: event.taskVersion };
    });
  }

  // ---------------------------------------------------------------- 归档

  /**
   * 归档：只加时间戳，不改状态，也不删事件、消息与文件。
   * 只有已结束的任务可以归档；运行中的任务先取消或验收，避免把活埋掉。
   */
  async archive(actor: Principal, taskId: string): Promise<{ archivedAt: string; version: number }> {
    const task = await readTask(this.ctx, actor, taskId);
    assertOwner(actor, task);
    if (task.archivedAt) throw conflict('任务已归档');
    if (task.status !== 'completed' && task.status !== 'cancelled') {
      throw conflict('只有已完成或已取消的任务可以归档');
    }
    const now = this.ctx.now();
    return this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE tasks SET archived_at = :at, updated_at = :at WHERE id = :taskId', {
        at: now,
        taskId,
      });
      const event = await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'task_archived',
        payload: { status: task.status },
      });
      return { archivedAt: now, version: event.taskVersion };
    });
  }

  /** 撤销归档；历史与文件原样保留。 */
  async unarchive(actor: Principal, taskId: string): Promise<{ archivedAt: null; version: number }> {
    const task = await readTask(this.ctx, actor, taskId);
    assertOwner(actor, task);
    if (!task.archivedAt) throw conflict('任务没有归档');
    const now = this.ctx.now();
    return this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE tasks SET archived_at = NULL, updated_at = :at WHERE id = :taskId', {
        at: now,
        taskId,
      });
      const event = await appendEvent(this.ctx, tx, {
        taskId,
        actorId: actor.id,
        type: 'task_unarchived',
        payload: {},
      });
      return { archivedAt: null, version: event.taskVersion };
    });
  }

  // ---------------------------------------------------------------- 运维

  /**
   * 把超过截止时间仍未提交的子任务标记为 timed_out。
   * 超时只是"需要人工核对"，不代表执行失败，也不会自动重试业务操作。
   */
  async expireOverdue(actor: Principal): Promise<{ expired: number; checkedAt: string }> {
    if (!hasAnyRole(actor, 'admin')) throw forbidden('只有管理员可以执行超时检查');
    const now = this.ctx.now();
    const overdue = await this.ctx.db.read.all(
      `SELECT s.* FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE t.workspace = :workspace AND t.status = 'running'
         AND s.status IN ('invited','accepted','returned') AND s.due_at <= :now
       ORDER BY s.due_at`,
      { workspace: actor.workspace, now },
    );
    if (overdue.length === 0) return { expired: 0, checkedAt: now };

    await this.ctx.db.transaction(async tx => {
      for (const row of overdue) {
        const changed = await tx.run(
          "UPDATE subtasks SET status = 'timed_out', version = version + 1, updated_at = :at WHERE id = :id AND status = :status",
          { at: now, id: String(row.id), status: String(row.status) },
        );
        if (changed === 0) continue; // 期间已被其他操作改变，跳过。
        await appendEvent(this.ctx, tx, {
          taskId: String(row.task_id),
          actorId: actor.id,
          type: 'subtask_timed_out',
          payload: {
            subtaskId: String(row.id),
            scheduled: true,
            note: '截止时间已过；先核对执行业务状态，再决定是否退回重试',
          },
        });
      }
    });
    return { expired: overdue.length, checkedAt: now };
  }
}
