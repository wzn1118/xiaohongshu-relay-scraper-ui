import http from 'node:http';
import path from 'node:path';
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
import { DataCopilotRuntime } from './data-copilot-runtime.mjs';
import { DataCopilotService } from './data-copilot-service.mjs';

const diagnostics = createDiagnostics({ filePath: config.diagnosticsPath });

const aiSessions = new AiSessionStore({ filePath: config.aiConfigPath });
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
const localModels = new LocalModelManager();
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
const copilotRuntime = new DataCopilotRuntime({
  store: copilotStore,
  approvals: copilotApprovals,
  registry: copilotTools,
  aiSessions,
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
  manager,
  aiSessions,
});
await dataCopilot.initialize();
const dataLifecycle = new DataLifecycleService({
  manager,
  profileStore,
  audienceAi,
  retentionPath: config.dataRetentionPath,
  auditPath: config.deletionAuditPath,
});
await dataLifecycle.initialize();
const relaySupervisor = createRelaySupervisor({
  getConfig: () => relayConfig.get(),
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
const server = http.createServer(createApp({ manager, config, aiSessions, profileStore, relayConfig, smtpConfig, mailSender, localModels, relaySupervisor, dataLifecycle, diagnostics, audienceAiService: audienceAi, dataCopilotService: dataCopilot }));
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
  clearInterval(retentionTimer);
  relaySupervisor.stop();
  try {
    const shutdownErrors = [];
    try { await audienceAi.close(); } catch (error) { shutdownErrors.push(error); }
    try { await manager.shutdown(); } catch (error) { shutdownErrors.push(error); }
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
