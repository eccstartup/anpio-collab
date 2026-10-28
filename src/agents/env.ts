/**
 * 示例智能体的公共环境处理。
 */

import { CollabClient } from '../sdk/client.ts';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

export function clientFromEnv(): CollabClient {
  return new CollabClient(requireEnv('COLLAB_URL'), requireEnv('COLLAB_TOKEN'), {
    timeoutMs: Number(process.env.COLLAB_TIMEOUT_MS ?? 10_000),
  });
}

/** 稳定的操作编号：同一子任务、同一动作只会有一次有效写操作。 */
export function operationId(action: string, subtaskId: string): string {
  return `${action}:${subtaskId}`;
}
