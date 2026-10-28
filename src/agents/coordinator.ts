/**
 * 示例协调智能体（规则型，单次执行）。
 *
 * 职责：提议分工 → 等待业务智能体提交 → 核对数据并汇总 → 提交待人工验收。
 * 它不是超级主体：只能在自己被委派的任务上分派子任务，不能验收，
 * 也没有业务系统的访问权限。再次运行是安全的（幂等 + 状态检查）。
 */

import { clientFromEnv, operationId, requireEnv } from './env.ts';
import { CollabError } from '../sdk/client.ts';

type SubtaskView = {
  id: string;
  kind: string;
  agentId: string;
  status: string;
  result: { quantity?: number; summary?: string; source?: string; observedAt?: string } | null;
};

type TaskView = {
  task: { id: string; title: string; status: string; version: number; input: Record<string, unknown> };
  subtasks: SubtaskView[];
};

const STALE_DAYS = 7;

async function main(): Promise<void> {
  const client = clientFromEnv();
  const taskId = requireEnv('COLLAB_TASK');
  const plan: { kind: string; agent: string }[] = [
    { kind: 'inventory', agent: requireEnv('COLLAB_INVENTORY_AGENT') },
    { kind: 'supplier', agent: requireEnv('COLLAB_SUPPLIER_AGENT') },
  ];

  let view = (await client.task(taskId)) as TaskView;
  if (!['pending', 'running'].includes(view.task.status)) {
    console.log(`任务状态为 ${view.task.status}，无需协调`);
    return;
  }

  // 1. 提议分工：只为还没有对应子任务的角色补发邀请。
  for (const { kind, agent } of plan) {
    const exists = view.subtasks.some(item => item.kind === kind && item.agentId === agent);
    if (exists) continue;
    try {
      await client.assign(taskId, { agent, kind }, `coordinator:assign:${taskId}:${kind}:${agent}`);
      console.log(`已派发 ${kind} → ${agent}`);
    } catch (error) {
      // 409 表示别人已经派过，属于正常竞争，不重复处理。
      if (error instanceof CollabError && error.status === 409) {
        console.log(`${kind} 已存在，跳过`);
      } else {
        throw error;
      }
    }
  }

  view = (await client.task(taskId)) as TaskView;
  const relevant = plan.map(item => view.subtasks.find(subtask => subtask.kind === item.kind));
  if (relevant.some(item => item === undefined)) {
    console.log('子任务尚未建立完成，等待下一次运行');
    return;
  }
  if (!view.subtasks.every(item => item.status === 'submitted')) {
    const waiting = view.subtasks.filter(item => item.status !== 'submitted').map(item => `${item.kind}:${item.status}`);
    console.log(`等待业务结果（${waiting.join('，')}）`);
    return;
  }

  // 2. 核对数据：缺字段就明确失败，不猜测。
  const inventory = relevant[0] as SubtaskView;
  const supplier = relevant[1] as SubtaskView;
  const stock = inventory.result?.quantity;
  const offer = supplier.result?.quantity;
  if (typeof stock !== 'number' || typeof offer !== 'number') {
    throw new Error('库存或供应商结果缺少 quantity，请人工核对');
  }
  const demand = Number(view.task.input.quantity);
  const material = String(view.task.input.material ?? '未指定物料');
  if (!Number.isSafeInteger(demand)) throw new Error('任务输入缺少有效的 quantity');

  const gap = Math.max(0, demand - stock);
  const coverage = Math.min(offer, gap);
  const notes: string[] = [];
  const observedAt = [inventory.result?.observedAt, supplier.result?.observedAt]
    .filter((value): value is string => typeof value === 'string')
    .sort()[0];
  if (observedAt) {
    const days = (Date.now() - Date.parse(observedAt)) / 86_400_000;
    if (days > STALE_DAYS) notes.push(`数据观测于 ${observedAt}，已超过 ${STALE_DAYS} 天，需核对时效`);
  }
  if (coverage < gap) notes.push(`供应商可供量不足以覆盖缺口，仍缺 ${gap - coverage}`);

  const text = [
    `物料 ${material}：需求 ${demand}，库存 ${stock}（来源 ${inventory.result?.source ?? '未注明'}），缺口 ${gap}。`,
    `供应商可供 ${offer}（来源 ${supplier.result?.source ?? '未注明'}），可覆盖 ${coverage}。`,
    notes.length > 0 ? `待确认：${notes.join('；')}。` : '数据来源与时效未见异常，仍需人工确认交期。',
    '本结果为建议，平台不自动下单。',
  ].join('');

  await client.stageSummary(
    taskId,
    { text, pending: notes.length > 0 ? notes.join('；') : '人工确认交期与最终采购动作' },
    `coordinator:stage:${taskId}:${view.task.version}`,
  );
  await client.summary(taskId, text, `coordinator:summary:${taskId}:${view.task.version}`);
  console.log('已提交汇总，等待负责人验收');
}

main().catch(error => {
  console.error(`协调智能体失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
