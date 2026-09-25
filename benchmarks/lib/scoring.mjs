// 评分口径：与各数据集的官方口径对齐（不改写、不近似到失去可比性）。
//
// 三个数据集的口径不同，**不可横比**：
// - CMRC 2018：中文抽取式，去空白/标点后**字符级** EM / F1（官方口径）
// - HotpotQA：英文，官方归一化（去冠词/标点）后**词级** EM / F1
// - cn-eval 自建：中文判定用"答案核心词包含 + 弃答识别"，只做定性结论

// ─────────────────────────── CMRC 2018（中文，字符级） ──────────────────────

export function cmrcNormalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function cmrcEm(gold, hypothesis) {
  const g = cmrcNormalize(gold);
  const h = cmrcNormalize(hypothesis);
  return g.length > 0 && g === h ? 1 : 0;
}

export function cmrcF1(gold, hypothesis) {
  const g = [...cmrcNormalize(gold)];
  const h = [...cmrcNormalize(hypothesis)];
  if (g.length === 0 || h.length === 0) return 0;
  const remaining = new Map();
  for (const ch of g) remaining.set(ch, (remaining.get(ch) ?? 0) + 1);
  let overlap = 0;
  for (const ch of h) {
    const left = remaining.get(ch) ?? 0;
    if (left > 0) {
      overlap++;
      remaining.set(ch, left - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / h.length;
  const recall = overlap / g.length;
  return (2 * precision * recall) / (precision + recall);
}

// ─────────────────────────── HotpotQA（英文，词级） ──────────────────────────

export function hotpotNormalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/([,.!?;:"()<>{}\[\]])/g, ' ')
    .replace(/[-—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNumber(text) {
  const m = String(text).match(/-?\d+(\.\d+)?/);
  return m ? String(Number(m[0])) : null;
}

export function hotpotF1(prediction, gold) {
  const predTokens = hotpotNormalize(prediction).split(' ').filter(Boolean);
  const goldTokens = hotpotNormalize(gold).split(' ').filter(Boolean);
  if (predTokens.length === 0 || goldTokens.length === 0) {
    return predTokens.join('') === goldTokens.join('') ? 1 : 0;
  }
  const common = new Set(predTokens.filter((t) => goldTokens.includes(t)));
  if (common.size === 0) return 0;
  const precision = common.size / predTokens.length;
  const recall = common.size / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

export function hotpotEmF1(prediction, gold) {
  const p = hotpotNormalize(prediction);
  const g = hotpotNormalize(gold);
  let em = p === g ? 1 : 0;
  if (!em) {
    const pn = firstNumber(prediction);
    const gn = firstNumber(gold);
    if (pn !== null && pn === gn) em = 1;
  }
  return { em, f1: hotpotF1(prediction, gold) };
}

// ─────────────────────────── cn-eval 自建（判定式） ──────────────────────────

/** 弃答识别：模型明确表示"文档里没有"的常见措辞。 */
export const ABSTAIN_PATTERN =
  /不知道|无法|没有(?:相关|提及|找到)|未提及|不确定|无相关/;

const NEGATION_PATTERN = /不允许|禁止|不可以|不得|否/;

/**
 * 自建语料的判定：
 * - `unanswerable` 题正确弃答记 `correct_abstain`，硬答记 `overconfident`
 * - 可答题弃答记 `wrong_abstain`（比答错更值得追：记着了不敢答）
 */
export function cnVerdict(question, hypothesis) {
  const abstained = ABSTAIN_PATTERN.test(hypothesis);
  if (question.type === 'unanswerable') {
    return abstained ? 'correct_abstain' : 'overconfident';
  }
  if (abstained) return 'wrong_abstain';
  const keys = question.answer === '不允许'
    ? ['不允许', '禁止', '不可以', '不得']
    : [question.answer];
  if (keys.some((key) => hypothesis.includes(key))) return 'correct';
  if (question.answer === '不允许' && NEGATION_PATTERN.test(hypothesis)) return 'correct';
  return 'wrong';
}

/** 汇总召回指标（Recall@k / MRR），输入每题 gold 的排名（0 = 未召回）。 */
export function recallSummary(goldRanks) {
  const total = goldRanks.length;
  if (total === 0) return { recall_at_1: 0, recall_at_5: 0, recall_at_8: 0, mrr: 0 };
  const rankAt = (k) => goldRanks.filter((r) => r > 0 && r <= k).length / total;
  const mrr = goldRanks.reduce((sum, r) => sum + (r > 0 ? 1 / r : 0), 0) / total;
  return {
    recall_at_1: rankAt(1),
    recall_at_5: rankAt(5),
    recall_at_8: rankAt(8),
    mrr,
  };
}
