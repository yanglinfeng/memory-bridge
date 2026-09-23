import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  REFLECTION_GRAMMAR_MODEL,
  runReflectionGrammarProbe,
  writeReflectionGrammarReceipt,
} from '../scripts/verify-reflection-grammar.mjs';

function schemaFactory({ phase, retryMode }) {
  return {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        maxItems: retryMode === 'compact' ? 2 : 4,
        items: {
          type: 'object',
          properties: {
            evidence: {
              type: 'array',
              minItems: phase === 'verify' ? 3 : 1,
            },
          },
        },
      },
    },
  };
}

function successfulFetch(requests) {
  return async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/api/version') {
      return Response.json({ version: '0.31.1-test' });
    }
    if (pathname === '/api/tags') {
      return Response.json({
        models: [{
          name: REFLECTION_GRAMMAR_MODEL,
          model: REFLECTION_GRAMMAR_MODEL,
          digest: 'a'.repeat(64),
          details: { family: 'qwen2', parameter_size: '7.6B' },
        }],
      });
    }
    assert.equal(pathname, '/api/chat');
    const body = JSON.parse(String(init.body));
    requests.push(body);
    return Response.json({
      model: REFLECTION_GRAMMAR_MODEL,
      message: { content: '{"candidates":[]}' },
      done: true,
      done_reason: 'stop',
    });
  };
}

test('真实探针合同固定 qwen2.5:14b 并编译四种 reflection schema', async () => {
  const requests = [];
  const report = await runReflectionGrammarProbe({
    baseUrl: 'http://127.0.0.1:11434',
    fetchImpl: successfulFetch(requests),
    schemaFactory,
  });

  assert.equal(report.status, 'PASS');
  assert.equal(report.evidenceMode, 'test_injected');
  assert.equal(report.model.requested, REFLECTION_GRAMMAR_MODEL);
  assert.equal(report.model.resolved, REFLECTION_GRAMMAR_MODEL);
  assert.equal(report.model.digest, 'a'.repeat(64));
  assert.equal(report.ollama.version, '0.31.1-test');
  assert.equal(report.providerCalls, 4);
  assert.deepEqual(
    report.cases.map((item) => [item.phase, item.retryMode, item.status]),
    [
      ['discover', 'normal', 'PASS'],
      ['discover', 'compact', 'PASS'],
      ['verify', 'normal', 'PASS'],
      ['verify', 'compact', 'PASS'],
    ],
  );
  assert.equal(requests.length, 4);
  assert.ok(requests.every((body) => body.model === 'qwen2.5:14b'));
  assert.ok(requests.every((body) => body.stream === false));
  assert.deepEqual(
    requests.map((body) => body.format.properties.candidates.maxItems),
    [4, 2, 4, 2],
  );
  assert.deepEqual(
    requests.map((body) =>
      body.format.properties.candidates.items.properties.evidence.minItems),
    [1, 1, 3, 3],
  );
});

test('Ollama 返回其他模型时探针失败且不接受替换', async () => {
  const report = await runReflectionGrammarProbe({
    baseUrl: 'http://127.0.0.1:11434',
    schemaFactory,
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/version') {
        return Response.json({ version: '0.31.1-test' });
      }
      if (pathname === '/api/tags') {
        return Response.json({ models: [{
          name: REFLECTION_GRAMMAR_MODEL,
          digest: 'b'.repeat(64),
        }] });
      }
      assert.equal(pathname, '/api/chat');
      assert.equal(JSON.parse(String(init.body)).model, REFLECTION_GRAMMAR_MODEL);
      return Response.json({
        model: 'unexpected-reflection-model',
        message: { content: '{"candidates":[]}' },
      });
    },
  });

  assert.equal(report.status, 'FAIL');
  assert.equal(report.providerCalls, 1);
  assert.equal(report.cases[0].errorCode, 'model_substitution');
  assert.match(report.cases[0].errorFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(
    JSON.stringify(report).includes('unexpected-reflection-model'),
    false,
  );
});

test('HTTP 400 grammar 编译失败进入带指纹的 FAIL 而不是伪装 PASS', async () => {
  const rawError = 'Failed to initialize samplers: failed to parse grammar';
  const report = await runReflectionGrammarProbe({
    baseUrl: 'http://127.0.0.1:11434',
    schemaFactory,
    fetchImpl: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/version') {
        return Response.json({ version: '0.31.1-test' });
      }
      if (pathname === '/api/tags') {
        return Response.json({ models: [{
          name: REFLECTION_GRAMMAR_MODEL,
          digest: 'c'.repeat(64),
        }] });
      }
      return new Response(JSON.stringify({ error: rawError }), {
        status: 400,
      });
    },
  });

  assert.equal(report.status, 'FAIL');
  assert.equal(report.providerCalls, 1);
  assert.equal(report.cases[0].errorCode, 'grammar_compile_http_400');
  assert.match(report.cases[0].errorFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(report).includes(rawError), false);
  assert.equal(report.cases.slice(1).every((item) => item.status === 'SKIPPED'), true);
});

test('预检失败时 metadataCalls 记录真实已尝试请求数', async () => {
  let calls = 0;
  const report = await runReflectionGrammarProbe({
    baseUrl: 'http://127.0.0.1:11434',
    schemaFactory,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('offline sentinel must be fingerprinted');
    },
  });

  assert.equal(report.status, 'FAIL');
  assert.equal(calls, 1);
  assert.equal(report.metadataCalls, 1);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.errorCode, 'ollama_transport_error');
  assert.equal(JSON.stringify(report).includes('offline sentinel'), false);
});

test('替换 globalThis.fetch 不能把导出 probe 提升为真实 PASS', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = successfulFetch(requests);
  try {
    const report = await runReflectionGrammarProbe({ schemaFactory });
    assert.equal(report.status, 'PASS');
    assert.equal(report.evidenceMode, 'test_injected');
    assert.equal(requests.length, 4);
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'reflection-grammar-forgery-'),
    );
    try {
      assert.throws(
        () => writeReflectionGrammarReceipt(report, {
          parentDirectory: parent,
        }),
        /导出.*PASS|PASS.*CLI/iu,
      );
      assert.throws(
        () => writeReflectionGrammarReceipt({
          ...report,
          evidenceMode: 'real_ollama',
        }, { parentDirectory: parent }),
        /导出.*PASS|PASS.*CLI/iu,
      );
      assert.deepEqual(fs.readdirSync(parent), []);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('grammar 回执写入私有运行目录且不可变 SHA-256 可复算', () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'reflection-grammar-receipt-'),
  );
  try {
    assert.throws(() => writeReflectionGrammarReceipt({
      format: 'memory-bridge-reflection-grammar:v1',
      status: 'PASS',
      evidenceMode: 'test_injected',
    }, { parentDirectory: parent }), /导出.*PASS|PASS.*CLI/iu);
    const receipt = writeReflectionGrammarReceipt({
      format: 'memory-bridge-reflection-grammar:v1',
      status: 'FAIL',
      evidenceMode: 'test_injected',
    }, { parentDirectory: parent });
    assert.equal(fs.statSync(receipt.runRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(receipt.path).mode & 0o777, 0o600);
    const bytes = fs.readFileSync(receipt.path);
    assert.equal(receipt.sha256.length, 64);
    assert.equal(receipt.bytes, bytes.length);
    assert.throws(
      () => fs.writeFileSync(receipt.path, 'overwrite', { flag: 'wx' }),
      /EEXIST/u,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
