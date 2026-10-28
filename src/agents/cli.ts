/**
 * 命令行桥接：给"用户自己操作的智能体"（Claude Code、Codex 等）用。
 *
 * 这些客户端没有后台进程，靠人触发命令；因此每个命令都是一次完整的
 * 读或写，操作编号由动作和子任务 ID 推导，重跑同一条命令是安全的。
 *
 * 身份有两种来源（见 session.ts）：
 *   COLLAB_ANP_KEY=./agent-key.json   走 ANP 登录，私钥留在本机
 *   COLLAB_TOKEN=...                  用管理员给的静态令牌
 *
 * 用法：
 *   node src/agents/cli.ts login [绑定码]
 *   node src/agents/cli.ts whoami | inbox | offers
 *   node src/agents/cli.ts claim <offerId>
 *   node src/agents/cli.ts accept <subtaskId>
 *   node src/agents/cli.ts submit <subtaskId> < result.json
 *   node src/agents/cli.ts comment <taskId> "…@某人 看一下"
 *   node src/agents/cli.ts heartbeat online "正在跑库存快照"
 *   node src/agents/cli.ts knowledge "缺料"
 */

import { resolveAgentSession, shortDid, withAgentClient } from './session.ts';
import { CollabClient } from '../sdk/client.ts';

const USAGE = `用法:
  login [绑定码] | whoami | me
  inbox | notifications | offers
  claim <offerId>
  task <taskId> | context <taskId> | comments <taskId>
  comment <taskId> <内容>
  adopt <taskId>
  heartbeat [online|busy|offline] [备注] | presence | oversight
  knowledge [查询] | search <关键词> [limit]
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
    case 'offers':
      return client.openOffers();
    case 'claim':
      if (!first) throw new Error('需要 offerId');
      return client.claimOffer(first, `cli:claim:${first}`);
    case 'comments':
      if (!first) throw new Error('需要 taskId');
      return client.comments(first);
    case 'comment':
      if (!first || !rest[0]) throw new Error('需要 taskId 与内容');
      // 评论是追加而不是覆盖，重复执行会多出一条，所以带时间戳。
      return client.comment(first, rest.join(' '), `cli:comment:${first}:${Date.now()}`);
    case 'adopt':
      if (!first) throw new Error('需要 taskId');
      return client.adopt(first, `cli:adopt:${first}`);
    case 'heartbeat': {
      const state = first ?? 'online';
      if (!['online', 'busy', 'offline'].includes(state)) {
        throw new Error('state 必须是 online / busy / offline');
      }
      return client.heartbeat({
        state: state as 'online' | 'busy' | 'offline',
        ...(rest.length ? { note: rest.join(' ') } : {}),
        client: 'cli',
      });
    }
    case 'presence':
      return client.presence();
    case 'oversight':
      return client.oversight();
    case 'ack':
      if (!first) throw new Error('需要 notificationId');
      return client.acknowledge(first, `cli:ack:${first}`);
    default:
      throw new Error(USAGE);
  }
}

/**
 * `login` 单独走一条路：它只需要会话，不需要读写业务数据。
 * 加 `--force` 时忽略缓存，重新签一次名。
 */
async function login(argv: string[]): Promise<unknown> {
  const baseUrl = process.env.COLLAB_URL;
  if (!baseUrl) throw new Error('缺少环境变量 COLLAB_URL');
  const session = await resolveAgentSession({ baseUrl, force: true, bindCode: argv[0] });
  const client = new CollabClient(baseUrl, session.token);
  const me = await client.me();
  return {
    mode: session.mode,
    did: session.did,
    expiresAt: session.expiresAt,
    principal: me,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command] = argv;
  if (command === 'login') {
    const result = await login(argv.slice(1));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'whoami') {
    const baseUrl = process.env.COLLAB_URL ?? '';
    const session = await resolveAgentSession({ baseUrl });
    const me = await new CollabClient(baseUrl, session.token).me();
    console.log(JSON.stringify({ mode: session.mode, did: shortDid(session.did), expiresAt: session.expiresAt, principal: me }, null, 2));
    return;
  }
  const result = await withAgentClient(client => run(client, argv));
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
