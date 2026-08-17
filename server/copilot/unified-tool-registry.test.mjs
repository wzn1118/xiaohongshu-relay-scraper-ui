import assert from 'node:assert/strict';
import test from 'node:test';

import { UnifiedToolRegistry } from './unified-tool-registry.mjs';

function definition(name, risk = 'read') {
  return {
    name,
    description: `${name} description`,
    category: name.split('.')[0],
    risk,
    inputSchema: { type: 'object', properties: {} },
  };
}

test('combines data, workspace, MCP, and agent catalogs and routes each execution', async () => {
  const executions = [];
  const dataDefinitions = [definition('tool.search'), definition('tool.describe'), definition('records.query')];
  const workspaceDefinitions = [definition('workspace.read'), definition('exec.run', 'approval_required')];
  const mcpDefinition = { ...definition('mcp.github.search-code'), source: 'mcp', serverId: 'github' };
  const agentDefinition = definition('agent.delegate');
  const dataRegistry = {
    list: () => dataDefinitions,
    get: (name) => dataDefinitions.find((tool) => tool.name === name) || null,
    async execute(name, input) { executions.push(['data', name, input]); return { source: 'data' }; },
  };
  const workspaceAdapter = {
    list: () => workspaceDefinitions,
    get: (name) => workspaceDefinitions.find((tool) => tool.name === name) || null,
    async execute(name, input) { executions.push(['workspace', name, input]); return { source: 'workspace' }; },
  };
  let mcpContext = null;
  const mcpManager = {
    listTools: () => [mcpDefinition],
    getTool: (name) => name === mcpDefinition.name ? mcpDefinition : null,
    async execute(name, input, context) {
      mcpContext = context;
      executions.push(['mcp', name, input]);
      return { source: 'mcp' };
    },
    describe: () => ({ initialized: true, toolCount: 1 }),
  };
  const subagentAdapter = {
    list: () => [agentDefinition],
    get: (name) => name === agentDefinition.name ? agentDefinition : null,
    async execute(name, input, context) {
      executions.push(['agent', name, input, context.runId, context.toolRunId]);
      return { source: 'agent' };
    },
    describe: () => ({ enabled: true, toolCount: 1, maxDepth: 1 }),
  };
  const registry = new UnifiedToolRegistry({ dataRegistry, workspaceAdapter, mcpManager, subagentAdapter });

  assert.deepEqual(registry.describeCapabilities().sources, { data: 3, workspace: 2, git: 0, mcp: 1, agent: 1 });
  assert.equal(registry.describeCapabilities().subagents.maxDepth, 1);
  assert.equal(registry.get('exec.run').risk, 'approval_required');
  assert.equal(registry.search('MCP GitHub', { limit: 3 })[0].name, mcpDefinition.name);

  await registry.execute('records.query', { dataset: 'applications' });
  await registry.execute('workspace.read', { path: 'README.md' });
  await registry.execute(mcpDefinition.name, { query: 'runtime' }, {
    runId: 'run-unified-001',
    toolRunId: 'tool-unified-001',
    idempotencyKey: 'tool:unified:001',
    authorizationMode: 'automatic_owner',
    workspaceBinding: { projectId: 'project-001', workspaceId: 'workspace-001' },
  });
  await registry.execute(agentDefinition.name, { objective: 'Inspect the runtime.' }, { runId: 'parent-run', toolRunId: 'parent-tool' });
  assert.deepEqual(executions.map((entry) => entry[0]), ['data', 'workspace', 'mcp', 'agent']);
  assert.deepEqual(mcpContext, {
    runId: 'run-unified-001',
    toolRunId: 'tool-unified-001',
    idempotencyKey: 'tool:unified:001',
    authorizationMode: 'automatic_owner',
    workspaceBinding: { projectId: 'project-001', workspaceId: 'workspace-001' },
    signal: undefined,
    timeoutMs: undefined,
  });
  assert.deepEqual(executions.at(-1).slice(3), ['parent-run', 'parent-tool']);
});

test('optionally catalogs and routes a scoped Git adapter with the caller execution context', async () => {
  const gitTool = definition('git.status');
  const calls = [];
  const registry = new UnifiedToolRegistry({
    dataRegistry: {
      list: () => [definition('records.query')],
      get: () => null,
      async execute() { return { source: 'data' }; },
    },
    gitAdapter: {
      list: () => [gitTool],
      get: (name) => name === gitTool.name ? gitTool : null,
      async execute(name, input, context) {
        calls.push({ name, input, context });
        return { type: 'git.status.receipt', root: '.', dirty: false };
      },
    },
  });

  assert.deepEqual(registry.describeCapabilities().sources, { data: 1, workspace: 0, git: 1, mcp: 0, agent: 0 });
  assert.equal(registry.get('git.status').source, 'git');
  assert.equal(registry.search('Git status')[0].name, 'git.status');
  const context = { runId: 'git-run-001', toolRunId: 'git-tool-001', idempotencyKey: 'git:status:001' };
  const result = await registry.execute('git.status', { maxOutputBytes: 2_048 }, context);
  assert.equal(result.type, 'git.status.receipt');
  assert.deepEqual(calls, [{ name: 'git.status', input: { maxOutputBytes: 2_048 }, context }]);
});

test('catalog discovery activates tools from every adapter for later model rounds', async () => {
  const definitions = [definition('tool.search'), definition('tool.describe')];
  const dataRegistry = {
    list: () => definitions,
    get: (name) => definitions.find((tool) => tool.name === name) || null,
    async execute() { throw new Error('search should be handled by the unified registry'); },
  };
  const workspaceTool = definition('exec.run', 'approval_required');
  const registry = new UnifiedToolRegistry({
    dataRegistry,
    workspaceAdapter: {
      list: () => [workspaceTool],
      get: (name) => name === workspaceTool.name ? workspaceTool : null,
      async execute() { return {}; },
    },
  });
  const state = { activeToolNames: [] };
  const result = await registry.execute('tool.search', { query: 'run command', limit: 10 }, { state });

  assert.equal(result.type, 'tool.catalog');
  assert.ok(result.tools.some((tool) => tool.name === 'exec.run'));
  assert.ok(state.activeToolNames.includes('exec.run'));
});

test('rejects cross-source tool name conflicts before catalog metadata or execution can diverge', async () => {
  const dataTool = definition('records.query', 'read');
  const agentTool = definition('records.query', 'write');
  let executionSource = '';
  const registry = new UnifiedToolRegistry({
    dataRegistry: {
      list: () => [dataTool],
      get: (name) => name === dataTool.name ? dataTool : null,
      async execute() { executionSource = 'data'; return { source: 'data' }; },
    },
    subagentAdapter: {
      list: () => [agentTool],
      get: (name) => name === agentTool.name ? agentTool : null,
      async execute() { executionSource = 'agent'; return { source: 'agent' }; },
    },
  });

  const expected = {
    code: 'COPILOT_TOOL_NAME_CONFLICT',
    status: 409,
    message: 'Tool name "records.query" is registered by both data and agent.',
  };
  assert.throws(() => registry.list(), expected);
  assert.throws(() => registry.get('records.query'), expected);
  assert.throws(() => registry.search('records'), expected);
  assert.throws(() => registry.describe(['records.query']), expected);
  await assert.rejects(() => registry.execute('records.query'), expected);
  assert.equal(executionSource, '');
});
