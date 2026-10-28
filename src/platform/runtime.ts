/**
 * 进程入口的公共判断。
 *
 * Node 22 没有 import.meta.main，用 argv[1] 与模块路径比较来判断
 * "这个文件是被当作脚本直接运行，还是被其他模块 import"。
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = realpathSync(fileURLToPath(moduleUrl));
  try {
    return realpathSync(entry) === modulePath;
  } catch {
    return false;
  }
}
