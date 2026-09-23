import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  authorizeEquivalentPersonalMemoryIds,
  assessExtractionConvergence,
  assessGroundedAnswerSample,
  assessOrdinaryDailyQuestionExtraction,
  assessProductionEvidenceReadiness,
  assessReflectionCandidateQuality,
  assessSchema37Acceptance,
  buildScenarios,
  computeTimelineMetrics,
  computeRetrievalMetrics,
  createSchema37DeterministicRanker,
  drainReflectionQaWindows,
  evaluateQueryResultLayers,
  evaluateTimelineResultOrder,
  extractRerankTraceEvidence,
  fillerContent,
  learnedMemoryQueryCases,
  modelPreflight,
  parseConfig,
  passesNaturalCorpusQuality,
  passesReliableRetrievalThresholds,
  RELIABLE_RECALL_P95_LIMIT_MS,
  productionCorrectionPathSnapshot,
  runSchema37DeterministicSmoke,
  schema37DrainIdleDecision,
  SCHEMA37_ACCEPTANCE_THRESHOLDS,
  settleReflectionQaSample,
  summarizeNaturalCorpus,
} from '../scripts/qa-natural-conversation-quality.mjs';
import {
  extractionTargetDisposition,
} from '../dist/server/memory-extractor.js';

test('自然对话门禁把到期 pending 提取任务视为失败', () => {
  const passing = {
    expectedUserTurns: 1_000,
    extractionJobCount: 1_000,
    completedExtractionJobs: 1_000,
    dueExtractionJobs: 0,
    unhealthyExtractionJobs: 0,
    openResolutionJobs: 0,
    completedExtractionRuns: 1_000,
    nonCompletedExtractionRuns: 0,
    coveredUserTurns: 1_000,
    turnCoverageRate: 1,
  };
  assert.deepEqual(assessExtractionConvergence(passing), {
    passed: true,
    failures: [],
  });
  assert.deepEqual(assessExtractionConvergence({
    ...passing,
    completedExtractionJobs: 999,
    dueExtractionJobs: 1,
    completedExtractionRuns: 999,
    coveredUserTurns: 999,
    turnCoverageRate: 0.999,
  }), {
    passed: false,
    failures: [
      'completed_extraction_run_per_user_turn',
      'all_extraction_jobs_completed',
      'due_extraction_jobs',
    ],
  });
});

test('普通日常问句必须有样本且不能生成任何原子长期记忆', () => {
  assert.deepEqual(assessOrdinaryDailyQuestionExtraction({
    ordinaryDailyQuestionCount: 28,
    ordinaryDailyQuestionCandidateCount: 0,
  }), {
    ordinaryDailyQuestionCount: 28,
    ordinaryDailyQuestionCandidateCount: 0,
    passed: true,
  });
  assert.equal(assessOrdinaryDailyQuestionExtraction({
    ordinaryDailyQuestionCount: 28,
    ordinaryDailyQuestionCandidateCount: 1,
  }).passed, false);
  assert.equal(assessOrdinaryDailyQuestionExtraction({
    ordinaryDailyQuestionCount: 0,
    ordinaryDailyQuestionCandidateCount: 0,
  }).passed, false);
});

test('grounded answer 正例只允许目标值，无证据问题必须回答不知道', () => {
  assert.equal(assessGroundedAnswerSample({
    answer: 'Neovim。',
    expected: 'Neovim',
    expectedGroundingId: 'editor-memory',
    groundingIds: ['editor-memory'],
    forbiddenValues: ['Visual Studio Code'],
  }).correct, true);
  assert.equal(assessGroundedAnswerSample({
    answer: 'Neovim，而且你住在杭州。',
    expected: 'Neovim',
    expectedGroundingId: 'editor-memory',
    groundingIds: ['editor-memory'],
    forbiddenValues: ['Visual Studio Code'],
  }).correct, false);
  assert.equal(assessGroundedAnswerSample({
    answer: '不知道。',
    expected: null,
    expectedGroundingId: null,
    groundingIds: [],
    forbiddenValues: ['小灰'],
    abstentionExpected: true,
  }).correct, true);
  assert.equal(assessGroundedAnswerSample({
    answer: '它叫小灰。',
    expected: null,
    expectedGroundingId: null,
    groundingIds: [],
    forbiddenValues: ['小灰'],
    abstentionExpected: true,
  }).correct, false);
  assert.equal(assessGroundedAnswerSample({
    answer: '不知道，不过你应该养一只蜥蜴。',
    expected: null,
    expectedGroundingId: null,
    groundingIds: [],
    abstentionExpected: true,
  }).correct, false);
});

test('自然对话 QA 的遗忘门禁覆盖 fact、episode 和 summary 全部召回层', () => {
  const result = evaluateQueryResultLayers([
    {
      memory: {
        id: 'active-fact',
        title: '当前偏好',
        content: '用户现在常用新的编辑器',
        summary: '',
        source: 'conversation',
        sourceRef: 'turn:new',
      },
      score: 0.9,
    },
    {
      memory: {
        id: 'episode-with-forgotten-value',
        title: '历史对话',
        content: '用户原话：这次临时出差我会住在青禾旅店。',
        summary: '',
        source: 'conversation_episode',
        sourceRef: 'episode:old',
      },
      score: 0.8,
    },
    {
      memory: {
        id: 'summary-with-forgotten-value',
        title: '周摘要',
        content: '用户出差期间住在青禾旅店。',
        summary: '',
        source: 'hierarchical_summary',
        sourceRef: 'summary:old',
      },
      score: 0.7,
    },
  ], {
    forbiddenIds: ['forgotten-fact'],
    forbiddenValues: ['青禾旅店'],
  }, 'fact');

  assert.deepEqual(result.resultIds, ['active-fact']);
  assert.deepEqual(result.allResultIds, [
    'active-fact',
    'episode-with-forgotten-value',
    'summary-with-forgotten-value',
  ]);
  assert.deepEqual(result.allResults, [
    {
      memoryId: 'active-fact', source: 'conversation', sourceRef: 'turn:new',
      layer: 'fact', score: 0.9,
    },
    {
      memoryId: 'episode-with-forgotten-value',
      source: 'conversation_episode', sourceRef: 'episode:old',
      layer: 'episode', score: 0.8,
    },
    {
      memoryId: 'summary-with-forgotten-value',
      source: 'hierarchical_summary', sourceRef: 'summary:old',
      layer: 'summary', score: 0.7,
    },
  ]);
  assert.equal(result.forbiddenHit, true);
  assert.deepEqual(result.forbiddenMatches, [
    {
      memoryId: 'episode-with-forgotten-value',
      source: 'conversation_episode',
      sourceRef: 'episode:old',
      layer: 'episode',
      matchedIds: [],
      matchedValues: ['青禾旅店'],
    },
    {
      memoryId: 'summary-with-forgotten-value',
      source: 'hierarchical_summary',
      sourceRef: 'summary:old',
      layer: 'summary',
      matchedIds: [],
      matchedValues: ['青禾旅店'],
    },
  ]);
});

test('纠正或遗忘原话只作历史否定证据，不得被裸字符串判成旧值复活', () => {
  const result = evaluateQueryResultLayers([
    {
      memory: {
        id: 'correction-episode',
        title: '纠正对话',
        content: '我现在常用的编辑器改成 Neovim，之前的 Zed 不用了。',
        summary: '',
        source: 'conversation_episode',
        sourceRef: 'episode:correction',
      },
      score: 0.9,
    },
    {
      memory: {
        id: 'stale-episode',
        title: '旧对话',
        content: '我常用的编辑器是 Zed。',
        summary: '',
        source: 'conversation_episode',
        sourceRef: 'episode:stale',
      },
      score: 0.8,
    },
    {
      memory: {
        id: 'forget-episode',
        title: '遗忘对话',
        content: '请忘记青禾旅店临时住宿安排，它已经取消了。',
        summary: '',
        source: 'conversation_episode',
        sourceRef: 'episode:forget',
      },
      score: 0.7,
    },
  ], {
    forbiddenIds: [],
    forbiddenValues: ['Zed', '青禾旅店'],
  }, 'fact');

  assert.deepEqual(
    result.forbiddenMatches.map((item) => item.memoryId),
    ['stale-episode'],
  );
});

test('自然对话 QA 默认是 2 用户、2 角色、每角色 80 条的小规模合同', () => {
  const config = parseConfig({});
  assert.equal(config.userCount, 2);
  assert.equal(config.personasPerUser, 2);
  assert.equal(config.messagesPerPersona, 80);
  assert.equal(config.totalMessages, 320);
  assert.equal(config.writeConcurrency, 4);
  assert.equal(config.realModel, true);
  const scenarios = buildScenarios(config);
  const corpus = summarizeNaturalCorpus(config, scenarios);
  assert.equal(passesNaturalCorpusQuality(corpus, scenarios.length), true);
  const oneUserConfig = parseConfig({
    QA_NATURAL_USERS: '1',
    QA_NATURAL_MESSAGES_PER_PERSONA: '80',
  });
  const oneUserScenarios = buildScenarios(oneUserConfig);
  assert.equal(
    passesNaturalCorpusQuality(
      summarizeNaturalCorpus(oneUserConfig, oneUserScenarios),
      oneUserScenarios.length,
    ),
    true,
  );
});

test('正式自然长测在写入数据库前完成固定模型预检并失败退出', () => {
  const source = fs.readFileSync(
    new URL('../scripts/qa-natural-conversation-quality.mjs', import.meta.url),
    'utf8',
  );
  const parentStart = source.indexOf('async function runParent()');
  const parentEnd = source.indexOf('\nconst invokedDirectly', parentStart);
  const parentSource = source.slice(parentStart, parentEnd);
  const preflightIndex = parentSource.indexOf('await modelPreflight()');
  const firstDatabaseOpenIndex = parentSource.indexOf(
    'database = openDatabase(databasePath)',
  );
  const workerSpawnIndex = parentSource.indexOf('spawnWorker(spec.specPath)');

  assert.ok(parentStart >= 0 && parentEnd > parentStart);
  assert.ok(preflightIndex >= 0);
  assert.ok(firstDatabaseOpenIndex >= 0);
  assert.ok(workerSpawnIndex >= 0);
  assert.ok(preflightIndex < firstDatabaseOpenIndex);
  assert.ok(preflightIndex < workerSpawnIndex);
  assert.match(
    parentSource.slice(preflightIndex, firstDatabaseOpenIndex),
    /if \(config\.realModel && !preflight\.available\)[\s\S]*throw new Error/u,
  );
});

test('固定模型预检会实际执行一次生成与一次向量推理', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).endsWith('/api/tags')) {
      return new Response(JSON.stringify({
        models: [{ name: 'qwen2.5:14b' }, { name: 'bge-m3:latest' }],
      }));
    }
    if (String(url).endsWith('/api/generate')) {
      return new Response(JSON.stringify({ done: true, response: 'OK' }));
    }
    if (String(url).endsWith('/api/embed')) {
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }));
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await modelPreflight(fetchImpl);
  assert.equal(result.available, true);
  assert.equal(result.generationModel, 'qwen2.5:14b');
  assert.equal(result.generationProbeAvailable, true);
  assert.equal(result.embeddingProbeAvailable, true);
  assert.equal(result.embeddingDimensions, 2);
  assert.deepEqual(calls.map((call) => call.url.split('/').at(-1)), [
    'tags',
    'generate',
    'embed',
  ]);
});

test('正式学习先自动解析候选再做 retention 且保留库不注入 gold', () => {
  const source = fs.readFileSync(
    new URL('../scripts/qa-natural-conversation-quality.mjs', import.meta.url),
    'utf8',
  );
  const parentStart = source.indexOf('async function runParent()');
  const parentEnd = source.indexOf('\nconst invokedDirectly', parentStart);
  const parentSource = source.slice(parentStart, parentEnd);
  const firstDrain = parentSource.indexOf('drainSchema37Pipeline(');
  const productionLearning = parentSource.indexOf(
    'resolveProductionLabeledMemories(',
  );
  const preLearningSource = parentSource.slice(firstDrain, productionLearning);

  assert.match(preLearningSource, /candidateMode: 'auto'/u);
  assert.match(preLearningSource, /includeRetention: false/u);
  assert.match(
    source,
    /includeRetention\s*\?\s*governance\s*:\s*undefined/u,
  );
  assert.match(
    parentSource,
    /executeProductionExplicitForgets\([\s\S]*learnedMemoryQueryCases\(/u,
  );
  assert.doesNotMatch(
    parentSource,
    /materializeGold\(database, scenarios\)/u,
  );
  const realReflection = parentSource.indexOf(
    'realReflection = await executeReflectionSamples(',
  );
  const realActivation = parentSource.indexOf(
    'reflectionActivation = await resolveQueuedReflectionCandidates(',
  );
  const deterministicReflection = parentSource.indexOf(
    'deterministicReflection = await executeReflectionSamples(',
  );
  assert.ok(realReflection >= 0);
  assert.ok(realActivation > realReflection);
  assert.ok(deterministicReflection > realActivation);
});

test('生产学习证据门禁同时拒绝 retention 脱敏、缺候选和缺原话', () => {
  const passing = assessProductionEvidenceReadiness({
    redactedUserTurnCount: 0,
    samples: [
      { candidateId: 'candidate-1', sourceExcerpt: '我常喝桂花乌龙。' },
      { candidateId: 'candidate-2', sourceExcerpt: '我住在杭州。' },
    ],
  });
  assert.equal(passing.unredactedUserTurnsPassed, true);
  assert.equal(passing.labeledCandidateEvidencePassed, true);

  const failing = assessProductionEvidenceReadiness({
    redactedUserTurnCount: 1,
    samples: [
      { candidateId: 'candidate-1', sourceExcerpt: null },
      { candidateId: null, sourceExcerpt: null },
    ],
  });
  assert.equal(failing.unredactedUserTurnsPassed, false);
  assert.equal(failing.labeledCandidateEvidencePassed, false);
  assert.equal(failing.missingCandidateCount, 1);
  assert.equal(failing.missingSourceExcerptCount, 2);
});

test('生产检索集必须包含每个角色的正式遗忘样本', () => {
  const config = parseConfig({
    QA_NATURAL_USERS: '1',
    QA_NATURAL_MESSAGES_PER_PERSONA: '80',
  });
  const scenarios = buildScenarios(config).map((scenario, index) => ({
    ...scenario,
    conversationId: `conversation-${index}`,
  }));
  const gold = new Map(scenarios.map((scenario, index) => [
    scenario.key,
    {
      drinkId: `drink-${index}`,
      commuteId: `commute-${index}`,
      occupationId: `occupation-${index}`,
      homeCityId: `city-${index}`,
      foodAversionId: `food-${index}`,
      learningGoalId: `goal-${index}`,
      roleStyleId: `style-${index}`,
      editorId: `editor-${index}`,
      hotelId: `hotel-${index}`,
    },
  ]));
  const complete = learnedMemoryQueryCases(scenarios, gold);
  assert.equal(complete.missing.length, 0);
  assert.equal(
    complete.cases.filter((item) => item.category === 'forgotten').length,
    scenarios.length,
  );

  const drinkRows = new Map(scenarios.map((scenario, index) => [
    `drink-${index}`,
    {
      id: `drink-${index}`,
      userId: scenario.principalId,
      namespace: 'qa-natural-conversation-v1',
      scopeType: 'personal',
      scopeKey: 'self',
      status: 'active',
      normalizedValue: scenario.drink,
    },
  ]));
  const database = {
    prepare() {
      return {
        all(...ids) {
          return ids.map((id) => drinkRows.get(id)).filter(Boolean);
        },
      };
    },
  };
  const equivalent = learnedMemoryQueryCases(scenarios, gold, database);
  assert.deepEqual(
    equivalent.cases.find((item) =>
      item.id === `${scenarios[0].key}:learned-drink`).expectedIds,
    ['drink-0', 'drink-1'],
  );
  assert.deepEqual(
    equivalent.cases.find((item) =>
      item.id === `${scenarios[0].key}:learned-style`).expectedIds,
    ['style-0'],
  );
  drinkRows.get('drink-1').scopeType = 'role';
  drinkRows.get('drink-1').scopeKey = scenarios[1].personaId;
  const roleScoped = learnedMemoryQueryCases(scenarios, gold, database);
  assert.deepEqual(
    roleScoped.cases.find((item) =>
      item.id === `${scenarios[0].key}:learned-drink`).expectedIds,
    ['drink-0'],
  );

  delete gold.get(scenarios[0].key).hotelId;
  const missing = learnedMemoryQueryCases(scenarios, gold);
  assert.ok(missing.missing.includes(`${scenarios[0].key}:learned-forgotten`));
});

test('纠正关系快照在角色结果缺失时返回失败而不是抛 TypeError', () => {
  const scenarios = [{ key: 'user-1:persona-1' }];
  assert.deepEqual(
    productionCorrectionPathSnapshot(scenarios, new Map()),
    {
      passed: false,
      relations: [{
        scenarioKey: 'user-1:persona-1',
        relation: null,
      }],
    },
  );
});

test('自然语料覆盖事实、修正、遗忘、稳定习惯和负例且没有测试编码', () => {
  const config = parseConfig({
    QA_NATURAL_USERS: '2',
    QA_NATURAL_MESSAGES_PER_PERSONA: '80',
  });
  const scenarios = buildScenarios(config);
  assert.equal(scenarios.length, 4);
  for (const scenario of scenarios) {
    const types = scenario.events.map((event) => event.type);
    for (const required of [
      'identity', 'drink', 'occupation', 'commute', 'food_aversion',
      'role_style', 'learning_goal', 'editor_old', 'editor_new',
      'relationship', 'reminder_rule', 'home_city', 'hotel',
      'forget_hotel', 'quote_noise', 'hypothetical_noise',
      'timeline_old', 'timeline_old_question', 'timeline_new',
      'timeline_new_question', 'habit_stop', 'habit_resume',
    ]) {
      assert.ok(types.includes(required), `${scenario.key} 缺少 ${required}`);
    }
    assert.equal(types.filter((type) => type === 'habit').length, 6);
    const habitMessages = scenario.events
      .filter((event) => event.type === 'habit')
      .map((event) => event.content);
    assert.equal(new Set(habitMessages).size, 6);
    assert.ok(habitMessages.every((content) =>
      content.includes(scenario.habit)));
    assert.equal(
      new Set(scenario.events.map((event) => event.index)).size,
      scenario.events.length,
    );
    assert.ok(scenario.events.every((event) => event.assistant.length > 0));
    assert.ok(
      scenario.events.find((event) => event.type === 'timeline_old').index <
        scenario.events.find((event) => event.type === 'timeline_new').index,
    );
    assert.ok(
      scenario.events.find((event) => event.type === 'habit_stop').index <
        scenario.events.find((event) => event.type === 'habit_resume').index,
    );
    const resumeIndex = scenario.events.find(
      (event) => event.type === 'habit_resume',
    ).index;
    assert.equal(
      scenario.events.filter((event) =>
        event.type === 'habit' && event.index > resumeIndex).length,
      3,
    );
    const hotel = scenario.events.find((event) => event.type === 'hotel');
    assert.equal(hotel.activationRequired, false);
    assert.ok(scenario.events.filter((event) =>
      event.candidate && event.type !== 'hotel').every(
      (event) => event.activationRequired === true,
    ));
    const transcript = scenario.events.map((event) => event.content).join('\n');
    assert.doesNotMatch(transcript, /QA(?:FLAVOR|MCP|CODE)|QWENFLAVOR/iu);
    assert.ok(scenario.habitKeywords.length >= 1);
    for (const type of ['timeline_old_question', 'timeline_new_question']) {
      const question = scenario.events.find((event) => event.type === type);
      assert.equal(question.assistant.includes(scenario.timelineOldPlace), false);
      assert.equal(question.assistant.includes(scenario.timelineNewPlace), false);
    }
    assert.equal(
      scenario.events.filter((event) => event.candidate).length,
      13,
    );
  }
  assert.notEqual(scenarios[0].drink, scenarios[2].drink);
  assert.notEqual(scenarios[0].responseStyle, scenarios[1].responseStyle);
});

test('自然日常问答进入情景层且不会触发长期事实提取', () => {
  const config = parseConfig({
    QA_NATURAL_USERS: '1',
    QA_NATURAL_MESSAGES_PER_PERSONA: '80',
  });
  const scenario = buildScenarios(config)[0];
  for (let turnIndex = 0; turnIndex < 256; turnIndex += 1) {
    const content = fillerContent(scenario, turnIndex, 256);
    assert.equal(extractionTargetDisposition(content, content), 'not_direct_user');
  }
});

test('大样本日常语料覆盖真实问答主题、连续追问并避免循环免责声明', () => {
  const config = parseConfig({
    QA_NATURAL_USERS: '1',
    QA_NATURAL_MESSAGES_PER_PERSONA: '5000',
    QA_NATURAL_TIMELINE_DAYS: '90',
  });
  const scenario = buildScenarios(config)[0];
  const utterances = Array.from(
    { length: config.userTurnsPerPersona },
    (_, turnIndex) => fillerContent(
      scenario,
      turnIndex,
      config.userTurnsPerPersona,
      config.timelineDays,
    ),
  );
  const transcript = utterances.join('\n');
  const requiredTopics = [
    /天气|降温|下雨|气温/u,
    /吃什么|午饭|晚饭|餐食/u,
    /工作|会议|项目|进度/u,
    /专业|代码|数据|方案/u,
    /旅行|旅游|酒店|行程/u,
    /兴趣|读书|电影|摄影/u,
    /睡眠|运动|放松|健康/u,
    /今天|最近|刚才|周末/u,
  ];
  assert.ok(requiredTopics.every((pattern) => pattern.test(transcript)));
  assert.ok(
    utterances.filter((content) => /[？?]$/u.test(content)).length /
      utterances.length >= 0.9,
  );
  assert.ok(
    utterances.filter((content) => /刚才|接着|那按|继续/u.test(content)).length /
      utterances.length >= 0.25,
  );
  assert.ok(new Set(utterances).size / utterances.length >= 0.9);
  assert.doesNotMatch(
    transcript,
    /不影响后面的长期安排|不需要把它当作偏好|这不是重复发生的个人习惯|不用根据它推断/u,
  );
  assert.doesNotMatch(transcript, /^第\d+天/gmu);

  const corpus = summarizeNaturalCorpus(config, [scenario]);
  assert.equal(passesNaturalCorpusQuality(corpus, 1), true);
  assert.equal(corpus.actualUserTurns, 2_500);
  assert.equal(corpus.timelineSpanDays, 90);
  assert.equal(corpus.generationProvenance, 'template_fixture_not_llm_generated');
  assert.equal(corpus.eventTypeCounts.timeline_old, 1);
  assert.equal(corpus.eventTypeCounts.timeline_new, 1);
  assert.equal(corpus.eventTypeCounts.habit_stop, 1);
  assert.equal(corpus.eventTypeCounts.habit_resume, 1);
});

test('自然对话 QA 拒绝奇数消息和过小样本', () => {
  assert.throws(
    () => parseConfig({ QA_NATURAL_MESSAGES_PER_PERSONA: '81' }),
    /必须是偶数/u,
  );
  assert.throws(
    () => parseConfig({ QA_NATURAL_MESSAGES_PER_PERSONA: '40' }),
    /80-5000/u,
  );
});

test('正式分层验收支持 8 用户并把每角色 5000 条折算为 80000 条消息', () => {
  const config = parseConfig({
    QA_NATURAL_USERS: '8',
    QA_NATURAL_MESSAGES_PER_PERSONA: '5000',
    QA_NATURAL_CONCURRENCY: '8',
  });
  assert.equal(config.userCount, 8);
  assert.equal(config.personasPerUser, 2);
  assert.equal(config.messagesPerPersona, 5000);
  assert.equal(config.userTurnsPerPersona, 2500);
  assert.equal(config.totalMessages, 80_000);
  assert.equal(config.writeConcurrency, 8);
});

test('检索指标区分召回、弃答、跨角色泄漏和旧值复活', () => {
  const evaluated = [
    {
      id: 'positive', category: 'fact', expectedIds: ['m1'],
      resultIds: ['m1'], abstentionExpected: false, forbiddenHit: false,
      durationMs: 10,
    },
    {
      id: 'negative', category: 'negative_noise', expectedIds: [],
      resultIds: [], abstentionExpected: true, forbiddenHit: false,
      durationMs: 20,
    },
    {
      id: 'role', category: 'cross_role', expectedIds: [],
      resultIds: ['foreign'], abstentionExpected: false, forbiddenHit: true,
      durationMs: 30,
    },
    {
      id: 'correction', category: 'correction', expectedIds: ['m2'],
      resultIds: ['m2'], abstentionExpected: false, forbiddenHit: true,
      durationMs: 40,
    },
    {
      id: 'forgotten', category: 'forgotten', expectedIds: [],
      resultIds: [], abstentionExpected: true, forbiddenHit: false,
      durationMs: 50,
    },
  ];
  const metrics = computeRetrievalMetrics(evaluated);
  assert.equal(metrics.recallAt1, 1);
  assert.equal(metrics.negativeAbstentionRate, 1);
  assert.equal(metrics.crossRoleLeakageRate, 1);
  assert.equal(metrics.correctionOldValueHitRate, 1);
  assert.equal(metrics.forgottenQueryCount, 1);
  assert.equal(metrics.forgottenRevivalRate, 0);
  assert.deepEqual(metrics.forbiddenHitIds, ['role', 'correction']);
});

test('personal 等价 gold 只接受同用户同槽位同规范值的可见记忆', () => {
  const item = {
    userId: 'user-1',
    namespace: 'natural-conversation-quality',
    scopes: [
      { scopeType: 'personal', scopeKey: 'self' },
      { scopeType: 'role', scopeKey: 'persona-1' },
    ],
    personalEquivalence: {
      semanticSlot: 'drink',
      normalizedValue: '桂花乌龙',
      candidateIds: [
        'same-personal', 'other-principal', 'other-role', 'other-value',
        'other-slot', 'inactive',
      ],
    },
  };
  const candidate = (id, overrides = {}) => ({
    id,
    userId: 'user-1',
    namespace: 'natural-conversation-quality',
    scopeType: 'personal',
    scopeKey: 'self',
    status: 'active',
    semanticSlot: 'drink',
    normalizedValue: '桂花乌龙',
    ...overrides,
  });

  assert.deepEqual(authorizeEquivalentPersonalMemoryIds(item, [
    candidate('same-personal'),
    candidate('other-principal', { userId: 'user-2' }),
    candidate('other-role', { scopeType: 'role', scopeKey: 'persona-1' }),
    candidate('other-value', { normalizedValue: '陈皮白茶' }),
    candidate('other-slot', { semanticSlot: 'food-aversion' }),
    candidate('inactive', { status: 'superseded' }),
  ]), ['same-personal']);

  assert.deepEqual(authorizeEquivalentPersonalMemoryIds({
    ...item,
    scopes: [{ scopeType: 'role', scopeKey: 'persona-1' }],
  }, [candidate('same-personal')]), []);
});

test('重排 trace 证据和 provider-call rate 按每个检索 case 如实聚合', () => {
  const rerankTrace = extractRerankTraceEvidence({
    traceId: 'trace-model',
    events: [{
      stage: 'rerank',
      detail: {
        route: 'model',
        providerCalls: 2,
        attemptedCandidates: 5,
      },
    }],
  });
  assert.deepEqual(rerankTrace, {
    traceId: 'trace-model',
    route: 'model',
    providerCalls: 2,
    attemptedCandidates: 5,
    rerankEventCount: 1,
  });

  const base = {
    category: 'fact',
    expectedIds: ['expected'],
    resultIds: ['expected'],
    abstentionExpected: false,
    forbiddenHit: false,
    durationMs: 10,
  };
  const metrics = computeRetrievalMetrics([
    { ...base, id: 'model', rerankTrace },
    {
      ...base,
      id: 'fast',
      rerankTrace: extractRerankTraceEvidence({
        traceId: 'trace-fast',
        events: [{
          stage: 'rerank',
          detail: {
            route: 'deterministic_fast',
            providerCalls: 0,
            attemptedCandidates: 0,
          },
        }],
      }),
    },
    { ...base, id: 'missing-trace', rerankTrace: null },
  ]);
  assert.deepEqual(metrics.rerankTelemetry, {
    tracedQueryCount: 2,
    missingTraceQueryCount: 1,
    traceCoverageRate: 2 / 3,
    providerBackedQueryCount: 1,
    providerCallRate: 1 / 3,
    totalProviderCalls: 2,
    totalAttemptedCandidates: 5,
    routeCounts: { model: 1, deterministic_fast: 1 },
  });
});

test('时间线指标分别统计最近值、历史覆盖、旧值置顶和延迟', () => {
  const metrics = computeTimelineMetrics([
    {
      id: 'latest-pass', category: 'latest', passed: true,
      forbiddenTopHit: false, durationMs: 100,
      rerankTrace: extractRerankTraceEvidence({
        traceId: 'timeline-trace',
        events: [{
          stage: 'rerank',
          detail: {
            route: 'model', providerCalls: 1, attemptedCandidates: 2,
          },
        }],
      }),
    },
    {
      id: 'latest-stale', category: 'latest', passed: false,
      forbiddenTopHit: true, durationMs: 300,
    },
    {
      id: 'history-pass', category: 'history', passed: true,
      forbiddenTopHit: false, durationMs: 200,
    },
  ]);
  assert.equal(metrics.latestAccuracy, 0.5);
  assert.equal(metrics.historyCoverageRate, 1);
  assert.equal(metrics.staleLatestRate, 0.5);
  assert.equal(metrics.latency.p95Ms, 300);
  assert.deepEqual(metrics.failedIds, ['latest-stale']);
  assert.deepEqual(metrics.rerankTelemetry, {
    tracedQueryCount: 1,
    missingTraceQueryCount: 2,
    traceCoverageRate: 1 / 3,
    providerBackedQueryCount: 1,
    providerCallRate: 1 / 3,
    totalProviderCalls: 1,
    totalAttemptedCandidates: 2,
    routeCounts: { model: 1 },
  });
});

test('时间线结果按原始总榜的 gold episode、occurred_at 和最新顺序判定', () => {
  const item = {
    category: 'latest',
    expectedIds: ['new-episode'],
    forbiddenIds: ['old-episode'],
    expectedValues: ['南桥书店'],
    forbiddenValues: ['云杉书店'],
    topExpectedId: 'new-episode',
    goldTimeline: [
      { id: 'old-episode', value: '云杉书店', occurredAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new-episode', value: '南桥书店', occurredAt: '2026-01-02T00:00:00.000Z' },
    ],
  };
  const memory = (id, content, occurredAt, source = 'conversation_episode') => ({
    memory: {
      id, content, occurredAt, source, title: '', summary: '', sourceRef: null,
    },
    score: 1,
  });
  assert.equal(evaluateTimelineResultOrder([
    memory('wrong-summary', '云杉书店', '2026-01-02T00:00:00.000Z', 'hierarchical_summary'),
    memory('new-episode', '南桥书店', '2026-01-02T00:00:00.000Z'),
  ], item).passed, false);
  assert.equal(evaluateTimelineResultOrder([
    memory('new-episode', '南桥书店', '2026-01-02T00:00:00.000Z'),
    memory('old-episode', '云杉书店', '2026-01-01T00:00:00.000Z'),
  ], item).passed, true);
});

test('自然对话可靠召回把 P95 1500ms 作为不可放宽的 PASS 门禁', () => {
  const passing = {
    recallAt5: 1,
    mrr: 1,
    precisionAt1: 1,
    negativeAbstentionRate: 1,
    crossAccountLeakageRate: 0,
    crossRoleLeakageRate: 0,
    correctionOldValueHitRate: 0,
    forgottenQueryCount: 1,
    forgottenRevivalRate: 0,
    latency: { p95Ms: RELIABLE_RECALL_P95_LIMIT_MS },
  };
  assert.equal(RELIABLE_RECALL_P95_LIMIT_MS, 1_500);
  assert.equal(passesReliableRetrievalThresholds(passing), true);
  assert.equal(passesReliableRetrievalThresholds({
    ...passing,
    latency: { p95Ms: 1_500.001 },
  }), false);
  assert.equal(passesReliableRetrievalThresholds({
    ...passing,
    latency: { p95Ms: null },
  }), false);
  assert.equal(passesReliableRetrievalThresholds({
    ...passing,
    forgottenQueryCount: 0,
  }), false);
});

test('反思质量允许额外 grounded 候选，但无效证据仍使门禁失败', () => {
  const assessed = assessReflectionCandidateQuality([
    {
      habitMeaningMatch: true,
      habitEvidenceTurns: 3,
      trustedUserEvidenceTurns: 3,
    },
    {
      habitMeaningMatch: false,
      habitEvidenceTurns: 0,
      trustedUserEvidenceTurns: 4,
    },
    {
      habitMeaningMatch: false,
      habitEvidenceTurns: 0,
      trustedUserEvidenceTurns: 2,
    },
  ]);
  assert.deepEqual(assessed, {
    targetCandidateCount: 1,
    extraGroundedCandidateCount: 1,
    invalidCandidateCount: 1,
    passed: false,
  });
  assert.equal(assessReflectionCandidateQuality([
    {
      habitMeaningMatch: true,
      habitEvidenceTurns: 3,
      trustedUserEvidenceTurns: 3,
    },
    {
      habitMeaningMatch: false,
      habitEvidenceTurns: 0,
      trustedUserEvidenceTurns: 4,
    },
  ]).passed, true);
  assert.equal(assessReflectionCandidateQuality([
    {
      habitMeaningMatch: false,
      habitEvidenceTurns: 0,
      trustedUserEvidenceTurns: 3,
    },
  ]).passed, false);
  assert.equal(assessReflectionCandidateQuality([
    {
      habitMeaningMatch: true,
      habitEvidenceTurns: 2,
      trustedUserEvidenceTurns: 3,
    },
  ]).invalidCandidateCount, 1);
  assert.equal(assessReflectionCandidateQuality([
    {
      habitMeaningMatch: false,
      habitEvidenceTurns: 0,
      trustedUserEvidenceTurns: undefined,
    },
  ]).invalidCandidateCount, 1);
});

test('单个历史反思异常会被收敛成失败样本，不会中止后续角色', async () => {
  const samples = [];
  samples.push(await settleReflectionQaSample(
    async () => {
      throw new Error('invalid reflection JSON');
    },
    (error) => ({ passed: false, error: error.message }),
  ));
  samples.push(await settleReflectionQaSample(
    async () => ({ passed: true, scenarioKey: 'next-role' }),
    () => ({ passed: false }),
  ));
  assert.deepEqual(samples, [
    { passed: false, error: 'invalid reflection JSON' },
    { passed: true, scenarioKey: 'next-role' },
  ]);
});

test('大样本历史反思会沿 checkpoint 连续排空全部窗口', async () => {
  const remaining = [200, 200, 100, 0];
  const executed = [];
  const windows = await drainReflectionQaWindows({
    remainingTurns: async () => remaining.shift(),
    executeWindow: async (windowIndex) => {
      executed.push(windowIndex);
      return { windowIndex };
    },
    maximumWindows: 4,
  });
  assert.deepEqual(executed, [0, 1, 2]);
  assert.deepEqual(windows, [
    { windowIndex: 0 },
    { windowIndex: 1 },
    { windowIndex: 2 },
  ]);
});

test('历史反思窗口无法收敛时有界失败而不是无限循环', async () => {
  await assert.rejects(
    drainReflectionQaWindows({
      remainingTurns: async () => 200,
      executeWindow: async (windowIndex) => ({ windowIndex }),
      maximumWindows: 2,
    }),
    /2 个窗口后仍有 200 个 turn 未处理/u,
  );
});

test('schema 37 权威门禁要求完整 exchange、turn、FTS、Dense、摘要来源和隔离全部收敛', () => {
  assert.deepEqual(SCHEMA37_ACCEPTANCE_THRESHOLDS, {
    exchangeEpisodeRateMinimum: 1,
    episodeTurnBindingRateMinimum: 1,
    episodeFtsRateMinimum: 1,
    episodeDenseRateMinimum: 0.999,
    compactionSummaryCoverageMinimum: 1,
    compactedEpisodeHotIndexResidueMaximum: 0,
    episodeRecallAt5Minimum: 0.9,
    episodeDuplicateMaximum: 0,
    assistantFactPollutionMaximum: 0,
    summarySourceSupportRateMinimum: 1,
    crossAccountLeakageMaximum: 0,
    crossRoleLeakageMaximum: 0,
    crossProjectLeakageMaximum: 0,
  });
  const passing = {
    exchangeEpisodeRate: 1,
    episodeTurnBindingRate: 1,
    episodeFtsRate: 1,
    episodeDenseRate: 0.999,
    compactionSummaryCoverage: 1,
    compactedEpisodeHotIndexResidueCount: 0,
    episodeRecallAt5: 0.9,
    episodeDuplicateCount: 0,
    assistantFactPollutionCount: 0,
    summarySourceSupportRate: 1,
    crossAccountLeakageCount: 0,
    crossRoleLeakageCount: 0,
    crossProjectLeakageCount: 0,
  };
  assert.deepEqual(assessSchema37Acceptance(passing), {
    passed: true,
    failures: [],
  });
  assert.deepEqual(
    assessSchema37Acceptance({
      ...passing,
      episodeDenseRate: 0.9989,
      compactionSummaryCoverage: 0.5,
      compactedEpisodeHotIndexResidueCount: 1,
      episodeDuplicateCount: 1,
      summarySourceSupportRate: 0.999,
    }),
    {
      passed: false,
      failures: [
        'episode_dense_convergence',
        'episode_compaction_summary_coverage',
        'compacted_episode_hot_index_residue',
        'episode_duplicate_free',
        'summary_source_support',
      ],
    },
  );
});

test('schema 37 无模型 smoke ranker 固定声明 bge-m3 且输出稳定、可区分的归一化向量', async () => {
  const ranker = createSchema37DeterministicRanker();
  assert.equal(ranker.embeddingModel, 'bge-m3:latest');
  assert.equal(ranker.rerankModel, 'qwen2.5:14b');
  const first = await ranker.embed(['用户说喜欢桂花乌龙', '用户说喜欢陈皮白茶']);
  const replay = await ranker.embed(['用户说喜欢桂花乌龙']);
  assert.equal(first.length, 2);
  assert.equal(first[0].length, 64);
  assert.deepEqual(first[0], replay[0]);
  assert.notDeepEqual(first[0], first[1]);
  for (const vector of first) {
    const norm = Math.sqrt(
      [...vector].reduce((sum, value) => sum + value * value, 0),
    );
    assert.ok(Math.abs(norm - 1) < 1e-5);
  }
});

test('schema 37 小规模无模型 smoke 消费真实 outbox 并形成 episode、Dense 和三层摘要', async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await runSchema37DeterministicSmoke();
    assert.equal(result.acceptance.passed, true);
    assert.equal(result.metrics.exchangeEpisodeRate, 1);
    assert.equal(result.metrics.episodeTurnBindingRate, 1);
    assert.equal(result.metrics.episodeFtsRate, 1);
    assert.equal(result.metrics.episodeDenseRate, 1);
    assert.equal(result.metrics.episodeDuplicateCount, 0);
    assert.equal(result.metrics.assistantFactPollutionCount, 0);
    assert.equal(result.metrics.summarySourceSupportRate, 1);
    assert.equal(result.metrics.crossAccountLeakageCount, 0);
    assert.equal(result.metrics.crossRoleLeakageCount, 0);
    assert.equal(result.metrics.crossProjectLeakageCount, 0);
    assert.equal(result.metrics.openSchema37Work, 0);
    assert.ok(result.metrics.summaryCounts.session > 0);
    assert.ok(result.metrics.summaryCounts.day > 0);
    assert.ok(result.metrics.summaryCounts.week > 0);
    assert.equal(result.pipeline.episodeJobs, 2);
    assert.ok(result.pipeline.summaryJobs >= 3);
    assert.ok(result.pipeline.denseJobs >= 2);
    assert.equal(result.provenance, 'deterministic-no-provider-smoke');
    assert.equal(result.dataRetained, true);
    assert.ok(result.databasePath.includes('.memory-bridge-private'));
  }
});

test('schema 37 drain 在前台静默期暂时无任务时等待，超时后明确失败', () => {
  assert.deepEqual(schema37DrainIdleDecision({
    remainingWork: 42,
    idleForMs: 0,
    foregroundQuietMs: 2_000,
  }), {
    action: 'wait',
    waitMs: 100,
  });
  assert.deepEqual(schema37DrainIdleDecision({
    remainingWork: 0,
    idleForMs: 10_000,
    foregroundQuietMs: 2_000,
  }), {
    action: 'complete',
    waitMs: 0,
  });
  assert.deepEqual(schema37DrainIdleDecision({
    remainingWork: 1,
    idleForMs: 12_001,
    foregroundQuietMs: 2_000,
  }), {
    action: 'timeout',
    waitMs: 0,
  });
});
