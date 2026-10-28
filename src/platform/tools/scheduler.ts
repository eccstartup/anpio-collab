/**
 * 超时调度器 + 监管扫描。
 *
 * 平台不内置定时任务：超时检查与告警扫描都是显式的管理操作，
 * 由运维进程按固定间隔调用，便于审计与观察。
 *
 * 顺序是有意义的：先让过期的子任务变成超时，再扫描告警，
 * 这样同一轮里产生的异常当轮就能被看见，而不是等到下一轮。
 *
 * 用法：
 *   COLLAB_URL=... COLLAB_TOKEN=... node src/platform/tools/scheduler.ts --once
 *   COLLAB_URL=... COLLAB_TOKEN=... node src/platform/tools/scheduler.ts
 */

import { CollabClient } from '../../sdk/client.ts';
import { isMain } from '../runtime.ts';

export async function runScheduler(options: {
  url: string;
  token: string;
  intervalMs: number;
  once: boolean;
  /** 监管扫描需要 admin 或 supervisor；显式关掉可以只跑超时检查。 */
  scan?: boolean;
}): Promise<void> {
  const client = new CollabClient(options.url, options.token);
  const scan = options.scan ?? true;
  let stopped = false;
  let wake: (() => void) | undefined;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopped = true;
      wake?.();
    });
  }

  do {
    const at = new Date().toISOString();
    try {
      const expired = await client.expire();
      let alerts: { opened: number; updated: number; resolved: number; total: number } | null = null;
      if (scan) alerts = await client.scanAlerts();
      console.log(JSON.stringify({ at, ...expired, ...(alerts ? { alerts } : {}) }));
    } catch (error) {
      console.error(`调度轮次失败: ${error instanceof Error ? error.message : String(error)}`);
      if (options.once) process.exitCode = 1;
    }
    if (options.once || stopped) break;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, options.intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  } while (!stopped);
}

if (isMain(import.meta.url)) {
  const url = process.env.COLLAB_URL;
  const token = process.env.COLLAB_TOKEN;
  if (!url || !token) {
    console.error('需要 COLLAB_URL 与具有 admin 角色的 COLLAB_TOKEN');
    process.exit(1);
  }
  const intervalMs = Number(process.env.COLLAB_SCHEDULER_INTERVAL_MS ?? 30_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
    console.error('COLLAB_SCHEDULER_INTERVAL_MS 至少 1000');
    process.exit(1);
  }
  runScheduler({
    url,
    token,
    intervalMs,
    once: process.argv.includes('--once'),
    // 只想跑超时检查时可以 --no-scan；默认连告警一起算。
    scan: !process.argv.includes('--no-scan'),
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
