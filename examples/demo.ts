/**
 * 企业域内完整演示（单机）。
 *
 * 演示一条纵向闭环：
 *   人创建任务 → 委派协调者 → 协调者分派 → 两个业务智能体以独立进程执行
 *   → 协调者汇总 → 人验收 → 沉淀候选经验 → 审核发布 → 第二个任务引用经验。
 *
 * 运行：npm run demo
 * 演示使用临时数据库，结束时删除；验收动作由脚本模拟，真实场景由人在界面上完成。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/platform/app.ts';
import { openDatabase } from '../src/platform/db/index.ts';
import { createServer } from '../src/platform/http/server.ts';
import { CollabClient } from '../src/sdk/client.ts';

const ROOT = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'collab-demo-'));
const adminToken = randomBytes(32).toString('hex');

function step(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function spawnAgent(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${script} 退出码 ${code}`))));
  });
}

async function main(): Promise<void> {
  const db = openDatabase(join(directory, 'demo.sqlite3'));
  const app = await createApp(db);
  await app.principals.bootstrap('demo', {
    id: 'owner',
    roles: ['admin', 'owner', 'reviewer'],
    token: adminToken,
    displayName: '张经理（发起人）',
  });

  const server = createServer({ app, webRoot: join(ROOT, 'src/web'), bodyLimit: 65536 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const owner = new CollabClient(url, adminToken);

  const tokens: Record<string, string> = {};
  for (const id of ['inventory', 'supplier', 'coordinator']) {
    tokens[id] = randomBytes(24).toString('hex');
    await owner.registerPrincipal(
      {
        id,
        roles: ['agent'],
        token: tokens[id],
        displayName: id === 'coordinator' ? '协调智能体' : id === 'inventory' ? '库存智能体' : '供应商信息智能体',
        capabilities: [id === 'coordinator' ? 'coordination' : `${id}:read`],
      },
      `register:${id}`,
    );
  }

  try {
    step('1. 人创建任务');
    const task = await owner.createTask(
      {
        title: 'M-100 缺料分析',
        type: 'shortage-analysis',
        goal: '判断 100 件 M-100 能否按期交付',
        acceptance: '库存与供应商数据需带来源与观测时间，缺口需明确',
        input: { material: 'M-100', quantity: 100 },
      },
      'create-task',
    );
    console.log(`任务 ${task.id} 已创建，状态 ${task.status}`);

    step('2. 委派协调智能体');
    await owner.delegate(task.id, 'coordinator', 'delegate');
    const coordinatorEnv = {
      COLLAB_URL: url,
      COLLAB_TOKEN: tokens.coordinator,
      COLLAB_TASK: task.id,
      COLLAB_INVENTORY_AGENT: 'inventory',
      COLLAB_SUPPLIER_AGENT: 'supplier',
    };
    await spawnAgent('src/agents/coordinator.ts', coordinatorEnv);

    step('3. 业务智能体在各自进程执行');
    await Promise.all([
      spawnAgent('src/agents/worker.ts', {
        COLLAB_URL: url,
        COLLAB_TOKEN: tokens.inventory,
        COLLAB_KIND: 'inventory',
        COLLAB_DATA: join(ROOT, 'examples/data/inventory.json'),
        COLLAB_WORKER_DB: join(directory, 'inventory.sqlite'),
      }),
      spawnAgent('src/agents/worker.ts', {
        COLLAB_URL: url,
        COLLAB_TOKEN: tokens.supplier,
        COLLAB_KIND: 'supplier',
        COLLAB_DATA: join(ROOT, 'examples/data/supplier.json'),
        COLLAB_WORKER_DB: join(directory, 'supplier.sqlite'),
      }),
    ]);

    step('4. 协调者汇总，进入待验收');
    await spawnAgent('src/agents/coordinator.ts', coordinatorEnv);
    const pending = await owner.task(task.id);
    console.log(`状态：${pending.task.status}`);
    console.log(`汇总：${(pending.task.result as { text: string }).text}`);

    step('5. 负责人验收');
    await owner.review(task.id, 'accept', '数据来源与时效已核对，结论可作为建议', 'review');
    const completed = await owner.task(task.id);
    console.log(`状态：${completed.task.status}；子任务：${completed.subtasks.map(item => item.status).join(', ')}`);

    step('6. 沉淀经验并审核发布');
    const candidate = await owner.candidate(
      task.id,
      {
        content: '缺料判断先取库存快照，再确认供应商可供量与交期；两者都需记录来源与观测时间。缺口大于可供量时不得直接承诺交期。',
        conditions: '物料 M-100，需求 100 件以内，库存与供应商数据均为当日快照',
      },
      'candidate',
    );
    await owner.publish(candidate.id, { expiresAt: '2027-10-28T00:00:00Z', audience: 'workspace' }, 'publish');
    console.log(`经验 ${candidate.id} 已发布，有效期至 2027-10-28`);

    step('7. 第二个任务引用已审核经验');
    const second = await owner.createTask(
      {
        title: 'M-100 二次询单',
        type: 'shortage-analysis',
        goal: '复用上次结论处理新询单',
        acceptance: '引用经验需标明版本',
        input: { material: 'M-100', quantity: 60 },
      },
      'create-second',
    );
    await owner.reference(second.id, candidate.id, 'reference');
    const related = await owner.evidence(second.id, candidate.id, 1);
    console.log(`第二个任务 ${second.id} 引用了经验 v${related.version}`);

    const search = await owner.searchKnowledge('缺料 交期', 5, 2000);
    console.log(`检索「缺料 交期」命中 ${search.items.length} 条，用量 ${search.usedChars}/${search.budgetChars} 字符`);

    step('结果摘要');
    console.log(
      JSON.stringify(
        {
          tasks: (await owner.tasks()).map(item => ({ id: item.id, title: item.title, status: item.status })),
          knowledge: (await owner.knowledge()).map(item => ({ id: item.id, version: item.version })),
          audit: (await owner.audit()).length,
        },
        null,
        2,
      ),
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('演示失败:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
