/**
 * 事务传播。
 *
 * 需求有两头：HTTP 执行器要为"幂等记录 + 业务写入 + 审计"提供一个事务；
 * 领域服务自己也需要保证原子性，会调用 db.transaction。
 * 如果两个事务各自去争同一把写锁，就会自锁。
 *
 * 这里用 AsyncLocalStorage 实现"加入外层事务"的语义：
 * 已经在事务里时，内层 db.transaction 直接复用外层连接，不再 BEGIN。
 * 只有最外层负责提交或回滚。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Queryable } from './driver.ts';

const storage = new AsyncLocalStorage<Queryable>();

export function activeTransaction(): Queryable | undefined {
  return storage.getStore();
}

export function runInTransaction<T>(tx: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return storage.run(tx, () => fn(tx));
}
