/**
 * 任务材料与智能体自提交经验。
 *
 * 钉住两条新语义：
 *  - 任务材料随创建请求提交，可见性跟随任务，只有负责人/受派智能体能读；
 *  - 受派智能体提交结果后可以自己把解决办法沉淀成候选经验，仍需人审核发布。
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  emailLogin,
  expectStatus,
  startHarness,
  TASK_INPUT,
} from './helpers/harness.ts';
import type { Harness } from './helpers/harness.ts';

const FUTURE = '2099-01-01T00:00:00Z';
const RESULT = { summary: '已排除网络抖动，重启采集进程后恢复', source: '现场巡检', observedAt: '2026-10-28T00:00:00Z' };
const SNAPSHOT = '库存快照：M-100 剩 30 件\n';
const TEXT = Buffer.from(SNAPSHOT, 'utf8').toString('base64');
const PDF = Buffer.from('%PDF-1.4\nfixture\n', 'utf8').toString('base64');

/** 在指定空间里登记智能体，返回它的客户端。 */
async function agentIn(harness: Harness, token: string, id: string) {
  const agentToken = harness.token(id);
  await harness.client(token).registerPrincipal(
    { id, roles: ['agent'], token: agentToken, displayName: id },
    `register:${id}:${randomUUID()}`,
  );
  return harness.client(agentToken);
}

test('任务材料：创建时提交，负责人与受派智能体可读，外部人员拿不到', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const owner = harness.client(alice.token);
    const agent = await agentIn(harness, alice.token, 'material-agent');

    const task = await owner.createTask(
      {
        ...TASK_INPUT,
        materials: [
          { name: '库存快照.txt', mime: 'text/plain', data: TEXT },
          { name: '巡检表.pdf', mime: 'application/pdf', data: PDF },
        ],
      },
      `create:${randomUUID()}`,
    );

    const detail = await owner.task(task.id);
    assert.deepEqual(
      detail.materials.map(item => item.name).sort(),
      ['库存快照.txt', '巡检表.pdf'].sort(),
    );
    const snapshot = detail.materials.find(item => item.name === '库存快照.txt');
    assert.ok(snapshot, '缺少库存快照材料');
    assert.equal(snapshot.size, Buffer.byteLength(SNAPSHOT));
    assert.equal(snapshot.uploadedBy, alice.principal.id);

    const list = await owner.taskMaterials(task.id);
    assert.equal(list.length, 2);
    const content = await owner.taskMaterial(task.id, snapshot.id);
    assert.equal(content.data, TEXT);
    assert.equal(content.mime, 'text/plain');

    // 受派智能体按任务可见性读到材料。
    const sub = await owner.assign(task.id, { agent: 'material-agent', kind: 'inspection' }, `assign:${task.id}`);
    await agent.accept(sub.id, `accept:${sub.id}`);
    assert.equal((await agent.taskMaterials(task.id)).length, 2);

    // 无关账号看不到任务，也拿不到材料目录与正文。
    const bob = await emailLogin(harness, 'bob@example.com');
    await expectStatus(harness.client(bob.token).taskMaterials(task.id), 404);
    await expectStatus(harness.client(bob.token).taskMaterial(task.id, snapshot.id), 404);
    await expectStatus(harness.client(bob.token).task(task.id), 404);

    // 没有材料的任务返回空目录。
    const plain = await owner.createTask({ ...TASK_INPUT, title: '无材料任务' }, `plain:${randomUUID()}`);
    assert.deepEqual(await owner.taskMaterials(plain.id), []);
  } finally {
    await harness.close();
  }
});

test('任务材料：非法 base64、超量、未知字段被整单拒绝', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const owner = harness.client(alice.token);

    await expectStatus(
      owner.createTask(
        { ...TASK_INPUT, materials: [{ name: 'x.txt', mime: 'text/plain', data: 'not base64!' }] },
        `bad-base64:${randomUUID()}`,
      ),
      400,
    );
    await expectStatus(
      owner.createTask(
        {
          ...TASK_INPUT,
          materials: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, mime: 'text/plain', data: TEXT })),
        },
        `too-many:${randomUUID()}`,
      ),
      400,
    );
    await expectStatus(
      owner.createTask(
        { ...TASK_INPUT, materials: [{ name: 'x.txt', mime: 'not-a-mime', data: TEXT }] },
        `bad-mime:${randomUUID()}`,
      ),
      400,
    );
  } finally {
    await harness.close();
  }
});

test('受派智能体提交结果后可以自提交候选经验，仍需人审核发布', async () => {
  const harness = await startHarness({ workspace: 'acme' });
  try {
    const alice = await emailLogin(harness, 'alice@example.com');
    const owner = harness.client(alice.token);
    const agent = await agentIn(harness, alice.token, 'ops-agent');
    const stranger = await agentIn(harness, alice.token, 'other-agent');

    const task = await owner.createTask(
      {
        ...TASK_INPUT,
        title: '机房巡检',
        goal: '逐台检查采集节点，遇到异常处理并上报',
        acceptance: '每台节点都有现状与处理结果',
        materials: [{ name: '节点清单.csv', mime: 'text/csv', data: Buffer.from('n1,n2\n').toString('base64') }],
      },
      `create:${randomUUID()}`,
    );
    const sub = await owner.assign(task.id, { agent: 'ops-agent', kind: 'inspection' }, `assign:${task.id}`);

    // 还没提交结果：不能沉淀；未受派的智能体也不行。
    await agent.accept(sub.id, `accept:${sub.id}`);
    await expectStatus(
      agent.candidate(task.id, { content: '先重启采集进程', conditions: 'Linux 节点' }, `early:${randomUUID()}`),
      403,
    );
    await expectStatus(
      stranger.candidate(task.id, { content: '越权经验', conditions: '无' }, `stranger:${randomUUID()}`),
      403,
    );
    await expectStatus(
      stranger.task(task.id),
      403,
    );

    await agent.submit(sub.id, RESULT, `submit:${sub.id}`);
    const candidate = await agent.candidate(
      task.id,
      { content: '采集节点无数据时，先看进程再重启，最后核对最近一次心跳', conditions: '自建采集节点，心跳仍在线' },
      `candidate:${randomUUID()}`,
    );
    assert.equal(candidate.state, 'candidate');

    // 候选经验进入人的审核列表，并能看到作者。
    const pending = await owner.candidates();
    const row = (pending as { id: string; authorName?: string }[]).find(item => item.id === candidate.id);
    assert.ok(row, '负责人应看到智能体提交的候选经验');
    assert.equal(row.authorName, 'ops-agent');

    await owner.publish(candidate.id, { expiresAt: FUTURE }, `publish:${randomUUID()}`);
    const published = (await agent.knowledge()) as { id: string }[];
    assert.ok(published.some(item => item.id === candidate.id));
  } finally {
    await harness.close();
  }
});
