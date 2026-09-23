import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../src/server/index.ts', import.meta.url),
  'utf8',
);

test('生产入口把情景物化和层级摘要服务注入后台 Worker', () => {
  assert.match(
    source,
    /new EpisodicMemoryService\(database\)/u,
  );
  assert.match(
    source,
    /new HierarchicalSummaryService\([\s\S]*?database,[\s\S]*?store,[\s\S]*?consolidationProvider[\s\S]*?\)/u,
  );
  assert.match(
    source,
    /new MemoryWorker\([\s\S]*?reflectionService,[\s\S]*?episodicMemoryService,[\s\S]*?hierarchicalSummaryService[\s\S]*?\)/u,
  );
});
