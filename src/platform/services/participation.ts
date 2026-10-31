/**
 * 任务参与与智能体协商。
 *
 * 两条链路刻意分开：
 *  - 参与：任务发起人邀请的是**人**，被邀请人接受时再选定自己的一个智能体；
 *  - 分工：智能体之间用同一张请求表协商——委托协调者与分配子任务只是粒度不同。
 *
 * 人负责"谁进来"，智能体负责"怎么干"。平台不替任何一方做业务判断，
 * 只保证每次交接都有明确的发起方、接受方、状态和事件。
 */

import { conflict, forbidden, invalid, notFound } from '../../protocol/errors.ts';
import { asEnum, asId, asObject, asString, asTimestamp } from '../../protocol/parse.ts';
import type {
  ParticipantStatus,
  Principal,
  RequestRole,
  RequestStatus,
  Task,
  TaskParticipant,
  TaskRequest,
  TaskStatus,
} from '../../protocol/types.ts';
import { REQUEST_ROLES, REQUEST_STATUSES } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable, Row } from '../db/driver.ts';
import { encode } from '../db/mappers.ts';
import { activeTransaction } from '../db/transaction.ts';
import { assertCoordinator, assertOwner, loadTask, readTask } from './access.ts';
import { appendEvent } from './events.ts';

const OPEN_TASK_STATUSES: TaskStatus[] = ['pending', 'running', 'review'];
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type TaskInvitation = TaskParticipant & {
  taskTitle: string;
  taskStatus: TaskStatus;
  invitedByName: string;
};

export type TaskRequestView = TaskRequest & {
  taskTitle: string;
  fromName: string;
  toName: string;
};

type ParticipantRow = Row;
type RequestRow = Row;

function toParticipant(row: Row): TaskParticipant {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    humanPrincipalId: String(row.human_principal_id),
    displayName: String(row.human_name ?? ''),
    email: row.email === null || row.email === undefined ? null : String(row.email),
    invitedBy: String(row.invited_by),
    status: String(row.status) as ParticipantStatus,
    agentId: row.agent_id === null || row.agent_id === undefined ? null : String(row.agent_id),
    agentName: row.agent_name === null || row.agent_name === undefined ? null : String(row.agent_name),
    note: String(row.note ?? ''),
    createdAt: String(row.created_at),
    respondedAt: row.responded_at === null || row.responded_at === undefined ? null : String(row.responded_at),
  };
}

function toRequest(row: Row): TaskRequest {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    fromPrincipal: String(row.from_principal),
    toPrincipal: String(row.to_principal),
    role: String(row.role) as RequestRole,
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    counter: row.counter === null || row.counter === undefined ? null : (JSON.parse(String(row.counter)) as Record<string, unknown>),
    status: String(row.status) as RequestStatus,
    subtaskId: row.subtask_id === null || row.subtask_id === undefined ? null : String(row.subtask_id),
    createdAt: String(row.created_at),
    respondedAt: row.responded_at === null || row.responded_at === undefined ? null : String(row.responded_at),
  };
}

function toRequestView(row: Row): TaskRequestView {
  return {
    ...toRequest(row),
    taskTitle: String(row.task_title),
    fromName: String(row.from_name),
    toName: String(row.to_name),
  };
}

export class ParticipationService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------- 参与人

  async participants(actor: Principal, taskId: string): Promise<TaskParticipant[]> {
    const task = await readTask(this.ctx, actor, taskId);
    const rows = await this.ctx.db.read.all(
      `SELECT p.*, h.display_name AS human_name,
              (SELECT value FROM account_links e WHERE e.account_id = p.account_id AND e.kind = 'email' LIMIT 1) AS email,
              a.display_name AS agent_name
       FROM task_participants p
       JOIN principals h ON h.id = p.human_principal_id
       LEFT JOIN principals a ON a.id = p.agent_id
       WHERE p.task_id = :taskId AND p.workspace = :workspace
       ORDER BY p.created_at, p.id`,
      { taskId: task.id, workspace: actor.workspace },
    );
    return rows.map(toParticipant);
  }

  /**
   * 邀请一个人参与任务。
   *
   * 这里只认"人"：智能体不能作为被邀请对象，它只能由主人选定后进入。
   * 团队任务才开放邀请；个人任务本来就只有一个人。
   */
  async invite(actor: Principal, taskId: string, body: unknown): Promise<TaskParticipant> {
    const task = await readTask(this.ctx, actor, taskId);
    await assertCoordinator(this.ctx, actor, task);
    if (!OPEN_TASK_STATUSES.includes(task.status)) throw conflict('任务已结束，无法继续邀请');
    const tenant = await this.ctx.db.read.one('SELECT personal FROM tenants WHERE id = :id', {
      id: actor.workspace,
    });
    if (tenant && Number(tenant.personal) === 1) throw conflict('个人任务不邀请其他成员');

    const input = asObject(body);
    const invitee = await this.resolveInvitee(actor, input);
    if (invitee.id === actor.id) throw conflict('不能邀请自己');
    if (!invitee.accountId) throw conflict('该成员没有账号，无法选定智能体');

    const note = input.note === undefined ? '' : asString(input.note, 'note', { max: 1000, min: 0 });
    const existing = await this.ctx.db.read.one(
      'SELECT * FROM task_participants WHERE task_id = :taskId AND human_principal_id = :human',
      { taskId: task.id, human: invitee.id },
    );
    if (existing) {
      const status = String(existing.status);
      if (status === 'accepted') throw conflict('该成员已在任务中');
      if (status === 'invited') throw conflict('已经邀请过，等待对方接受');
    }

    const id = existing ? String(existing.id) : this.ctx.newId();
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      if (existing) {
        await tx.run(
          `UPDATE task_participants
           SET status = 'invited', agent_id = NULL, note = :note, invited_by = :invitedBy,
               responded_at = NULL, created_at = :at
           WHERE id = :id`,
          { id, note, invitedBy: actor.id, at },
        );
      } else {
        await tx.run(
          `INSERT INTO task_participants(id, task_id, workspace, human_principal_id, account_id,
                                         invited_by, status, agent_id, note, created_at, responded_at)
           VALUES(:id, :taskId, :workspace, :human, :account, :invitedBy, 'invited', NULL, :note, :at, NULL)`,
          {
            id,
            taskId: task.id,
            workspace: actor.workspace,
            human: invitee.id,
            account: invitee.accountId,
            invitedBy: actor.id,
            note,
            at,
          },
        );
      }
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: 'participant_invited',
        payload: { participantId: id, humanPrincipalId: invitee.id, to: invitee.id },
      });
    });
    return this.participantById(id, actor.workspace);
  }

  /** 我收到的、还没回应的任务邀请。 */
  async invitations(actor: Principal): Promise<TaskInvitation[]> {
    if (actor.kind !== 'human') throw forbidden('只有人可以接受任务邀请');
    const rows = await this.ctx.db.read.all(
      `SELECT p.*, h.display_name AS human_name, a.display_name AS agent_name,
              inv.display_name AS inviter_name,
              (SELECT value FROM account_links e WHERE e.account_id = p.account_id AND e.kind = 'email' LIMIT 1) AS email,
              t.title AS task_title, t.status AS task_status
       FROM task_participants p
       JOIN principals h ON h.id = p.human_principal_id
       JOIN tasks t ON t.id = p.task_id
       LEFT JOIN principals inv ON inv.id = p.invited_by
       LEFT JOIN principals a ON a.id = p.agent_id
       WHERE p.workspace = :workspace AND p.human_principal_id = :human AND p.status = 'invited'
       ORDER BY p.created_at`,
      { workspace: actor.workspace, human: actor.id },
    );
    return rows.map(row => ({
      ...toParticipant(row),
      taskTitle: String(row.task_title),
      taskStatus: String(row.task_status) as TaskStatus,
      invitedByName: String(row.inviter_name ?? row.invited_by),
    }));
  }

  /** 接受邀请：必须选一个自己的智能体，之后由它进入协作。 */
  async acceptInvitation(actor: Principal, participantId: string, body: unknown): Promise<TaskParticipant> {
    const row = await this.invitationRow(actor, participantId);
    if (String(row.status) !== 'invited') throw conflict('该邀请已经处理过');
    const agent = asId(asObject(body).agent, 'agent');
    await this.ownedAgent(actor, agent);
    const task = await loadTask(this.ctx, actor, String(row.task_id));
    if (!OPEN_TASK_STATUSES.includes(task.status)) throw conflict('任务已结束，无法接受邀请');

    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      const changed = await tx.run(
        `UPDATE task_participants SET status = 'accepted', agent_id = :agent, responded_at = :at
         WHERE id = :id AND status = 'invited'`,
        { agent, at, id: participantId },
      );
      if (changed === 0) throw conflict('该邀请已经处理过');
      await appendEvent(this.ctx, tx, {
        taskId: String(row.task_id),
        actorId: actor.id,
        type: 'participant_accepted',
        payload: { participantId, agentId: agent },
      });
    });
    return this.participantById(participantId, actor.workspace);
  }

  async declineInvitation(actor: Principal, participantId: string, body: unknown): Promise<TaskParticipant> {
    const row = await this.invitationRow(actor, participantId);
    if (String(row.status) !== 'invited') throw conflict('该邀请已经处理过');
    const note = asString(asObject(body).note ?? '', 'note', { max: 1000, min: 0 });
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      const changed = await tx.run(
        `UPDATE task_participants SET status = 'declined', note = :note, responded_at = :at
         WHERE id = :id AND status = 'invited'`,
        { note, at, id: participantId },
      );
      if (changed === 0) throw conflict('该邀请已经处理过');
      await appendEvent(this.ctx, tx, {
        taskId: String(row.task_id),
        actorId: actor.id,
        type: 'participant_declined',
        payload: { participantId, note },
      });
    });
    return this.participantById(participantId, actor.workspace);
  }

  /** 已接受的参与人可以换一个自己的智能体，不必重新邀请。 */
  async selectAgent(actor: Principal, participantId: string, body: unknown): Promise<TaskParticipant> {
    const row = await this.ctx.db.read.one(
      'SELECT * FROM task_participants WHERE id = :id AND workspace = :workspace AND human_principal_id = :human',
      { id: participantId, workspace: actor.workspace, human: actor.id },
    );
    if (!row) throw notFound('参与记录不存在');
    if (String(row.status) !== 'accepted') throw conflict('只有已接受的参与人可以更换智能体');
    const task = await loadTask(this.ctx, actor, String(row.task_id));
    if (!OPEN_TASK_STATUSES.includes(task.status)) throw conflict('任务已结束，无法更换智能体');
    const agent = asId(asObject(body).agent, 'agent');
    await this.ownedAgent(actor, agent);

    await this.ctx.db.transaction(async tx => {
      await tx.run('UPDATE task_participants SET agent_id = :agent WHERE id = :id', {
        agent,
        id: participantId,
      });
      await appendEvent(this.ctx, tx, {
        taskId: String(row.task_id),
        actorId: actor.id,
        type: 'participant_agent_selected',
        payload: { participantId, agentId: agent, previous: String(row.agent_id ?? '') },
      });
    });
    return this.participantById(participantId, actor.workspace);
  }

  /** 发起人或协调者撤销参与；撤销不删除历史，只把状态改成 revoked。 */
  async revoke(actor: Principal, taskId: string, participantId: string): Promise<TaskParticipant> {
    const task = await readTask(this.ctx, actor, taskId);
    await assertCoordinator(this.ctx, actor, task);
    const row = await this.ctx.db.read.one(
      'SELECT * FROM task_participants WHERE id = :id AND task_id = :taskId AND workspace = :workspace',
      { id: participantId, taskId: task.id, workspace: actor.workspace },
    );
    if (!row) throw notFound('参与记录不存在');
    if (String(row.status) === 'revoked') throw conflict('该成员已被撤销');
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE task_participants SET status = 'revoked', responded_at = :at WHERE id = :id`,
        { at, id: participantId },
      );
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: 'participant_revoked',
        payload: { participantId, humanPrincipalId: String(row.human_principal_id) },
      });
    });
    return this.participantById(participantId, actor.workspace);
  }

  // ---------------------------------------------------------------- 协商请求

  /**
   * 发起一次协作请求。
   *
   * `coordinate`：把整个任务交给一个协调智能体（委派）；
   * `subtask`：把一段具体工作交出去（分配子任务）。
   * 两者走同一条接口，接受后才真正落成协调者或子任务。
   */
  async propose(actor: Principal, taskId: string, body: unknown): Promise<TaskRequest> {
    const task = await readTask(this.ctx, actor, taskId);
    const input = asObject(body);
    const role = asEnum(input.role, 'role', REQUEST_ROLES);
    if (role === 'coordinate') assertOwner(actor, task);
    else await assertCoordinator(this.ctx, actor, task);
    if (!OPEN_TASK_STATUSES.includes(task.status)) throw conflict('任务已结束，无法发起协作请求');

    const to = asId(input.to, 'to');
    if (to === actor.id) throw conflict('不能把工作请求发给自己');
    const target = await this.ctx.db.read.one(
      'SELECT * FROM principals WHERE id = :id AND workspace = :workspace AND active = 1',
      { id: to, workspace: actor.workspace },
    );
    if (!target) throw invalid('目标主体不存在或已停用');
    const targetRoles = JSON.parse(String(target.roles)) as string[];
    if (!targetRoles.includes('agent')) throw invalid('只能把工作请求发给智能体主体');

    const payload = await this.requestTerms(actor, task.id, role, input);
    const pending = await this.ctx.db.read.one(
      `SELECT 1 AS present FROM task_requests
       WHERE task_id = :taskId AND to_principal = :to AND role = :role
         AND status IN ('proposed','countered')`,
      { taskId: task.id, to, role },
    );
    if (pending) throw conflict('已有待回应的同类请求，请先撤回或等待结果');
    if (role === 'subtask') {
      const duplicate = await this.ctx.db.read.one(
        'SELECT id FROM subtasks WHERE task_id = :taskId AND agent_id = :agent AND kind = :kind',
        { taskId: task.id, agent: to, kind: String(payload.kind) },
      );
      if (duplicate) throw conflict('该智能体已承担同类子任务');
    }

    const id = this.ctx.newId();
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO task_requests(id, workspace, task_id, from_principal, to_principal, role,
                                   payload, counter, response_note, status, subtask_id, created_at, responded_at)
         VALUES(:id, :workspace, :taskId, :from, :to, :role, :payload, NULL, NULL, 'proposed', NULL, :at, NULL)`,
        {
          id,
          workspace: actor.workspace,
          taskId: task.id,
          from: actor.id,
          to,
          role,
          payload: encode(payload),
          at,
        },
      );
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: 'request_proposed',
        payload: { requestId: id, to, role, kind: payload.kind ?? null },
      });
    });
    return this.requestById(id, actor.workspace);
  }

  /**
   * 收件箱 / 发件箱。
   * 收件箱也包含发给「自己名下智能体」的请求：页面上人替自己的智能体回应，
   * 但落库的仍是那个智能体。
   */
  async requests(
    actor: Principal,
    options: { box?: string; taskId?: string; status?: string } = {},
  ): Promise<TaskRequestView[]> {
    const outbox = options.box === 'outbox';
    const conditions = ['r.workspace = :workspace'];
    const params: Record<string, unknown> = { workspace: actor.workspace, actor: actor.id, account: actor.accountId };
    if (outbox) {
      conditions.push('r.from_principal = :actor');
    } else {
      conditions.push(`(r.to_principal = :actor OR (
        o.kind = 'agent' AND (
          EXISTS (SELECT 1 FROM agent_grants g
                  WHERE g.agent_principal_id = r.to_principal AND g.tenant_id = r.workspace
                    AND g.status = 'active' AND g.owner_principal_id = :actor)
          OR (o.account_id IS NOT NULL AND o.account_id = :account))))`);
    }
    if (options.taskId) {
      conditions.push('r.task_id = :taskId');
      params.taskId = options.taskId;
    }
    if (options.status) {
      asEnum(options.status, 'status', REQUEST_STATUSES);
      conditions.push('r.status = :status');
      params.status = options.status;
    }
    const rows = await this.ctx.db.read.all(
      `SELECT r.*, t.title AS task_title, f.display_name AS from_name, o.display_name AS to_name
       FROM task_requests r
       JOIN tasks t ON t.id = r.task_id
       JOIN principals f ON f.id = r.from_principal
       JOIN principals o ON o.id = r.to_principal
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.created_at, r.id
       LIMIT 100`,
      params,
    );
    return rows.map(toRequestView);
  }

  /** 任务视角的全部协商记录：负责人、协调者与参与人看得到分工是怎么谈成的。 */
  async taskRequests(actor: Principal, taskId: string): Promise<TaskRequestView[]> {
    const task = await readTask(this.ctx, actor, taskId);
    const rows = await this.ctx.db.read.all(
      `SELECT r.*, t.title AS task_title, f.display_name AS from_name, o.display_name AS to_name
       FROM task_requests r
       JOIN tasks t ON t.id = r.task_id
       JOIN principals f ON f.id = r.from_principal
       JOIN principals o ON o.id = r.to_principal
       WHERE r.task_id = :taskId AND r.workspace = :workspace
       ORDER BY r.created_at, r.id`,
      { taskId: task.id, workspace: actor.workspace },
    );
    return rows.map(toRequestView);
  }

  /** 被邀请的智能体接受：普通请求直接落库，还价过的请求要等发起方确认。 */
  async acceptRequest(actor: Principal, requestId: string): Promise<{ id: string; status: 'accepted'; subtaskId: string | null }> {
    const request = await this.requestForTarget(actor, requestId);
    if (request.status !== 'proposed') throw conflict('该请求当前不能接受');
    return this.materialize(actor, request, request.payload, 'request_accepted');
  }

  async declineRequest(actor: Principal, requestId: string, body: unknown): Promise<TaskRequest> {
    const request = await this.requestForTarget(actor, requestId);
    if (request.status !== 'proposed') throw conflict('该请求当前不能拒绝');
    const note = asString(asObject(body).reason ?? asObject(body).note ?? '', 'reason', { max: 1000, min: 0 });
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      const changed = await tx.run(
        `UPDATE task_requests SET status = 'declined', response_note = :note, responded_at = :at
         WHERE id = :id AND status = 'proposed'`,
        { note, at, id: requestId },
      );
      if (changed === 0) throw conflict('请求状态已变化');
      await appendEvent(this.ctx, tx, {
        taskId: request.taskId,
        actorId: actor.id,
        type: 'request_declined',
        payload: { requestId, from: request.fromPrincipal, note },
      });
    });
    return this.requestById(requestId, actor.workspace);
  }

  /** 还价：给出自己能接受的期限或工作粒度，等发起方确认。 */
  async counterRequest(actor: Principal, requestId: string, body: unknown): Promise<TaskRequest> {
    const request = await this.requestForTarget(actor, requestId);
    if (request.status !== 'proposed') throw conflict('该请求当前不能还价');
    const terms = await this.requestTerms(actor, request.taskId, request.role, asObject(body), true);
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      const changed = await tx.run(
        `UPDATE task_requests SET status = 'countered', counter = :counter, responded_at = :at
         WHERE id = :id AND status = 'proposed'`,
        { counter: encode(terms), at, id: requestId },
      );
      if (changed === 0) throw conflict('请求状态已变化');
      await appendEvent(this.ctx, tx, {
        taskId: request.taskId,
        actorId: actor.id,
        type: 'request_countered',
        payload: { requestId, from: request.fromPrincipal, terms },
      });
    });
    return this.requestById(requestId, actor.workspace);
  }

  /** 发起方接受还价：用还价条件落库。 */
  async confirmRequest(actor: Principal, requestId: string): Promise<{ id: string; status: 'accepted'; subtaskId: string | null }> {
    const request = await this.requestById(requestId, actor.workspace);
    if (request.fromPrincipal !== actor.id) throw forbidden('只有发起方可以确认还价');
    if (request.status !== 'countered' || !request.counter) throw conflict('该请求没有待确认的还价');
    const merged = { ...request.payload, ...request.counter };
    return this.materialize(actor, request, merged, 'request_confirmed');
  }

  async withdrawRequest(actor: Principal, requestId: string): Promise<TaskRequest> {
    const request = await this.requestById(requestId, actor.workspace);
    if (request.fromPrincipal !== actor.id) throw forbidden('只有发起方可以撤回请求');
    if (!['proposed', 'countered'].includes(request.status)) throw conflict('该请求当前不能撤回');
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      const changed = await tx.run(
        `UPDATE task_requests SET status = 'withdrawn', responded_at = :at
         WHERE id = :id AND status IN ('proposed','countered')`,
        { at, id: requestId },
      );
      if (changed === 0) throw conflict('请求状态已变化');
      await appendEvent(this.ctx, tx, {
        taskId: request.taskId,
        actorId: actor.id,
        type: 'request_withdrawn',
        payload: { requestId, to: request.toPrincipal },
      });
    });
    return this.requestById(requestId, actor.workspace);
  }

  // ---------------------------------------------------------------- 内部

  private async resolveInvitee(actor: Principal, input: Record<string, unknown>): Promise<Principal> {
    if (input.principal !== undefined) {
      const id = asId(input.principal, 'principal');
      const row = await this.ctx.db.read.one(
        'SELECT * FROM principals WHERE id = :id AND workspace = :workspace AND active = 1',
        { id, workspace: actor.workspace },
      );
      if (!row) throw invalid('成员不存在或已停用');
      return this.human(row);
    }
    if (input.email !== undefined) {
      const email = asString(input.email, 'email', { max: 254, min: 3 }).toLowerCase();
      const row = await this.ctx.db.read.one(
        `SELECT p.* FROM principals p
         JOIN account_links e ON e.account_id = p.account_id AND e.kind = 'email'
         WHERE e.value = :email AND p.workspace = :workspace AND p.active = 1
         LIMIT 1`,
        { email, workspace: actor.workspace },
      );
      if (!row) throw invalid('这个邮箱还不是本团队的人，请先邀请加入团队');
      return this.human(row);
    }
    throw invalid('请提供 principal 或 email');
  }

  private human(row: Row): Principal {
    if (String(row.kind) !== 'human') throw invalid('任务邀请的对象必须是人，智能体由主人选定');
    return {
      id: String(row.id),
      workspace: String(row.workspace),
      roles: JSON.parse(String(row.roles ?? '[]')) as Principal['roles'],
      accountId: row.account_id === null || row.account_id === undefined ? null : String(row.account_id),
      tenantRole: String(row.tenant_role ?? 'member') as Principal['tenantRole'],
      did: row.did === null || row.did === undefined ? null : String(row.did),
      kind: 'human',
      handle: row.handle === null || row.handle === undefined ? null : String(row.handle),
      displayName: String(row.display_name ?? ''),
      avatar: String(row.avatar ?? ''),
      title: String(row.title ?? ''),
      bio: String(row.bio ?? ''),
      description: String(row.description ?? ''),
      capabilities: JSON.parse(String(row.capabilities ?? '[]')) as string[],
      active: Number(row.active) === 1,
    };
  }

  private async invitationRow(actor: Principal, participantId: string): Promise<Row> {
    if (actor.kind !== 'human') throw forbidden('只有人可以处理任务邀请');
    const row = await this.ctx.db.read.one(
      `SELECT * FROM task_participants
       WHERE id = :id AND workspace = :workspace AND human_principal_id = :human`,
      { id: participantId, workspace: actor.workspace, human: actor.id },
    );
    if (!row) throw notFound('任务邀请不存在');
    return row;
  }

  private async participantById(id: string, workspace: string): Promise<TaskParticipant> {
    // 请求级的写事务还没提交，只读连接看不到新行；有外层事务时复用它。
    const db = activeTransaction() ?? this.ctx.db.read;
    const row = await db.one(
      `SELECT p.*, h.display_name AS human_name,
              (SELECT value FROM account_links e WHERE e.account_id = p.account_id AND e.kind = 'email' LIMIT 1) AS email,
              a.display_name AS agent_name
       FROM task_participants p
       JOIN principals h ON h.id = p.human_principal_id
       LEFT JOIN principals a ON a.id = p.agent_id
       WHERE p.id = :id AND p.workspace = :workspace`,
      { id, workspace },
    );
    if (!row) throw notFound('参与记录不存在');
    return toParticipant(row);
  }

  /**
   * 智能体必须属于这个人：设备授权记录的主人是本人，或两者挂在同一个账号下。
   * 只按“同一租户里的智能体”放行会让被邀请人把别人的智能体拉进任务。
   */
  private async ownsAgent(human: Principal, agentId: string): Promise<boolean> {
    const row = await this.ctx.db.read.one(
      `SELECT 1 AS present FROM principals p
       LEFT JOIN agent_grants g
         ON g.agent_principal_id = p.id AND g.tenant_id = p.workspace AND g.status = 'active'
       WHERE p.id = :id AND p.workspace = :workspace
         AND p.kind = 'agent' AND p.active = 1
         AND (g.owner_principal_id = :human
              OR (p.account_id IS NOT NULL AND :account IS NOT NULL AND p.account_id = :account))
       LIMIT 1`,
      { id: agentId, workspace: human.workspace, human: human.id, account: human.accountId },
    );
    return row !== undefined;
  }

  private async ownedAgent(human: Principal, agentId: string): Promise<void> {
    if (!(await this.ownsAgent(human, agentId))) throw invalid('只能选择自己的智能体');
  }

  private async requestById(id: string, workspace: string): Promise<TaskRequest> {
    const db = activeTransaction() ?? this.ctx.db.read;
    const row = await db.one('SELECT * FROM task_requests WHERE id = :id AND workspace = :workspace', {
      id,
      workspace,
    });
    if (!row) throw notFound('协作请求不存在');
    return toRequest(row);
  }

  /**
   * 被请求的智能体本人，或它的人主人。人在页面上替自己的智能体回应，
   * 但接受后落库的仍然是那个智能体。
   */
  private async requestForTarget(actor: Principal, requestId: string): Promise<TaskRequest> {
    const request = await this.requestById(requestId, actor.workspace);
    if (request.toPrincipal === actor.id) return request;
    if (actor.kind === 'human' && (await this.ownsAgent(actor, request.toPrincipal))) return request;
    throw forbidden('只有被邀请的智能体或其主人可以处理该请求');
  }

  /** 统一校验两类请求的条款，还价时只接受能改的那几项。 */
  private async requestTerms(
    actor: Principal,
    taskId: string,
    role: RequestRole,
    input: Record<string, unknown>,
    counter = false,
  ): Promise<Record<string, unknown>> {
    const note = input.note === undefined ? '' : asString(input.note, 'note', { max: 1000, min: 0 });
    if (role === 'coordinate') return { note };
    const kind =
      input.kind === undefined && counter
        ? undefined
        : asString(input.kind, 'kind', { max: 100, pattern: KIND_PATTERN });
    const dueAt =
      input.dueAt === undefined ? undefined : asTimestamp(input.dueAt, 'dueAt');
    let dependsOn: string[] | undefined;
    if (input.dependsOn !== undefined) {
      if (!Array.isArray(input.dependsOn)) throw invalid('dependsOn 必须是子任务 ID 数组');
      dependsOn = input.dependsOn.map((item, index) => asId(item, `dependsOn[${index}]`));
      if (new Set(dependsOn).size !== dependsOn.length) throw invalid('dependsOn 存在重复项');
      for (const dependency of dependsOn) {
        const row = await this.ctx.db.read.one(
          'SELECT id FROM subtasks WHERE id = :id AND task_id = :taskId',
          { id: dependency, taskId },
        );
        if (!row) throw invalid('依赖的子任务必须属于同一任务');
      }
    }
    if (counter && kind === undefined && dueAt === undefined && dependsOn === undefined && note === '') {
      throw invalid('还价至少要修改期限、粒度或说明中的一项');
    }
    return {
      ...(kind === undefined ? {} : { kind }),
      ...(dueAt === undefined ? {} : { dueAt }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
      note,
    };
  }

  /**
   * 把协商结果落成真正的协作关系。
   * 子任务直接以 accepted 建立，因为接受动作已经完成了状态机里的那一步邀请。
   */
  private async materialize(
    actor: Principal,
    request: TaskRequest,
    terms: Record<string, unknown>,
    eventType: 'request_accepted' | 'request_confirmed',
  ): Promise<{ id: string; status: 'accepted'; subtaskId: string | null }> {
    const task = await loadTask(this.ctx, actor, request.taskId);
    if (!OPEN_TASK_STATUSES.includes(task.status)) throw conflict('任务已结束，无法接受该请求');
    const at = this.ctx.now();
    let subtaskId: string | null = null;

    await this.ctx.db.transaction(async tx => {
      if (request.role === 'coordinate') {
        const exists = await tx.one(
          'SELECT 1 AS present FROM task_coordinators WHERE task_id = :taskId AND principal_id = :principal',
          { taskId: task.id, principal: request.toPrincipal },
        );
        if (exists) throw conflict('该主体已是本任务的协调者');
        await tx.run('INSERT INTO task_coordinators(task_id, principal_id) VALUES(:taskId, :principal)', {
          taskId: task.id,
          principal: request.toPrincipal,
        });
      } else {
        const kind = String(terms.kind ?? '');
        if (!kind) throw invalid('协作请求缺少子任务类型');
        const duplicate = await tx.one(
          'SELECT id FROM subtasks WHERE task_id = :taskId AND agent_id = :agent AND kind = :kind',
          { taskId: task.id, agent: request.toPrincipal, kind },
        );
        if (duplicate) throw conflict('该智能体已承担同类子任务');
        subtaskId = this.ctx.newId();
        const dueAt = typeof terms.dueAt === 'string' ? terms.dueAt : task.dueAt;
        await tx.run(
          `INSERT INTO subtasks(id, task_id, agent_id, kind, status, result, due_at, version, created_at, updated_at)
           VALUES(:id, :taskId, :agent, :kind, 'accepted', NULL, :dueAt, 1, :at, :at)`,
          { id: subtaskId, taskId: task.id, agent: request.toPrincipal, kind, dueAt, at },
        );
        const dependencies = Array.isArray(terms.dependsOn) ? (terms.dependsOn as string[]) : [];
        for (const dependency of dependencies) {
          await tx.run(
            'INSERT INTO subtask_dependencies(subtask_id, depends_on) VALUES(:subtask, :dependsOn)',
            { subtask: subtaskId, dependsOn: dependency },
          );
        }
        if (task.status === 'pending') {
          await tx.run("UPDATE tasks SET status = 'running', updated_at = :at WHERE id = :taskId", {
            at,
            taskId: task.id,
          });
        }
      }

      const changed = await tx.run(
        `UPDATE task_requests SET status = 'accepted', subtask_id = :subtask, responded_at = :at
         WHERE id = :id AND status = :expected`,
        {
          subtask: subtaskId,
          at,
          id: request.id,
          expected: eventType === 'request_confirmed' ? 'countered' : 'proposed',
        },
      );
      if (changed === 0) throw conflict('请求状态已变化，请重新读取后再操作');
      await appendEvent(this.ctx, tx, {
        taskId: task.id,
        actorId: actor.id,
        type: eventType,
        payload: { requestId: request.id, role: request.role, subtaskId },
      });
    });
    return { id: request.id, status: 'accepted', subtaskId };
  }
}
