const DIMENSIONS = 384;

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TOPIC_FILLER_PHRASES = [
  '用户最喜欢的',
  '用户最喜欢',
  '用户喜欢怎样的',
  '用户喜欢',
  '用户现在的',
  '用户当前的',
  '这个用户的',
  '这个用户',
  '用户的',
  '用户',
  '现在的',
  '当前的',
  '常用的',
  '通常的',
  '哪一种',
  '哪一个',
  '哪一位',
  '最喜欢的',
  '最喜欢',
  '喜欢的',
  '偏好是什么',
  '有什么偏好',
  '喜欢',
  '偏好',
  '是什么',
  '有什么',
  '什么',
  '怎样的',
  '怎么样',
  '怎样',
  '怎么',
  '如何',
  '现在',
  '当前',
  '常用',
  '通常',
  '一般',
  '使用',
  '正在',
  '应该',
  '需要',
  '可以',
  '是否',
  '信息',
  '情况',
  '内容',
  '名字',
  '名称',
  '请问',
  '告诉我',
  '关于',
  '这个',
  '那个',
  '哪些',
  '哪里',
  '何时',
  '为何',
  'the current user',
  'the user',
  'current user',
  'favorite',
  'preference',
  'prefer',
  'likes',
  'like',
  'what is',
  'what',
  'which',
  'how',
] as const;

const ENGLISH_TOPIC_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'at',
  'be',
  'by',
  'current',
  'currently',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'his',
  'her',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'name',
  'of',
  'on',
  'or',
  'our',
  's',
  'should',
  'tell',
  'that',
  'their',
  'them',
  'they',
  'this',
  'to',
  'use',
  'uses',
  'using',
  'user',
  'users',
  'we',
  'with',
  'you',
  'your',
]);

const TOPIC_CONCEPTS = [
  {
    token: 'concept:dev-editor',
    aliases: [
      '代码编辑器',
      '文本编辑器',
      '开发环境',
      '集成开发环境',
      'visual studio code',
      'vs code',
      'vscode',
      'code editor',
      'editor',
      'ide',
    ],
  },
  {
    token: 'concept:initial-data',
    aliases: [
      '第一次启动',
      '第一次打开',
      '首次启动',
      '首次打开',
      '初次启动',
      '初次打开',
      '初始化数据',
      '初始数据',
      '空数据',
      '演示数据',
      'first launch',
      'first start',
      'initial data',
    ],
  },
  {
    token: 'concept:coffee',
    aliases: [
      '卡布奇诺',
      'espresso',
      'coffee',
      'latte',
      '咖啡',
      '拿铁',
      '摩卡',
      '美式',
      '浓缩',
    ],
  },
  {
    token: 'concept:dessert',
    aliases: [
      '提拉米苏',
      '甜品',
      '甜点',
      '蛋糕',
      'dessert',
    ],
  },
  {
    token: 'concept:address',
    aliases: [
      '家庭住址',
      '居住地址',
      '家庭地址',
      '住址',
      '地址',
      '住在哪里',
      'address',
    ],
  },
  {
    token: 'concept:occupation',
    aliases: [
      '工作是什么',
      '做什么工作',
      '从事什么',
      '职业',
      '职位',
      '职务',
      'occupation',
      'profession',
      'job',
    ],
  },
  {
    token: 'concept:pet',
    aliases: ['宠物', '猫咪', '小猫', '狗狗', '小狗', 'pet'],
  },
  {
    token: 'concept:transport-preference',
    aliases: [
      '出行',
      '出差',
      '通勤',
      '交通方式',
      '乘坐',
      '高铁',
      '飞机',
      '自行车',
      'travel',
      'commute',
      'transport',
    ],
  },
] as const;

const PROGRAMMING_LANGUAGE_ALIASES = [
  'programming language',
  'coding language',
  'typescript',
  'javascript',
  '编程语言',
  '开发语言',
  '代码语言',
  'python',
  'golang',
  'kotlin',
  'swift',
  'rust',
  'ruby',
  'java',
  'php',
  'c++',
  'c#',
] as const;

const SPOKEN_LANGUAGE_ALIASES = [
  'preferred language',
  'spoken language',
  '中文交流',
  '英文交流',
  '语言回复',
  '回复语言',
  '语言交流',
  '交流语言',
  '沟通语言',
  '偏好的语言',
  '普通话',
  '粤语',
  '汉语',
  '中文',
  '英语',
  '英文',
] as const;

function normalizeTopicText(value: string): string {
  let normalized = normalizeText(value);
  for (const phrase of TOPIC_FILLER_PHRASES) {
    normalized = normalized.replaceAll(phrase, ' ');
  }
  return normalized
    .replaceAll('的', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topicTokens(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const tokens = new Set<string>();
  for (const concept of TOPIC_CONCEPTS) {
    if (concept.aliases.some((alias) => normalized.includes(alias))) {
      tokens.add(concept.token);
    }
  }
  const hasProgrammingLanguage = PROGRAMMING_LANGUAGE_ALIASES.some(
    (alias) => normalized.includes(alias),
  );
  if (hasProgrammingLanguage) {
    tokens.add('concept:programming-language');
  }
  if (
    SPOKEN_LANGUAGE_ALIASES.some((alias) => normalized.includes(alias)) ||
    (normalized.includes('语言') && !hasProgrammingLanguage)
  ) {
    tokens.add('concept:spoken-language');
  }

  const topicText = normalizeTopicText(normalized);
  for (const segment of topicText.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) || []) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      if (segment.length < 2) continue;
      for (let index = 0; index < segment.length - 1; index += 1) {
        tokens.add(segment.slice(index, index + 2));
      }
      continue;
    }

    if (
      segment.length >= 2 &&
      !ENGLISH_TOPIC_STOP_WORDS.has(segment)
    ) {
      tokens.add(segment);
    }
  }

  return [...tokens];
}

function hashToken(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const tokens = normalized.split(' ').filter(Boolean);
  const ideographs = [...normalized.replace(/[^\p{Script=Han}]/gu, '')];

  for (let index = 0; index < ideographs.length; index += 1) {
    tokens.push(ideographs[index]);
    if (index < ideographs.length - 1) {
      tokens.push(`${ideographs[index]}${ideographs[index + 1]}`);
    }
    if (index < ideographs.length - 2) {
      tokens.push(
        `${ideographs[index]}${ideographs[index + 1]}${ideographs[index + 2]}`,
      );
    }
  }

  return [...new Set(tokens)];
}

export function retrievalTokens(value: string): string[] {
  return [
    ...new Set([
      ...tokenize(value),
      ...topicTokens(value),
    ]),
  ];
}

export function embedText(value: string): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  for (const token of retrievalTokens(value)) {
    const hash = hashToken(token);
    const index = hash % DIMENSIONS;
    const sign = hash & 1 ? 1 : -1;
    vector[index] += sign * (1 + Math.min(token.length, 8) / 8);
  }

  let norm = 0;
  for (const item of vector) norm += item * item;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] /= norm;
    }
  }
  return vector;
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(
    vector.buffer,
    vector.byteOffset,
    vector.byteLength,
  );
}

export function bufferToVector(value: Uint8Array): Float32Array {
  const copy = Buffer.from(value);
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    copy.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

export function cosineSimilarity(
  left: Float32Array,
  right: Float32Array,
): number {
  if (left.length !== right.length) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
  }
  return Math.max(0, Math.min(1, dot));
}

export function tokenOverlap(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / Math.max(1, Math.min(a.size, b.size));
}

export function topicTokenOverlap(left: string, right: string): number {
  const a = new Set(topicTokens(left));
  const b = new Set(topicTokens(right));
  if (!a.size || !b.size) return 0;

  const aConcepts = new Set(
    [...a].filter((token) => token.startsWith('concept:')),
  );
  const bConcepts = new Set(
    [...b].filter((token) => token.startsWith('concept:')),
  );
  let conceptIntersection = 0;
  for (const token of aConcepts) {
    if (bConcepts.has(token)) conceptIntersection += 1;
  }
  if (
    aConcepts.size > 0 &&
    bConcepts.size > 0 &&
    conceptIntersection === 0
  ) {
    return 0;
  }

  const aLexical = new Set(
    [...a].filter((token) => !token.startsWith('concept:')),
  );
  const bLexical = new Set(
    [...b].filter((token) => !token.startsWith('concept:')),
  );
  let lexicalIntersection = 0;
  for (const token of aLexical) {
    if (bLexical.has(token)) lexicalIntersection += 1;
  }
  const lexicalOverlap =
    lexicalIntersection /
    Math.max(1, Math.min(aLexical.size, bLexical.size));
  const conceptOverlap =
    conceptIntersection /
    Math.max(1, Math.min(aConcepts.size, bConcepts.size));
  return Math.max(lexicalOverlap, conceptOverlap);
}

export function embeddingDimensions(): number {
  return DIMENSIONS;
}
