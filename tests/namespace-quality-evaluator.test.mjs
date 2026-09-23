import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  SCHEMA_VERSION,
} from '../dist/server/database.js';
import {
  CandidateResolver,
} from '../dist/server/candidate-resolver.js';
import {
  LifecycleStore,
} from '../dist/server/lifecycle-store.js';
import { MemoryStore } from '../dist/server/memory-store.js';
import {
  MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
} from '../dist/server/memory-extractor.js';
import {
  NAMESPACE_QUALITY_EVALUATOR_VERSION,
  NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
  NamespaceQualityService,
} from '../dist/server/namespace-quality.js';
import {
  assertSafeRecordingTarget,
  isAutoCommitEligible,
  matchExtractionCase,
  parseFixedDatasetBytes,
  QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
  quantityTokens,
  recordNamespaceSnapshot,
  relationEmbeddingTexts,
  runCredentialPipelinePreflight,
  summarizeExtractionQuality,
  valueTermMatches,
} from '../scripts/evaluate-namespace-quality.mjs';

const USER_ID = 'quality-recording-test';
const NAMESPACE = 'personal';
const FIXED_SHA =
  'a5a1212cac317bc6274ccad2aa207fc29d34ad20bddbe991c77fc8217587c708';

test('质量流水线源码指纹锁定当前 evaluator、提取器和冲突解析器', () => {
  assert.equal(
    QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
    NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
  );
});

test('语义去重固定集同时预缓存正文和关系谓词向量', () => {
  assert.deepEqual(relationEmbeddingTexts({
    candidate: {
      content: '候选正文',
      predicate: '当前编辑器 [条件:工作日]',
    },
    target: {
      content: '目标正文',
      predicateKey: '用户::当前编辑器 [条件:工作日]',
    },
  }), [
    '候选正文',
    '目标正文',
    '当前编辑器',
    '当前编辑器',
  ]);
});

test('value matcher 保守允许短插入且拒绝错误数量和无关语句', () => {
  assert.equal(
    valueTermMatches('每周固定发布三篇', '每周发布三篇'),
    true,
  );
  assert.equal(
    valueTermMatches('每周固定发布三十篇', '每周发布三篇'),
    false,
  );
  assert.equal(
    valueTermMatches(
      '每周开会并发布版本，季度会写三篇总结',
      '每周发布三篇',
    ),
    false,
  );
  assert.equal(
    valueTermMatches('运行完整 CI', 'CI'),
    true,
  );
  assert.equal(
    valueTermMatches('持续集成流水线', 'CI'),
    false,
  );
  assert.equal(valueTermMatches('CITIES', 'CI'), false);
  assert.equal(valueTermMatches('reactive', 'React'), false);
  assert.equal(valueTermMatches('React Native', 'React'), true);
});

test('value matcher 拒绝极性翻转和额外冲突数量', () => {
  assert.equal(
    valueTermMatches('项目不使用 Rust', '使用 Rust'),
    false,
  );
  assert.equal(
    valueTermMatches(
      '产品不允许收集匿名遥测',
      '允许收集匿名遥测',
    ),
    false,
  );
  assert.equal(
    valueTermMatches(
      '产品不允许收集匿名遥测',
      '不允许收集匿名遥测',
    ),
    true,
  );
  assert.equal(
    valueTermMatches(
      '每周发布三篇，现改为十篇',
      '每周发布三篇',
    ),
    false,
  );
  assert.equal(
    valueTermMatches(
      '先向用户确认',
      '确认',
      'AIRI 对不确定的信息必须先向用户确认。',
    ),
    true,
  );
});

test('value matcher 用完整 expected claim 校验数量和删除动作', () => {
  assert.equal(
    valueTermMatches(
      '每周五下午做下一周计划',
      '每周五下午',
      '用户每周五下午做下一周计划。',
    ),
    true,
  );
  assert.equal(
    valueTermMatches(
      '每周五下午做下一周计划',
      '下一周计划',
      '用户每周五下午做下一周计划。',
    ),
    true,
  );
  assert.equal(
    valueTermMatches(
      '永久删除前必须二次确认',
      '二次确认',
      '永久删除前必须二次确认。',
    ),
    true,
  );
});

test('value matcher 只把数量语境解析为中文数量、序数、比例和日期', () => {
  assert.deepEqual(
    quantityTokens('五小时以内时我一直优先坐高铁'),
    ['duration:5:小时'],
  );
  assert.deepEqual(
    quantityTokens('我的第一块学习板固定选 ESP32-S3'),
    ['ordinal:1:块'],
  );
  assert.deepEqual(
    quantityTokens('封面统一使用三比四的竖图'),
    ['ratio:3:4'],
  );
  assert.deepEqual(
    quantityTokens('发票统一在每月五号开具'),
    ['month-day:5'],
  );
  assert.deepEqual(
    quantityTokens('一直、统一、一贯、一旦、ESP32-S3'),
    [],
  );
  const equivalentCases = [
    [
      '出差在五小时以内时我一直优先坐高铁',
      '高铁',
      '五小时以内的出差用户优先乘坐高铁。',
    ],
    [
      '我的第一块学习板固定选 ESP32-S3',
      'ESP32-S3',
      '用户的第1块学习板选择 ESP32-S3。',
    ],
    [
      '封面统一使用三比四的竖图',
      '竖图',
      '用户的封面统一使用 3:4 竖图。',
    ],
    [
      '发票统一在每月五号开具',
      '发票',
      '用户统一在每月5号开具发票。',
    ],
    [
      '我一直保持简洁回答',
      '简洁',
      '用户一直保持简洁回答。',
    ],
    [
      '封面统一使用竖图',
      '竖图',
      '用户的封面统一使用竖图。',
    ],
    [
      '我一贯优先给出结论',
      '结论',
      '用户一贯优先给出结论。',
    ],
    [
      '一旦失败就停止',
      '停止',
      '一旦失败就停止。',
    ],
  ];
  for (const [candidate, term, canonical] of equivalentCases) {
    assert.equal(
      valueTermMatches(candidate, term, canonical),
      true,
      `${candidate} 应匹配 ${canonical}`,
    );
  }

  const conflictingCases = [
    [
      '出差在六小时以内时优先坐高铁',
      '高铁',
      '五小时以内的出差用户优先乘坐高铁。',
    ],
    [
      '我的第二块学习板固定选 ESP32-S3',
      'ESP32-S3',
      '用户的第一块学习板选择 ESP32-S3。',
    ],
    [
      '封面统一使用四比三的竖图',
      '竖图',
      '用户的封面统一使用三比四竖图。',
    ],
    [
      '发票统一在每月六号开具',
      '发票',
      '用户统一在每月五号开具发票。',
    ],
    [
      '每周固定发布三篇并额外发布十篇',
      '发布',
      '用户每周固定发布三篇内容。',
    ],
    [
      '每周五下午做下两周计划',
      '计划',
      '用户每周五下午做下一周计划。',
    ],
  ];
  for (const [candidate, term, canonical] of conflictingCases) {
    assert.equal(
      valueTermMatches(candidate, term, canonical),
      false,
      `${candidate} 不得匹配 ${canonical}`,
    );
  }
});

test('value matcher 只匹配纠正后的新值并拒绝被取消的旧值', () => {
  const corrections = [
    ['从 VS Code 改为 Cursor', 'VS Code', 'Cursor'],
    ['弃用 npm，改为 pnpm', 'npm', 'pnpm'],
    ['停止使用 Chrome，改用 Firefox', 'Chrome', 'Firefox'],
    ['从北京搬到上海', '北京', '上海'],
    ['撤销 Notion，切换到 Obsidian', 'Notion', 'Obsidian'],
    ['删除 React，替换为 Vue', 'React', 'Vue'],
    ['取消 MySQL，迁移到 PostgreSQL', 'MySQL', 'PostgreSQL'],
  ];
  for (const [candidate, oldValue, newValue] of corrections) {
    assert.equal(
      valueTermMatches(candidate, oldValue),
      false,
      `${candidate} 不得匹配旧值 ${oldValue}`,
    );
    assert.equal(
      valueTermMatches(candidate, newValue),
      true,
      `${candidate} 应匹配新值 ${newValue}`,
    );
  }
});

test('提取匹配的 embedding key 只使用结构化 claim 字段', () => {
  const fixture = {
    text: '每周一上午安排本周计划。',
    expected: [
      {
        id: 'weekly-plan',
        canonical: '用户每周一上午安排本周计划。',
        valueTerms: ['每周一上午', '本周计划'],
      },
    ],
  };
  const candidate = {
    subject: '用户',
    predicate: '计划时间',
    value: '每周一上午安排本周计划',
    content:
      'atomic-memory-v1:' +
      '{"subject":"用户","predicate":"计划时间",' +
      '"value":"每周一上午安排本周计划",' +
      '"negated":false}',
    negated: false,
    scopeType: 'personal',
    scopeKey: 'self',
  };
  const vectors = new Map([
    [fixture.expected[0].canonical, [1, 0]],
    [
      [
        candidate.subject,
        candidate.predicate,
        candidate.value,
        '肯定',
      ].join('\n'),
      [1, 0],
    ],
    [
      [
        candidate.subject,
        candidate.predicate,
        candidate.value,
        candidate.content,
      ].join('\n'),
      [0, 1],
    ],
  ]);

  assert.equal(
    matchExtractionCase(
      fixture,
      [candidate],
      vectors,
    ).matches.length,
    1,
  );
});

test('提取匹配不得用 content 绕过 value 的原子事实校验', () => {
  const fixture = {
    expected: [
      {
        id: 'expected-1',
        canonical: '产品允许收集匿名遥测。',
        valueTerms: ['允许收集匿名遥测'],
      },
    ],
  };
  const candidate = {
    subject: '产品',
    predicate: '遥测规则',
    value: '遥测设置',
    content: '产品不允许收集匿名遥测。',
    negated: false,
  };
  const result = matchExtractionCase(
    fixture,
    [candidate],
    { get: () => [1, 0] },
  );
  assert.equal(result.matches.length, 0);
});

test('提取匹配优先最大基数，不被局部最高分贪心卡住', () => {
  const fixture = {
    expected: [
      {
        id: 'flexible',
        canonical: '灵活事实',
        valueTerms: ['A', 'B'],
      },
      {
        id: 'only-a',
        canonical: '只能匹配 A',
        valueTerms: ['A'],
      },
    ],
  };
  const candidates = [
    {
      subject: '用户',
      predicate: '第一项',
      value: 'A',
      content: '候选 A',
      negated: false,
    },
    {
      subject: '用户',
      predicate: '第二项',
      value: 'B',
      content: '候选 B',
      negated: false,
    },
  ];
  const result = matchExtractionCase(
    fixture,
    candidates,
    { get: () => [1, 0] },
  );
  assert.equal(result.matches.length, 2);
  assert.deepEqual(
    result.matches.map(
      ({ expectedIndex, candidateIndex }) => [
        expectedIndex,
        candidateIndex,
      ],
    ),
    [[0, 1], [1, 0]],
  );
});

test('项目固定集不能把 Atlas/Orbit 的 personal 候选计为 TP', () => {
  for (const fixture of [
    {
      text: 'Atlas 项目的后端确定使用 Node.js。Atlas 使用 pnpm。',
      scopeKey: 'Atlas',
      expected: [
        {
          id: 'atlas-scope',
          canonical: 'Atlas 项目使用 Node.js。',
          valueTerms: ['Node.js'],
        },
      ],
    },
    {
      text: 'Orbit 软件坚持本地优先。Orbit 每天备份。',
      scopeKey: 'Orbit',
      expected: [
        {
          id: 'orbit-scope',
          canonical: 'Orbit 项目坚持本地优先。',
          valueTerms: ['本地优先'],
        },
      ],
    },
  ]) {
    const baseCandidate = {
      subject: `${fixture.scopeKey} 项目`,
      predicate: '项目规则',
      value: fixture.expected[0].valueTerms[0],
      content: fixture.expected[0].canonical,
      negated: false,
      scopeType: 'personal',
      scopeKey: 'self',
    };
    assert.equal(
      matchExtractionCase(
        fixture,
        [baseCandidate],
        { get: () => [1, 0] },
      ).matches.length,
      0,
    );
    assert.equal(
      matchExtractionCase(
        fixture,
        [{
          ...baseCandidate,
          scopeType: 'project',
          scopeKey: fixture.scopeKey,
        }],
        { get: () => [1, 0] },
      ).matches.length,
      1,
    );
  }
});

test('precision 样本数精确等于预测正类分母', () => {
  const summary = summarizeExtractionQuality({
    positiveFacts: 100,
    matchedExpected: 90,
    trueAutoCommits: 43,
    falseAutoCommits: 1,
    credentialSaves: 0,
  });
  assert.equal(summary.autoCommitPredictions, 44);
  assert.equal(summary.extractionPrecision, 43 / 44);
  assert.equal(summary.candidateRecall, 0.9);
  assert.equal(summary.samples.extractionPrecision, 44);
  assert.equal(summary.samples.candidateRecall, 100);

  const zero = summarizeExtractionQuality({
    positiveFacts: 100,
    matchedExpected: 90,
    trueAutoCommits: 0,
    falseAutoCommits: 0,
    credentialSaves: 0,
  });
  assert.equal(zero.extractionPrecision, 0);
  assert.equal(zero.samples.extractionPrecision, 0);
});

test('auto eligibility 必须持有唯一、逐字且语义对齐的单句证据', () => {
  const turn = '界面默认使用深色模式。提交前运行测试。';
  const candidate = {
    subject: '用户',
    predicate: '界面模式',
    value: '深色模式',
    content:
      'atomic-memory-v1:' +
      '{"subject":"用户","predicate":"界面模式",' +
      '"value":"深色模式","negated":false}',
    sourceExcerpt: '界面默认使用深色模式。',
    sensitivity: 'normal',
    negated: false,
    sourceAuthority: 'direct_user',
    confidence: 0.99,
    importance: 0.8,
  };
  assert.equal(isAutoCommitEligible(candidate, turn), true);
  assert.equal(
    isAutoCommitEligible(
      {
        ...candidate,
        predicate: '航班选择',
        value: '红眼航班',
        content:
          'atomic-memory-v1:' +
          '{"subject":"用户","predicate":"航班选择",' +
          '"value":"红眼航班","negated":true}',
        sourceExcerpt: '我不会选择红眼航班。',
        negated: true,
      },
      '我不会选择红眼航班。',
    ),
    true,
  );
  assert.equal(
    isAutoCommitEligible(
      { ...candidate, sourceExcerpt: '' },
      turn,
    ),
    false,
  );
  assert.equal(
    isAutoCommitEligible(
      {
        ...candidate,
        value: '爵士乐',
        content: '用户住在上海。',
        sourceExcerpt: '用户住在上海。',
      },
      '用户住在上海。',
    ),
    false,
  );
  assert.equal(
    isAutoCommitEligible(
      {
        ...candidate,
        sourceExcerpt: '模型伪造的原始证据',
      },
      turn,
    ),
    false,
  );
  assert.equal(
    isAutoCommitEligible(
      { ...candidate, sourceExcerpt: turn },
      turn,
    ),
    false,
  );
  assert.equal(
    isAutoCommitEligible(
      {
        ...candidate,
        value: '爵士乐',
        content: '用户喜欢爵士乐。',
        sourceExcerpt: '用户住在上海。',
      },
      '用户住在上海。用户使用 VS Code。',
    ),
    false,
  );
  assert.equal(
    isAutoCommitEligible(
      {
        ...candidate,
        value: '蓝色',
        content: '用户偏好蓝色。',
        sourceExcerpt: '用户偏好蓝色。',
      },
      '用户偏好蓝色。用户偏好蓝色！',
    ),
    false,
  );
  assert.equal(
    isAutoCommitEligible(
      {
        ...candidate,
        predicate: '每周计划时间',
        value: '每周五下午做下一周计划',
        content:
          'atomic-memory-v1:' +
          '{"subject":"用户","predicate":"每周计划时间",' +
          '"value":"每周五下午做下一周计划",' +
          '"negated":false}',
        sourceExcerpt: '每周五下午做下一周计划。',
      },
      '我的日程统一按上海时区安排。上午九点前不要安排会议。' +
        '每天下午两点到四点固定作为专注时间。' +
        '每周五下午做下一周计划。',
    ),
    true,
  );
  assert.equal(
    isAutoCommitEligible(
      {
        ...candidate,
        content:
          '用户默认使用深色模式。用户的主力编辑器是 VS Code。',
        sourceExcerpt: '我默认使用深色模式。',
      },
      '我默认使用深色模式。我的主力编辑器是 VS Code。',
    ),
    false,
  );
  assert.equal(
    isAutoCommitEligible(
      {
        ...candidate,
        content:
          '用户默认使用深色模式，主力编辑器是 VS Code。',
        sourceExcerpt: '我默认使用深色模式。',
      },
      '我默认使用深色模式。我的主力编辑器是 VS Code。',
    ),
    false,
  );
  for (const content of [
    '用户默认使用深色模式，协作工具是飞书。',
    '用户默认使用深色模式、协作工具是飞书。',
    '用户默认使用深色模式；协作工具是飞书。',
    '用户默认使用深色模式协作工具飞书。',
    '用户默认使用深色模式，primary tool 是 Feishu。',
  ]) {
    assert.equal(
      isAutoCommitEligible(
        {
          ...candidate,
          content,
          sourceExcerpt: '我默认使用深色模式。',
        },
        '我默认使用深色模式。我的协作工具是飞书。',
      ),
      false,
      content,
    );
  }
});

test('auto eligibility 允许密钥安全政策但拒绝真实 secret 值', () => {
  const policy = {
    subject: '所有服务',
    predicate: '服务密钥读取规则',
    value: '所有服务密钥必须从环境变量读取',
    content:
      'atomic-memory-v1:' +
      '{"subject":"所有服务","predicate":"服务密钥读取规则",' +
      '"value":"所有服务密钥必须从环境变量读取",' +
      '"negated":false}',
    sourceExcerpt: '所有服务密钥必须从环境变量读取。',
    sensitivity: 'normal',
    negated: false,
    sourceAuthority: 'direct_user',
    confidence: 0.99,
    importance: 0.9,
  };
  assert.equal(
    isAutoCommitEligible(
      policy,
      '所有服务密钥必须从环境变量读取。',
    ),
    true,
  );
  assert.equal(
    isAutoCommitEligible(
      {
        ...policy,
        predicate: 'API Key',
        value: 'sk-live-test-1234',
        content: '用户的 API Key 是 sk-live-test-1234。',
        sourceExcerpt: 'API Key 是 sk-live-test-1234。',
      },
      'API Key 是 sk-live-test-1234。',
    ),
    false,
  );
  for (const secret of [
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature123',
    'sk-proj-abc123XYZ789',
    'token=generic-token-123456',
    'API Key: sk-proj-abc123XYZ789 must-not-log',
  ]) {
    assert.equal(
      isAutoCommitEligible(
        {
          ...policy,
          predicate: '认证材料',
          value: secret,
          content: `${secret}。`,
          sourceExcerpt: `${secret}。`,
        },
        `${secret}。`,
      ),
      false,
      `${secret} 不得计为自动提交`,
    );
  }
});

test('真实凭据通过 LifecycleStore→CandidateResolver 仍为零候选零记忆', async () => {
  const secrets = [
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature123',
    'sk-proj-abc123XYZ789',
    'token=generic-token-123456',
    'API Key: sk-proj-abc123XYZ789 must-not-log',
  ];
  const database = openDatabase(':memory:');
  try {
    const lifecycle = new LifecycleStore(database);
    const memoryStore = new MemoryStore(database);
    const resolver = new CandidateResolver(
      database,
      lifecycle,
      memoryStore,
      { mode: 'auto' },
    );
    for (const [index, secret] of secrets.entries()) {
      const sourceExcerpt = `${secret}。`;
      const turn = lifecycle.recordTurn({
        clientName: 'namespace-quality-safety',
        sessionExternalId: 'credential-safety-session',
        turnExternalId: `credential-safety-${index}`,
        role: 'user',
        content: sourceExcerpt,
      }).turn;
      const runId = lifecycle.startExtraction(
        turn.id,
        'qwen2.5:14b',
        'extract-v6',
      );
      const candidates = lifecycle.completeExtraction(runId, [
        {
          kind: 'knowledge',
          subject: '用户',
          predicate: `认证材料 ${index}`,
          value: secret,
          content: sourceExcerpt,
          confidence: 0.99,
          importance: 0.9,
          sensitivity: 'normal',
          sourceExcerpt,
          sourceAuthority: 'direct_user',
        },
      ]);
      for (const candidate of candidates) {
        await resolver.resolve(candidate.id);
      }
    }
    assert.equal(
      lifecycle.listCandidates({}).length,
      0,
    );
    assert.equal(memoryStore.list().total, 0);
  } finally {
    database.close();
  }
});

test('namespace evaluator 启动前执行真实凭据 pipeline 预检', async () => {
  assert.deepEqual(
    await runCredentialPipelinePreflight(),
    {
      passed: true,
      samples: 5,
      candidateCount: 0,
      memoryCount: 0,
    },
  );
});

test('固定 fixture 只接受已锁定的 SHA-256', () => {
  const fixturePath = fileURLToPath(
    new URL(
      '../scripts/fixtures/memory-quality-v1.json',
      import.meta.url,
    ),
  );
  const bytes = fs.readFileSync(fixturePath);
  assert.equal(parseFixedDatasetBytes(bytes).datasetSha256, FIXED_SHA);

  const tampered = JSON.parse(bytes.toString('utf8'));
  tampered.negativeCases[0].sampleCount = 9999;
  assert.throws(
    () =>
      parseFixedDatasetBytes(
        Buffer.from(JSON.stringify(tampered)),
      ),
    /固定数据集 SHA-256 不匹配/u,
  );
});

function report(passed) {
  const trueAutoCommits = passed ? 99 : 97;
  const falseAutoCommits = passed ? 1 : 3;
  return {
    passed,
    rawMetrics: {
      extractionPrecision: passed ? 0.99 : 0.97,
      candidateRecall: 0.95,
      credentialSaves: 0,
      conflictAccuracy: 1,
      semanticDuplicateRate: 0,
    },
    samples: {
      extractionPrecision: 100,
      candidateRecall: 100,
      credentialSafety: 20,
      conflictResolution: 50,
      semanticDuplicate: 100,
    },
    models: {
      extraction: 'qwen2.5:14b',
      relation: 'qwen2.5:14b',
      rerank: 'qwen2.5:14b',
      embedding: 'bge-m3:latest',
      extractorImplementation:
        MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
      qualityPipelineImplementation:
        QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
    },
    prompts: {
      extraction: 'extract-v6',
      relation: 'claim-relation-v1',
    },
    evaluatorVersion: NAMESPACE_QUALITY_EVALUATOR_VERSION,
    dataset: {
      id: 'memory-quality-v1',
      sha256: FIXED_SHA,
    },
    counts: {
      positiveFacts: 100,
      matchedExpected: 95,
      trueAutoCommits,
      falseAutoCommits,
      autoCommitPredictions:
        trueAutoCommits + falseAutoCommits,
    },
    timing: {
      completedAt: passed
        ? '2026-07-31T00:00:00.000Z'
        : '2026-07-31T01:00:00.000Z',
    },
  };
}

test('正式库的 symlink 和 hardlink 不能绕过二次确认', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-alias-'),
  );
  const formal = path.join(directory, 'memory-bridge.sqlite3');
  const symlink = path.join(directory, 'formal-link.sqlite3');
  const hardlink = path.join(directory, 'formal-hard.sqlite3');
  try {
    fs.writeFileSync(formal, '');
    fs.symlinkSync(formal, symlink);
    fs.linkSync(formal, hardlink);
    for (const alias of [symlink, hardlink]) {
      assert.throws(
        () => assertSafeRecordingTarget(alias, false, formal),
        /拒绝把质量评测快照写入默认正式数据库/u,
      );
      assert.throws(
        () => assertSafeRecordingTarget(alias, true, formal),
        /精确的默认正式数据库路径/u,
      );
    }
    assert.equal(
      assertSafeRecordingTarget(formal, true, formal),
      path.resolve(formal),
    );
    const isolated = path.join(directory, 'isolated.sqlite3');
    assert.equal(
      assertSafeRecordingTarget(isolated, false, formal),
      path.resolve(isolated),
    );
    assert.throws(
      () => assertSafeRecordingTarget(isolated, true, formal),
      /精确的默认正式数据库路径/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('默认正式库识别不依赖当前工作目录', () => {
  const alternateCwd = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-cwd-'),
  );
  const originalCwd = process.cwd();
  const formalDatabasePath = fileURLToPath(
    new URL(
      '../data/memory-bridge.sqlite3',
      import.meta.url,
    ),
  );
  try {
    process.chdir(alternateCwd);
    assert.throws(
      () =>
        assertSafeRecordingTarget(
          formalDatabasePath,
          false,
        ),
      /拒绝把质量评测快照写入默认正式数据库/u,
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(alternateCwd, { recursive: true, force: true });
  }
});

test('MEMORY_BRIDGE_DATA_DIR 指向的正式库默认拒绝写入', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-custom-data-'),
  );
  const databasePath = path.join(
    directory,
    'memory-bridge.sqlite3',
  );
  const scriptPath = fileURLToPath(
    new URL('../scripts/evaluate-namespace-quality.mjs', import.meta.url),
  );
  try {
    const child = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--record',
        '--database',
        databasePath,
        '--user',
        USER_ID,
        '--namespace',
        NAMESPACE,
      ],
      {
        cwd: os.tmpdir(),
        env: {
          ...process.env,
          MEMORY_BRIDGE_DATA_DIR: directory,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 1);
    assert.match(
      child.stderr,
      /拒绝把质量评测快照写入默认正式数据库/u,
    );
    assert.equal(fs.existsSync(databasePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('不存在的大小写别名也不能绕过正式库保护', {
  skip: !['darwin', 'win32'].includes(process.platform),
}, () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-case-'),
  );
  try {
    const formal = path.join(directory, 'Data', 'memory-bridge.sqlite3');
    const alias = path.join(directory, 'data', 'MEMORY-BRIDGE.SQLITE3');
    assert.throws(
      () => assertSafeRecordingTarget(alias, false, formal),
      /拒绝把质量评测快照写入默认正式数据库/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('quality recorder 对旧 schema fail-closed 且不迁移', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-schema-'),
  );
  const databasePath = path.join(
    directory,
    'memory-bridge.sqlite3',
  );
  try {
    const current = openDatabase(databasePath);
    current.exec(`
      CREATE TABLE evaluator_guard_sentinel (
        value TEXT NOT NULL
      );
      INSERT INTO evaluator_guard_sentinel VALUES ('keep');
      PRAGMA user_version = 23;
    `);
    current.close();

    assert.throws(
      () =>
        recordNamespaceSnapshot(
          report(true),
          {
            database: databasePath,
            user: USER_ID,
            namespace: NAMESPACE,
            allowDefaultDatabase: true,
          },
          { formalDatabasePath: databasePath },
        ),
      new RegExp(
        `schema 版本为 23.*要求 ${SCHEMA_VERSION}.*` +
          '拒绝由评测器迁移',
        'u',
      ),
    );

    const raw = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      assert.equal(
        Number(
          raw
            .prepare('PRAGMA user_version')
            .get()?.user_version,
        ),
        23,
      );
      assert.equal(
        raw
          .prepare(
            'SELECT value FROM evaluator_guard_sentinel',
          )
          .get()?.value,
        'keep',
      );
      assert.equal(
        Number(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM namespace_quality_snapshots`,
            )
            .get()?.count,
        ),
        0,
      );
    } finally {
      raw.close();
    }
    assert.equal(
      fs.existsSync(path.join(directory, 'migration-backups')),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('少于 100 个 precision 预测的伪 PASS 在写库前被拒绝', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-preflight-'),
  );
  const databasePath = path.join(
    directory,
    'memory-bridge.sqlite3',
  );
  try {
    const initialized = openDatabase(databasePath);
    initialized.close();
    const inconsistent = report(true);
    inconsistent.rawMetrics.extractionPrecision = 43 / 44;
    inconsistent.samples.extractionPrecision = 44;
    inconsistent.counts.trueAutoCommits = 43;
    inconsistent.counts.falseAutoCommits = 1;
    inconsistent.counts.autoCommitPredictions = 44;

    assert.throws(
      () =>
        recordNamespaceSnapshot(
          inconsistent,
          {
            database: databasePath,
            user: USER_ID,
            namespace: NAMESPACE,
            allowDefaultDatabase: true,
          },
          { formalDatabasePath: databasePath },
        ),
      /门禁结果与评测报告不一致/u,
    );

    const raw = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      assert.equal(
        Number(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM namespace_quality_snapshots`,
            )
            .get()?.count,
        ),
        0,
      );
      assert.equal(
        Number(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM namespace_rollout_state`,
            )
            .get()?.count,
        ),
        0,
      );
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('质量写入拒绝旧 v9 提取器实现身份', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-identity-'),
  );
  const databasePath = path.join(
    directory,
    'memory-bridge.sqlite3',
  );
  try {
    const initialized = openDatabase(databasePath);
    initialized.close();
    const stale = report(true);
    stale.models.extractorImplementation =
      'ollama-structured-memory-extractor-v9';
    assert.throws(
      () =>
        recordNamespaceSnapshot(
          stale,
          {
            database: databasePath,
            user: USER_ID,
            namespace: NAMESPACE,
            allowDefaultDatabase: true,
          },
          { formalDatabasePath: databasePath },
        ),
      /extractorImplementation 模型版本不受信任/u,
    );
    const raw = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      assert.equal(
        Number(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM namespace_quality_snapshots`,
            )
            .get()?.count,
        ),
        0,
      );
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('质量写入拒绝与当前源码不一致的流水线指纹', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-source-hash-'),
  );
  const databasePath = path.join(
    directory,
    'memory-bridge.sqlite3',
  );
  try {
    const initialized = openDatabase(databasePath);
    initialized.close();
    const stale = report(true);
    stale.models.qualityPipelineImplementation = '0'.repeat(64);
    assert.throws(
      () =>
        recordNamespaceSnapshot(
          stale,
          {
            database: databasePath,
            user: USER_ID,
            namespace: NAMESPACE,
            allowDefaultDatabase: true,
          },
          { formalDatabasePath: databasePath },
        ),
      /qualityPipelineImplementation 模型版本不受信任/u,
    );
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        Number(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM namespace_quality_snapshots`,
            )
            .get()?.count,
        ),
        0,
      );
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('质量写入拒绝旧 v10 evaluator 报告身份', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-quality-evaluator-'),
  );
  const databasePath = path.join(
    directory,
    'memory-bridge.sqlite3',
  );
  try {
    const initialized = openDatabase(databasePath);
    initialized.close();
    const stale = report(true);
    stale.evaluatorVersion = 'namespace-quality-evaluator-v10';
    assert.throws(
      () =>
        recordNamespaceSnapshot(
          stale,
          {
            database: databasePath,
            user: USER_ID,
            namespace: NAMESPACE,
            allowDefaultDatabase: true,
          },
          { formalDatabasePath: databasePath },
        ),
      /数据集或 evaluator 版本不受信任/u,
    );
    const raw = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      assert.equal(
        Number(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM namespace_quality_snapshots`,
            )
            .get()?.count,
        ),
        0,
      );
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test(
  '显式二次确认只写质量元数据，失败快照会把 auto 回退 shadow',
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-bridge-quality-recording-'),
    );
    const databasePath = path.join(
      directory,
      'data',
      'memory-bridge.sqlite3',
    );
    const options = {
      database: databasePath,
      user: USER_ID,
      namespace: NAMESPACE,
      allowDefaultDatabase: true,
    };
    try {
      const initialized = openDatabase(databasePath);
      initialized.close();
      assert.throws(
        () =>
          assertSafeRecordingTarget(
            databasePath,
            false,
            databasePath,
          ),
        /拒绝把质量评测快照写入默认正式数据库/u,
      );
      assert.equal(
        assertSafeRecordingTarget(
          databasePath,
          true,
          databasePath,
        ),
        path.resolve(databasePath),
      );

      const passed = recordNamespaceSnapshot(
        report(true),
        options,
        { formalDatabasePath: databasePath },
      );
      assert.equal(passed.snapshotPassed, true);
      assert.equal(passed.rolloutMode, 'auto');
      assert.equal(passed.qualityState, 'passed');
      assert.equal(passed.businessRowsUnchanged, true);

      const failed = recordNamespaceSnapshot(
        report(false),
        options,
        { formalDatabasePath: databasePath },
      );
      assert.equal(failed.snapshotPassed, false);
      assert.equal(failed.rolloutMode, 'shadow');
      assert.equal(failed.qualityState, 'failed');
      assert.deepEqual(failed.failedMetrics, [
        'extractionPrecision',
      ]);
      assert.equal(failed.businessRowsUnchanged, true);

      const database = openDatabase(databasePath);
      try {
        const quality = new NamespaceQualityService(database);
        const rollout = quality.effectiveAutomationMode(
          USER_ID,
          NAMESPACE,
          'auto',
        );
        assert.equal(rollout.mode, 'shadow');
        assert.equal(rollout.qualityState, 'failed');
        assert.equal(
          quality.latestSnapshot(USER_ID, NAMESPACE)?.passed,
          false,
        );
        assert.equal(
          Number(
            database
              .prepare(
                `SELECT COUNT(*) AS count
                 FROM namespace_quality_snapshots
                 WHERE user_id = ? AND namespace = ?`,
              )
              .get(USER_ID, NAMESPACE)?.count,
          ),
          2,
        );
        assert.equal(
          Number(
            database
              .prepare(
                `SELECT COUNT(*) AS count
                 FROM audit_log
                 WHERE user_id = ?
                   AND action = 'namespace_quality_evaluated'`,
              )
              .get(USER_ID)?.count,
          ),
          2,
        );
        for (const table of [
          'memories',
          'memory_items',
          'memory_versions',
          'conversation_sessions',
          'conversation_turns',
          'memory_candidates',
          'memory_evidence',
          'outbox_events',
          'memory_jobs',
        ]) {
          assert.equal(
            Number(
              database
                .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
                .get()?.count,
            ),
            0,
            `${table} 必须保持空`,
          );
        }
      } finally {
        database.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
