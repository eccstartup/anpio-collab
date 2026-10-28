/**
 * did:wba 文档解析（注册校验）。
 *
 * 平台不接受"客户端自带一份 didDocument 就当它是真的"：那样的文档谁都能编，
 * 编一份带自己公钥的文档就能把任意 DID 绑到自己账号上。因此登录与绑定都必须
 * 先到 DID 所属服务器上取回文档，取不到就判定"未注册"。
 *
 * 解析规则按 did:wba：`did:wba:<authority>:<path...>` → `<scheme>://<authority>/<path>/did.json`。
 * `authority` 里的 `%3A` 是端口（DID 的冒号分隔与 host:port 冲突，规范用百分号转义）。
 *
 * 取文档这一步本身就是对外发请求，所以边界写死在这里：
 *  - 只允许 did:wba，别的 method 不猜；
 *  - 只走 https；本机回环与显式开启的内网模式才允许 http；
 *  - 不跟随重定向（3xx 可能把请求引到内网元数据端点）；
 *  - 3 秒超时、64KB 上限，超过就当不可用；
 *  - 成功结果缓存 5 分钟，失败不缓存——刚注册完的 DID 要能立刻用。
 */

export type DidDocumentResult = {
  document: Record<string, unknown>;
  /** 文档实际地址，排障与审计用。 */
  url: string;
  cached: boolean;
};

export type DidResolutionErrorCode =
  | 'invalid_did'
  | 'unsupported_method'
  | 'insecure_transport'
  | 'unreachable'
  | 'not_found'
  | 'redirected'
  | 'too_large'
  | 'bad_document';

export class DidResolutionError extends Error {
  readonly code: DidResolutionErrorCode;
  readonly did: string;
  readonly url: string | null;

  constructor(code: DidResolutionErrorCode, did: string, message: string, url: string | null = null) {
    super(message);
    this.name = 'DidResolutionError';
    this.code = code;
    this.did = did;
    this.url = url;
  }
}

export type DidResolver = {
  resolve(did: string): Promise<DidDocumentResult>;
  /** 本地缓存作废（解绑、换钥后强制重新取）。 */
  invalidate(did: string): void;
};

export type DidResolverOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  cacheTtlMs?: number;
  /** 内网部署没有证书时打开：非回环地址也允许 http。默认只对本机回环放行。 */
  allowInsecureHttp?: boolean;
  /** 便于测试注入时钟。 */
  now?: () => number;
};

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]|::1)$/i;
/** host[:port]；不允许 userinfo、路径、查询串。 */
const AUTHORITY = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

const normalizeAuthority = (raw: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error('authority 不是合法的百分号编码');
  }
  return decoded.toLowerCase();
};

const hostOf = (authority: string): string => {
  const colon = authority.lastIndexOf(':');
  return colon > 0 ? authority.slice(0, colon) : authority;
};

/**
 * 由 DID 推出文档地址。解析不出来就抛错——调用方据此拒绝登录/绑定，
 * 而不是退回到"请求体里那份文档"。
 */
export function didDocumentUrl(did: string, options: { allowInsecureHttp?: boolean } = {}): URL {
  const segments = did.split(':');
  if (segments.length < 4 || segments[0] !== 'did') {
    throw new DidResolutionError('invalid_did', did, '不是合法的 DID');
  }
  if (segments[1] !== 'wba') {
    throw new DidResolutionError('unsupported_method', did, `暂不支持 did:${segments[1]}，只接受 did:wba`);
  }
  let authority: string;
  try {
    authority = normalizeAuthority(segments[2] ?? '');
  } catch {
    throw new DidResolutionError('invalid_did', did, 'DID 的域段不是合法的百分号编码');
  }
  if (!AUTHORITY.test(authority)) {
    throw new DidResolutionError('invalid_did', did, 'DID 的域段必须是 host 或 host:port');
  }

  const path: string[] = [];
  for (const raw of segments.slice(3)) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      throw new DidResolutionError('invalid_did', did, 'DID 路径段不是合法的百分号编码');
    }
    // 段内出现分隔符或 .. 会让"解析"变成"漫游"，直接拒绝。
    if (!segment || segment === '.' || segment === '..' || /[/\\?#\u0000-\u001f]/.test(segment)) {
      throw new DidResolutionError('invalid_did', did, 'DID 路径段不合法');
    }
    path.push(encodeURIComponent(segment));
  }
  if (path.length === 0) throw new DidResolutionError('invalid_did', did, 'did:wba 缺少主体路径');

  const loopback = LOOPBACK.test(hostOf(authority));
  const scheme = loopback || options.allowInsecureHttp ? 'http' : 'https';
  const url = new URL(`${scheme}://${authority}/${path.join('/')}/did.json`);
  if (!loopback && url.protocol !== 'https:' && !options.allowInsecureHttp) {
    throw new DidResolutionError('insecure_transport', did, '内网 http 解析未开启，无法取回 DID 文档', url.toString());
  }
  return url;
}

const sameDid = (left: string, right: string): boolean => {
  const normalize = (value: string): string => value.replace(/%3a/gi, ':').toLowerCase();
  return normalize(left) === normalize(right);
};

export function createHttpDidResolver(options: DidResolverOptions = {}): DidResolver {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now;
  const allowInsecureHttp = options.allowInsecureHttp ?? false;
  const cache = new Map<string, { document: Record<string, unknown>; url: string; expiresAt: number }>();

  return {
    invalidate(did: string): void {
      cache.delete(did);
    },

    async resolve(did: string): Promise<DidDocumentResult> {
      const hit = cache.get(did);
      if (hit && hit.expiresAt > now()) {
        return { document: hit.document, url: hit.url, cached: true };
      }
      if (hit) cache.delete(did);

      const url = didDocumentUrl(did, { allowInsecureHttp });
      const target = url.toString();
      let response: Response;
      try {
        response = await fetchImpl(target, {
          method: 'GET',
          headers: { accept: 'application/did+json, application/json' },
          // 不跟重定向：跟随就可能被引到内网元数据端点。
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name === 'TimeoutError' ? '请求超时' : error.message : String(error);
        throw new DidResolutionError('unreachable', did, `取 DID 文档失败：${reason}`, target);
      }

      if (response.status >= 300 && response.status < 400) {
        throw new DidResolutionError('redirected', did, 'DID 文档地址返回了重定向，拒绝跟随', target);
      }
      if (response.status === 404 || response.status === 410) {
        throw new DidResolutionError('not_found', did, '该 DID 未在注册服务器登记（did.json 不存在）', target);
      }
      if (!response.ok) {
        throw new DidResolutionError(
          'unreachable',
          did,
          `注册服务器返回 HTTP ${response.status}，无法确认 DID 归属`,
          target,
        );
      }

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new DidResolutionError('too_large', did, 'DID 文档超过大小上限', target);
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new DidResolutionError('unreachable', did, '读取 DID 文档失败', target);
      }
      if (Buffer.byteLength(text) > maxBytes) {
        throw new DidResolutionError('too_large', did, 'DID 文档超过大小上限', target);
      }

      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        throw new DidResolutionError('bad_document', did, 'DID 文档不是合法 JSON', target);
      }
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new DidResolutionError('bad_document', did, 'DID 文档不是对象', target);
      }
      const id = (document as { id?: unknown }).id;
      if (typeof id !== 'string' || !sameDid(id, did)) {
        throw new DidResolutionError('bad_document', did, 'DID 文档的 id 与请求的 DID 不一致', target);
      }

      cache.set(did, { document: document as Record<string, unknown>, url: target, expiresAt: now() + cacheTtlMs });
      if (cache.size > 256) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return { document: document as Record<string, unknown>, url: target, cached: false };
    },
  };
}

/** 把解析失败翻译成一句面向用户的话；调用方负责包成协议错误。 */
export function describeResolutionFailure(error: unknown): string {
  if (error instanceof DidResolutionError) {
    switch (error.code) {
      case 'not_found':
        return '这条 DID 没有在注册服务器上登记';
      case 'unsupported_method':
        return error.message;
      case 'invalid_did':
        return `DID 格式不合法：${error.message}`;
      case 'insecure_transport':
        return '注册服务器要求 https，本部署未开启内网 http 解析';
      case 'redirected':
        return 'DID 文档地址发生了重定向，已拒绝（可能是配置错误）';
      case 'too_large':
        return 'DID 文档超过大小上限，拒绝加载';
      case 'bad_document':
        return `DID 文档不可信：${error.message}`;
      default:
        return `无法连接 DID 注册服务器：${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
