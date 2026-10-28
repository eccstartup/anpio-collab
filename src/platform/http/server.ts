/**
 * HTTP 服务。
 *
 * 只做四件事：静态资源、健康检查、解析请求、把请求交给执行器。
 * 业务规则不在这里；这里唯一的"业务"是认证与错误响应格式。
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { AppError, invalid, notFound, unauthenticated } from '../../protocol/errors.ts';
import type { Principal } from '../../protocol/types.ts';
import type { App } from '../app.ts';
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

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, error: AppError): void {
  sendJson(res, error.status, { error: { code: error.code, message: error.message } });
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limit) throw new AppError('payload_too_large', `请求体超过 ${limit} 字节`);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
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
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
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

async function authenticate(app: App, req: http.IncomingMessage): Promise<Principal> {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 1024) {
    throw unauthenticated('需要 Bearer 访问令牌');
  }
  return app.principals.authenticate(header.slice(7).trim());
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

export function createServer(options: ServerOptions): http.Server {
  const { app, webRoot, bodyLimit, logRequests = false } = options;
  const router = new Router(routes);

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (logRequests) {
      res.on('finish', () => {
        console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, protocol: 'v1' });
      return;
    }

    if (req.method === 'GET' && (await serveStatic(res, webRoot, url.pathname))) return;

    let principal: Principal | undefined;
    try {
      principal = await authenticate(app, req);
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (!match) throw notFound('接口不存在');

      const body = req.method === 'POST' ? await readBody(req, bodyLimit) : undefined;
      const context = {
        app,
        principal,
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
          await app.audit.record(principal, url.pathname, `denied:${appError.status}`);
        } catch (auditError) {
          console.error('审计写入失败', auditError);
        }
      }
      sendError(res, appError);
    }
  });
}
