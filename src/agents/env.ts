/**
 * 示例智能体的公共环境处理。
 */

import type { CollabClient } from '../sdk/client.ts';
import { createAgentClient } from './session.ts';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

/**
 * 按环境变量建客户端。
 *
 * 可能是 ANP 登录换来的会话令牌，也可能是静态令牌 —— 具体由 session.ts 决定。
 * 之所以是异步的：第一次 ANP 登录要签名，还要走一次网络往返。
 */
export function clientFromEnv(): Promise<CollabClient> {
  return createAgentClient();
}

/** 稳定的操作编号：同一子任务、同一动作只会有一次有效写操作。 */
export function operationId(action: string, subtaskId: string): string {
  return `${action}:${subtaskId}`;
}
