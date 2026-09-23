import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CandidateResolver } from '../dist/server/candidate-resolver.js';
import {
  OllamaConversationChatProvider,
} from '../dist/server/conversation-chat.js';
import { ConversationService } from '../dist/server/conversation-service.js';
import { config } from '../dist/server/config.js';
import { openDatabase, SCHEMA_VERSION } from '../dist/server/database.js';
import { EpisodicMemoryService } from '../dist/server/episodic-memory-service.js';
import {
  ExplicitMemoryIntentService,
} from '../dist/server/explicit-memory-intent.js';
import {
  HierarchicalSummaryService,
} from '../dist/server/hierarchical-summary-service.js';
import { IdentityService } from '../dist/server/identity.js';
import { LifecycleStore } from '../dist/server/lifecycle-store.js';
import { MemoryConsolidator } from '../dist/server/memory-consolidator.js';
import { MemoryAdminService } from '../dist/server/memory-admin.js';
import { OllamaMemoryExtractor } from '../dist/server/memory-extractor.js';
import { MemoryGovernance } from '../dist/server/memory-governance.js';
import {
  MemoryReflectionService,
  OllamaReflectionProvider,
} from '../dist/server/memory-reflection.js';
import { MemoryStore } from '../dist/server/memory-store.js';
import { MemoryWorker } from '../dist/server/memory-worker.js';
import { OllamaSemanticRanker } from '../dist/server/semantic-ranker.js';
import {
  buildQaImplementationEvidence,
  createPrivateQaRunRoot,
  createQaRunId,
  immutableQaPath,
  writeImmutableQaFile,
} from './qa-receipt-lib.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(path.dirname(scriptPath));
const privateParent = path.join(
  projectRoot,
  '.memory-bridge-private',
  'natural-conversation-quality',
);
const NAMESPACE = 'qa-natural-conversation-v1';
const REQUIRED_GENERATION_MODEL = 'qwen2.5:14b';
const REQUIRED_EMBEDDING_MODEL = 'bge-m3:latest';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL_TIMEOUT_MS = 180_000;
const REFLECTION_WINDOW_TURNS = 200;
const ROLE_NAMES = ['小岚', '砚舟'];

export const RELIABLE_RECALL_P95_LIMIT_MS = 1_500;

export const SCHEMA37_ACCEPTANCE_THRESHOLDS = Object.freeze({
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

export const EXTRACTION_CONVERGENCE_THRESHOLDS = Object.freeze({
  turnCoverageRateMinimum: 1,
  dueJobMaximum: 0,
  unhealthyJobMaximum: 0,
  openResolutionJobMaximum: 0,
});

export function assessExtractionConvergence(metrics) {
  const failures = [];
  if (
    !Number.isFinite(metrics.turnCoverageRate) ||
    metrics.turnCoverageRate <
      EXTRACTION_CONVERGENCE_THRESHOLDS.turnCoverageRateMinimum
  ) {
    failures.push('completed_extraction_run_per_user_turn');
  }
  if (metrics.extractionJobCount !== metrics.expectedUserTurns) {
    failures.push('one_extraction_job_per_user_turn');
  }
  if (metrics.completedExtractionJobs !== metrics.expectedUserTurns) {
    failures.push('all_extraction_jobs_completed');
  }
  if (metrics.dueExtractionJobs > 0) {
    failures.push('due_extraction_jobs');
  }
  if (metrics.unhealthyExtractionJobs > 0) {
    failures.push('unhealthy_extraction_jobs');
  }
  if (metrics.openResolutionJobs > 0) {
    failures.push('open_candidate_resolution_jobs');
  }
  if (metrics.nonCompletedExtractionRuns > 0) {
    failures.push('non_completed_extraction_runs');
  }
  return { passed: failures.length === 0, failures };
}

export function assessOrdinaryDailyQuestionExtraction(metrics) {
  const ordinaryDailyQuestionCount = Number(
    metrics.ordinaryDailyQuestionCount,
  );
  const ordinaryDailyQuestionCandidateCount = Number(
    metrics.ordinaryDailyQuestionCandidateCount,
  );
  return {
    ordinaryDailyQuestionCount,
    ordinaryDailyQuestionCandidateCount,
    passed:
      Number.isSafeInteger(ordinaryDailyQuestionCount) &&
      ordinaryDailyQuestionCount > 0 &&
      Number.isSafeInteger(ordinaryDailyQuestionCandidateCount) &&
      ordinaryDailyQuestionCandidateCount === 0,
  };
}

export function assessGroundedAnswerSample({
  answer,
  expected,
  expectedGroundingId,
  groundingIds,
  forbiddenValues = [],
  abstentionExpected = false,
}) {
  const normalizedAnswer = String(answer || '').normalize('NFKC');
  const compact = (value) => String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}+#.]+/gu, '')
    .toLocaleLowerCase('zh-CN');
  const forbidden = forbiddenValues.some((value) =>
    normalizedAnswer.includes(String(value).normalize('NFKC')));
  if (abstentionExpected) {
    const correct = groundingIds.length === 0 &&
      compact(normalizedAnswer) === compact('不知道') && !forbidden;
    return {
      correct,
      forbidden,
      unexpectedExtraFact: !correct,
    };
  }
  const correct = Boolean(expectedGroundingId) &&
    groundingIds.includes(expectedGroundingId) &&
    compact(normalizedAnswer) === compact(expected) &&
    !forbidden;
  return {
    correct,
    forbidden,
    unexpectedExtraFact:
      compact(normalizedAnswer) !== compact(expected),
  };
}

export function assessProductionEvidenceReadiness({
  redactedUserTurnCount,
  samples,
}) {
  const missingCandidateCount = samples.filter(
    (sample) => !sample.candidateId,
  ).length;
  const missingSourceExcerptCount = samples.filter(
    (sample) => !String(sample.sourceExcerpt || '').trim(),
  ).length;
  return {
    unredactedUserTurnsPassed: redactedUserTurnCount === 0,
    labeledCandidateEvidencePassed:
      missingCandidateCount === 0 && missingSourceExcerptCount === 0,
    missingCandidateCount,
    missingSourceExcerptCount,
  };
}

export function assessReflectionCandidateQuality(candidates) {
  const trusted = (candidate) =>
    Number.isFinite(candidate.trustedUserEvidenceTurns) &&
    candidate.trustedUserEvidenceTurns >= 3;
  const target = (candidate) =>
    candidate.habitMeaningMatch === true &&
    Number.isFinite(candidate.habitEvidenceTurns) &&
    candidate.habitEvidenceTurns >= 3 &&
    trusted(candidate);
  const extraGrounded = (candidate) =>
    candidate.habitMeaningMatch === false && trusted(candidate);
  const targetCandidateCount = candidates.filter(target).length;
  const extraGroundedCandidateCount = candidates.filter(extraGrounded).length;
  const invalidCandidateCount = candidates.length -
    targetCandidateCount - extraGroundedCandidateCount;
  return {
    targetCandidateCount,
    extraGroundedCandidateCount,
    invalidCandidateCount,
    passed: targetCandidateCount >= 1 && invalidCandidateCount === 0,
  };
}

export function assessSchema37Acceptance(metrics) {
  const thresholds = SCHEMA37_ACCEPTANCE_THRESHOLDS;
  const failures = [];
  const requireMinimum = (field, threshold, failure) => {
    if (!Number.isFinite(metrics[field]) || metrics[field] < threshold) {
      failures.push(failure);
    }
  };
  const requireMaximum = (field, threshold, failure) => {
    if (!Number.isFinite(metrics[field]) || metrics[field] > threshold) {
      failures.push(failure);
    }
  };
  requireMinimum(
    'exchangeEpisodeRate',
    thresholds.exchangeEpisodeRateMinimum,
    'exchange_episode_completeness',
  );
  requireMinimum(
    'episodeTurnBindingRate',
    thresholds.episodeTurnBindingRateMinimum,
    'episode_turn_binding',
  );
  requireMinimum(
    'episodeFtsRate',
    thresholds.episodeFtsRateMinimum,
    'episode_fts_completeness',
  );
  requireMinimum(
    'episodeDenseRate',
    thresholds.episodeDenseRateMinimum,
    'episode_dense_convergence',
  );
  requireMinimum(
    'compactionSummaryCoverage',
    thresholds.compactionSummaryCoverageMinimum,
    'episode_compaction_summary_coverage',
  );
  requireMaximum(
    'compactedEpisodeHotIndexResidueCount',
    thresholds.compactedEpisodeHotIndexResidueMaximum,
    'compacted_episode_hot_index_residue',
  );
  requireMinimum(
    'episodeRecallAt5',
    thresholds.episodeRecallAt5Minimum,
    'episode_recall_at_5',
  );
  requireMaximum(
    'episodeDuplicateCount',
    thresholds.episodeDuplicateMaximum,
    'episode_duplicate_free',
  );
  requireMaximum(
    'assistantFactPollutionCount',
    thresholds.assistantFactPollutionMaximum,
    'assistant_fact_pollution',
  );
  requireMinimum(
    'summarySourceSupportRate',
    thresholds.summarySourceSupportRateMinimum,
    'summary_source_support',
  );
  requireMaximum(
    'crossAccountLeakageCount',
    thresholds.crossAccountLeakageMaximum,
    'cross_account_isolation',
  );
  requireMaximum(
    'crossRoleLeakageCount',
    thresholds.crossRoleLeakageMaximum,
    'cross_role_isolation',
  );
  requireMaximum(
    'crossProjectLeakageCount',
    thresholds.crossProjectLeakageMaximum,
    'cross_project_isolation',
  );
  return { passed: failures.length === 0, failures };
}

function deterministicEmbedding(text, dimensions = 64) {
  const values = new Float32Array(dimensions);
  const normalized = String(text).normalize('NFKC');
  for (let offset = 0; offset < normalized.length; offset += 1) {
    const codePoint = normalized.codePointAt(offset) || 0;
    const digest = createHash('sha256')
      .update(`${offset}:${codePoint}:${normalized.slice(offset, offset + 3)}`)
      .digest();
    values[digest[0] % dimensions] += digest[1] % 2 === 0 ? 1 : -1;
  }
  let norm = Math.sqrt(
    [...values].reduce((sum, value) => sum + value * value, 0),
  );
  if (norm === 0) {
    values[0] = 1;
    norm = 1;
  }
  return Float32Array.from(values, (value) => value / norm);
}

export function createSchema37DeterministicRanker() {
  return {
    embeddingModel: REQUIRED_EMBEDDING_MODEL,
    rerankModel: REQUIRED_GENERATION_MODEL,
    async embed(texts) {
      return texts.map((text) => deterministicEmbedding(text));
    },
    async rerank(query, candidates) {
      const queryTokens = new Set(
        String(query).normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [],
      );
      return candidates.map((candidate) => {
        const memoryTokens = new Set(
          String(candidate.memory).normalize('NFKC')
            .match(/[\p{L}\p{N}]+/gu) || [],
        );
        const overlap = [...queryTokens].filter((token) =>
          memoryTokens.has(token)).length;
        return {
          id: candidate.id,
          relevant: overlap > 0,
          confidence: overlap > 0 ? 1 : 0,
          reason: 'schema37_deterministic_state_machine_smoke',
        };
      });
    },
  };
}

const PEOPLE = [
  {
    name: '林澈', drink: '桂花乌龙', commute: '骑共享单车到地铁站',
  },
  {
    name: '顾宁', drink: '陈皮白茶', commute: '步行穿过公园去公司',
  },
  {
    name: '周遥', drink: '无糖茉莉茶', commute: '坐社区巴士到园区',
  },
  {
    name: '沈禾', drink: '冷萃柠檬水', commute: '骑折叠自行车上班',
  },
  {
    name: '唐葵', drink: '烘焙大麦茶', commute: '乘有轨电车通勤',
  },
  {
    name: '许舟', drink: '薄荷青柠水', commute: '坐公司的通勤班车',
  },
  {
    name: '江岚', drink: '热燕麦拿铁', commute: '沿河步行去工作室',
  },
  {
    name: '苏沐', drink: '武夷岩茶', commute: '骑公路车去办公室',
  },
];

const RESPONSE_STYLES = [
  '先给一句结论，再列两点依据',
  '先说明风险，再给三个执行步骤',
  '用简短清单回答，不要写长段落',
  '先复述目标，再给最短可行方案',
  '先给推荐选项，再说明取舍',
  '按时间顺序说明，不要跳步骤',
  '先指出阻塞项，再列可以继续的事情',
  '先给数据，再给判断',
  '先说是否可行，再估算耗时',
  '只给必要命令，并解释危险操作',
  '先总结变化，再列验证证据',
  '先回答问题，再补一个注意事项',
  '先列已知事实，再标出不确定项',
  '用表格比较方案，最后给建议',
  '先说明当前状态，再给下一步',
  '先给失败原因，再给恢复方法',
];

const EDITOR_PAIRS = [
  ['Visual Studio Code', 'Neovim'], ['Zed', 'Helix'],
  ['Sublime Text', 'Fleet'], ['IntelliJ IDEA', 'Cursor'],
  ['Emacs', 'Lapce'], ['Nova', 'Vim'], ['WebStorm', 'Zed'],
  ['Kate', 'Visual Studio Code'], ['Atom', 'Neovim'],
  ['Fleet', 'Sublime Text'], ['Cursor', 'IntelliJ IDEA'],
  ['Vim', 'Helix'], ['Lapce', 'Nova'], ['WebStorm', 'Emacs'],
  ['Kate', 'Zed'], ['Visual Studio Code', 'Fleet'],
];

const HOTELS = [
  '青禾旅店', '白塔公寓', '沿江客栈', '松风酒店',
  '云栖民宿', '北岸宾馆', '槐序公寓', '栖霞旅店',
  '南桥酒店', '月桂民宿', '石巷客栈', '晴川公寓',
  '枫庭酒店', '海棠宾馆', '春汀旅店', '竹影民宿',
];

const HABITS = [
  '晚饭后散步二十分钟', '睡前读十页纸质书',
  '午休后做一组肩颈拉伸', '下班后整理十分钟桌面',
  '早餐后记录当天最重要的事', '傍晚给阳台植物浇水',
  '晚间练十五分钟吉他', '回家后先换衣服再休息',
  '周中晚上做半小时力量训练', '睡前把手机放到客厅充电',
  '午饭后绕办公楼走一圈', '晚上写三行当天复盘',
  '通勤回来先喝一杯温水', '晚饭后收拾第二天的背包',
  '睡前听二十分钟有声书', '下班后做一轮呼吸练习',
];

const HABIT_KEYWORDS = [
  ['散步'], ['纸质书', '读书'], ['肩颈', '拉伸'], ['桌面', '整理'],
  ['记录', '重要'], ['植物', '浇水'], ['吉他'], ['换衣服'],
  ['力量训练'], ['手机', '充电'], ['办公楼', '走'], ['复盘'],
  ['温水'], ['背包'], ['有声书'], ['呼吸'],
];

const OCCUPATIONS = [
  '室内设计师', '后端工程师', '小学科学老师', '产品运营',
  '独立摄影师', '供应链计划员', '宠物医生', '数据分析师',
];

const HOME_CITIES = [
  '杭州', '成都', '苏州', '厦门', '武汉', '青岛', '昆明', '南京',
];

const FOOD_AVERSIONS = [
  '香菜', '生洋葱', '折耳根', '过甜奶油',
  '芹菜', '榴莲', '肥肉', '苦瓜',
];

const LEARNING_GOALS = [
  '系统学习木工基础', '通过日语 N2', '学会自由泳', '掌握基础摄影布光',
  '完成十公里跑训练', '学习家庭烘焙', '掌握数据可视化', '读完二十本历史书',
];

const RELATIONSHIPS = [
  ['小安', '妹妹'], ['阿衡', '哥哥'], ['小满', '女儿'], ['乐乐', '儿子'],
  ['云姨', '姨妈'], ['老周', '父亲'], ['宁宁', '伴侣'], ['小羽', '表妹'],
];

const TIMELINE_OUTINGS = [
  ['云杉书店', '南桥书店'], ['白塔书局', '江湾书店'],
  ['青石书屋', '梧桐书店'], ['海风书房', '灯塔书局'],
  ['东湖书店', '晴川书屋'], ['山海书局', '栈桥书店'],
  ['翠湖书房', '云上书店'], ['秦淮书屋', '玄武书店'],
  ['松果书店', '银杏书房'], ['岛屿书局', '微光书店'],
  ['长街书屋', '河畔书店'], ['拾光书局', '纸间书店'],
  ['北岸书房', '南山书店'], ['旧城书屋', '新港书局'],
  ['晚风书店', '晨光书房'], ['石桥书局', '木棉书店'],
];

const ROLE_REMINDER_RULES = [
  '晚上十点后不要主动提醒', '工作日早上九点前不要催进度',
  '涉及花钱的建议先提醒预算', '所有清单最多保留五项',
  '运动建议先说明热身要求', '外出计划先检查天气',
  '阅读推荐要注明篇幅', '会议安排要避开午休',
  '做决定前先列出不可逆风险', '命令行操作先说明回滚方式',
  '健康建议必须标出非医疗诊断', '采购建议先给总成本',
  '旅行建议先核对证件有效期', '学习计划按周拆分',
  '任务延期时先说明影响范围', '数据操作必须先说明备份状态',
];

export const NATURAL_CHAT_TOPICS = Object.freeze([
  'weather',
  'food',
  'work',
  'professional',
  'travel',
  'hobby',
  'wellness',
  'casual',
]);

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DAY_PERIODS = ['早上', '上午', '午休', '下午', '傍晚', '晚上'];
const WEATHER_CONDITIONS = [
  '有阵雨还刮风', '晴天但温差很大', '一直是阴天', '突然降温',
  '空气有点闷热', '小雨断断续续', '太阳很晒', '早晚有雾',
  '湿度特别高', '风比昨天大', '午后可能有雷雨', '夜里会转凉',
];
const OUTDOOR_PLANS = [
  '骑车去见朋友', '步行去超市', '下班后去公园', '带电脑去咖啡店',
  '坐地铁去看展', '晚上出门取快递', '午休出去买东西', '去书店待一会儿',
  '陪家人散步', '赶早班车', '去健身房', '在户外拍照',
];
const DISHES = [
  '番茄牛腩', '清蒸鲈鱼', '鸡丝凉面', '菌菇烩饭', '冬瓜排骨汤',
  '咖喱鸡饭', '虾仁蒸蛋', '番茄鸡蛋面', '牛肉粉', '烤南瓜沙拉',
  '砂锅豆腐', '青椒肉丝', '照烧鸡腿饭', '三鲜馄饨', '海鲜粥',
  '酸汤水饺', '葱油拌面', '香菇鸡汤', '土豆炖牛肉', '紫菜饭团',
];
const WORK_SITUATIONS = [
  '需求刚改了两次', '会议比计划多了一场', '项目进度有点落后',
  '同事给了几条相反意见', '下午要做阶段汇报', '手上同时来了三件急事',
  '客户临时提前了截止时间', '评审里还有两个阻塞项',
  '文档和实际实现对不上', '跨团队回复一直没到',
  '今天需要估算下一阶段工作', '一个线上问题还没定位清楚',
];
const PROFESSIONAL_QUESTIONS = [
  '数据库索引怎么判断是否有效', '接口幂等应该从哪里开始设计',
  '并发写入怎么避免重复数据', '日志怎样设计才方便追踪请求',
  '缓存失效策略怎么选', '如何拆分一个过大的服务模块',
  '怎么判断测试覆盖了真正的风险', '慢查询应该按什么顺序排查',
  '向量检索的召回率怎么评估', 'RAG 的重排序应该看哪些指标',
  '如何给异步任务设计补偿机制', '模型输出非法 JSON 怎么兜底',
];
const TRAVEL_DESTINATIONS = [
  '泉州', '大理', '长沙', '景德镇', '威海', '扬州',
  '桂林', '福州', '洛阳', '绍兴', '潮州', '重庆',
];
const TRAVEL_CONCERNS = [
  '交通别太折腾', '想避开人最多的地方', '预算要控制住',
  '希望多留一点自由时间', '不想每天换酒店', '想兼顾吃饭和散步',
  '带着长辈不宜走太多路', '下雨也要有备用安排',
];
const HOBBY_ACTIVITIES = [
  '读一本历史书', '看一部悬疑电影', '练习夜景摄影', '学一首简单的吉他曲',
  '整理上周拍的照片', '逛一个小型展览', '听一期科技播客', '做一个木工小摆件',
  '试着画一张速写', '读一篇长报道', '练习做面包', '看一场纪录片',
];
const WELLNESS_CONTEXTS = [
  '昨晚只睡了六个小时', '今天坐着开会太久', '下午注意力一直不集中',
  '晚饭吃得有点撑', '最近肩颈有点紧', '今天工作完脑子还停不下来',
  '上午走路比平时多', '这两天起床后有点疲惫',
  '晚上想做一点轻运动', '今天情绪有点烦躁',
];
const CASUAL_CONTEXTS = [
  '刚看完一部节奏很慢的电影', '窗外突然下起了小雨',
  '朋友发来一张很好笑的猫咪照片', '回家路上看到一家新书店',
  '今天终于把桌面收拾干净了', '午休时听到一首很熟的老歌',
  '刚把积了几天的快递拆完', '楼下的花今天开得很好看',
  '周末想给自己留半天空白', '晚上不太想继续盯着屏幕',
];

function pick(values, seed, offset = 0) {
  return values[Math.abs(seed * 17 + offset * 31) % values.length];
}

function naturalDialogueContext(
  scenario,
  turnIndex,
  turnCount,
  timelineDays,
) {
  const pairIndex = Math.floor(turnIndex / 2);
  const topic = NATURAL_CHAT_TOPICS[
    (pairIndex + scenario.scenarioIndex * 3) % NATURAL_CHAT_TOPICS.length
  ];
  const dayIndex = Math.min(
    timelineDays - 1,
    Math.floor(
      (turnIndex / Math.max(1, turnCount - 1)) * timelineDays,
    ),
  );
  const date = new Date(Date.UTC(2026, 0, 1 + dayIndex));
  return {
    topic,
    pairIndex,
    seed: Math.floor(pairIndex / NATURAL_CHAT_TOPICS.length) +
      scenario.scenarioIndex * 101,
    followUp: turnIndex % 2 === 1,
    dayIndex,
    dateLabel: `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`,
    weekday: WEEKDAYS[(dayIndex + 3) % WEEKDAYS.length],
    period: DAY_PERIODS[(turnIndex + scenario.scenarioIndex) % DAY_PERIODS.length],
  };
}

export function naturalDialogueForTurn(
  scenario,
  turnIndex,
  turnCount,
  timelineDays = 45,
) {
  const context = naturalDialogueContext(
    scenario,
    turnIndex,
    turnCount,
    timelineDays,
  );
  const { seed, followUp, weekday, period, dateLabel } = context;
  const temperature = 7 + Math.abs(seed * 7 + scenario.scenarioIndex) % 27;
  switch (context.topic) {
    case 'weather': {
      const condition = pick(WEATHER_CONDITIONS, seed, 1);
      const plan = pick(OUTDOOR_PLANS, seed, 2);
      return {
        ...context,
        user: followUp
          ? `${dateLabel}${period}，那按你刚才说的穿法，${plan}时还要再带一件外套吗？`
          : `${dateLabel}${weekday}${period}${scenario.homeCity}预报${temperature}℃，${condition}，我还要${plan}，怎么穿比较合适？`,
        assistant: followUp
          ? '可以带一件轻薄、方便收纳的外套；出门前再看一次体感温度和降雨雷达。'
          : '先按体感温度分层穿，外层兼顾风雨；临出门再核对逐小时预报。',
      };
    }
    case 'food': {
      const dish = pick(DISHES, seed, 3);
      const side = pick(['米饭', '杂粮饭', '清汤面', '烤蔬菜', '蒸红薯'], seed, 4);
      return {
        ...context,
        user: followUp
          ? `${dateLabel}${period}，接着刚才的晚饭建议，如果主食换成${side}，分量怎么搭更合适？`
          : `${dateLabel}${period}不知道吃什么，想吃${dish}又要避开${scenario.foodAversion}，你帮我配一顿简单的餐食好吗？`,
        assistant: followUp
          ? `可以把${side}控制在一拳左右，再配一掌蛋白质和两拳蔬菜。`
          : `可以以${dish}为主菜，明确去掉${scenario.foodAversion}，再搭清淡主食和一份蔬菜。`,
      };
    }
    case 'work': {
      const situation = pick(WORK_SITUATIONS, seed, 5);
      const deadline = pick(['今天下班前', '明天上午', '本周五', '下次评审前'], seed, 6);
      return {
        ...context,
        user: followUp
          ? `${dateLabel}${period}，那按你刚才排的优先级，我在${deadline}前应该先交付哪一项，怎么跟同事说明？`
          : `${dateLabel}${weekday}工作里${situation}，我现在有点乱，能帮我按影响和紧急度排一下处理顺序吗？`,
        assistant: followUp
          ? '先交付能解除他人阻塞的最小结果，并同步范围、风险、负责人和下一次更新时间。'
          : '先列出真正阻塞交付的事项，再处理高影响且不可并行的任务，剩余工作明确排期。',
      };
    }
    case 'professional': {
      const question = pick(PROFESSIONAL_QUESTIONS, seed, 7);
      const scale = 100 + Math.abs(seed * 97) % 9_900;
      return {
        ...context,
        user: followUp
          ? `${dateLabel}${period}继续刚才这个专业问题，如果数据量到${scale}条，最先应该加哪一个验证指标？`
          : `${dateLabel}${period}我有个专业问题：${question}，能先给判断思路再举一个小例子吗？`,
        assistant: followUp
          ? '先加一个直接反映用户结果的质量指标，再补 P50、P95 和失败样本分类，避免只看平均值。'
          : '先明确目标和失败定义，再用最小可复现实验验证关键假设，最后才决定是否改架构。',
      };
    }
    case 'travel': {
      const destination = pick(TRAVEL_DESTINATIONS, seed, 8);
      const concern = pick(TRAVEL_CONCERNS, seed, 9);
      const days = 2 + Math.abs(seed) % 5;
      return {
        ...context,
        user: followUp
          ? `${dateLabel}${period}，那按刚才的${destination}路线，如果第二天下雨，室内行程怎么替换最顺？`
          : `${dateLabel}${period}我想去${destination}旅行${days}天，${concern}，能先排一个不过度赶路的行程吗？`,
        assistant: followUp
          ? '把同一区域的博物馆、书店或室内展馆放进备用清单，尽量不改变当天住宿和交通方向。'
          : '先按住宿位置把景点分区，每天只安排一个核心区域，并预留一段完全自由的时间。',
      };
    }
    case 'hobby': {
      const activity = pick(HOBBY_ACTIVITIES, seed, 10);
      const minutes = 20 + (Math.abs(seed) % 5) * 10;
      return {
        ...context,
        user: followUp
          ? `${dateLabel}${period}，那按你刚才的兴趣练习安排，今晚只有${minutes}分钟，先做哪一步最值？`
          : `${dateLabel}${weekday}${period}想${activity}，但不想把休息变成任务，你能给我一个轻松的开始方式吗？`,
        assistant: followUp
          ? '先做能立即得到反馈的最小一步，时间到就停，并留一句下次从哪里继续。'
          : '把目标缩成一次可随时停止的小体验，不设完成量，只保留开始和收尾两个动作。',
      };
    }
    case 'wellness': {
      const situation = pick(WELLNESS_CONTEXTS, seed, 11);
      const minutes = 5 + (Math.abs(seed) % 4) * 5;
      return {
        ...context,
        user: followUp
          ? `${dateLabel}${period}，那按刚才的放松方案，我只有${minutes}分钟，呼吸和拉伸先做哪个？`
          : `${dateLabel}${period}${situation}，现在想恢复一点状态，有什么温和的健康调整建议？`,
        assistant: followUp
          ? '先做两分钟缓慢呼吸降低紧张感，再用剩余时间活动最僵硬的部位；不适就停止。'
          : '先补水并离开屏幕几分钟，再做轻量活动；如果症状持续或明显加重，应咨询专业人士。',
      };
    }
    case 'casual': {
      const situation = pick(CASUAL_CONTEXTS, seed, 12);
      const choice = pick(['散步', '听音乐', '看书', '泡杯热饮', '整理照片'], seed, 13);
      return {
        ...context,
        user: followUp
          ? `${dateLabel}${period}，接着刚才的闲聊，如果我选${choice}，怎么安排才能真的放松而不是又赶进度？`
          : `${dateLabel}${period}${situation}，你愿意陪我随便聊聊，顺便给一个不费脑子的休息点子吗？`,
        assistant: followUp
          ? `给${choice}设一个很短的开始动作，不计成果，觉得够了就停。`
          : '当然可以。先把手头的事放下十分钟，选一个不用做决定的小活动就好。',
      };
    }
    default:
      throw new Error(`未知日常对话主题: ${context.topic}`);
  }
}

function integerSetting(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === ''
    ? fallback
    : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return parsed;
}

export function parseConfig(environment = process.env) {
  const userCount = integerSetting(
    environment.QA_NATURAL_USERS,
    2,
    1,
    8,
    'QA_NATURAL_USERS',
  );
  const messagesPerPersona = integerSetting(
    environment.QA_NATURAL_MESSAGES_PER_PERSONA,
    80,
    80,
    5_000,
    'QA_NATURAL_MESSAGES_PER_PERSONA',
  );
  if (messagesPerPersona % 2 !== 0) {
    throw new Error('QA_NATURAL_MESSAGES_PER_PERSONA 必须是偶数');
  }
  return Object.freeze({
    userCount,
    personasPerUser: 2,
    messagesPerPersona,
    userTurnsPerPersona: messagesPerPersona / 2,
    totalMessages: userCount * 2 * messagesPerPersona,
    timelineDays: integerSetting(
      environment.QA_NATURAL_TIMELINE_DAYS,
      45,
      7,
      365,
      'QA_NATURAL_TIMELINE_DAYS',
    ),
    writeConcurrency: integerSetting(
      environment.QA_NATURAL_CONCURRENCY,
      4,
      1,
      8,
      'QA_NATURAL_CONCURRENCY',
    ),
    realModel: environment.QA_NATURAL_REAL_MODEL !== 'off',
  });
}

function claim(kind, predicate, value, scopeType = 'personal') {
  return {
    kind,
    subject: '用户',
    predicate,
    value,
    content: '',
    confidence: 0.99,
    importance: 0.8,
    sensitivity: 'normal',
    scopeType,
    scopeKey: scopeType === 'personal' ? 'self' : undefined,
  };
}

function eventSlots(turnCount) {
  const definitions = [
    ['identity', 0.01], ['drink', 0.03], ['occupation', 0.055],
    ['commute', 0.08], ['food_aversion', 0.11], ['role_style', 0.14],
    ['learning_goal', 0.17], ['editor_old', 0.20],
    ['relationship', 0.235], ['quote_noise', 0.27],
    ['reminder_rule', 0.305], ['hotel', 0.34], ['home_city', 0.375],
    ['hypothetical_noise', 0.41], ['timeline_old', 0.44],
    ['timeline_old_question', 0.46], ['habit', 0.47], ['habit', 0.61],
    ['editor_new', 0.68], ['habit', 0.77], ['habit_stop', 0.81],
    ['forget_hotel', 0.84], ['timeline_new', 0.88],
    ['timeline_new_question', 0.90], ['habit_resume', 0.92],
    ['habit', 0.95], ['habit', 0.965], ['habit', 0.985],
  ];
  if (turnCount >= 200) {
    const windowStart = Math.min(
      turnCount - 160,
      Math.floor((turnCount * 0.5) / REFLECTION_WINDOW_TURNS) *
        REFLECTION_WINDOW_TURNS,
    );
    const habitFractions = [20, 65, 110, 155].map(
      (offset) => (windowStart + offset) / (turnCount - 1),
    );
    let habitIndex = 0;
    for (const definition of definitions) {
      if (definition[0] === 'habit') {
        if (habitIndex < habitFractions.length) {
          definition[1] = habitFractions[habitIndex];
        }
        habitIndex += 1;
      }
    }
  }
  const used = new Set();
  return definitions.map(([type, fraction]) => {
    let index = Math.round(Number(fraction) * (turnCount - 1));
    while (used.has(index) && index < turnCount - 1) index += 1;
    while (used.has(index) && index > 0) index -= 1;
    used.add(index);
    return { type, index };
  }).sort((left, right) => left.index - right.index);
}

function eventContent(type, scenario, occurrence = 0) {
  switch (type) {
    case 'identity':
      return `我的名字是${scenario.personName}，以后可以一直这样称呼我。`;
    case 'drink':
      return `这条在所有角色之间共享：我平时最常喝${scenario.drink}，点单时优先选它。`;
    case 'occupation':
      return `我目前的职业是${scenario.occupation}，这是我的长期职业背景。`;
    case 'commute':
      return `这个通勤习惯在每个角色里都一样：工作日我通常${scenario.commute}。`;
    case 'food_aversion':
      return `我一直不吃${scenario.foodAversion}，以后推荐餐食时请避开。`;
    case 'role_style':
      return `当前角色专属：和${scenario.roleName}这个角色聊天时，请${scenario.responseStyle}，其他角色不要沿用。`;
    case 'editor_old':
      return `只在和${scenario.roleName}这个角色聊天时，我常用的编辑器是${scenario.oldEditor}。`;
    case 'learning_goal':
      return `我今年的长期学习目标是${scenario.learningGoal}。`;
    case 'relationship':
      return `${scenario.relatedPerson}是我的${scenario.relationship}，以后提到这个名字时按这个关系理解。`;
    case 'quote_noise':
      return '同事说他离不开香菜，但那是他的口味，不是我的偏好。';
    case 'hotel':
      return `当前角色专属：这次临时出差我会住在${scenario.hotel}，只用于本角色。`;
    case 'home_city':
      return `我长期生活在${scenario.homeCity}，只需要记住城市，不要推断具体地址。`;
    case 'reminder_rule':
      return `只在和${scenario.roleName}聊天时，${scenario.reminderRule}。`;
    case 'hypothetical_noise':
      return '如果以后搬到海边，我也许会每天冲浪；这只是随口假设，不是现在的计划。';
    case 'timeline_old':
      return `今天午休我去了${scenario.timelineOldPlace}，在那里翻了几本旅行地图。`;
    case 'timeline_old_question':
      return '我前几天午休去的那家书店叫什么来着？';
    case 'timeline_new':
      return `今天午休我又去了一家书店，这次是${scenario.timelineNewPlace}，在那里看了摄影画册。`;
    case 'timeline_new_question':
      return '我最近一次午休去的是哪家书店？';
    case 'editor_new':
      return `更正一下，只在和${scenario.roleName}这个角色聊天时，我现在常用的编辑器改成${scenario.newEditor}，之前的${scenario.oldEditor}不用了。`;
    case 'forget_hotel':
      return `请忘记我前面说的${scenario.hotel}临时住宿安排，它已经取消了。`;
    case 'habit_stop':
      return `从今天起先停止${scenario.habit}，最近的安排不再继续。`;
    case 'habit_resume':
      return `现在恢复${scenario.habit}，后面继续按这个习惯安排。`;
    case 'habit':
      return [
        `今天照常${scenario.habit}，结束后整个人轻松了不少。`,
        `这周又坚持了${scenario.habit}，做完以后心情很平静。`,
        `忙完手上的事，我还是去${scenario.habit}了，身体也放松下来。`,
        `最近没有中断${scenario.habit}这个安排，今天做完也很舒服。`,
        `昨天按计划完成了${scenario.habit}，今天也照常做完了。`,
        `这两天我继续保持${scenario.habit}，刚才又完成了一次。`,
      ][occurrence] || `今天继续${scenario.habit}，做完以后很放松。`;
    default:
      throw new Error(`未知自然对话事件: ${type}`);
  }
}

function eventAssistantContent(type, scenario) {
  switch (type) {
    case 'identity':
      return `好的，之后我会称呼你为${scenario.personName}。`;
    case 'drink':
      return `记住了，点单时优先考虑${scenario.drink}。`;
    case 'occupation':
      return `了解，我会把${scenario.occupation}作为你的职业背景。`;
    case 'commute':
      return '收到，后续通勤建议会参考这个工作日习惯。';
    case 'food_aversion':
      return `明白，推荐餐食时会避开${scenario.foodAversion}。`;
    case 'role_style':
      return `好的，只在和${scenario.roleName}聊天时采用这个回复方式。`;
    case 'learning_goal':
      return '了解，后续学习建议会围绕这个长期目标。';
    case 'editor_old':
      return `收到，当前先按${scenario.oldEditor}记录。`;
    case 'editor_new':
      return `已更正为${scenario.newEditor}，旧编辑器偏好不再作为当前值。`;
    case 'relationship':
      return `明白，之后提到${scenario.relatedPerson}时会按这个关系理解。`;
    case 'quote_noise':
      return '了解，这是同事的口味，我不会记成你的偏好。';
    case 'reminder_rule':
      return `收到，这条规则只作用于${scenario.roleName}。`;
    case 'hotel':
      return `好的，这次临时住宿先按${scenario.hotel}处理。`;
    case 'forget_hotel':
      return '已按你的要求忘记这项临时住宿安排。';
    case 'home_city':
      return `了解，只记录你长期生活在${scenario.homeCity}。`;
    case 'hypothetical_noise':
      return '明白，这只是一个假设，不会当成当前计划。';
    case 'timeline_old':
      return `听起来你在${scenario.timelineOldPlace}度过了一个轻松的午休。`;
    case 'timeline_old_question':
      return '我会只根据更早的对话记录核对，证据不足就明确说不知道。';
    case 'timeline_new':
      return `这次去的是${scenario.timelineNewPlace}，和前一家书店不一样。`;
    case 'timeline_new_question':
      return '我会按时间顺序核对之前的记录，不从当前问题猜答案。';
    case 'habit':
      return '听起来这个安排已经连续出现了一段时间。';
    case 'habit_stop':
      return `好的，先停止${scenario.habit}，不会继续按旧状态建议。`;
    case 'habit_resume':
      return `明白，现在恢复${scenario.habit}。`;
    default:
      throw new Error(`未知自然对话事件回复: ${type}`);
  }
}

function eventCandidate(type, scenario) {
  switch (type) {
    case 'identity':
      return claim('profile', '姓名', scenario.personName);
    case 'drink':
      return claim('preference', '常喝饮品', scenario.drink);
    case 'occupation':
      return claim('profile', '职业', scenario.occupation);
    case 'commute':
      return claim('preference', '工作日通勤方式', scenario.commute);
    case 'food_aversion':
      return claim('preference', '饮食忌口', scenario.foodAversion);
    case 'role_style':
      return claim('instruction', '回复组织方式', scenario.responseStyle, 'role');
    case 'editor_old':
    case 'editor_new':
      return claim(
        'preference',
        '常用编辑器',
        type === 'editor_old' ? scenario.oldEditor : scenario.newEditor,
        'role',
      );
    case 'learning_goal':
      return claim('profile', '长期学习目标', scenario.learningGoal);
    case 'relationship':
      return claim(
        'relationship',
        `与${scenario.relatedPerson}的关系`,
        scenario.relationship,
      );
    case 'hotel':
      return claim('event', '临时住宿地点', scenario.hotel, 'role');
    case 'home_city':
      return claim('profile', '长期生活城市', scenario.homeCity);
    case 'reminder_rule':
      return claim(
        'instruction',
        '主动提醒规则',
        scenario.reminderRule,
        'role',
      );
    default:
      return null;
  }
}

export function buildScenarios(config) {
  const scenarios = [];
  for (let userIndex = 0; userIndex < config.userCount; userIndex += 1) {
    const person = PEOPLE[userIndex];
    for (let personaIndex = 0; personaIndex < 2; personaIndex += 1) {
      const scenarioIndex = userIndex * 2 + personaIndex;
      const scenario = {
        key: `user-${userIndex + 1}:persona-${personaIndex + 1}`,
        scenarioIndex,
        userIndex,
        personaIndex,
        principalId: `natural-user-${String(userIndex + 1).padStart(2, '0')}`,
        personaId: `natural-user-${String(userIndex + 1).padStart(2, '0')}-persona-${personaIndex + 1}`,
        projectId: personaIndex === 1
          ? `natural-user-${String(userIndex + 1).padStart(2, '0')}-project`
          : null,
        userTurnsPerPersona: config.userTurnsPerPersona,
        roleName: ROLE_NAMES[personaIndex],
        personName: person.name,
        drink: person.drink,
        commute: person.commute,
        responseStyle: RESPONSE_STYLES[scenarioIndex],
        oldEditor: EDITOR_PAIRS[scenarioIndex][0],
        newEditor: EDITOR_PAIRS[scenarioIndex][1],
        hotel: HOTELS[scenarioIndex],
        habit: HABITS[scenarioIndex],
        habitKeywords: HABIT_KEYWORDS[scenarioIndex],
        occupation: OCCUPATIONS[userIndex],
        homeCity: HOME_CITIES[userIndex],
        foodAversion: FOOD_AVERSIONS[userIndex],
        learningGoal: LEARNING_GOALS[userIndex],
        relatedPerson: RELATIONSHIPS[userIndex][0],
        relationship: RELATIONSHIPS[userIndex][1],
        reminderRule: ROLE_REMINDER_RULES[scenarioIndex],
        timelineOldPlace: TIMELINE_OUTINGS[scenarioIndex][0],
        timelineNewPlace: TIMELINE_OUTINGS[scenarioIndex][1],
      };
      let habitOccurrence = 0;
      scenario.events = eventSlots(config.userTurnsPerPersona).map((event) => {
        const occurrence = event.type === 'habit' ? habitOccurrence++ : 0;
        return {
          ...event,
          content: eventContent(event.type, scenario, occurrence),
          assistant: eventAssistantContent(event.type, scenario),
          candidate: eventCandidate(event.type, scenario),
          activationRequired: event.type !== 'hotel',
        };
      });
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

export function summarizeNaturalCorpus(config, scenarios) {
  const topicCounts = Object.fromEntries(
    NATURAL_CHAT_TOPICS.map((topic) => [topic, 0]),
  );
  const eventTypeCounts = {};
  const userUtterances = new Set();
  const assistantUtterances = new Set();
  const dailyUserUtterances = new Set();
  const dailyAssistantUtterances = new Set();
  let dailyChatTurns = 0;
  let eventTurns = 0;
  let questionTurns = 0;
  let dailyQuestionTurns = 0;
  let followUpTurns = 0;
  let explicitTestDisclaimerTurns = 0;
  for (const scenario of scenarios) {
    const events = new Map(
      scenario.events.map((event) => [event.index, event]),
    );
    for (let turnIndex = 0;
      turnIndex < config.userTurnsPerPersona;
      turnIndex += 1) {
      const event = events.get(turnIndex);
      const dialogue = event
        ? { user: event.content, assistant: event.assistant }
        : naturalDialogueForTurn(
            scenario,
            turnIndex,
            config.userTurnsPerPersona,
            config.timelineDays,
          );
      if (event) {
        eventTurns += 1;
        eventTypeCounts[event.type] = (eventTypeCounts[event.type] || 0) + 1;
      } else {
        dailyChatTurns += 1;
        topicCounts[dialogue.topic] += 1;
        dailyUserUtterances.add(dialogue.user);
        dailyAssistantUtterances.add(dialogue.assistant);
        if (dialogue.followUp) followUpTurns += 1;
        if (/[？?]$/u.test(dialogue.user)) dailyQuestionTurns += 1;
      }
      if (/[？?]$/u.test(dialogue.user)) questionTurns += 1;
      if (
        /不影响后面的长期安排|不需要把它当作偏好|这不是重复发生的个人习惯|不用根据它推断/u
          .test(dialogue.user)
      ) {
        explicitTestDisclaimerTurns += 1;
      }
      userUtterances.add(dialogue.user);
      assistantUtterances.add(dialogue.assistant);
    }
  }
  const expectedUserTurns = scenarios.length * config.userTurnsPerPersona;
  return {
    generator: 'deterministic-seeded-natural-daily-dialogue-v2',
    generationProvenance: 'template_fixture_not_llm_generated',
    expectedUserTurns,
    actualUserTurns: dailyChatTurns + eventTurns,
    dailyChatTurns,
    eventTurns,
    topicCounts,
    topicRates: Object.fromEntries(
      Object.entries(topicCounts).map(([topic, count]) => [
        topic,
        ratio(count, dailyChatTurns),
      ]),
    ),
    eventTypeCounts,
    questionTurns,
    questionRate: ratio(questionTurns, expectedUserTurns),
    dailyQuestionTurns,
    dailyQuestionRate: ratio(dailyQuestionTurns, dailyChatTurns),
    followUpTurns,
    followUpRate: ratio(followUpTurns, dailyChatTurns),
    uniqueUserUtteranceCount: userUtterances.size,
    uniqueUserUtteranceRate: ratio(userUtterances.size, expectedUserTurns),
    uniqueAssistantUtteranceCount: assistantUtterances.size,
    uniqueAssistantUtteranceRate:
      ratio(assistantUtterances.size, expectedUserTurns),
    uniqueDailyUserUtteranceCount: dailyUserUtterances.size,
    uniqueDailyUserUtteranceRate:
      ratio(dailyUserUtterances.size, dailyChatTurns),
    uniqueDailyAssistantUtteranceCount: dailyAssistantUtterances.size,
    uniqueDailyAssistantUtteranceRate:
      ratio(dailyAssistantUtterances.size, dailyChatTurns),
    explicitTestDisclaimerTurns,
    timelineSpanDays: config.timelineDays,
  };
}

export function passesNaturalCorpusQuality(corpus, scenarioCount) {
  return corpus.actualUserTurns === corpus.expectedUserTurns &&
    NATURAL_CHAT_TOPICS.every((topic) =>
      corpus.topicCounts[topic] >= 1) &&
    corpus.dailyQuestionRate >= 0.9 &&
    corpus.followUpRate >= 0.35 &&
    corpus.uniqueDailyUserUtteranceRate >= 0.9 &&
    corpus.uniqueAssistantUtteranceCount >= 16 &&
    corpus.explicitTestDisclaimerTurns === 0 &&
    corpus.eventTypeCounts.timeline_old === scenarioCount &&
    corpus.eventTypeCounts.timeline_new === scenarioCount &&
    corpus.eventTypeCounts.habit_stop === scenarioCount &&
    corpus.eventTypeCounts.habit_resume === scenarioCount;
}

export function fillerContent(
  scenario,
  turnIndex,
  turnCount,
  timelineDays = 45,
) {
  return naturalDialogueForTurn(
    scenario,
    turnIndex,
    turnCount,
    timelineDays,
  ).user;
}

function assistantContent(
  scenario,
  turnIndex,
  turnCount,
  timelineDays,
) {
  return naturalDialogueForTurn(
    scenario,
    turnIndex,
    turnCount,
    timelineDays,
  ).assistant;
}

function timestampFor(scenarioIndex, turnIndex, turnCount, timelineDays, assistant) {
  const start = Date.parse('2026-01-01T08:00:00.000Z') + scenarioIndex * 3_600_000;
  const fraction = turnIndex / Math.max(1, turnCount - 1);
  const offset = Math.round(fraction * timelineDays * 86_400_000);
  return new Date(start + offset + (assistant ? 30_000 : 0)).toISOString();
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return Number(sorted[index].toFixed(3));
}

function latencySummary(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length > 0 ? Number(Math.max(...values).toFixed(3)) : null,
  };
}

function scalar(database, sql, ...parameters) {
  const row = database.prepare(sql).get(...parameters) || {};
  return Number(Object.values(row)[0] || 0);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isBusyError(error) {
  return /SQLITE_BUSY|database is locked|database is busy/iu.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function retryBusy(operation, counters) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error) || attempt === 19) throw error;
      counters.busyRetries += 1;
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(250, 5 * 2 ** attempt));
      });
    }
  }
  throw new Error('SQLite busy retry exhausted');
}

async function runWorker(specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const database = openDatabase(spec.databasePath);
  let currentTime = timestampFor(
    spec.scenario.scenarioIndex,
    0,
    spec.config.userTurnsPerPersona,
    spec.config.timelineDays,
    false,
  );
  const service = new ConversationService(database, {
    now: () => currentTime,
    instanceId: `natural-writer-${spec.scenario.scenarioIndex}`,
  });
  const counters = { busyRetries: 0, messages: 0, user: 0, assistant: 0 };
  const latencies = [];
  const events = new Map(spec.scenario.events.map((event) => [event.index, event]));
  const started = performance.now();
  try {
    for (let turnIndex = 0;
      turnIndex < spec.config.userTurnsPerPersona;
      turnIndex += 1) {
      const event = events.get(turnIndex);
      const userContent = event?.content || fillerContent(
        spec.scenario,
        turnIndex,
        spec.config.userTurnsPerPersona,
        spec.config.timelineDays,
      );
      currentTime = timestampFor(
        spec.scenario.scenarioIndex,
        turnIndex,
        spec.config.userTurnsPerPersona,
        spec.config.timelineDays,
        false,
      );
      const userStarted = performance.now();
      await retryBusy(() => service.appendMessage(
        { principalId: spec.scenario.principalId, namespace: NAMESPACE },
        spec.scenario.conversationId,
        {
          clientMessageId: `${spec.scenario.key}-user-${turnIndex + 1}`,
          role: 'user',
          content: userContent,
        },
      ), counters);
      latencies.push(performance.now() - userStarted);
      counters.messages += 1;
      counters.user += 1;

      currentTime = timestampFor(
        spec.scenario.scenarioIndex,
        turnIndex,
        spec.config.userTurnsPerPersona,
        spec.config.timelineDays,
        true,
      );
      const assistantStarted = performance.now();
      await retryBusy(() => service.appendMessage(
        { principalId: spec.scenario.principalId, namespace: NAMESPACE },
        spec.scenario.conversationId,
        {
          clientMessageId: `${spec.scenario.key}-assistant-${turnIndex + 1}`,
          role: 'assistant',
          content: event?.assistant || assistantContent(
            spec.scenario,
            turnIndex,
            spec.config.userTurnsPerPersona,
            spec.config.timelineDays,
          ),
        },
      ), counters);
      latencies.push(performance.now() - assistantStarted);
      counters.messages += 1;
      counters.assistant += 1;
    }
    writeImmutableQaFile(spec.resultPath, `${JSON.stringify({
      format: 'memory-bridge-natural-writer:v1',
      scenarioKey: spec.scenario.key,
      principalId: spec.scenario.principalId,
      counters,
      latency: latencySummary(latencies),
      durationMs: Number((performance.now() - started).toFixed(3)),
    }, null, 2)}\n`);
  } finally {
    database.close();
  }
}

function spawnWorker(specPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--worker', specPath], {
      cwd: projectRoot,
      env: { PATH: process.env.PATH || '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-4_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(
          `natural writer failed code=${code} signal=${signal || ''} ` +
          `stdout=${stdout} stderr=${stderr}`,
        ));
        return;
      }
      resolve();
    });
  });
}

function findTurn(database, scenario, event) {
  const row = database.prepare(
    `SELECT id, content FROM conversation_turns
     WHERE user_id = ? AND namespace = ? AND session_id = ?
       AND client_message_id = ? AND role = 'user'`,
  ).get(
    scenario.principalId,
    NAMESPACE,
    scenario.conversationId,
    `${scenario.key}-user-${event.index + 1}`,
  );
  if (!row) throw new Error(`缺少事件 turn: ${scenario.key}/${event.type}`);
  return { id: String(row.id), content: String(row.content) };
}

async function materializeGold(database, scenarios) {
  const lifecycle = new LifecycleStore(database);
  const memoryStore = new MemoryStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycle,
    memoryStore,
    {
      mode: 'auto',
      autoCommitMinConfidence: 0.95,
      autoCommitMinImportance: 0.5,
    },
  );
  const gold = new Map();
  const resolutions = [];
  for (const scenario of scenarios) {
    const scenarioGold = {};
    for (const event of scenario.events) {
      const turn = findTurn(database, scenario, event);
      if (event.candidate) {
        const runId = lifecycle.startExtraction(
          turn.id,
          'qa-gold-materializer',
          'natural-conversation-gold-v1',
          'qa-natural-gold',
          'v1',
        );
        const [candidate] = lifecycle.completeExtraction(
          runId,
          [{ ...event.candidate, sourceExcerpt: turn.content }],
          { enqueueResolution: false },
        );
        if (!candidate) {
          throw new Error(`gold 候选未持久化: ${scenario.key}/${event.type}`);
        }
        const result = await resolver.resolve(candidate.id);
        if (result.state !== 'accepted' || !result.memoryId) {
          throw new Error(
            `gold 候选未接受: ${scenario.key}/${event.type}/${result.reason}`,
          );
        }
        resolutions.push({
          scenarioKey: scenario.key,
          eventType: event.type,
          candidateId: candidate.id,
          memoryId: result.memoryId,
          relation: result.relation,
          reason: result.reason,
        });
        if (event.type === 'drink') scenarioGold.drinkId = result.memoryId;
        if (event.type === 'commute') scenarioGold.commuteId = result.memoryId;
        if (event.type === 'role_style') scenarioGold.roleStyleId = result.memoryId;
        if (event.type === 'editor_old') scenarioGold.editorId = result.memoryId;
        if (event.type === 'editor_new') {
          scenarioGold.editorId = result.memoryId;
          scenarioGold.editorCorrectionRelation = result.relation;
        }
        if (event.type === 'hotel') scenarioGold.hotelId = result.memoryId;
      }
      if (event.type === 'forget_hotel') {
        if (!scenarioGold.hotelId) throw new Error('遗忘事件缺少住宿记忆');
        memoryStore.forget(
          scenarioGold.hotelId,
          '自然对话测试中的明确遗忘请求',
          scenario.principalId,
        );
      }
    }
    gold.set(scenario.key, scenarioGold);
  }
  return { gold, resolutions };
}

function noopExtractor() {
  return {
    model: 'qa-noop',
    promptVersion: 'qa-noop-v1',
    extractorId: 'qa-noop',
    extractorVersion: 'v1',
    async extract() {
      return [];
    },
  };
}

function auditedNoMemoryExtractor() {
  return {
    model: 'qa-deterministic-no-memory',
    promptVersion: 'qa-deterministic-no-memory-v1',
    extractorId: 'qa-deterministic-no-memory',
    extractorVersion: 'v1',
    async extract() {
      return [];
    },
  };
}

function createQaPipelineExtractor(realModelAvailable) {
  const telemetry = {
    mode: realModelAvailable
      ? 'production-extractor-full-job-drain'
      : 'deterministic-no-memory-full-job-drain',
    physicalProviderCalls: 0,
  };
  if (!realModelAvailable) {
    return { extractor: auditedNoMemoryExtractor(), telemetry };
  }
  return {
    extractor: new OllamaMemoryExtractor({
      baseUrl: OLLAMA_URL,
      model: REQUIRED_GENERATION_MODEL,
      promptVersion: 'qa-natural-full-pipeline-extraction-v1',
      timeoutMs: MODEL_TIMEOUT_MS,
      fetchImpl: async (...args) => {
        telemetry.physicalProviderCalls += 1;
        return fetch(...args);
      },
    }),
    telemetry,
  };
}

function deterministicSummaryProvider() {
  return {
    model: REQUIRED_GENERATION_MODEL,
    promptVersion: 'qa-schema37-deterministic-summary-v1',
    async consolidate(_scope, sources) {
      return {
        sentences: [{
          text: `本时间桶包含 ${sources.length} 个有来源的对话情景。`,
          sourceVersionIds: sources.map((source) => source.memoryVersionId),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'qa_schema37_source_set_contract',
      }));
    },
  };
}

function unfinishedSchema37Work(database, includeRetention = true) {
  return scalar(
    database,
    `SELECT COUNT(*) FROM outbox_events
     WHERE namespace = ? AND status IN ('pending', 'processing', 'failed')`,
    NAMESPACE,
  ) + scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE namespace = ?
       AND job_type IN (
         'extract_turn', 'resolve_candidate', 'materialize_episode',
         'summarize_memory_bucket', 'index_memory',
         'consolidate_memory_change', 'consolidate_scope',
         'consolidation_sweep', 'retention_sweep'
       )
       AND status IN ('pending', 'running', 'failed')
       AND (? = 1 OR job_type != 'retention_sweep')
       AND available_at <= ?`,
    NAMESPACE,
    includeRetention ? 1 : 0,
    new Date().toISOString(),
  );
}

export function schema37DrainIdleDecision({
  remainingWork,
  idleForMs,
  foregroundQuietMs,
}) {
  if (remainingWork <= 0) return { action: 'complete', waitMs: 0 };
  const maximumIdleMs = Math.max(10_000, foregroundQuietMs + 10_000);
  if (idleForMs > maximumIdleMs) return { action: 'timeout', waitMs: 0 };
  return { action: 'wait', waitMs: 100 };
}

async function drainSchema37Pipeline(
  database,
  scenarios,
  ranker,
  options = {},
) {
  const includeRetention = options.includeRetention !== false;
  const lifecycle = new LifecycleStore(database);
  const store = new MemoryStore(database, ranker);
  await store.prepareDenseIndexScopes();
  const extractor = options.extractor || auditedNoMemoryExtractor();
  const candidateResolver = new CandidateResolver(
    database,
    lifecycle,
    store,
    { mode: options.candidateMode || 'shadow' },
  );
  const consolidator = new MemoryConsolidator(
    database,
    lifecycle,
    store,
    deterministicSummaryProvider(),
  );
  const governance = new MemoryGovernance(
    database,
    lifecycle,
    store,
  );
  if (includeRetention) {
    for (const principalId of new Set(
      scenarios.map((scenario) => scenario.principalId),
    )) {
      governance.ensureRetentionSweep(
        new Date().toISOString(),
        principalId,
        NAMESPACE,
      );
    }
  }
  const worker = new MemoryWorker(
    lifecycle,
    extractor,
    candidateResolver,
    consolidator,
    includeRetention ? governance : undefined,
    true,
    store,
    undefined,
    undefined,
    new EpisodicMemoryService(database),
    new HierarchicalSummaryService(
      database,
      store,
      deterministicSummaryProvider(),
    ),
  );
  const counters = {
    iterations: 0,
    outboxDispatched: 0,
    episodeJobs: 0,
    summaryJobs: 0,
    denseJobs: 0,
    extractionJobs: 0,
    resolutionJobs: 0,
    extractionCandidates: 0,
    consolidationJobs: 0,
    retentionJobs: 0,
  };
  const expectedExchanges = scenarios.reduce(
    (total, scenario) => total + scenario.userTurnsPerPersona,
    0,
  );
  const maximumIterations = expectedExchanges * 10 + 10_000;
  const processAvailable = async () => {
    let idleStartedAt = null;
    while (unfinishedSchema37Work(database, includeRetention) > 0) {
      if (counters.iterations >= maximumIterations) {
        throw new Error('schema 37 派生链未在有界步数内收敛');
      }
      const beforeOutbox = scalar(
        database,
        `SELECT COUNT(*) FROM outbox_events
         WHERE namespace = ? AND status = 'completed'`,
        NAMESPACE,
      );
      const result = await worker.processNext(
        `qa-schema37-worker-${counters.iterations % 4}`,
        { backgroundModelAllowed: true },
      );
      counters.iterations += 1;
      const afterOutbox = scalar(
        database,
        `SELECT COUNT(*) FROM outbox_events
         WHERE namespace = ? AND status = 'completed'`,
        NAMESPACE,
      );
      counters.outboxDispatched += Math.max(0, afterOutbox - beforeOutbox);
      if (result.error) throw new Error(`schema 37 outbox 失败：${result.error}`);
      if (result.job?.jobType === 'materialize_episode') counters.episodeJobs += 1;
      if (result.job?.jobType === 'summarize_memory_bucket') counters.summaryJobs += 1;
      if (result.job?.jobType === 'index_memory') counters.denseJobs += 1;
      if (result.job?.jobType === 'extract_turn') {
        counters.extractionJobs += 1;
        counters.extractionCandidates += result.candidateCount;
      }
      if (result.job?.jobType === 'resolve_candidate') {
        counters.resolutionJobs += 1;
      }
      if (result.job?.jobType.startsWith('consolidat')) {
        counters.consolidationJobs += 1;
      }
      if (result.job?.jobType === 'retention_sweep') {
        counters.retentionJobs += 1;
      }
      if (result.processed || result.job) {
        idleStartedAt = null;
        continue;
      }
      idleStartedAt ??= performance.now();
      const remainingWork = unfinishedSchema37Work(
        database,
        includeRetention,
      );
      const decision = schema37DrainIdleDecision({
        remainingWork,
        idleForMs: performance.now() - idleStartedAt,
        foregroundQuietMs: config.foregroundQuietMs,
      });
      if (decision.action === 'complete') break;
      if (decision.action === 'timeout') {
        throw new Error(
          `schema 37 派生链有 ${remainingWork} 个到期任务，但 Worker 在有界静默期内未取得进展`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, decision.waitMs));
    }
  };
  await processAvailable();
  for (const scenario of scenarios) {
    lifecycle.endSession(
      scenario.principalId,
      'conversation-api',
      scenario.conversationId,
    );
  }
  await processAvailable();
  const denseBackfill = await backfillDense(
    store,
    [...new Set(scenarios.map((scenario) => scenario.principalId))],
  );
  return { counters, denseBackfill, store };
}

function extractionLedgerSnapshot(database) {
  const now = new Date().toISOString();
  const expectedUserTurns = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_turns
     WHERE namespace = ? AND role = 'user'`,
    NAMESPACE,
  );
  const completedExtractionRuns = scalar(
    database,
    `SELECT COUNT(*) FROM extraction_runs r
     JOIN conversation_turns t ON t.id = r.turn_id
     WHERE t.namespace = ? AND r.status = 'completed'`,
    NAMESPACE,
  );
  const coveredUserTurns = scalar(
    database,
    `SELECT COUNT(DISTINCT r.turn_id) FROM extraction_runs r
     JOIN conversation_turns t ON t.id = r.turn_id
     WHERE t.namespace = ? AND t.role = 'user'
       AND r.status = 'completed'`,
    NAMESPACE,
  );
  const provenance = database.prepare(
    `SELECT r.model, r.extractor_id AS extractorId,
            r.extractor_version AS extractorVersion,
            r.prompt_contract_version AS promptContractVersion,
            r.status, COUNT(*) AS count
     FROM extraction_runs r
     JOIN conversation_turns t ON t.id = r.turn_id
     WHERE t.namespace = ?
     GROUP BY r.model, r.extractor_id, r.extractor_version,
              r.prompt_contract_version, r.status
     ORDER BY count DESC, r.model ASC`,
  ).all(NAMESPACE).map((row) => ({
    ...row,
    count: Number(row.count || 0),
  }));
  const candidateStates = database.prepare(
    `SELECT c.state, c.extractor_id AS extractorId, COUNT(*) AS count
     FROM memory_candidates c
     WHERE c.namespace = ?
     GROUP BY c.state, c.extractor_id
     ORDER BY count DESC, c.state ASC`,
  ).all(NAMESPACE).map((row) => ({
    ...row,
    count: Number(row.count || 0),
  }));
  return {
    expectedUserTurns,
    extractionJobCount: scalar(
      database,
      `SELECT COUNT(*) FROM memory_jobs
       WHERE namespace = ? AND job_type = 'extract_turn'`,
      NAMESPACE,
    ),
    completedExtractionJobs: scalar(
      database,
      `SELECT COUNT(*) FROM memory_jobs
       WHERE namespace = ? AND job_type = 'extract_turn'
         AND status = 'completed'`,
      NAMESPACE,
    ),
    dueExtractionJobs: scalar(
      database,
      `SELECT COUNT(*) FROM memory_jobs
       WHERE namespace = ? AND job_type = 'extract_turn'
         AND status IN ('pending', 'failed') AND available_at <= ?`,
      NAMESPACE,
      now,
    ),
    unhealthyExtractionJobs: scalar(
      database,
      `SELECT COUNT(*) FROM memory_jobs
       WHERE namespace = ? AND job_type = 'extract_turn'
         AND status IN ('running', 'failed', 'dead')`,
      NAMESPACE,
    ),
    openResolutionJobs: scalar(
      database,
      `SELECT COUNT(*) FROM memory_jobs
       WHERE namespace = ? AND job_type = 'resolve_candidate'
         AND status IN ('pending', 'running', 'failed')
         AND available_at <= ?`,
      NAMESPACE,
      now,
    ),
    completedExtractionRuns,
    nonCompletedExtractionRuns: scalar(
      database,
      `SELECT COUNT(*) FROM extraction_runs r
       JOIN conversation_turns t ON t.id = r.turn_id
       WHERE t.namespace = ? AND r.status != 'completed'`,
      NAMESPACE,
    ),
    coveredUserTurns,
    turnCoverageRate: ratio(coveredUserTurns, expectedUserTurns),
    candidateBearingRuns: scalar(
      database,
      `SELECT COUNT(DISTINCT r.id) FROM extraction_runs r
       JOIN conversation_turns t ON t.id = r.turn_id
       JOIN memory_candidates c ON c.extraction_run_id = r.id
       WHERE t.namespace = ? AND r.status = 'completed'`,
      NAMESPACE,
    ),
    noMemoryRuns: completedExtractionRuns - scalar(
      database,
      `SELECT COUNT(DISTINCT r.id) FROM extraction_runs r
       JOIN conversation_turns t ON t.id = r.turn_id
       JOIN memory_candidates c ON c.extraction_run_id = r.id
       WHERE t.namespace = ? AND r.status = 'completed'`,
      NAMESPACE,
    ),
    provenance,
    candidateStates,
  };
}

function candidateTextsForTurn(database, turnId, extractorId) {
  return database.prepare(
    `SELECT c.subject, c.predicate, c.value_text AS value
     FROM memory_candidates c
     JOIN extraction_runs r ON r.id = c.extraction_run_id
     WHERE c.turn_id = ? AND r.extractor_id = ?
     ORDER BY c.created_at ASC, c.id ASC`,
  ).all(turnId, extractorId).map((row) =>
    [row.subject, row.predicate, row.value]
      .map((value) => String(value || '').normalize('NFKC'))
      .join(' '));
}

function labeledValueSupported(candidateText, expectedValue) {
  const normalize = (value) => String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const candidate = normalize(candidateText);
  const expected = normalize(expectedValue);
  if (!candidate || !expected) return false;
  if (candidate.includes(expected)) return true;
  if (expected.length < 4) return false;
  const expectedBigrams = new Set();
  for (let index = 0; index < expected.length - 1; index += 1) {
    expectedBigrams.add(expected.slice(index, index + 2));
  }
  let matched = 0;
  for (const bigram of expectedBigrams) {
    if (candidate.includes(bigram)) matched += 1;
  }
  return matched / Math.max(1, expectedBigrams.size) >= 0.6;
}

function evaluatePipelineExtractionCoverage(
  database,
  scenarios,
  extractorId,
) {
  const positives = [];
  const negativeNoise = [];
  const implicitPatterns = [];
  let ordinaryDailyQuestionCount = 0;
  let ordinaryDailyQuestionCandidateCount = 0;
  const ordinaryDailyQuestionPollutionSamples = [];
  for (const scenario of scenarios) {
    const eventTurnIds = new Set();
    for (const event of scenario.events) {
      const turn = findTurn(database, scenario, event);
      eventTurnIds.add(turn.id);
      const candidateTexts = candidateTextsForTurn(
        database,
        turn.id,
        extractorId,
      );
      if (event.candidate && event.type !== 'hotel') {
        const expected = String(event.candidate.value).normalize('NFKC');
        positives.push({
          scenarioKey: scenario.key,
          type: event.type,
          expected,
          candidateCount: candidateTexts.length,
          matched: candidateTexts.some((text) =>
            labeledValueSupported(text, expected)),
        });
      } else if (
        ['quote_noise', 'hypothetical_noise'].includes(event.type)
      ) {
        negativeNoise.push({
          scenarioKey: scenario.key,
          type: event.type,
          candidateCount: candidateTexts.length,
          abstained: candidateTexts.length === 0,
        });
      } else if (event.type === 'habit') {
        implicitPatterns.push({
          scenarioKey: scenario.key,
          type: event.type,
          candidateCount: candidateTexts.length,
          deferredToReflection: candidateTexts.length === 0,
        });
      }
    }
    const ordinaryTurns = database.prepare(
      `SELECT t.id, t.content, COUNT(c.id) AS candidate_count
       FROM conversation_turns t
       LEFT JOIN extraction_runs r
         ON r.turn_id = t.id AND r.extractor_id = ?
       LEFT JOIN memory_candidates c ON c.extraction_run_id = r.id
       WHERE t.user_id = ? AND t.namespace = ? AND t.session_id = ?
         AND t.role = 'user'
       GROUP BY t.id, t.content
       ORDER BY t.occurred_at ASC, t.id ASC`,
    ).all(
      extractorId,
      scenario.principalId,
      NAMESPACE,
      scenario.conversationId,
    );
    for (const row of ordinaryTurns) {
      const turnId = String(row.id);
      if (eventTurnIds.has(turnId) || !/[？?]$/u.test(String(row.content))) {
        continue;
      }
      const candidateCount = Number(row.candidate_count || 0);
      ordinaryDailyQuestionCount += 1;
      ordinaryDailyQuestionCandidateCount += candidateCount;
      if (
        candidateCount > 0 &&
        ordinaryDailyQuestionPollutionSamples.length < 50
      ) {
        ordinaryDailyQuestionPollutionSamples.push({
          scenarioKey: scenario.key,
          turnId,
          content: String(row.content),
          candidateTexts: candidateTextsForTurn(
            database,
            turnId,
            extractorId,
          ),
        });
      }
    }
  }
  const ordinaryDailyQuestionAssessment =
    assessOrdinaryDailyQuestionExtraction({
      ordinaryDailyQuestionCount,
      ordinaryDailyQuestionCandidateCount,
    });
  return {
    extractorId,
    positiveCount: positives.length,
    positiveCoverageRate: ratio(
      positives.filter((item) => item.matched).length,
      positives.length,
    ),
    negativeNoiseCount: negativeNoise.length,
    negativeAbstentionRate: ratio(
      negativeNoise.filter((item) => item.abstained).length,
      negativeNoise.length,
    ),
    implicitPatternCount: implicitPatterns.length,
    implicitPatternDeferralRate: ratio(
      implicitPatterns.filter((item) => item.deferredToReflection).length,
      implicitPatterns.length,
    ),
    ...ordinaryDailyQuestionAssessment,
    ordinaryDailyQuestionPollutionSamples,
    positives,
    negativeNoise,
    implicitPatterns,
  };
}

function productionCandidatesForTurn(database, turnId, extractorId) {
  return database.prepare(
    `SELECT c.id, c.subject, c.predicate, c.value_text AS value,
            c.state, c.decision_reason, c.source_excerpt,
            c.resolved_memory_item_id
     FROM memory_candidates c
     JOIN extraction_runs r ON r.id = c.extraction_run_id
     WHERE c.turn_id = ? AND r.extractor_id = ?
     ORDER BY c.created_at ASC, c.id ASC`,
  ).all(turnId, extractorId).map((row) => ({
    id: String(row.id),
    text: [row.subject, row.predicate, row.value]
      .map((value) => String(value || '').normalize('NFKC'))
      .join(' '),
    value: String(row.value || ''),
    state: String(row.state || ''),
    sourceExcerpt: row.source_excerpt
      ? String(row.source_excerpt)
      : null,
    resolvedMemoryItemId: row.resolved_memory_item_id
      ? String(row.resolved_memory_item_id)
      : null,
    decisionReason: row.decision_reason
      ? String(row.decision_reason)
      : null,
  }));
}

function productionEvidenceSnapshot(database, scenarios, extractorId) {
  const samples = [];
  for (const scenario of scenarios) {
    for (const event of scenario.events) {
      if (!event.candidate) continue;
      const turn = findTurn(database, scenario, event);
      const expectedValue = String(event.candidate.value).normalize('NFKC');
      const matched = productionCandidatesForTurn(
        database,
        turn.id,
        extractorId,
      ).find((candidate) =>
        labeledValueSupported(candidate.text, expectedValue));
      samples.push({
        scenarioKey: scenario.key,
        eventType: event.type,
        turnId: turn.id,
        candidateId: matched?.id || null,
        sourceExcerpt: matched?.sourceExcerpt || null,
      });
    }
  }
  const redactedUserTurnCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_turns
     WHERE namespace = ? AND role = 'user'
       AND content = '[retention-redacted]'`,
    NAMESPACE,
  );
  return {
    redactedUserTurnCount,
    samples,
    ...assessProductionEvidenceReadiness({
      redactedUserTurnCount,
      samples,
    }),
  };
}

function assignLearnedMemoryId(target, eventType, resolution) {
  const fields = {
    identity: 'identityId',
    drink: 'drinkId',
    occupation: 'occupationId',
    commute: 'commuteId',
    food_aversion: 'foodAversionId',
    role_style: 'roleStyleId',
    learning_goal: 'learningGoalId',
    editor_old: 'editorId',
    editor_new: 'editorId',
    relationship: 'relationshipId',
    home_city: 'homeCityId',
    reminder_rule: 'reminderRuleId',
    hotel: 'hotelId',
  };
  const field = fields[eventType];
  if (field && resolution.memoryId) target[field] = resolution.memoryId;
  if (eventType === 'editor_new') {
    target.editorCorrectionRelation = resolution.relation;
  }
}

async function resolveProductionLabeledMemories(
  database,
  scenarios,
  extractorId,
) {
  const lifecycle = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycle,
    new MemoryStore(database),
    {
      mode: 'auto',
      autoCommitMinConfidence: 0.95,
      autoCommitMinImportance: 0.5,
    },
  );
  const gold = new Map();
  const samples = [];
  for (const scenario of scenarios) {
    const learned = {};
    for (const event of scenario.events) {
      if (!event.candidate) continue;
      const turn = findTurn(database, scenario, event);
      const candidates = productionCandidatesForTurn(
        database,
        turn.id,
        extractorId,
      );
      const expectedValue = String(event.candidate.value).normalize('NFKC');
      const matched = candidates.find((candidate) =>
        labeledValueSupported(candidate.text, expectedValue));
      let resolution = null;
      let error = null;
      if (matched) {
        try {
          resolution = await resolver.resolve(matched.id);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
      }
      const passed = Boolean(
        matched && resolution?.state === 'accepted' && resolution.memoryId,
      );
      if (passed) assignLearnedMemoryId(learned, event.type, resolution);
      samples.push({
        scenarioKey: scenario.key,
        eventType: event.type,
        activationRequired: event.activationRequired,
        expectedValue,
        candidateId: matched?.id || null,
        candidateCount: candidates.length,
        resolutionState: resolution?.state || null,
        resolutionReason: resolution?.reason || null,
        relation: resolution?.relation || null,
        memoryId: resolution?.memoryId || null,
        passed,
        error: error ? error.slice(0, 500) : null,
      });
    }
    gold.set(scenario.key, learned);
  }
  const activationSamples = samples.filter((sample) =>
    sample.activationRequired);
  const passedCount = activationSamples.filter((sample) =>
    sample.passed).length;
  return {
    extractorId,
    totalLabeledCount: samples.length,
    expectedCount: activationSamples.length,
    passedCount,
    activationRate: ratio(passedCount, activationSamples.length),
    missingOrPending: activationSamples.filter((sample) => !sample.passed),
    reviewRequired: samples.filter((sample) => !sample.activationRequired),
    samples,
    gold,
  };
}

export function productionCorrectionPathSnapshot(scenarios, gold) {
  const relations = scenarios.map((scenario) => ({
    scenarioKey: scenario.key,
    relation: gold.get(scenario.key)?.editorCorrectionRelation || null,
  }));
  return {
    passed: relations.every((item) => item.relation === 'supersedes'),
    relations,
  };
}

async function executeProductionExplicitForgets(
  database,
  scenarios,
  store,
  extractorId,
  gold,
) {
  const lifecycle = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycle,
    store,
    {
      mode: 'auto',
      autoCommitMinConfidence: 0.95,
      autoCommitMinImportance: 0.5,
    },
  );
  const governance = new MemoryGovernance(database, lifecycle, store);
  const admin = new MemoryAdminService(
    database,
    store,
    lifecycle,
    resolver,
    governance,
  );
  const hotelByForgetText = new Map(scenarios.map((scenario) => {
    const event = scenario.events.find((candidate) =>
      candidate.type === 'forget_hotel');
    return [event?.content || '', scenario.hotel];
  }));
  const provider = {
    model: 'qa-deterministic-explicit-forget',
    promptVersion: 'qa-deterministic-explicit-forget-v1',
    async classify(userText, actionHint) {
      const hotel = hotelByForgetText.get(userText);
      if (actionHint !== 'forget' || !hotel) {
        throw new Error('正式遗忘 QA 收到未标注的自然语言请求');
      }
      return {
        action: 'forget',
        confidence: 1,
        sensitivity: 'normal',
        targetQuery: `${hotel} 临时住宿安排`,
        candidate: null,
        rationale: 'qa_confirmed_explicit_forget',
      };
    },
  };
  const intentService = new ExplicitMemoryIntentService(
    database,
    lifecycle,
    store,
    resolver,
    provider,
  );
  const samples = [];
  for (const scenario of scenarios) {
    const event = scenario.events.find((candidate) =>
      candidate.type === 'forget_hotel');
    const hotelEvent = scenario.events.find((candidate) =>
      candidate.type === 'hotel');
    let serviceResult = null;
    let reviewResult = null;
    let preconditionReview = null;
    let intentHandleInvoked = false;
    let error = null;
    let memoryStatus = null;
    let activeTombstoneCount = 0;
    let expectedMemoryId = gold.get(scenario.key)?.hotelId || null;
    try {
      if (!event || !hotelEvent) {
        throw new Error('角色缺少住宿或正式遗忘事件');
      }
      const hotelTurn = findTurn(database, scenario, hotelEvent);
      const matched = productionCandidatesForTurn(
        database,
        hotelTurn.id,
        extractorId,
      ).find((candidate) =>
        labeledValueSupported(candidate.text, scenario.hotel));
      if (!matched) {
        throw new Error('正式住宿候选不存在');
      }
      if (
        matched.state === 'accepted' &&
        matched.resolvedMemoryItemId
      ) {
        expectedMemoryId = matched.resolvedMemoryItemId;
      } else if (
        matched.state === 'pending' || matched.state === 'conflicted'
      ) {
        preconditionReview = resolver.acceptForReview(matched.id);
        expectedMemoryId = preconditionReview.memoryId;
      } else {
        throw new Error('正式住宿候选不能进入遗忘前人工确认');
      }
      if (!expectedMemoryId) {
        throw new Error('遗忘前人工确认没有形成住宿记忆');
      }
      gold.get(scenario.key).hotelId = expectedMemoryId;
      intentHandleInvoked = true;
      serviceResult = await intentService.handle({
        userId: scenario.principalId,
        namespace: NAMESPACE,
        personaId: scenario.personaId,
        identitySource: 'credential',
        identityStatus: 'complete',
        trustedProjectId: scenario.projectId,
        scopes: scenarioRecallScopes(scenario),
        clientName: 'conversation-api',
        sessionExternalId: scenario.conversationId,
        userTurnExternalId:
          `${scenario.key}-user-${event.index + 1}`,
        userText: event.content,
      });
      if (
        serviceResult.status === 'pending' &&
        serviceResult.actionRequestId
      ) {
        reviewResult = admin.acceptMemoryActionRequest(
          serviceResult.actionRequestId,
          { memoryId: expectedMemoryId },
          scenario.principalId,
        );
      }
      const completedMemoryId = reviewResult?.memoryId ||
        serviceResult.memoryId;
      if (completedMemoryId !== expectedMemoryId) {
        throw new Error('正式遗忘没有删除预期住宿记忆');
      }
      memoryStatus = store.get(
        expectedMemoryId,
        true,
        scenario.principalId,
      )?.status || null;
      activeTombstoneCount = scalar(
        database,
        `SELECT COUNT(*) FROM memory_tombstones
         WHERE memory_item_id = ? AND user_id = ? AND namespace = ?
           AND restored_at IS NULL`,
        expectedMemoryId,
        scenario.principalId,
        NAMESPACE,
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    samples.push({
      scenarioKey: scenario.key,
      expectedMemoryId,
      actionRequestId: serviceResult?.actionRequestId || null,
      intentHandleInvoked,
      preconditionReviewState: preconditionReview?.state || null,
      manualActivationPerformed: Boolean(preconditionReview),
      serviceStatus: serviceResult?.status || null,
      reviewStatus: reviewResult?.status || null,
      memoryStatus,
      activeTombstoneCount,
      passed:
        !error && intentHandleInvoked && memoryStatus === 'deleted' &&
        activeTombstoneCount >= 1,
      error: error ? error.slice(0, 500) : null,
    });
  }
  return {
    expectedCount: scenarios.length,
    passedCount: samples.filter((sample) => sample.passed).length,
    passed: samples.length === scenarios.length &&
      samples.every((sample) => sample.passed),
    samples,
  };
}

function normalizedQaValue(value) {
  return String(value || '').normalize('NFKC').trim();
}

export function authorizeEquivalentPersonalMemoryIds(item, candidates) {
  const expectation = item?.personalEquivalence;
  if (!expectation) return [];
  const personalVisible = (item.scopes || []).some((scope) =>
    scope.scopeType === 'personal' && scope.scopeKey === 'self');
  if (!personalVisible) return [];
  const candidateIds = new Set(expectation.candidateIds || []);
  const normalizedValue = normalizedQaValue(expectation.normalizedValue);
  return [...new Set((candidates || []).filter((candidate) =>
    candidateIds.has(candidate.id) &&
    candidate.userId === item.userId &&
    candidate.namespace === item.namespace &&
    candidate.scopeType === 'personal' &&
    candidate.scopeKey === 'self' &&
    candidate.status === 'active' &&
    candidate.semanticSlot === expectation.semanticSlot &&
    normalizedQaValue(candidate.normalizedValue) === normalizedValue)
    .map((candidate) => candidate.id))];
}

function equivalentPersonalIdsFromDatabase(database, item) {
  const expectation = item.personalEquivalence;
  const candidateIds = [...new Set(expectation?.candidateIds || [])];
  if (!database || candidateIds.length === 0) return [];
  const rows = database.prepare(
    `SELECT id, user_id AS userId, namespace,
            scope_type AS scopeType, scope_key AS scopeKey,
            status, normalized_value AS normalizedValue
     FROM memory_items
     WHERE id IN (${candidateIds.map(() => '?').join(', ')})`,
  ).all(...candidateIds).map((row) => ({
    ...row,
    semanticSlot: expectation.semanticSlot,
  }));
  return authorizeEquivalentPersonalMemoryIds(item, rows);
}

export function learnedMemoryQueryCases(scenarios, gold, database = null) {
  const cases = [];
  const missing = [];
  const add = (base, specification) => {
    const expectedIds = specification.expectedIds.filter(Boolean);
    if (expectedIds.length !== specification.expectedIds.length) {
      missing.push(specification.id);
      return;
    }
    const item = {
      forbiddenIds: [],
      forbiddenValues: [],
      abstentionExpected: false,
      ...base,
      ...specification,
      expectedIds,
    };
    item.expectedIds = [...new Set([
      ...item.expectedIds,
      ...equivalentPersonalIdsFromDatabase(database, item),
    ])];
    cases.push(item);
  };
  for (const scenario of scenarios) {
    const own = gold.get(scenario.key) || {};
    const otherRole = scenarios.find((candidate) =>
      candidate.principalId === scenario.principalId &&
      candidate.personaId !== scenario.personaId);
    const otherUser = scenarios.find((candidate) =>
      candidate.principalId !== scenario.principalId &&
      candidate.personaIndex === scenario.personaIndex);
    const base = {
      scenarioKey: scenario.key,
      userId: scenario.principalId,
      namespace: NAMESPACE,
      scopes: scenarioRecallScopes(scenario),
    };
    for (const specification of [
      { suffix: 'drink', query: '平时给我点饮料，优先选什么？', id: own.drinkId,
        goldField: 'drinkId', valueField: 'drink' },
      { suffix: 'commute', query: '工作日我平常怎么去上班？', id: own.commuteId,
        goldField: 'commuteId', valueField: 'commute' },
      { suffix: 'occupation', query: '我的职业背景是什么？', id: own.occupationId,
        goldField: 'occupationId', valueField: 'occupation' },
      { suffix: 'city', query: '我长期生活在哪个城市？', id: own.homeCityId,
        goldField: 'homeCityId', valueField: 'homeCity' },
      { suffix: 'food', query: '给我推荐吃的时要避开什么？', id: own.foodAversionId,
        goldField: 'foodAversionId', valueField: 'foodAversion' },
      { suffix: 'goal', query: '我今年长期想学成什么？', id: own.learningGoalId,
        goldField: 'learningGoalId', valueField: 'learningGoal' },
      { suffix: 'style', query: '这个角色应该怎样组织回复？', id: own.roleStyleId },
      { suffix: 'editor', query: '我现在常用哪个编辑器？', id: own.editorId,
        forbiddenValues: [scenario.oldEditor] },
    ]) {
      const equivalentCandidateIds = specification.goldField
        ? scenarios.filter((candidate) =>
          candidate.key !== scenario.key &&
          candidate.principalId === scenario.principalId &&
          normalizedQaValue(candidate[specification.valueField]) ===
            normalizedQaValue(scenario[specification.valueField]))
          .map((candidate) => gold.get(candidate.key)?.[specification.goldField])
          .filter(Boolean)
        : [];
      add(base, {
        id: `${scenario.key}:learned-${specification.suffix}`,
        category: specification.suffix === 'editor'
          ? 'correction'
          : 'learned_fact',
        query: specification.query,
        expectedIds: [specification.id],
        forbiddenValues: specification.forbiddenValues || [],
        personalEquivalence: specification.goldField
          ? {
              semanticSlot: specification.suffix,
              normalizedValue: scenario[specification.valueField],
              candidateIds: equivalentCandidateIds,
            }
          : null,
      });
    }
    const forgottenCaseId = `${scenario.key}:learned-forgotten`;
    if (!own.hotelId) {
      missing.push(forgottenCaseId);
    } else {
      cases.push({
        ...base,
        id: forgottenCaseId,
        category: 'forgotten',
        query: `我之前说的${scenario.hotel}临时住宿安排还有效吗？`,
        expectedIds: [],
        forbiddenIds: [own.hotelId],
        forbiddenValues: [scenario.hotel],
        abstentionExpected: true,
      });
    }
    if (otherRole) {
      const other = gold.get(otherRole.key) || {};
      add(base, {
        id: `${scenario.key}:learned-role-leak`,
        category: 'cross_role',
        query: `当前角色是否要求${otherRole.responseStyle}？`,
        expectedIds: [],
        forbiddenIds: [other.roleStyleId],
        forbiddenValues: [otherRole.responseStyle],
      });
    }
    if (otherUser) {
      const other = gold.get(otherUser.key) || {};
      add(base, {
        id: `${scenario.key}:learned-account-leak`,
        category: 'cross_account',
        query: `我是不是最常喝${otherUser.drink}？`,
        expectedIds: [],
        forbiddenIds: [other.drinkId],
        forbiddenValues: [otherUser.drink],
      });
    }
    cases.push({
      ...base,
      id: `${scenario.key}:learned-negative`,
      category: 'negative_noise',
      query: '我有没有说过自己养蜥蜴？',
      expectedIds: [],
      forbiddenIds: [],
      forbiddenValues: [],
      abstentionExpected: true,
    });
  }
  return { cases, missing };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

function schema37Snapshot(database, scenarios, options = {}) {
  const expectedExchanges = scenarios.reduce(
    (total, scenario) => total + scenario.userTurnsPerPersona,
    0,
  );
  const episodeCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes
     WHERE namespace = ? AND status = 'active'`,
    NAMESPACE,
  );
  const completeEpisodeCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN conversation_turns u ON u.id = e.user_turn_id
     JOIN conversation_turns a ON a.id = e.assistant_turn_id
     WHERE e.namespace = ? AND e.status = 'active'
       AND u.role = 'user' AND a.role = 'assistant'
       AND u.session_id = e.session_id AND a.session_id = e.session_id
       AND u.user_id = e.user_id AND a.user_id = e.user_id
       AND u.namespace = e.namespace AND a.namespace = e.namespace`,
    NAMESPACE,
  );
  const episodeTurnBindingCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     WHERE e.namespace = ? AND e.status = 'active'
       AND (SELECT COUNT(*) FROM conversation_episode_turns et
            WHERE et.episode_id = e.id) = 2
       AND EXISTS (
         SELECT 1 FROM conversation_episode_turns et
         WHERE et.episode_id = e.id AND et.turn_id = e.user_turn_id
           AND et.role = 'user' AND et.ordinal = 0
       )
       AND EXISTS (
         SELECT 1 FROM conversation_episode_turns et
         WHERE et.episode_id = e.id AND et.turn_id = e.assistant_turn_id
           AND et.role = 'assistant' AND et.ordinal = 1
       )`,
    NAMESPACE,
  );
  const episodeFtsCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN memories_fts f ON f.memory_id = e.memory_id
     WHERE e.namespace = ? AND e.status = 'active'`,
    NAMESPACE,
  );
  const episodeDenseCount = scalar(
    database,
    `SELECT COUNT(DISTINCT e.id) FROM conversation_episodes e
     JOIN dense_index_aliases a
       ON a.user_id = e.user_id AND a.namespace = e.namespace
     JOIN memory_embeddings d
       ON d.memory_id = e.memory_id
      AND d.generation_id = a.active_generation_id
     WHERE e.namespace = ? AND e.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM conversation_episode_compactions compacted
         WHERE compacted.episode_id = e.id
       )`,
    NAMESPACE,
  );
  const episodeDenseEligibleCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     WHERE e.namespace = ? AND e.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM conversation_episode_compactions compacted
         WHERE compacted.episode_id = e.id
       )`,
    NAMESPACE,
  );
  const compactedEpisodeCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN conversation_episode_compactions compacted
       ON compacted.episode_id = e.id AND compacted.memory_id = e.memory_id
     WHERE e.namespace = ? AND e.status = 'active'`,
    NAMESPACE,
  );
  const compactedEpisodeSummarySupportedCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN conversation_episode_compactions compacted
       ON compacted.episode_id = e.id AND compacted.memory_id = e.memory_id
     JOIN conversation_memory_summaries summary
       ON summary.id = compacted.summary_id
     JOIN memories summary_memory ON summary_memory.id = summary.memory_id
     WHERE e.namespace = ? AND e.status = 'active'
       AND summary.summary_type = 'week' AND summary.status = 'active'
       AND summary_memory.status = 'active'
       AND EXISTS (
         SELECT 1 FROM conversation_memory_summary_sources source
         WHERE source.summary_id = summary.id AND source.episode_id = e.id
       )`,
    NAMESPACE,
  );
  const compactedEpisodeHotIndexResidueCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN conversation_episode_compactions compacted
       ON compacted.episode_id = e.id AND compacted.memory_id = e.memory_id
     WHERE e.namespace = ? AND e.status = 'active'
       AND (
         EXISTS (SELECT 1 FROM memory_embeddings index_row
                 WHERE index_row.memory_id = e.memory_id)
         OR EXISTS (SELECT 1 FROM memory_dense_lsh index_row
                    WHERE index_row.memory_id = e.memory_id)
         OR EXISTS (SELECT 1 FROM memory_ann_index index_row
                    WHERE index_row.memory_id = e.memory_id)
         OR EXISTS (SELECT 1 FROM memory_term_index index_row
                    WHERE index_row.memory_id = e.memory_id)
       )`,
    NAMESPACE,
  );
  const episodeDuplicateCount = scalar(
    database,
    `SELECT COALESCE(SUM(count - 1), 0) FROM (
       SELECT COUNT(*) AS count FROM conversation_episodes
       WHERE namespace = ?
       GROUP BY user_id, namespace, user_turn_id, assistant_turn_id
       HAVING COUNT(*) > 1
     )`,
    NAMESPACE,
  );
  const assistantFactPollutionCount = scalar(
    database,
    `SELECT COUNT(*) FROM memory_evidence evidence
     JOIN memory_versions version ON version.id = evidence.memory_version_id
     JOIN memory_items item ON item.id = version.memory_item_id
     JOIN memories memory ON memory.id = item.id
     JOIN conversation_turns turn ON turn.id = evidence.turn_id
     WHERE item.namespace = ? AND turn.role = 'assistant'
       AND evidence.source_authority != 'assistant_inference'
       AND memory.source = 'conversation_episode'`,
    NAMESPACE,
  );
  const summaryCounts = Object.fromEntries(
    ['session', 'day', 'week'].map((summaryType) => [
      summaryType,
      scalar(
        database,
        `SELECT COUNT(*) FROM conversation_memory_summaries
         WHERE namespace = ? AND summary_type = ? AND status = 'active'`,
        NAMESPACE,
        summaryType,
      ),
    ]),
  );
  const summaryCount = Object.values(summaryCounts)
    .reduce((total, value) => total + value, 0);
  const supportedSummaryCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_memory_summaries summary
     WHERE summary.namespace = ? AND summary.status = 'active'
       AND summary.source_count > 0
       AND summary.source_count = (
         SELECT COUNT(*) FROM conversation_memory_summary_sources source
         JOIN conversation_episodes episode ON episode.id = source.episode_id
         JOIN memories memory ON memory.id = episode.memory_id
         JOIN memory_items item ON item.id = episode.memory_id
         WHERE source.summary_id = summary.id
           AND episode.status = 'active'
           AND memory.status = 'active'
           AND item.status = 'active'
           AND memory.source = 'conversation_episode'
       )
       AND EXISTS (
         SELECT 1 FROM memory_evidence evidence
         JOIN memory_versions version
           ON version.id = evidence.memory_version_id
         JOIN memory_items summary_item
           ON summary_item.current_version_id = version.id
         WHERE summary_item.id = summary.memory_id
           AND evidence.evidence_type = 'hierarchical_summary_sentence'
       )
       AND NOT EXISTS (
         SELECT 1 FROM conversation_memory_summary_sources source
         JOIN conversation_episodes episode ON episode.id = source.episode_id
         JOIN memory_items episode_item ON episode_item.id = episode.memory_id
         WHERE source.summary_id = summary.id
           AND NOT EXISTS (
             SELECT 1 FROM memory_evidence evidence
             JOIN memory_versions version
               ON version.id = evidence.memory_version_id
             JOIN memory_items summary_item
               ON summary_item.current_version_id = version.id
             WHERE summary_item.id = summary.memory_id
               AND evidence.evidence_type = 'hierarchical_summary_sentence'
               AND evidence.source_ref LIKE
                 '%episode:' || episode.id || '%'
               AND evidence.source_ref LIKE
                 '%version:' || episode_item.current_version_id || '%'
           )
       )`,
    NAMESPACE,
  );
  const crossAccountLeakageCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN conversation_sessions session ON session.id = e.session_id
     JOIN memories memory ON memory.id = e.memory_id
     WHERE e.namespace = ? AND (
       e.user_id != session.user_id OR e.user_id != memory.user_id
       OR e.namespace != session.namespace OR e.namespace != memory.namespace
     )`,
    NAMESPACE,
  );
  const crossRoleLeakageCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN conversation_sessions session ON session.id = e.session_id
     WHERE e.namespace = ? AND e.scope_type = 'role'
       AND e.scope_key != session.persona_id`,
    NAMESPACE,
  );
  const crossProjectLeakageCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN conversation_sessions session ON session.id = e.session_id
     WHERE e.namespace = ? AND e.scope_type = 'project'
       AND e.scope_key != session.project_id`,
    NAMESPACE,
  );
  return {
    expectedExchanges,
    episodeCount,
    completeEpisodeCount,
    exchangeEpisodeRate: ratio(completeEpisodeCount, expectedExchanges),
    episodeTurnBindingCount,
    episodeTurnBindingRate: ratio(episodeTurnBindingCount, episodeCount),
    episodeFtsCount,
    episodeFtsRate: ratio(episodeFtsCount, episodeCount),
    episodeDenseCount,
    episodeDenseEligibleCount,
    episodeDenseRate: ratio(
      episodeDenseCount,
      episodeDenseEligibleCount,
    ),
    compactedEpisodeCount,
    compactedEpisodeSummarySupportedCount,
    compactionSummaryCoverage: ratio(
      compactedEpisodeSummarySupportedCount,
      compactedEpisodeCount,
    ),
    compactedEpisodeHotIndexResidueCount,
    episodeDuplicateCount,
    assistantFactPollutionCount,
    summaryCounts,
    summaryCount,
    supportedSummaryCount,
    summarySourceSupportRate: ratio(supportedSummaryCount, summaryCount),
    crossAccountLeakageCount,
    crossRoleLeakageCount,
    crossProjectLeakageCount,
    openSchema37Work: unfinishedSchema37Work(
      database,
      options.includeRetention !== false,
    ),
  };
}

function episodeGold(database, scenario, event) {
  const expected = database.prepare(
    `SELECT e.memory_id, e.occurred_at FROM conversation_episodes e
     JOIN conversation_turns turn ON turn.id = e.user_turn_id
     WHERE e.user_id = ? AND e.namespace = ? AND e.session_id = ?
       AND turn.client_message_id = ?`,
  ).get(
    scenario.principalId,
    NAMESPACE,
    scenario.conversationId,
    `${scenario.key}-user-${event.index + 1}`,
  );
  assert.ok(expected?.memory_id && expected?.occurred_at);
  return {
    id: String(expected.memory_id),
    occurredAt: String(expected.occurred_at),
  };
}

function episodeMemoryId(database, scenario, event) {
  return episodeGold(database, scenario, event).id;
}

function scenarioRecallScopes(scenario) {
  return [
    { scopeType: 'personal', scopeKey: 'self' },
    { scopeType: 'role', scopeKey: scenario.personaId },
    { scopeType: 'session', scopeKey: scenario.conversationId },
    ...(scenario.projectId
      ? [{ scopeType: 'project', scopeKey: scenario.projectId }]
      : []),
  ];
}

function episodeQueryCases(database, scenarios) {
  return scenarios.map((scenario) => {
    const event = scenario.events.find((candidate) =>
      ['drink', 'role_style', 'habit'].includes(candidate.type));
    assert.ok(event);
    return {
      id: `${scenario.key}:episode`,
      expectedIds: [episodeMemoryId(database, scenario, event)],
      query: event.content,
      userId: scenario.principalId,
      namespace: NAMESPACE,
      scopes: scenarioRecallScopes(scenario),
    };
  });
}

function timelineQueryCases(database, scenarios) {
  return scenarios.flatMap((scenario) => {
    const oldEvent = scenario.events.find((event) =>
      event.type === 'timeline_old');
    const oldQuestion = scenario.events.find((event) =>
      event.type === 'timeline_old_question');
    const newEvent = scenario.events.find((event) =>
      event.type === 'timeline_new');
    const newQuestion = scenario.events.find((event) =>
      event.type === 'timeline_new_question');
    assert.ok(oldEvent && oldQuestion && newEvent && newQuestion);
    const oldGold = episodeGold(database, scenario, oldEvent);
    const newGold = episodeGold(database, scenario, newEvent);
    const goldTimeline = [
      { ...oldGold, value: scenario.timelineOldPlace },
      { ...newGold, value: scenario.timelineNewPlace },
    ];
    const base = {
      scenarioKey: scenario.key,
      userId: scenario.principalId,
      namespace: NAMESPACE,
      scopes: scenarioRecallScopes(scenario),
    };
    return [
      {
        ...base,
        id: `${scenario.key}:timeline-latest`,
        category: 'latest',
        query: '我最近一次午休去书店看摄影画册时，是哪家店？',
        expectedValues: [scenario.timelineNewPlace],
        forbiddenValues: [scenario.timelineOldPlace],
        expectedIds: [newGold.id],
        forbiddenIds: [oldGold.id],
        topExpectedId: newGold.id,
        goldTimeline,
      },
      {
        ...base,
        id: `${scenario.key}:timeline-history`,
        category: 'history',
        query: '我前后两次午休去过哪两家书店？',
        expectedValues: [
          scenario.timelineOldPlace,
          scenario.timelineNewPlace,
        ],
        forbiddenValues: [],
        forbiddenIds: [],
        expectedIds: [oldGold.id, newGold.id],
        topExpectedId: null,
        goldTimeline,
      },
    ];
  });
}

function summarizeRerankTelemetry(evaluated) {
  const rerankTraces = evaluated.map((item) => item.rerankTrace)
    .filter(Boolean);
  const providerBackedQueryCount = rerankTraces.filter((trace) =>
    trace.providerCalls > 0).length;
  const routeCounts = {};
  for (const trace of rerankTraces) {
    const route = trace.route || 'unreported';
    routeCounts[route] = (routeCounts[route] || 0) + 1;
  }
  return {
    tracedQueryCount: rerankTraces.length,
    missingTraceQueryCount: evaluated.length - rerankTraces.length,
    traceCoverageRate: evaluated.length === 0
      ? 0
      : rerankTraces.length / evaluated.length,
    providerBackedQueryCount,
    providerCallRate: evaluated.length === 0
      ? 0
      : providerBackedQueryCount / evaluated.length,
    totalProviderCalls: rerankTraces.reduce(
      (total, trace) => total + trace.providerCalls,
      0,
    ),
    totalAttemptedCandidates: rerankTraces.reduce(
      (total, trace) => total + trace.attemptedCandidates,
      0,
    ),
    routeCounts,
  };
}

export function computeTimelineMetrics(evaluated) {
  const latest = evaluated.filter((item) => item.category === 'latest');
  const history = evaluated.filter((item) => item.category === 'history');
  return {
    queryCount: evaluated.length,
    latestQueryCount: latest.length,
    historyQueryCount: history.length,
    latestAccuracy: ratio(
      latest.filter((item) => item.passed).length,
      latest.length,
    ),
    historyCoverageRate: ratio(
      history.filter((item) => item.passed).length,
      history.length,
    ),
    staleLatestRate: ratio(
      latest.filter((item) => item.forbiddenTopHit).length,
      latest.length,
    ),
    rerankTelemetry: summarizeRerankTelemetry(evaluated),
    latency: latencySummary(evaluated.map((item) => item.durationMs)),
    failedIds: evaluated.filter((item) => !item.passed)
      .map((item) => item.id),
  };
}

export function evaluateTimelineResultOrder(results, item) {
  const resultIds = results.map((result) => result.memory.id);
  const resultById = new Map(results.map((result) => [
    result.memory.id,
    result,
  ]));
  const goldById = new Map((item.goldTimeline || []).map((entry) => [
    entry.id,
    entry,
  ]));
  const goldTimes = (item.goldTimeline || []).map((entry) =>
    Date.parse(entry.occurredAt));
  const goldChronologyPassed = goldTimes.length >= 2 &&
    goldTimes.every(Number.isFinite) &&
    goldTimes.every((time, index) =>
      index === 0 || goldTimes[index - 1] < time);
  const expectedIdHits = (item.expectedIds || []).filter((id) => {
    const result = resultById.get(id);
    const gold = goldById.get(id);
    return Boolean(
      result &&
      gold &&
      result.memory.occurredAt === gold.occurredAt,
    );
  });
  const texts = results.map((result) => resultText(result));
  const matchedExpectedValues = (item.expectedValues || []).filter((value) =>
    texts.some((text) => text.includes(value)));
  const topResult = results[0] || null;
  const topText = topResult ? resultText(topResult) : '';
  const forbiddenTopHit = (item.forbiddenIds || []).includes(
    topResult?.memory.id,
  ) || (item.forbiddenValues || []).some((value) =>
    topText.includes(value));
  const expectedIdsPassed = expectedIdHits.length ===
    (item.expectedIds || []).length;
  const passed = goldChronologyPassed && expectedIdsPassed &&
    matchedExpectedValues.length === (item.expectedValues || []).length &&
    !forbiddenTopHit && (
      item.category !== 'latest' ||
      topResult?.memory.id === item.topExpectedId
    );
  return {
    resultIds,
    topResultId: topResult?.memory.id || null,
    expectedIdHits,
    matchedExpectedValues,
    goldChronologyPassed,
    forbiddenTopHit,
    passed,
  };
}

async function evaluateTimelineQueries(store, cases) {
  const evaluated = [];
  for (const item of cases) {
    const started = performance.now();
    let retrievalTraceId = null;
    const results = await store.recallReliable({
      query: item.query,
      userId: item.userId,
      namespace: item.namespace,
      scopes: item.scopes,
      limit: 5,
    }, {
      onTraceCreated(traceId) {
        retrievalTraceId = traceId;
      },
    });
    const rerankTrace = retrievalTraceId
      ? extractRerankTraceEvidence(
        store.getRetrievalTrace(retrievalTraceId, item.userId),
      )
      : null;
    const evaluation = evaluateTimelineResultOrder(results, item);
    evaluated.push({
      ...item,
      ...evaluation,
      rerankTrace,
      durationMs: Number((performance.now() - started).toFixed(3)),
    });
  }
  return { cases: evaluated, metrics: computeTimelineMetrics(evaluated) };
}

function passesTimelineThresholds(metrics) {
  return metrics.latestAccuracy >= 0.9 &&
    metrics.historyCoverageRate >= 0.9 &&
    metrics.staleLatestRate === 0 &&
    Number.isFinite(metrics.latency.p95Ms) &&
    metrics.latency.p95Ms <= RELIABLE_RECALL_P95_LIMIT_MS;
}

function evaluateEpisodeRecall(store, cases) {
  const evaluated = cases.map((item) => {
    const results = store.recall({
      query: item.query,
      userId: item.userId,
      namespace: item.namespace,
      scopes: item.scopes,
      limit: 5,
      minScore: 0.12,
    });
    return {
      ...item,
      resultIds: results.map((result) => result.memory.id),
    };
  });
  return {
    cases: evaluated,
    recallAt5: ratio(
      evaluated.filter((item) => item.resultIds.slice(0, 5).some(
        (memoryId) => item.expectedIds.includes(memoryId),
      )).length,
      evaluated.length,
    ),
  };
}

function evaluateEpisodeIsolation(store, cases, scenarios) {
  const byScenario = new Map(cases.map((item) => [item.id.split(':episode')[0], item]));
  const searchForbidden = (request, forbiddenId) => store.recall({
    query: request.query,
    userId: request.userId,
    namespace: request.namespace,
    scopes: request.scopes.filter((scope) =>
      scope.scopeType !== 'session'),
    limit: 5,
    minScore: 0.12,
  }).some((result) => result.memory.id === forbiddenId);
  let crossAccountLeakageCount = 0;
  let crossRoleLeakageCount = 0;
  let crossProjectLeakageCount = 0;
  for (const scenario of scenarios) {
    const own = byScenario.get(scenario.key);
    const otherRole = scenarios.find((candidate) =>
      candidate.principalId === scenario.principalId &&
      candidate.personaId !== scenario.personaId);
    const otherUser = scenarios.find((candidate) =>
      candidate.principalId !== scenario.principalId &&
      candidate.personaIndex === scenario.personaIndex);
    assert.ok(own);
    assert.ok(otherRole);
    const otherRoleCase = byScenario.get(otherRole.key);
    assert.ok(otherRoleCase);
    if (searchForbidden(
      { ...own, query: otherRoleCase.query },
      otherRoleCase.expectedIds[0],
    )) {
      crossRoleLeakageCount += 1;
    }
    if (otherUser) {
      const otherUserCase = byScenario.get(otherUser.key);
      assert.ok(otherUserCase);
      if (searchForbidden(
        { ...own, query: otherUserCase.query },
        otherUserCase.expectedIds[0],
      )) {
        crossAccountLeakageCount += 1;
      }
    }
    if (!scenario.projectId && otherRole.projectId) {
      if (searchForbidden(
        { ...own, query: otherRoleCase.query },
        otherRoleCase.expectedIds[0],
      )) {
        crossProjectLeakageCount += 1;
      }
    }
  }
  return {
    crossAccountLeakageCount,
    crossRoleLeakageCount,
    crossProjectLeakageCount,
  };
}

export async function runSchema37DeterministicSmoke() {
  const runRoot = createPrivateQaRunRoot(privateParent, 'smoke-');
  const dataDir = path.join(runRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, 'memory-bridge.sqlite3');
  const database = openDatabase(databasePath);
  try {
    const identity = new IdentityService(database);
    const principalId = 'schema37-smoke-user';
    identity.createPrincipal({ id: principalId, displayName: '验收用户' });
    const trusted = identity.trustPrincipal(principalId);
    const service = new ConversationService(database, {
      instanceId: 'schema37-smoke',
    });
    service.bindProject(
      { principalId, namespace: NAMESPACE },
      'schema37-smoke-project',
      { expectedVersion: 0, displayName: '验收项目' },
    );
    const scenarios = [];
    for (const [scenarioIndex, projectId] of [
      null,
      'schema37-smoke-project',
    ].entries()) {
      const personaId = `schema37-smoke-persona-${scenarioIndex + 1}`;
      identity.bindPersona(trusted, {
        clientType: 'qa-schema37-smoke',
        clientInstanceId: 'schema37-smoke-device',
        personaId,
        displayName: ROLE_NAMES[scenarioIndex],
      });
      service.putChatProfile(
        { principalId, namespace: NAMESPACE },
        personaId,
        {
          expectedVersion: 0,
          displayName: ROLE_NAMES[scenarioIndex],
          systemPrompt: '只读取当前验收作用域。',
          greeting: '你好。',
          language: 'zh-Hans',
          capabilityIds: [],
        },
      );
      const conversation = service.createConversation(
        { principalId, namespace: NAMESPACE },
        {
          idempotencyKey: `schema37-smoke-${scenarioIndex}`,
          personaId,
          projectId,
          title: 'schema 37 确定性烟测',
        },
      );
      const userContent = scenarioIndex === 0
        ? '我今天明确聊了桂花乌龙，只属于当前角色。'
        : '我今天明确聊了陈皮白茶，只属于当前项目。';
      const scenarioKey = `schema37-smoke:${scenarioIndex}`;
      service.appendMessage(
        { principalId, namespace: NAMESPACE },
        conversation.id,
        {
          clientMessageId: `${scenarioKey}-user-1`,
          role: 'user',
          content: userContent,
        },
      );
      service.appendMessage(
        { principalId, namespace: NAMESPACE },
        conversation.id,
        {
          clientMessageId: `${scenarioKey}-assistant-1`,
          role: 'assistant',
          content: '收到，我会保留为对话情景但不会把回答当作用户事实。',
        },
      );
      scenarios.push({
        key: scenarioKey,
        principalId,
        personaId,
        projectId,
        conversationId: conversation.id,
        userTurnsPerPersona: 1,
        events: [{ type: 'drink', index: 0, content: userContent }],
      });
    }
    const pipeline = await drainSchema37Pipeline(
      database,
      scenarios,
      createSchema37DeterministicRanker(),
    );
    const episodeCases = episodeQueryCases(database, scenarios);
    const episodeRecall = evaluateEpisodeRecall(
      pipeline.store,
      episodeCases,
    );
    const metrics = {
      ...schema37Snapshot(database, scenarios),
      ...evaluateEpisodeIsolation(pipeline.store, episodeCases, scenarios),
      episodeRecallAt5: episodeRecall.recallAt5,
    };
    return {
      provenance: 'deterministic-no-provider-smoke',
      dataRetained: true,
      runRoot,
      databasePath,
      pipeline: pipeline.counters,
      metrics,
      acceptance: assessSchema37Acceptance(metrics),
      episodeRecall,
    };
  } finally {
    database.close();
  }
}

function deterministicReflectionProvider(scenarios) {
  const byScope = new Map(scenarios.map((scenario) => [
    `${scenario.principalId}\0${scenario.personaId}`,
    scenario,
  ]));
  return {
    model: 'qa-deterministic-reflection',
    promptVersion: 'natural-conversation-reflection-gold-v1',
    async reflect(input) {
      const scenario = byScope.get(`${input.userId}\0${input.scopeKey}`);
      if (!scenario) return { candidates: [] };
      const resumeIndex = scenario.events.find(
        (event) => event.type === 'habit_resume',
      )?.index ?? -1;
      const currentHabitEvidence = new Set(
        scenario.events.filter((event) =>
          event.type === 'habit' && event.index > resumeIndex)
          .map((event) => event.content),
      );
      const evidence = input.turns
        .filter((turn) => currentHabitEvidence.has(turn.content))
        .slice(0, 4)
        .map((turn) => ({
          turnAlias: turn.turnAlias,
          excerpt: turn.content,
        }));
      if (evidence.length < 3) return { candidates: [] };
      return {
        candidates: [{
          kind: 'preference',
          subject: '用户',
          predicate: '稳定生活习惯',
          value: scenario.habit,
          confidence: 0.9,
          importance: 0.75,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence,
        }],
      };
    },
  };
}

export async function settleReflectionQaSample(execute, onFailure) {
  try {
    return await execute();
  } catch (error) {
    return onFailure(error);
  }
}

export async function drainReflectionQaWindows({
  remainingTurns,
  executeWindow,
  maximumWindows,
}) {
  const windows = [];
  while (windows.length < maximumWindows) {
    const remaining = await remainingTurns();
    if (!Number.isSafeInteger(remaining) || remaining < 0) {
      throw new Error('历史反思剩余 turn 数无效');
    }
    if (remaining === 0) return windows;
    windows.push(await executeWindow(windows.length));
  }
  const remaining = await remainingTurns();
  if (remaining > 0) {
    throw new Error(
      `历史反思在 ${maximumWindows} 个窗口后仍有 ${remaining} 个 turn 未处理`,
    );
  }
  return windows;
}

async function executeReflectionSamples(database, scenarios, provider, label) {
  const lifecycle = new LifecycleStore(database);
  const service = new MemoryReflectionService(
    database,
    lifecycle,
    noopExtractor(),
    provider,
    {
      mode: 'shadow',
      maxTurns: REFLECTION_WINDOW_TURNS,
      tokenBudget: 64_000,
      lookbackDays: 365,
      minNewTurns: 1,
      minPatternEvidence: 3,
      maxDailyCalls: 100_000,
      clock: () => new Date('2026-12-31T00:00:00.000Z'),
    },
  );
  const samples = [];
  for (const scenario of scenarios) {
    let queued = null;
    const executedWindows = [];
    const started = performance.now();
    samples.push(await settleReflectionQaSample(async () => {
      const scope = {
        userId: scenario.principalId,
        namespace: NAMESPACE,
        scopeType: 'role',
        scopeKey: scenario.personaId,
      };
      const maximumWindows = Math.ceil(
        scenario.userTurnsPerPersona / REFLECTION_WINDOW_TURNS,
      ) + 1;
      await drainReflectionQaWindows({
        remainingTurns: async () =>
          (await service.preview(scope)).pipelines.reflect.turnCount,
        executeWindow: async (windowIndex) => {
          queued = service.queueRun({
            ...scope,
            runType: 'reflect',
            trigger: 'manual',
            requestedBy: `qa-natural-${label}`,
          });
          const executed = await service.executeRun(
            queued.run.id,
            `qa-natural-${label}-${scenario.scenarioIndex}-${windowIndex}`,
          );
          executedWindows.push(executed);
          return executed;
        },
        maximumWindows,
      });
      const candidates = executedWindows.flatMap((executed) =>
        executed.candidates).map((candidate) => {
        const trustedEvidenceFrom = `
           FROM memory_candidate_evidence e
           JOIN memory_candidates c ON c.id = e.candidate_id
           JOIN conversation_turns t ON t.id = e.turn_id
           JOIN conversation_sessions s ON s.id = t.session_id
           WHERE e.candidate_id = ?
             AND c.user_id = ? AND c.namespace = ?
             AND t.role = 'user'
             AND t.user_id = c.user_id AND t.namespace = c.namespace
             AND s.user_id = c.user_id AND s.namespace = c.namespace
             AND trim(COALESCE(e.excerpt, '')) != ''
             AND instr(t.content, e.excerpt) > 0
             AND (
               (c.scope_type = 'personal' AND c.scope_key = 'self')
               OR (c.scope_type = 'role' AND c.scope_key = s.persona_id)
               OR (c.scope_type = 'project' AND c.scope_key = s.project_id)
               OR (c.scope_type = 'session' AND c.scope_key = s.external_id)
             )`;
        const trustedUserEvidenceTurns = scalar(
          database,
          `SELECT COUNT(DISTINCT t.id) ${trustedEvidenceFrom}`,
          candidate.id,
          scenario.principalId,
          NAMESPACE,
        );
        const habitEvidenceTurns = scalar(
          database,
          `SELECT COUNT(DISTINCT t.id) ${trustedEvidenceFrom}
             AND instr(t.content, ?) > 0`,
          candidate.id,
          scenario.principalId,
          NAMESPACE,
          scenario.habit,
        );
        const claimText = [
          candidate.subject,
          candidate.predicate,
          candidate.value,
        ].join('');
        const habitMeaningMatch = scenario.habitKeywords.some((keyword) =>
          claimText.includes(keyword));
        return {
          id: candidate.id,
          state: candidate.state,
          predicate: candidate.predicate,
          value: candidate.value,
          trustedUserEvidenceTurns,
          habitEvidenceTurns,
          habitMeaningMatch,
        };
      });
      const quality = assessReflectionCandidateQuality(candidates);
      return {
        scenarioKey: scenario.key,
        runId: executedWindows.at(-1)?.run.id || null,
        runIds: executedWindows.map((executed) => executed.run.id),
        status: executedWindows.every((executed) =>
          executed.run.status === 'completed') ? 'completed' : 'failed',
        windowCount: executedWindows.length,
        inputTurnCount: executedWindows.reduce((sum, executed) =>
          sum + executed.run.inputTurnCount, 0),
        candidateCount: executedWindows.reduce((sum, executed) =>
          sum + executed.run.candidateCount, 0),
        rejectedCount: executedWindows.reduce((sum, executed) =>
          sum + executed.run.rejectedCount, 0),
        candidates,
        correctCandidateCount: quality.targetCandidateCount,
        extraGroundedCandidateCount: quality.extraGroundedCandidateCount,
        invalidCandidateCount: quality.invalidCandidateCount,
        incorrectCandidateCount: quality.invalidCandidateCount,
        passed: quality.passed,
        durationMs: Number((performance.now() - started).toFixed(3)),
      };
    }, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const failedRun = queued
        ? service.getRun(queued.run.id, scenario.principalId)
        : null;
      return {
        scenarioKey: scenario.key,
        runId: failedRun?.id || queued?.run.id || null,
        runIds: executedWindows.map((executed) => executed.run.id),
        status: failedRun?.status || 'failed',
        windowCount: executedWindows.length + (failedRun ? 1 : 0),
        inputTurnCount: executedWindows.reduce((sum, executed) =>
          sum + executed.run.inputTurnCount, failedRun?.inputTurnCount || 0),
        candidateCount: executedWindows.reduce((sum, executed) =>
          sum + executed.run.candidateCount, failedRun?.candidateCount || 0),
        rejectedCount: executedWindows.reduce((sum, executed) =>
          sum + executed.run.rejectedCount, failedRun?.rejectedCount || 0),
        candidates: [],
        correctCandidateCount: 0,
        extraGroundedCandidateCount: 0,
        invalidCandidateCount: 0,
        incorrectCandidateCount: 0,
        passed: false,
        executionError: {
          errorClass: error instanceof Error ? error.name : 'Error',
          error: message.slice(0, 1_000),
          errorFingerprint: sha256(message),
        },
        durationMs: Number((performance.now() - started).toFixed(3)),
      };
    }));
  }
  return samples;
}

async function resolveQueuedReflectionCandidates(database, expectedSamples) {
  const lifecycle = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycle,
    new MemoryStore(database),
    {
      mode: 'auto',
      autoCommitMinConfidence: 0.95,
      autoCommitMinImportance: 0.5,
    },
  );
  let processedJobCount = 0;
  for (;;) {
    const workerId = `qa-reflection-resolver-${processedJobCount % 4}`;
    const job = lifecycle.claimJob(
      workerId,
      300,
      ['resolve_candidate'],
    );
    if (!job) break;
    const candidateId = typeof job.payload.candidateId === 'string'
      ? job.payload.candidateId
      : '';
    if (!candidateId) {
      throw new Error('反思候选解析任务缺少 candidateId');
    }
    const resolution = await resolver.resolve(candidateId);
    lifecycle.completeJob(job.id, workerId, {
      resultStatus: resolution.state,
      resolutionReason: resolution.reason,
      memoryId: resolution.memoryId || null,
    });
    processedJobCount += 1;
    if (processedJobCount > 10_000) {
      throw new Error('反思候选解析任务未在有界步数内收敛');
    }
  }

  const expectedCandidateIds = [...new Set(
    (expectedSamples || []).flatMap((sample) =>
      sample.candidates.map((candidate) => candidate.id)),
  )];
  const candidates = expectedCandidateIds.map((candidateId) => {
    const candidate = lifecycle.getCandidate(candidateId);
    const memory = database.prepare(
      `SELECT m.id
       FROM candidate_resolution_runs r
       JOIN memories m ON m.id = r.target_memory_item_id
       WHERE r.candidate_id = ? AND r.status = 'completed'
         AND m.status = 'active'
       ORDER BY r.created_at DESC LIMIT 1`,
    ).get(candidateId);
    return {
      candidateId,
      state: candidate?.state || 'missing',
      sensitivity: candidate?.sensitivity || null,
      memoryId: memory?.id ? String(memory.id) : null,
      activated: candidate?.state === 'accepted' && Boolean(memory?.id),
    };
  });
  return {
    processedJobCount,
    expectedCandidateCount: expectedCandidateIds.length,
    activatedCandidateCount:
      candidates.filter((candidate) => candidate.activated).length,
    candidates,
    passed: expectedCandidateIds.length > 0 &&
      candidates.every((candidate) => candidate.activated),
  };
}

function resultText(result) {
  return [result.memory.title, result.memory.content, result.memory.summary]
    .join('\n')
    .normalize('NFKC');
}

function qaMemoryLayer(source) {
  if (source === 'conversation_episode') return 'episode';
  if (source === 'hierarchical_summary') return 'summary';
  if (source === 'consolidation') return 'consolidation';
  return 'fact';
}

function isHistoricalNegatedReference(text, value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const afterValue = new RegExp(
    `${escaped}.{0,32}(?:不用了|不再使用|不再采用|停用|已取消|取消了|` +
      `已经取消|失效|作废|已忘记|已删除|不作为当前值)`,
    'u',
  );
  const beforeValue = new RegExp(
    `(?:请忘记|忘记|取消|停止|停用|不再使用|不再采用|不再作为)` +
      `.{0,32}${escaped}`,
    'u',
  );
  return String(text).split(/[。！？!?\n]+/u)
    .filter((sentence) => sentence.includes(value))
    .some((sentence) =>
      afterValue.test(sentence) || beforeValue.test(sentence));
}

export function evaluateQueryResultLayers(results, item, memoryLayer = 'fact') {
  const layerResults = memoryLayer === 'fact'
    ? results.filter((result) => qaMemoryLayer(result.memory.source) === 'fact')
    : results;
  const forbiddenIds = new Set(item.forbiddenIds || []);
  const forbiddenValues = (item.forbiddenValues || [])
    .map((value) => String(value).normalize('NFKC'));
  const allResults = results.map((result) => ({
    memoryId: result.memory.id,
    source: result.memory.source,
    sourceRef: result.memory.sourceRef || null,
    layer: qaMemoryLayer(result.memory.source),
    score: Number(result.score.toFixed(6)),
  }));
  const forbiddenMatches = results.flatMap((result) => {
    const text = resultText(result);
    const matchedIds = forbiddenIds.has(result.memory.id)
      ? [result.memory.id]
      : [];
    const matchedValues = forbiddenValues.filter((value) =>
      text.includes(value) && !isHistoricalNegatedReference(text, value));
    if (matchedIds.length === 0 && matchedValues.length === 0) return [];
    return [{
      memoryId: result.memory.id,
      source: result.memory.source,
      sourceRef: result.memory.sourceRef || null,
      layer: qaMemoryLayer(result.memory.source),
      matchedIds,
      matchedValues,
    }];
  });
  return {
    resultIds: layerResults.map((result) => result.memory.id),
    resultScores: layerResults.map((result) =>
      Number(result.score.toFixed(6))),
    allResultIds: allResults.map((result) => result.memoryId),
    allResults,
    forbiddenMatches,
    forbiddenHit: forbiddenMatches.length > 0,
  };
}

function queryCases(scenarios, gold) {
  const cases = [];
  for (const scenario of scenarios) {
    const own = gold.get(scenario.key);
    const otherRole = scenarios.find((candidate) =>
      candidate.principalId === scenario.principalId &&
      candidate.personaId !== scenario.personaId);
    const otherUser = scenarios.find((candidate) =>
      candidate.principalId !== scenario.principalId &&
      candidate.personaIndex === scenario.personaIndex);
    assert.ok(otherRole);
    const scopes = [
      { scopeType: 'personal', scopeKey: 'self' },
      { scopeType: 'role', scopeKey: scenario.personaId },
      { scopeType: 'session', scopeKey: scenario.conversationId },
      ...(scenario.projectId
        ? [{ scopeType: 'project', scopeKey: scenario.projectId }]
        : []),
    ];
    const base = {
      scenarioKey: scenario.key,
      userId: scenario.principalId,
      namespace: NAMESPACE,
      scopes,
    };
    cases.push(
      { ...base, id: `${scenario.key}:drink`, category: 'fact',
        query: '我平时点单最常喝什么？', expectedIds: [own.drinkId] },
      { ...base, id: `${scenario.key}:commute`, category: 'fact',
        query: '工作日我通常怎么通勤？', expectedIds: [own.commuteId] },
      { ...base, id: `${scenario.key}:style`, category: 'role_fact',
        query: '当前角色专属的回复组织方式是什么？',
        expectedIds: [own.roleStyleId] },
      { ...base, id: `${scenario.key}:correction`, category: 'correction',
        query: '我现在常用的编辑器是什么？',
        expectedIds: [own.editorId], forbiddenValues: [scenario.oldEditor] },
      { ...base, id: `${scenario.key}:forgotten`, category: 'forgotten',
        query: '我这次临时出差住在哪里？', expectedIds: [],
        forbiddenIds: [own.hotelId], forbiddenValues: [scenario.hotel],
        abstentionExpected: true },
      { ...base, id: `${scenario.key}:role-leak`, category: 'cross_role',
        query: `我是不是要求你${otherRole.responseStyle}？`, expectedIds: [],
        forbiddenIds: [gold.get(otherRole.key).roleStyleId],
        forbiddenValues: [otherRole.responseStyle] },
      { ...base, id: `${scenario.key}:negative`, category: 'negative_noise',
        query: '我有没有说过自己养蜥蜴？', expectedIds: [],
        abstentionExpected: true },
    );
    if (otherUser) {
      cases.push({
        ...base,
        id: `${scenario.key}:account-leak`,
        category: 'cross_account',
        query: `我最常喝${otherUser.drink}吗？`,
        expectedIds: [],
        forbiddenIds: [gold.get(otherUser.key).drinkId],
        forbiddenValues: [otherUser.drink],
      });
    }
  }
  return cases.map((item) => ({
    forbiddenIds: [],
    forbiddenValues: [],
    abstentionExpected: false,
    ...item,
  }));
}

export function computeRetrievalMetrics(evaluated) {
  const positives = evaluated.filter((item) => item.expectedIds.length > 0);
  const abstentions = evaluated.filter((item) => item.abstentionExpected);
  const hitAt = (item, limit) => item.resultIds.slice(0, limit).some(
    (id) => item.expectedIds.includes(id),
  );
  const mean = (values, emptyValue = 0) => values.length === 0
    ? emptyValue
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  const reciprocalRanks = positives.map((item) => {
    const rank = item.resultIds.findIndex((id) => item.expectedIds.includes(id));
    return rank < 0 ? 0 : 1 / (rank + 1);
  });
  const forbidden = evaluated.filter((item) => item.forbiddenHit);
  const crossAccount = evaluated.filter((item) => item.category === 'cross_account');
  const crossRole = evaluated.filter((item) => item.category === 'cross_role');
  const corrections = evaluated.filter((item) => item.category === 'correction');
  const forgotten = evaluated.filter((item) => item.category === 'forgotten');
  return {
    queryCount: evaluated.length,
    positiveQueryCount: positives.length,
    abstentionQueryCount: abstentions.length,
    recallAt1: mean(positives.map((item) => Number(hitAt(item, 1))), 1),
    recallAt3: mean(positives.map((item) => Number(hitAt(item, 3))), 1),
    recallAt5: mean(positives.map((item) => Number(hitAt(item, 5))), 1),
    mrr: mean(reciprocalRanks, 1),
    precisionAt1: mean(positives.map((item) =>
      item.resultIds.slice(0, 1).filter((id) => item.expectedIds.includes(id)).length), 1),
    precisionAt3: mean(positives.map((item) =>
      item.resultIds.slice(0, 3).filter((id) => item.expectedIds.includes(id)).length / 3), 1),
    precisionAt5: mean(positives.map((item) =>
      item.resultIds.slice(0, 5).filter((id) => item.expectedIds.includes(id)).length / 5), 1),
    negativeAbstentionRate: mean(
      abstentions.map((item) => Number(item.resultIds.length === 0)),
      1,
    ),
    forbiddenHitRate: mean(evaluated.map((item) => Number(item.forbiddenHit))),
    errorMemoryInjectionRate: mean(
      evaluated.map((item) => Number(item.forbiddenHit)),
    ),
    crossAccountLeakageRate: mean(
      crossAccount.map((item) => Number(item.forbiddenHit)),
    ),
    crossRoleLeakageRate: mean(
      crossRole.map((item) => Number(item.forbiddenHit)),
    ),
    correctionOldValueHitRate: mean(
      corrections.map((item) => Number(item.forbiddenHit)),
    ),
    forgottenQueryCount: forgotten.length,
    forgottenRevivalRate: mean(
      forgotten.map((item) => Number(item.forbiddenHit)),
    ),
    rerankTelemetry: summarizeRerankTelemetry(evaluated),
    latency: latencySummary(evaluated.map((item) => item.durationMs)),
    failedPositiveIds: positives.filter((item) => !hitAt(item, 5))
      .map((item) => item.id),
    forbiddenHitIds: forbidden.map((item) => item.id),
  };
}

export function extractRerankTraceEvidence(trace) {
  if (!trace) return null;
  const rerankEvents = (trace.events || []).filter((event) =>
    event.stage === 'rerank');
  const routes = rerankEvents.map((event) => event.detail?.route)
    .filter((route) => typeof route === 'string' && route.length > 0);
  const route = routes.includes('model')
    ? 'model'
    : routes.includes('cache')
      ? 'cache'
      : routes.includes('deterministic_fast')
        ? 'deterministic_fast'
        : routes.at(-1) || null;
  const nonNegativeNumber = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
  };
  return {
    traceId: trace.traceId || null,
    route,
    providerCalls: rerankEvents.reduce(
      (total, event) => total + nonNegativeNumber(event.detail?.providerCalls),
      0,
    ),
    attemptedCandidates: rerankEvents.reduce(
      (total, event) =>
        total + nonNegativeNumber(event.detail?.attemptedCandidates),
      0,
    ),
    rerankEventCount: rerankEvents.length,
  };
}

async function evaluateQueries(store, cases, reliable, memoryLayer = 'fact') {
  const evaluated = [];
  for (const item of cases) {
    const started = performance.now();
    let retrievalTraceId = null;
    const request = {
      query: item.query,
      userId: item.userId,
      namespace: item.namespace,
      scopes: item.scopes,
      limit: 5,
    };
    const results = reliable
      ? await store.recallReliable(request, {
        onTraceCreated(traceId) {
          retrievalTraceId = traceId;
        },
      })
      : store.recall(request);
    const rerankTrace = reliable && retrievalTraceId
      ? extractRerankTraceEvidence(
        store.getRetrievalTrace(retrievalTraceId, item.userId),
      )
      : null;
    const evaluation = evaluateQueryResultLayers(results, item, memoryLayer);
    evaluated.push({
      ...item,
      ...evaluation,
      memoryLayer,
      rerankTrace,
      durationMs: Number((performance.now() - started).toFixed(3)),
    });
  }
  return { cases: evaluated, metrics: computeRetrievalMetrics(evaluated) };
}

export async function modelPreflight(fetchImpl = fetch) {
  const started = performance.now();
  try {
    const response = await fetchImpl(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        available: false,
        generationAvailable: false,
        embeddingAvailable: false,
        reason: `ollama_http_${response.status}`,
        durationMs: Number((performance.now() - started).toFixed(3)),
      };
    }
    const payload = await response.json();
    const names = (payload.models || []).map((model) => String(model.name));
    const has = (required) => names.some((name) =>
      name === required || name.startsWith(`${required}-`));
    const generationAvailable = has(REQUIRED_GENERATION_MODEL);
    const embeddingAvailable = has(REQUIRED_EMBEDDING_MODEL);
    if (!generationAvailable || !embeddingAvailable) {
      return {
        available: false,
        generationModel: REQUIRED_GENERATION_MODEL,
        embeddingModel: REQUIRED_EMBEDDING_MODEL,
        generationAvailable,
        embeddingAvailable,
        generationProbeAvailable: false,
        embeddingProbeAvailable: false,
        reason: 'required_model_missing',
        durationMs: Number((performance.now() - started).toFixed(3)),
      };
    }
    const generationProbeStarted = performance.now();
    const generationResponse = await fetchImpl(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: REQUIRED_GENERATION_MODEL,
        prompt: '只回复 OK',
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    const generationPayload = generationResponse.ok
      ? await generationResponse.json()
      : null;
    const generationProbeAvailable = Boolean(
      generationResponse.ok &&
      generationPayload?.done === true &&
      String(generationPayload.response || '').trim(),
    );
    const generationProbeDurationMs = Number(
      (performance.now() - generationProbeStarted).toFixed(3),
    );
    const embeddingProbeStarted = performance.now();
    const embeddingResponse = await fetchImpl(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: REQUIRED_EMBEDDING_MODEL,
        input: ['忆桥模型预检'],
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    const embeddingPayload = embeddingResponse.ok
      ? await embeddingResponse.json()
      : null;
    const embeddingVector = Array.isArray(embeddingPayload?.embeddings?.[0])
      ? embeddingPayload.embeddings[0]
      : [];
    const embeddingProbeAvailable = Boolean(
      embeddingResponse.ok && embeddingVector.length > 0,
    );
    const embeddingProbeDurationMs = Number(
      (performance.now() - embeddingProbeStarted).toFixed(3),
    );
    const available = generationProbeAvailable && embeddingProbeAvailable;
    return {
      available,
      generationModel: REQUIRED_GENERATION_MODEL,
      embeddingModel: REQUIRED_EMBEDDING_MODEL,
      generationAvailable,
      embeddingAvailable,
      generationProbeAvailable,
      embeddingProbeAvailable,
      embeddingDimensions: embeddingVector.length,
      generationProbeDurationMs,
      embeddingProbeDurationMs,
      reason: available ? null : 'required_model_probe_failed',
      durationMs: Number((performance.now() - started).toFixed(3)),
    };
  } catch (error) {
    return {
      available: false,
      generationAvailable: false,
      embeddingAvailable: false,
      reason: 'ollama_unreachable',
      errorClass: error instanceof Error ? error.name : 'Error',
      durationMs: Number((performance.now() - started).toFixed(3)),
    };
  }
}

function instrumentedRanker() {
  const base = new OllamaSemanticRanker({
    baseUrl: OLLAMA_URL,
    embeddingModel: REQUIRED_EMBEDDING_MODEL,
    rerankModel: REQUIRED_GENERATION_MODEL,
    embedBatchSize: 32,
    rerankBatchSize: 16,
    timeoutMs: MODEL_TIMEOUT_MS,
    cacheTtlMs: 30_000,
    cacheMaxEntries: 256,
  });
  const calls = {
    embed: 0,
    rerank: 0,
    rewrite: 0,
    physicalEmbed: 0,
    physicalRerank: 0,
    physicalRewrite: 0,
    embedMs: [],
    rerankMs: [],
  };
  const embedWithTelemetry = async (texts) => {
    calls.embed += 1;
    const started = performance.now();
    try {
      const operation = await base.embedWithTelemetry(texts);
      calls.physicalEmbed += operation.telemetry.providerCalls;
      return operation;
    } finally {
      calls.embedMs.push(performance.now() - started);
    }
  };
  const rerankWithTelemetry = async (query, candidates) => {
    calls.rerank += 1;
    const started = performance.now();
    try {
      const operation = await base.rerankWithTelemetry(query, candidates);
      calls.physicalRerank += operation.telemetry.providerCalls;
      return operation;
    } finally {
      calls.rerankMs.push(performance.now() - started);
    }
  };
  const rewriteWithTelemetry = async (query) => {
    calls.rewrite += 1;
    const operation = await base.rewriteWithTelemetry(query);
    calls.physicalRewrite += operation.telemetry.providerCalls;
    return operation;
  };
  const ranker = {
    embeddingModel: base.embeddingModel,
    rerankModel: base.rerankModel,
    async embed(texts) {
      return (await embedWithTelemetry(texts)).result;
    },
    async embedWithTelemetry(texts) {
      return embedWithTelemetry(texts);
    },
    async rerank(query, candidates) {
      return (await rerankWithTelemetry(query, candidates)).result;
    },
    async rerankWithTelemetry(query, candidates) {
      return rerankWithTelemetry(query, candidates);
    },
    async rewrite(query) {
      return (await rewriteWithTelemetry(query)).result;
    },
    async rewriteWithTelemetry(query) {
      return rewriteWithTelemetry(query);
    },
  };
  return { ranker, calls, base };
}

async function backfillDense(store, principals) {
  const results = [];
  for (const principalId of principals) {
    let latest = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      latest = await store.backfillDenseIndex(
        64,
        undefined,
        principalId,
        NAMESPACE,
      );
      if (latest.complete || latest.processed === 0) break;
    }
    results.push({ principalId, ...latest });
  }
  return results;
}

async function runRealExtraction(database, scenarios) {
  const lifecycle = new LifecycleStore(database);
  let physicalProviderCalls = 0;
  const extractor = new OllamaMemoryExtractor({
    baseUrl: OLLAMA_URL,
    model: REQUIRED_GENERATION_MODEL,
    promptVersion: 'qa-natural-extraction-v1',
    timeoutMs: MODEL_TIMEOUT_MS,
    fetchImpl: async (...args) => {
      physicalProviderCalls += 1;
      return fetch(...args);
    },
  });
  const samples = [];
  for (const scenario of scenarios) {
    for (const spec of [
      { type: 'drink', expected: scenario.drink, positive: true },
      { type: 'editor_new', expected: scenario.newEditor, positive: true },
      { type: 'quote_noise', expected: null, positive: false },
    ]) {
      const event = scenario.events.find((item) => item.type === spec.type);
      const turnRow = findTurn(database, scenario, event);
      const turn = lifecycle.getTurn(turnRow.id);
      if (!turn) throw new Error('真实提取样本 turn 不存在');
      const callsBefore = physicalProviderCalls;
      const started = performance.now();
      const candidates = await extractor.extract(turn);
      const providerCalls = physicalProviderCalls - callsBefore;
      const passed = spec.positive
        ? candidates.some((candidate) =>
          candidate.value.normalize('NFKC').includes(spec.expected))
        : candidates.length === 0;
      samples.push({
        scenarioKey: scenario.key,
        type: spec.type,
        positive: spec.positive,
        expected: spec.expected,
        candidateCount: candidates.length,
        values: candidates.map((candidate) => candidate.value),
        providerCalls,
        provenance: providerCalls > 0
          ? REQUIRED_GENERATION_MODEL
          : 'deterministic',
        passed,
        durationMs: Number((performance.now() - started).toFixed(3)),
      });
    }
  }
  const positives = samples.filter((sample) => sample.positive);
  const negatives = samples.filter((sample) => !sample.positive);
  return {
    pipeline: 'ollama-memory-extractor-with-deterministic-guards',
    providerModel: REQUIRED_GENERATION_MODEL,
    sampleCount: samples.length,
    physicalProviderCalls,
    providerBackedSampleCount: samples.filter((sample) =>
      sample.providerCalls > 0).length,
    deterministicSampleCount: samples.filter((sample) =>
      sample.providerCalls === 0).length,
    positiveAccuracy: positives.filter((sample) => sample.passed).length /
      Math.max(1, positives.length),
    negativeAbstentionRate: negatives.filter((sample) => sample.passed).length /
      Math.max(1, negatives.length),
    latency: latencySummary(samples.map((sample) => sample.durationMs)),
    providerBackedLatency: latencySummary(samples
      .filter((sample) => sample.providerCalls > 0)
      .map((sample) => sample.durationMs)),
    samples,
  };
}

async function runGroundedAnswers(store, scenarios, gold) {
  const provider = new OllamaConversationChatProvider({
    baseUrl: OLLAMA_URL,
    timeoutMs: MODEL_TIMEOUT_MS,
  });
  const samples = [];
  for (const scenario of scenarios) {
    const own = gold.get(scenario.key);
    const scopes = [
      { scopeType: 'personal', scopeKey: 'self' },
      { scopeType: 'role', scopeKey: scenario.personaId },
      { scopeType: 'session', scopeKey: scenario.conversationId },
      ...(scenario.projectId
        ? [{ scopeType: 'project', scopeKey: scenario.projectId }]
        : []),
    ];
    for (const specification of [
      {
        type: 'editor',
        question: '我现在常用的编辑器是什么？只回答编辑器名称。',
        expected: scenario.newEditor,
        expectedGroundingId: own?.editorId || null,
        forbiddenValues: [scenario.oldEditor],
        abstentionExpected: false,
      },
      {
        type: 'unsupported-pet',
        question: '我有没有说过自己养蜥蜴？没有可靠记忆时只回答“不知道”。',
        expected: null,
        expectedGroundingId: null,
        forbiddenValues: [],
        abstentionExpected: true,
      },
    ]) {
      const context = await store.getContextReliable({
        query: specification.question,
        userId: scenario.principalId,
        namespace: NAMESPACE,
        scopes,
        limit: 5,
      });
      const controller = new AbortController();
      const started = performance.now();
      const answer = await provider.generate({
        model: REQUIRED_GENERATION_MODEL,
        requestId:
          `natural-answer-${scenario.scenarioIndex}-${specification.type}`,
        messages: [
          {
            role: 'system',
            content: '只能依据下面的长期记忆回答。' +
              '有依据时只回答目标值，不解释也不补充；' +
              '没有依据时只回答“不知道”。\n' +
              context.context,
          },
          { role: 'user', content: specification.question },
        ],
      }, controller.signal);
      const groundingIds = context.grounding.map((item) => item.memoryId);
      const assessment = assessGroundedAnswerSample({
        answer,
        expected: specification.expected,
        expectedGroundingId: specification.expectedGroundingId,
        groundingIds,
        forbiddenValues: specification.forbiddenValues,
        abstentionExpected: specification.abstentionExpected,
      });
      samples.push({
        scenarioKey: scenario.key,
        type: specification.type,
        expected: specification.expected,
        answer,
        groundingIds,
        qualityState: context.qualityState,
        abstentionExpected: specification.abstentionExpected,
        ...assessment,
        durationMs: Number((performance.now() - started).toFixed(3)),
      });
    }
  }
  const positives = samples.filter((sample) => !sample.abstentionExpected);
  const negatives = samples.filter((sample) => sample.abstentionExpected);
  return {
    model: REQUIRED_GENERATION_MODEL,
    calls: samples.length,
    positiveCount: positives.length,
    negativeCount: negatives.length,
    groundedAnswerRate: positives.filter((sample) => sample.correct).length /
      Math.max(1, positives.length),
    negativeAbstentionRate:
      negatives.filter((sample) => sample.correct).length /
      Math.max(1, negatives.length),
    finalAnswerHallucinationRate: samples.filter((sample) =>
      !sample.correct || sample.forbidden || sample.unexpectedExtraFact).length /
      Math.max(1, samples.length),
    latency: latencySummary(samples.map((sample) => sample.durationMs)),
    samples,
  };
}

function databaseSnapshot(database, databasePath) {
  const integrity = String(
    Object.values(database.prepare('PRAGMA integrity_check').get() || {})[0] || '',
  );
  return {
    integrity,
    foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all().length,
    schemaVersion: Number(
      database.prepare('PRAGMA user_version').get()?.user_version || 0,
    ),
    conversations: scalar(
      database,
      'SELECT COUNT(*) FROM conversation_sessions WHERE namespace = ?',
      NAMESPACE,
    ),
    messages: scalar(
      database,
      'SELECT COUNT(*) FROM conversation_turns WHERE namespace = ?',
      NAMESPACE,
    ),
    userMessages: scalar(
      database,
      `SELECT COUNT(*) FROM conversation_turns
       WHERE namespace = ? AND role = 'user'`,
      NAMESPACE,
    ),
    assistantMessages: scalar(
      database,
      `SELECT COUNT(*) FROM conversation_turns
       WHERE namespace = ? AND role = 'assistant'`,
      NAMESPACE,
    ),
    sequenceGaps: scalar(
      database,
      `SELECT COUNT(*) FROM (
         SELECT session_id, COUNT(*) AS message_count,
                MIN(message_sequence) AS minimum_sequence,
                MAX(message_sequence) AS maximum_sequence,
                COUNT(DISTINCT message_sequence) AS unique_sequences
         FROM conversation_turns WHERE namespace = ? GROUP BY session_id
         HAVING minimum_sequence != 1 OR maximum_sequence != message_count
            OR unique_sequences != message_count
       )`,
      NAMESPACE,
    ),
    tenantMismatches: scalar(
      database,
      `SELECT COUNT(*) FROM conversation_turns t
       JOIN conversation_sessions s ON s.id = t.session_id
       WHERE t.namespace = ? AND (
         t.user_id != s.user_id OR t.namespace != s.namespace
       )`,
      NAMESPACE,
    ),
    activeMemories: scalar(
      database,
      `SELECT COUNT(*) FROM memories
       WHERE namespace = ? AND status = 'active'`,
      NAMESPACE,
    ),
    deletedMemories: scalar(
      database,
      `SELECT COUNT(*) FROM memories
       WHERE namespace = ? AND status = 'deleted'`,
      NAMESPACE,
    ),
    memoryVersions: scalar(
      database,
      'SELECT COUNT(*) FROM memory_versions WHERE namespace = ?',
      NAMESPACE,
    ),
    tombstones: scalar(
      database,
      'SELECT COUNT(*) FROM memory_tombstones WHERE namespace = ?',
      NAMESPACE,
    ),
    unhealthyJobs: scalar(
      database,
      `SELECT COUNT(*) FROM memory_jobs
       WHERE namespace = ? AND status IN ('running', 'failed', 'dead')`,
      NAMESPACE,
    ),
    deadLetterJobs: scalar(
      database,
      'SELECT COUNT(*) FROM dead_letter_jobs WHERE namespace = ?',
      NAMESPACE,
    ),
    openOutbox: scalar(
      database,
      `SELECT COUNT(*) FROM outbox_events
       WHERE namespace = ? AND status IN ('pending', 'processing', 'failed')`,
      NAMESPACE,
    ),
    bytes: {
      database: fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0,
      wal: fs.existsSync(`${databasePath}-wal`)
        ? fs.statSync(`${databasePath}-wal`).size : 0,
      shm: fs.existsSync(`${databasePath}-shm`)
        ? fs.statSync(`${databasePath}-shm`).size : 0,
    },
  };
}

export function passesReliableRetrievalThresholds(metrics) {
  return metrics.recallAt5 >= 0.9 &&
    metrics.mrr >= 0.75 &&
    metrics.precisionAt1 >= 0.75 &&
    metrics.negativeAbstentionRate >= 0.75 &&
    metrics.crossAccountLeakageRate === 0 &&
    metrics.crossRoleLeakageRate === 0 &&
    metrics.correctionOldValueHitRate === 0 &&
    metrics.forgottenQueryCount > 0 &&
    metrics.forgottenRevivalRate === 0 &&
    Number.isFinite(metrics.latency?.p95Ms) &&
    metrics.latency.p95Ms <= RELIABLE_RECALL_P95_LIMIT_MS;
}

async function runParent() {
  const config = parseConfig();
  const runId = createQaRunId();
  const runRoot = createPrivateQaRunRoot(privateParent, 'run-');
  const dataDir = path.join(runRoot, 'data');
  const receiptsDir = path.join(runRoot, 'receipts');
  const workerDir = path.join(runRoot, 'workers');
  for (const directory of [dataDir, receiptsDir, workerDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const databasePath = path.join(dataDir, 'memory-bridge.sqlite3');
  const reportPath = immutableQaPath(
    receiptsDir,
    'natural-conversation-quality',
    runId,
    'json',
  );
  const failurePath = immutableQaPath(
    receiptsDir,
    'natural-conversation-failure',
    runId,
    'json',
  );
  const checks = [];
  const record = (name, passed, details = {}) => {
    const check = { name, passed: Boolean(passed), ...details };
    checks.push(check);
    console.log(`[check] ${check.passed ? 'PASS' : 'FAIL'} ${name}`);
  };
  const startedAt = new Date().toISOString();
  const implementation = buildQaImplementationEvidence({
    projectRoot,
    schemaVersion: SCHEMA_VERSION,
    relativeFiles: [
      'package-lock.json',
      'package.json',
      'scripts/qa-natural-conversation-quality.mjs',
      'scripts/qa-receipt-lib.mjs',
      'src/server/candidate-resolver.ts',
      'src/server/conversation-service.ts',
      'src/server/episodic-memory-service.ts',
      'src/server/hierarchical-summary-service.ts',
      'src/server/lifecycle-store.ts',
      'src/server/memory-extractor.ts',
      'src/server/memory-reflection.ts',
      'src/server/memory-store.ts',
      'src/server/memory-worker.ts',
      'src/server/semantic-ranker.ts',
    ],
    runtimeDirectories: ['dist/server'],
  });
  writeImmutableQaFile(
    path.join(receiptsDir, 'run-manifest.json'),
    `${JSON.stringify({
      format: 'memory-bridge-natural-conversation-manifest:v1',
      runId,
      startedAt,
      config,
      namespace: NAMESPACE,
      requiredGenerationModel: REQUIRED_GENERATION_MODEL,
      requiredEmbeddingModel: REQUIRED_EMBEDDING_MODEL,
      productionPortUsed: false,
      productionDatabaseUsed: false,
      dataRetained: true,
      implementation,
    }, null, 2)}\n`,
  );

  let database = null;
  try {
    const baseScenarios = buildScenarios(config);
    const conversationCorpus = summarizeNaturalCorpus(
      config,
      baseScenarios,
    );
    record(
      'natural-continuous-corpus-quality',
      passesNaturalCorpusQuality(conversationCorpus, baseScenarios.length),
      conversationCorpus,
    );
    const preflight = config.realModel
      ? await modelPreflight()
      : {
          available: false,
          generationAvailable: false,
          embeddingAvailable: false,
          reason: 'real_model_disabled',
          durationMs: 0,
        };
    record(
      'fixed-model-preflight',
      !config.realModel || preflight.available,
      preflight,
    );
    if (config.realModel && !preflight.available) {
      throw new Error(`固定模型预检失败: ${preflight.reason}`);
    }
    database = openDatabase(databasePath);
    const identity = new IdentityService(database);
    const service = new ConversationService(database, {
      instanceId: 'qa-natural-setup',
    });
    const trusted = new Map();
    for (let userIndex = 0; userIndex < config.userCount; userIndex += 1) {
      const principalId = baseScenarios.find((scenario) =>
        scenario.userIndex === userIndex).principalId;
      identity.createPrincipal({
        id: principalId,
        displayName: PEOPLE[userIndex].name,
      });
      trusted.set(principalId, identity.trustPrincipal(principalId));
      service.bindProject(
        { principalId, namespace: NAMESPACE },
        `natural-user-${String(userIndex + 1).padStart(2, '0')}-project`,
        { expectedVersion: 0, displayName: `${PEOPLE[userIndex].name}的工作项目` },
      );
    }
    const scenarios = [];
    for (const scenario of baseScenarios) {
      identity.bindPersona(trusted.get(scenario.principalId), {
        clientType: 'qa-natural-conversation',
        clientInstanceId: `${scenario.principalId}-device`,
        personaId: scenario.personaId,
        displayName: scenario.roleName,
      });
      service.putChatProfile(
        { principalId: scenario.principalId, namespace: NAMESPACE },
        scenario.personaId,
        {
          expectedVersion: 0,
          displayName: scenario.roleName,
          systemPrompt: '只使用当前账户和当前角色有权访问的可靠记忆。',
          greeting: '你好。',
          language: 'zh-Hans',
          capabilityIds: [],
        },
      );
      const conversation = service.createConversation(
        { principalId: scenario.principalId, namespace: NAMESPACE },
        {
          idempotencyKey: `natural-conversation-${scenario.scenarioIndex}`,
          personaId: scenario.personaId,
          projectId: scenario.projectId,
          title: `${scenario.roleName}长期自然对话`,
        },
      );
      scenarios.push({ ...scenario, conversationId: conversation.id });
    }
    database.close();
    database = null;

    const workerSpecs = [];
    for (const scenario of scenarios) {
      const specPath = path.join(workerDir, `scenario-${scenario.scenarioIndex}.json`);
      const resultPath = path.join(
        workerDir,
        `scenario-${scenario.scenarioIndex}-result.json`,
      );
      writeImmutableQaFile(specPath, `${JSON.stringify({
        databasePath,
        config,
        scenario,
        resultPath,
      }, null, 2)}\n`);
      workerSpecs.push({ specPath, resultPath });
    }
    const writerStarted = performance.now();
    for (let offset = 0;
      offset < workerSpecs.length;
      offset += config.writeConcurrency) {
      await Promise.all(workerSpecs
        .slice(offset, offset + config.writeConcurrency)
        .map((spec) => spawnWorker(spec.specPath)));
    }
    const writerDurationMs = performance.now() - writerStarted;
    const writerResults = workerSpecs.map((spec) =>
      JSON.parse(fs.readFileSync(spec.resultPath, 'utf8')));
    record(
      'authoritative-natural-message-count',
      writerResults.length === scenarios.length &&
        writerResults.every((result) =>
          result.counters.messages === config.messagesPerPersona) &&
        writerResults.reduce((sum, result) =>
          sum + result.counters.messages, 0) === config.totalMessages,
      {
        expectedTotal: config.totalMessages,
        actualTotal: writerResults.reduce((sum, result) =>
          sum + result.counters.messages, 0),
        busyRetries: writerResults.reduce((sum, result) =>
          sum + result.counters.busyRetries, 0),
      },
    );
    database = openDatabase(databasePath);
    const schema37Ranker = config.realModel && preflight.available
      ? instrumentedRanker()
      : {
          ranker: createSchema37DeterministicRanker(),
          calls: {
            embed: 0,
            rerank: 0,
            rewrite: 0,
            physicalEmbed: 0,
            physicalRerank: 0,
            physicalRewrite: 0,
            embedMs: [],
            rerankMs: [],
          },
          base: null,
        };
    const extractionPipeline = createQaPipelineExtractor(
      config.realModel && preflight.available,
    );
    let schema37Pipeline = await drainSchema37Pipeline(
      database,
      scenarios,
      schema37Ranker.ranker,
      {
        extractor: extractionPipeline.extractor,
        candidateMode: 'auto',
        includeRetention: false,
      },
    );
    let productionEvidence = null;
    if (config.realModel && preflight.available) {
      productionEvidence = productionEvidenceSnapshot(
        database,
        scenarios,
        extractionPipeline.extractor.extractorId,
      );
      record(
        'production-user-turns-not-retention-redacted',
        productionEvidence.unredactedUserTurnsPassed,
        {
          redactedUserTurnCount: productionEvidence.redactedUserTurnCount,
        },
      );
      record(
        'production-labeled-candidate-source-evidence',
        productionEvidence.labeledCandidateEvidencePassed,
        {
          labeledCandidateCount: productionEvidence.samples.length,
          missingCandidateCount: productionEvidence.missingCandidateCount,
          missingSourceExcerptCount:
            productionEvidence.missingSourceExcerptCount,
        },
      );
    }
    const extractionLedger = extractionLedgerSnapshot(database);
    const extractionConvergence = assessExtractionConvergence(
      extractionLedger,
    );
    record(
      'full-extraction-job-and-run-convergence',
      extractionConvergence.passed,
      {
        ...extractionLedger,
        ...extractionPipeline.telemetry,
        failures: extractionConvergence.failures,
      },
    );
    const pipelineExtractionCoverage =
      config.realModel && preflight.available
        ? evaluatePipelineExtractionCoverage(
          database,
          scenarios,
          extractionPipeline.extractor.extractorId,
        )
        : null;
    if (pipelineExtractionCoverage) {
      record(
        'production-extractor-full-labeled-coverage',
        pipelineExtractionCoverage.positiveCoverageRate >= 0.75 &&
          pipelineExtractionCoverage.negativeAbstentionRate === 1 &&
          pipelineExtractionCoverage.implicitPatternDeferralRate === 1 &&
          pipelineExtractionCoverage.passed,
        {
          positiveCoverageRate:
            pipelineExtractionCoverage.positiveCoverageRate,
          negativeAbstentionRate:
            pipelineExtractionCoverage.negativeAbstentionRate,
          implicitPatternDeferralRate:
            pipelineExtractionCoverage.implicitPatternDeferralRate,
          positiveCount: pipelineExtractionCoverage.positiveCount,
          negativeNoiseCount:
            pipelineExtractionCoverage.negativeNoiseCount,
          implicitPatternCount:
            pipelineExtractionCoverage.implicitPatternCount,
          ordinaryDailyQuestionCount:
            pipelineExtractionCoverage.ordinaryDailyQuestionCount,
          ordinaryDailyQuestionCandidateCount:
            pipelineExtractionCoverage.ordinaryDailyQuestionCandidateCount,
          ordinaryDailyQuestionPollutionSamples:
            pipelineExtractionCoverage.ordinaryDailyQuestionPollutionSamples,
        },
      );
    }
    let productionLearning = null;
    let productionExplicitForgets = null;
    let productionLearnedRetrieval = null;
    let productionLearnedCases = null;
    if (config.realModel && preflight.available) {
      productionLearning = await resolveProductionLabeledMemories(
        database,
        scenarios,
        extractionPipeline.extractor.extractorId,
      );
      record(
        'production-learned-memory-auto-activation',
        productionLearning.activationRate === 1,
        {
          expectedCount: productionLearning.expectedCount,
          passedCount: productionLearning.passedCount,
          activationRate: productionLearning.activationRate,
          missingOrPending: productionLearning.missingOrPending,
        },
      );
      schema37Pipeline = await drainSchema37Pipeline(
        database,
        scenarios,
        schema37Ranker.ranker,
        {
          extractor: extractionPipeline.extractor,
          candidateMode: 'auto',
          includeRetention: false,
        },
      );
      productionExplicitForgets = await executeProductionExplicitForgets(
        database,
        scenarios,
        schema37Pipeline.store,
        extractionPipeline.extractor.extractorId,
        productionLearning.gold,
      );
      record(
        'production-explicit-forget-lifecycle',
        productionExplicitForgets.passed,
        productionExplicitForgets,
      );
      productionLearnedCases = learnedMemoryQueryCases(
        scenarios,
        productionLearning.gold,
        database,
      );
      productionLearnedRetrieval = await evaluateQueries(
        schema37Pipeline.store,
        productionLearnedCases.cases,
        true,
      );
      productionLearnedRetrieval.missingExpectedCaseIds =
        productionLearnedCases.missing;
      record(
        'production-learned-memory-retrieval-thresholds',
        productionLearnedCases.missing.length === 0 &&
          passesReliableRetrievalThresholds(
            productionLearnedRetrieval.metrics,
          ),
        {
          ...productionLearnedRetrieval.metrics,
          missingExpectedCaseIds: productionLearnedCases.missing,
        },
      );
    } else if (config.realModel) {
      record('production-learned-memory-auto-activation', false, {
        reason: 'fixed_models_unavailable',
      });
      record('production-learned-memory-retrieval-thresholds', false, {
        reason: 'fixed_models_unavailable',
      });
    }
    const episodeCases = episodeQueryCases(database, scenarios);
    const timelineCases = timelineQueryCases(database, scenarios);
    const episodeRecall = evaluateEpisodeRecall(
      schema37Pipeline.store,
      episodeCases,
    );
    let schema37 = {
      ...schema37Snapshot(database, scenarios, {
        includeRetention: false,
      }),
      ...evaluateEpisodeIsolation(
        schema37Pipeline.store,
        episodeCases,
        scenarios,
      ),
      episodeRecallAt5: episodeRecall.recallAt5,
    };
    let schema37Acceptance = assessSchema37Acceptance(schema37);
    record(
      'schema37-authoritative-layered-memory',
      schema37Acceptance.passed && schema37.openSchema37Work === 0 &&
        schema37.summaryCounts.session > 0 &&
        schema37.summaryCounts.day > 0 &&
        schema37.summaryCounts.week > 0,
      {
        ...schema37,
        failures: schema37Acceptance.failures,
      },
    );
    const learnedGold = productionLearning?.gold || new Map();
    const correctionPath = productionCorrectionPathSnapshot(
      scenarios,
      learnedGold,
    );
    record(
      'production-correction-version-path',
      Boolean(productionLearning) && correctionPath.passed,
      correctionPath,
    );

    const cases = productionLearnedCases?.cases || [];
    const localRetrieval = await evaluateQueries(
      new MemoryStore(database),
      cases,
      false,
    );
    record(
      'local-production-retrieval-isolation-and-lifecycle',
      localRetrieval.metrics.crossAccountLeakageRate === 0 &&
        localRetrieval.metrics.crossRoleLeakageRate === 0 &&
        localRetrieval.metrics.correctionOldValueHitRate === 0 &&
        localRetrieval.metrics.forgottenQueryCount === scenarios.length &&
        localRetrieval.metrics.forgottenRevivalRate === 0,
      localRetrieval.metrics,
    );

    let deterministicReflection = null;
    let reliableRetrieval = null;
    let timelineRetrieval = null;
    let realExtraction = null;
    let realReflection = null;
    let reflectionActivation = null;
    let groundedAnswers = null;
    let modelCalls = null;
    let denseBackfill = null;
    let postRetentionRetrieval = null;
    if (config.realModel && preflight.available) {
      const instrumented = schema37Ranker;
      const reliableStore = schema37Pipeline.store;
      denseBackfill = schema37Pipeline.denseBackfill;
      record(
        'dense-index-complete',
        denseBackfill.every((item) => item.complete),
        { principals: denseBackfill },
      );
      reliableRetrieval = productionLearnedRetrieval;
      record(
        'reliable-natural-retrieval-thresholds',
        Boolean(reliableRetrieval) &&
          productionLearnedCases?.missing.length === 0 &&
          reliableRetrieval.metrics.forgottenQueryCount === scenarios.length &&
          passesReliableRetrievalThresholds(reliableRetrieval.metrics),
        reliableRetrieval.metrics,
      );
      timelineRetrieval = await evaluateTimelineQueries(
        reliableStore,
        timelineCases,
      );
      record(
        'reliable-timeline-retrieval-thresholds',
        passesTimelineThresholds(timelineRetrieval.metrics),
        timelineRetrieval.metrics,
      );
      realExtraction = await runRealExtraction(database, scenarios);
      record(
        'fixed-extraction-pipeline-quality',
        realExtraction.positiveAccuracy >= 0.75 &&
          realExtraction.negativeAbstentionRate >= 0.75,
        {
          positiveAccuracy: realExtraction.positiveAccuracy,
          negativeAbstentionRate: realExtraction.negativeAbstentionRate,
          sampleCount: realExtraction.sampleCount,
          physicalProviderCalls: realExtraction.physicalProviderCalls,
          providerBackedSampleCount:
            realExtraction.providerBackedSampleCount,
          deterministicSampleCount:
            realExtraction.deterministicSampleCount,
        },
      );
      realReflection = await executeReflectionSamples(
        database,
        scenarios,
        new OllamaReflectionProvider({
          baseUrl: OLLAMA_URL,
          model: REQUIRED_GENERATION_MODEL,
          promptVersion: 'qa-natural-real-reflection-v3-grounded-evidence-repair',
          timeoutMs: MODEL_TIMEOUT_MS,
        }),
        'qwen-real',
      );
      const reflectionRate = realReflection.filter((sample) => sample.passed).length /
        Math.max(1, realReflection.length);
      const incorrectReflectionCandidates = realReflection.reduce(
        (total, sample) => total + sample.incorrectCandidateCount,
        0,
      );
      const extraGroundedReflectionCandidates = realReflection.reduce(
        (total, sample) => total + sample.extraGroundedCandidateCount,
        0,
      );
      const totalReflectionCandidates = realReflection.reduce(
        (total, sample) => total + sample.candidateCount,
        0,
      );
      record(
        'qwen-real-stable-habit-quality',
        reflectionRate >= 0.75 && incorrectReflectionCandidates === 0,
        {
          stableHabitIdentificationRate: reflectionRate,
          incorrectStablePatternCount: incorrectReflectionCandidates,
          incorrectStablePatternRate: incorrectReflectionCandidates /
            Math.max(1, totalReflectionCandidates),
          extraGroundedCandidateCount: extraGroundedReflectionCandidates,
          totalCandidateCount: totalReflectionCandidates,
        },
      );
      reflectionActivation = await resolveQueuedReflectionCandidates(
        database,
        realReflection,
      );
      record(
        'verified-stable-habit-auto-activation',
        reflectionActivation.passed,
        {
          processedJobCount: reflectionActivation.processedJobCount,
          expectedCandidateCount: reflectionActivation.expectedCandidateCount,
          activatedCandidateCount:
            reflectionActivation.activatedCandidateCount,
        },
      );
      groundedAnswers = await runGroundedAnswers(
        reliableStore,
        scenarios,
        learnedGold,
      );
      record(
        'qwen-grounded-answer-quality',
        groundedAnswers.groundedAnswerRate >= 0.75 &&
          groundedAnswers.negativeAbstentionRate === 1 &&
          groundedAnswers.finalAnswerHallucinationRate === 0,
        {
          groundedAnswerRate: groundedAnswers.groundedAnswerRate,
          negativeAbstentionRate: groundedAnswers.negativeAbstentionRate,
          finalAnswerHallucinationRate:
            groundedAnswers.finalAnswerHallucinationRate,
        },
      );
      modelCalls = {
        logicalEmbedOperations: instrumented.calls.embed,
        logicalRerankStages: instrumented.calls.rerank,
        logicalRewriteOperations: instrumented.calls.rewrite,
        physicalEmbeddingProviderCalls: instrumented.calls.physicalEmbed,
        physicalRerankProviderCalls: instrumented.calls.physicalRerank,
        physicalRewriteProviderCalls: instrumented.calls.physicalRewrite,
        embedLatency: latencySummary(instrumented.calls.embedMs),
        rerankLatency: latencySummary(instrumented.calls.rerankMs),
      };
    } else if (config.realModel) {
      record('dense-index-complete', false, { reason: preflight.reason });
      record('reliable-natural-retrieval-thresholds', false, {
        reason: 'fixed_models_unavailable',
      });
      record('reliable-timeline-retrieval-thresholds', false, {
        reason: 'fixed_models_unavailable',
      });
      record('fixed-extraction-pipeline-quality', false, {
        reason: `${REQUIRED_GENERATION_MODEL}_unavailable`,
      });
      record('qwen-real-stable-habit-quality', false, {
        reason: `${REQUIRED_GENERATION_MODEL}_unavailable`,
      });
      record('qwen-grounded-answer-quality', false, {
        reason: `${REQUIRED_GENERATION_MODEL}_unavailable`,
      });
    }

    if (!config.realModel) {
      reflectionActivation = {
        processedJobCount: 0,
        expectedCandidateCount: 0,
        activatedCandidateCount: 0,
        candidates: [],
        passed: true,
      };
      record(
        'verified-stable-habit-auto-activation',
        true,
        reflectionActivation,
      );
    }

    deterministicReflection = await executeReflectionSamples(
      database,
      scenarios,
      deterministicReflectionProvider(scenarios),
      'deterministic',
    );
    record(
      'deterministic-stable-habit-identification',
      deterministicReflection.every((sample) => sample.passed),
      {
        passed: deterministicReflection.filter((sample) => sample.passed).length,
        total: deterministicReflection.length,
        extraGroundedCandidateCount: deterministicReflection.reduce(
          (total, sample) => total + sample.extraGroundedCandidateCount,
          0,
        ),
        invalidCandidateCount: deterministicReflection.reduce(
          (total, sample) => total + sample.invalidCandidateCount,
          0,
        ),
      },
    );

    const finalSchema37Pipeline = await drainSchema37Pipeline(
      database,
      scenarios,
      schema37Ranker.ranker,
      {
        extractor: extractionPipeline.extractor,
        candidateMode: 'auto',
        includeRetention: true,
      },
    );
    if (config.realModel && preflight.available) {
      postRetentionRetrieval = await evaluateQueries(
        finalSchema37Pipeline.store,
        productionLearnedCases?.cases || [],
        true,
      );
      postRetentionRetrieval.missingExpectedCaseIds =
        productionLearnedCases?.missing || [];
      record(
        'post-retention-production-retrieval-thresholds',
        postRetentionRetrieval.missingExpectedCaseIds.length === 0 &&
          postRetentionRetrieval.metrics.forgottenQueryCount ===
            scenarios.length &&
          passesReliableRetrievalThresholds(
            postRetentionRetrieval.metrics,
          ),
        {
          ...postRetentionRetrieval.metrics,
          missingExpectedCaseIds:
            postRetentionRetrieval.missingExpectedCaseIds,
        },
      );
    }
    const finalEpisodeCases = episodeQueryCases(database, scenarios);
    const finalEpisodeRecall = evaluateEpisodeRecall(
      finalSchema37Pipeline.store,
      finalEpisodeCases,
    );
    schema37 = {
      ...schema37Snapshot(database, scenarios),
      ...evaluateEpisodeIsolation(
        finalSchema37Pipeline.store,
        finalEpisodeCases,
        scenarios,
      ),
      episodeRecallAt5: finalEpisodeRecall.recallAt5,
    };
    schema37Acceptance = assessSchema37Acceptance(schema37);
    record(
      'schema37-final-outbox-dense-convergence',
      schema37Acceptance.passed && schema37.openSchema37Work === 0,
      {
        ...schema37,
        failures: schema37Acceptance.failures,
        pipeline: finalSchema37Pipeline.counters,
      },
    );
    const snapshot = databaseSnapshot(database, databasePath);
    record('database-integrity', snapshot.integrity === 'ok', {
      integrity: snapshot.integrity,
    });
    record('database-foreign-keys', snapshot.foreignKeyViolations === 0, {
      violations: snapshot.foreignKeyViolations,
    });
    record(
      'database-counts-and-isolation',
      snapshot.messages === config.totalMessages &&
        snapshot.userMessages === config.totalMessages / 2 &&
        snapshot.assistantMessages === config.totalMessages / 2 &&
        snapshot.sequenceGaps === 0 && snapshot.tenantMismatches === 0,
      snapshot,
    );
    record(
      'database-job-health',
      snapshot.unhealthyJobs === 0 && snapshot.deadLetterJobs === 0,
      {
        unhealthyJobs: snapshot.unhealthyJobs,
        deadLetterJobs: snapshot.deadLetterJobs,
        openOutbox: snapshot.openOutbox,
      },
    );

    const failedChecks = checks.filter((check) => !check.passed);
    const report = {
      format: 'memory-bridge-natural-conversation-quality-report:v1',
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      status: failedChecks.length === 0 ? 'PASS' : 'FAIL',
      scope: {
        ...config,
        scenarioCount: scenarios.length,
        messagesPerRole: config.messagesPerPersona,
        totalMessages: config.totalMessages,
        generatedFixtureMessages: config.totalMessages,
        labeledProductionEventCount: productionLearning?.expectedCount || 0,
        extractionJobConvergenceIsFullDataset: true,
        semanticQualityModelCallsAreSampled: config.realModel,
      },
      safety: {
        isolatedDatabase: true,
        productionDatabaseUsed: false,
        productionPort3789Used: false,
        privateConversationDataUsed: false,
        fixedGenerationModel: REQUIRED_GENERATION_MODEL,
        automaticModelReplacement: false,
        dataRetained: true,
      },
      thresholds: {
        ...SCHEMA37_ACCEPTANCE_THRESHOLDS,
        reliableRecallAt5Minimum: 0.9,
        reliableRecallP95MaximumMs: RELIABLE_RECALL_P95_LIMIT_MS,
        timelineLatestAccuracyMinimum: 0.9,
        timelineHistoryCoverageMinimum: 0.9,
        timelineStaleLatestMaximum: 0,
        timelineRecallP95MaximumMs: RELIABLE_RECALL_P95_LIMIT_MS,
        reliableMrrMinimum: 0.75,
        reliablePrecisionAt1Minimum: 0.75,
        negativeAbstentionMinimum: 0.75,
        leakageMaximum: 0,
        correctionOldValueHitMaximum: 0,
        forgottenRevivalMaximum: 0,
        realExtractionAccuracyMinimum: 0.75,
        productionLearnedActivationMinimum: 1,
        productionLearnedRecallAt5Minimum: 0.9,
        realStableHabitIdentificationMinimum: 0.75,
        realStableHabitActivationMinimum: 1,
        incorrectStablePatternMaximum: 0,
        finalAnswerHallucinationMaximum: 0,
        extractionTurnCoverageMinimum:
          EXTRACTION_CONVERGENCE_THRESHOLDS.turnCoverageRateMinimum,
        dueExtractionJobMaximum:
          EXTRACTION_CONVERGENCE_THRESHOLDS.dueJobMaximum,
      },
      checks,
      failedChecks: failedChecks.map((check) => check.name),
      writer: {
        durationMs: Number(writerDurationMs.toFixed(3)),
        workers: writerResults,
        latency: latencySummary(writerResults.flatMap((result) => [
          result.latency.p50Ms,
          result.latency.p95Ms,
          result.latency.p99Ms,
        ]).filter((value) => value !== null)),
      },
      conversationCorpus,
      deterministicLifecycle: {
        goldControlInjectedIntoRetainedDatabase: false,
        controlGroupStatus: 'omitted_to_preserve_production_only_database',
        stableHabitSamples: deterministicReflection,
      },
      extraction: {
        telemetry: extractionPipeline.telemetry,
        ledger: extractionLedger,
        convergence: extractionConvergence,
        productionEvidence,
        labeledCoverage: pipelineExtractionCoverage,
        productionLearning: productionLearning
          ? {
              extractorId: productionLearning.extractorId,
              expectedCount: productionLearning.expectedCount,
              passedCount: productionLearning.passedCount,
              activationRate: productionLearning.activationRate,
              missingOrPending: productionLearning.missingOrPending,
              samples: productionLearning.samples,
              learnedMemoryIdsByScenario:
                Object.fromEntries(productionLearning.gold),
            }
          : null,
        productionExplicitForgets,
        productionLearnedRetrieval,
      },
      schema37: {
        provenance: config.realModel
          ? 'real-bge-m3-dense-plus-deterministic-summary-state-machine'
          : 'deterministic-no-provider-smoke',
        generationModelDeclared: REQUIRED_GENERATION_MODEL,
        embeddingModelDeclared: REQUIRED_EMBEDDING_MODEL,
        physicalGenerationProviderCalls:
          schema37Ranker.calls.physicalRerank +
          schema37Ranker.calls.physicalRewrite,
        physicalEmbeddingProviderCalls: schema37Ranker.calls.physicalEmbed,
        pipeline: {
          initial: schema37Pipeline.counters,
          final: finalSchema37Pipeline.counters,
        },
        metrics: schema37,
        acceptance: schema37Acceptance,
        episodeRecall: finalEpisodeRecall,
      },
      localRetrieval,
      fixedModelPreflight: preflight,
      denseBackfill,
      reliableRetrieval,
      postRetentionRetrieval,
      timelineRetrieval,
      realExtraction,
      realReflection,
      reflectionActivation,
      groundedAnswers,
      modelCalls,
      database: snapshot,
      artifacts: { runRoot, databasePath, reportPath, retained: true },
      implementation,
    };
    const receipt = writeImmutableQaFile(
      reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify({
      status: report.status,
      runRoot,
      reportPath,
      reportSha256: receipt.sha256,
      totalMessages: config.totalMessages,
      failedChecks: report.failedChecks,
    }, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeImmutableQaFile(failurePath, `${JSON.stringify({
      format: 'memory-bridge-natural-conversation-failure:v1',
      runId,
      status: 'ERROR',
      startedAt,
      failedAt: new Date().toISOString(),
      errorClass: error instanceof Error ? error.name : 'Error',
      error: message.slice(0, 1_000),
      errorFingerprint: sha256(message),
      checks,
      artifacts: { runRoot, databasePath, retained: true },
      implementation,
    }, null, 2)}\n`);
    throw error;
  } finally {
    database?.close();
  }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(scriptPath);
if (invokedDirectly) {
  if (process.argv[2] === '--worker') {
    const specPath = process.argv[3];
    if (!specPath) throw new Error('worker 缺少 spec path');
    await runWorker(specPath);
  } else {
    await runParent();
  }
}
