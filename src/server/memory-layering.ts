import type { RecallResult } from './types.js';

export type MemoryLayer = 'fact' | 'episode' | 'summary';

const PREFERRED_LAYER_LIMITS: Readonly<Record<MemoryLayer, number>> =
  Object.freeze({
    fact: 4,
    episode: 3,
    summary: 2,
  });

export function classifyMemoryLayer(source: string): MemoryLayer {
  if (source === 'conversation_episode') return 'episode';
  if (source === 'hierarchical_summary' || source === 'consolidation') {
    return 'summary';
  }
  return 'fact';
}

export function memoryLayerContextFields(source: string): {
  heading: string;
  contentLabel: string;
  caution: string | null;
} {
  const layer = classifyMemoryLayer(source);
  if (layer === 'episode') {
    return {
      heading: '过往对话情景',
      contentLabel: '情景',
      caution: '这只证明以前聊过这些内容，不等于已验证的用户事实。',
    };
  }
  if (layer === 'summary') {
    return {
      heading: '派生摘要',
      contentLabel: '摘要',
      caution: '这是由可追溯来源压缩出的摘要，需要按来源理解。',
    };
  }
  return {
    heading: '已验证事实',
    contentLabel: '事实',
    caution: null,
  };
}

export function selectLayeredRecallResults(
  ranked: RecallResult[],
  requestedLimit: number,
): RecallResult[] {
  const limit = Math.max(1, Math.trunc(requestedLimit));
  const selected: RecallResult[] = [];
  const selectedIds = new Set<string>();
  const counts: Record<MemoryLayer, number> = {
    fact: 0,
    episode: 0,
    summary: 0,
  };

  for (const result of ranked) {
    const layer = classifyMemoryLayer(result.memory.source);
    if (counts[layer] >= PREFERRED_LAYER_LIMITS[layer]) continue;
    selected.push(result);
    selectedIds.add(result.memory.id);
    counts[layer] += 1;
    if (selected.length >= limit) return selected;
  }

  for (const result of ranked) {
    if (selectedIds.has(result.memory.id)) continue;
    selected.push(result);
    selectedIds.add(result.memory.id);
    if (selected.length >= limit) break;
  }
  return selected;
}
