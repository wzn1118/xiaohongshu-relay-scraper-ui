import http from 'node:http';
import { config } from './config.mjs';
import { createApp } from './app.mjs';
import { JobManager } from './job-manager.mjs';
import { AiSessionStore } from './ai-session-store.mjs';
import { ProfileStore } from './profile-store.mjs';
import { RelayConfigStore } from './relay-config-store.mjs';
import { SmtpConfigStore } from './smtp-config-store.mjs';
import { createMailSender } from './mail-sender.mjs';
import { LocalModelManager } from './local-model-manager.mjs';
import { DataLifecycleService } from './data-lifecycle-service.mjs';

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
const manager = new JobManager({ ...config, aiSessions, profileStore });
await manager.initialize();
const dataLifecycle = new DataLifecycleService({
  manager,
  profileStore,
  retentionPath: config.dataRetentionPath,
  auditPath: config.deletionAuditPath,
});
await dataLifecycle.initialize();

const server = http.createServer(createApp({ manager, config, aiSessions, profileStore, relayConfig, smtpConfig, mailSender, localModels, dataLifecycle }));
server.listen(config.port, config.host, () => {
  console.log(`Xiaohongshu relay scraper API listening at http://${config.host}:${config.port}`);
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
  console.log(`${signal} received; stopping active work before closing the HTTP server.`);
  const forcedExit = setTimeout(() => process.exit(1), 15000);
  forcedExit.unref();
  server.close();
  clearInterval(retentionTimer);
  try {
    await manager.shutdown();
    clearTimeout(forcedExit);
    process.exit(0);
  } catch (error) {
    console.error(`Graceful shutdown failed: ${error?.message || error}`);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
