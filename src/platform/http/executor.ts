/**
 * 写操作执行器。
 *
 * 把三件跨接口都要做的事收敛到一处：
 *  1. 幂等：同一主体 + 同一 Idempotency-Key + 同一请求返回同一结果；
 *  2. 版本前置条件：If-Match 与资源当前版本比较；
 *  3. 审计：成功与重放在同一事务内记录，拒绝由 HTTP 层单独记录。
 *
 * 注意：重放会重新执行授权核对，但不会重新执行业务写操作。
 */

import { createHash } from 'node:crypto';
import { conflict, invalid, preconditionFailed, unauthenticated } from '../../protocol/errors.ts';
import type { App } from '../app.ts';
import type { RouteMatch, WriteContext } from './router.ts';

export type WriteOptions = {
  operationKey: string;
  expectedVersion?: number;
};

const fingerprintOf = (match: RouteMatch, ctx: WriteContext, expectedVersion?: number): string =>
  createHash('sha256')
    .update(JSON.stringify([match.route.method, ctx.path, ctx.body ?? null, expectedVersion ?? null]))
    .digest('hex');

export async function executeWrite(
  app: App,
  match: RouteMatch,
  ctx: WriteContext,
  options: WriteOptions,
): Promise<unknown> {
  const spec = match.route.write;
  if (!spec) throw invalid('该路径不支持写操作');
  const fingerprint = fingerprintOf(match, ctx, options.expectedVersion);

  return app.ctx.db.transaction(async tx => {
    // 1. 主体在本次请求期间必须仍然有效，且角色没有被改动。
    const current = await tx.one<{ roles: string; active: unknown }>(
      'SELECT roles, active FROM principals WHERE id = :id AND workspace = :workspace',
      { id: ctx.principal.id, workspace: ctx.principal.workspace },
    );
    if (!current || Number(current.active) !== 1) throw unauthenticated('主体已停用');
    if (String(current.roles) !== JSON.stringify(ctx.principal.roles)) {
      throw unauthenticated('权限已变更，请重新认证');
    }

    // 2. 幂等重放：返回上次结果，但仍核对当前授权。
    const previous = await tx.one<{ fingerprint: string; response: string }>(
      'SELECT fingerprint, response FROM operations WHERE principal_id = :principal AND op_key = :key',
      { principal: ctx.principal.id, key: options.operationKey },
    );
    if (previous) {
      if (String(previous.fingerprint) !== fingerprint) {
        throw conflict('同一 Idempotency-Key 被用于不同请求');
      }
      await spec.authorize?.(ctx);
      await app.audit.recordIn(tx, ctx.principal, ctx.path, 'replay');
      return JSON.parse(String(previous.response));
    }

    // 3. 资源级授权与版本前置条件。
    const authorized = await spec.authorize?.(ctx);
    if (options.expectedVersion !== undefined) {
      const version = authorized?.version;
      if (typeof version !== 'number') {
        throw invalid('If-Match 仅适用于带版本的任务或子任务操作');
      }
      if (version !== options.expectedVersion) {
        throw preconditionFailed('资源版本已变化，请重新读取后再操作');
      }
    }

    // 4. 执行并记录。
    const response = await spec.execute(ctx, authorized);
    await tx.run(
      `INSERT INTO operations(principal_id, op_key, fingerprint, response, created_at)
       VALUES(:principal, :key, :fingerprint, :response, :at)`,
      {
        principal: ctx.principal.id,
        key: options.operationKey,
        fingerprint,
        response: JSON.stringify(response ?? null),
        at: app.ctx.now(),
      },
    );
    await app.audit.recordIn(tx, ctx.principal, ctx.path, 'success');
    return response;
  });
}

export async function executeRead(app: App, match: RouteMatch, ctx: WriteContext): Promise<unknown> {
  const handler = match.route.read;
  if (!handler) throw invalid('该路径不支持读操作');
  const result = await handler(ctx);
  await app.audit.record(ctx.principal, ctx.path, 'success');
  return result;
}
