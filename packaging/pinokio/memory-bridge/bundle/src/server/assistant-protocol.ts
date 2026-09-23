import { containsCredentialSecret } from './memory-extractor.js';

export type AssistantActionType = 'emotion' | 'motion';

export interface AssistantAction {
  readonly type: AssistantActionType;
  readonly payload: Readonly<{ name: string }>;
}

export type AssistantProtocolReason =
  | 'known_action_extracted'
  | 'credential_redacted';

export interface SanitizedAssistantProtocol {
  readonly displayContent: string;
  readonly actions: readonly AssistantAction[];
  readonly reasons: readonly AssistantProtocolReason[];
}

export type AssistantProtocolQuarantineCode =
  | 'truncated_protocol'
  | 'malformed_action'
  | 'unknown_action'
  | 'nested_protocol'
  | 'forbidden_protocol'
  | 'unknown_protocol'
  | 'unauthorized_action'
  | 'action_limit_exceeded';

export class AssistantProtocolQuarantineError extends Error {
  override readonly name = 'AssistantProtocolQuarantineError';

  constructor(readonly code: AssistantProtocolQuarantineCode) {
    super(`assistant protocol quarantined: ${code}`);
  }
}

export const REDACTED_ASSISTANT_CREDENTIAL =
  '[credential redacted before persistence]';

const ACTION_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const MAX_ACTION_COUNT = 8;
const MAX_ACTION_WRAPPER_BYTES = 1024;
const MAX_ACTION_TOTAL_BYTES = 8192;
const REGISTERED_ACTION_NAMES: Readonly<
  Record<AssistantActionType, ReadonlySet<string>>
> = Object.freeze({
  emotion: new Set([
    'neutral', 'happy', 'sad', 'angry', 'surprised', 'worried',
    'calm', 'excited',
  ]),
  motion: new Set([
    'idle', 'wave', 'nod', 'shake_head', 'bow',
  ]),
});
const FORBIDDEN_PROTOCOL_PATTERN =
  /(?:<\/?tool_(?:call|result)\b|\[Memory Bridge 自动长期记忆上下文\]|_memoryContext(?:Context|GroundedFacts|ContextReason|TraceId)|<\|(?:system|developer|assistant|tool)\|>)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function normalizedAction(
  value: Record<string, unknown>,
): AssistantAction {
  const keys = Object.keys(value);
  let type: unknown;
  let payload: unknown;
  if (
    keys.length === 1 &&
    (keys[0] === 'emotion' || keys[0] === 'motion')
  ) {
    type = keys[0];
    payload = { name: value[keys[0]] };
  } else {
    type = value.type;
    payload = value.payload;
    if (
      keys.length !== 2 ||
      !keys.includes('type') ||
      !keys.includes('payload')
    ) {
      throw new AssistantProtocolQuarantineError('malformed_action');
    }
  }
  if (type !== 'emotion' && type !== 'motion') {
    throw new AssistantProtocolQuarantineError('unknown_action');
  }
  if (!isRecord(payload)) {
    throw new AssistantProtocolQuarantineError('malformed_action');
  }
  const payloadKeys = Object.keys(payload);
  if (
    payloadKeys.length !== 1 ||
    payloadKeys[0] !== 'name' ||
    typeof payload.name !== 'string' ||
    !ACTION_NAME_PATTERN.test(payload.name)
  ) {
    throw new AssistantProtocolQuarantineError('malformed_action');
  }
  if (!REGISTERED_ACTION_NAMES[type].has(payload.name)) {
    throw new AssistantProtocolQuarantineError('unknown_action');
  }
  return Object.freeze({
    type,
    payload: Object.freeze({ name: payload.name }),
  });
}

function parseAction(value: string): AssistantAction {
  if (value.includes('<|') || value.includes('|>')) {
    throw new AssistantProtocolQuarantineError('nested_protocol');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AssistantProtocolQuarantineError('malformed_action');
  }
  if (!isRecord(parsed)) {
    throw new AssistantProtocolQuarantineError('malformed_action');
  }
  return normalizedAction(parsed);
}

export function sanitizeAssistantProtocol(
  rawContent: string,
): SanitizedAssistantProtocol {
  if (FORBIDDEN_PROTOCOL_PATTERN.test(rawContent)) {
    throw new AssistantProtocolQuarantineError('forbidden_protocol');
  }
  const actions: AssistantAction[] = [];
  let actionBytes = 0;
  let displayContent = '';
  let cursor = 0;
  while (cursor < rawContent.length) {
    const open = rawContent.indexOf('<|ACT', cursor);
    if (open === -1) {
      displayContent += rawContent.slice(cursor);
      break;
    }
    displayContent += rawContent.slice(cursor, open);
    const payloadStart = open + '<|ACT'.length;
    if (!/\s/u.test(rawContent[payloadStart] || '')) {
      throw new AssistantProtocolQuarantineError('malformed_action');
    }
    const close = rawContent.indexOf('|>', payloadStart);
    if (close === -1) {
      throw new AssistantProtocolQuarantineError('truncated_protocol');
    }
    const nested = rawContent.indexOf('<|', payloadStart);
    if (nested !== -1 && nested < close) {
      throw new AssistantProtocolQuarantineError('nested_protocol');
    }
    const wrapperBytes = Buffer.byteLength(
      rawContent.slice(open, close + 2),
      'utf8',
    );
    actionBytes += wrapperBytes;
    if (
      actions.length >= MAX_ACTION_COUNT ||
      wrapperBytes > MAX_ACTION_WRAPPER_BYTES ||
      actionBytes > MAX_ACTION_TOTAL_BYTES
    ) {
      throw new AssistantProtocolQuarantineError(
        'action_limit_exceeded',
      );
    }
    actions.push(parseAction(rawContent.slice(payloadStart, close).trim()));
    cursor = close + 2;
  }
  if (/<\||\|>/u.test(displayContent)) {
    throw new AssistantProtocolQuarantineError('unknown_protocol');
  }
  if (containsCredentialSecret(displayContent)) {
    return Object.freeze({
      displayContent: REDACTED_ASSISTANT_CREDENTIAL,
      actions: Object.freeze(actions),
      reasons: Object.freeze<AssistantProtocolReason[]>([
        'credential_redacted',
      ]),
    });
  }
  return Object.freeze({
    displayContent,
    actions: Object.freeze(actions),
    reasons: Object.freeze<AssistantProtocolReason[]>(
      actions.length > 0 ? ['known_action_extracted'] : [],
    ),
  });
}

function lastStableTextBoundary(
  rawContent: string,
  before = rawContent.length,
): number {
  let boundary = 0;
  for (let index = 0; index < before; index += 1) {
    if (/[。！？!?；;\n\r]/u.test(rawContent[index] || '')) {
      boundary = index + 1;
    }
  }
  return boundary;
}

function stableAssistantPrefixLength(rawContent: string): number {
  let boundary = lastStableTextBoundary(rawContent);
  let open = rawContent.indexOf('<|ACT');
  while (open !== -1 && open < boundary) {
    const close = rawContent.indexOf('|>', open + '<|ACT'.length);
    if (close === -1 || close + 2 > boundary) {
      boundary = lastStableTextBoundary(rawContent, open);
      break;
    }
    open = rawContent.indexOf('<|ACT', close + 2);
  }
  return boundary;
}

export class StreamingAssistantProtocolSanitizer {
  private rawContent = '';
  private emittedDisplayContent = '';

  push(rawDelta: string): string {
    if (!rawDelta) return '';
    this.rawContent += rawDelta;
    const stableLength = stableAssistantPrefixLength(this.rawContent);
    if (stableLength === 0) return '';
    const stable = sanitizeAssistantProtocol(
      this.rawContent.slice(0, stableLength),
    );
    if (!stable.displayContent.startsWith(this.emittedDisplayContent)) {
      throw new AssistantProtocolQuarantineError('forbidden_protocol');
    }
    const displayDelta = stable.displayContent.slice(
      this.emittedDisplayContent.length,
    );
    this.emittedDisplayContent = stable.displayContent;
    return displayDelta;
  }
}
