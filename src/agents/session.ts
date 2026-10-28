/**
 * 智能体怎么拿到会话。
 *
 * 两条路，优先级明确：
 *  1. `COLLAB_ANP_KEY` —— 指向一个 Ed25519 私钥 JWK 文件，走 ANP-02 登录换令牌。
 *     私钥留在自己的机器上，平台只验签；这是推荐的接入方式。
 *  2. `COLLAB_TOKEN` —— 管理员登记主体时一次性给出的静态令牌，给不想管密钥的场景。
 *
 * ANP 令牌会缓存在状态目录里（默认 `.anpio-collab/`），没过期就复用：
 * 每个子命令都签一次名既慢又会让审计日志被登录刷满。令牌失效后自动重登。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { anpLogin, AnpLoginError, type AnpLoginResult } from '../anp/client.ts';
import { identityFromJwk, type AnpIdentity } from '../anp/identity.ts';
import type { webcrypto } from 'node:crypto';
import { CollabClient } from '../sdk/client.ts';

export type AgentSession = {
  token: string;
  mode: 'anp' | 'token';
  did: string | null;
  /** ANP 会话的到期时间；静态令牌没有这个概念。 */
  expiresAt: string | null;
};

type CachedSession = {
  token: string;
  did: string;
  expiresAt: string;
  baseUrl: string;
};

/** 到期前留一点余量，避免刚好卡在边界上被服务端拒绝。 */
const RENEW_MARGIN_MS = 60_000;

function sessionFile(handle: string, baseUrl: string): string {
  if (process.env.COLLAB_SESSION_FILE) return resolve(process.env.COLLAB_SESSION_FILE);
  // 环境变量在调用时读：测试与脚本会临时改它。
  const stateDir = process.env.COLLAB_STATE_DIR ?? '.anpio-collab';
  const safeBase = baseUrl.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  return join(stateDir, `session-${safeBase}-${handle.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);
}

function readCache(file: string): CachedSession | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CachedSession;
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(file: string, value: CachedSession): void {
  mkdirSync(dirname(file), { recursive: true });
  // 令牌等同于身份：只给当前用户读写。
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** 从 `COLLAB_ANP_KEY` 读一个 Ed25519 JWK；handle 决定默认主体名。 */
export function loadIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): { identity: AnpIdentity; handle: string } | null {
  const keyPath = env.COLLAB_ANP_KEY;
  if (!keyPath) return null;
  const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as webcrypto.JsonWebKey;
  if (parsed.kty !== 'OKP') throw new Error(`${keyPath} 不是 Ed25519 JWK（kty 应为 OKP）`);
  // DID 由"公钥 + handle"共同决定：文件名就是默认 handle，
  // 想用别的名字请显式设置 COLLAB_ANP_HANDLE，否则会得到另一个 DID。
  const handle =
    env.COLLAB_ANP_HANDLE?.trim() ||
    basename(keyPath).replace(/\.json$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  return { identity: identityFromJwk(parsed, { handle, domain: env.COLLAB_ANP_DOMAIN }), handle };
}

/**
 * 取一个可用的会话。
 *
 * `force` 用于显式执行 `login` 子命令：忽略缓存，重新签一次。
 */
export async function resolveAgentSession(
  options: { baseUrl: string; force?: boolean; bindCode?: string } = { baseUrl: '' },
): Promise<AgentSession> {
  const baseUrl = options.baseUrl || process.env.COLLAB_URL || '';
  const loaded = loadIdentityFromEnv();

  if (!loaded) {
    const token = process.env.COLLAB_TOKEN;
    if (!token) {
      throw new Error(
        '缺少凭据：设置 COLLAB_ANP_KEY（Ed25519 JWK 文件路径，走 ANP 登录）或 COLLAB_TOKEN（静态令牌）',
      );
    }
    return { token, mode: 'token', did: null, expiresAt: null };
  }

  if (!baseUrl) throw new Error('ANP 登录需要 COLLAB_URL');
  const { identity, handle } = loaded;
  const file = sessionFile(handle, baseUrl);

  if (!options.force) {
    const cached = readCache(file);
    if (
      cached &&
      cached.baseUrl === baseUrl &&
      cached.did === identity.did &&
      Date.parse(cached.expiresAt) - RENEW_MARGIN_MS > Date.now()
    ) {
      return { token: cached.token, mode: 'anp', did: cached.did, expiresAt: cached.expiresAt };
    }
  }

  let result: AnpLoginResult;
  try {
    result = await anpLogin({ baseUrl, identity, client: 'agent', bindCode: options.bindCode });
  } catch (error) {
    if (error instanceof AnpLoginError && error.code === 'enrollment_pending') {
      throw new Error(
        `这条 DID 已登记但还在等批准：让管理员在「参与者」里批准 ${identity.did}，或先签发绑定码再登录`,
      );
    }
    throw error;
  }

  writeCache(file, {
    token: result.token,
    did: result.did,
    expiresAt: result.sessionExpiresAt,
    baseUrl,
  });
  return { token: result.token, mode: 'anp', did: result.did, expiresAt: result.sessionExpiresAt };
}

/**
 * 按环境变量建客户端。
 *
 * 只在需要时登录：读命令也走同一条路，因为"能读到什么"本身就是权限问题，
 * 用令牌猜权限不如老老实实登一次。
 */
export async function createAgentClient(): Promise<CollabClient> {
  const baseUrl = process.env.COLLAB_URL;
  if (!baseUrl) throw new Error('缺少环境变量 COLLAB_URL');
  const session = await resolveAgentSession({ baseUrl });
  return new CollabClient(baseUrl, session.token, {
    timeoutMs: Number(process.env.COLLAB_TIMEOUT_MS ?? 10_000),
  });
}

const isUnauthorized = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as { status?: number }).status === 401);

/**
 * 跑一次需要会话的操作；令牌失效时重新登录再试一次。
 *
 * 缓存里的令牌可能已经被撤销或到期——那是服务端的事实，本地无从预知。
 * 与其每条命令都先探测一次，不如等它真的 401 再重签：代价更低，也更诚实。
 */
export async function withAgentClient<T>(fn: (client: CollabClient) => Promise<T>): Promise<T> {
  const baseUrl = process.env.COLLAB_URL;
  if (!baseUrl) throw new Error('缺少环境变量 COLLAB_URL');
  const make = (token: string) =>
    new CollabClient(baseUrl, token, { timeoutMs: Number(process.env.COLLAB_TIMEOUT_MS ?? 10_000) });

  const session = await resolveAgentSession({ baseUrl });
  try {
    return await fn(make(session.token));
  } catch (error) {
    // 静态令牌重试没有意义：它不会自己变好。
    if (!isUnauthorized(error) || session.mode !== 'anp') throw error;
    const renewed = await resolveAgentSession({ baseUrl, force: true });
    return fn(make(renewed.token));
  }
}

/** 错误信息里只露 DID 的前后段，避免把整条标识刷满日志。 */
export function shortDid(did: string | null): string {
  if (!did) return '（静态令牌）';
  const parts = did.split(':');
  const tail = parts[parts.length - 1] ?? '';
  return tail.length > 24 ? `${tail.slice(0, 10)}…${tail.slice(-6)}` : did;
}
