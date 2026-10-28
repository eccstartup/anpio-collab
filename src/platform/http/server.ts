/**
 * HTTP 服务。
 *
 * 只做四件事：静态资源、健康检查、解析请求、把请求交给执行器。
 * 业务规则不在这里；这里唯一的"业务"是认证与错误响应格式。
 *
 * ANP 登录是例外：它必须在认证之前处理，且必须拿到**原始请求体**——
 * content-digest 覆盖的是字节，先 JSON.parse 再序列化就不再是同一份字节。
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { AppError, invalid, notFound, unauthenticated } from '../../protocol/errors.ts';
import { asObject } from '../../protocol/parse.ts';
import type { Principal } from '../../protocol/types.ts';
import type { App } from '../app.ts';
import { ChallengeRequiredError, EnrollmentPendingError } from '../services/identity.ts';
import { toAppError } from './errors.ts';
import { executeRead, executeWrite } from './executor.ts';
import { Router } from './router.ts';
import { routes } from './routes.ts';

export type ServerOptions = {
  app: App;
  webRoot: string;
  bodyLimit: number;
  logRequests?: boolean;
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, error: AppError, extraHeaders: Record<string, string> = {}): void {
  sendJson(res, error.status, { error: { code: error.code, message: error.message } }, extraHeaders);
}

async function readRawBody(req: http.IncomingMessage, limit: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limit) throw new AppError('payload_too_large', `请求体超过 ${limit} 字节`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const text = await readRawBody(req, limit);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('请求体不是合法 JSON');
  }
}

async function serveStatic(
  res: http.ServerResponse,
  webRoot: string,
  pathname: string,
): Promise<boolean> {
  // 登录前可见的说明页：给一个干净地址，而不是 /login-help.html。
  // /login 是邮件链接的落点，必须回落到同一个单页应用，否则点链接会拿到 401 JSON。
  const aliases: Record<string, string> = {
    '/help/login': 'login-help.html',
    '/login': 'index.html',
    '/agents/approve': 'index.html',
  };
  const relative = aliases[pathname] ?? (pathname === '/' ? 'index.html' : pathname.slice(1));
  // 只允许根目录下的单层文件，避免路径穿越。
  if (!/^[A-Za-z0-9._-]+$/.test(relative)) return false;
  const target = resolve(join(normalize(webRoot), relative));
  if (!target.startsWith(resolve(webRoot))) return false;
  try {
    const content = await readFile(target);
    const type = CONTENT_TYPES[extname(target)] ?? 'application/octet-stream';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': content.byteLength,
      ...(type.startsWith('text/html') ? { 'Content-Security-Policy': HTML_CSP } : {}),
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function parseIdempotencyKey(req: http.IncomingMessage): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > 200) {
    throw invalid('写请求必须携带 1-200 字符的 Idempotency-Key');
  }
  return key;
}

function parseIfMatch(req: http.IncomingMessage): number | undefined {
  const header = req.headers['if-match'];
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !/^"[1-9]\d*"$/.test(header)) {
    throw invalid('If-Match 格式应为 "版本号"，例如 "3"');
  }
  return Number(header.slice(1, -1));
}

/** 请求头的原样副本：键统一小写，值按原字节拼接。 */
function headerMap(req: http.IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

/**
 * 从请求重建**外部可见**的绝对 URL。
 *
 * 签名覆盖 `@target-uri` / `@authority`，所以这里必须用客户端实际使用的
 * Host 与协议，而不是监听地址：统一换成 127.0.0.1 会让 localhost 登录全部验签失败。
 */
function absoluteUrl(req: http.IncomingMessage, pathname: string): string | null {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return null;
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = typeof forwarded === 'string' && forwarded.startsWith('https') ? 'https' : 'http';
  return `${proto}://${host}${pathname}`;
}

/** 简单的进程内限流：只保护登录端点，不追求分布式精确。 */
class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  hit(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    if (this.hits.size > 5000) this.prune(now);
    return entry.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

type AnpContext = {
  app: App;
  bodyLimit: number;
  loginLimiter: RateLimiter;
  emailLimiter: RateLimiter;
};

/**
 * `/auth/*`：所有"登录之前"的端点。
 *
 * 这些端点不需要令牌，因此在这里统一做限流与错误映射。
 * 返回 `true` 表示已经处理完这个请求。
 */
async function handlePublicAuth(
  context: AnpContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const { app } = context;
  const path = url.pathname;

  // ------------------------------------------------------------ 邮箱链接
  if (path === '/auth/email/start' && req.method === 'POST') {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!context.emailLimiter.hit(peer)) {
      sendError(res, new AppError('invalid', '发送过于频繁，请 10 分钟后再试'), { 'Retry-After': '600' });
      return true;
    }
    const body = asObject(await readBody(req, context.bodyLimit)) as Record<string, unknown>;
    const origin = absoluteUrl(req, '/')?.replace(/\/$/, '');
    try {
      const result = await app.emailAuth.start({
        email: body.email,
        invite: body.invite,
        origin: origin ?? undefined,
        userAgent: String(req.headers['user-agent'] ?? ''),
      });
      sendJson(res, 202, result);
    } catch (error) {
      sendError(res, toAppError(error));
    }
    return true;
  }

  if (path === '/auth/email/verify' && req.method === 'POST') {
    const body = asObject(await readBody(req, context.bodyLimit)) as Record<string, unknown>;
    try {
      const result = await app.emailAuth.verify({ ticket: body.ticket });
      if (result.status === 'select') {
        sendJson(res, 409, {
          error: { code: 'tenant_selection_required', message: '该邮箱属于多个组织，请选择要进入的组织' },
          selectionToken: result.selectionToken,
          tenants: result.tenants,
        });
        return true;
      }
      await app.audit.record(result.principal, 'POST /auth/email/verify', 'success');
      sendJson(
        res,
        200,
        {
          token: result.token,
          tokenType: 'Bearer',
          expiresAt: result.expiresAt,
          tenant: result.tenant,
          joinedTenant: result.joinedTenant ?? false,
          principal: publicPrincipal(result.principal),
        },
        { 'Authentication-Info': `access_token="${result.token}", token_type="Bearer"` },
      );
    } catch (error) {
      sendError(res, toAppError(error));
    }
    return true;
  }

  if (path === '/auth/email/choose' && req.method === 'POST') {
    const body = asObject(await readBody(req, context.bodyLimit)) as Record<string, unknown>;
    try {
      const result = await app.emailAuth.choose({
        selectionToken: body.selectionToken,
        tenantId: body.tenantId,
      });
      if (result.status !== 'ok') throw new AppError('internal', '选择组织失败');
      await app.audit.record(result.principal, 'POST /auth/email/choose', 'success');
      sendJson(res, 200, {
        token: result.token,
        tokenType: 'Bearer',
        expiresAt: result.expiresAt,
        tenant: result.tenant,
        principal: publicPrincipal(result.principal),
      });
    } catch (error) {
      sendError(res, toAppError(error));
    }
    return true;
  }

  // ------------------------------------------------------------ Agent 设备流
  if (path === '/auth/agent/request' && req.method === 'POST') {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!context.loginLimiter.hit(peer)) {
      sendError(res, new AppError('invalid', '请求过于频繁，请稍后再试'), { 'Retry-After': '60' });
      return true;
    }
    try {
      const body = await readBody(req, context.bodyLimit);
      const result = await app.agentAuth.request(body);
      sendJson(res, 201, result);
    } catch (error) {
      sendError(res, toAppError(error));
    }
    return true;
  }

  if (path === '/auth/agent/token' && req.method === 'POST') {
    try {
      const body = await readBody(req, context.bodyLimit);
      const result = await app.agentAuth.poll(body);
      if (result.status === 'pending') {
        sendJson(res, 202, result);
        return true;
      }
      sendJson(res, 200, result, {
        'Authentication-Info': `access_token="${result.token}", token_type="Bearer"`,
      });
    } catch (error) {
      sendError(res, toAppError(error));
    }
    return true;
  }

  // ------------------------------------------------------------ 开发用邮件箱
  if (path === '/auth/dev/mails' && req.method === 'GET') {
    if (!app.mail.exposeOutbox) {
      sendError(res, notFound('接口不存在'));
      return true;
    }
    const email = (url.searchParams.get('email') ?? '').trim();
    if (!email) {
      sendError(res, invalid('缺少 email 参数'));
      return true;
    }
    sendJson(res, 200, { items: await app.mail.recent(email) });
    return true;
  }

  return false;
}

function publicPrincipal(principal: Principal) {
  return {
    id: principal.id,
    displayName: principal.displayName,
    kind: principal.kind,
    roles: principal.roles,
    tenantRole: principal.tenantRole,
    workspace: principal.workspace,
  };
}

/**
 * `/auth/anp/*`：挑战与登录。
 *
 * 两个端点都不需要令牌；其余所有 `/v1/*` 仍然走 Bearer。
 * 返回 `true` 表示已经处理完这个请求。
 */
async function handleAnpAuth(
  context: AnpContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const { app } = context;
  const path = url.pathname;

  if (path === '/auth/anp/challenge' && req.method === 'GET') {
    const issued = await app.identity.issueNonce();
    sendJson(res, 200, { nonce: issued.nonce, expiresAt: issued.expiresAt, audience: absoluteUrl(req, path) });
    return true;
  }

  if (path === '/auth/anp/login' && req.method === 'POST') {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!context.loginLimiter.hit(peer)) {
      sendError(res, new AppError('invalid', '登录请求过于频繁，请稍后再试'), { 'Retry-After': '60' });
      return true;
    }
    const target = absoluteUrl(req, path);
    if (!target) {
      sendError(res, invalid('缺少 Host 头，无法确定签名目标'));
      return true;
    }
    const rawBody = await readRawBody(req, context.bodyLimit);
    try {
      const result = await app.identity.login({
        method: 'POST',
        url: target,
        headers: headerMap(req),
        rawBody,
      });
      await app.audit.record(result.principal, 'POST /auth/anp/login', 'success');
      sendJson(
        res,
        200,
        {
          ok: true,
          token: result.token,
          tokenType: result.tokenType,
          did: result.did,
          subject: result.subject,
          keyid: result.keyid,
          enrollment: result.enrollment,
          sessionExpiresAt: result.sessionExpiresAt,
          principal: publicPrincipal(result.principal),
        },
        { 'Authentication-Info': `access_token="${result.token}", token_type="Bearer"` },
      );
    } catch (error) {
      if (error instanceof ChallengeRequiredError) {
        sendJson(
          res,
          401,
          { error: { code: 'challenge_required', message: error.message }, nonce: error.nonce },
          { 'WWW-Authenticate': `ANP nonce="${error.nonce}"` },
        );
        return true;
      }
      if (error instanceof EnrollmentPendingError) {
        sendJson(res, 403, {
          error: {
            code: 'enrollment_pending',
            message: error.message,
          },
          principalId: error.principalId,
        });
        return true;
      }
      const appError = toAppError(error);
      if (appError.code === 'internal') console.error('ANP 登录失败', appError.cause ?? appError);
      sendError(res, appError);
    }
    return true;
  }

  if (path.startsWith('/auth/anp/')) {
    sendError(res, notFound('接口不存在'));
    return true;
  }
  return false;
}

export function createServer(options: ServerOptions): http.Server {
  const { app, webRoot, bodyLimit, logRequests = false } = options;
  const router = new Router(routes);
  const anp: AnpContext = {
    app,
    bodyLimit,
    loginLimiter: new RateLimiter(30, 60_000),
    emailLimiter: new RateLimiter(5, 600_000),
  };

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (logRequests) {
      res.on('finish', () => {
        console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
      });
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, protocol: 'v1', anp: true });
        return;
      }

      if (req.method === 'GET' && (await serveStatic(res, webRoot, url.pathname))) return;

      if (await handlePublicAuth(anp, req, res, url)) return;
      if (await handleAnpAuth(anp, req, res, url)) return;
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code === 'internal') console.error(appError.cause ?? appError);
      sendError(res, appError);
      return;
    }

    let principal: Principal | undefined;
    try {
      const header = req.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 1024) {
        throw unauthenticated('需要 Bearer 访问令牌');
      }
      const token = header.slice(7).trim();
      principal = await app.principals.authenticate(token);
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (!match) throw notFound('接口不存在');

      const body = req.method === 'POST' ? await readBody(req, bodyLimit) : undefined;
      const context = {
        app,
        principal,
        token,
        params: match.params,
        query: url.searchParams,
        path: url.pathname,
        body,
      };

      let result: unknown;
      if (req.method === 'GET') {
        result = await executeRead(app, match, context);
      } else {
        result = await executeWrite(app, match, context, {
          operationKey: parseIdempotencyKey(req),
          expectedVersion: parseIfMatch(req),
        });
      }
      sendJson(res, 200, result);
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code === 'internal') console.error(appError.cause ?? appError);
      if (principal) {
        try {
          await app.audit.record(principal, `${req.method ?? 'GET'} ${url.pathname}`, `denied:${appError.status}`);
        } catch (auditError) {
          console.error('审计写入失败', auditError);
        }
      }
      sendError(res, appError);
    }
  });
}

/** 供需要自建的场景复用同一套路由（测试、嵌入式部署）。 */
export const routeTable = routes;
