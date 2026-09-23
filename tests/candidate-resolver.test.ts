import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CandidateResolver,
  type CandidateResolverOptions,
  type ClaimRelationClassifier,
  classifyPredicateCardinality,
} from '../src/server/candidate-resolver.js';
import { openDatabase } from '../src/server/database.js';
import {
  LifecycleStore,
  type MemoryCandidate,
  type MemoryCandidateInput,
  type TurnRole,
} from '../src/server/lifecycle-store.js';
import { MemoryStore } from '../src/server/memory-store.js';

function createFixture(
  mode: 'off' | 'shadow' | 'auto' = 'auto',
  resolverOptions: Partial<CandidateResolverOptions> = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-resolver-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycle = new LifecycleStore(database);
  const memoryStore = new MemoryStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycle,
    memoryStore,
    {
      mode,
      autoCommitMinConfidence: 0.95,
      autoCommitMinImportance: 0.5,
      ...resolverOptions,
    },
  );
  let sequence = 0;

  return {
    database,
    lifecycle,
    memoryStore,
    resolver,
    candidate(
      turnContent: string,
      input: MemoryCandidateInput,
      role: TurnRole = 'user',
      trustedProjectId?: string,
    ): MemoryCandidate {
      sequence += 1;
      const trustedIdentity = trustedProjectId
        ? {
            personaId: 'persona-project-fixture',
            projectId: trustedProjectId,
            identitySource: 'test',
            identityStatus: 'complete' as const,
            roundId: `round-${sequence}`,
            metadata: { trustedProjectId },
          }
        : {};
      const recorded = lifecycle.recordTurn({
        clientName: 'client',
        sessionExternalId: `session-${sequence}`,
        turnExternalId: `turn-${sequence}`,
        role,
        content: turnContent,
        ...trustedIdentity,
      });
      const runId = lifecycle.startExtraction(
        recorded.turn.id,
        'qwen2.5:14b',
        'extract-v1',
      );
      return lifecycle.completeExtraction(runId, [{
        sourceExcerpt: turnContent,
        ...input,
      }])[0];
    },
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function editorCandidate(
  value: string,
  content: string,
): MemoryCandidateInput {
  return {
    kind: 'preference',
    subject: '用户',
    predicate: '主要编辑器',
    value,
    content,
    confidence: 0.98,
    importance: 0.8,
  };
}

test('shadow 模式只保留待确认候选，不污染规范记忆', async () => {
  const fixture = createFixture('shadow');
  try {
    const candidate = fixture.candidate(
      '我主要用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    const result = await fixture.resolver.resolve(candidate.id);

    assert.equal(result.state, 'pending');
    assert.equal(result.reason, 'shadow_mode');
    assert.equal(fixture.memoryStore.list().total, 0);
  } finally {
    fixture.close();
  }
});

test('auto 模式提交高置信事实并保存版本和用户原话证据', async () => {
  const fixture = createFixture();
  try {
    const candidate = fixture.candidate(
      '我主要用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    const result = await fixture.resolver.resolve(candidate.id);

    assert.equal(result.state, 'accepted');
    assert.ok(result.memoryId);
    assert.equal(fixture.memoryStore.list().total, 1);
    const item = fixture.database
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(result.memoryId!);
    assert.equal(item?.predicate_key, '用户::主要编辑器');
    assert.equal(item?.normalized_value, 'VS Code');
    assert.equal(item?.predicate_cardinality, 'single');
    const evidence = fixture.database
      .prepare(
        `SELECT excerpt
         FROM memory_evidence
         WHERE memory_version_id = ?`,
      )
      .get(item?.current_version_id);
    assert.equal(evidence?.excerpt, '我主要用 VS Code。');
    const resolution = fixture.database
      .prepare(
        `SELECT relation, method, status
         FROM candidate_resolution_runs
         WHERE candidate_id = ?`,
      )
      .get(candidate.id);
    assert.deepEqual({ ...resolution }, {
      relation: 'coexists',
      method: 'rule',
      status: 'completed',
    });
  } finally {
    fixture.close();
  }
});

test('完整链路会先规范化夹带 content，再只提交有证据的原子事实', async () => {
  const fixture = createFixture();
  try {
    const candidate = fixture.candidate(
      '我默认使用深色模式。我的协作工具是飞书。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '界面偏好',
        value: '深色模式',
        content:
          '用户默认使用深色模式。用户的协作工具是飞书。',
        confidence: 0.99,
        importance: 0.8,
        sourceExcerpt: '我默认使用深色模式。',
      },
    );

    assert.equal(
      candidate.content,
      'atomic-memory-v1:' +
        '{"subject":"用户","predicate":"界面偏好",' +
        '"value":"深色模式","negated":false}',
    );
    const result = await fixture.resolver.resolve(candidate.id);

    assert.equal(result.state, 'accepted');
    const memories = fixture.memoryStore.list();
    assert.equal(memories.total, 1);
    assert.equal(
      memories.items[0]?.content,
      'atomic-memory-v1:' +
        '{"subject":"用户","predicate":"界面偏好",' +
        '"value":"深色模式","negated":false}',
    );
    assert.doesNotMatch(memories.items[0]?.content || '', /飞书/u);
  } finally {
    fixture.close();
  }
});

test('历史或篡改候选的非原子 content 不得自动提交', async () => {
  const variants = [
    '用户默认使用深色模式。用户的协作工具是飞书。',
    '用户默认使用深色模式，协作工具是飞书。',
    '用户默认使用深色模式、协作工具是飞书。',
    '用户默认使用深色模式；协作工具是飞书。',
    '用户默认使用深色模式协作工具飞书。',
    '用户默认使用深色模式，primary tool 是 Feishu。',
  ];
  for (const content of variants) {
    const fixture = createFixture();
    try {
      const candidate = fixture.candidate(
        '我默认使用深色模式。我的协作工具是飞书。',
        {
          kind: 'preference',
          subject: '用户',
          predicate: '界面偏好',
          value: '深色模式',
          content: '用户默认使用深色模式。',
          confidence: 0.99,
          importance: 0.8,
          sourceExcerpt: '我默认使用深色模式。',
        },
      );
      fixture.database
        .prepare(
          `UPDATE memory_candidates
           SET content = ?
           WHERE id = ?`,
        )
        .run(content, candidate.id);

      const result = await fixture.resolver.resolve(candidate.id);

      assert.equal(result.state, 'pending', content);
      assert.equal(
        result.reason,
        'candidate_content_unsupported',
        content,
      );
      assert.equal(fixture.memoryStore.list().total, 0, content);
    } finally {
      fixture.close();
    }
  }
});

test('缺失、低重合、平分、伪造或跨句 sourceExcerpt 不得自动提交', async () => {
  const fixture = createFixture();
  try {
    const missing = fixture.candidate(
      '我主要用 VS Code。',
      {
        ...editorCandidate(
          'VS Code',
          '用户主要使用 VS Code。',
        ),
        sourceExcerpt: '',
      },
    );
    const lowOverlap = fixture.candidate(
      '用户住在上海。用户使用 VS Code。',
      {
        ...editorCandidate(
          'VS Code',
          '用户主要使用 VS Code。',
        ),
        sourceExcerpt: '用户住在上海。',
      },
    );
    const tiedTurn =
      '我主要用 VS Code。我主要用 VS Code！';
    const tied = fixture.candidate(
      tiedTurn,
      {
        ...editorCandidate(
          'VS Code',
          '用户主要使用 VS Code。',
        ),
        sourceExcerpt: '我主要用 VS Code。',
      },
    );
    const fabricated = fixture.candidate(
      '我主要用 VS Code。',
      {
        ...editorCandidate(
          'VS Code',
          '用户主要使用 VS Code。',
        ),
        sourceExcerpt: '模型伪造的原始证据',
      },
    );
    const fullTurn = '我主要用 VS Code。合并前必须运行测试。';
    const spanning = fixture.candidate(
      fullTurn,
      {
        ...editorCandidate(
          'VS Code',
          '用户主要使用 VS Code。',
        ),
        sourceExcerpt: fullTurn,
      },
    );
    const thirdPartyQuote = fixture.candidate(
      '我妈妈总说：‘你出生在杭州。’',
      {
        kind: 'profile',
        subject: '用户母亲',
        predicate: '出生地',
        value: '杭州',
        content: '用户出生在杭州。',
        sourceExcerpt: '你出生在杭州。',
        confidence: 0.95,
        importance: 0.8,
      },
    );

    assert.equal(missing.sourceExcerpt, null);
    assert.equal(lowOverlap.sourceExcerpt, null);
    assert.equal(tied.sourceExcerpt, null);
    assert.equal(fabricated.sourceExcerpt, null);
    assert.equal(spanning.sourceExcerpt, null);
    assert.equal(thirdPartyQuote.sourceExcerpt, null);
    for (
      const candidate of [
        missing,
        lowOverlap,
        tied,
        fabricated,
        spanning,
        thirdPartyQuote,
      ]
    ) {
      const result = await fixture.resolver.resolve(candidate.id);
      assert.equal(result.state, 'pending');
      assert.equal(result.reason, 'source_evidence_required');
    }
    assert.equal(fixture.memoryStore.list().total, 0);
  } finally {
    fixture.close();
  }
});

test('历史候选即使被写入非空伪证据也必须在解析时重新校验', async () => {
  const fixture = createFixture();
  try {
    const turn =
      '我主要用 VS Code。合并前必须运行测试。';
    const candidate = fixture.candidate(
      turn,
      {
        ...editorCandidate(
          'VS Code',
          '用户主要使用 VS Code。',
        ),
        sourceExcerpt: '我主要用 VS Code。',
      },
    );
    assert.equal(candidate.sourceExcerpt, '我主要用 VS Code。');
    fixture.database
      .prepare(
        `UPDATE memory_candidates
         SET source_excerpt = ?
         WHERE id = ?`,
      )
      .run(turn, candidate.id);

    const result = await fixture.resolver.resolve(candidate.id);
    assert.equal(result.state, 'pending');
    assert.equal(result.reason, 'source_evidence_required');
    assert.equal(fixture.memoryStore.list().total, 0);
  } finally {
    fixture.close();
  }
});

test('缺少原始 turn 的历史候选必须 fail-closed', async () => {
  const fixture = createFixture();
  try {
    const candidate = fixture.candidate(
      '我主要用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    fixture.database
      .prepare(
        `UPDATE memory_candidates
         SET turn_id = NULL
         WHERE id = ?`,
      )
      .run(candidate.id);

    const result = await fixture.resolver.resolve(candidate.id);
    assert.equal(result.state, 'pending');
    assert.equal(result.reason, 'source_evidence_required');
    assert.equal(fixture.memoryStore.list().total, 0);
  } finally {
    fixture.close();
  }
});

test('同值改写会作为等价观察增加计数且不制造新版本', async () => {
  const fixture = createFixture();
  try {
    const first = fixture.candidate(
      '我主要用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    const firstResult = await fixture.resolver.resolve(first.id);
    const second = fixture.candidate(
      '平时写代码，我的主力编辑器还是 VS Code。',
      {
        ...editorCandidate(
          'VS Code',
          '用户的主力代码编辑器是 VS Code。',
        ),
        confidence: 0.96,
      },
    );
    const secondResult = await fixture.resolver.resolve(second.id);

    assert.equal(secondResult.memoryId, firstResult.memoryId);
    assert.equal(fixture.memoryStore.list().total, 1);
    const item = fixture.database
      .prepare(
        `SELECT revision, observation_count, current_version_id
         FROM memory_items
         WHERE id = ?`,
      )
      .get(firstResult.memoryId!);
    assert.equal(item?.revision, 1);
    assert.equal(item?.observation_count, 2);
    assert.equal(
      fixture.memoryStore.get(firstResult.memoryId!)?.confidence,
      0.98,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_evidence
           WHERE memory_version_id IN (
             SELECT id FROM memory_versions WHERE memory_item_id = ?
           )`,
        )
        .get(firstResult.memoryId!)?.count,
      2,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT relation
           FROM candidate_resolution_runs
           WHERE candidate_id = ?`,
        )
        .get(second.id)?.relation,
      'equivalent',
    );
  } finally {
    fixture.close();
  }
});

test('完全等价观察只追加 evidence，不制造新版本', async () => {
  const fixture = createFixture();
  try {
    const first = fixture.candidate(
      '我主要用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    const created = await fixture.resolver.resolve(first.id);
    const second = fixture.candidate(
      '我主要用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    const equivalent = await fixture.resolver.resolve(second.id);

    assert.equal(equivalent.memoryId, created.memoryId);
    assert.equal(equivalent.relation, 'equivalent');
    const item = fixture.database
      .prepare(
        `SELECT revision, observation_count
         FROM memory_items WHERE id = ?`,
      )
      .get(created.memoryId!);
    assert.deepEqual({ ...item }, {
      revision: 1,
      observation_count: 2,
    });
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_versions WHERE memory_item_id = ?`,
        )
        .get(created.memoryId!)?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_evidence
           WHERE memory_version_id = (
             SELECT current_version_id FROM memory_items WHERE id = ?
           )`,
        )
        .get(created.memoryId!)?.count,
      2,
    );
  } finally {
    fixture.close();
  }
});

test('不同 scope、不同有效时间和有可靠证据的稳定否定可正确共存', async () => {
  const fixture = createFixture();
  try {
    const projectA = fixture.candidate(
      'A 项目现在使用 VS Code。',
      {
        ...editorCandidate('VS Code', 'A 项目使用 VS Code。'),
        scopeType: 'project',
        scopeKey: 'a',
      },
      'user',
      'a',
    );
    const projectB = fixture.candidate(
      'B 项目现在使用 Zed。',
      {
        ...editorCandidate('Zed', 'B 项目使用 Zed。'),
        scopeType: 'project',
        scopeKey: 'b',
      },
      'user',
      'b',
    );
    const historical = fixture.candidate(
      '2024 年我主要使用 Vim。',
      {
        ...editorCandidate('Vim', '用户主要使用 Vim。'),
        claimValidFrom: '2024-01-01T00:00:00.000Z',
        claimValidTo: '2025-01-01T00:00:00.000Z',
      },
    );
    const current = fixture.candidate(
      '2026 年我主要使用 Zed。',
      {
        ...editorCandidate('Zed', '用户主要使用 Zed。'),
        claimValidFrom: '2026-01-01T00:00:00.000Z',
      },
    );
    const negated = fixture.candidate(
      '我不使用 Cursor。',
      {
        ...editorCandidate('Cursor', '用户不使用 Cursor。'),
        negated: true,
      },
    );

    const results = await Promise.all([
      fixture.resolver.resolve(projectA.id),
      fixture.resolver.resolve(projectB.id),
      fixture.resolver.resolve(historical.id),
      fixture.resolver.resolve(current.id),
      fixture.resolver.resolve(negated.id),
    ]);
    assert.equal(results[0].state, 'accepted');
    assert.equal(results[1].state, 'accepted');
    assert.equal(results[2].state, 'accepted');
    assert.equal(results[3].state, 'accepted');
    assert.equal(results[3].relation, 'coexists');
    assert.equal(results[4].state, 'accepted');
    assert.equal(
      results[4].reason,
      'new_single_value',
    );
    assert.equal(fixture.memoryStore.list().total, 5);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memories WHERE negated = 1`,
        )
        .get()?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('助手推断不能覆盖用户直接陈述', async () => {
  const fixture = createFixture();
  try {
    const direct = fixture.candidate(
      '我现在主要用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    const stored = await fixture.resolver.resolve(direct.id);
    const inferred = fixture.candidate(
      '根据对话推断用户改用 Zed。',
      editorCandidate('Zed', '用户主要使用 Zed。'),
      'assistant',
    );
    const result = await fixture.resolver.resolve(inferred.id);

    assert.equal(result.state, 'pending');
    assert.equal(
      result.reason,
      'assistant_inference_requires_confirmation',
    );
    assert.match(
      fixture.memoryStore.get(stored.memoryId!)?.content || '',
      /VS Code/,
    );
  } finally {
    fixture.close();
  }
});

test('embedding 近邻经模型形成五路关系并写不可变审计', async () => {
  const relations = [
    'equivalent',
    'reinforces',
    'supersedes',
    'contradicts',
    'coexists',
  ] as const;
  for (const relation of relations) {
    let targetId: string | null = null;
    const classifier: ClaimRelationClassifier = {
      model: 'fake-qwen2.5:14b',
      promptVersion: 'relation-test-v1',
      async classify(_candidate, targets) {
        targetId = targets[0]?.id || null;
        return {
          relation,
          targetMemoryId: targetId,
          confidence: 0.99,
          rationale: `fake-${relation}`,
        };
      },
    };
    const fixture = createFixture('auto', {
      classifier,
      embeddingProvider: {
        embeddingModel: 'fake-bge-m3',
        async embed(texts) {
          return texts.map(() =>
            Float32Array.from([1, 0, 0, 0]),
          );
        },
      },
    });
    try {
      const baseline = fixture.candidate(
        '我主要使用 VS Code。',
        editorCandidate('VS Code', '用户主要使用 VS Code。'),
      );
      const baselineResult =
        await fixture.resolver.resolve(baseline.id);
      const semantic = fixture.candidate(
        relation === 'supersedes'
          ? '纠正一下，我的首要代码工具已经改用 Cursor。'
          : '我的首要代码工具现在是 Cursor。',
        {
          kind: 'preference',
          subject: '用户',
          predicate: '首要代码工具',
          value: 'Cursor',
          content: '用户首要代码工具是 Cursor。',
          confidence: 0.99,
          importance: 0.9,
        },
      );
      const result = await fixture.resolver.resolve(semantic.id);
      assert.equal(result.relation, relation);
      assert.equal(result.method, 'model');
      assert.equal(targetId, baselineResult.memoryId);
      assert.equal(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM candidate_resolution_runs
             WHERE candidate_id = ?
               AND relation = ?
               AND method = 'model'
               AND model = 'fake-qwen2.5:14b'
               AND prompt_version = 'relation-test-v1'`,
          )
          .get(semantic.id, relation)?.count,
        1,
      );
      if (relation === 'contradicts') {
        assert.equal(result.state, 'conflicted');
      } else {
        assert.equal(result.state, 'accepted');
      }
    } finally {
      fixture.close();
    }
  }
});

test('正文相似但谓词不同不得交给 14B 误判为冲突', async () => {
  let classifierCalls = 0;
  const classifier: ClaimRelationClassifier = {
    model: 'fake-qwen2.5:14b',
    promptVersion: 'relation-test-v1',
    async classify(_candidate, targets) {
      classifierCalls += 1;
      return {
        relation: 'contradicts',
        targetMemoryId: targets[0]?.id || null,
        confidence: 0.99,
        rationale: '错误地把不同属性判为冲突',
      };
    },
  };
  const fixture = createFixture('auto', {
    classifier,
    embeddingProvider: {
      embeddingModel: 'fake-bge-m3',
      async embed(texts) {
        const predicateOnly = texts.every(
          (text) => !text.startsWith('atomic-memory-v1:'),
        );
        if (!predicateOnly) {
          return texts.map(() => Float32Array.from([1, 0, 0, 0]));
        }
        return texts.map((text) =>
          text.includes('验收颜色')
            ? Float32Array.from([1, 0, 0, 0])
            : Float32Array.from([0, 1, 0, 0]),
        );
      },
    },
  });
  try {
    const baseline = fixture.candidate(
      '验收项目A的代号是青铜海燕。',
      {
        kind: 'knowledge',
        subject: '验收项目A',
        predicate: '代号',
        value: '青铜海燕',
        content: '验收项目A的代号是青铜海燕。',
        confidence: 1,
        importance: 0.95,
      },
    );
    await fixture.resolver.resolve(baseline.id);
    const color = fixture.candidate(
      '验收项目A的验收颜色是靛蓝。',
      {
        kind: 'knowledge',
        subject: '验收项目A',
        predicate: '验收颜色',
        value: '靛蓝',
        content: '验收项目A的验收颜色是靛蓝。',
        confidence: 1,
        importance: 0.95,
      },
    );

    const result = await fixture.resolver.resolve(color.id);

    assert.equal(classifierCalls, 0);
    assert.equal(result.state, 'accepted');
    assert.equal(result.relation, 'coexists');
    assert.equal(result.method, 'embedding');
    assert.equal(
      result.reason,
      'semantic_predicate_mismatch_coexists',
    );
    assert.equal(fixture.memoryStore.list().total, 2);
  } finally {
    fixture.close();
  }
});

test('相同条件标签不能让代号与发布窗口被合并', async () => {
  let classifierCalls = 0;
  const fixture = createFixture('auto', {
    classifier: {
      model: 'fake-qwen2.5:14b',
      promptVersion: 'relation-condition-label-v1',
      async classify(_candidate, targets) {
        classifierCalls += 1;
        return {
          relation: 'reinforces',
          targetMemoryId: targets[0]?.id || null,
          confidence: 0.99,
          rationale: '错误地把共享条件当成同一谓词',
        };
      },
    },
    embeddingProvider: {
      embeddingModel: 'fake-bge-m3',
      async embed(texts) {
        const predicateOnly = texts.every(
          (text) => !text.startsWith('atomic-memory-v1:'),
        );
        if (!predicateOnly) {
          return texts.map(() => Float32Array.from([1, 0, 0, 0]));
        }
        return texts.map((text) =>
          text.includes('[条件:晚上]') || text.includes('代号')
            ? Float32Array.from([1, 0, 0, 0])
            : Float32Array.from([0, 1, 0, 0]),
        );
      },
    },
  });
  try {
    const code = fixture.candidate(
      '晨舟项目代号是赤狐42。',
      {
        kind: 'project',
        subject: '晨舟项目',
        predicate: '代号 [条件:晚上]',
        value: '赤狐42',
        content: '晨舟项目代号是赤狐42。',
        confidence: 1,
        importance: 0.95,
        scopeType: 'project',
        scopeKey: '晨舟项目',
      },
      'user',
      'project-morningboat',
    );
    await fixture.resolver.resolve(code.id);
    const window = fixture.candidate(
      '固定发布窗口是星期三晚上九点。',
      {
        kind: 'project',
        subject: '晨舟项目',
        predicate: '固定发布窗口 [条件:晚上]',
        value: '星期三晚上九点',
        content: '晨舟项目固定发布窗口是星期三晚上九点。',
        confidence: 1,
        importance: 0.95,
        scopeType: 'project',
        scopeKey: '晨舟项目',
      },
      'user',
      'project-morningboat',
    );

    const result = await fixture.resolver.resolve(window.id);

    assert.equal(classifierCalls, 0);
    assert.equal(result.state, 'accepted');
    assert.equal(result.relation, 'coexists');
    assert.equal(result.reason, 'semantic_predicate_mismatch_coexists');
    assert.equal(fixture.memoryStore.list().total, 2);
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT predicate_key
           FROM memory_items
           ORDER BY predicate_key`,
        )
        .all()
        .map((row) => row.predicate_key),
      [
        '晨舟项目::代号 [条件:晚上]',
        '晨舟项目::固定发布窗口 [条件:晚上]',
      ],
    );
  } finally {
    fixture.close();
  }
});

test('非显式语义 supersedes 不得静默覆盖当前值', async () => {
  const classifier: ClaimRelationClassifier = {
    model: 'fake-qwen2.5:14b',
    promptVersion: 'relation-test-v1',
    async classify(_candidate, targets) {
      return {
        relation: 'supersedes',
        targetMemoryId: targets[0]?.id || null,
        confidence: 0.99,
        rationale: '模型认为新工具替代旧工具',
      };
    },
  };
  const fixture = createFixture('auto', {
    classifier,
    embeddingProvider: {
      embeddingModel: 'fake-bge-m3',
      async embed(texts) {
        return texts.map(() =>
          Float32Array.from([1, 0, 0, 0]),
        );
      },
    },
  });
  try {
    const baseline = fixture.candidate(
      '我主要使用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    const stored = await fixture.resolver.resolve(baseline.id);
    const semantic = fixture.candidate(
      'Cursor 也看起来不错。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '首要代码工具',
        value: 'Cursor',
        content: '用户首要代码工具是 Cursor。',
        confidence: 0.99,
        importance: 0.9,
      },
    );

    assert.equal(semantic.explicitCorrection, false);
    const result = await fixture.resolver.resolve(semantic.id);

    assert.equal(result.state, 'conflicted');
    assert.equal(result.relation, 'contradicts');
    assert.equal(
      result.reason,
      'classified_supersession_requires_confirmation',
    );
    assert.match(
      fixture.memoryStore.get(stored.memoryId!)?.content || '',
      /VS Code/,
    );
    assert.equal(fixture.memoryStore.list().total, 1);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_versions
           WHERE memory_item_id = ?`,
        )
        .get(stored.memoryId!)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('确定且更晚的开放有效期可规则化替代旧当前值', async () => {
  const fixture = createFixture();
  try {
    const oldCurrent = fixture.candidate(
      '从 2024 年开始，我的主要编辑器是 VS Code。',
      {
        ...editorCandidate('VS Code', '用户主要使用 VS Code。'),
        claimValidFrom: '2024-01-01T00:00:00.000Z',
      },
    );
    const stored = await fixture.resolver.resolve(oldCurrent.id);
    const newCurrent = fixture.candidate(
      '从 2026 年开始，我的主要编辑器是 Zed。',
      {
        ...editorCandidate('Zed', '用户主要使用 Zed。'),
        claimValidFrom: '2026-01-01T00:00:00.000Z',
      },
    );

    assert.equal(newCurrent.explicitCorrection, false);
    const result = await fixture.resolver.resolve(newCurrent.id);

    assert.equal(result.state, 'accepted');
    assert.equal(result.relation, 'supersedes');
    assert.equal(result.reason, 'deterministic_temporal_supersession');
    assert.equal(result.memoryId, stored.memoryId);
    assert.match(
      fixture.memoryStore.get(stored.memoryId!)?.content || '',
      /Zed/,
    );
  } finally {
    fixture.close();
  }
});

test('第 129 条旧同谓词事实仍参与精确去重', async () => {
  const fixture = createFixture();
  try {
    const candidate = fixture.candidate(
      '我会 LegacyLang。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '掌握的编程语言',
        value: 'LegacyLang',
        content: '用户会 LegacyLang。',
        confidence: 0.99,
        importance: 0.8,
      },
    );
    const target = fixture.memoryStore.remember({
      kind: 'preference',
      content: candidate.content,
      stableKey: `${candidate.stableKey}::set::target`,
      predicateKey: candidate.normalizedKey,
      normalizedValueHash: candidate.normalizedHash,
      normalizedValue: candidate.value,
      predicateCardinality: 'set',
      sourceAuthority: 'direct_user',
    }).memory;
    for (let index = 0; index < 128; index += 1) {
      fixture.memoryStore.remember({
        kind: 'preference',
        content: `用户会 NoiseLang-${index}。`,
        stableKey: `${candidate.stableKey}::set::noise-${index}`,
        predicateKey: candidate.normalizedKey,
        normalizedValueHash: `noise-hash-${index}`,
        normalizedValue: `NoiseLang-${index}`,
        predicateCardinality: 'set',
        sourceAuthority: 'direct_user',
      });
    }
    fixture.database
      .prepare(
        `UPDATE memory_items
         SET updated_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`,
      )
      .run(target.id);

    const assessment = await fixture.resolver.assessClaim(
      candidate,
      { cardinality: 'set' },
    );

    assert.equal(assessment.relatedTargets.length, 129);
    assert.equal(assessment.relation, 'equivalent');
    assert.equal(assessment.targetMemoryId, target.id);
  } finally {
    fixture.close();
  }
});

test('超过 1000 条时按真实相似度排序并把最旧 nearest 送入模型', async () => {
  let nearestId: string | null = null;
  let classifiedTargetIds: string[] = [];
  const classifier: ClaimRelationClassifier = {
    model: 'fake-qwen2.5:14b',
    promptVersion: 'relation-test-v1',
    async classify(_candidate, targets) {
      classifiedTargetIds = targets.map((target) => target.id);
      return {
        relation: 'equivalent',
        targetMemoryId: targets[0]?.id || null,
        confidence: 0.99,
        rationale: '首个目标是真实语义近邻',
      };
    },
  };
  const fixture = createFixture('auto', {
    classifier,
    embeddingProvider: {
      embeddingModel: 'fake-bge-m3',
      async embed(texts) {
        return texts.map((text) =>
          text.includes('全库语义锚点')
            ? Float32Array.from([1, 0, 0, 0])
            : Float32Array.from([0, 1, 0, 0]),
        );
      },
    },
  });
  try {
    const candidate = fixture.candidate(
      '这条候选对应全库语义锚点。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '长期研发约束',
        value: '全库语义锚点',
        content: '用户的长期研发约束是全库语义锚点。',
        confidence: 0.99,
        importance: 0.9,
      },
    );
    const nearest = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户的工程原则是全库语义锚点。',
      stableKey: 'personal::self::用户::工程原则',
      predicateKey: '用户::工程原则',
      normalizedValueHash: 'nearest-old-hash',
      normalizedValue: '全库语义锚点',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    nearestId = nearest.id;
    for (let index = 0; index < 1_001; index += 1) {
      fixture.memoryStore.remember({
        kind: 'preference',
        content: `用户的一般偏好噪声 ${index}。`,
        stableKey: `personal::self::用户::一般偏好噪声-${index}`,
        predicateKey: `用户::一般偏好噪声-${index}`,
        normalizedValueHash: `semantic-noise-${index}`,
        normalizedValue: `噪声-${index}`,
        predicateCardinality: 'single',
        sourceAuthority: 'direct_user',
      });
    }
    fixture.database
      .prepare(
        `UPDATE memory_items
         SET updated_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`,
      )
      .run(nearest.id);

    const assessment = await fixture.resolver.assessClaim(candidate);

    assert.equal(assessment.relatedTargets.length, 1_002);
    assert.equal(assessment.relation, 'equivalent');
    assert.equal(assessment.targetMemoryId, nearest.id);
    assert.equal(classifiedTargetIds.length, 12);
    assert.equal(classifiedTargetIds[0], nearestId);
    assert.ok(classifiedTargetIds.includes(nearest.id));
  } finally {
    fixture.close();
  }
});

test('单值属性冲突不静默覆盖，明确纠正才追加新版本', async () => {
  const fixture = createFixture();
  try {
    const first = fixture.candidate(
      '我主要用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    const firstResult = await fixture.resolver.resolve(first.id);

    const conflict = fixture.candidate(
      'Zed 看起来也不错。',
      editorCandidate('Zed', '用户主要使用 Zed。'),
    );
    const conflictResult = await fixture.resolver.resolve(conflict.id);
    assert.equal(conflictResult.state, 'conflicted');
    assert.match(
      fixture.memoryStore.get(firstResult.memoryId!)?.content || '',
      /VS Code/,
    );

    const correction = fixture.candidate(
      '纠正一下，我的主要编辑器已经改成 Zed。',
      editorCandidate('Zed', '用户主要使用 Zed。'),
    );
    assert.equal(correction.explicitCorrection, true);
    const corrected = await fixture.resolver.resolve(correction.id);
    assert.equal(corrected.state, 'accepted');
    assert.equal(corrected.memoryId, firstResult.memoryId);
    assert.match(
      fixture.memoryStore.get(firstResult.memoryId!)?.content || '',
      /Zed/,
    );
    const versions = fixture.database
      .prepare(
        `SELECT id, version, superseded_at
         FROM memory_versions
         WHERE memory_item_id = ?
         ORDER BY version`,
      )
      .all(firstResult.memoryId!);
    assert.equal(versions.length, 2);
    assert.ok(versions[0]?.superseded_at);
    assert.equal(versions[1]?.superseded_at, null);

    const reverted = fixture.memoryStore.revertToVersion(
      firstResult.memoryId!,
      String(versions[0]?.id),
    );
    assert.match(reverted.content, /VS Code/);
    const afterRevert = fixture.database
      .prepare(
        `SELECT version, created_by, normalized_value, superseded_at
         FROM memory_versions
         WHERE memory_item_id = ?
         ORDER BY version`,
      )
      .all(firstResult.memoryId!);
    assert.equal(afterRevert.length, 3);
    assert.equal(afterRevert[1]?.superseded_at !== null, true);
    assert.equal(afterRevert[2]?.created_by, 'user-revert');
    assert.equal(afterRevert[2]?.normalized_value, 'VS Code');
  } finally {
    fixture.close();
  }
});

test('同 stable_key 的单值记忆即使 kind 漂移也沿用原版本链', async () => {
  const fixture = createFixture();
  try {
    const baseline = fixture.candidate(
      '我的常用编辑器是 Visual Studio Code。',
      {
        kind: 'knowledge',
        subject: '用户',
        predicate: '常用编辑器',
        value: 'Visual Studio Code',
        content: '用户的常用编辑器是 Visual Studio Code。',
        confidence: 0.99,
        importance: 0.8,
        scopeType: 'role',
        scopeKey: 'persona-project-fixture',
      },
      'user',
      'editor-project',
    );
    const stored = await fixture.resolver.resolve(baseline.id);
    const correction = fixture.candidate(
      '纠正一下，我的常用编辑器已经改成 Neovim。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '常用编辑器',
        value: 'Neovim',
        content: '用户的常用编辑器是 Neovim。',
        confidence: 0.99,
        importance: 0.9,
        scopeType: 'role',
        scopeKey: 'persona-project-fixture',
      },
      'user',
      'editor-project',
    );

    assert.equal(correction.explicitCorrection, true);
    assert.equal(correction.stableKey, baseline.stableKey);
    const corrected = await fixture.resolver.resolve(correction.id);

    assert.equal(corrected.state, 'accepted');
    assert.equal(corrected.relation, 'supersedes');
    assert.equal(corrected.reason, 'explicit_correction');
    assert.equal(corrected.memoryId, stored.memoryId);
    assert.deepEqual(
      { ...fixture.database.prepare(
        `SELECT m.kind AS memory_kind, i.kind AS item_kind,
                i.revision, i.normalized_value
         FROM memory_items i
         JOIN memories m ON m.id = i.id
         WHERE i.id = ?`,
      ).get(stored.memoryId!) },
      {
        memory_kind: 'knowledge',
        item_kind: 'knowledge',
        revision: 2,
        normalized_value: 'Neovim',
      },
    );
    const versions = fixture.database.prepare(
      `SELECT version, superseded_at
       FROM memory_versions
       WHERE memory_item_id = ?
       ORDER BY version`,
    ).all(stored.memoryId!);
    assert.equal(versions.length, 2);
    assert.ok(versions[0]?.superseded_at);
    assert.equal(versions[1]?.superseded_at, null);
  } finally {
    fixture.close();
  }
});

test('显式纠正可唯一修复 event 和时间 stable_key 漂移', async () => {
  const fixture = createFixture();
  try {
    const baseline = fixture.candidate(
      '2026年1月起，我常用的编辑器是 Visual Studio Code。',
      {
        kind: 'event',
        subject: '用户',
        predicate: '常用编辑器',
        value: 'Visual Studio Code',
        content: '用户的常用编辑器是 Visual Studio Code。',
        confidence: 0.99,
        importance: 0.8,
        claimValidFrom: '2026-01-01T00:00:00.000Z',
      },
    );
    const stored = await fixture.resolver.resolve(baseline.id);
    const storedItem = fixture.database.prepare(
      `SELECT stable_key FROM memory_items WHERE id = ?`,
    ).get(stored.memoryId!);
    assert.match(String(storedItem?.stable_key), /::time::/u);

    const correction = fixture.candidate(
      '更正一下，我的常用编辑器已经改成 Neovim，' +
        '之前的 Visual Studio Code 不用了。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '常用编辑器',
        value: 'Neovim',
        content: '用户的常用编辑器是 Neovim。',
        confidence: 0.99,
        importance: 0.9,
      },
    );
    assert.equal(correction.explicitCorrection, true);

    const corrected = await fixture.resolver.resolve(correction.id);

    assert.equal(corrected.state, 'accepted');
    assert.equal(corrected.relation, 'supersedes');
    assert.equal(corrected.reason, 'explicit_correction');
    assert.equal(corrected.memoryId, stored.memoryId);
    assert.deepEqual(
      { ...fixture.database.prepare(
        `SELECT revision, normalized_value
         FROM memory_items WHERE id = ?`,
      ).get(stored.memoryId!) },
      { revision: 2, normalized_value: 'Neovim' },
    );
    const versions = fixture.database.prepare(
      `SELECT version, superseded_at
       FROM memory_versions
       WHERE memory_item_id = ?
       ORDER BY version`,
    ).all(stored.memoryId!);
    assert.equal(versions.length, 2);
    assert.ok(versions[0]?.superseded_at);
    assert.equal(versions[1]?.superseded_at, null);
  } finally {
    fixture.close();
  }
});

test('显式纠正遇到多个历史 event 时间目标时 fail closed', async () => {
  const fixture = createFixture();
  try {
    const first = fixture.candidate(
      '2026年1月起，我常用的编辑器是 Visual Studio Code。',
      {
        kind: 'event',
        subject: '用户',
        predicate: '常用编辑器',
        value: 'Visual Studio Code',
        content: '用户的常用编辑器是 Visual Studio Code。',
        confidence: 0.99,
        importance: 0.8,
        claimValidFrom: '2026-01-01T00:00:00.000Z',
      },
    );
    const second = fixture.candidate(
      '2026年2月起，我常用的编辑器是 Zed。',
      {
        kind: 'event',
        subject: '用户',
        predicate: '常用编辑器',
        value: 'Zed',
        content: '用户的常用编辑器是 Zed。',
        confidence: 0.99,
        importance: 0.8,
        claimValidFrom: '2026-02-01T00:00:00.000Z',
      },
    );
    const firstTarget = fixture.memoryStore.remember({
      kind: 'event',
      content: first.content,
      stableKey: `${first.stableKey}::time::legacy-first`,
      predicateKey: first.normalizedKey,
      normalizedValueHash: first.normalizedHash,
      normalizedValue: first.value,
      predicateCardinality: 'event',
      validFrom: first.claimValidFrom || undefined,
      sourceAuthority: 'direct_user',
    }).memory;
    const secondTarget = fixture.memoryStore.remember({
      kind: 'event',
      content: second.content,
      stableKey: `${second.stableKey}::time::legacy-second`,
      predicateKey: second.normalizedKey,
      normalizedValueHash: second.normalizedHash,
      normalizedValue: second.value,
      predicateCardinality: 'event',
      validFrom: second.claimValidFrom || undefined,
      sourceAuthority: 'direct_user',
    }).memory;
    assert.notEqual(firstTarget.id, secondTarget.id);

    const correction = fixture.candidate(
      '更正一下，我的常用编辑器已经改成 Helix。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '常用编辑器',
        value: 'Helix',
        content: '用户的常用编辑器是 Helix。',
        confidence: 0.99,
        importance: 0.9,
      },
    );
    assert.equal(correction.explicitCorrection, true);

    const result = await fixture.resolver.resolve(correction.id);

    assert.equal(result.state, 'conflicted');
    assert.equal(result.reason, 'explicit_correction_target_ambiguous');
    assert.equal(result.memoryId, null);
    assert.equal(result.relation, 'contradicts');
    assert.equal(fixture.memoryStore.list().total, 2);
    const revisions = fixture.database.prepare(
      `SELECT revision FROM memory_items ORDER BY id`,
    ).all();
    assert.deepEqual(revisions.map((row) => row.revision), [1, 1]);
  } finally {
    fixture.close();
  }
});

test('同 stable_key 的结构不兼容或跨 scope 目标必须安全冲突', async () => {
  for (const mismatch of ['cardinality', 'scope'] as const) {
    const fixture = createFixture();
    try {
      const candidate = fixture.candidate(
        '纠正一下，我的常用编辑器已经改成 Neovim。',
        {
          kind: 'preference',
          subject: '用户',
          predicate: '常用编辑器',
          value: 'Neovim',
          content: '用户的常用编辑器是 Neovim。',
          confidence: 0.99,
          importance: 0.9,
        },
      );
      const target = fixture.memoryStore.remember({
        kind: mismatch === 'cardinality' ? 'event' : 'preference',
        content: '用户的常用编辑器是 Visual Studio Code。',
        stableKey: candidate.stableKey,
        predicateKey: candidate.normalizedKey,
        normalizedValueHash: 'visual-studio-code',
        normalizedValue: 'Visual Studio Code',
        predicateCardinality:
          mismatch === 'cardinality' ? 'event' : 'single',
        scopeType: mismatch === 'scope' ? 'role' : 'personal',
        scopeKey: mismatch === 'scope' ? 'other-role' : 'self',
        sourceAuthority: 'direct_user',
      }).memory;

      const result = await fixture.resolver.resolve(candidate.id);

      assert.equal(result.state, 'conflicted', mismatch);
      assert.equal(
        result.reason,
        'canonical_identity_incompatible',
        mismatch,
      );
      assert.equal(result.memoryId, null, mismatch);
      assert.equal(result.relation, 'contradicts', mismatch);
      assert.equal(result.method, 'rule', mismatch);
      assert.match(
        fixture.memoryStore.get(target.id)?.content || '',
        /Visual Studio Code/u,
        mismatch,
      );
      assert.equal(
        fixture.database.prepare(
          'SELECT COUNT(*) AS count FROM memory_items',
        ).get()?.count,
        1,
        mismatch,
      );
    } finally {
      fixture.close();
    }
  }
});

test('多值谓词允许共存，tombstone 阻止旧证据复活', async () => {
  const fixture = createFixture();
  try {
    assert.equal(
      classifyPredicateCardinality('preference', '掌握的编程语言'),
      'set',
    );
    const typescript = fixture.candidate(
      '我会 TypeScript。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '掌握的编程语言',
        value: 'TypeScript',
        content: '用户会 TypeScript。',
        confidence: 0.99,
        importance: 0.8,
      },
    );
    const python = fixture.candidate(
      '我也会 Python。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '掌握的编程语言',
        value: 'Python',
        content: '用户会 Python。',
        confidence: 0.99,
        importance: 0.8,
      },
    );
    const first = await fixture.resolver.resolve(typescript.id);
    const second = await fixture.resolver.resolve(python.id);
    assert.equal(first.state, 'accepted');
    assert.equal(second.state, 'accepted');
    assert.notEqual(first.memoryId, second.memoryId);
    assert.equal(fixture.memoryStore.list().total, 2);

    fixture.memoryStore.forget(first.memoryId!);
    const replay = fixture.candidate(
      '我会 TypeScript。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '掌握的编程语言',
        value: 'TypeScript',
        content: '用户会 TypeScript。',
        confidence: 0.99,
        importance: 0.8,
      },
    );
    const blocked = await fixture.resolver.resolve(replay.id);
    assert.equal(blocked.state, 'rejected');
    assert.equal(blocked.reason, 'tombstone_blocked');
    assert.equal(fixture.memoryStore.list().total, 1);
  } finally {
    fixture.close();
  }
});

test('明确停止同值集合习惯会关闭旧肯定版本而不是创建并存记忆', async () => {
  const fixture = createFixture();
  try {
    const running = fixture.candidate(
      '我每天早晨跑步。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '稳定生活习惯',
        value: '早晨跑步',
        content: '用户早晨跑步。',
        confidence: 0.99,
        importance: 0.8,
      },
    );
    const stored = await fixture.resolver.resolve(running.id);
    const stopped = fixture.candidate(
      '我不再早晨跑步。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '稳定生活习惯',
        value: '早晨跑步',
        content: '用户不再早晨跑步。',
        confidence: 0.99,
        importance: 0.8,
        negated: true,
      },
    );

    assert.equal(stopped.explicitCorrection, true);
    const result = await fixture.resolver.resolve(stopped.id);

    assert.equal(result.state, 'accepted');
    assert.equal(result.relation, 'supersedes');
    assert.equal(result.memoryId, stored.memoryId);
    assert.equal(fixture.memoryStore.list().total, 1);
    const versions = fixture.database
      .prepare(
        `SELECT version, negated, superseded_at
         FROM memory_versions
         WHERE memory_item_id = ?
         ORDER BY version`,
      )
      .all(stored.memoryId!);
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.negated, 0);
    assert.ok(versions[0]?.superseded_at);
    assert.equal(versions[1]?.negated, 1);
    assert.equal(versions[1]?.superseded_at, null);
  } finally {
    fixture.close();
  }
});

test('同一发生时间的不同集合习惯使用不同稳定键且都能持久化', async () => {
  const fixture = createFixture();
  try {
    const occurredAt = '2026-08-31T07:30:00.000Z';
    const running = fixture.candidate(
      '今天的记录：早晨跑步。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '稳定生活习惯',
        value: '早晨跑步',
        content: '用户早晨跑步。',
        confidence: 0.99,
        importance: 0.8,
        claimOccurredAt: occurredAt,
      },
    );
    const reading = fixture.candidate(
      '今天的记录：晚上阅读。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '稳定生活习惯',
        value: '晚上阅读',
        content: '用户晚上阅读。',
        confidence: 0.99,
        importance: 0.8,
        claimOccurredAt: occurredAt,
      },
    );

    const first = await fixture.resolver.resolve(running.id);
    const second = await fixture.resolver.resolve(reading.id);

    assert.equal(first.state, 'accepted');
    assert.equal(second.state, 'accepted');
    assert.notEqual(first.memoryId, second.memoryId);
    assert.equal(fixture.memoryStore.list().total, 2);
    const keys = fixture.database
      .prepare(
        `SELECT stable_key
         FROM memory_items
         WHERE id IN (?, ?)
         ORDER BY id`,
      )
      .all(first.memoryId!, second.memoryId!)
      .map((row) => String(row.stable_key));
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  } finally {
    fixture.close();
  }
});

test('tombstone 阻止同义旧值但不误杀同谓词的新值', async () => {
  const fixture = createFixture();
  try {
    const original = fixture.candidate(
      '我做的软件第一次启动不能内置演示数据。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '软件首次打开数据要求',
        value: '第一次启动不能内置演示数据',
        content: '用户要求软件第一次启动不能内置演示数据。',
        confidence: 0.99,
        importance: 0.9,
      },
    );
    const accepted = await fixture.resolver.resolve(original.id);
    fixture.memoryStore.forget(accepted.memoryId!);

    const paraphrase = fixture.candidate(
      '首次打开必须为空数据，也不放任何演示内容。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '软件首次打开数据要求',
        value: '首次打开必须为空数据，不放演示内容',
        content: '用户要求软件首次打开为空数据且不放演示内容。',
        confidence: 0.99,
        importance: 0.9,
      },
    );
    const blocked = await fixture.resolver.resolve(paraphrase.id);
    assert.equal(blocked.state, 'rejected');
    assert.equal(blocked.reason, 'tombstone_blocked');

    const replacement = fixture.candidate(
      '现在改为首次打开自动导入一套最小示例数据。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '软件首次打开数据要求',
        value: '自动导入一套最小示例数据',
        content: '用户要求软件首次打开自动导入最小示例数据。',
        confidence: 0.99,
        importance: 0.9,
      },
    );
    const allowed = await fixture.resolver.resolve(replacement.id);
    assert.equal(allowed.state, 'accepted');
    assert.ok(allowed.memoryId);
    assert.match(
      fixture.memoryStore.get(allowed.memoryId!)?.content || '',
      /自动导入/,
    );
  } finally {
    fixture.close();
  }
});

test('关系模型运行期间新增 tombstone 会在提交前再次阻断', async () => {
  let rejectDuringClassification: (() => void) | null = null;
  const classifier: ClaimRelationClassifier = {
    model: 'fake-qwen2.5:14b',
    promptVersion: 'relation-tombstone-race-v1',
    async classify(_candidate, targets) {
      rejectDuringClassification?.();
      return {
        relation: 'equivalent',
        targetMemoryId: targets[0]?.id || null,
        confidence: 0.99,
        rationale: '测试关系评估后的 tombstone 复查',
      };
    },
  };
  const fixture = createFixture('auto', {
    classifier,
    embeddingProvider: {
      embeddingModel: 'fake-bge-m3',
      async embed(texts) {
        return texts.map(() => Float32Array.from([1, 0, 0, 0]));
      },
    },
  });
  try {
    fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户偏好安静的工作环境。',
      stableKey: 'personal::self::用户::工作环境',
      predicateKey: '用户::工作环境',
      normalizedValue: '安静',
      normalizedValueHash: 'quiet-workspace',
    });
    const candidate = fixture.candidate(
      '软件第一次打开不应内置演示数据。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '软件首次打开数据要求',
        value: '不内置演示数据',
        content: '用户要求软件首次打开不内置演示数据。',
        confidence: 0.99,
        importance: 0.9,
      },
    );
    const blocker = fixture.candidate(
      '不要再记软件首次打开不带演示数据这项要求。',
      {
        kind: 'preference',
        subject: '用户',
        predicate: '软件首次打开数据要求',
        value: '不内置演示数据',
        content: '用户要求软件首次打开不内置演示数据。',
        confidence: 0.99,
        importance: 0.9,
      },
    );
    rejectDuringClassification = () => {
      fixture.resolver.rejectForReview(blocker.id, true);
      rejectDuringClassification = null;
    };

    const result = await fixture.resolver.resolve(candidate.id);
    assert.equal(result.state, 'rejected');
    assert.equal(result.reason, 'tombstone_blocked');
    assert.equal(fixture.memoryStore.list().total, 1);
  } finally {
    fixture.close();
  }
});

test('敏感、低置信和低价值候选不会自动提交', async () => {
  const fixture = createFixture();
  try {
    const cases: Array<{
      input: MemoryCandidateInput;
      reason: string;
    }> = [
      {
        input: {
          ...editorCandidate('VS Code', '用户主要使用 VS Code。'),
          sensitivity: 'sensitive',
        },
        reason: 'sensitive_requires_confirmation',
      },
      {
        input: {
          ...editorCandidate('Zed', '用户主要使用 Zed。'),
          confidence: 0.8,
        },
        reason: 'confidence_below_auto_commit_threshold',
      },
      {
        input: {
          ...editorCandidate('Vim', '用户主要使用 Vim。'),
          importance: 0.2,
        },
        reason: 'importance_below_auto_commit_threshold',
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const candidate = fixture.candidate(
        `我主要使用 ${entry.input.value}。`,
        entry.input,
      );
      const result = await fixture.resolver.resolve(candidate.id);
      assert.equal(result.state, 'pending');
      assert.equal(result.reason, entry.reason);
    }
    assert.equal(fixture.memoryStore.list().total, 0);
  } finally {
    fixture.close();
  }
});

test('人工审核可修正冲突候选或写入禁止再记 tombstone', async () => {
  const fixture = createFixture();
  try {
    const first = fixture.candidate(
      '我主要用 VS Code。',
      editorCandidate('VS Code', '用户主要使用 VS Code。'),
    );
    const firstResult = await fixture.resolver.resolve(first.id);
    const conflict = fixture.candidate(
      'Zed 看起来也不错。',
      editorCandidate('Zed', '用户主要使用 Zed。'),
    );
    assert.equal(
      (await fixture.resolver.resolve(conflict.id)).state,
      'conflicted',
    );

    const reviewed = fixture.resolver.acceptForReview(
      conflict.id,
      {
        value: 'Zed',
        content: '用户经人工确认主要使用 Zed。',
      },
    );
    assert.equal(reviewed.state, 'accepted');
    assert.equal(reviewed.reason, 'manual_review_corrected');
    assert.equal(reviewed.memoryId, firstResult.memoryId);
    assert.match(
      fixture.memoryStore.get(reviewed.memoryId!)?.content || '',
      /人工确认主要使用 Zed/,
    );

    const rejected = fixture.candidate(
      '这条候选以后不要再记。',
      {
        kind: 'knowledge',
        subject: '用户',
        predicate: '不应保存的测试事实',
        value: '拒绝值',
        content: '用户有一条不应保存的测试事实。',
        confidence: 0.8,
        importance: 0.5,
      },
    );
    const rejection = fixture.resolver.rejectForReview(
      rejected.id,
      true,
    );
    assert.equal(rejection.state, 'rejected');
    assert.equal(
      rejection.reason,
      'manual_rejected_and_tombstoned',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE user_id = 'default'
             AND namespace = 'personal'
             AND restored_at IS NULL`,
        )
        .get()?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});
