import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseLoopbackHost } from '../src/server/config.js';

test('HTTP 服务只允许绑定明确的回环地址', () => {
  assert.equal(parseLoopbackHost(undefined), '127.0.0.1');
  assert.equal(parseLoopbackHost('127.0.0.1'), '127.0.0.1');
  assert.equal(parseLoopbackHost('::1'), '::1');
  assert.equal(parseLoopbackHost('localhost'), '127.0.0.1');
  assert.equal(parseLoopbackHost('0.0.0.0'), '127.0.0.1');
  assert.equal(parseLoopbackHost('192.168.1.50'), '127.0.0.1');
});

test('运行时默认使用通过验收的巩固提示版本', () => {
  const environment = { ...process.env };
  delete environment.MEMORY_BRIDGE_CONSOLIDATION_PROMPT_VERSION;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      [
        "import { config } from './src/server/config.ts';",
        'process.stdout.write(config.consolidationPromptVersion);',
      ].join(''),
    ],
    {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'consolidate-v6');
});

test('运行时默认使用当前提取提示契约版本', () => {
  const environment = { ...process.env };
  delete environment.MEMORY_BRIDGE_EXTRACTION_PROMPT_VERSION;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      [
        "import { config } from './src/server/config.ts';",
        'process.stdout.write(config.extractionPromptVersion);',
      ].join(''),
    ],
    {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'extract-v6');
});

test('兼容代理聊天模型默认值与环境变量覆盖均由运行时配置加载', () => {
  const evaluate = (model: string | undefined) => {
    const environment = { ...process.env };
    if (model === undefined) {
      delete environment.MEMORY_BRIDGE_COMPAT_CHAT_MODEL;
    } else {
      environment.MEMORY_BRIDGE_COMPAT_CHAT_MODEL = model;
    }
    return spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        [
          "import { config } from './src/server/config.ts';",
          'process.stdout.write(config.compatChatModel);',
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        env: environment,
        encoding: 'utf8',
      },
    );
  };

  const defaultModel = evaluate(undefined);
  assert.equal(defaultModel.status, 0, defaultModel.stderr);
  assert.equal(defaultModel.stdout, 'qwen2.5:14b');

  const customModel = evaluate('custom-chat:latest');
  assert.equal(customModel.status, 0, customModel.stderr);
  assert.equal(customModel.stdout, 'custom-chat:latest');

  const trimmedModel = evaluate('  custom-chat:latest  ');
  assert.equal(trimmedModel.status, 0, trimmedModel.stderr);
  assert.equal(trimmedModel.stdout, 'custom-chat:latest');

  for (const invalid of ['   ', 'model;touch-bad', 'model\nother']) {
    const rejected = evaluate(invalid);
    assert.notEqual(rejected.status, 0);
    assert.match(
      rejected.stderr,
      /MEMORY_BRIDGE_COMPAT_CHAT_MODEL/u,
    );
  }
});

test('全部 Ollama 模型角色统一 trim 并拒绝不安全标识符', () => {
  const roles = {
    MEMORY_BRIDGE_COMPAT_CHAT_MODEL: 'compatChatModel',
    MEMORY_BRIDGE_EMBED_MODEL: 'embeddingModel',
    MEMORY_BRIDGE_QUERY_MODEL: 'queryModel',
    MEMORY_BRIDGE_RERANK_MODEL: 'rerankModel',
    MEMORY_BRIDGE_EXTRACTION_MODEL: 'extractionModel',
    MEMORY_BRIDGE_RELATION_MODEL: 'relationModel',
    MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL: 'explicitIntentModel',
    MEMORY_BRIDGE_CONSOLIDATION_MODEL: 'consolidationModel',
    MEMORY_BRIDGE_REFLECTION_MODEL: 'reflectionModel',
  };
  const evaluate = (overrides: Record<string, string>) => {
    const environment = { ...process.env, ...overrides };
    return spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        [
          "import { config } from './src/server/config.ts';",
          `process.stdout.write(JSON.stringify({${
            Object.values(roles)
              .map((name) => `${name}:config.${name}`)
              .join(',')
          }}));`,
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        env: environment,
        encoding: 'utf8',
      },
    );
  };

  const safeOverrides = Object.fromEntries(
    Object.keys(roles).map((environmentName, index) => [
      environmentName,
      `  custom-model-${index}:latest  `,
    ]),
  );
  const safe = evaluate(safeOverrides);
  assert.equal(safe.status, 0, safe.stderr);
  assert.deepEqual(
    JSON.parse(safe.stdout),
    Object.fromEntries(
      Object.values(roles).map((configName, index) => [
        configName,
        `custom-model-${index}:latest`,
      ]),
    ),
  );

  for (const environmentName of Object.keys(roles)) {
    const rejected = evaluate({ [environmentName]: 'model;unsafe' });
    assert.notEqual(rejected.status, 0, environmentName);
    assert.match(rejected.stderr, new RegExp(environmentName));
  }
});

test('历史重提炼默认使用受限 shadow 配置', () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('MEMORY_BRIDGE_REFLECTION_')) {
      delete environment[key];
    }
  }
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      [
        "import { config } from './src/server/config.ts';",
        'process.stdout.write(JSON.stringify({',
        'mode: config.reflectionMode,',
        'sweepHours: config.reflectionSweepHours,',
        'idleMinutes: config.reflectionIdleMinutes,',
        'minNewTurns: config.reflectionMinNewTurns,',
        'maxTurns: config.reflectionMaxTurns,',
        'tokenBudget: config.reflectionTokenBudget,',
        'lookbackDays: config.reflectionLookbackDays,',
        'minEvidence: config.reflectionMinPatternEvidence,',
        'requireCrossSession: config.reflectionRequireCrossSessionEvidence,',
        'requireCrossDay: config.reflectionRequireCrossDayEvidence,',
        'dailyCalls: config.reflectionMaxDailyCalls,',
        'concurrency: config.reflectionConcurrency',
        '}));',
      ].join(''),
    ],
    {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    mode: 'shadow',
    sweepHours: 24,
    idleMinutes: 30,
    minNewTurns: 12,
    maxTurns: 40,
    tokenBudget: 8000,
    lookbackDays: 180,
    minEvidence: 3,
    requireCrossSession: false,
    requireCrossDay: false,
    dailyCalls: 1000,
    concurrency: 1,
  });

  for (const [configured, expected] of [
    ['2', 3],
    ['3', 3],
    ['5', 5],
    ['6', 3],
  ] as const) {
    const bounded = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "import { config } from './src/server/config.ts'; process.stdout.write(String(config.reflectionMinPatternEvidence));",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...environment,
          MEMORY_BRIDGE_REFLECTION_MIN_PATTERN_EVIDENCE: configured,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.equal(Number(bounded.stdout), expected, configured);
  }
});

test('历史重提炼证据多样性开关只接受显式 true', () => {
  const environment = {
    ...process.env,
    MEMORY_BRIDGE_REFLECTION_REQUIRE_CROSS_SESSION_EVIDENCE: 'true',
    MEMORY_BRIDGE_REFLECTION_REQUIRE_CROSS_DAY_EVIDENCE: '1',
  };
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      [
        "import { config } from './src/server/config.ts';",
        'process.stdout.write(JSON.stringify([',
        'config.reflectionRequireCrossSessionEvidence,',
        'config.reflectionRequireCrossDayEvidence]));',
      ].join(''),
    ],
    { cwd: process.cwd(), env: environment, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [true, true]);
});

// -0 与 0 是同一个数值，但 `assert/strict` 用 Object.is 判等（Object.is(-0, 0) 为 false）。
// 零偏移时区（如 UTC）下 `-new Date().getTimezoneOffset()` 得到 -0，而子进程里
// `String(-0)` 输出 "0"、解析回来是 0 —— 归一化后再比较，避免把表示差异误判为回归。
const normalizeZero = (value: number): number => (value === 0 ? 0 : value);

test('层级摘要时区默认跟随本机且只接受合法分钟偏移', () => {
  const evaluate = (value: string | undefined) => {
    const environment = { ...process.env };
    if (value === undefined) {
      delete environment.MEMORY_BRIDGE_SUMMARY_TIMEZONE_OFFSET_MINUTES;
    } else {
      environment.MEMORY_BRIDGE_SUMMARY_TIMEZONE_OFFSET_MINUTES = value;
    }
    return spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        [
          "import { config } from './src/server/config.ts';",
          'process.stdout.write(String(config.summaryTimezoneOffsetMinutes));',
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        env: environment,
        encoding: 'utf8',
      },
    );
  };

  const defaultOffset = evaluate(undefined);
  assert.equal(defaultOffset.status, 0, defaultOffset.stderr);
  assert.equal(
    normalizeZero(Number(defaultOffset.stdout)),
    normalizeZero(-new Date().getTimezoneOffset()),
  );

  for (const [value, expected] of [
    ['480', 480],
    ['-300', -300],
    ['840', 840],
    ['-840', -840],
  ] as const) {
    const result = evaluate(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), expected);
  }

  for (const invalid of ['841', '-841', '8.5', 'not-a-number']) {
    const result = evaluate(invalid);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      normalizeZero(Number(result.stdout)),
      normalizeZero(-new Date().getTimezoneOffset()),
    );
  }
});

test('重排候选文本预算：默认零回归，可经环境变量放大，越界回落默认', () => {
  const evaluate = (
    overrides: Record<string, string | undefined>,
  ): { status: number | null; stdout: string; stderr: string } => {
    const environment: Record<string, string | undefined> = {
      ...process.env,
      ...overrides,
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete environment[key];
    }
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        [
          "import { config } from './src/server/config.ts';",
          'process.stdout.write(JSON.stringify({',
          'budget: config.semanticRerankCandidateTextBudget,',
          'numCtx: config.semanticRerankNumCtx,',
          '}));',
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        env: environment as NodeJS.ProcessEnv,
        encoding: 'utf8',
      },
    );
    return {
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
    };
  };

  // 出厂默认：640 字符 + 不显式下发 num_ctx（沿用运行时默认，行为不变）。
  const defaults = evaluate({
    MEMORY_BRIDGE_SEMANTIC_RERANK_CANDIDATE_TEXT_BUDGET: undefined,
    MEMORY_BRIDGE_SEMANTIC_RERANK_NUM_CTX: undefined,
  });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout), {
    budget: 640,
    numCtx: 0,
  });

  // 知识库档：预算放大到 2400，必须同时抬高上下文窗口，否则尾批被截断。
  const raised = evaluate({
    MEMORY_BRIDGE_SEMANTIC_RERANK_CANDIDATE_TEXT_BUDGET: '2400',
    MEMORY_BRIDGE_SEMANTIC_RERANK_NUM_CTX: '8192',
  });
  assert.equal(raised.status, 0, raised.stderr);
  assert.deepEqual(JSON.parse(raised.stdout), {
    budget: 2400,
    numCtx: 8192,
  });

  // 越界或非法值一律回落出厂默认，不允许把预算压到重排拿空文本的程度。
  for (const invalid of ['1', '0', '-100', '无穷', '1.5', '99999']) {
    const result = evaluate({
      MEMORY_BRIDGE_SEMANTIC_RERANK_CANDIDATE_TEXT_BUDGET: invalid,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).budget, 640, invalid);
  }
});

test('cross-encoder 重排 provider 配置：默认 llm，CE 档可完整切换', () => {
  const evaluate = (
    environmentOverrides: Record<string, string | undefined>,
  ) => {
    const environment = { ...process.env };
    for (const [key, value] of Object.entries(environmentOverrides)) {
      if (value === undefined) {
        delete environment[key];
      } else {
        environment[key] = value;
      }
    }
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        [
          "import { config } from './src/server/config.ts';",
          'process.stdout.write(JSON.stringify({',
          'provider: config.semanticRerankProvider,',
          'url: config.crossEncoderBaseUrl,',
          'model: config.crossEncoderModel,',
          'timeoutMs: config.crossEncoderTimeoutMs,',
          'batchSize: config.crossEncoderBatchSize,',
          '}));',
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        env: environment as NodeJS.ProcessEnv,
        encoding: 'utf8',
      },
    );
    return {
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
    };
  };

  // 出厂默认：llm provider，CE 相关字段仅给安全默认值，不生效。
  const defaults = evaluate({
    MEMORY_BRIDGE_RERANK_PROVIDER: undefined,
    MEMORY_BRIDGE_CROSS_ENCODER_URL: undefined,
    MEMORY_BRIDGE_CROSS_ENCODER_TIMEOUT_MS: undefined,
    MEMORY_BRIDGE_CROSS_ENCODER_BATCH_SIZE: undefined,
  });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout), {
    provider: 'llm',
    url: 'http://127.0.0.1:3798',
    model: 'bge-reranker-v2-m3',
    timeoutMs: 30_000,
    batchSize: 32,
  });

  // CE 档：provider 切换 + 自定义地址/批量。
  const ce = evaluate({
    MEMORY_BRIDGE_RERANK_PROVIDER: 'cross_encoder',
    MEMORY_BRIDGE_CROSS_ENCODER_URL: 'http://127.0.0.1:3801',
    MEMORY_BRIDGE_CROSS_ENCODER_BATCH_SIZE: '64',
  });
  assert.equal(ce.status, 0, ce.stderr);
  const ceConfig = JSON.parse(ce.stdout);
  assert.equal(ceConfig.provider, 'cross_encoder');
  assert.equal(ceConfig.url, 'http://127.0.0.1:3801');
  assert.equal(ceConfig.batchSize, 64);

  // 未知 provider 值回落 llm；批量越界回落默认。
  const fallback = evaluate({
    MEMORY_BRIDGE_RERANK_PROVIDER: 'hybrid',
    MEMORY_BRIDGE_CROSS_ENCODER_BATCH_SIZE: '999',
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).provider, 'llm');
  assert.equal(JSON.parse(fallback.stdout).batchSize, 32);
});

test('语料域分档门槛：三档默认 0.9/0.65/0.7，env 可覆盖，越界回落', () => {
  const evaluate = (
    overrides: Record<string, string | undefined>,
  ): { status: number | null; stdout: string; stderr: string } => {
    const environment: Record<string, string | undefined> = {
      ...process.env,
      ...overrides,
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete environment[key];
    }
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        [
          "import { config } from './src/server/config.ts';",
          'process.stdout.write(JSON.stringify({',
          'policy: config.rerankGatePolicy,',
          'open: config.rerankGateOpen,',
          'chat: config.rerankGateChat,',
          '}));',
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        env: environment as NodeJS.ProcessEnv,
        encoding: 'utf8',
      },
    );
    return {
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
    };
  };

  // 出厂默认：policy 0.9 / open 0.65 / chat 0.7。
  const defaults = evaluate({
    MEMORY_BRIDGE_RERANK_GATE_POLICY: undefined,
    MEMORY_BRIDGE_RERANK_GATE_OPEN: undefined,
    MEMORY_BRIDGE_RERANK_GATE_CHAT: undefined,
  });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout), {
    policy: 0.9,
    open: 0.65,
    chat: 0.7,
  });

  // 三档均可独立覆盖。
  const overridden = evaluate({
    MEMORY_BRIDGE_RERANK_GATE_POLICY: '0.95',
    MEMORY_BRIDGE_RERANK_GATE_OPEN: '0.5',
    MEMORY_BRIDGE_RERANK_GATE_CHAT: '0.8',
  });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.deepEqual(JSON.parse(overridden.stdout), {
    policy: 0.95,
    open: 0.5,
    chat: 0.8,
  });

  // 越界回落默认（门槛必须在 [0,1] 内，否则等于关掉或全拒）。
  const invalid = evaluate({
    MEMORY_BRIDGE_RERANK_GATE_POLICY: '1.5',
    MEMORY_BRIDGE_RERANK_GATE_OPEN: '-0.1',
  });
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.deepEqual(JSON.parse(invalid.stdout), {
    policy: 0.9,
    open: 0.65,
    chat: 0.7,
  });
});
