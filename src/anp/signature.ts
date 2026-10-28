/**
 * RFC 9421 HTTP Message Signatures（ANP-02/03 用到的子集）。
 *
 * 只做一件事：从真实请求上重建签名基并验证，或者反过来为出站请求签名。
 * 覆盖分量**不写死**——`Signature-Input` 说覆盖了什么就重建什么，
 * 这样钱包插件、`anpio-cli`、`anpio-key` 三家的细微差别都不需要平台改代码；
 * 反过来写死一个分量列表，就会在没有覆盖 `@authority` 的实现上悄悄放过重放。
 */

import { createHash, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export type SignedRequestParts = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
};

export type ParsedSignature = {
  label: string;
  components: string[];
  /** 括号内的原始分量列表，例如 `("@method" "@target-uri")`。 */
  innerList: string;
  /** 括号之后的参数原文，例如 `created=1;expires=2;nonce="x"`。 */
  params: string;
  created?: number;
  expires?: number;
  nonce?: string;
  keyid?: string;
};

const DEFAULT_TTL_SECONDS = 300;
/** 允许的对时误差；与插件、CLI 的 300s 保持一致。 */
export const CLOCK_SKEW_SECONDS = 300;

export const sha256Digest = (body: string | Uint8Array): string =>
  `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;

/** 按顶层分隔符切分，跳过引号与括号里的内容。 */
function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (char === '"' && input[i - 1] !== '\\') quoted = !quoted;
    else if (!quoted && (char === '(' || char === '<')) depth += 1;
    else if (!quoted && (char === ')' || char === '>')) depth -= 1;
    else if (!quoted && depth === 0 && char === separator) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * 解析 `Signature-Input` 的第一个签名成员。
 *
 * 只取第一个：ANP 的登录请求只有一个 `sig1`，多签名是另一种场景，
 * 猜第二个会变成"看哪个能验过就用哪个"——那不是验证。
 */
export function parseSignatureInput(header: string): ParsedSignature {
  const text = header.trim();
  const eq = text.indexOf('=');
  if (eq <= 0) throw new Error('Signature-Input 缺少签名标签');
  const label = text.slice(0, eq).trim();
  const rest = text.slice(eq + 1).trim();

  if (!rest.startsWith('(')) throw new Error('Signature-Input 缺少分量列表');
  let depth = 0;
  let quoted = false;
  let close = -1;
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i]!;
    if (char === '"' && rest[i - 1] !== '\\') quoted = !quoted;
    else if (!quoted && char === '(') depth += 1;
    else if (!quoted && char === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error('Signature-Input 的分量列表没有闭合');

  const innerList = rest.slice(0, close + 1);
  const tail = rest.slice(close + 1);
  const params = splitTopLevel(tail, ',')[0]!.replace(/^;/, '').trim();

  const components: string[] = [];
  for (const item of splitTopLevel(innerList.slice(1, -1), ' ')) {
    const token = item.trim();
    if (!token) continue;
    // `"content-digest";sf` 这类参数只影响序列化，不影响取值。
    const name = unquote(token.split(';')[0]!.trim());
    if (name) components.push(name);
  }
  if (components.length === 0) throw new Error('Signature-Input 没有覆盖任何分量');

  const parsed: ParsedSignature = { label, components, innerList, params };
  for (const item of splitTopLevel(params, ';')) {
    const [rawName, ...restValue] = item.split('=');
    if (!rawName || restValue.length === 0) continue;
    const name = rawName.trim().toLowerCase();
    const value = unquote(restValue.join('='));
    if (name === 'created') parsed.created = Number(value);
    else if (name === 'expires') parsed.expires = Number(value);
    else if (name === 'nonce') parsed.nonce = value;
    else if (name === 'keyid') parsed.keyid = value;
  }
  return parsed;
}

/** 解析 `Signature: sig1=:base64:`，返回标签对应的签名字节。 */
export function parseSignatureHeader(header: string): { label: string; signature: Buffer } {
  const text = header.trim();
  const eq = text.indexOf('=');
  if (eq <= 0) throw new Error('Signature 头缺少签名标签');
  const label = text.slice(0, eq).trim();
  const value = text.slice(eq + 1).trim();
  const match = /^:([A-Za-z0-9+/=]+):$/.exec(value);
  if (!match) throw new Error('Signature 值不是 `:base64:` 形式');
  return { label, signature: Buffer.from(match[1]!, 'base64') };
}

function componentValue(name: string, parts: SignedRequestParts): string {
  const url = new URL(parts.url);
  switch (name) {
    case '@method':
      return parts.method.toUpperCase();
    case '@target-uri':
      return parts.url;
    case '@authority':
      return url.host;
    case '@scheme':
      return url.protocol.replace(':', '');
    case '@path':
      return url.pathname;
    case '@query':
      return url.search ? url.search : '?';
    case '@request-target':
      return `${url.pathname}${url.search}`;
    default: {
      const value = parts.headers[name.toLowerCase()];
      if (value === undefined) throw new Error(`签名覆盖了请求未携带的头 ${name}`);
      return value;
    }
  }
}

/** 重建 ASCII 签名基：每个分量一行，最后一行是 `"@signature-params"`。 */
export function buildSignatureBase(parsed: ParsedSignature, parts: SignedRequestParts): string {
  const lines = parsed.components.map(name => `"${name}": ${componentValue(name, parts)}`);
  const params = parsed.params ? `${parsed.innerList};${parsed.params}` : parsed.innerList;
  lines.push(`"@signature-params": ${params}`);
  return lines.join('\n');
}

export type VerifyOptions = {
  /** 允许的对时误差，秒。 */
  skewSeconds?: number;
  /** 由调用方提供"当前时间"，测试可以固定时钟。 */
  now?: number;
};

export type VerifiedSignature = {
  did: string;
  keyid: string;
  nonce: string | null;
  created: number | null;
  components: string[];
};

/**
 * 验证一个已解析的签名。
 *
 * 顺序是刻意的：先比对 content-digest（字节是否被改），再比时间窗口
 * （是否过期），最后才做公钥运算。前面两步失败时不做无谓的密码学运算，
 * 也让错误信息能指出到底是哪一层不对。
 */
export function verifySignature(
  parts: SignedRequestParts,
  key: KeyObject,
  keyid: string,
  did: string,
  options: VerifyOptions = {},
): VerifiedSignature {
  const inputHeader = parts.headers['signature-input'];
  const signatureHeader = parts.headers.signature;
  if (!inputHeader) throw new Error('缺少 Signature-Input 头');
  if (!signatureHeader) throw new Error('缺少 Signature 头');

  const parsed = parseSignatureInput(inputHeader);
  const { label, signature } = parseSignatureHeader(signatureHeader);
  if (label !== parsed.label) throw new Error('Signature 与 Signature-Input 的标签不一致');

  if (parsed.components.includes('content-digest')) {
    const declared = parts.headers['content-digest'];
    if (!declared) throw new Error('签名覆盖了 content-digest，但请求没有该头');
    const actual = sha256Digest(parts.body);
    if (declared.trim() !== actual) throw new Error('content-digest 与请求体不一致');
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.skewSeconds ?? CLOCK_SKEW_SECONDS;
  if (typeof parsed.created === 'number' && parsed.created - skew > now) {
    throw new Error('签名时间在未来，超出允许误差');
  }
  if (typeof parsed.expires === 'number' && parsed.expires + skew < now) {
    throw new Error('签名已过期');
  }
  if (typeof parsed.created !== 'number' && typeof parsed.expires !== 'number') {
    // 没有时间参数就无法判断新鲜度，一律拒绝；重放窗口靠 nonce 兜底，但两者都要。
    throw new Error('签名缺少 created / expires');
  }

  const base = buildSignatureBase(parsed, parts);
  const ok = cryptoVerify(null, Buffer.from(base, 'utf8'), key, signature);
  if (!ok) throw new Error('签名校验失败');

  return {
    did,
    keyid,
    nonce: parsed.nonce ?? null,
    created: parsed.created ?? null,
    components: [...parsed.components],
  };
}

export type SignOptions = {
  method?: string;
  url: string;
  body: string;
  nonce: string;
  keyid: string;
  privateKey: KeyObject;
  ttlSeconds?: number;
  now?: number;
};

/**
 * 为出站 ANP-02 请求签名。
 *
 * 覆盖分量与钱包插件、`anpio-key` 一致（`@method` `@target-uri` `@authority`
 * `content-digest`），参数拼写也一致，因此平台既能验证它们，也能生成
 * 同样的请求给别的 ANP 服务端。
 */
export function signRequest(options: SignOptions): { headers: Record<string, string>; body: string } {
  const method = (options.method ?? 'POST').toUpperCase();
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const components = ['@method', '@target-uri', '@authority', 'content-digest'];
  const digest = sha256Digest(options.body);
  const params = `created=${now};expires=${now + ttl};nonce="${options.nonce}";keyid="${options.keyid}"`;
  const innerList = `(${components.map(name => `"${name}"`).join(' ')})`;
  const parsed: ParsedSignature = {
    label: 'sig1',
    components,
    innerList,
    params,
    created: now,
    expires: now + ttl,
    nonce: options.nonce,
    keyid: options.keyid,
  };
  const base = buildSignatureBase(parsed, {
    method,
    url: options.url,
    headers: { 'content-digest': digest },
    body: options.body,
  });
  const signature = cryptoSign(null, Buffer.from(base, 'utf8'), options.privateKey);
  return {
    body: options.body,
    headers: {
      'content-digest': digest,
      'signature-input': `sig1=${innerList};${params}`,
      signature: `sig1=:${signature.toString('base64')}:`,
    },
  };
}
