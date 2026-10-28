/**
 * ANP 登录客户端。
 *
 * 与 `anpio-cli anp login` 走同一条路：取挑战 → 对 `{nonce, did, didDocument}`
 * 签名 → 换会话令牌。两条差异是刻意的：
 *  - 先主动取 nonce，省掉一次 401 往返；服务器若仍返回挑战，再答一次；
 *  - 请求体里的可选字段（`bindCode` / `client`）只用于"绑定到已有账号"
 *    与展示，不改变验签方式。
 *
 * 这个模块不读环境变量、不写磁盘：拿一个 identity 就能登录，
 * 因此测试与示例智能体用的是同一份代码。
 */

import type { AnpIdentity } from './identity.ts';
import { signRequest } from './signature.ts';

export type AnpLoginOptions = {
  /** 平台根地址，例如 http://127.0.0.1:8787 */
  baseUrl: string;
  identity: AnpIdentity;
  /** 绑定码：把本 DID 绑到已存在的主体上，实现"人和智能体同一个账号"。 */
  bindCode?: string;
  /** 只用于展示与默认角色。 */
  client?: 'browser' | 'agent';
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type AnpLoginResult = {
  token: string;
  tokenType: string;
  did: string;
  subject: string;
  principal: { id: string; displayName: string; roles: string[]; kind: string; workspace: string };
  sessionExpiresAt: string;
  /** auto：首次登录自动登记；bound：绑定到已有账号；existing：已有身份。 */
  enrollment: 'auto' | 'bound' | 'existing' | string;
};

export class AnpLoginError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AnpLoginError';
    this.status = status;
    this.code = code;
  }
}

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** `WWW-Authenticate: ANP nonce="..."` 里的 nonce。 */
export function nonceFromChallenge(header: string | null): string | null {
  if (!header) return null;
  const match = /nonce\s*=\s*"?([^",\s]+)"?/i.exec(header);
  return match ? match[1]! : null;
}

async function fetchChallenge(baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<string> {
  const response = await fetchImpl(`${trimBase(baseUrl)}/auth/anp/challenge`, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await readJson(response);
  if (!response.ok || typeof payload.nonce !== 'string') {
    throw new AnpLoginError(response.status, 'challenge_failed', '无法获取登录挑战');
  }
  return payload.nonce;
}

/**
 * 登录并在失败时解释原因。
 *
 * `401` 一律按"证明没通过"处理，`403` 按"身份通过但被拒"（待批准 / 已停用），
 * `409` 留给 DID 冲突这类需要人介入的情况。
 */
export async function anpLogin(options: AnpLoginOptions): Promise<AnpLoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = trimBase(options.baseUrl);
  const url = `${base}/auth/anp/login`;

  const attempt = async (nonce: string): Promise<Response> => {
    const body = JSON.stringify({
      nonce,
      did: options.identity.did,
      didDocument: options.identity.didDocument,
      ...(options.bindCode ? { bindCode: options.bindCode } : {}),
      client: options.client ?? 'agent',
    });
    const signed = signRequest({
      url,
      method: 'POST',
      body,
      nonce,
      keyid: options.identity.keyid,
      privateKey: options.identity.privateKey,
    });
    return fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed.headers },
      body: signed.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  let response = await attempt(await fetchChallenge(base, fetchImpl, timeoutMs));

  if (response.status === 401) {
    // 服务器要求它自己发的 nonce（例如挑战过期），答一次；再拒就是拒了。
    const challenged = nonceFromChallenge(response.headers.get('www-authenticate'));
    if (challenged) response = await attempt(challenged);
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const error = (payload.error ?? {}) as { code?: string; message?: string };
    throw new AnpLoginError(
      response.status,
      error.code ?? `http_${response.status}`,
      error.message ?? `登录失败（HTTP ${response.status}）`,
    );
  }
  const token = typeof payload.token === 'string' ? payload.token : '';
  if (!token) throw new AnpLoginError(502, 'no_token', '服务器接受了证明但没有签发会话令牌');
  return {
    token,
    tokenType: typeof payload.tokenType === 'string' ? payload.tokenType : 'Bearer',
    did: String(payload.did ?? options.identity.did),
    subject: String(payload.subject ?? options.identity.did),
    principal: payload.principal as AnpLoginResult['principal'],
    sessionExpiresAt: String(payload.sessionExpiresAt ?? ''),
    enrollment: typeof payload.enrollment === 'string' ? payload.enrollment : 'existing',
  };
}
