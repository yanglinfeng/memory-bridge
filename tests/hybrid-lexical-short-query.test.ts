import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { HybridRetrievalIndex } from '../src/server/hybrid-retrieval.js';
import { MemoryStore } from '../src/server/memory-store.js';

// 回归背景：FTS5 表用 tokenize='trigram'，而词法通道的查询词由 3-gram 生成，
// 于是"压缩后不足 3 字"的查询（两字中文、两字母缩写）会拿到空查询词表，
// 词法通道整体空转 —— 表现为中文检索 0 命中。
const CONTENT =
  '差旅与报销管理制度：出差住宿标准为一线城市每晚 450 元，补贴每人每天 200 元。';

test('两字中文查询能命中词法通道（trigram 短查询回归）', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-short-cjk-'));
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  try {
    const policy = store.remember({
      kind: 'knowledge',
      content: CONTENT,
      stableKey: 'travel-policy',
    }).memory;

    for (const query of ['差旅', '补贴', '住宿']) {
      const result = new HybridRetrievalIndex(database).searchWithDiagnostics({
        query,
        userId: 'default',
        namespace: 'personal',
        timestamp: '2026-09-30T08:00:00.000Z',
        limit: 10,
      });
      assert.ok(
        result.diagnostics.channels.lexical.rawCount > 0,
        `两字中文查询未命中词法通道：${query}`,
      );
      assert.ok(
        result.candidates.some((candidate) => candidate.id === policy.id),
        `两字中文查询候选未包含目标记忆：${query}`,
      );
    }
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('两字母拉丁缩写查询能命中词法通道', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-short-latin-'));
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  try {
    const note = store.remember({
      kind: 'knowledge',
      content: '内网 AI 部署要求：模型推理不得出网，向量模型使用 bge-m3。',
      stableKey: 'intranet-ai',
    }).memory;

    const result = new HybridRetrievalIndex(database).searchWithDiagnostics({
      query: 'AI',
      userId: 'default',
      namespace: 'personal',
      timestamp: '2026-09-30T08:00:00.000Z',
      limit: 10,
    });
    assert.ok(
      result.diagnostics.channels.lexical.rawCount > 0,
      '两字母缩写未命中词法通道：AI',
    );
    assert.ok(result.candidates.some((candidate) => candidate.id === note.id));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
