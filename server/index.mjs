import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { createApp } from './app.mjs';
import { JobManager } from './job-manager.mjs';
import { AiSessionStore } from './ai-session-store.mjs';
import { ProfileStore } from './profile-store.mjs';
import { RelayConfigStore } from './relay-config-store.mjs';
import { SmtpConfigStore } from './smtp-config-store.mjs';
import { createMailSender } from './mail-sender.mjs';
import { LocalModelManager } from './local-model-manager.mjs';
import { createRelaySupervisor } from './lib/relay-supervisor.mjs';
import { DataLifecycleService } from './data-lifecycle-service.mjs';
import { createDiagnostics } from './lib/diagnostics.mjs';
import { AudienceAiService } from './audience-ai-service.mjs';
import { createAudienceAiProfileRunner } from './lib/audience-ai-profile-runner.mjs';
import { DataCopilotStore } from './data-copilot-store.mjs';
import { CopilotApprovalStore } from './copilot-approval-store.mjs';
import { CopilotArtifactService } from './copilot-artifact-service.mjs';
import { DataPolicyEngine } from './data-policy-engine.mjs';
import { DataToolRegistry } from './data-tool-registry.mjs';
import { McpDataAdapter } from './mcp-data-adapter.mjs';
import { McpAccessService } from './mcp-access-service.mjs';
import { createMcpHttpGateway } from './mcp-http-server.mjs';
import { DataCopilotRuntime } from './data-copilot-runtime.mjs';
import { DataCopilotService } from './data-copilot-service.mjs';
import { createCopilotProductionStore } from './copilot/production-store.mjs';
import { WorkspaceToolAdapter } from './copilot/workspace-tool-adapter.mjs';
import { GitToolAdapter } from './copilot/git-tool-adapter.mjs';
import { createMcpClientManager } from './copilot/mcp-client-manager.mjs';
import { createRunCoordinator } from './copilot/run-coordinator.mjs';
import { createModelGateway } from './copilot/model-gateway.mjs';
import { createModelRunBroker } from './copilot/model-run-broker.mjs';
import { createModelTurnLedger } from './copilot/model-turn-ledger.mjs';
import {
  createExecutionDispatcher,
  createExecutionHandlerRegistry,
  createExecutionWorkerSupervisor,
  createRuntimeV3Repository,
} from './copilot/runtime-v3/index.mjs';
import { createToolExecutionBroker } from './copilot/tool-execution-broker.mjs';
import { createSubagentRuntime } from './copilot/subagent-runtime.mjs';
import { createUnifiedToolRegistry } from './copilot/unified-tool-registry.mjs';
import { createProjectWorkspaceService } from './copilot/project-workspace-service.mjs';
import { createAuthStore } from './auth-store.mjs';

const diagnostics = createDiagnostics({ filePath: config.diagnosticsPath });
const authStore = createAuthStore({
  usersPath: config.authUsersPath,
  sessionSecretPath: config.authSessionSecretPath,
  required: config.authRequired,
  cookieName: config.authCookieName,
  secureCookie: config.authSecureCookie,
  sessionTtlSeconds: config.authSessionTtlSeconds,
});
await authStore.initialize({ bootstrapEmail: config.authBootstrapEmail, bootstrapPassword: config.authBootstrapPassword });

const aiSessions = new AiSessionStore({ filePath: config.aiConfigPath, localModelEndpoint: config.localModelEndpoint });
const profileStore = new ProfileStore({
  root: config.profileDir,
  pythonBin: config.pythonBin,
  scriptPath: config.profileScriptPath,
});
const relayConfig = new RelayConfigStore({ filePath: config.relayConfigPath });
const smtpConfig = new SmtpConfigStore({ filePath: config.smtpConfigPath, defaults: config.smtp });
await profileStore.initialize();
await aiSessions.initialize();
await relayConfig.initialize();
await smtpConfig.initialize();
const mailSender = createMailSender(smtpConfig.getForMailer());
const localModels = new LocalModelManager({ endpoint: config.localModelEndpoint });
const manager = new JobManager({ ...config, aiSessions, profileStore, diagnostics });
await manager.initialize();
diagnostics.record('state_initialization_completed', {
  migration: { component: 'jobs', status: 'completed', count: manager.list().length },
});
const audienceAi = new AudienceAiService({
  manager,
  aiSessions,
  config,
  profileEnricher: createAudienceAiProfileRunner({ manager, config, getRelayConfig: () => relayConfig.get() }),
});
await audienceAi.initialize();
const copilotRoot = path.dirname(config.dataDir);
const copilotProductionStore = createCopilotProductionStore({ rootDir: copilotRoot });
const copilotRuntimeV3Repository = createRuntimeV3Repository({ store: copilotProductionStore });
const copilotExecutionDispatcher = createExecutionDispatcher({
  repository: copilotRuntimeV3Repository,
  workerId: `copilot-api-${process.pid}-${randomUUID()}`,
  emit: (event) => diagnostics.record('copilot_execution_dispatcher_event', {
    executionId: event?.payload?.executionId || '',
    type: event?.type || '',
  }),
});
const copilotExecutionHandlers = createExecutionHandlerRegistry({
  dispatcher: copilotExecutionDispatcher,
});
const copilotStore = new DataCopilotStore({ rootDir: copilotRoot });
const copilotApprovals = new CopilotApprovalStore({ rootDir: copilotRoot });
const copilotArtifacts = new CopilotArtifactService({
  rootDir: copilotRoot,
  pythonCommands: [config.pythonBin],
});
const copilotPolicy = new DataPolicyEngine({ manager });
const copilotTools = new DataToolRegistry({
  manager,
  policy: copilotPolicy,
  artifactService: copilotArtifacts,
  mailSender,
});
const copilotWorkspace = new WorkspaceToolAdapter({
  workspaceRoot: config.copilotWorkspaceRoot || config.projectRoot,
  execTimeoutMs: config.copilotExecTimeoutMs,
  httpTimeoutMs: config.copilotHttpTimeoutMs,
  maxOutputBytes: config.copilotMaxOutputBytes,
});
const copilotGit = new GitToolAdapter({
  workspaceRoot: config.copilotWorkspaceRoot || config.projectRoot,
  maxOutputBytes: config.copilotMaxOutputBytes,
  timeoutMs: config.copilotExecTimeoutMs,
});
const copilotProjectWorkspaces = createProjectWorkspaceService({
  rootDir: copilotRoot,
  allowedRoots: [config.copilotWorkspaceRoot || config.projectRoot],
});
const copilotMcpClients = createMcpClientManager({
  configPath: config.copilotMcpConfigPath,
});
try {
  await copilotMcpClients.initialize();
} catch (error) {
  const detail = String(error?.message || error);
  diagnostics.record('copilot_mcp_initialization_failed', {
    status: 'degraded',
    error: detail,
  });
  console.error(`Outbound MCP initialization failed; continuing without external MCP tools: ${detail}`);
}
const copilotRunCoordinator = createRunCoordinator({ store: copilotProductionStore });
const copilotModelGateway = createModelGateway();
const copilotModelBroker = createModelRunBroker({ gateway: copilotModelGateway });
const copilotModelTurnLedger = createModelTurnLedger({
  repository: copilotRuntimeV3Repository,
});
let copilotRegistry = null;
const copilotSubagents = createSubagentRuntime({
  productionStore: copilotProductionStore,
  runCoordinator: copilotRunCoordinator,
  registryProvider: () => copilotRegistry,
  aiSessions,
  modelRunBroker: copilotModelBroker,
  approvalMode: config.copilotApprovalMode,
});
copilotRegistry = createUnifiedToolRegistry({
  dataRegistry: copilotTools,
  workspaceAdapter: copilotWorkspace,
  gitAdapter: copilotGit,
  mcpManager: copilotMcpClients,
  subagentAdapter: copilotSubagents,
});
const copilotToolBroker = createToolExecutionBroker({
  registry: copilotRegistry,
  repository: copilotRuntimeV3Repository,
  dispatcher: copilotExecutionDispatcher,
  handlerRegistry: copilotExecutionHandlers,
});
const recoveredQueuedToolExecutions = await copilotToolBroker.reconcileQueuedOrphans();
if (recoveredQueuedToolExecutions.length) {
  diagnostics.record('copilot_queued_tool_executions_reconciled', {
    count: recoveredQueuedToolExecutions.length,
  });
}
const copilotExecutionWorker = createExecutionWorkerSupervisor({
  dispatcher: copilotExecutionDispatcher,
  handlerRegistry: copilotExecutionHandlers,
  pollIntervalMs: 250,
  recoveryIntervalMs: 15_000,
  maxConcurrency: 4,
  scanLimit: 100,
  emit: (event) => diagnostics.record('copilot_execution_worker_event', {
    type: event?.type || '',
    activeExecutions: event?.payload?.activeExecutions || 0,
    error: String(event?.payload?.error || ''),
  }),
});
const copilotRuntime = new DataCopilotRuntime({
  store: copilotStore,
  approvals: copilotApprovals,
  registry: copilotRegistry,
  aiSessions,
  productionStore: copilotProductionStore,
  modelRunBroker: copilotModelBroker,
  modelTurnLedger: copilotModelTurnLedger,
  toolExecutionBroker: copilotToolBroker,
  approvalMode: config.copilotApprovalMode,
  autoExecuteToolNames: config.copilotApprovalMode === 'workspace_auto'
    ? ['workspace.write', 'workspace.patch', 'exec.run']
    : [],
});
const copilotMcp = new McpDataAdapter({
  policy: copilotPolicy,
  registry: copilotTools,
  artifacts: copilotArtifacts,
});
const dataCopilot = new DataCopilotService({
  rootDir: copilotRoot,
  store: copilotStore,
  approvals: copilotApprovals,
  artifacts: copilotArtifacts,
  runtime: copilotRuntime,
  policy: copilotPolicy,
  mcpAdapter: copilotMcp,
  capabilityRegistry: copilotRegistry,
  workspaceAdapter: copilotWorkspace,
  gitAdapter: copilotGit,
  projectWorkspaceService: copilotProjectWorkspaces,
  mcpClientManager: copilotMcpClients,
  manager,
  aiSessions,
  productionStore: copilotProductionStore,
  runtimeV3Repository: copilotRuntimeV3Repository,
  toolExecutionBroker: copilotToolBroker,
  runCoordinator: copilotRunCoordinator,
  subagentRuntime: copilotSubagents,
  modelGateway: copilotModelGateway,
  modelRunBroker: copilotModelBroker,
  executionWorkerSupervisor: copilotExecutionWorker,
});
await dataCopilot.initialize();
copilotExecutionWorker.start();
const mcpAccess = new McpAccessService({
  productionStore: copilotProductionStore,
  dataCopilotService: dataCopilot,
  adapter: copilotMcp,
  registry: copilotTools,
  approvals: copilotApprovals,
  tokenPepperPath: config.mcpTokenPepperPath,
  endpoint: `http://${config.mcpHost}:${config.mcpPort}/mcp`,
  limits: {
    maxOutputBytes: config.mcpMaxOutputBytes,
    toolTimeoutMs: config.mcpToolTimeoutMs,
    maxConcurrentToolsPerGrant: config.mcpMaxConcurrentToolsPerGrant,
    maxCallsPerMinute: config.mcpMaxCallsPerMinute,
  },
});
await mcpAccess.initialize();
const mcpGateway = createMcpHttpGateway({ accessService: mcpAccess, config, diagnostics });
const dataLifecycle = new DataLifecycleService({
  manager,
  profileStore,
  audienceAi,
  retentionPath: config.dataRetentionPath,
  auditPath: config.deletionAuditPath,
});
await dataLifecycle.initialize();
const getRelayConfig = () => {
  const relay = relayConfig.get();
  return { ...relay, autoConnect: config.relayAutoConnect && relay.autoConnect };
};
const relaySupervisor = createRelaySupervisor({
  getConfig: getRelayConfig,
  getActiveJob: () => manager.active,
  openClawConfigPath: config.openClawConfigPath,
  managedBrowserDataDir: config.managedBrowserDataDir,
  pythonBin: config.pythonBin,
  connectionCheckScriptPath: config.relayConnectionCheckScriptPath,
  monitorIntervalMs: config.relayMonitorIntervalMs,
  failureThreshold: config.relayFailureThreshold,
  recoveryCooldownMs: config.relayRecoveryCooldownMs,
  connectTimeoutMs: config.relayConnectTimeoutMs,
  playwrightTimeoutMs: config.relayPlaywrightTimeoutMs,
});
const server = http.createServer(createApp({ manager, config, aiSessions, profileStore, relayConfig, smtpConfig, mailSender, localModels, relaySupervisor, dataLifecycle, diagnostics, audienceAiService: audienceAi, dataCopilotService: dataCopilot, mcpAccessService: mcpAccess, authStore }));
const mcpServer = config.mcpEnabled ? http.createServer(mcpGateway.handler) : null;
mcpServer?.listen(config.mcpPort, config.mcpHost, () => {
  diagnostics.record('mcp_server_started', { status: 'ready', host: config.mcpHost, port: config.mcpPort });
  console.log(`MCP Streamable HTTP listening at http://${config.mcpHost}:${config.mcpPort}/mcp`);
});
server.listen(config.port, config.host, () => {
  diagnostics.record('server_started', { status: 'ready' });
  console.log(`Xiaohongshu relay scraper API listening at http://${config.host}:${config.port}`);
  relaySupervisor.start();
  void dataLifecycle.cleanupExpired({ dryRun: false }).catch((error) => {
    console.error(`Retention cleanup failed: ${error?.message || error}`);
  });
});

const retentionTimer = setInterval(() => {
  void dataLifecycle.cleanupExpired({ dryRun: false }).catch((error) => {
    console.error(`Retention cleanup failed: ${error?.message || error}`);
  });
}, 24 * 60 * 60 * 1000);
retentionTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  diagnostics.record('server_shutdown_requested', { stopReason: signal });
  console.log(`${signal} received; stopping active work before closing the HTTP server.`);
  const forcedExit = setTimeout(() => process.exit(1), 15000);
  forcedExit.unref();
  server.close();
  mcpServer?.close();
  clearInterval(retentionTimer);
  relaySupervisor.stop();
  try {
    const shutdownErrors = [];
    try { await copilotMcpClients.close(); } catch (error) { shutdownErrors.push(error); }
    try { await mcpGateway.close(); } catch (error) { shutdownErrors.push(error); }
    try { await audienceAi.close(); } catch (error) { shutdownErrors.push(error); }
    try { await manager.shutdown(); } catch (error) { shutdownErrors.push(error); }
    try { await copilotSubagents.close(); } catch (error) { shutdownErrors.push(error); }
    try { await dataCopilot.close(); } catch (error) { shutdownErrors.push(error); }
    try { await copilotExecutionWorker.close({ timeoutMs: 8_000 }); } catch (error) { shutdownErrors.push(error); }
    try { await copilotToolBroker.close({ timeoutMs: 8_000 }); } catch (error) { shutdownErrors.push(error); }
    try { copilotExecutionHandlers.close(); } catch (error) { shutdownErrors.push(error); }
    try { copilotExecutionDispatcher.close(); } catch (error) { shutdownErrors.push(error); }
    try { copilotProductionStore.close(); } catch (error) { shutdownErrors.push(error); }
    await diagnostics.flush();
    if (shutdownErrors.length) throw shutdownErrors[0];
    clearTimeout(forcedExit);
    process.exit(0);
  } catch (error) {
    console.error(`Graceful shutdown failed: ${error?.message || error}`);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
