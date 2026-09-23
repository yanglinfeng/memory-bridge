import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPredicateCardinality,
} from '../src/server/claim-relation-engine.js';

test('稳定画像谓词的 cardinality 优先于 14B 的 event 误标', () => {
  const singlePredicates = [
    '点单时的首选茶',
    '职业',
    '居住地',
    '工作日通勤方式',
    '通勤方式 [条件:工作日]',
    '回复组织方式',
    '常用编辑器',
  ];
  const setPredicates = [
    '饮食偏好',
    '饮食忌口',
    '推荐餐食规则',
    '长期学习目标',
    '与特定角色交流规则',
    '角色专属规则',
    '稳定生活习惯',
  ];

  for (const predicate of singlePredicates) {
    assert.equal(
      classifyPredicateCardinality('event', predicate),
      'single',
      predicate,
    );
  }
  for (const predicate of setPredicates) {
    assert.equal(
      classifyPredicateCardinality('event', predicate),
      'set',
      predicate,
    );
  }
});

test('未带稳定限定的一次性事件不会被画像规则吞掉', () => {
  for (const predicate of [
    '访问地点',
    '住宿地点',
    '完成的活动',
    '通勤方式',
  ]) {
    assert.equal(
      classifyPredicateCardinality('event', predicate),
      'event',
      predicate,
    );
  }
});
