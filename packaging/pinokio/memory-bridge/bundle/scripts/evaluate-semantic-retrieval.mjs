const fixtures = [
  {
    expected: false,
    memory: '会议室咖啡机需要维修。',
    query: '用户喝咖啡是否加糖？',
  },
  {
    expected: false,
    memory: '公司办公地址是北京朝阳区。',
    query: '用户的家庭住址是什么？',
  },
  {
    expected: false,
    memory: '招聘职位是后端工程师。',
    query: '用户当前的工作是什么？',
  },
  {
    expected: false,
    memory: '宠物禁止进入办公区。',
    query: '用户的宠物叫什么名字？',
  },
  {
    expected: false,
    memory: '演示数据保存在测试环境。',
    query: '首次启动应有什么数据？',
  },
  {
    expected: false,
    memory: '咖啡店甜点包含提拉米苏。',
    query: '用户最喜欢什么甜点？',
  },
  {
    expected: false,
    memory: 'Python 入门教程已归档。',
    query: '用户喜欢什么编程语言？',
  },
  {
    expected: false,
    memory: 'VS Code 插件市场发生故障。',
    query: '用户常用哪个 IDE？',
  },
  {
    expected: false,
    memory: '项目加入了中文翻译文件。',
    query: '用户偏好的回复语言是什么？',
  },
  {
    expected: true,
    memory: '出差时优先乘坐高铁。',
    query: '出行交通方式首选什么？',
  },
  {
    expected: true,
    memory: '每天早上九点开始办公。',
    query: '平时几点上班？',
  },
  {
    expected: true,
    memory: '对花生严重过敏。',
    query: '饮食要避开什么坚果？',
  },
  {
    expected: true,
    memory: '界面采用深色模式。',
    query: '外观偏好是否为夜间主题？',
  },
  {
    expected: true,
    memory: '用户住在上海浦东。',
    query: '当前居住城市是哪里？',
  },
  {
    expected: true,
    memory: '用户时区是 Asia/Shanghai。',
    query: '用户所在时区的 UTC 偏移如何计算？',
  },
  {
    expected: true,
    memory: '回复要简洁直接。',
    query: '回答应详细还是精炼？',
  },
  {
    expected: true,
    memory: '后端使用 Node.js 和 SQLite。',
    query: '服务采用什么技术栈？',
  },
  {
    expected: true,
    memory: '每周一下午三点召开例会。',
    query: '例会安排在什么时候？',
  },
];

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

const input = fixtures.flatMap((fixture) => [
  fixture.query,
  fixture.memory,
]);
const response = await fetch('http://127.0.0.1:11434/api/embed', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: process.env.MEMORY_BRIDGE_EMBED_MODEL || 'bge-m3:latest',
    input,
    keep_alive: '15m',
  }),
});
if (!response.ok) {
  throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
}
const payload = await response.json();
for (let index = 0; index < fixtures.length; index += 1) {
  const fixture = fixtures[index];
  const score = cosine(
    payload.embeddings[index * 2],
    payload.embeddings[index * 2 + 1],
  );
  console.log(JSON.stringify({
    stage: 'embedding',
    expected: fixture.expected,
    score: Number(score.toFixed(4)),
    query: fixture.query,
    memory: fixture.memory,
  }));
}

const rerankSystemPrompt = [
  '你是严格的长期记忆相关性审查器。',
  '判断每条 memory 是否包含能够直接回答 query 的用户事实或任务事实。',
  '仅共享主题或关键词不算相关；必须保持主体、对象、关系、属性、否定、时间范围和“事实/要求”模态一致。',
  '公司/招聘/教程/设备/文件/政策/测试环境等事实，不能冒充用户本人的偏好、身份、资料或产品要求。',
  '只有当 memory 单独作为可信前提时，query 的答案能够无须猜测地推出，才是 relevant=true。',
  '接触、拥有、学习或项目中出现某物，不等于用户偏好、身份、习惯或默认选择。',
  '描述某处已有数据，不等于规定首次启动应该有什么数据；翻译文件语言不等于用户回复语言。',
  '当 query 询问“应/应该/必须/要求”时，同一主体和阶段的明确规则、要求或禁止事项属于直接答案。',
  '答案可以是“无/空/不要”，不能因为没有列出具体对象就判为无关。',
  '允许同义改写和一步确定性推导；仅仅“可能”“暗示”“通常如此”必须判 false。',
  '如果 memory 提供了回答所缺的用户变量，而剩余步骤只是稳定公共知识的一步计算，也算 relevant。',
  'query 未限定场景时，可以召回带有更窄且不冲突场景的事实，并在答案中保留该场景；query 已明确场景时，不能用不同场景替代。',
  '“出行”本身不等于“日常通勤”，属于未限定场景；出差是出行的一种。',
  '校准示例：',
  'query=用户最喜欢哪种手机；memory=iPhone 维修手册已更新；relevant=false。',
  'query=用户做什么工作；memory=公司正在招聘会计；relevant=false。',
  'query=用户偏好哪种语言回复；memory=仓库新增日语本地化文件；relevant=false。',
  'query=应用初次启动有什么数据；memory=测试库保存了样例记录；relevant=false。',
  'query=应用初次启动应有什么数据；memory=产品首次启动必须保持空数据；relevant=true。',
  'query=平时怎么通勤；memory=上班优先骑自行车；relevant=true。',
  'query=回答应该多详细；memory=回复保持简短；relevant=true。',
  'query=出行交通方式首选什么；memory=出差时优先乘坐高铁；relevant=true。',
  'query=用户时区的 UTC 偏移是多少；memory=用户时区是 Asia/Shanghai；relevant=true。',
  '逐条返回，不得遗漏或增加 index。',
].join('');
const rerankFormat = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          relevant: { type: 'boolean' },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
          reason: { type: 'string' },
        },
        required: ['index', 'relevant', 'confidence', 'reason'],
      },
    },
  },
  required: ['results'],
};
const rerankResults = [];
const rerankBatchSize = Number(process.env.RERANK_BATCH_SIZE || 16);
for (let start = 0; start < fixtures.length; start += rerankBatchSize) {
  const batch = fixtures
    .slice(start, start + rerankBatchSize)
    .map((fixture, offset) => ({
      index: start + offset,
      query: fixture.query,
      memory: fixture.memory,
    }));
  const rerankResponse = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MEMORY_BRIDGE_RERANK_MODEL || 'qwen2.5:14b',
      stream: false,
      think: false,
      keep_alive: '15m',
      format: rerankFormat,
      options: {
        temperature: 0,
        seed: 42,
        num_predict: Math.max(512, batch.length * 128),
      },
      messages: [
        { role: 'system', content: rerankSystemPrompt },
        { role: 'user', content: JSON.stringify(batch) },
      ],
    }),
  });
  if (!rerankResponse.ok) {
    throw new Error(
      `Ollama rerank failed: ${rerankResponse.status} ${await rerankResponse.text()}`,
    );
  }
  const rerankPayload = await rerankResponse.json();
  const parsed = JSON.parse(rerankPayload.message.content);
  rerankResults.push(...parsed.results);
}
let rerankFailures = 0;
for (const result of rerankResults) {
  const fixture = fixtures[result.index];
  const passed = result.relevant === fixture.expected;
  if (!passed) rerankFailures += 1;
  console.log(JSON.stringify({
    stage: 'rerank',
    passed,
    expected: fixture.expected,
    ...result,
    query: fixture.query,
    memory: fixture.memory,
  }));
}
if (rerankFailures > 0) {
  process.exitCode = 1;
}
