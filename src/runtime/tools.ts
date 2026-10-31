/**
 * 一轮运行里模型可以调用的工具。
 *
 * 每个工具都是"平台协议 + 沙箱原语"的薄封装：参数校验在模型适配层之外，
 * 失败以文本回到模型，让它自己决定换一种做法；只有"写请求结果未知"
 * 是致命的——这时本轮必须停下并以 outcome_unknown 收尾，不能假装成功。
 */

import { CollabError, type CollabClient } from '../sdk/client.ts';
import type { EmbeddedAgentDefinition, EmbeddedTool } from './definition.ts';
import type { ToolCall, ToolSpec } from './brains/types.ts';
import { listFilesInside, readFileInside, runShell, writeFileInside } from './sandbox.ts';

const MAX_RESULT_CHARS = 6_000;

export type ToolExecution = {
  content: string;
  /** finish 工具被调用时返回，运行时据此结束本轮。 */
  finish?: { summary: string; outcome: string };
  /** 写请求结果未知：本轮必须以 outcome_unknown 结束。 */
  uncertain?: string;
};

export type ToolLog = (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void;

export type ToolOptions = {
  client: CollabClient;
  runDir: string;
  runId: string;
  definition: EmbeddedAgentDefinition;
  log: ToolLog;
  heartbeat?: () => void | Promise<void>;
};

type Schema = Record<string, unknown>;

function schema(properties: Schema, required: string[] = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const SPECS: Record<EmbeddedTool, ToolSpec> = {
  task_get: {
    name: 'task_get',
    description: '读取一个任务的详情：验收条件、子任务、事件与材料清单。',
    parameters: schema({ taskId: { type: 'string', description: '任务 id' } }),
  },
  task_accept: {
    name: 'task_accept',
    description: '接下分配给你的子任务。接活前应先看任务详情确认能做。',
    parameters: schema({
      subtaskId: { type: 'string' },
      version: { type: 'integer', description: '可选：当前版本号，用于并发保护' },
    }, ['subtaskId']),
  },
  task_progress: {
    name: 'task_progress',
    description: '汇报进展。若等待外部条件，用这个而不是猜测结果。',
    parameters: schema({
      subtaskId: { type: 'string' },
      text: { type: 'string', description: '给人看的一句话进展' },
      version: { type: 'integer' },
    }, ['subtaskId', 'text']),
  },
  task_submit: {
    name: 'task_submit',
    description:
      '提交子任务结果。result 是结构化对象：summary 或 quantity 至少一个，另需 source（结果来源）与 observedAt（UTC 时间）。',
    parameters: schema({
      subtaskId: { type: 'string' },
      result: { type: 'object', description: '结构化结果，例如 {summary, artifacts, checks}' },
      version: { type: 'integer' },
    }, ['subtaskId', 'result']),
  },
  task_comment: {
    name: 'task_comment',
    description: '在任务评论区留言，可 @ 人（body 里写 @名称 或 @主体 id）。',
    parameters: schema({
      taskId: { type: 'string' },
      body: { type: 'string', description: '留言正文，最长 20000 字' },
    }),
  },
  knowledge_search: {
    name: 'knowledge_search',
    description: '在公司知识库里检索，返回带版本的条目摘要与正文片段。',
    parameters: schema({
      query: { type: 'string' },
      limit: { type: 'integer', description: '可选，默认 10，最多 50' },
    }, ['query']),
  },
  shell: {
    name: 'shell',
    description:
      '在本次运行的沙箱工作目录里执行 shell 命令。环境里没有平台令牌和模型密钥；超时与输出长度都有限制。',
    parameters: schema({
      command: { type: 'string', description: '在 /bin/sh -lc 下执行的命令，最多 8000 字符' },
    }),
  },
  read_file: {
    name: 'read_file',
    description: '读取工作目录里的文本文件（最多 256 KiB）。',
    parameters: schema({ path: { type: 'string', description: '相对工作目录的路径' } }),
  },
  write_file: {
    name: 'write_file',
    description: '在工作目录里写入文本文件。目录外的路径会被拒绝。',
    parameters: schema({
      path: { type: 'string' },
      content: { type: 'string' },
    }),
  },
  list_files: {
    name: 'list_files',
    description: '列出工作目录（或其中的子目录）条目。',
    parameters: schema({ path: { type: 'string', description: '可选，默认 "."' } }, []),
  },
  finish: {
    name: 'finish',
    description: '结束本轮。调用前应已经把该做的提交、留言做完。',
    parameters: schema({
      summary: { type: 'string', description: '这一轮做了什么，一到三句话' },
      outcome: {
        type: 'string',
        enum: ['done', 'nothing_to_do', 'blocked'],
        description: 'done=处理完毕；nothing_to_do=消息不需要行动；blocked=需要人参与',
      },
    }, ['summary']),
  },
};

function textOf(input: Record<string, unknown>, key: string, max = 20_000): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`缺少参数 ${key}`);
  if (value.length > max) throw new Error(`参数 ${key} 过长（上限 ${max}）`);
  return value;
}

function optionalVersion(input: Record<string, unknown>): number | undefined {
  const value = input.version;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('参数 version 必须是整数');
  }
  return value;
}

function render(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…（已截断）` : text;
}

export function createTools(options: ToolOptions) {
  const { client, runDir, runId, definition, log } = options;
  const enabled = new Set<string>(definition.tools);
  const specs = definition.tools.map(tool => SPECS[tool]).filter((spec): spec is ToolSpec => Boolean(spec));

  const operation = (call: ToolCall, suffix = '') => `run:${runId}:${call.id}${suffix ? `:${suffix}` : ''}`;

  async function execute(call: ToolCall): Promise<ToolExecution> {
    if (!enabled.has(call.name)) {
      return { content: `工具 ${call.name} 没有在这一轮启用` };
    }
    const input = call.input ?? {};
    try {
      switch (call.name) {
        case 'task_get': {
          const taskId = textOf(input, 'taskId', 128);
          const task = await client.task(taskId);
          return {
            content: render({
              task: task.task,
              subtasks: task.subtasks,
              coordinators: task.coordinators,
              materials: task.materials,
            }),
          };
        }
        case 'task_accept':
          return {
            content: render(await client.accept(textOf(input, 'subtaskId', 128), operation(call), optionalVersion(input))),
          };
        case 'task_progress':
          return {
            content: render(
              await client.progress(
                textOf(input, 'subtaskId', 128),
                textOf(input, 'text', 4_000),
                operation(call),
                optionalVersion(input),
              ),
            ),
          };
        case 'task_submit': {
          const result = input.result;
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error('参数 result 必须是对象');
          }
          return {
            content: render(
              await client.submit(
                textOf(input, 'subtaskId', 128),
                result as Record<string, unknown>,
                operation(call),
                optionalVersion(input),
              ),
            ),
          };
        }
        case 'task_comment':
          return {
            content: render(
              await client.comment(textOf(input, 'taskId', 128), textOf(input, 'body', 20_000), operation(call)),
            ),
          };
        case 'knowledge_search': {
          const limit = input.limit === undefined ? 10 : Number(input.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit 必须是 1..50 的整数');
          const found = await client.searchKnowledge(textOf(input, 'query', 500), limit);
          return { content: render(found) };
        }
        case 'shell': {
          if (!definition.sandbox.shell) throw new Error('这一轮没有开启 shell');
          const result = await runShell({
            command: textOf(input, 'command', 8_000),
            cwd: runDir,
            timeoutMs: definition.sandbox.shellTimeoutMs,
            maxOutputBytes: definition.sandbox.maxOutputBytes,
          });
          return {
            content: render({
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: result.timedOut,
              truncated: result.truncated,
            }),
          };
        }
        case 'read_file':
          return { content: render(await readFileInside(runDir, textOf(input, 'path', 1_000))) };
        case 'write_file': {
          const bytes = await writeFileInside(runDir, textOf(input, 'path', 1_000), textOf(input, 'content'));
          return { content: `已写入 ${bytes} 字节` };
        }
        case 'list_files': {
          const entries = await listFilesInside(runDir, input.path === undefined ? '.' : textOf(input, 'path', 1_000));
          return { content: render(entries) };
        }
        case 'finish':
          return {
            content: '本轮结束。',
            finish: {
              summary: textOf(input, 'summary', 2_000),
              outcome: typeof input.outcome === 'string' ? input.outcome : 'done',
            },
          };
        default:
          return { content: `未知工具 ${call.name}` };
      }
    } catch (error) {
      if (error instanceof CollabError && error.uncertain) {
        log('error', `工具 ${call.name} 的结果未知：${error.message}`);
        return { content: `写请求结果未知：${error.message}`, uncertain: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      log('warn', `工具 ${call.name} 失败：${message}`);
      return { content: `工具执行失败：${message}` };
    }
  }

  return { specs, execute };
}
