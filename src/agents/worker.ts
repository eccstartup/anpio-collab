/**
 * 示例业务智能体：按静态数据回答"某物料可供多少"。
 *
 * 这是一个独立进程：它只通过 HTTP 拿到自己的子任务，用本地数据文件作答，
 * 不知道平台数据库，也不读取其他智能体的结果。
 *
 * 流程：重放未确认请求 → 拉取待办 → 接受 → 提交（带来源与观测时间）。
 * 找不到资料时拒绝，而不是猜测一个数字。
 */

import { readFile } from 'node:fs/promises';
import { clientFromEnv, operationId, optionalEnv, requireEnv } from './env.ts';
import { RequestJournal } from '../sdk/journal.ts';

type InboxItem = {
  id: string;
  kind: string;
  status: string;
  version: number;
  task: { id: string; title: string; input: Record<string, unknown> };
};

async function main(): Promise<void> {
  const kind = requireEnv('COLLAB_KIND');
  const dataFile = requireEnv('COLLAB_DATA');
  const journalPath = requireEnv('COLLAB_WORKER_DB');
  const client = clientFromEnv();

  const raw = JSON.parse(await readFile(dataFile, 'utf8')) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('数据文件应为 { "物料编号": 数量 } 形式的对象');
  }
  const data = new Map<string, number>();
  for (const [material, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`数据文件中的 ${material} 必须是非负整数`);
    }
    data.set(material, value);
  }

  const me = await client.me();
  const journal = new RequestJournal(journalPath, {
    url: client.baseUrl,
    principal: me.id,
    workspace: me.workspace,
  });

  try {
    const replayed = await journal.replay(client);
    if (replayed > 0) console.log(`[${kind}] 已重放 ${replayed} 条未确认请求`);

    const inbox = (await client.inbox()) as InboxItem[];
    const mine = inbox.filter(item => item.kind === kind);
    console.log(`[${kind}] 待办 ${mine.length} 条`);

    for (const item of mine) {
      const material = item.task.input.material;
      if (typeof material !== 'string' || material === '') {
        if (item.status !== 'rejected') {
          await journal.send(
            client,
            `subtasks/${item.id}/reject`,
            { reason: '任务输入缺少 material 字段' },
            operationId('reject', item.id),
          );
          console.log(`[${kind}] 拒绝 ${item.id}：输入缺少 material`);
        }
        continue;
      }
      const quantity = data.get(material);
      if (quantity === undefined) {
        if (item.status !== 'rejected') {
          await journal.send(
            client,
            `subtasks/${item.id}/reject`,
            { reason: `本地数据中没有物料 ${material}` },
            operationId('reject', item.id),
          );
          console.log(`[${kind}] 拒绝 ${item.id}：没有 ${material} 的资料`);
        }
        continue;
      }

      if (item.status !== 'accepted') {
        await journal.send(client, `subtasks/${item.id}/accept`, {}, operationId('accept', item.id));
        console.log(`[${kind}] 接受 ${item.id}`);
      }

      await journal.send(
        client,
        `subtasks/${item.id}/submit`,
        {
          result: {
            quantity,
            source: dataFile,
            observedAt: new Date().toISOString(),
            summary: `${kind} 数据：${material} 可供 ${quantity}`,
          },
        },
        operationId('submit', item.id),
      );
      console.log(`[${kind}] 提交 ${item.id}：${material} = ${quantity}`);
    }

    if (optionalEnv('COLLAB_WORKER_ACK_INVITES') === '1') {
      const notifications = (await client.notifications()) as { id: string }[];
      for (const notification of notifications) {
        await client.acknowledge(notification.id, operationId('ack', notification.id));
      }
      if (notifications.length > 0) console.log(`[${kind}] 确认通知 ${notifications.length} 条`);
    }
  } finally {
    journal.close();
  }
}

main().catch(error => {
  console.error(`业务智能体失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
