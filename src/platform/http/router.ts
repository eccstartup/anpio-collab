/**
 * 路由声明。
 *
 * 每个接口是一行数据：方法、路径、说明、读处理或写处理。
 * 路径里的 `:name` 在启动时编译成正则，命中后作为参数交给处理函数。
 * 不再用一长串 if/else 拼接 URL，也不会出现"某个分支忘了解析 body"。
 */

import type { App } from '../app.ts';
import type { Principal } from '../../protocol/types.ts';

export type RequestContext = {
  app: App;
  principal: Principal;
  params: Record<string, string>;
  query: URLSearchParams;
  path: string;
};

export type ReadContext = RequestContext;
export type WriteContext = RequestContext & { body: unknown };

/** 授权阶段可以顺带返回资源及其版本，用于 If-Match 前置条件。 */
export type Authorized = { version?: number } | undefined;

export type WriteSpec = {
  /**
   * 每次请求都会执行，包括幂等重放。重放只跳过写操作，
   * 不跳过授权核对与版本比较，避免权限被撤销后仍能读到旧结果。
   */
  authorize?: (ctx: WriteContext) => Promise<Authorized>;
  execute: (ctx: WriteContext, authorized: Authorized) => Promise<unknown>;
};

export type Route = {
  method: 'GET' | 'POST';
  path: string;
  description: string;
  /** 无需令牌的公开接口，例如健康检查。 */
  public?: boolean;
  read?: (ctx: ReadContext) => Promise<unknown>;
  write?: WriteSpec;
};

export type RouteMatch = { route: Route; params: Record<string, string> };

type CompiledRoute = RouteMatch & { regex: RegExp; names: string[] };

const escapeSegment = (segment: string): string => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Router {
  private readonly compiled: CompiledRoute[];

  constructor(routes: Route[]) {
    const seen = new Set<string>();
    this.compiled = routes.map(route => {
      const names: string[] = [];
      const pattern = route.path
        .split('/')
        .map(segment => {
          if (segment.startsWith(':')) {
            names.push(segment.slice(1));
            return '([^/]+)';
          }
          return escapeSegment(segment);
        })
        .join('/');
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) throw new Error(`重复的路由定义: ${key}`);
      seen.add(key);
      if (route.method === 'POST' && !route.write) throw new Error(`POST 路由缺少写处理: ${key}`);
      if (route.method === 'GET' && !route.read) throw new Error(`GET 路由缺少读处理: ${key}`);
      return { route, params: {}, regex: new RegExp(`^${pattern}$`), names };
    });
  }

  match(method: string, pathname: string): RouteMatch | null {
    for (const item of this.compiled) {
      if (item.route.method !== method.toUpperCase()) continue;
      const matched = item.regex.exec(pathname);
      if (!matched) continue;
      const params: Record<string, string> = {};
      item.names.forEach((name, index) => {
        params[name] = decodeURIComponent(matched[index + 1] ?? '');
      });
      return { route: item.route, params };
    }
    return null;
  }

  /** 供 `/v1/meta` 与文档自检使用。 */
  describe(): { method: string; path: string; description: string }[] {
    return this.compiled.map(item => ({
      method: item.route.method,
      path: item.route.path,
      description: item.route.description,
    }));
  }
}
