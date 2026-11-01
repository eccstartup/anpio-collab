/**
 * 供应商注册表（控制面）。
 *
 * 只校验目录本身：id 唯一、协议合法、四类齐全。
 * 协议适配器的请求形状与工具调用解析在 anpio-agents 的 tests/brains.test.ts。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, PROTOCOLS } from '../src/platform/embedded/providers.ts';

test('注册表：id 唯一、协议合法、四类齐全', () => {
  const ids = PROVIDERS.map(provider => provider.id);
  assert.equal(new Set(ids).size, ids.length, '供应商 id 不能重复');
  for (const provider of PROVIDERS) {
    assert.ok(provider.label.length > 0, `${provider.id} 缺 label`);
    // 没有默认地址的条目（订阅型、Jev）必须在 notes 里说明原因。
    if (provider.endpoints.length === 0) {
      assert.ok(provider.notes, `${provider.id} 没有端点也没有说明`);
    }
    for (const endpoint of provider.endpoints) {
      assert.ok((PROTOCOLS as readonly string[]).includes(endpoint.protocol), `${provider.id} 协议非法`);
      assert.match(endpoint.baseUrl, /^(https?:\/\/|\{)/, `${provider.id} 地址不合法`);
    }
    if (provider.keyEnv) assert.match(provider.keyEnv, /^[A-Z][A-Z0-9_]*$/);
  }
  const categories = new Set(PROVIDERS.map(provider => provider.category));
  assert.deepEqual([...categories].sort(), ['分发站', '厂商', '订阅', '自定义'].sort());
  const custom = PROVIDERS.filter(provider => provider.category === '自定义');
  assert.ok(custom.length >= 6, '自定义供应商应覆盖各协议');
});
