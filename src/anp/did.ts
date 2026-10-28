/**
 * did:wba 文档解析。
 *
 * 平台只读公开文档，不保管私钥、不代签：登录请求自带 `didDocument`，
 * 这里从中取出 `keyid` 指向的 Ed25519 公钥用于验签。
 *
 * 支持两种公钥表示：
 *  - `publicKeyMultibase`（e1 profile，`z` + base58btc(0xed01 || key)）；
 *  - `publicKeyJwk`（标准的 OKP/Ed25519 JWK），便于别家实现接入。
 */

import { createPublicKey, createHash, type KeyObject } from 'node:crypto';
import { decodeBase58 } from './base58.ts';

const ED25519_MULTICODEC = [0xed, 0x01];

export type ResolvedKey = {
  key: KeyObject;
  keyid: string;
  /** RFC 7638 JWK 指纹（base64url 无填充），用于识别同一把钥匙。 */
  fingerprint: string;
};

export const isDid = (value: unknown): value is string =>
  typeof value === 'string' && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value) && value.length <= 300;

/** `z` + base58btc(0xed01 || pubkey) → 原始 32 字节公钥。 */
export function decodeMultibaseEd25519(value: string): Uint8Array {
  if (typeof value !== 'string' || !value.startsWith('z')) {
    throw new Error('publicKeyMultibase 必须是 z 开头的 base58btc multibase');
  }
  const bytes = decodeBase58(value.slice(1));
  if (bytes.length !== 34 || bytes[0] !== ED25519_MULTICODEC[0] || bytes[1] !== ED25519_MULTICODEC[1]) {
    throw new Error('publicKeyMultibase 不是 Ed25519 多编址公钥');
  }
  return bytes.slice(2);
}

const b64url = (buffer: Buffer): string =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 7638：`{"crv":"Ed25519","kty":"OKP","x":"..."}` 的 SHA-256。 */
export function fingerprintOfRawKey(raw: Uint8Array): string {
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${b64url(Buffer.from(raw))}"}`;
  return b64url(createHash('sha256').update(canonical).digest());
}

function keyObjectFromRaw(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: b64url(Buffer.from(raw)) },
    format: 'jwk',
  });
}

type VerificationMethod = {
  id?: unknown;
  type?: unknown;
  controller?: unknown;
  publicKeyMultibase?: unknown;
  publicKeyJwk?: unknown;
};

/**
 * 从文档里解析 `keyid` 对应的公钥。
 *
 * 匹配规则按 DID 规范：`#key-1` 这样的相对引用，先补全成 `<did>#key-1` 再比。
 * 找不到就报错——调用方据此拒绝登录，而不是退化成"任取一把钥匙"。
 */
export function resolveVerificationKey(did: string, keyid: string, document: unknown): ResolvedKey {
  const doc = document as { id?: unknown; verificationMethod?: unknown; authentication?: unknown };
  if (!doc || typeof doc !== 'object') throw new Error('didDocument 不是对象');
  if (typeof doc.id === 'string' && doc.id !== did) {
    throw new Error('didDocument.id 与请求体声明的 DID 不一致');
  }
  const methods = Array.isArray(doc.verificationMethod) ? (doc.verificationMethod as VerificationMethod[]) : [];
  if (methods.length === 0) throw new Error('didDocument 缺少 verificationMethod');

  const wanted = keyid.includes('#') ? keyid : `${did}#${keyid}`;
  const method =
    methods.find(item => typeof item.id === 'string' && (item.id === wanted || `${did}${item.id}` === wanted)) ??
    (methods.length === 1 ? methods[0]! : undefined);
  if (!method) throw new Error(`didDocument 中没有 ${wanted} 对应的公钥`);

  // 若文档声明了 authentication，签名的钥匙必须在其中，避免用一把未授权的方法冒充。
  const auth = Array.isArray(doc.authentication) ? doc.authentication : null;
  if (auth && method.id && !auth.some(entry => entry === method.id || `${did}${String(entry)}` === wanted)) {
    throw new Error('该钥匙未被 didDocument 的 authentication 授权');
  }

  if (typeof method.publicKeyMultibase === 'string') {
    const raw = decodeMultibaseEd25519(method.publicKeyMultibase);
    return {
      key: keyObjectFromRaw(raw),
      keyid: typeof method.id === 'string' ? method.id : wanted,
      fingerprint: fingerprintOfRawKey(raw),
    };
  }

  const jwk = method.publicKeyJwk as { kty?: string; crv?: string; x?: string } | undefined;
  if (jwk && jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string') {
    const raw = Buffer.from(jwk.x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return {
      key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }),
      keyid: typeof method.id === 'string' ? method.id : wanted,
      fingerprint: fingerprintOfRawKey(raw),
    };
  }

  throw new Error('该 verificationMethod 既没有 publicKeyMultibase 也没有 Ed25519 JWK');
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
