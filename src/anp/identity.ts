/**
 * 智能体侧的 ANP 身份。
 *
 * 这是"平台之外"的东西：私钥由智能体自己持有（或由 anpio-key 守护），
 * 平台只在登录时用请求里自带的公开文档验签。本模块存在是为了两件事——
 * 让示例智能体与测试能真正走 ANP 登录，以及让 `anpio-cli` 的用户一眼看出
 * 平台期望的请求长什么样。
 *
 * DID、文档与 proof 都由 `@anpio-cli/core` 生成，本模块只负责把 Node 的
 * `KeyObject` 换成 core 需要的原始字节。生成的 DID 形状仍是
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
import { didFingerprint, identityDid, subjectOf } from '@anpio-cli/core';
import {
  buildBaseDidDocument,
  encodeMultibaseEd25519,
  signDidDocumentProofSync,
} from '@anpio-cli/core/advanced';

export type AnpIdentity = {
  /** 去掉指纹的稳定主体标识，例如 `did:wba:agents.local:user:alice`。 */
  subject: string;
  did: string;
  keyid: string;
  publicKeyMultibase: string;
  publicKey: { publicKeyMultibase: string };
  fingerprint: string;
  didDocument: Record<string, unknown>;
  /** Node 侧的私钥对象，供需要 WebCrypto/KeyObject 的调用方使用。 */
  privateKey: KeyObject;
  /** 32 字节 Ed25519 种子；core 的签名入口只收原始字节。 */
  priv: Uint8Array;
};

export const DEFAULT_DID_DOMAIN = 'agents.local';

const b64url = (value: Buffer): string =>
  value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 从公钥对象拿到 32 字节原始 key（JWK 的 x 就是它）。 */
function rawPublicKey(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('无法导出 Ed25519 公钥');
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
}

function rawPrivateKey(privateKey: KeyObject): Uint8Array {
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  if (!jwk.d) throw new Error('无法导出 Ed25519 私钥');
  return new Uint8Array(Buffer.from(jwk.d, 'base64url'));
}

export function buildIdentity(privateKey: KeyObject, options: { handle: string; domain?: string }): AnpIdentity {
  const domain = options.domain ?? DEFAULT_DID_DOMAIN;
  const handle = options.handle.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!handle) throw new Error('handle 不能为空');

  const raw = rawPublicKey(createPublicKey(privateKey));
  const priv = rawPrivateKey(privateKey);
  const did = identityDid(domain, undefined, undefined, {
    curve: 'ed25519',
    publicKey: raw,
    path: ['user', handle],
  });
  const keyid = `${did}#key-1`;
  const publicKeyMultibase = encodeMultibaseEd25519(raw);
  const fingerprint = didFingerprint('ed25519', raw);
  const didDocument = buildBaseDidDocument({ did, keyid, publicKeyMultibase });
  // e1_ 文档的 proof 是登录时对方校验的那一份：没有它，core 在 lenient 下也拒绝。
  didDocument.proof = signDidDocumentProofSync(didDocument, keyid, priv);

  return {
    subject: subjectOf(did),
    did,
    keyid,
    publicKeyMultibase,
    publicKey: { publicKeyMultibase },
    fingerprint,
    didDocument,
    privateKey,
    priv,
  };
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
