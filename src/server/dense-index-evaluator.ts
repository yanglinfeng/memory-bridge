import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DENSE_EVALUATION_DATASET_ID,
  DENSE_EVALUATION_DATASET_SHA256,
  DENSE_EVALUATION_MRR_AT_10_MIN,
  DENSE_EVALUATION_QUERY_COUNT,
  DENSE_EVALUATION_RECALL_AT_20_MIN,
  DENSE_EVALUATOR_VERSION,
} from './dense-evaluation-contract.js';
import { openDatabase } from './database.js';
import {
  MemoryStore,
  type DenseIndexEvaluationReport,
} from './memory-store.js';

export {
  DENSE_EVALUATION_DATASET_ID,
  DENSE_EVALUATION_DATASET_SHA256,
  DENSE_EVALUATOR_VERSION,
} from './dense-evaluation-contract.js';

interface DenseEvaluationCase {
  id: string;
  query: string;
  relevant: string;
  distractors: string[];
}

export const DENSE_EVALUATION_CASES: readonly DenseEvaluationCase[] = [
  {
    id: 'coffee-sugar',
    query: '用户喝咖啡时会加糖吗？',
    relevant: '用户喝咖啡只喝无糖拿铁。',
    distractors: [
      '会议室咖啡机需要维修。',
      '咖啡店的甜点菜单增加了焦糖蛋糕。',
    ],
  },
  {
    id: 'home-address',
    query: '用户现在住在哪个城市？',
    relevant: '用户目前住在上海浦东。',
    distractors: [
      '公司办公地址位于北京朝阳区。',
      '上海办公室正在装修。',
    ],
  },
  {
    id: 'occupation',
    query: '用户当前从事什么工作？',
    relevant: '用户当前的工作是后端工程师。',
    distractors: [
      '公司正在招聘后端工程师。',
      '后端工程师岗位说明已经归档。',
    ],
  },
  {
    id: 'pet-name',
    query: '用户的宠物叫什么名字？',
    relevant: '用户养的猫叫豆包。',
    distractors: [
      '宠物禁止进入办公区域。',
      '豆包店的营业时间发生了变化。',
    ],
  },
  {
    id: 'empty-first-run',
    query: '产品首次启动时应该预置演示数据吗？',
    relevant: '产品首次启动必须保持空数据，不预置演示记录。',
    distractors: [
      '演示数据保存在隔离测试环境。',
      '产品演示安排在周五下午。',
    ],
  },
  {
    id: 'programming-language',
    query: '用户最喜欢哪种编程语言？',
    relevant: '用户最喜欢的编程语言是 TypeScript。',
    distractors: [
      'Python 入门教程已经归档。',
      'JavaScript 运行时刚刚升级。',
    ],
  },
  {
    id: 'reply-language',
    query: '应该使用什么语言回复用户？',
    relevant: '用户要求默认使用中文回复。',
    distractors: [
      '项目新增了中文翻译文件。',
      '英语词典资源已经下载。',
    ],
  },
  {
    id: 'travel',
    query: '用户出差时首选什么交通工具？',
    relevant: '用户出差时优先乘坐高铁。',
    distractors: [
      '高铁站的设备正在检修。',
      '公司购买了一辆通勤班车。',
    ],
  },
  {
    id: 'work-time',
    query: '用户通常几点开始办公？',
    relevant: '用户每天早上九点开始办公。',
    distractors: [
      '办公楼九点开始访客登记。',
      '考勤系统将在午夜维护。',
    ],
  },
  {
    id: 'allergy',
    query: '给用户准备食物时要避开什么？',
    relevant: '用户对花生严重过敏。',
    distractors: [
      '仓库新到了一批花生原料。',
      '餐厅更换了坚果供应商。',
    ],
  },
  {
    id: 'theme',
    query: '用户偏好明亮主题还是夜间主题？',
    relevant: '用户界面偏好使用深色模式。',
    distractors: [
      '夜间主题文件需要重新打包。',
      '显示器亮度检测功能已经上线。',
    ],
  },
  {
    id: 'timezone',
    query: '用户所在时区是什么？',
    relevant: '用户的时区是 Asia/Shanghai。',
    distractors: [
      '时区转换依赖需要升级。',
      '上海机房使用 UTC 记录日志。',
    ],
  },
  {
    id: 'answer-style',
    query: '回答用户时应该详细还是精炼？',
    relevant: '用户要求回复简洁直接。',
    distractors: [
      '精炼版项目总结已经归档。',
      '详细日志保留七天。',
    ],
  },
  {
    id: 'technology-stack',
    query: '这个长期记忆服务使用什么后端技术？',
    relevant: '长期记忆服务后端使用 Node.js 和 SQLite。',
    distractors: [
      'Node.js 入门教程已经下载。',
      'SQLite 客户端图标需要更新。',
    ],
  },
  {
    id: 'meeting-time',
    query: '团队例会安排在什么时候？',
    relevant: '团队每周一下午三点召开例会。',
    distractors: [
      '例会室的投影仪需要维修。',
      '周一下午会进行网络维护。',
    ],
  },
  {
    id: 'food-dislike',
    query: '用户是否喜欢香菜？',
    relevant: '用户不喜欢香菜，点餐时需要去掉。',
    distractors: [
      '香菜供应商本周暂停送货。',
      '餐厅新增了香菜种植记录。',
    ],
  },
  {
    id: 'editor',
    query: '用户平时使用哪个代码编辑器？',
    relevant: '用户平时使用 VS Code 编写代码。',
    distractors: [
      'VS Code 插件市场发生过故障。',
      '编辑器对比报告已经生成。',
    ],
  },
  {
    id: 'paper-reading',
    query: '用户阅读长文章时偏好什么载体？',
    relevant: '用户阅读长文章时更喜欢纸质版本。',
    distractors: [
      '打印机缺少 A4 纸。',
      '电子书服务完成了版本升级。',
    ],
  },
  {
    id: 'local-first',
    query: '用户希望数据优先保存在哪里？',
    relevant: '用户偏好本地优先，数据默认保存在自己的电脑。',
    distractors: [
      '云服务器的本地缓存已清理。',
      '电脑商店正在进行促销。',
    ],
  },
  {
    id: 'notification-window',
    query: '什么时候不要给用户发送普通提醒？',
    relevant: '用户要求晚上十一点到早上七点不要发送普通提醒。',
    distractors: [
      '提醒服务在晚上十一点发布了新版本。',
      '早上七点的服务器巡检已经完成。',
    ],
  },
] as const;

const canonicalDataset = JSON.stringify(
  DENSE_EVALUATION_CASES.map((item) => ({
    id: item.id,
    query: item.query,
    relevant: item.relevant,
    distractors: [...item.distractors],
  })),
);

const computedDatasetSha256 = createHash('sha256')
  .update(canonicalDataset)
  .digest('hex');

if (
  DENSE_EVALUATION_CASES.length !== DENSE_EVALUATION_QUERY_COUNT ||
  computedDatasetSha256 !== DENSE_EVALUATION_DATASET_SHA256
) {
  throw new Error('Dense 固定评测数据集与不可变契约不一致');
}

export interface DenseIndexEvaluationOutcome {
  report: DenseIndexEvaluationReport;
  activated: boolean;
}

export class DenseIndexEvaluator {
  constructor(private readonly productionStore: MemoryStore) {}

  async evaluateAndActivate(input: {
    generationId: string;
    userId?: string;
    namespace?: string;
  }): Promise<DenseIndexEvaluationOutcome> {
    const generation = this.productionStore.denseIndexGeneration(
      input.generationId,
    );
    if (!generation) {
      throw new Error('待评测的 Dense generation 不存在');
    }
    const ranker =
      await this.productionStore.denseRankerForGeneration(
        generation.generationId,
      );
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-bridge-dense-evaluation-'),
    );
    const database = openDatabase(
      path.join(directory, 'evaluation.sqlite3'),
    );
    const evaluationStore = new MemoryStore(database, ranker);
    const namespace = `evaluation:${DENSE_EVALUATION_DATASET_ID}`;
    const expectedIds = new Map<string, string>();
    const startedAt = new Date().toISOString();
    try {
      for (const fixture of DENSE_EVALUATION_CASES) {
        const relevant = evaluationStore.remember({
          namespace,
          kind: 'preference',
          content: fixture.relevant,
          source: 'dense-index-evaluation',
          stableKey: `evaluation::${fixture.id}::relevant`,
        }).memory;
        expectedIds.set(fixture.id, relevant.id);
        for (const [index, distractor] of fixture.distractors.entries()) {
          evaluationStore.remember({
            namespace,
            kind: 'knowledge',
            content: distractor,
            source: 'dense-index-evaluation',
            stableKey: `evaluation::${fixture.id}::distractor::${index}`,
          });
        }
      }
      let backfill = await evaluationStore.backfillDenseIndex(
        256,
        undefined,
        undefined,
        namespace,
      );
      while (!backfill.complete) {
        if (backfill.processed === 0) {
          throw new Error('Dense 固定评测回填没有进展');
        }
        backfill = await evaluationStore.backfillDenseIndex(
          256,
          undefined,
          undefined,
          namespace,
        );
      }
      if (backfill.generationId !== generation.generationId) {
        throw new Error('固定评测使用的 embedding generation 与目标不一致');
      }

      const cases = [];
      let hitsAt20 = 0;
      let reciprocalRankTotal = 0;
      for (const fixture of DENSE_EVALUATION_CASES) {
        const retrievedIds = await evaluationStore.denseEvaluationCandidateIds({
          generationId: generation.generationId,
          namespace,
          query: fixture.query,
          limit: 20,
        });
        const expectedId = expectedIds.get(fixture.id)!;
        const rankIndex = retrievedIds.indexOf(expectedId);
        const rank = rankIndex < 0 ? null : rankIndex + 1;
        const hitAt20 = rank !== null && rank <= 20;
        const reciprocalRank =
          rank !== null && rank <= 10 ? 1 / rank : 0;
        if (hitAt20) hitsAt20 += 1;
        reciprocalRankTotal += reciprocalRank;
        cases.push({
          caseId: fixture.id,
          expectedMemoryId: expectedId,
          retrievedMemoryIds: retrievedIds,
          rank,
          hitAt20,
          reciprocalRank,
        });
      }
      const queryCount = DENSE_EVALUATION_CASES.length;
      const recallAt20 = hitsAt20 / queryCount;
      const mrrAt10 = reciprocalRankTotal / queryCount;
      const completedAt = new Date().toISOString();
      const report: DenseIndexEvaluationReport = {
        evaluationId: `dense-evaluation:${randomUUID()}`,
        generationId: generation.generationId,
        modelId: generation.modelId,
        embeddingModel: generation.embeddingModel,
        generationKey: generation.generationKey,
        dimensions: generation.dimensions,
        datasetId: DENSE_EVALUATION_DATASET_ID,
        datasetSha256: DENSE_EVALUATION_DATASET_SHA256,
        evaluatorVersion: DENSE_EVALUATOR_VERSION,
        queryCount,
        recallAt20,
        mrrAt10,
        passed:
          recallAt20 >= DENSE_EVALUATION_RECALL_AT_20_MIN &&
          mrrAt10 >= DENSE_EVALUATION_MRR_AT_10_MIN,
        startedAt,
        completedAt,
        cases,
      };
      this.productionStore.recordDenseIndexEvaluation(
        report,
        input.userId,
      );
      if (!report.passed) {
        this.productionStore.failDenseIndexGeneration(
          generation.generationId,
          `固定评测未过门槛：Recall@20=${recallAt20.toFixed(4)}, ` +
          `MRR@10=${mrrAt10.toFixed(4)}`,
        );
        return { report, activated: false };
      }
      const alias = this.productionStore.denseIndexAlias(
        input.userId,
        input.namespace,
      );
      if (alias?.activeGenerationId === generation.generationId) {
        return { report, activated: true };
      }
      if (alias?.buildingGenerationId !== generation.generationId) {
        throw new Error('评测完成时目标已不再是 building generation');
      }
      await this.productionStore.activateDenseIndexGeneration({
        generationId: generation.generationId,
        expectedAliasRevision: alias.revision,
        evaluationId: report.evaluationId,
        userId: input.userId,
        namespace: input.namespace,
      });
      return { report, activated: true };
    } finally {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
