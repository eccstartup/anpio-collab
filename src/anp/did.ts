/**
 * did:wba 的展示与业务 helper。
 *
 * 文档解析、proof 校验与密钥提取已经收敛到 `@anpio-cli/core`：这里只留下
 * "这个字符串是不是 DID""它该显示成什么短名""句柄怎么读出来"这类不参与
 * 授权的逻辑，以及给业务存储用的密钥指纹。
 */

import { createHash } from 'node:crypto';
import { didFingerprint } from '@anpio-cli/core';

export const isDid = (value: unknown): value is string =>
  typeof value === 'string' && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value) && value.length <= 300;

/** RFC 7638 指纹，带 `e1_` 前缀——与 DID 里的最后一段逐字一致。 */
export function fingerprintOfRawKey(raw: Uint8Array): string {
  return didFingerprint('ed25519', raw);
}

// ---------------------------------------------------------------------------
// 展示用派生信息（不参与授权）
// ---------------------------------------------------------------------------

const E1_PREFIX = 'e1_';

/** DID 里可读的短名：优先取 `e1_` 指纹前的那一段，其次取最后一段。 */
export function didShortId(did: string): string {
  const segments = did.split(':').slice(3);
  const readable = segments.filter(segment => !segment.startsWith(E1_PREFIX) && segment !== 'user');
  const candidate = readable.at(-1) ?? segments.at(-1) ?? 'did';
  const clean = candidate.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  const hash = createHash('sha256').update(did).digest('hex').slice(0, 6);
  return `${clean || 'did'}-${hash}`;
}

/** 注册服务器上的句柄：`did:wba:awiki.ai:user:alice:e1_x` → `alice@awiki.ai`。 */
export function handleFromDid(did: string): string | null {
  const parts = did.replace(/^did:wba:/, '').split(':');
  if (parts.length < 2) return null;
  const host = parts[0]!.replace(/%3A/gi, ':');
  const readable = parts.slice(1).filter(part => !part.startsWith(E1_PREFIX) && part !== 'user');
  if (readable.length === 0) return null;
  return `${readable.join('.')}@${host}`;
}
