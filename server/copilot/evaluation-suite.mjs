import crypto from 'node:crypto';

import { createReadOnlySandbox } from './sandbox.mjs';

const ROWS = Object.freeze([
  { id: 'a', group: 'east', value: 10, score: 0.8, label: 'alpha product' },
  { id: 'b', group: 'west', value: 30, score: 0.6, label: 'beta growth' },
  { id: 'c', group: 'east', value: 20, score: 0.9, label: 'alpha growth' },
  { id: 'd', group: 'north', value: null, score: 0.4, label: 'delta ops' },
]);

export function createGoldenTasks() {
  return [
    golden('profile-rows', 'profile', 'dataset.profile', { rows: ROWS }, (out) => out.rowCount === 4),
    golden('profile-columns', 'profile', 'dataset.profile', { rows: ROWS }, (out) => out.columns.length === 5),
    golden('profile-null-count', 'profile', 'dataset.profile', { rows: ROWS }, (out) => column(out, 'value')?.nullCount === 1),
    golden('profile-numeric-mean', 'profile', 'dataset.profile', { rows: ROWS }, (out) => near(column(out, 'value')?.mean, 20)),

    golden('sql-select-all', 'sql', 'sql.query', { rows: ROWS, sql: 'select * from data', table: 'data' }, (out) => out.rowCount === 4),
    golden('sql-project', 'sql', 'sql.query', { rows: ROWS, sql: 'select id, value from data', table: 'data' }, (out) => out.columns.join(',') === 'id,value'),
    golden('sql-filter', 'sql', 'sql.query', { rows: ROWS, sql: 'select * from data where value >= 20', table: 'data' }, (out) => out.rowCount === 2),
    golden('sql-order-limit', 'sql', 'sql.query', { rows: ROWS, sql: 'select * from data order by score desc limit 2', table: 'data' }, (out) => out.rows.map((row) => row.id).join(',') === 'c,a'),
    golden('sql-group-count', 'sql', 'sql.query', { rows: ROWS, sql: 'select count(*) as total from data group by group', table: 'data' }, (out) => out.rows.find((row) => row.group === 'east')?.total === 2),
    golden('sql-group-sum', 'sql', 'sql.query', { rows: ROWS, sql: 'select sum(value) as total from data group by group', table: 'data' }, (out) => out.rows.find((row) => row.group === 'east')?.total === 30),

    golden('aggregate-count', 'analysis', 'python.analyze', { rows: ROWS, operation: 'aggregate', groupBy: 'group' }, (out) => out.rows.find((row) => row.group === 'east')?.value === 2),
    golden('aggregate-sum', 'analysis', 'python.analyze', { rows: ROWS, operation: 'aggregate', aggregation: 'sum', groupBy: 'group', metric: 'value' }, (out) => out.rows.find((row) => row.group === 'east')?.value === 30),
    golden('aggregate-avg', 'analysis', 'python.analyze', { rows: ROWS, operation: 'aggregate', aggregation: 'avg', groupBy: 'group', metric: 'score' }, (out) => near(out.rows.find((row) => row.group === 'east')?.value, 0.85)),
    golden('analysis-profile', 'analysis', 'python.analyze', { rows: ROWS, operation: 'profile' }, (out) => out.rowCount === 4),
    golden('analysis-empty', 'analysis', 'python.analyze', { rows: [], operation: 'profile' }, (out) => out.rowCount === 0),

    golden('correlation-shape', 'statistics', 'python.analyze', { rows: ROWS, operation: 'correlation', columns: ['value', 'score'] }, (out) => out.matrix.length === 2),
    golden('correlation-diagonal', 'statistics', 'python.analyze', { rows: ROWS, operation: 'correlation', columns: ['value', 'score'] }, (out) => near(out.matrix[0][0], 1)),
    golden('correlation-symmetric', 'statistics', 'python.analyze', { rows: ROWS, operation: 'correlation', columns: ['value', 'score'] }, (out) => near(out.matrix[0][1], out.matrix[1][0])),

    golden('chart-bar', 'chart', 'chart.create', { rows: ROWS, type: 'bar', x: 'group', y: 'value' }, (out) => out.type === 'bar'),
    golden('chart-line', 'chart', 'chart.create', { rows: ROWS, type: 'line', x: 'id', y: 'score' }, (out) => out.type === 'line'),
    golden('chart-fallback', 'chart', 'chart.create', { rows: ROWS, type: 'unknown', x: 'id', y: 'value' }, (out) => out.type === 'bar'),
    golden('chart-bounded-data', 'chart', 'chart.create', { rows: Array.from({ length: 600 }, (_, index) => ({ x: index, y: index })), x: 'x', y: 'y' }, (out) => out.data.length === 500),

    golden('search-alpha', 'search', 'semantic.search', { items: ROWS, query: 'alpha', fields: ['label'] }, (out) => out.length === 2),
    golden('search-two-terms', 'search', 'semantic.search', { items: ROWS, query: 'alpha growth', fields: ['label'] }, (out) => out[0]?.item?.id === 'c'),
    golden('search-limit', 'search', 'semantic.search', { items: ROWS, query: 'growth', limit: 1 }, (out) => out.length === 1),
    golden('search-empty-query', 'search', 'semantic.search', { items: ROWS, query: '', limit: 3 }, (out) => out.length === 3),

    golden('report-heading', 'report', 'report.compose', { title: 'Golden report' }, (out) => out.blocks[0]?.kind === 'heading'),
    golden('report-sections', 'report', 'report.compose', { title: 'R', sections: [{ title: 'S', content: 'Body' }] }, (out) => out.blocks.some((block) => block.content === 'S')),
    golden('report-citation', 'report', 'report.compose', { title: 'R', evidence: [{ sourceId: 'source-1', label: 'Source' }] }, (out) => out.blocks.some((block) => block.kind === 'citation' && block.sourceRefs?.includes('source-1'))),
    golden('report-metadata', 'report', 'report.compose', { title: 'R', summary: 'Summary' }, (out) => out.metadata?.generatedBy === 'report.compose'),
  ];
}

export async function runGoldenEvaluation({ sandbox = createReadOnlySandbox(), now = () => new Date() } = {}) {
  const tasks = createGoldenTasks();
  const createdAt = now().toISOString();
  const startedAt = Date.now();
  const results = [];
  for (const task of tasks) {
    const taskStartedAt = Date.now();
    try {
      const output = await sandbox.execute(task.toolName, task.input);
      const passed = Boolean(task.score(output));
      results.push({ id: task.id, category: task.category, toolName: task.toolName, passed, durationMs: Date.now() - taskStartedAt, error: passed ? '' : 'Scorer assertion failed.' });
    } catch (error) {
      results.push({ id: task.id, category: task.category, toolName: task.toolName, passed: false, durationMs: Date.now() - taskStartedAt, error: String(error?.message || error) });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  const categories = Object.fromEntries([...new Set(results.map((result) => result.category))].map((category) => {
    const selected = results.filter((result) => result.category === category);
    const categoryPassed = selected.filter((result) => result.passed).length;
    return [category, { total: selected.length, passed: categoryPassed, passRate: categoryPassed / selected.length }];
  }));
  return {
    schemaVersion: 1,
    evaluationId: `golden-${crypto.randomUUID()}`,
    suite: 'data-copilot-golden-30',
    status: passed === tasks.length ? 'passed' : 'failed',
    createdAt,
    durationMs: Date.now() - startedAt,
    summary: { total: tasks.length, passed, failed: tasks.length - passed, passRate: passed / tasks.length },
    categories,
    results,
  };
}

function golden(id, category, toolName, input, score) { return { id, category, toolName, input, score }; }
function column(output, name) { return output.columns?.find((item) => item.name === name); }
function near(left, right) { return Math.abs(Number(left) - Number(right)) < 1e-9; }
