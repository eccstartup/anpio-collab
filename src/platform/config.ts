/**
 * 配置。
 *
 * 所有环境变量在这里一次性解析并校验，出错就在启动时失败，
 * 而不是在某个请求中途才发现端口或路径不合法。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnrollMode } from './services/identity.ts';
import type { OversightThresholds } from './services/oversight.ts';

// 按模块位置定位，而不是 process.cwd()：从别的目录启动时（服务管理器、IDE、脚本）
// 工作目录往往不是仓库根，静态文件就会全部读不到，首页退化成 401 JSON。
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

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
  /** 陌生 DID 首次登录时的落位策略。 */
  anpEnroll: EnrollMode;
  /** 内网部署允许用 http 取 did.json（默认只对本机回环放行）。 */
  didAllowHttp: boolean;
  sessionHours: number;
  oversight: Partial<OversightThresholds>;
};

const parsePort = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT 不合法: ${raw}`);
  }
  return value;
};

const parsePositiveInt = (raw: string | undefined, fallback: number, name: string): number => {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数: ${raw}`);
  return value;
};

const parseEnroll = (raw: string | undefined): EnrollMode => {
  const value = raw ?? 'open';
  if (value !== 'open' && value !== 'pending' && value !== 'off') {
    throw new Error('COLLAB_ANP_ENROLL 只能是 open / pending / off');
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
    // 任务材料随创建请求以 base64 提交，默认上限要容得下 5 个文件、总计 2 MB 的原始内容。
    requestBodyLimit: Number(env.COLLAB_BODY_LIMIT ?? 4 * 1024 * 1024),
    webRoot: env.COLLAB_WEB_ROOT ?? DEFAULT_WEB_ROOT,
    logRequests: env.COLLAB_LOG_REQUESTS === '1',
    anpEnroll: parseEnroll(env.COLLAB_ANP_ENROLL),
    didAllowHttp: env.COLLAB_DID_HTTP === '1',
    sessionHours: parsePositiveInt(env.COLLAB_SESSION_HOURS, 24 * 7, 'COLLAB_SESSION_HOURS'),
    oversight: {
      offlineMinutes: parsePositiveInt(env.COLLAB_OFFLINE_MINUTES, 15, 'COLLAB_OFFLINE_MINUTES'),
      stalledSubtaskHours: parsePositiveInt(env.COLLAB_STALLED_HOURS, 24, 'COLLAB_STALLED_HOURS'),
      deniedThreshold: parsePositiveInt(env.COLLAB_DENIED_THRESHOLD, 8, 'COLLAB_DENIED_THRESHOLD'),
    },
  };
}
