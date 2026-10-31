/**
 * 第一阶段验收：手动经验、复制与来源链、任务房间。
 *
 * 钉住几条容易松掉的语义：
 *  - 智能体不能创建或发布经验；
 *  - 复制由用户选择目标团队，个人经验只有作者能复制；
 *  - 跨个人空间必须由对方接受邀请，来源撤销后副本仍有明确提示；
 *  - 任务房间把进展、对话与文件合并成一条时间线，团队真人成员可读。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from '../src/platform/db/schema.ts';
import {
  ADMIN_TOKEN,
  emailLogin,
  expectStatus,
  startHarness,
  TASK_INPUT,
  type Harness,
} from './helpers/harness.ts';

const FUTURE = '2099-01-01T00:00:00Z';

const call = async (
  harness: Harness,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
  version?: number,
): Promise<Response> =>
  fetch(`${harness.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async <T = any>(response: Response): Promise<T> => {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as T;
};

type Item = {
  id: string;
  state: string;
  version: number;
  title: string;
  kind: string;
  source: string;
  evidenceLevel: string;
  authorName: string;
  sourceTaskId: string | null;
  copiedFrom: { id: string; workspaceName: string; version: number } | null;
  sourceRevoked: boolean;
  copies: { knowledgeId: string; workspace: string; workspaceName: string }[];
  archivedAt: string | null;
};

const draft = (overrides: Record<string, unknown> = {}) => ({
  kind: 'document',
  title: '缺料先查库存快照',
  summary: '避免重复下单',
  content: '先查库存快照，再确认供应商可供量和交期。',
  tags: ['库存', '补货'],
  ...overrides,
});

const createDraft = async (
  harness: Harness,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<Item> => json<Item>(await call(harness, 'POST', '/v1/documents', token, draft(overrides)));

const publishDraft = async (
  harness: Harness,
  token: string,
  item: Item,
  body: Record<string, unknown> = {},
): Promise<void> => {
  await json(await call(harness, 'POST', `/v1/documents/${item.id}/submit`, token, undefined, item.version));
  await json(
    await call(harness, 'POST', `/v1/documents/${item.id}/publish`, token, {
      expiresAt: FUTURE,
      ...body,
    }),
  );
};

test('经验手动生命周期：草稿可编辑、提交后发布，智能体不能创建或发布', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const created = await createDraft(harness, alice.token);
    assert.equal(created.state, 'draft');
    assert.equal(created.source, 'manual');
    assert.equal(created.evidenceLevel, 'manual');
    assert.equal(created.authorName, 'alice');

    const removable = await createDraft(harness, alice.token, { title: '只用于删除的草稿' });
    const removed = await json<{ id: string; deleted: boolean }>(
      await call(harness, 'POST', `/v1/documents/${removable.id}/delete`, alice.token, {}, removable.version),
    );
    assert.equal(removed.deleted, true);
    assert.equal(
      (await call(harness, 'GET', `/v1/documents/${removable.id}`, alice.token)).status,
      404,
      '删除后不能再读到',
    );

    const edited = await json<Item>(
      await call(harness, 'POST', `/v1/documents/${created.id}/edit`, alice.token, {
        title: '缺料时先查库存快照',
        tags: ['库存'],
      }, 1),
    );
    assert.equal(edited.title, '缺料时先查库存快照');

    const submitted = await json<Item>(
      await call(harness, 'POST', `/v1/documents/${created.id}/submit`, alice.token, undefined, 1),
    );
    assert.equal(submitted.state, 'candidate');

    const token = harness.token('inv-doc');
    await harness.admin.registerPrincipal(
      { id: 'inv-doc', roles: ['agent'], token, displayName: 'inv-doc' },
      'register:inv-doc',
    );
    const agent = harness.client(token);
    await expectStatus(
      agent.request('documents', { method: 'POST', body: draft(), operationId: 'agent-create' }),
      403,
    );

    const published = await json<Item>(
      await call(harness, 'POST', `/v1/documents/${created.id}/publish`, alice.token, {}),
    );
    assert.equal(published.state, 'published');
    const noExpiry = await json<Item & { expiresAt: string | null; conditions: string }>(
      await call(harness, 'GET', `/v1/documents/${created.id}`, alice.token),
    );
    assert.equal(noExpiry.expiresAt, null, '普通文档可以不设有效期');
    assert.equal(noExpiry.conditions, '', '普通文档不要求适用条件');

    const deletePublished = await call(
      harness,
      'POST',
      `/v1/documents/${created.id}/delete`,
      alice.token,
      {},
      published.version,
    );
    assert.equal(deletePublished.status, 409, '已发布的经验只能归档或撤销，不能直接删除');

    await expectStatus(
      agent.request(`knowledge/${created.id}/revoke`, {
        method: 'POST',
        body: { reason: 'agent' },
        operationId: 'agent-revoke',
      }),
      403,
    );

    const list = await json<Item[]>(await call(harness, 'GET', '/v1/documents', alice.token));
    assert.equal(list.length, 1);
    assert.equal(list[0].state, 'published');

    const archived = await json<Item>(
      await call(harness, 'POST', `/v1/documents/${created.id}/archive`, alice.token, { reason: '过期' }, 1),
    );
    assert.equal(archived.state, 'archived');
    assert.ok(archived.archivedAt);
    const afterArchive = await json<Item[]>(await call(harness, 'GET', '/v1/documents', alice.token));
    assert.equal(afterArchive.length, 0, '归档后默认列表不再显示');
  } finally {
    await harness.close();
  }
});

test('复制到自己的团队：选择目标团队生成独立草稿、保留来源链', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const source = await createDraft(harness, alice.token);
    await publishDraft(harness, alice.token, source);

    const team = await json<{ token: string; tenant: { id: string } }>(
      await call(harness, 'POST', '/v1/tenants', alice.token, { name: '供应链小组' }),
    );
    const personal = await json<{ token: string }>(
      await call(harness, 'POST', '/v1/me/switch', team.token, { tenantId: alice.tenant.id }),
    );

    const child = await json<Item>(
      await call(harness, 'POST', `/v1/documents/${source.id}/copy`, personal.token, {
        targetWorkspace: team.tenant.id,
      }),
    );
    assert.equal(child.state, 'draft');
    assert.equal(child.source, 'manual');
    assert.equal(child.evidenceLevel, 'imported');
    assert.equal(child.copiedFrom?.workspaceName, alice.tenant.name);
    assert.equal(child.copiedFrom?.version, 1);

    const teamSession = await json<{ token: string }>(
      await call(harness, 'POST', '/v1/me/switch', personal.token, { tenantId: team.tenant.id }),
    );
    const inTeam = await json<Item>(await call(harness, 'GET', `/v1/documents/${child.id}`, teamSession.token));
    assert.equal(inTeam.copiedFrom?.id, source.id);
    assert.equal(inTeam.authorName, 'alice');

    const lineage = await json<{ id: string }[]>(
      await call(harness, 'GET', `/v1/documents/${child.id}/lineage`, teamSession.token),
    );
    assert.deepEqual(lineage.map(entry => entry.id), [source.id]);

    // 团队产物文件可以挂成证据，团队内复制时一起带上。
    const teamTask = (await harness.client(teamSession.token).createTask(TASK_INPUT, 'team-task')) as { id: string };
    const file = await json<{ id: string }>(
      await call(harness, 'POST', `/v1/tasks/${teamTask.id}/files`, teamSession.token, {
        name: 'plan.md',
        mime: 'text/markdown',
        kind: 'output',
        data: Buffer.from('# 补货计划\n').toString('base64'),
      }),
    );
    await json(
      await call(harness, 'POST', `/v1/documents/${child.id}/assets`, teamSession.token, {
        fileId: file.id,
        role: 'evidence',
      }, child.version),
    );
    const assets = await json<{ fileId: string }[]>(
      await call(harness, 'GET', `/v1/documents/${child.id}/assets`, teamSession.token),
    );
    assert.deepEqual(assets.map(entry => entry.fileId), [file.id]);

    await publishDraft(harness, teamSession.token, child);

    const missingTarget = await call(harness, 'POST', `/v1/documents/${child.id}/copy`, teamSession.token, {});
    assert.equal(missingTarget.status, 400, '复制必须选择目标团队');

    const out = await call(harness, 'POST', `/v1/documents/${child.id}/copy`, teamSession.token, {
      targetWorkspace: 'personal',
    });
    assert.equal(out.status, 400, '复制目标必须是团队');

    const forked = await json<Item>(
      await call(harness, 'POST', `/v1/documents/${child.id}/copy`, teamSession.token, {
        targetWorkspace: team.tenant.id,
      }),
    );
    assert.equal(forked.state, 'draft');
    assert.equal(forked.copiedFrom?.id, child.id);

    const destinations = await json<{ knowledgeId: string }[]>(
      await call(harness, 'GET', `/v1/documents/${child.id}/copies`, teamSession.token),
    );
    assert.deepEqual(destinations.map(entry => entry.knowledgeId), [forked.id]);

    const copiedAssets = await json<{ fileId: string }[]>(
      await call(harness, 'GET', `/v1/documents/${forked.id}/assets`, teamSession.token),
    );
    assert.deepEqual(copiedAssets.map(entry => entry.fileId), [file.id]);
  } finally {
    await harness.close();
  }
});

test('复制到他人：必须由对方接受邀请，来源撤销后副本给出提示', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const bob = await emailLogin(harness, 'bob@example.com');
    const source = await createDraft(harness, alice.token);
    await publishDraft(harness, alice.token, source);

    const direct = await call(harness, 'POST', `/v1/documents/${source.id}/copy`, alice.token, {
      targetWorkspace: bob.tenant.id,
    });
    assert.equal(direct.status, 403, '不能直接把副本塞进别人的个人空间');

    const invite = await json<{ id: string; status: string }>(
      await call(harness, 'POST', `/v1/documents/${source.id}/invite`, alice.token, {
        targetPrincipal: bob.principal.id,
        note: '供参考',
      }, 1),
    );
    assert.equal(invite.status, 'pending');

    const incoming = await json<{ id: string; knowledgeId: string; title: string }[]>(
      await call(harness, 'GET', '/v1/me/copy-invites', bob.token),
    );
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].id, invite.id);
    assert.equal(incoming[0].knowledgeId, source.id);

    const copy = await json<Item>(
      await call(harness, 'POST', `/v1/me/copy-invites/${invite.id}/accept`, bob.token, {}),
    );
    assert.equal(copy.state, 'draft');
    assert.equal(copy.copiedFrom?.id, source.id);
    assert.equal(copy.copiedFrom?.workspaceName, alice.tenant.name);

    const detail = await json<Item>(await call(harness, 'GET', `/v1/documents/${copy.id}`, bob.token));
    assert.equal(detail.sourceRevoked, false);

    await json(
      await call(harness, 'POST', `/v1/knowledge/${source.id}/revoke`, alice.token, { reason: '数据失效' }),
    );
    const revokedView = await json<Item>(await call(harness, 'GET', `/v1/documents/${copy.id}`, bob.token));
    assert.equal(revokedView.sourceRevoked, true, '来源撤销后副本应提示');

    const secondInvite = await call(harness, 'POST', `/v1/documents/${source.id}/invite`, alice.token, {
      targetPrincipal: bob.principal.id,
    });
    assert.equal(secondInvite.status, 409, '已撤销的来源不能再邀请复制');
  } finally {
    await harness.close();
  }
});

test('任务房间：线程、消息、文件与进展合并成一条时间线', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const agentToken = harness.token('inv-room');
    await harness.admin.registerPrincipal(
      { id: 'inv-room', roles: ['agent'], token: agentToken, displayName: 'inv-room' },
      'register:inv-room',
    );
    const agent = harness.client(agentToken);
    const owner = harness.admin;
    const created = (await owner.createTask(TASK_INPUT, 'room-task')) as { id: string };
    const subtask = (await owner.assign(created.id, { agent: 'inv-room', kind: 'inventory' }, 'room-assign')) as {
      id: string;
    };
    await agent.accept(subtask.id, 'room-accept');

    const thread = await json<{ id: string; topic: string; messageCount: number }>(
      await call(harness, 'POST', `/v1/tasks/${created.id}/threads`, ADMIN_TOKEN, {
        topic: '补货方案',
        assigneeId: 'inv-room',
      }),
    );
    assert.equal(thread.topic, '补货方案');
    assert.equal(thread.messageCount, 0);

    const question = await json<{ id: string; kind: string; threadId: string }>(
      await call(harness, 'POST', `/v1/tasks/${created.id}/messages`, agentToken, {
        body: '供应商只肯给 20 件，是否分两批？',
        kind: 'question',
        threadId: thread.id,
        payload: { blocking: true },
      }),
    );
    assert.equal(question.kind, 'question');
    assert.equal(question.threadId, thread.id);

    const decision = await json<{ id: string; kind: string; replyTo: string }>(
      await call(harness, 'POST', `/v1/tasks/${created.id}/messages`, ADMIN_TOKEN, {
        body: '先接 20 件，余量走第二家。',
        kind: 'decision',
        replyTo: question.id,
        payload: { decision: 'split' },
      }),
    );
    assert.equal(decision.replyTo, question.id);

    const file = await json<{ id: string; sha256: string; kind: string }>(
      await call(harness, 'POST', `/v1/tasks/${created.id}/files`, agentToken, {
        name: 'plan.md',
        mime: 'text/markdown',
        kind: 'output',
        messageId: question.id,
        data: Buffer.from('# 补货计划\n').toString('base64'),
      }),
    );
    assert.equal(file.kind, 'output');
    assert.match(file.sha256, /^[0-9a-f]{64}$/);

    const messages = await json<{ id: string; fileIds?: string[] }[]>(
      await call(harness, 'GET', `/v1/tasks/${created.id}/messages?threadId=${thread.id}`, agentToken),
    );
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0].fileIds, [file.id]);

    const room = await json<{
      threads: { id: string; messageCount: number }[];
      messages: unknown[];
      files: { id: string }[];
      activity: { type: string; stream: string }[];
    }>(await call(harness, 'GET', `/v1/tasks/${created.id}/room`, agentToken));
    assert.equal(room.threads[0]?.messageCount, 2);
    assert.equal(room.messages.length, 2);
    assert.deepEqual(room.files.map(entry => entry.id), [file.id]);
    const types = room.activity.map(entry => entry.type);
    assert.ok(room.activity.some(entry => entry.stream === 'message' && entry.type === 'question'));
    assert.ok(types.includes('file_uploaded'));
    assert.ok(types.includes('thread_opened'));

    const downloaded = await json<{ file: { name: string }; data: string }>(
      await call(harness, 'GET', `/v1/tasks/${created.id}/files/${file.id}`, agentToken),
    );
    assert.equal(downloaded.file.name, 'plan.md');
    assert.equal(Buffer.from(downloaded.data, 'base64').toString(), '# 补货计划\n');

    const note = await createDraft(harness, ADMIN_TOKEN, { title: '补货决策' });
    await json(
      await call(harness, 'POST', `/v1/tasks/${created.id}/files/${file.id}/promote`, ADMIN_TOKEN, {
        knowledgeId: note.id,
      }),
    );
    const assets = await json<{ fileId: string }[]>(
      await call(harness, 'GET', `/v1/documents/${note.id}/assets`, ADMIN_TOKEN),
    );
    assert.deepEqual(assets.map(entry => entry.fileId), [file.id]);

    const publishedNote = await createDraft(harness, ADMIN_TOKEN, { title: '补货结论' });
    await json(
      await call(harness, 'POST', `/v1/documents/${publishedNote.id}/assets`, ADMIN_TOKEN, {
        fileId: file.id,
        role: 'evidence',
      }, publishedNote.version),
    );
    await publishDraft(harness, ADMIN_TOKEN, publishedNote);
    const roomWithKnowledge = await json<{
      knowledge: { id: string; title: string }[];
      activity: { stream: string; type: string }[];
    }>(await call(harness, 'GET', `/v1/tasks/${created.id}/room`, agentToken));
    assert.deepEqual(roomWithKnowledge.knowledge.map(entry => entry.id), [publishedNote.id]);
    assert.ok(
      roomWithKnowledge.activity.some(
        entry => entry.stream === 'knowledge' && entry.type === 'document_published',
      ),
      '挂到任务文件上的经验出现在任务时间线里',
    );

    const resolved = await json<{ status: string }>(
      await call(harness, 'POST', `/v1/tasks/${created.id}/threads/${thread.id}/resolve`, ADMIN_TOKEN, {}),
    );
    assert.equal(resolved.status, 'resolved');

    await json(await call(harness, 'POST', `/v1/tasks/${created.id}/files/${file.id}/delete`, ADMIN_TOKEN, {}));
    assert.equal(
      (await call(harness, 'GET', `/v1/tasks/${created.id}/files/${file.id}`, agentToken)).status,
      404,
    );
  } finally {
    await harness.close();
  }
});

test('团队任务对真人成员可见，访客与团队外主体仍受限', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const team = await json<{ token: string; tenant: { id: string; name: string } }>(
      await call(harness, 'POST', '/v1/tenants', alice.token, { name: '运营组' }),
    );

    const invited = await json<{ link: string }>(
      await call(harness, 'POST', '/v1/tenants/current/invites', team.token, {
        email: 'bob@example.com',
        role: 'member',
      }),
    );
    const ticket = new URL(invited.link).searchParams.get('ticket')!;
    const joined = await json<{ token: string }>(
      await fetch(`${harness.url}/auth/email/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ ticket }),
      }),
    );

    const created = (await harness.client(team.token).createTask(TASK_INPUT, 'team-room-task')) as { id: string };
    const room = await json<{ task: { id: string } }>(
      await call(harness, 'GET', `/v1/tasks/${created.id}/room`, joined.token),
    );
    assert.equal(room.task.id, created.id);

    const message = await json<{ id: string }>(
      await call(harness, 'POST', `/v1/tasks/${created.id}/messages`, joined.token, {
        body: '我来跟进补货',
        kind: 'status',
      }),
    );
    assert.ok(message.id);

    const tasks = await json<{ id: string }[]>(
      await call(harness, 'GET', '/v1/tasks', joined.token),
    );
    assert.ok(tasks.some(entry => entry.id === created.id), '成员能在任务列表里看到团队任务');

    const outsider = await call(harness, 'GET', `/v1/tasks/${created.id}/room`, ADMIN_TOKEN);
    assert.equal(outsider.status, 404, '团队外的主体按工作空间隔离');

    const guestInvite = await json<{ link: string }>(
      await call(harness, 'POST', '/v1/tenants/current/invites', team.token, {
        email: 'carol@example.com',
        role: 'guest',
      }),
    );
    const guestTicket = new URL(guestInvite.link).searchParams.get('ticket')!;
    const guest = await json<{ token: string }>(
      await fetch(`${harness.url}/auth/email/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ ticket: guestTicket }),
      }),
    );
    const guestView = await call(harness, 'GET', `/v1/tasks/${created.id}/room`, guest.token);
    assert.equal(guestView.status, 403, '访客不能读整个团队任务');
  } finally {
    await harness.close();
  }
});

test('v8 迁移：旧版本表的有效期 NOT NULL 被放宽，且迁移可重复执行', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    // 模拟 v7 结构：knowledge_versions.expires_at NOT NULL。
    if (harness.db.dialect === 'sqlite') {
      await harness.db.exec('PRAGMA foreign_keys=OFF');
      await harness.db.exec('ALTER TABLE knowledge_versions RENAME TO knowledge_versions_v7_old');
      await harness.db.exec(`CREATE TABLE knowledge_versions (
        knowledge_id TEXT NOT NULL REFERENCES knowledge(id),
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        conditions TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        published_at TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (knowledge_id, version)
      )`);
      await harness.db.exec('DROP TABLE knowledge_versions_v7_old');
      await harness.db.exec('PRAGMA foreign_keys=ON');
    } else {
      await harness.db.transaction(tx =>
        tx.run('ALTER TABLE knowledge_versions ALTER COLUMN expires_at SET NOT NULL'),
      );
    }

    await migrate(harness.db, harness.app.ctx.now);
    await migrate(harness.db, harness.app.ctx.now);

    const nullable =
      harness.db.dialect === 'sqlite'
        ? !Number(
            (
              await harness.db.read.all<{ name: string; notnull: number }>(
                'PRAGMA table_info(knowledge_versions)',
              )
            ).find(row => String(row.name) === 'expires_at')?.notnull,
          )
        : String(
            (
              await harness.db.read.one<{ is_nullable: string }>(
                `SELECT is_nullable FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'knowledge_versions'
                   AND column_name = 'expires_at'`,
              )
            )?.is_nullable,
          ) === 'YES';
    assert.equal(nullable, true, '迁移后普通文档的版本可以不设有效期');
  } finally {
    await harness.close();
  }
});
