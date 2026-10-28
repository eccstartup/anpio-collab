/**
 * 配置。
 *
 * 所有环境变量在这里一次性解析并校验，出错就在启动时失败，
 * 而不是在某个请求中途才发现端口或路径不合法。
 */

import { resolve } from 'node:path';

export type Config = {
  workspace: string;
  host: string;
  port: number;
  /** SQLite 文件路径，或 postgresql:// 连接串。 */
  database: string;
  bootstrapId: string;
  bootstrapToken: string | null;
  requestBodyLimit: number;
  webRoot: string;
  logRequests: boolean;
};

const parsePort = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT 不合法: ${raw}`);
  }
  return value;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const database = env.DATABASE_URL ?? env.COLLAB_DB ?? resolve(cwd, 'collab.sqlite3');
  const token = env.COLLAB_BOOTSTRAP_TOKEN ?? null;
  if (token !== null && token.length < 24) {
    throw new Error('COLLAB_BOOTSTRAP_TOKEN 至少需要 24 个字符');
  }
  return {
    workspace: env.COLLAB_WORKSPACE ?? 'local',
    host: env.HOST ?? '127.0.0.1',
    port: parsePort(env.PORT, 8787),
    database,
    bootstrapId: env.COLLAB_BOOTSTRAP_ID ?? 'admin',
    bootstrapToken: token,
    requestBodyLimit: Number(env.COLLAB_BODY_LIMIT ?? 65536),
    webRoot: env.COLLAB_WEB_ROOT ?? resolve(cwd, 'src/web'),
    logRequests: env.COLLAB_LOG_REQUESTS === '1',
  };
}
