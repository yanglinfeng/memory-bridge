// 答案工具框架（Answer Tools）：
// 面向"检索结果不足以直接作答、需要确定性计算"的场景，提供
// 统一的工具注册表与一组内置确定性工具（算术、日期运算）。
//
// 架构约定：
// ① 纯模块——不依赖数据库、网络与全局状态，可在任意进程内复用；
// ② 单一注册表——HTTP（/api/tools）与 MCP（answer_* 工具）两个
//    通道共享同一份注册表，新增工具只需 register 一次；
// ③ 确定性优先——内置工具必须是纯计算、无副作用、无 LLM 参与，
//    结果可复现、可审计；
// ④ 安全约束——计算器使用自研词法/逆波兰求值（禁 eval），
//    表达式长度、token 数、结果尺寸均有上限。
//
// 新增工具的步骤：
//   1. 实现 AnswerTool 接口（name/描述/参数说明/execute）；
//   2. 在 answerToolRegistry 上 register；
//   3. HTTP 通道自动出现在 GET /api/tools，MCP 通道如需暴露
//      再在 mcp-server.ts 加一条薄封装（见 answer_* 工具）。

export interface AnswerToolParam {
  name: string;
  type: 'string' | 'number';
  required: boolean;
  description: string;
}

export interface AnswerToolDescriptor {
  name: string;
  title: string;
  description: string;
  params: AnswerToolParam[];
}

export interface AnswerTool {
  name: string;
  title: string;
  description: string;
  params: AnswerToolParam[];
  /** 纯计算；参数非法时抛 Error（message 面向调用方）。 */
  execute(args: Record<string, unknown>): unknown;
}

export interface AnswerToolInvocationResult {
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;
const MAX_RESULT_JSON_BYTES = 4_096;

export class AnswerToolRegistry {
  private readonly tools = new Map<string, AnswerTool>();

  register(tool: AnswerTool): void {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(
        `工具名不合法：${tool.name}（需匹配 ${TOOL_NAME_PATTERN.source}）`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重复注册：${tool.name}`);
    }
    if (typeof tool.execute !== 'function') {
      throw new Error(`工具缺少 execute：${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnswerToolDescriptor[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      params: tool.params,
    }));
  }

  get(name: string): AnswerTool | undefined {
    return this.tools.get(name);
  }

  /** 统一入口：计时、错误封装、结果尺寸护栏。永不抛出。 */
  async invoke(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<AnswerToolInvocationResult> {
    const started = performance.now();
    const durationMs = () =>
      Number((performance.now() - started).toFixed(3));
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        tool: name,
        ok: false,
        error: `未知工具：${name}`,
        durationMs: durationMs(),
      };
    }
    try {
      const result = tool.execute(args ?? {});
      const json = JSON.stringify(result);
      if (json !== undefined && json.length > MAX_RESULT_JSON_BYTES) {
        return {
          tool: name,
          ok: false,
          error: `工具结果超过 ${MAX_RESULT_JSON_BYTES} 字节上限`,
          durationMs: durationMs(),
        };
      }
      return {
        tool: name,
        ok: true,
        result,
        durationMs: durationMs(),
      };
    } catch (error) {
      return {
        tool: name,
        ok: false,
        error: error instanceof Error
          ? error.message
          : String(error),
        durationMs: durationMs(),
      };
    }
  }
}

// ── 内置工具 1：算术计算器 ────────────────────────────────
// 自研词法分析 + 调度场算法（shunting-yard）+ 逆波兰求值。
// 支持 + - * / % ^ 与括号、一元负号、十进制小数；禁止字母与
// 一切其他符号，杜绝代码注入面。

type ArithmeticToken =
  | { kind: 'number'; value: number }
  | { kind: 'operator'; value: '+' | '-' | '*' | '/' | '%' | '^' | 'u-' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const ARITHMETIC_MAX_LENGTH = 256;
const ARITHMETIC_MAX_TOKENS = 96;

function tokenizeArithmetic(
  expression: string,
): ArithmeticToken[] {
  const tokens: ArithmeticToken[] = [];
  let index = 0;
  let previousSignificant: 'number' | 'operator' | 'lparen' | 'rparen' | null =
    null;
  while (index < expression.length) {
    const char = expression[index];
    if (char === ' ' || char === '\t') {
      index += 1;
      continue;
    }
    if (/[0-9]/u.test(char) || char === '.') {
      const start = index;
      let sawDot = false;
      while (index < expression.length) {
        const next = expression[index];
        if (next === '.') {
          if (sawDot) throw new Error('计算表达式含非法数字（多个小数点）');
          sawDot = true;
        } else if (!/[0-9]/u.test(next)) break;
        index += 1;
      }
      const raw = expression.slice(start, index);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`计算表达式含非法数字：${raw}`);
      }
      tokens.push({ kind: 'number', value });
      previousSignificant = 'number';
      continue;
    }
    if ('+-*/%^'.includes(char)) {
      const unary =
        char === '-' &&
        (previousSignificant === null ||
          previousSignificant === 'operator' ||
          previousSignificant === 'lparen');
      tokens.push(
        unary
          ? { kind: 'operator', value: 'u-' }
          : {
              kind: 'operator',
              value: char as '+' | '-' | '*' | '/' | '%' | '^',
            },
      );
      previousSignificant = 'operator';
      index += 1;
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'lparen' });
      previousSignificant = 'lparen';
      index += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen' });
      previousSignificant = 'rparen';
      index += 1;
      continue;
    }
    throw new Error(`计算表达式含不允许的字符：${char}（仅允许数字与 + - * / % ^ ( )）`);
  }
  if (tokens.length === 0) throw new Error('计算表达式为空');
  if (tokens.length > ARITHMETIC_MAX_TOKENS) {
    throw new Error(
      `计算表达式过长（最多 ${ARITHMETIC_MAX_TOKENS} 个 token）`,
    );
  }
  return tokens;
}

const OPERATOR_PRECEDENCE: Record<string, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '%': 2,
  '^': 3,
  'u-': 4,
};

const RIGHT_ASSOCIATIVE = new Set(['^', 'u-']);

function applyOperator(
  operator: string,
  operands: number[],
): void {
  if (operator === 'u-') {
    const value = operands.pop();
    if (value === undefined) throw new Error('计算表达式结构非法');
    operands.push(-value);
    return;
  }
  const right = operands.pop();
  const left = operands.pop();
  if (left === undefined || right === undefined) {
    throw new Error('计算表达式结构非法');
  }
  switch (operator) {
    case '+': operands.push(left + right); return;
    case '-': operands.push(left - right); return;
    case '*': operands.push(left * right); return;
    case '/':
      if (right === 0) throw new Error('除数为 0');
      operands.push(left / right);
      return;
    case '%':
      if (right === 0) throw new Error('取模除数为 0');
      operands.push(left % right);
      return;
    case '^':
      operands.push(Math.pow(left, right));
      return;
    default:
      throw new Error(`未知运算符：${operator}`);
  }
}

export function evaluateArithmeticExpression(
  expression: string,
): number {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new Error('expression 必须是非空字符串');
  }
  if (expression.length > ARITHMETIC_MAX_LENGTH) {
    throw new Error(
      `计算表达式过长（最多 ${ARITHMETIC_MAX_LENGTH} 字符）`,
    );
  }
  const tokens = tokenizeArithmetic(expression);
  const output: ArithmeticToken[] = [];
  const operatorStack: ArithmeticToken[] = [];
  for (const token of tokens) {
    if (token.kind === 'number') {
      output.push(token);
    } else if (token.kind === 'operator') {
      while (operatorStack.length > 0) {
        const top = operatorStack[operatorStack.length - 1];
        if (top.kind !== 'operator') break;
        const precedenceTop = OPERATOR_PRECEDENCE[top.value];
        const precedenceCurrent = OPERATOR_PRECEDENCE[token.value];
        if (
          precedenceTop > precedenceCurrent ||
          (precedenceTop === precedenceCurrent &&
            !RIGHT_ASSOCIATIVE.has(token.value))
        ) {
          output.push(operatorStack.pop() as ArithmeticToken);
        } else break;
      }
      operatorStack.push(token);
    } else if (token.kind === 'lparen') {
      operatorStack.push(token);
    } else {
      let matched = false;
      while (operatorStack.length > 0) {
        const top = operatorStack.pop() as ArithmeticToken;
        if (top.kind === 'lparen') {
          matched = true;
          break;
        }
        output.push(top);
      }
      if (!matched) throw new Error('括号不匹配');
    }
  }
  while (operatorStack.length > 0) {
    const top = operatorStack.pop() as ArithmeticToken;
    if (top.kind === 'lparen') throw new Error('括号不匹配');
    output.push(top);
  }
  const operands: number[] = [];
  for (const token of output) {
    if (token.kind === 'number') {
      operands.push(token.value);
    } else if (token.kind === 'operator') {
      applyOperator(token.value, operands);
    }
  }
  if (operands.length !== 1) {
    throw new Error('计算表达式结构非法');
  }
  const result = operands[0];
  if (!Number.isFinite(result)) {
    throw new Error('计算结果不是有限数');
  }
  // 消解浮点噪声（0.1+0.2 → 0.3）
  return Number(result.toPrecision(12));
}

function requireString(
  args: Record<string, unknown>,
  field: string,
): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

// ── 内置工具 2/3：日期运算 ────────────────────────────────

const DATE_ONLY_PATTERNS = [
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/u,
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/u,
  /^(\d{4})年(\d{1,2})月(\d{1,2})[日号]?$/u,
];

const MAX_DATE_SPAN_DAYS = 400_000;

/** 解析日期输入：支持 ISO（YYYY-MM-DD / 完整 ISO 时间）、YYYY/MM/DD、中文日期。 */
export function parseDateInput(raw: string, field: string): Date {
  for (const pattern of DATE_ONLY_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        throw new Error(`${field} 日期分量非法：${raw}`);
      }
      const date = new Date(Date.UTC(year, month - 1, day));
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      ) {
        throw new Error(`${field} 不是真实存在的日期：${raw}`);
      }
      return date;
    }
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `${field} 无法解析为日期：${raw}（支持 ISO、YYYY/MM/DD、YYYY年M月D日）`,
    );
  }
  return parsed;
}

function utcCalendar(date: Date): {
  year: number;
  month: number;
  day: number;
} {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

const calculatorTool: AnswerTool = {
  name: 'calculator',
  title: '算术计算器',
  description:
    '对算术表达式做确定性求值，支持 + - * / % ^ 与括号、一元负号。适用于把召回事实中的多个数值做加减乘除（如金额合计、单价×数量）。',
  params: [
    {
      name: 'expression',
      type: 'string',
      required: true,
      description: '算术表达式，如 "(1234.5 + 678.9) * 2"',
    },
  ],
  execute(args) {
    const expression = requireString(args, 'expression');
    const value = evaluateArithmeticExpression(expression);
    return { expression, value };
  },
};

const dateDiffTool: AnswerTool = {
  name: 'date_diff',
  title: '日期差计算',
  description:
    '计算两个日期之间的天数差与年/月/日拆分。适用于"间隔了多少天""过去了多久"类问题。日期支持 ISO、YYYY/MM/DD、中文（2024年3月5日）。',
  params: [
    {
      name: 'from',
      type: 'string',
      required: true,
      description: '起始日期',
    },
    {
      name: 'to',
      type: 'string',
      required: true,
      description: '结束日期',
    },
  ],
  execute(args) {
    const fromRaw = requireString(args, 'from');
    const toRaw = requireString(args, 'to');
    const from = parseDateInput(fromRaw, 'from');
    const to = parseDateInput(toRaw, 'to');
    const diffMs = to.getTime() - from.getTime();
    const daysExact = diffMs / 86_400_000;
    const fromCalendar = utcCalendar(from);
    const toCalendar = utcCalendar(to);
    let years = toCalendar.year - fromCalendar.year;
    let months = toCalendar.month - fromCalendar.month;
    let days = toCalendar.day - fromCalendar.day;
    if (days < 0) {
      months -= 1;
      const anchorMonthIndex = (toCalendar.month - 2 + 12) % 12;
      const anchorYear = anchorMonthIndex === 11
        ? toCalendar.year - 1
        : toCalendar.year;
      days += daysInUtcMonth(anchorYear, anchorMonthIndex);
    }
    if (months < 0) {
      years -= 1;
      months += 12;
    }
    if (Math.abs(daysExact) > MAX_DATE_SPAN_DAYS) {
      throw new Error(
        `日期跨度过大（上限 ±${MAX_DATE_SPAN_DAYS} 天）`,
      );
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      days: Number(daysExact.toFixed(4)),
      wholeDays: Math.round(daysExact),
      calendar: { years, months, days },
    };
  },
};

const dateShiftTool: AnswerTool = {
  name: 'date_shift',
  title: '日期平移',
  description:
    '把日期向前/向后平移指定天数（days 可为负数）。适用于"X 天后是几号""提前 N 天是哪天"类问题。',
  params: [
    {
      name: 'date',
      type: 'string',
      required: true,
      description: '基准日期',
    },
    {
      name: 'days',
      type: 'number',
      required: true,
      description: '平移天数，可为负数',
    },
  ],
  execute(args) {
    const dateRaw = requireString(args, 'date');
    const days = args.days;
    if (
      typeof days !== 'number' ||
      !Number.isInteger(days) ||
      Math.abs(days) > MAX_DATE_SPAN_DAYS
    ) {
      throw new Error(
        `days 必须是整数且绝对值 ≤ ${MAX_DATE_SPAN_DAYS}`,
      );
    }
    const base = parseDateInput(dateRaw, 'date');
    const shifted = new Date(base.getTime() + days * 86_400_000);
    return {
      date: base.toISOString(),
      days,
      result: shifted.toISOString().slice(0, 10),
      weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
        shifted.getUTCDay()
      ],
    };
  },
};

export const answerToolRegistry = new AnswerToolRegistry();
answerToolRegistry.register(calculatorTool);
answerToolRegistry.register(dateDiffTool);
answerToolRegistry.register(dateShiftTool);
