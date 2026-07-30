import test from 'node:test';
import assert from 'node:assert/strict';
import { planRelayRecovery, relayTargetSummary } from './lib/relay-targets.mjs';

test('relay target summary marks overloaded mixed contexts for recovery', () => {
  const targets = [
    { id: 'search', type: 'page', url: 'https://www.xiaohongshu.com/search_result?keyword=test' },
    { id: 'detail', type: 'page', url: 'https://www.xiaohongshu.com/explore/note' },
    { id: 'other', type: 'page', url: 'https://www.douyin.com/search/test' },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `worker-${index}`, type: 'worker', url: 'https://example.test/worker.js' })),
  ];

  const summary = relayTargetSummary(targets);

  assert.equal(summary.pressure, 'high');
  assert.equal(summary.recoveryRecommended, true);
  assert.deepEqual(summary.pressureReasons.slice(0, 2), ['target_count', 'page_count']);
});

test('relay recovery plan replaces a pressured set and leaves workers to their parent pages', () => {
  const targets = [
    { id: 'search', type: 'page', url: 'https://www.xiaohongshu.com/search_result?keyword=test' },
    { id: 'detail', type: 'page', url: 'https://www.xiaohongshu.com/explore/note' },
    { id: 'other', type: 'page', url: 'https://www.douyin.com/search/test' },
    { id: 'worker', type: 'worker', url: 'https://example.test/worker.js' },
  ];

  const plan = planRelayRecovery(targets);

  assert.equal(plan.replaceWithFreshPage, true);
  assert.deepEqual(plan.closeTargets.map((target) => target.id), ['search', 'detail', 'other']);
});

test('relay recovery plan preserves the only healthy Xiaohongshu page', () => {
  const targets = [{ id: 'search', type: 'page', url: 'https://www.xiaohongshu.com/search_result?keyword=test' }];
  const plan = planRelayRecovery(targets);

  assert.equal(plan.replaceWithFreshPage, false);
  assert.equal(plan.keeper.id, 'search');
  assert.deepEqual(plan.closeTargets, []);
});

test('relay target summary allows one unrelated page beside the target page', () => {
  const targets = [
    { id: 'search', type: 'page', url: 'https://www.xiaohongshu.com/search_result?keyword=test' },
    { id: 'other', type: 'page', url: 'https://example.com/' },
  ];

  const summary = relayTargetSummary(targets);

  assert.equal(summary.pressure, 'normal');
  assert.equal(summary.recoveryRecommended, false);
  assert.deepEqual(summary.pressureReasons, []);
});
