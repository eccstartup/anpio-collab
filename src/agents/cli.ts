/**
 * 命令行桥接：给"用户自己操作的智能体"（Claude Code、Codex 等）用。
 *
 * 这些客户端没有后台进程，靠人触发命令；因此每个命令都是一次完整的
 * 读或写，操作编号由动作和子任务 ID 推导，重跑同一条命令是安全的。
 *
 * 用法：
 *   node src/agents/cli.ts inbox
 *   node src/agents/cli.ts accept <subtaskId>
 *   node src/agents/cli.ts submit <subtaskId> < result.json
 *   node src/agents/cli.ts reject <subtaskId> "缺少 X 数据"
 *   node src/agents/cli.ts knowledge "缺料"
 */

import { clientFromEnv } from './env.ts';
import { CollabClient } from '../sdk/client.ts';

const USAGE = `用法:
  inbox | me | notifications | knowledge [查询]
  task <taskId> | context <taskId>
  search <关键词> [limit]
  accept <subtaskId>
  reject <subtaskId> <原因>
  submit <subtaskId> < result.json
  progress <subtaskId> <说明>
  outcome-unknown <subtaskId> <原因> <外部操作编号>
  ack <notificationId>`;

async function readStdin(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error('标准输入超过 64 KiB');
  }
  return input.trim();
}

function parseResultJson(text: string): Record<string, unknown> {
  if (!text) throw new Error('需要从标准输入提供 result JSON');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('result 必须是 JSON 对象');
  return parsed;
}

async function run(client: CollabClient, argv: string[]): Promise<unknown> {
  const [command, first, ...rest] = argv;
  switch (command) {
    case 'me':
      return client.me();
    case 'inbox':
      return client.inbox();
    case 'notifications':
      return client.notifications();
    case 'knowledge':
      return client.knowledge(first ?? '');
    case 'search':
      return client.searchKnowledge(first ?? '', Number(rest[0] ?? 10));
    case 'task':
      if (!first) throw new Error('需要 taskId');
      return client.task(first);
    case 'context':
      if (!first) throw new Error('需要 taskId');
      return client.context(first);
    case 'accept':
      if (!first) throw new Error('需要 subtaskId');
      return client.accept(first, `cli:accept:${first}`);
    case 'reject':
      if (!first || !rest[0]) throw new Error('需要 subtaskId 与原因');
      return client.reject(first, rest.join(' '), `cli:reject:${first}`);
    case 'progress':
      if (!first || !rest[0]) throw new Error('需要 subtaskId 与说明');
      return client.progress(first, rest.join(' '), `cli:progress:${first}:${Date.now()}`);
    case 'submit':
      if (!first) throw new Error('需要 subtaskId');
      return client.submit(first, parseResultJson(await readStdin()), `cli:submit:${first}`);
    case 'outcome-unknown':
      if (!first || !rest[0] || !rest[1]) throw new Error('需要 subtaskId、原因与外部操作编号');
      return client.outcomeUnknown(
        first,
        { reason: rest[0], externalOperationId: rest[1] },
        `cli:outcome-unknown:${first}`,
      );
    case 'ack':
      if (!first) throw new Error('需要 notificationId');
      return client.acknowledge(first, `cli:ack:${first}`);
    default:
      throw new Error(USAGE);
  }
}

async function main(): Promise<void> {
  const client = clientFromEnv();
  const result = await run(client, process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
