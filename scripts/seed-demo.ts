/**
 * 演示数据填充。
 *
 * 面向"已经跑起来、但界面空空"的场景：向一个运行中的实例写入几个主体、
 * 三条处于不同阶段的任务和一条已发布经验，方便查看管理台各个视图。
 *
 * 运行前：
 *   COLLAB_TOKEN=<管理员令牌> npm run seed
 *   可选 COLLAB_URL（默认 http://127.0.0.1:8787）、COLLAB_SEED_SECRET。
 *
 * 重复执行是安全的：
 *  - 主体已存在时跳过登记，令牌由固定种子派生，因此每次一致；
 *  - 标题已存在的任务与经验直接跳过，不会重复堆积。
 */

import { createHash } from 'node:crypto';
import { CollabClient, CollabError } from '../src/sdk/client.ts';
import type { InboxItem } from '../src/sdk/types.ts';

const URL_BASE = process.env.COLLAB_URL ?? 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.COLLAB_TOKEN ?? '';
const SEED_SECRET = process.env.COLLAB_SEED_SECRET ?? 'anpio-collab-demo';

if (ADMIN_TOKEN.length < 8) {
  console.error('缺少 COLLAB_TOKEN：请填管理员令牌，例如 COLLAB_TOKEN=... npm run seed');
  process.exit(1);
}

/** 由固定种子派生令牌，保证重复执行时身份不变。 */
const tokenFor = (id: string): string =>
  createHash('sha256').update(`${SEED_SECRET}:${id}`).digest('hex');

const admin = new CollabClient(URL_BASE, ADMIN_TOKEN);

const AGENTS = [
  { id: 'coordinator', displayName: '协调智能体', capabilities: ['coordination'] },
  { id: 'inventory', displayName: '库存智能体', capabilities: ['inventory:read'] },
  { id: 'supplier', displayName: '供应商信息智能体', capabilities: ['supplier:read'] },
];

/** 监管者不是管理员：能看异常与在线表，但不碰业务写入。 */
const SUPERVISOR = { id: 'supervisor', displayName: '值班监管', capabilities: [] as string[] };

const ids = (prefix: string) => {
  let n = 0;
  return (action: string) => `${prefix}:${action}:${++n}`;
};

async function registerOnce(
  input: { id: string; roles: string[]; kind: string; displayName: string; capabilities: string[] },
): Promise<void> {
  try {
    await admin.registerPrincipal({ ...input, token: tokenFor(input.id) }, `seed:register:${input.id}`);
    console.log(`登记主体 ${input.id}`);
  } catch (error) {
    if (error instanceof CollabError && error.status === 409) {
      console.log(`主体 ${input.id} 已存在，跳过`);
      return;
    }
    throw error;
  }
}

async function ensureAgents(): Promise<void> {
  for (const agent of AGENTS) await registerOnce({ ...agent, roles: ['agent'], kind: 'agent' });
  await registerOnce({ ...SUPERVISOR, roles: ['supervisor'], kind: 'human' });
  // 令牌是派生的：如果主体是别人用别的令牌建的，这里会立刻暴露出来。
  for (const agent of [...AGENTS, SUPERVISOR]) {
    await new CollabClient(URL_BASE, tokenFor(agent.id)).me();
  }
}

async function agentFor(id: string): Promise<CollabClient> {
  const client = new CollabClient(URL_BASE, tokenFor(id));
  await client.me();
  return client;
}

/** 从智能体待办里取出属于该任务的那一条。 */
async function inboxItem(client: CollabClient, taskId: string, kind: string): Promise<InboxItem> {
  const inbox = (await client.inbox()) as InboxItem[];
  const item = inbox.find(entry => entry.taskId === taskId && entry.kind === kind);
  if (!item) throw new Error(`待办里没有任务 ${taskId} 的 ${kind} 子任务`);
  return item;
}

const OBSERVED_AT = new Date().toISOString();

async function completedTask(existing: Set<string>): Promise<void> {
  const title = 'M-100 缺料分析';
  if (existing.has(title)) {
    console.log(`任务「${title}」已存在，跳过`);
    return;
  }
  const op = ids('seed:shortage');

  const created = await admin.createTask(
    {
      title,
      type: 'shortage-analysis',
      goal: '判断 100 件 M-100 能否按期交付',
      acceptance: '库存与供应商数据需带来源与观测时间，缺口需明确',
      dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      input: { material: 'M-100', quantity: 100 },
    },
    op('create'),
  );
  await admin.delegate(created.id, 'coordinator', op('delegate'));

  const inventory = await admin.assign(
    created.id,
    { agent: 'inventory', kind: 'inventory', dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    op('assign-inventory'),
  );
  const supplier = await admin.assign(
    created.id,
    { agent: 'supplier', kind: 'supplier', dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    op('assign-supplier'),
  );

  for (const [agentId, kind, quantity, source, subId] of [
    ['inventory', 'inventory', 30, 'examples/data/inventory.json', inventory.id],
    ['supplier', 'supplier', 90, 'examples/data/supplier.json', supplier.id],
  ] as const) {
    const client = await agentFor(agentId);
    const item = await inboxItem(client, created.id, kind);
    await client.accept(item.id, op(`accept-${kind}`));
    await client.submit(
      item.id,
      {
        quantity,
        source,
        observedAt: OBSERVED_AT,
        summary: `${kind} 数据：M-100 可供 ${quantity} 件`,
      },
      op(`submit-${kind}`),
    );
    void subId;
  }

  const submitted = await admin.task(created.id);
  await admin.summary(
    created.id,
    '库存 30 件、供应商可供 90 件，按需求 100 件计算缺口为 0；两份数据均为当日快照，可支撑按期交付判断。',
    op('summary'),
    submitted.task.version,
  );

  const reviewable = await admin.task(created.id);
  await admin.review(created.id, 'accept', '来源与观测时间齐全，缺口计算可核对', op('review'), reviewable.task.version);

  const candidate = await admin.candidate(
    created.id,
    {
      content: '缺料判断先取库存快照，再确认供应商可供量与交期；两者都需记录来源与观测时间。缺口大于可供量时不得直接承诺交期。',
      conditions: '物料 M-100，需求 100 件以内，库存与供应商数据均为当日快照',
    },
    op('candidate'),
  );
  await admin.publish(
    candidate.id,
    { expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(), audience: 'workspace' },
    op('publish'),
  );
  console.log(`任务「${title}」已走完闭环，经验 ${candidate.id.slice(0, 8)} 已发布`);
}

async function runningTask(existing: Set<string>): Promise<void> {
  const title = 'M-100 二次询单';
  if (existing.has(title)) {
    console.log(`任务「${title}」已存在，跳过`);
    return;
  }
  const op = ids('seed:second');
  const created = await admin.createTask(
    {
      title,
      type: 'shortage-analysis',
      goal: '复用上次结论处理客户新增询单',
      acceptance: '引用经验需标明版本，数量变化需重新核对',
      priority: 'high',
      dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      input: { material: 'M-100', quantity: 160 },
    },
    op('create'),
  );
  await admin.delegate(created.id, 'coordinator', op('delegate'));
  // 只分派、不接受：界面停在"执行中 0/1"，可以看到智能体待接受的样子。
  await admin.assign(created.id, { agent: 'inventory', kind: 'inventory' }, op('assign'));

  const knowledge = await admin.knowledge();
  const published = knowledge.find(item => item.content.startsWith('缺料判断先取库存快照'));
  if (published) {
    await admin.reference(created.id, published.id, op('reference'));
    console.log(`任务「${title}」已引用经验 v${published.version}`);
  } else {
    console.log(`任务「${title}」已创建（未找到可引用经验）`);
  }
}

async function pendingTask(existing: Set<string>): Promise<void> {
  const title = 'M-200 备料评估';
  if (existing.has(title)) {
    console.log(`任务「${title}」已存在，跳过`);
    return;
  }
  const op = ids('seed:stock');
  await admin.createTask(
    {
      title,
      type: 'stock-planning',
      goal: '确认是否需要提前备货 M-200',
      acceptance: '给出建议备货量与触发条件',
      dueAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      input: { material: 'M-200', quantity: 200 },
    },
    op('create'),
  );
  console.log(`任务「${title}」已创建`);
}

/**
 * 让评论区、开放池、在线表与"智能体提案"都不是空的。
 *
 * 这些正是第二轮新增的协作面：没有它们，监管看板上什么都看不见，
 * 也就没法判断"报警到底有没有用"。
 */
async function collaboration(): Promise<void> {
  const tasks = await admin.tasks();
  const running = tasks.find(task => task.title === 'M-100 二次询单');
  const inventory = new CollabClient(URL_BASE, tokenFor('inventory'));
  const supplier = new CollabClient(URL_BASE, tokenFor('supplier'));

  if (running) {
    const comments = await admin.comments(running.id).catch(() => []);
    if (comments.length === 0) {
      await admin.comment(
        running.id,
        '@inventory 这次数量从 100 变成 160，先确认快照时间，不要直接复用上次结论。',
        'seed:comment:1',
      );
      await inventory.comment(running.id, '收到，上次快照是昨天 18:00 的，我先重新拉一次。', 'seed:comment:2');
      console.log(`任务「${running.title}」已留下两条评论`);
    }

    const offers = await admin.offers(running.id).catch(() => []);
    if (offers.length === 0) {
      await admin.publishOffer(
        running.id,
        { kind: 'supplier', capability: 'supplier:read', description: '核对 M-100 本周可供量与交期' },
        'seed:offer:1',
      );
      console.log('已挂出一条开放子任务（等能力匹配的智能体认领）');
    }
  }

  await supplier.heartbeat({ state: 'busy', note: '核对交期', client: 'seed' }).catch(() => {});
  // 库存智能体故意不心跳：它手上还挂着一个在办子任务，因此会触发 `agent_offline`。
  // 这个组合是刻意的——评论里它在说话、心跳里它不存在，正好演示"心跳链路坏了"
  // 这种最难发现的问题。协调者没有在办子任务，不心跳只会让在线表显示"未知"，不会报警。
  console.log('只上报了一条心跳（库存智能体与协调者都没有心跳，用于演示失联告警）');

  if (!tasks.some(task => task.title === 'M-200 紧急插单影响评估')) {
    const proposal = await inventory.createTask(
      {
        title: 'M-200 紧急插单影响评估',
        type: 'impact-assessment',
        goal: '客户要求 M-200 提前两周交付，评估是否可行',
        acceptance: '给出可行/不可行结论与依据，并标注数据观测时间',
        priority: 'high',
        dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        input: { material: 'M-200', quantity: 60 },
      },
      'seed:proposal:1',
    );
    await inventory.comment(
      proposal.id,
      '这条任务由智能体自己发起：观察到插单邮件后先立提案，等人接管再进入正式流程。',
      'seed:proposal:comment',
    );
    console.log('已创建一条智能体提案（等待人接管）');
  }
}

/**
 * 一个真的逾期了的子任务。
 *
 * 监管看板最怕"演示数据一切正常"，那样看不出报警有没有用。
 * 这里把截止时间放在 6 小时前，扫描后就会产生一条 high 级别的逾期告警。
 */
async function overdueTask(existing: Set<string>): Promise<void> {
  const title = 'M-300 交期确认（已逾期）';
  if (existing.has(title)) {
    console.log(`任务「${title}」已存在，跳过`);
    return;
  }
  const op = ids('seed:overdue');
  const created = await admin.createTask(
    {
      title,
      type: 'lead-time',
      goal: '确认 M-300 的实际交期',
      acceptance: '给出交期与来源，来源需可追溯',
      priority: 'high',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      input: { material: 'M-300', quantity: 40 },
    },
    op('create'),
  );
  await admin.assign(
    created.id,
    { agent: 'supplier', kind: 'supplier', dueAt: new Date(Date.now() - 6 * 3_600_000).toISOString() },
    op('assign'),
  );

  // 已接受但没有提交：既逾期、又算卡住，正是监管要找的状态。
  const supplier = new CollabClient(URL_BASE, tokenFor('supplier'));
  const item = (await supplier.inbox()).find(entry => entry.taskId === created.id);
  if (item) await supplier.accept(item.id, op('accept'));
  console.log(`任务「${title}」已建立逾期子任务`);
}

/** 留一条待审核的候选经验，让"经验库 → 待审核"不是空的。 */
async function pendingCandidate(): Promise<void> {
  const candidates = await admin.candidates();
  if (candidates.length > 0) {
    console.log('已有待审核经验，跳过');
    return;
  }
  const source = (await admin.tasks()).find(task => task.title === 'M-100 缺料分析');
  if (!source) return;
  await admin.candidate(
    source.id,
    {
      content: '同一物料短期二次询单时，先比对上次观测时间；库存快照超过 24 小时需重新拉取，不能直接复用上次结论。',
      conditions: '物料 M-100，距上次快照超过 24 小时',
    },
    'seed:candidate:pending',
  );
  console.log('已生成一条待审核候选经验');
}

async function main(): Promise<void> {
  const me = await admin.me();
  if (!me.roles.includes('admin') && !me.roles.includes('owner')) {
    console.error(`当前主体 ${me.id} 既不是管理员也不是负责人，无法填充演示数据`);
    process.exit(1);
  }
  console.log(`目标实例 ${URL_BASE}，以 ${me.id} 身份写入演示数据\n`);

  await ensureAgents();
  const existing = new Set((await admin.tasks()).map(task => task.title));
  await completedTask(existing);
  await runningTask(existing);
  await pendingTask(existing);
  await overdueTask(existing);
  await collaboration();
  await pendingCandidate();

  // 扫描放在最后：告警是"按当前数据重新评估"的结果，提前扫会把还没上报心跳的
  // 智能体判成失联，界面上就会同时出现"刚报过心跳"和"已失联"两条互相打脸的信息。
  // 真实环境里这一步由调度器按间隔执行（见 docs/local-operations.md）。
  const scan = await admin.scanAlerts();
  console.log(`\n告警扫描：新开 ${scan.opened} 条，更新 ${scan.updated} 条，自动解决 ${scan.resolved} 条，现存 ${scan.total} 条`);

  console.log('\n完成。用管理员令牌登录界面即可看到三条任务、一条已发布经验与新一轮协作数据。');
  console.log('监管者令牌：COLLAB_TOKEN=' + tokenFor(SUPERVISOR.id) + '（或用 COLLAB_SEED_SECRET 重新派生）');
  console.log(`智能体令牌可用 COLLAB_SEED_SECRET=${SEED_SECRET} 与主体 ID 重新派生。`);
}

main().catch(error => {
  console.error('填充失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
