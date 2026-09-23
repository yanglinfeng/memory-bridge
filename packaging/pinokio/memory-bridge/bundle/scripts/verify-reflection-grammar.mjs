import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildQaImplementationEvidence,
  createPrivateQaRunRoot,
  createQaRunId,
  immutableQaPath,
  writeImmutableQaFile,
} from './qa-receipt-lib.mjs';

export const REFLECTION_GRAMMAR_MODEL = 'qwen2.5:14b';
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const RECEIPT_FORMAT = 'memory-bridge-reflection-grammar:v1';
const CLI_NATIVE_FETCH = globalThis.fetch.bind(globalThis);
const CASES = Object.freeze([
  Object.freeze({ phase: 'discover', retryMode: 'normal' }),
  Object.freeze({ phase: 'discover', retryMode: 'compact' }),
  Object.freeze({ phase: 'verify', retryMode: 'normal' }),
  Object.freeze({ phase: 'verify', retryMode: 'compact' }),
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeBaseUrl(value) {
  const parsed = new URL(String(value || DEFAULT_OLLAMA_URL));
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('reflection grammar 探针只允许本机 HTTP Ollama origin');
  }
  return parsed.origin;
}

function errorFingerprint(status, text) {
  return sha256(`${status}\n${String(text || '')}`);
}

function skippedCase(item) {
  return {
    ...item,
    status: 'SKIPPED',
    schemaSha256: null,
    httpStatus: null,
    resolvedModelVerified: false,
    errorCode: 'blocked_by_prior_failure',
    errorFingerprint: null,
  };
}

async function readJsonResponse(response, errorCode) {
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      errorCode,
      httpStatus: response.status,
      errorFingerprint: errorFingerprint(response.status, text),
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      errorCode: `${errorCode}_invalid_json`,
      httpStatus: response.status,
      errorFingerprint: errorFingerprint(response.status, text),
    };
  }
}

async function inspectOllama(baseUrl, fetchImpl, timeoutMs) {
  const versionResponse = await fetchImpl(`${baseUrl}/api/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const version = await readJsonResponse(versionResponse, 'version_http_error');
  if (!version.ok) return { ok: false, failure: version };
  const tagsResponse = await fetchImpl(`${baseUrl}/api/tags`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const tags = await readJsonResponse(tagsResponse, 'tags_http_error');
  if (!tags.ok) return { ok: false, failure: tags };
  const models = Array.isArray(tags.value?.models) ? tags.value.models : [];
  const matched = models.find((item) =>
    item?.name === REFLECTION_GRAMMAR_MODEL ||
    item?.model === REFLECTION_GRAMMAR_MODEL
  );
  if (!matched) {
    return {
      ok: false,
      failure: {
        errorCode: 'required_model_missing',
        httpStatus: 200,
        errorFingerprint: sha256(
          models.map((item) => String(item?.name || item?.model || ''))
            .sort()
            .join('\n'),
        ),
      },
    };
  }
  const digest = typeof matched.digest === 'string' ? matched.digest : '';
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    return {
      ok: false,
      failure: {
        errorCode: 'model_digest_missing',
        httpStatus: 200,
        errorFingerprint: sha256(String(matched.digest || '')),
      },
    };
  }
  return {
    ok: true,
    version: typeof version.value?.version === 'string'
      ? version.value.version
      : null,
    model: {
      requested: REFLECTION_GRAMMAR_MODEL,
      resolved: REFLECTION_GRAMMAR_MODEL,
      digest,
      family: typeof matched.details?.family === 'string'
        ? matched.details.family
        : null,
      parameterSize: typeof matched.details?.parameter_size === 'string'
        ? matched.details.parameter_size
        : null,
    },
  };
}

function failedReport({
  startedAt,
  baseUrl,
  failure,
  cases = [],
  metadataCalls = 0,
  evidenceMode = 'real_ollama',
}) {
  return {
    format: RECEIPT_FORMAT,
    status: 'FAIL',
    evidenceMode,
    startedAt,
    completedAt: new Date().toISOString(),
    ollama: { baseUrl, version: null },
    model: {
      requested: REFLECTION_GRAMMAR_MODEL,
      resolved: null,
      digest: null,
      family: null,
      parameterSize: null,
    },
    providerCalls: cases.filter((item) => item.status !== 'SKIPPED').length,
    metadataCalls,
    errorCode: failure.errorCode,
    errorFingerprint: failure.errorFingerprint,
    cases: cases.length > 0 ? cases : CASES.map(skippedCase),
  };
}

async function runReflectionGrammarProbeInternal({
  baseUrl = DEFAULT_OLLAMA_URL,
  fetchImpl,
  schemaFactory,
  timeoutMs = 120_000,
  evidenceMode,
}) {
  const startedAt = new Date().toISOString();
  let metadataCalls = 0;
  let normalizedBaseUrl;
  try {
    normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  } catch (error) {
    return failedReport({
      startedAt,
      baseUrl: null,
      failure: {
        errorCode: 'invalid_ollama_url',
        errorFingerprint: sha256(
          error instanceof Error ? error.message : String(error),
        ),
      },
      evidenceMode,
    });
  }
  let inspected;
  try {
    inspected = await inspectOllama(
      normalizedBaseUrl,
      async (...args) => {
        metadataCalls += 1;
        return fetchImpl(...args);
      },
      timeoutMs,
    );
  } catch (error) {
    return failedReport({
      startedAt,
      baseUrl: normalizedBaseUrl,
      failure: {
        errorCode: 'ollama_transport_error',
        errorFingerprint: sha256(
          error instanceof Error ? error.message : String(error),
        ),
      },
      metadataCalls,
      evidenceMode,
    });
  }
  if (!inspected.ok) {
    return failedReport({
      startedAt,
      baseUrl: normalizedBaseUrl,
      failure: inspected.failure,
      metadataCalls,
      evidenceMode,
    });
  }
  if (typeof schemaFactory !== 'function') {
    throw new Error('reflection grammar 探针缺少实际 schema factory');
  }

  const results = [];
  for (const item of CASES) {
    const schemaInput = {
      phase: item.phase,
      retryMode: item.retryMode === 'compact' ? 'compact' : undefined,
    };
    const format = schemaFactory(schemaInput);
    const schemaSha256 = sha256(JSON.stringify(format));
    let response;
    try {
      response = await fetchImpl(`${normalizedBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: REFLECTION_GRAMMAR_MODEL,
          stream: false,
          think: false,
          keep_alive: '15m',
          format,
          options: { temperature: 0, seed: 42, num_predict: 16 },
          messages: [
            {
              role: 'system',
              content: '只按 format 返回 JSON，candidates 必须为空数组。',
            },
            { role: 'user', content: '{"turns":[]}' },
          ],
        }),
      });
    } catch (error) {
      results.push({
        ...item,
        status: 'FAIL',
        schemaSha256,
        httpStatus: null,
        resolvedModelVerified: false,
        errorCode: 'chat_transport_error',
        errorFingerprint: sha256(
          error instanceof Error ? error.message : String(error),
        ),
      });
      break;
    }
    const text = await response.text();
    if (!response.ok) {
      results.push({
        ...item,
        status: 'FAIL',
        schemaSha256,
        httpStatus: response.status,
        resolvedModelVerified: false,
        errorCode: response.status === 400 && /grammar/iu.test(text)
          ? 'grammar_compile_http_400'
          : 'chat_http_error',
        errorFingerprint: errorFingerprint(response.status, text),
      });
      break;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      results.push({
        ...item,
        status: 'FAIL',
        schemaSha256,
        httpStatus: response.status,
        resolvedModelVerified: false,
        errorCode: 'chat_response_invalid_json',
        errorFingerprint: errorFingerprint(response.status, text),
      });
      break;
    }
    if (payload?.model !== REFLECTION_GRAMMAR_MODEL) {
      results.push({
        ...item,
        status: 'FAIL',
        schemaSha256,
        httpStatus: response.status,
        resolvedModelVerified: false,
        errorCode: 'model_substitution',
        errorFingerprint: sha256(String(payload?.model || 'missing')),
      });
      break;
    }
    let generated;
    try {
      generated = JSON.parse(payload?.message?.content);
    } catch {
      generated = null;
    }
    if (!generated || !Array.isArray(generated.candidates)) {
      results.push({
        ...item,
        status: 'FAIL',
        schemaSha256,
        httpStatus: response.status,
        resolvedModelVerified: true,
        errorCode: 'schema_output_invalid',
        errorFingerprint: sha256(String(payload?.message?.content || '')),
      });
      break;
    }
    results.push({
      ...item,
      status: 'PASS',
      schemaSha256,
      httpStatus: response.status,
      resolvedModelVerified: true,
      errorCode: null,
      errorFingerprint: null,
    });
  }
  while (results.length < CASES.length) {
    results.push(skippedCase(CASES[results.length]));
  }
  const status = results.every((item) => item.status === 'PASS')
    ? 'PASS'
    : 'FAIL';
  return {
    format: RECEIPT_FORMAT,
    status,
    evidenceMode,
    startedAt,
    completedAt: new Date().toISOString(),
    ollama: {
      baseUrl: normalizedBaseUrl,
      version: inspected.version,
    },
    model: inspected.model,
    providerCalls: results.filter((item) => item.status !== 'SKIPPED').length,
    metadataCalls,
    errorCode: status === 'FAIL'
      ? results.find((item) => item.status === 'FAIL')?.errorCode || 'unknown'
      : null,
    errorFingerprint: status === 'FAIL'
      ? results.find((item) => item.status === 'FAIL')?.errorFingerprint || null
      : null,
    cases: results,
  };
}

export async function runReflectionGrammarProbe({
  baseUrl = DEFAULT_OLLAMA_URL,
  fetchImpl = globalThis.fetch,
  schemaFactory,
  timeoutMs = 120_000,
} = {}) {
  return runReflectionGrammarProbeInternal({
    baseUrl,
    fetchImpl,
    schemaFactory,
    timeoutMs,
    evidenceMode: 'test_injected',
  });
}

async function runRealReflectionGrammarProbe({
  baseUrl,
  schemaFactory,
}) {
  return runReflectionGrammarProbeInternal({
    baseUrl,
    fetchImpl: CLI_NATIVE_FETCH,
    schemaFactory,
    timeoutMs: 120_000,
    evidenceMode: 'real_ollama',
  });
}

function writeReflectionGrammarReceiptFile(
  report,
  parentDirectory,
) {
  const runId = report.runId || createQaRunId();
  const runRoot = createPrivateQaRunRoot(
    path.resolve(parentDirectory),
    'run-',
  );
  const receiptPath = immutableQaPath(
    runRoot,
    'reflection-grammar',
    runId,
    'json',
  );
  const payload = { ...report, runId };
  const written = writeImmutableQaFile(
    receiptPath,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  return { ...written, runRoot, runId };
}

export function writeReflectionGrammarReceipt(
  report,
  {
    parentDirectory = path.resolve(
      '.memory-bridge-private',
      'reflection-grammar',
    ),
  } = {},
) {
  if (report.status === 'PASS') {
    throw new Error('导出写入器不得写 PASS；真实 PASS 仅允许 CLI 私有路径');
  }
  return writeReflectionGrammarReceiptFile(report, parentDirectory);
}

function parseArguments(argv) {
  const options = {
    baseUrl: DEFAULT_OLLAMA_URL,
    parentDirectory: path.resolve(
      '.memory-bridge-private',
      'reflection-grammar',
    ),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--ollama-url') options.baseUrl = argv[++index];
    else if (value === '--receipt-parent') {
      options.parentDirectory = path.resolve(argv[++index]);
    } else {
      throw new Error(`未知参数：${value}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const { reflectionResponseSchemaFor } = await import(
    '../dist/server/memory-reflection.js'
  );
  const report = await runRealReflectionGrammarProbe({
    baseUrl: options.baseUrl,
    schemaFactory: reflectionResponseSchemaFor,
  });
  const implementation = buildQaImplementationEvidence({
    projectRoot,
    schemaVersion: null,
    relativeFiles: [
      'package.json',
      'package-lock.json',
      'scripts/qa-receipt-lib.mjs',
      'scripts/verify-reflection-grammar.mjs',
      'src/server/memory-reflection.ts',
      'dist/server/memory-reflection.js',
      'tests/verify-reflection-grammar.test.mjs',
    ],
    runtimeDirectories: [],
  });
  const receipt = writeReflectionGrammarReceiptFile(
    { ...report, implementation },
    options.parentDirectory,
  );
  console.log(JSON.stringify({
    status: report.status,
    model: report.model,
    ollama: report.ollama,
    providerCalls: report.providerCalls,
    errorCode: report.errorCode,
    errorFingerprint: report.errorFingerprint,
    receiptPath: receipt.path,
    receiptSha256: receipt.sha256,
  }, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}

const isDirectExecution = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
