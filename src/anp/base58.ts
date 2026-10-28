/**
 * base58btc。
 *
 * 只为 multibase 公钥解码用：DID 文档里的 `publicKeyMultibase` 是
 * `z` + base58btc(0xed 0x01 + 32 字节 Ed25519 公钥)。不引依赖，
 * 二十行足够，也避免为一次解码拉进一整个编码库。
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i += 1) INDEX[ALPHABET[i]!] = i;

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) out += '1';
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]!]!;
  return out;
}

export function decodeBase58(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array();
  const bytes: number[] = [];
  for (const char of input) {
    const value = INDEX[char];
    if (value === undefined) throw new Error(`base58 含非法字符: ${char}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < input.length && input[i] === '1'; i += 1) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}
