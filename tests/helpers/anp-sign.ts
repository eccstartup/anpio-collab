/**
 * 测试用 ANP 请求签名。
 *
 * 平台已经不用本地签名实现了，但负例测试仍要能签**任意请求体**、甚至用别人的
 * 钥匙签（伪造），所以这里直接用 core 的覆盖集与序列化规则，配 Node 的
 * `crypto.sign`（它接受 `KeyObject`，测试夹具正好持有）。
 *
 * 覆盖分量与 `signAnpLoginRequest` 一致：`@method` `@target-uri`
 * `@authority` `content-digest`。
 */

import { sign as cryptoSign, type KeyObject } from 'node:crypto';
import {
  ANP_COMPONENTS,
  buildContentDigestValue,
  buildSignatureBase,
  serializeSignatureParams,
  signatureBaseBytes,
} from '@anpio-cli/core/advanced';
import { signDidDocumentProofSync } from '@anpio-cli/core/advanced';
import type { AnpIdentity } from '../../src/anp/identity.ts';

export type SignOptions = {
  method?: string;
  url: string;
  body: string;
  nonce: string;
  keyid: string;
  privateKey: KeyObject;
  ttlSeconds?: number;
  now?: number;
  /** 负例用：覆盖集可以少于 ANP 的最小集合，服务端必须拒绝。 */
  components?: string[];
};

export async function signRequest(options: SignOptions): Promise<{ headers: Record<string, string>; body: string }> {
  const method = (options.method ?? 'POST').toUpperCase();
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? 300;
  const components = options.components ?? [...ANP_COMPONENTS];
  const url = new URL(options.url);
  const digest = await buildContentDigestValue(Buffer.from(options.body, 'utf8'));
  const signatureParams = serializeSignatureParams(components, {
    created: now,
    expires: now + ttl,
    nonce: options.nonce,
    keyid: options.keyid,
  });
  const base = buildSignatureBase({
    method,
    path: url.pathname,
    authority: url.host,
    targetUri: options.url,
    headers: { 'content-digest': digest },
    components,
    signatureParams,
  });
  const signature = cryptoSign(null, Buffer.from(signatureBaseBytes(base)), options.privateKey);
  return {
    body: options.body,
    headers: {
      'content-digest': digest,
      'signature-input': `sig1=${signatureParams}`,
      signature: `sig1=:${signature.toString('base64')}:`,
    },
  };
}

/**
 * 改过 DID 文档后重新签 proof——proof 覆盖整份文档，改一个字段就得重签。
 * 返回新文档，不改入参。
 */
export function resignDocument(
  document: Record<string, unknown>,
  identity: Pick<AnpIdentity, 'keyid' | 'priv'>,
): Record<string, unknown> {
  const { proof: _old, ...unsigned } = document;
  const next = { ...unsigned };
  next.proof = signDidDocumentProofSync(next, identity.keyid, identity.priv);
  return next;
}
