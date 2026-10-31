/**
 * 任务参与与智能体协商。
 *
 * 这里钉住两件事：
 *  - 邀请的对象是**人**，接受时由这个人从自己的智能体里选一个进入任务；
 *  - 委托协调与分配子任务走同一条协商接口，接受（或确认还价）之后才落库。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { hashToken } from '../src/platform/services/principals.ts';
import {
  ADMIN_TOKEN,
  TASK_INPUT,
  expectStatus,
  nextOperationId,
  register,
  startHarness,
  type Harness,
} from './helpers/harness.ts';

const post = (harness: Harness, path: string, body: unknown, token?: string) =>
  fetch(`${harness.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (harness: Harness, path: string, token: string) =>
  fetch(`${harness.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

const json = async <T = any>(response: Response): Promise<T> => (await response.json()) as T;

/** 通过邮箱邀请把一个人拉进当前团队，并返回他在团队里的账号与会话。 */
async function joinTeam(
  harness: Harness,
  email: string,
): Promise<{ token: string; principalId: string; accountId: string }> {
  const invited = await post(harness, '/v1/tenants/current/invites', { email, role: 'member' }, ADMIN_TOKEN);
  assert.equal(invited.status, 200, await invited.clone().text());
  const ticket = new URL((await json<{ link: string }>(invited)).link).searchParams.get('ticket');
  assert.ok(ticket, '邀请链接里应有 ticket');
  const verified = await post(harness, '/auth/email/verify', { ticket });
  assert.equal(verified.status, 200, await verified.clone().text());
  const session = await json<{ token: string; principal: { id: string } }>(verified);
  const me = await json<{ accountId: string }>(await get(harness, '/v1/me', session.token));
  return { token: session.token, principalId: session.principal.id, accountId: me.accountId };
}

/** 直接造一个挂在某人账号下的智能体，模拟“这个人自己的智能体”。 */
async function createOwnedAgent(
  harness: Harness,
  id: string,
  accountId: string,
): Promise<{ id: string; client: ReturnType<Harness['client']> }> {
  const token = harness.token(id);
  await harness.db.run(
    `INSERT INTO principals(id, workspace, roles, token_hash, did, kind, handle, display_name,
                            avatar, title, bio, description, capabilities, active, created_at, account_id, tenant_role)
     VALUES(:id, 'acme', :roles, :hash, NULL, 'agent', NULL, :name,
            '', '', '', '', '[]', 1, :at, :account, 'member')`,
    {
      id,
      roles: JSON.stringify(['agent']),
      hash: hashToken(token),
      name: id,
      at: harness.app.ctx.now(),
      account: accountId,
    },
  );
  return { id, client: harness.client(token) };
}

test('邀请的是人：被邀请人接受时选定自己的智能体，之后任务对它可见', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const task = await harness.admin.createTask(TASK_INPUT, nextOperationId('create'));
    const bob = await joinTeam(harness, 'bob@example.com');
    const bobAgent = await createOwnedAgent(harness, 'bob-agent', bob.accountId);
    const carol = await joinTeam(harness, 'carol@example.com');
    const carolAgent = await createOwnedAgent(harness, 'carol-agent', carol.accountId);
    const bobClient = harness.client(bob.token);

    const invited = await harness.admin.inviteParticipant(
      task.id,
      { email: 'bob@example.com', note: '请一起看缺料' },
      nextOperationId('invite'),
    );
    assert.equal(invited.status, 'invited');
    assert.equal(invited.displayName, 'bob');
    assert.equal(invited.agentId, null);

    // 邀请只出现在被邀请人的收件箱里。
    assert.equal((await harness.admin.taskInvitations()).length, 0);
    const pending = await bobClient.taskInvitations();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].taskId, task.id);
    assert.equal(pending[0].taskTitle, TASK_INPUT.title);

    // 不能拿别人的智能体来接受邀请。
    await expectStatus(
      bobClient.acceptTaskInvitation(pending[0].id, carolAgent.id, nextOperationId('accept')),
      400,
    );

    const accepted = await bobClient.acceptTaskInvitation(
      pending[0].id,
      bobAgent.id,
      nextOperationId('accept'),
    );
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.humanPrincipalId, bob.principalId);
    assert.equal(accepted.agentId, bobAgent.id);
    assert.equal(accepted.agentName, 'bob-agent');

    const participants = await harness.admin.participants(task.id);
    assert.equal(participants.length, 1);
    assert.equal(participants[0].email, 'bob@example.com');
    assert.equal(participants[0].status, 'accepted');

    // 选定的智能体（而不是团队里任意智能体）才能读任务。
    const detail = await bobAgent.client.task(task.id);
    assert.equal(detail.task.id, task.id);
    assert.equal((await bobClient.task(task.id)).task.id, task.id);
    await expectStatus(carolAgent.client.task(task.id), 403);

    // 换一个自己的智能体仍然可以，换成别人的不行。
    await expectStatus(
      bobClient.selectParticipantAgent(task.id, accepted.id, carolAgent.id, nextOperationId('select')),
      400,
    );
    const switched = await bobClient.selectParticipantAgent(
      task.id,
      accepted.id,
      bobAgent.id,
      nextOperationId('select'),
    );
    assert.equal(switched.agentId, bobAgent.id);
  } finally {
    await harness.close();
  }
});

test('智能体协商：委托协调与分配子任务共用一条请求，接受或确认后才落库', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const task = await harness.admin.createTask(TASK_INPUT, nextOperationId('create'));
    const coordinator = await register(harness, 'coord1', ['agent']);
    const worker = await register(harness, 'worker1', ['agent']);

    const proposed = await harness.admin.proposeRequest(
      task.id,
      { to: 'coord1', role: 'coordinate', note: '帮忙统筹' },
      nextOperationId('propose'),
    );
    assert.equal(proposed.status, 'proposed');

    // 请求只是提议，接受之前不会变成协调者。
    assert.deepEqual((await harness.admin.task(task.id)).coordinators, []);

    const coordInbox = await coordinator.requests({ box: 'inbox' });
    assert.equal(coordInbox.length, 1);
    assert.equal(coordInbox[0].taskTitle, TASK_INPUT.title);
    assert.equal(coordInbox[0].fromName, '管理员');

    // 非收件人不能替它接受。
    await expectStatus(worker.acceptRequest(coordInbox[0].id, nextOperationId('accept')), 403);

    const accepted = await coordinator.acceptRequest(coordInbox[0].id, nextOperationId('accept'));
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual((await harness.admin.task(task.id)).coordinators, ['coord1']);

    // 协调者可以继续把具体工作分给另一个智能体。
    const dueAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const subtaskRequest = await coordinator.proposeRequest(
      task.id,
      { to: 'worker1', role: 'subtask', kind: 'supplier-check', dueAt, note: '核对供应商交期' },
      nextOperationId('propose'),
    );
    assert.equal(subtaskRequest.role, 'subtask');

    const workerInbox = await worker.requests({ box: 'inbox' });
    assert.equal(workerInbox.length, 1);

    // 还价只改能改的条款，发起方确认后才成为子任务。
    const counterDueAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const countered = await worker.counterRequest(
      workerInbox[0].id,
      { dueAt: counterDueAt, note: '交期需要放宽两天' },
      nextOperationId('counter'),
    );
    assert.equal(countered.status, 'countered');

    const confirmed = await coordinator.confirmRequest(workerInbox[0].id, nextOperationId('confirm'));
    assert.equal(confirmed.status, 'accepted');
    assert.ok(confirmed.subtaskId);

    const detail = await harness.admin.task(task.id);
    assert.equal(detail.task.status, 'running');
    const subtask = detail.subtasks.find(item => item.id === confirmed.subtaskId);
    assert.ok(subtask);
    assert.equal(subtask.agentId, 'worker1');
    assert.equal(subtask.kind, 'supplier-check');
    assert.equal(subtask.status, 'accepted');
    assert.equal(subtask.dueAt, counterDueAt);

    const outbox = await coordinator.requests({ box: 'outbox', taskId: task.id });
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].status, 'accepted');

    // 只有发起方可以确认还价；非协调者不能继续分配。
    await expectStatus(worker.confirmRequest(workerInbox[0].id, nextOperationId('confirm')), 403);
    await expectStatus(
      worker.proposeRequest(
        task.id,
        { to: 'coord1', role: 'subtask', kind: 'extra' },
        nextOperationId('propose'),
      ),
      403,
    );
  } finally {
    await harness.close();
  }
});

test('人可以在页面上替自己的智能体回应请求，别人不行', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const task = await harness.admin.createTask(TASK_INPUT, nextOperationId('create'));
    const bob = await joinTeam(harness, 'bob@example.com');
    const bobAgent = await createOwnedAgent(harness, 'bob-order-agent', bob.accountId);
    const bobClient = harness.client(bob.token);
    const carol = await joinTeam(harness, 'carol@example.com');
    const carolClient = harness.client(carol.token);

    const proposed = await harness.admin.proposeRequest(
      task.id,
      { to: bobAgent.id, role: 'subtask', kind: 'supplier-check' },
      nextOperationId('propose'),
    );

    // 发给智能体的请求也进主人的收件箱，别人的收件箱里没有。
    const bobInbox = await bobClient.requests({ box: 'inbox' });
    assert.equal(bobInbox.length, 1);
    assert.equal(bobInbox[0].id, proposed.id);
    assert.equal((await carolClient.requests({ box: 'inbox' })).length, 0);
    assert.notEqual(bob.accountId, carol.accountId);

    await expectStatus(carolClient.acceptRequest(proposed.id, nextOperationId('accept')), 403);

    // 主人代为接受，但落库的仍是那个智能体。
    const accepted = await bobClient.acceptRequest(proposed.id, nextOperationId('accept'));
    assert.equal(accepted.status, 'accepted');
    const subtask = (await harness.admin.task(task.id)).subtasks.find(item => item.id === accepted.subtaskId);
    assert.ok(subtask);
    assert.equal(subtask.agentId, bobAgent.id);
  } finally {
    await harness.close();
  }
});

test('个人任务不邀请他人，工作请求只能发给智能体', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    // 邮箱首次登录会落到个人空间。
    const started = await post(harness, '/auth/email/start', { email: 'solo@example.com' });
    const devLink = (await json<{ devLink: string }>(started)).devLink;
    const ticket = new URL(devLink).searchParams.get('ticket');
    const verified = await post(harness, '/auth/email/verify', { ticket });
    const session = await json<{ token: string; principal: { id: string } }>(verified);
    const solo = harness.client(session.token);
    const personal = await solo.createTask(TASK_INPUT, nextOperationId('create'));

    await expectStatus(
      solo.inviteParticipant(personal.id, { principal: session.principal.id }, nextOperationId('invite')),
      409,
    );

    // 团队任务也不能把工作请求发给一个真人。
    const bob = await joinTeam(harness, 'bob@example.com');
    const task = await harness.admin.createTask(TASK_INPUT, nextOperationId('create'));
    await expectStatus(
      harness.admin.proposeRequest(
        task.id,
        { to: bob.principalId, role: 'coordinate' },
        nextOperationId('propose'),
      ),
      400,
    );
  } finally {
    await harness.close();
  }
});
