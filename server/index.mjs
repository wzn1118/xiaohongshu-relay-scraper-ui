import http from 'node:http';
import { config } from './config.mjs';
import { createApp } from './app.mjs';
import { JobManager } from './job-manager.mjs';
import { AiSessionStore } from './ai-session-store.mjs';
import { ProfileStore } from './profile-store.mjs';
import { RelayConfigStore } from './relay-config-store.mjs';
import { createMailSender } from './mail-sender.mjs';

const aiSessions = new AiSessionStore();
const profileStore = new ProfileStore({
  root: config.profileDir,
  pythonBin: config.pythonBin,
  scriptPath: config.profileScriptPath,
});
const relayConfig = new RelayConfigStore({ filePath: config.relayConfigPath });
const mailSender = createMailSender(config.smtp);
await profileStore.initialize();
await relayConfig.initialize();
const manager = new JobManager({ ...config, aiSessions, profileStore });
await manager.initialize();

const server = http.createServer(createApp({ manager, config, aiSessions, profileStore, relayConfig, mailSender }));
server.listen(config.port, config.host, () => {
  console.log(`Xiaohongshu relay scraper API listening at http://${config.host}:${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing HTTP server.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
