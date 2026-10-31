/**
 * 检索排序基线。
 *
 * 这里是纯函数测试：排序规则、中文二元组、字符预算截断。
 * 它不是检索质量评测——真实评测需要企业语料与标注，见 docs/architecture.md。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankKnowledge } from '../src/platform/services/knowledge.ts';
import type { Knowledge } from '../src/protocol/types.ts';

const item = (id: string, content: string, conditions: string): Knowledge => ({
  id,
  workspace: 'acme',
  sourceTaskId: `task-${id}`,
  content,
  conditions,
  state: 'published',
  version: 1,
  authorId: 'owner',
  reviewerId: 'reviewer',
  expiresAt: '2099-01-01T00:00:00Z',
  accessMode: 'workspace',
  createdAt: '2026-10-28T00:00:00Z',
  updatedAt: '2026-10-28T00:00:00Z',
  kind: 'experience',
  title: id,
  summary: '',
  tags: [],
  source: 'task',
  evidenceLevel: 'task_verified',
  archivedAt: null,
});

const corpus = [
  item('a', '缺料时先查库存快照，再确认供应商可供量与交期。', '物料 M-100 缺料'),
  item('b', '库存盘点每月一次，财务负责。', '所有物料'),
  item('c', '供应商准入需要资质审核。', '供应商合作'),
];

test('中文二元组可以命中部分词', () => {
  const result = rankKnowledge(corpus, '缺料', 5, 10_000);
  assert.equal(result.items[0].id, 'a');
  assert.ok(result.items.every(entry => entry.id === 'a'));
});

test('适用条件的命中权重高于正文', () => {
  const rows = [
    item('content-only', 'M-100 的库存为零', '通用说明'),
    item('condition-only', '请按流程处理', 'M-100 缺料处理'),
  ];
  const result = rankKnowledge(rows, 'M-100', 5, 10_000);
  assert.equal(result.items[0].id, 'condition-only');
});

test('精确短语得分高于词元命中', () => {
  const rows = [item('split', '缺 料 处理', '通用'), item('phrase', '缺料处理', '通用')];
  const result = rankKnowledge(rows, '缺料', 5, 10_000);
  assert.equal(result.items[0].id, 'phrase');
});

test('空查询按原顺序返回，limit 生效', () => {
  const result = rankKnowledge(corpus, '   ', 2, 10_000);
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.items.map(entry => entry.id),
    ['a', 'b'],
  );
});

test('字符预算不足时截断正文并标记', () => {
  const long = item('long', '缺料'.repeat(500), 'M-100');
  const result = rankKnowledge([long], '缺料', 5, 600);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].contentTruncated, true);
  assert.ok(result.items[0].content.length < long.content.length);
  assert.ok(result.usedChars <= 600);
});

test('每条结果都带稳定引用', () => {
  const result = rankKnowledge(corpus, '库存', 5, 10_000);
  for (const entry of result.items) {
    assert.equal(entry.reference, `knowledge:${entry.id}:${entry.version}`);
  }
});
