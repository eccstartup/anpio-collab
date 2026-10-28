/**
 * 智能体侧的 ANP 身份。
 *
 * 这是"平台之外"的东西：私钥由智能体自己持有（或由 anpio-key 守护），
 * 平台只在登录时用请求里自带的公开文档验签。本模块存在是为了两件事——
 * 让示例智能体与测试能真正走 ANP 登录，以及让 `anpio-cli` 的用户一眼看出
 * 平台期望的请求长什么样。
 *
 * 生成的 DID 与文档形状对齐 `anpio-extension` 的 e1 profile：
 * `did:wba:<domain>:user:<handle>:e1_<fingerprint>`。
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  type webcrypto,
} from 'node:crypto';
import { encodeBase58 } from './base58.ts';
import { fingerprintOfRawKey } from './did.ts';

export type AnpIdentity = {
  did: string;
  keyid: string;
  publicKeyMultibase: string;
  fingerprint: string;
  didDocument: Record<string, unknown>;
  privateKey: KeyObject;
};

export const DEFAULT_DID_DOMAIN = 'agents.local';

const b64url = (value: Buffer): string =>
  value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function multibaseEd25519(rawPublicKey: Uint8Array): string {
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(rawPublicKey, 2);
  return `z${encodeBase58(prefixed)}`;
}

/** 从公钥对象拿到 32 字节原始 key（JWK 的 x 就是它）。 */
function rawPublicKey(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('无法导出 Ed25519 公钥');
  return new Uint8Array(Buffer.from(jwk.x.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

export function buildIdentity(privateKey: KeyObject, options: { handle: string; domain?: string }): AnpIdentity {
  const domain = options.domain ?? DEFAULT_DID_DOMAIN;
  const handle = options.handle.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!handle) throw new Error('handle 不能为空');

  const raw = rawPublicKey(createPublicKey(privateKey));
  const fingerprint = fingerprintOfRawKey(raw);
  const did = `did:wba:${domain}:user:${handle}:e1_${fingerprint}`;
  const keyid = `${did}#key-1`;
  const publicKeyMultibase = multibaseEd25519(raw);

  const didDocument = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/data-integrity/v2',
      'https://w3id.org/security/multikey/v1',
    ],
    id: did,
    verificationMethod: [{ id: keyid, type: 'Multikey', controller: did, publicKeyMultibase }],
    authentication: [keyid],
    assertionMethod: [keyid],
  };

  return { did, keyid, publicKeyMultibase, fingerprint, didDocument, privateKey };
}

export function generateIdentity(options: { handle: string; domain?: string }): AnpIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return buildIdentity(privateKey, options);
}

/** 从 JWK 载入身份；同一个私钥永远得到同一个 DID。 */
export function identityFromJwk(jwk: webcrypto.JsonWebKey, options: { handle: string; domain?: string }): AnpIdentity {
  return buildIdentity(createPrivateKey({ key: jwk, format: 'jwk' }), options);
}

export function exportPrivateJwk(identity: AnpIdentity): webcrypto.JsonWebKey {
  return identity.privateKey.export({ format: 'jwk' }) as webcrypto.JsonWebKey;
}

/** 稳定短名，用于默认主体 ID。 */
export function shortHandle(handle: string): string {
  const clean = handle.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return clean || `agent-${createHash('sha256').update(handle).digest('hex').slice(0, 6)}`;
}

export const base64url = b64url;
