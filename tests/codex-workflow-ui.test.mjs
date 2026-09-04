import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Codex workflow surface exposes review, diff, output, and guarded mutation states', async () => {
  const html = await readFile('public/codex/index.html', 'utf8');
  const script = await readFile('public/codex/app.js', 'utf8');
  assert.match(html, /workflow-panel/u);
  assert.match(html, /workflow-files/u);
  assert.match(html, /workflow-output/u);
  assert.match(html, /workflow-apply/u);
  assert.match(html, /workflow-rollback/u);
  assert.match(script, /workflowRequest\('snapshot'\)/u);
  assert.match(script, /workflowRequest\('diff'/u);
  assert.match(script, /window\.confirm/u);
  assert.match(script, /workflowCommandState\.textContent = failed \? '失败' : '有新输出'/u);
  assert.match(script, /threadId: activeThreadId/u);
  assert.match(script, /snapshotGeneration/u);
});
