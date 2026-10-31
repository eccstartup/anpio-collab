/**
 * 内嵌智能体：定义、运行记录与派生身份。
 *
 * 平台只保存"这个智能体该怎么干活"，运行由 supervisor 拉起的一次性子进程完成。
 * 管理端与运行时都经过这里，因此列表、启停、运行与日志的权限判断只有一份。
 */

import { randomUUID } from 'node:crypto';
import { AppError, conflict, forbidden, notFound } from '../../protocol/errors.ts';
import {
  asBoolean,
  asEnum,
  asInteger,
  asObject,
  asOptionalString,
  asString,
} from '../../protocol/parse.ts';
import type { AgentScope, Principal } from '../../protocol/types.ts';
import type { Context } from '../context.ts';
import type { Queryable } from '../db/driver.ts';
import { requireRole } from './access.ts';
import { hashToken } from './principals.ts';
import { rolesFor } from './tenants.ts';
import type { MailboxService } from './mailbox.ts';
import {
  normalizeDefinition,
  type EmbeddedAgentDefinition,
  type NormalizedDefinition,
} from '../../runtime/definition.ts';
import { PROVIDERS } from '../../runtime/providers.ts';
import { deriveEmbeddedToken } from '../../runtime/token.ts';

const RUN_STATUSES = ['running', 'succeeded', 'failed', 'timeout', 'outcome_unknown'] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const GRANT_DAYS = 30;
const MAX_LOG_BYTES = 8_000;

type AgentRow = Record<string, unknown>;
type RunRow = Record<string, unknown>;

export type EmbeddedRun = {
  id: string;
  agentId: string;
  principalId: string | null;
  sessionId: string | null;
  triggerMessageId: string | null;
  status: RunStatus;
  workdir: string | null;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
  exitCode: number | null;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  outcomeUnknown: boolean;
  error: string | null;
};

export type EmbeddedRunLog = {
  seq: number;
  at: string;
  level: LogLevel;
  text: string;
};

export type EmbeddedAgentView = EmbeddedAgentDefinition & {
  unread: number;
  running: number;
};

export class EmbeddedService {
  private readonly ctx: Context;
  private readonly mailbox: MailboxService;

  constructor(ctx: Context, mailbox: MailboxService) {
    this.ctx = ctx;
    this.mailbox = mailbox;
  }

  // ------------------------------------------------------------------ 定义

  providers() {
    return PROVIDERS;
  }

  async list(actor: Principal): Promise<EmbeddedAgentView[]> {
    this.requireManage(actor);
    const rows = await this.ctx.db.read.all<AgentRow>(
      'SELECT * FROM embedded_agents WHERE workspace = :workspace ORDER BY created_at',
      { workspace: actor.workspace },
    );
    const result: EmbeddedAgentView[] = [];
    for (const row of rows) {
      const agent = this.toAgent(row);
      result.push({
        ...agent,
        unread: agent.id ? await this.unread(agent) : 0,
        running: await this.runningCount(agent.id),
      });
    }
    return result;
  }

  async get(actor: Principal, agentId: string): Promise<EmbeddedAgentView> {
    this.requireManage(actor);
    const agent = this.toAgent(await this.agentRow(actor.workspace, agentId));
    return {
      ...agent,
      unread: await this.unread(agent),
      running: await this.runningCount(agent.id),
    };
  }

  async create(actor: Principal, body: unknown): Promise<EmbeddedAgentView> {
    this.requireManage(actor);
    const definition = normalizeDefinition(body);
    await this.assertNameFree(actor.workspace, definition.name);
    const id = `emb_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO embedded_agents(id, workspace, principal_id, name, description, capabilities,
                                     provider, system_prompt, tools, scopes, limits, sandbox,
                                     enabled, concurrency, created_by, created_at, updated_at)
         VALUES(:id, :workspace, NULL, :name, :description, :capabilities,
                :provider, :systemPrompt, :tools, :scopes, :limits, :sandbox,
                :enabled, :concurrency, :by, :at, :at)`,
        this.agentParams(id, actor.workspace, definition, actor.id, at),
      );
    });
    return this.get(actor, id);
  }

  /** 部分更新：只覆盖请求里出现的字段，其余保持原值。 */
  async update(actor: Principal, agentId: string, body: unknown): Promise<EmbeddedAgentView> {
    this.requireManage(actor);
    const current = this.toAgent(await this.agentRow(actor.workspace, agentId));
    const input = asObject(body, 'body');
    const merged = {
      ...definitionOf(current),
      ...input,
      provider: mergeObject(definitionOf(current).provider, input.provider),
      limits: mergeObject(definitionOf(current).limits, input.limits),
      sandbox: mergeObject(definitionOf(current).sandbox, input.sandbox),
    };
    const definition = normalizeDefinition(merged);
    if (definition.name !== current.name) await this.assertNameFree(actor.workspace, definition.name);
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE embedded_agents
         SET name = :name, description = :description, capabilities = :capabilities,
             provider = :provider, system_prompt = :systemPrompt, tools = :tools,
             scopes = :scopes, limits = :limits, sandbox = :sandbox,
             enabled = :enabled, concurrency = :concurrency, updated_at = :at
         WHERE id = :id AND workspace = :workspace`,
        { ...this.agentParams(agentId, actor.workspace, definition, actor.id, at), at },
      );
    });
    return this.get(actor, agentId);
  }

  async remove(actor: Principal, agentId: string): Promise<{ id: string; removed: true }> {
    this.requireManage(actor);
    const agent = this.toAgent(await this.agentRow(actor.workspace, agentId));
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `DELETE FROM embedded_run_logs
         WHERE run_id IN (SELECT id FROM embedded_runs WHERE agent_id = :id AND workspace = :workspace)`,
        { id: agentId, workspace: actor.workspace },
      );
      await tx.run('DELETE FROM embedded_runs WHERE agent_id = :id AND workspace = :workspace', {
        id: agentId,
        workspace: actor.workspace,
      });
      await tx.run('DELETE FROM embedded_agents WHERE id = :id AND workspace = :workspace', {
        id: agentId,
        workspace: actor.workspace,
      });
      if (agent.principalId) {
        await tx.run(
          `UPDATE agent_grants SET status = 'revoked', revoked_at = :at
           WHERE agent_principal_id = :principal AND status = 'active'`,
          { at: this.ctx.now(), principal: agent.principalId },
        );
        await tx.run('UPDATE principals SET active = 0 WHERE id = :id', { id: agent.principalId });
      }
    });
    return { id: agentId, removed: true };
  }

  async setEnabled(actor: Principal, agentId: string, enabled: boolean) {
    this.requireManage(actor);
    await this.agentRow(actor.workspace, agentId);
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        'UPDATE embedded_agents SET enabled = :enabled, updated_at = :at WHERE id = :id AND workspace = :workspace',
        { enabled: enabled ? 1 : 0, at: this.ctx.now(), id: agentId, workspace: actor.workspace },
      );
    });
    return { id: agentId, enabled };
  }

  /** 从 definitions 文件批量落库（按 name 覆盖），supervisor 启动时用。 */
  async import(actor: Principal, body: unknown) {
    this.requireManage(actor);
    const input = asObject(body, 'body');
    if (!Array.isArray(input.agents)) throw conflict('agents 必须是数组');
    if (input.agents.length > 50) throw conflict('一次最多导入 50 个定义');
    const ids: string[] = [];
    for (const item of input.agents) {
      const definition = normalizeDefinition(item);
      const existing = await this.ctx.db.read.one(
        'SELECT id FROM embedded_agents WHERE workspace = :workspace AND name = :name',
        { workspace: actor.workspace, name: definition.name },
      );
      if (existing) {
        ids.push(String(existing.id));
        await this.update(actor, String(existing.id), definitionOfRaw(definition));
      } else {
        ids.push((await this.create(actor, definitionOfRaw(definition))).id);
      }
    }
    return { imported: ids };
  }

  // ------------------------------------------------------------------ 派生身份

  /**
   * 幂等地把定义变成可登录的主体：令牌由 secret 与 agentId 派生，
   * 数据库只存摘要；重复调用只更新授权与摘要，不动其它数据。
   */
  async ensure(actor: Principal, agentId: string) {
    if (!this.ctx.db) throw new AppError('internal', '数据库不可用');
    if (!isAdmin(actor)) throw forbidden('只有所有者或管理员可以为内嵌智能体创建身份');
    const agent = this.toAgent(await this.agentRow(actor.workspace, agentId));
    const secret = process.env.COLLAB_EMBEDDED_SECRET ?? '';
    if (!secret) throw new AppError('internal', '服务器未配置 COLLAB_EMBEDDED_SECRET');
    const token = deriveEmbeddedToken(secret, agent.id);
    const principalId = agent.principalId ?? `embedded-${agent.id}`;
    const at = this.ctx.now();
    const expiresAt = new Date(Date.parse(at) + GRANT_DAYS * 24 * 3600 * 1000).toISOString();

    await this.ctx.db.transaction(async tx => {
      const existing = await tx.one('SELECT id FROM principals WHERE id = :id AND workspace = :workspace', {
        id: principalId,
        workspace: actor.workspace,
      });
      if (existing) {
        await tx.run(
          `UPDATE principals SET active = 1, token_hash = :hash, display_name = :name,
             capabilities = :capabilities, kind = 'agent', tenant_role = 'member', roles = :roles
           WHERE id = :id AND workspace = :workspace`,
          {
            hash: hashToken(token),
            name: `${agent.name}（内嵌）`,
            capabilities: JSON.stringify(agent.capabilities),
            roles: JSON.stringify(rolesFor('member', 'agent')),
            id: principalId,
            workspace: actor.workspace,
          },
        );
      } else {
        await tx.run(
          `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name,
                                  description, capabilities, active, created_at, account_id, tenant_role)
           VALUES(:id, :workspace, :roles, :hash, NULL, 'agent', NULL, :name,
                  :description, :capabilities, 1, :at, NULL, 'member')`,
          {
            id: principalId,
            workspace: actor.workspace,
            roles: JSON.stringify(rolesFor('member', 'agent')),
            hash: hashToken(token),
            name: `${agent.name}（内嵌）`,
            description: agent.description,
            capabilities: JSON.stringify(agent.capabilities),
            at,
          },
        );
      }
      const grant = await tx.one('SELECT id FROM agent_grants WHERE agent_principal_id = :agent', {
        agent: principalId,
      });
      const scopes: AgentScope[] = agent.scopes;
      if (grant) {
        await tx.run(
          `UPDATE agent_grants SET scopes = :scopes, status = 'active', expires_at = :expiresAt,
             revoked_at = NULL, owner_principal_id = :owner
           WHERE id = :id`,
          {
            scopes: JSON.stringify(scopes),
            expiresAt,
            owner: agent.createdBy ?? actor.id,
            id: String(grant.id),
          },
        );
      } else {
        await tx.run(
          `INSERT INTO agent_grants(id, tenant_id, agent_principal_id, owner_principal_id, scopes,
                                    status, expires_at, created_at)
           VALUES(:id, :tenant, :agent, :owner, :scopes, 'active', :expiresAt, :at)`,
          {
            id: `grant_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            tenant: actor.workspace,
            agent: principalId,
            owner: agent.createdBy ?? actor.id,
            scopes: JSON.stringify(scopes),
            expiresAt,
            at,
          },
        );
      }
      await tx.run('UPDATE embedded_agents SET principal_id = :principal WHERE id = :id', {
        principal: principalId,
        id: agent.id,
      });
    });

    return { id: agent.id, principalId, scopes: agent.scopes, expiresAt };
  }

  // ------------------------------------------------------------------ 运行

  async startRun(actor: Principal, agentId: string, body: unknown): Promise<EmbeddedRun> {
    this.requireManage(actor);
    const agent = this.toAgent(await this.agentRow(actor.workspace, agentId));
    if (!agent.enabled) throw conflict('该内嵌智能体已停用');
    const input = body === undefined || body === null ? {} : asObject(body);
    const messageId = asOptionalString(input.messageId, 'messageId', { max: 128 }) ?? null;
    const workdir = asOptionalString(input.workdir, 'workdir', { max: 500 }) ?? null;
    const trigger = messageId ?? asOptionalString(input.triggerMessageId, 'triggerMessageId', { max: 128 }) ?? null;
    if (await this.runningCount(agent.id)) throw conflict('该内嵌智能体已有一轮在运行');
    const id = this.ctx.newId();
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `INSERT INTO embedded_runs(id, workspace, agent_id, principal_id, session_id, trigger_message_id,
                                   status, workdir, started_at, finished_at, heartbeat_at,
                                   exit_code, turns, prompt_tokens, completion_tokens,
                                   outcome_unknown, error)
         VALUES(:id, :workspace, :agent, :principal, NULL, :trigger,
                'running', :workdir, :at, NULL, :at, NULL, 0, 0, 0, 0, NULL)`,
        {
          id,
          workspace: actor.workspace,
          agent: agent.id,
          // 控制台的「立即运行」可能发生在 supervisor 调 ensure 之前。这里先记下
          // 派生主体，等身份建好，子进程用它的令牌就能写日志、心跳与收尾。
          principal: agent.principalId ?? `embedded-${agent.id}`,
          trigger,
          workdir,
          at,
        },
      );
      await tx.run('UPDATE embedded_agents SET last_run_at = :at WHERE id = :id', { at, id: agent.id });
    });
    return this.toRun((await this.ctx.db.read.one('SELECT * FROM embedded_runs WHERE id = :id', { id })) as RunRow);
  }

  async runs(actor: Principal, agentId: string, limit = 30): Promise<EmbeddedRun[]> {
    this.requireManage(actor);
    await this.agentRow(actor.workspace, agentId);
    const rows = await this.ctx.db.read.all<RunRow>(
      `SELECT * FROM embedded_runs WHERE workspace = :workspace AND agent_id = :agent
       ORDER BY started_at DESC LIMIT :limit`,
      { workspace: actor.workspace, agent: agentId, limit: Math.min(Math.max(limit, 1), 100) },
    );
    return rows.map(row => this.toRun(row));
  }

  async runDetail(actor: Principal, runId: string) {
    const run = this.toRun(await this.runRow(actor, runId));
    const agent = await this.agentRow(actor.workspace, run.agentId);
    return { ...run, agent: { id: String(agent.id), name: String(agent.name) } };
  }

  async logs(actor: Principal, runId: string, options: { limit?: number; since?: number } = {}) {
    await this.runRow(actor, runId);
    const rows = await this.ctx.db.read.all(
      `SELECT seq, at, level, text FROM embedded_run_logs
       WHERE run_id = :run AND seq > :since ORDER BY seq LIMIT :limit`,
      {
        run: runId,
        since: Math.max(0, options.since ?? 0),
        limit: Math.min(Math.max(options.limit ?? 200, 1), 1000),
      },
    );
    return rows.map(row => ({
      seq: Number(row.seq),
      at: String(row.at),
      level: String(row.level) as LogLevel,
      text: String(row.text),
    }));
  }

  /** 子进程追加日志；只有这一轮的主体或管理员可以写。 */
  async appendLog(actor: Principal, runId: string, body: unknown) {
    const run = this.toRun(await this.runRow(actor, runId));
    const level = body === undefined ? 'info' : asEnum(asObject(body).level ?? 'info', 'level', LOG_LEVELS);
    const text = asString(asObject(body).text, 'text', { max: MAX_LOG_BYTES, min: 0 });
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      // seq 是全局自增主键，交给数据库分配。按 run 取 MAX(seq)+1 会与
      // 其它运行已占用的序号冲突（每条运行的日志都从 1 开始）。
      await tx.run(
        `INSERT INTO embedded_run_logs(run_id, at, level, text)
         VALUES(:run, :at, :level, :text)`,
        { run: run.id, at, level, text: truncate(text, MAX_LOG_BYTES) },
      );
    });
    return { runId: run.id, at };
  }

  async heartbeatRun(actor: Principal, runId: string, body: unknown = {}) {
    const run = this.toRun(await this.runRow(actor, runId));
    const input = body === undefined || body === null ? {} : asObject(body);
    const sessionId = asOptionalString(input.sessionId, 'sessionId', { max: 128 }) ?? null;
    const at = this.ctx.now();
    if (sessionId) {
      const session = await this.ctx.db.read.one(
        'SELECT 1 AS present FROM mailbox_sessions WHERE id = :id AND principal_id = :principal',
        { id: sessionId, principal: actor.id },
      );
      if (!session) throw notFound('会话不存在');
    }
    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE embedded_runs SET heartbeat_at = :at, session_id = COALESCE(session_id, :session) WHERE id = :id`,
        { at, session: sessionId, id: run.id },
      );
    });
    return { id: run.id, status: run.status };
  }

  async finishRun(actor: Principal, runId: string, body: unknown) {
    const run = this.toRun(await this.runRow(actor, runId));
    if (run.status !== 'running') return run;
    const input = asObject(body, 'body');
    const status = asEnum(input.status ?? 'succeeded', 'status', RUN_STATUSES.filter(item => item !== 'running'));
    const exitCode = input.exitCode === undefined ? null : asInteger(Number(input.exitCode), 'exitCode', { min: -1, max: 255 });
    const turns = input.turns === undefined ? run.turns : asInteger(Number(input.turns), 'turns', { min: 0, max: 100_000 });
    const promptTokens = input.promptTokens === undefined
      ? run.promptTokens
      : asInteger(Number(input.promptTokens), 'promptTokens', { min: 0 });
    const completionTokens = input.completionTokens === undefined
      ? run.completionTokens
      : asInteger(Number(input.completionTokens), 'completionTokens', { min: 0 });
    const error = asOptionalString(input.error, 'error', { max: 2000 }) ?? null;
    const outcomeUnknown = status === 'outcome_unknown'
      || (input.outcomeUnknown === undefined ? false : asBoolean(input.outcomeUnknown, 'outcomeUnknown'));
    const at = this.ctx.now();

    await this.ctx.db.transaction(async tx => {
      await tx.run(
        `UPDATE embedded_runs
         SET status = :status, finished_at = :at, heartbeat_at = :at, exit_code = :exitCode,
             turns = :turns, prompt_tokens = :promptTokens, completion_tokens = :completionTokens,
             outcome_unknown = :outcomeUnknown, error = :error
         WHERE id = :id`,
        {
          id: run.id,
          status,
          at,
          exitCode,
          turns,
          promptTokens,
          completionTokens,
          outcomeUnknown: outcomeUnknown ? 1 : 0,
          error,
        },
      );
      await tx.run(
        'UPDATE embedded_agents SET last_run_at = :at, last_error = :error WHERE id = :id',
        { at, error: status === 'succeeded' ? null : error, id: run.agentId },
      );
      if (status !== 'succeeded') {
        await this.notifyRunFailure(tx, actor.workspace, run, error ?? status);
      }
    });
    return this.toRun((await this.ctx.db.read.one('SELECT * FROM embedded_runs WHERE id = :id', { id: run.id })) as RunRow);
  }

  /**
   * 回收心跳停滞的运行：标成结果未知，并把这一轮的投递放回队列，
   * 保证未确认的消息仍会再投一次（at-least-once）。
   */
  async recover(actor: Principal, body: unknown = {}) {
    this.requireManage(actor);
    const input = body === undefined ? {} : asObject(body);
    const staleSeconds = asInteger(Number(input.staleSeconds ?? 120), 'staleSeconds', { min: 10, max: 86_400 });
    const at = this.ctx.now();
    const cutoff = new Date(Date.parse(at) - staleSeconds * 1000).toISOString();
    const stale = await this.ctx.db.read.all<RunRow>(
      `SELECT * FROM embedded_runs
       WHERE workspace = :workspace AND status = 'running' AND COALESCE(heartbeat_at, started_at) < :cutoff`,
      { workspace: actor.workspace, cutoff },
    );
    const recovered: string[] = [];
    for (const row of stale) {
      const run = this.toRun(row);
      await this.ctx.db.transaction(async tx => {
        const changed = await tx.run(
          `UPDATE embedded_runs
           SET status = 'outcome_unknown', outcome_unknown = 1, finished_at = :at,
               error = COALESCE(error, '心跳超时，结果未知')
           WHERE id = :id AND status = 'running'`,
          { at, id: run.id },
        );
        if (changed === 0) return;
        recovered.push(run.id);
        await this.releaseRunDeliveries(tx, run, at);
        await tx.run(
          'UPDATE embedded_agents SET last_error = :error WHERE id = :id',
          { error: '上一轮心跳超时，结果未知', id: run.agentId },
        );
        await this.notifyRunFailure(tx, actor.workspace, run, '心跳超时，结果未知');
      });
    }
    return { recovered, staleSeconds };
  }

  /** 把某个会话里未确认的投递退回主体队列。 */
  private async releaseRunDeliveries(tx: Queryable, run: EmbeddedRun, at: string) {
    if (run.sessionId) {
      await tx.run(
        `UPDATE mailbox_deliveries
         SET session_id = NULL, owner_key = :owner, state = 'pending', lease_until = NULL, updated_at = :at
         WHERE session_id = :session AND state IN ('pending', 'leased')`,
        {
          owner: run.principalId ? `queue:${run.principalId}` : 'queue:',
          session: run.sessionId,
          at,
        },
      );
      await tx.run(
        `UPDATE mailbox_sessions SET status = 'closed', closed_at = COALESCE(closed_at, :at) WHERE id = :id`,
        { at, id: run.sessionId },
      );
    }
  }

  /** supervisor 心跳：记录一次自己的存活，供控制台显示"运行时在线"。 */
  async supervisorHeartbeat(actor: Principal, body: unknown) {
    this.requireManage(actor);
    const input = body === undefined ? {} : asObject(body);
    const id = asString(input.id ?? `sup_${randomUUID().replace(/-/g, '').slice(0, 12)}`, 'id', { max: 64 });
    const host = asOptionalString(input.host, 'host', { max: 200 }) ?? 'unknown';
    const pid = asInteger(Number(input.pid ?? process.pid), 'pid', { min: 1 });
    const at = this.ctx.now();
    await this.ctx.db.transaction(async tx => {
      const existing = await tx.one(
        'SELECT id FROM embedded_supervisors WHERE id = :id AND workspace = :workspace',
        { id, workspace: actor.workspace },
      );
      if (existing) {
        await tx.run(
          'UPDATE embedded_supervisors SET host = :host, pid = :pid, last_seen_at = :at WHERE id = :id',
          { host, pid, at, id },
        );
      } else {
        await tx.run(
          `INSERT INTO embedded_supervisors(id, workspace, host, pid, last_seen_at)
           VALUES(:id, :workspace, :host, :pid, :at)`,
          { id, workspace: actor.workspace, host, pid, at },
        );
      }
    });
    return { id, at };
  }

  async status(actor: Principal) {
    this.requireManage(actor);
    const agents = await this.list(actor);
    const supervisors = await this.ctx.db.read.all(
      `SELECT id, host, pid, last_seen_at FROM embedded_supervisors
       WHERE workspace = :workspace ORDER BY last_seen_at DESC LIMIT 20`,
      { workspace: actor.workspace },
    );
    const activeRuns = await this.ctx.db.read.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM embedded_runs WHERE workspace = :workspace AND status = 'running'`,
      { workspace: actor.workspace },
    );
    return {
      agents,
      supervisors: supervisors.map(row => ({
        id: String(row.id),
        host: String(row.host),
        pid: Number(row.pid),
        lastSeenAt: String(row.last_seen_at),
      })),
      activeRuns: Number(activeRuns?.total ?? 0),
    };
  }

  // ------------------------------------------------------------------ 内部

  /**
   * 运行失败/结果未知时，给负责这个定义的人和这个智能体各发一封信。
   * 正文是运行记录，收件人按 `run` 的可见性重新鉴权。
   */
  private async notifyRunFailure(
    tx: Queryable,
    workspace: string,
    run: EmbeddedRun,
    reason: string,
  ): Promise<void> {
    const agent = await tx.one<{ name: string; created_by: string | null }>(
      'SELECT name, created_by FROM embedded_agents WHERE id = :id',
      { id: run.agentId },
    );
    const name = agent ? String(agent.name) : run.agentId;
    const owner = agent?.created_by ? String(agent.created_by) : null;
    const targets = [...new Set([run.principalId, owner].filter((id): id is string => Boolean(id)))];
    for (const target of targets) {
      // 发布者不能同时是收件人，否则 publish 会按"不给自己发信"跳过。
      const publisher = target === run.principalId ? (owner ?? target) : (run.principalId ?? target);
      if (publisher === target) continue;
      await this.mailbox.publish(tx, {
        workspace,
        topic: `ws:${workspace}:principal:${target}`,
        kind: 'run.failed',
        priority: 'next',
        summary: `内置智能体「${name}」运行失败：${reason}`,
        ref: { type: 'run', id: run.id },
        publisherId: publisher,
        expiresAt: null,
        audience: { principals: [target] },
      });
    }
  }

  private requireManage(actor: Principal): void {
    requireRole(actor, 'admin', 'owner');
  }

  private async agentRow(workspace: string, agentId: string): Promise<AgentRow> {
    const row = await this.ctx.db.read.one<AgentRow>(
      'SELECT * FROM embedded_agents WHERE id = :id AND workspace = :workspace',
      { id: agentId, workspace },
    );
    if (!row) throw notFound('内嵌智能体不存在');
    return row;
  }

  private async runRow(actor: Principal, runId: string): Promise<RunRow> {
    const row = await this.ctx.db.read.one<RunRow>(
      'SELECT * FROM embedded_runs WHERE id = :id AND workspace = :workspace',
      { id: runId, workspace: actor.workspace },
    );
    if (!row) throw notFound('运行记录不存在');
    const principalId = row.principal_id === null || row.principal_id === undefined ? null : String(row.principal_id);
    if (!isAdmin(actor) && principalId !== actor.id) throw forbidden('只有这一轮的主体或管理员可以操作运行记录');
    return row;
  }

  private async assertNameFree(workspace: string, name: string): Promise<void> {
    const existing = await this.ctx.db.read.one(
      'SELECT id FROM embedded_agents WHERE workspace = :workspace AND name = :name',
      { workspace, name },
    );
    if (existing) throw conflict('同名内嵌智能体已存在');
  }

  private async runningCount(agentId: string): Promise<number> {
    const row = await this.ctx.db.read.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM embedded_runs WHERE agent_id = :agent AND status = 'running'`,
      { agent: agentId },
    );
    return Number(row?.total ?? 0);
  }

  private async unread(agent: EmbeddedAgentDefinition & { principalId: string | null }): Promise<number> {
    if (!agent.principalId) return 0;
    const row = await this.ctx.db.read.one<{ total: number }>(
      `SELECT COUNT(*) AS total FROM mailbox_deliveries
       WHERE principal_id = :principal AND state IN ('pending', 'leased')
         AND available_at <= :now`,
      { principal: agent.principalId, now: this.ctx.now() },
    );
    return Number(row?.total ?? 0);
  }

  private agentParams(id: string, workspace: string, value: NormalizedDefinition, actorId: string, at: string) {
    return {
      id,
      workspace,
      name: value.name,
      description: value.description,
      capabilities: JSON.stringify(value.capabilities),
      provider: JSON.stringify(value.provider),
      systemPrompt: value.systemPrompt,
      tools: JSON.stringify(value.tools),
      scopes: JSON.stringify(value.scopes),
      limits: JSON.stringify(value.limits),
      sandbox: JSON.stringify(value.sandbox),
      enabled: value.enabled ? 1 : 0,
      concurrency: value.concurrency,
      by: actorId,
      at,
    };
  }

  private toAgent(row: AgentRow): EmbeddedAgentDefinition & { principalId: string | null } {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      capabilities: parseJson(row.capabilities, []),
      provider: parseJson(row.provider, {
        id: 'script',
        protocol: 'script',
        baseUrl: '',
        model: 'script',
        apiKeyEnv: null,
      }),
      systemPrompt: String(row.system_prompt ?? ''),
      tools: parseJson(row.tools, []),
      scopes: parseJson(row.scopes, []),
      limits: parseJson(row.limits, { maxTurns: 8, timeoutMs: 120_000, maxTokens: 8192 }),
      sandbox: parseJson(row.sandbox, { shell: false, shellTimeoutMs: 60_000, maxOutputBytes: 65_536 }),
      enabled: Number(row.enabled) === 1,
      concurrency: Number(row.concurrency ?? 1),
      createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastRunAt: row.last_run_at === null || row.last_run_at === undefined ? null : String(row.last_run_at),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
      principalId: row.principal_id === null || row.principal_id === undefined ? null : String(row.principal_id),
    };
  }

  private toRun(row: RunRow): EmbeddedRun {
    return {
      id: String(row.id),
      agentId: String(row.agent_id),
      principalId: row.principal_id === null || row.principal_id === undefined ? null : String(row.principal_id),
      sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
      triggerMessageId: row.trigger_message_id === null || row.trigger_message_id === undefined
        ? null
        : String(row.trigger_message_id),
      status: String(row.status) as RunStatus,
      workdir: row.workdir === null || row.workdir === undefined ? null : String(row.workdir),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
      heartbeatAt: row.heartbeat_at === null || row.heartbeat_at === undefined ? null : String(row.heartbeat_at),
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
      turns: Number(row.turns ?? 0),
      promptTokens: Number(row.prompt_tokens ?? 0),
      completionTokens: Number(row.completion_tokens ?? 0),
      outcomeUnknown: Number(row.outcome_unknown) === 1,
      error: row.error === null || row.error === undefined ? null : String(row.error),
    };
  }
}

function isAdmin(actor: Principal): boolean {
  return actor.roles.includes('admin');
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function mergeObject(current: unknown, patch: unknown): unknown {
  if (patch === undefined || patch === null) return current;
  const merged = { ...asObject(current, 'current') };
  for (const [key, value] of Object.entries(asObject(patch, 'patch'))) merged[key] = value;
  return merged;
}

function definitionOf(agent: EmbeddedAgentDefinition) {
  return {
    name: agent.name,
    description: agent.description,
    capabilities: agent.capabilities,
    provider: agent.provider,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    scopes: agent.scopes,
    limits: agent.limits,
    sandbox: agent.sandbox,
    enabled: agent.enabled,
    concurrency: agent.concurrency,
  };
}

function definitionOfRaw(value: NormalizedDefinition) {
  return value as unknown as Record<string, unknown>;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
