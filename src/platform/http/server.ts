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
import { fileURLToPath } from 'node:url';
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

/** 文件下载：写完头部后错误只能切断连接，不能再改状态码。 */
function sendStream(
  res: http.ServerResponse,
  status: number,
  headers: Record<string, string>,
  stream: NodeJS.ReadableStream,
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'private, max-age=0', ...headers });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 上传地址不需要 Bearer：URL 里的随机令牌就是这一次上传的凭证。
 * 必须在通用 JSON 解析之前处理，否则大文件会先被读进内存并触发体积上限。
 */
async function handleRawUpload(
  app: App,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = /^\/v1\/space\/uploads\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!match) return false;
  if (req.method !== 'PUT') {
    sendError(res, new AppError('invalid', '上传地址只接受 PUT'));
    return true;
  }
  const rawLength = req.headers['content-length'];
  let declared: number | null = null;
  if (typeof rawLength === 'string') {
    declared = Number(rawLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      sendError(res, invalid('Content-Length 不合法'));
      return true;
    }
  }
  try {
    const result = await app.collab.receiveUpload(match[1], req, declared);
    sendJson(res, 200, result);
  } catch (error) {
    sendError(res, toAppError(error));
  }
  return true;
}

async function handleFileContent(
  app: App,
  principal: Principal,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const workspaceMatch = /^\/v1\/space\/files\/([^/]+)\/content$/.exec(url.pathname);
  const taskMatch = /^\/v1\/tasks\/([^/]+)\/files\/([^/]+)\/content$/.exec(url.pathname);
  if (!workspaceMatch && !taskMatch) return false;
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  try {
    const opened = taskMatch
      ? await app.collab.openTaskContent(
          principal,
          decodeURIComponent(taskMatch[1]),
          decodeURIComponent(taskMatch[2]),
          rangeHeader,
        )
      : await app.collab.openContent(principal, decodeURIComponent(workspaceMatch![1]), rangeHeader);
    const length = opened.range
      ? opened.range.end - opened.range.start + 1
      : opened.size;
    sendStream(
      res,
      opened.range ? 206 : 200,
      {
        'Content-Type': opened.file.mime,
        'Content-Length': String(length),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': contentDisposition(opened.file.name),
        ...(opened.range
          ? { 'Content-Range': `bytes ${opened.range.start}-${opened.range.end}/${opened.size}` }
          : {}),
      },
      opened.stream,
    );
  } catch (error) {
    sendError(res, toAppError(error));
  }
  return true;
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
 * 智能体的 skill 就是一个文件：仓库里的 skills/anpio-collab/SKILL.md。
 * 响应时把 {{BASE_URL}} 换成调用方访问的地址，下载下来就是能直接发的版本。
 */
const SKILL_TEMPLATE_PATH = fileURLToPath(
  new URL('../../../skills/anpio-collab/SKILL.md', import.meta.url),
);

async function renderAgentSkill(base: string): Promise<string> {
  const template = await readFile(SKILL_TEMPLATE_PATH, 'utf8');
  return template.split('{{BASE_URL}}').join(base);
}

function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

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

  // ------------------------------------------------------------ 智能体 skill
  // 一个 md 文件：浏览器直接打开就是正文，发给智能体也能按地址读。
  if ((path === '/auth/agent/skill' || path === '/auth/agent/skill.md') && req.method === 'GET') {
    const base = (absoluteUrl(req, '') ?? '').replace(/\/+$/, '');
    sendText(res, 200, await renderAgentSkill(base), 'text/markdown; charset=utf-8');
    return true;
  }

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
      if (result.status === 'bound') {
        // 补绑邮箱：链接只用来确认地址归属，不签发、也不替换当前会话。
        sendJson(res, 200, { ok: true, bound: true, email: result.email });
        return true;
      }
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

/** 拒绝日志里的 DID：只用来定位是谁在登录，解析不出来就留空。 */
function didOf(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { did?: unknown };
    return typeof parsed.did === 'string' ? parsed.did : '';
  } catch {
    return '';
  }
}

function publicPrincipal(principal: Principal) {
  return {
    id: principal.id,
    displayName: principal.displayName,
    kind: principal.kind,
    roles: principal.roles,
    tenantRole: principal.tenantRole,
    workspace: principal.workspace,
    accountId: principal.accountId,
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
      if (appError.code === 'internal') {
        console.error('ANP 登录失败', appError.cause ?? appError);
      } else {
        // 失败最常来自"这条 DID 没登记/文档对不上"，带上 DID 才定位得到是谁在登录。
        console.warn('[anp.login.rejected]', appError.code, appError.message, didOf(rawBody));
      }
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

/**
 * 信箱推送。
 *
 * 不用进程内广播：每秒按会话查一次数据库，多实例与 PostgreSQL 下语义一致。
 * 断开后客户端带 `Last-Event-ID` 重连，只补发缺失的投递。
 */
async function handleMailStream(
  app: App,
  principal: Principal,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const match = /^\/v1\/mail\/sessions\/([^/]+)\/events$/.exec(url.pathname);
  if (!match) return false;
  const sessionId = decodeURIComponent(match[1] ?? '');

  let session;
  try {
    session = await app.mailbox.getSession(principal, sessionId);
  } catch (error) {
    sendError(res, toAppError(error));
    return true;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const headerId = req.headers['last-event-id'];
  const requested = Array.isArray(headerId) ? headerId[0] : headerId;
  let last = Math.max(
    0,
    Number(requested ?? url.searchParams.get('since') ?? session.cursorSeq) || 0,
  );
  let closed = false;
  let polling = false;

  const finish = (reason: 'closed' | 'shutdown' | null) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(ping);
    unregister();
    try {
      if (reason === 'closed') res.write('event: closed\ndata: {}\n\n');
      res.end();
    } catch {
      // 连接已经断开，不需要再做什么。
    }
  };
  const unregister = app.mailbox.addStream(sessionId, finish);

  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const current = await app.mailbox.getSession(principal, sessionId);
      if (current.status === 'closed') {
        finish('closed');
        return;
      }
      const result = await app.mailbox.pull(principal, sessionId, {
        limit: 50,
        leaseSeconds: 0,
        includeDigest: true,
        since: last,
      });
      for (const item of result.items) {
        if (item.seq <= last) continue;
        last = item.seq;
        res.write(`id: ${item.seq}\nevent: mail\ndata: ${JSON.stringify(item)}\n\n`);
      }
    } catch {
      // 会话被关闭或撤权：结束流，让客户端重新建会话。
      finish(null);
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => void poll(), 1000);
  const ping = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);
  req.on('close', () => finish(null));
  void poll();
  return true;
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

      if (await handleRawUpload(app, req, res, url)) return;
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
      if (await handleMailStream(app, principal, req, res, url)) return;
      if (await handleFileContent(app, principal, req, res, url)) return;
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (!match) throw notFound('接口不存在');

      // 原始字节与请求头要原样交给路由：ANP 验签要重建签名基，
      // 先 JSON.parse 再 JSON.stringify 已经不是同一份字节了。
      const rawBody = req.method === 'POST' ? await readRawBody(req, bodyLimit) : '';
      let body: unknown;
      if (req.method === 'POST') {
        if (!rawBody) body = {};
        else {
          try {
            body = JSON.parse(rawBody);
          } catch {
            throw invalid('请求体不是合法 JSON');
          }
        }
      }
      const context = {
        app,
        principal,
        token,
        params: match.params,
        query: url.searchParams,
        path: url.pathname,
        body,
        headers: headerMap(req),
        rawBody,
        origin: absoluteUrl(req, '') ?? '',
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
