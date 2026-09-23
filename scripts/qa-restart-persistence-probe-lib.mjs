export function finiteNonNegativeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function finitePositiveNumber(value) {
  const parsed = finiteNonNegativeNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function reliableRecallLatency(rewriteDetails, retrievalDurationMs) {
  if (!rewriteDetails || typeof rewriteDetails !== 'object') return null;
  const queryUnderstandingMs = finiteNonNegativeNumber(
    rewriteDetails.latencyMs,
  );
  const retrievalTraceMs = finiteNonNegativeNumber(retrievalDurationMs);
  if (queryUnderstandingMs === null || retrievalTraceMs === null) return null;
  return {
    queryUnderstandingMs,
    retrievalTraceMs,
    reliableRecallMs: Number(
      (queryUnderstandingMs + retrievalTraceMs).toFixed(3),
    ),
  };
}

export function parseCompatAuditLog(
  raw,
  prefix = '[ollama-compat] ',
) {
  const events = [];
  const canonicalLines = [];
  let invalidPrefixedLineCount = 0;
  for (const line of String(raw || '').split(/\r?\n/u)) {
    if (!line.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(line.slice(prefix.length));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        invalidPrefixedLineCount += 1;
        continue;
      }
      events.push(parsed);
      canonicalLines.push(JSON.stringify(parsed));
    } catch {
      invalidPrefixedLineCount += 1;
    }
  }
  return {
    events,
    canonicalJsonl: canonicalLines.length > 0
      ? `${canonicalLines.join('\n')}\n`
      : '',
    invalidPrefixedLineCount,
  };
}

export const REQUIRED_RETRIEVAL_TRACE_STAGES = Object.freeze([
  'request',
  'rewrite',
  'channels',
  'fusion',
  'semantic',
  'rerank',
  'selection',
  'context',
  'result',
]);

export function completeRetrievalTraceStages(events) {
  if (!Array.isArray(events)) return false;
  if (
    events[0]?.stage !== 'request' ||
    events.at(-2)?.stage !== 'context' ||
    events.at(-1)?.stage !== 'result'
  ) return false;
  const pipelineStages = REQUIRED_RETRIEVAL_TRACE_STAGES.slice(1, -2);
  const pipelineEvents = events.slice(1, -2);
  let offset = 0;
  let completeAttempts = 0;
  while (offset < pipelineEvents.length) {
    const candidate = pipelineEvents.slice(
      offset,
      offset + pipelineStages.length,
    );
    if (
      candidate.length === pipelineStages.length &&
      candidate.every(
        (event, index) => event?.stage === pipelineStages[index],
      )
    ) {
      completeAttempts += 1;
      offset += pipelineStages.length;
      continue;
    }
    const event = pipelineEvents[offset];
    const details = event?.details || event?.detail || {};
    if (
      offset === pipelineEvents.length - 1 &&
      event?.stage === 'rewrite' &&
      (
        details.reason === 'quality_fallback_not_useful' ||
        details.reason === 'quality_fallback_no_query_delta'
      ) &&
      details.skipped === true
    ) {
      offset += 1;
      continue;
    }
    return false;
  }
  return completeAttempts >= 1;
}

const CLARIFICATION_PATTERN =
  /(?:请(?:说明|确认|问|补充)|你是指|具体(?:是|指)?|哪(?:一|个)|能否(?:说明|确认)|可以(?:说明|确认))/u;
const INTERNAL_PROVENANCE_PATTERN =
  /\[派生摘要:[^\]\r\n]+\]/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function evaluateProbeAnswer(expectation, answer) {
  const normalizedAnswer = String(answer || '').normalize('NFKC').trim();
  const expected = Array.isArray(expectation?.expected)
    ? expectation.expected.map(String)
    : [];
  const forbidden = Array.isArray(expectation?.forbidden)
    ? expectation.forbidden.map(String)
    : [];
  const matchedExpected = expected.filter((value) =>
    normalizedAnswer.includes(value)
  );
  const matchedForbidden = forbidden.filter((value) =>
    normalizedAnswer.includes(value)
  );
  const containsAbstention = normalizedAnswer === '不知道。';
  const containsGroundingPrefix = normalizedAnswer.startsWith(
    '根据长期记忆:',
  );
  const containsInternalProvenance = INTERNAL_PROVENANCE_PATTERN.test(
    normalizedAnswer,
  );
  const containsClarification =
    /[?？]/u.test(normalizedAnswer) &&
    CLARIFICATION_PATTERN.test(normalizedAnswer);
  const expectedResult = expectation?.expectedResult;
  const resultMatched =
    expectedResult === 'grounded'
      ? containsGroundingPrefix &&
        expected.length > 0 &&
        matchedExpected.length === expected.length
      : expectedResult === 'abstain'
        ? containsAbstention
      : expectedResult === 'clarify'
          ? containsClarification
          : expectedResult === 'passthrough'
            ? normalizedAnswer.length > 0 &&
              !containsAbstention &&
              !containsGroundingPrefix
          : false;

  return {
    passed:
      resultMatched &&
      matchedForbidden.length === 0 &&
      !containsInternalProvenance,
    expectedResult,
    resultMatched,
    matchedExpected,
    matchedForbidden,
    containsAbstention,
    containsGroundingPrefix,
    containsClarification,
    containsInternalProvenance,
  };
}

export function evaluateCompatAudit(
  expectation,
  requestId,
  events,
) {
  const normalizedRequestId = typeof requestId === 'string'
    ? requestId.trim()
    : '';
  const requestIdValid = UUID_V4_PATTERN.test(normalizedRequestId);
  const requestEvents = Array.isArray(events)
    ? events.filter((event) =>
        event &&
        typeof event === 'object' &&
        event.requestId === normalizedRequestId
      )
    : [];
  const lifecycleCompleted = requestEvents.some((event) =>
    event.action === 'memory_lifecycle' &&
    event.result === 'before_model_completed'
  );
  const proxySuccessEvent = requestEvents.find((event) =>
    event.action === 'proxy_result' && event.result === 'success'
  );
  const expectedAction = expectation?.expectedResult === 'grounded'
    ? 'grounded_recall_repair'
    : expectation?.expectedResult === 'abstain'
      ? 'zero_recall_abstention'
      : null;
  const expectedReason = expectation?.expectedAuditReason || null;
  const forcedEvents = requestEvents.filter((event) =>
    (
      event.action === 'grounded_recall_repair' ||
      event.action === 'zero_recall_abstention'
    ) && event.result === 'forced'
  );
  const forcedEvent = forcedEvents.length === 1
    ? forcedEvents[0]
    : null;
  const forcedEventsMatched = expectedAction === null
    ? forcedEvents.length === 0
    : forcedEvents.length === 1 && forcedEvent?.action === expectedAction;
  const reasonMatched = expectedReason === null
    ? true
    : forcedEvent?.memoryContextReason === expectedReason;
  const expectedTraceId = typeof expectation?.expectedTraceId === 'string'
    ? expectation.expectedTraceId
    : null;
  const traceMatched = expectedTraceId === null
    ? true
    : UUID_V4_PATTERN.test(expectedTraceId) &&
      proxySuccessEvent?.retrievalTraceId === expectedTraceId &&
      (
        expectedAction === null ||
        forcedEvent?.retrievalTraceId === expectedTraceId
      );

  return {
    passed:
      requestIdValid &&
      lifecycleCompleted &&
      Boolean(proxySuccessEvent) &&
      forcedEventsMatched &&
      reasonMatched &&
      traceMatched,
    requestIdPresent: normalizedRequestId.length > 0,
    requestIdValid,
    lifecycleCompleted,
    proxySucceeded: Boolean(proxySuccessEvent),
    expectedAction,
    observedAction: forcedEvent?.action || null,
    forcedEventCount: forcedEvents.length,
    expectedReason,
    observedReason: forcedEvent?.memoryContextReason || null,
    expectedTraceId,
    observedTraceId: proxySuccessEvent?.retrievalTraceId || null,
    traceMatched,
    eventCount: requestEvents.length,
  };
}
