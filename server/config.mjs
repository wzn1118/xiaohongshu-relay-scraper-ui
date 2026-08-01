import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const runnerPath =
  process.env.XHS_RUNNER_PATH ||
  path.resolve(serverDir, '..', 'scripts', 'run_project_workflow.py');
const audienceAiRunnerPath =
  process.env.XHS_AUDIENCE_AI_RUNNER_PATH ||
  path.resolve(serverDir, '..', 'scripts', 'run_audience_ai.py');
const audienceProfileSupplementPath = path.resolve(serverDir, '..', 'scripts', 'audience_profile_supplement.py');
const dataDir = path.resolve(process.env.XHS_SERVER_DATA_DIR || path.join(serverDir, '..', 'data', 'jobs'));
const smtpPort = readPort(process.env.SMTP_PORT, 587);
const smtpUser = String(process.env.SMTP_USER || '').trim();
const smtpPass = String(process.env.SMTP_PASS || '');
const smtpFrom = String(process.env.SMTP_FROM || smtpUser).trim();
const smtpAuth = String(process.env.SMTP_AUTH || 'auto').trim().toLowerCase();
const smtpOAuthTenant = normalizeMicrosoftTenant(process.env.SMTP_OAUTH_TENANT);

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: readPort(process.env.PORT, 4317),
  pythonBin: process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  runnerPath,
  runnerAvailable: existsSync(runnerPath),
  audienceAiEnabled: readBoolean(process.env.XHS_AUDIENCE_AI_ENABLED, false),
  audienceAiRunnerPath,
  audienceAiRunnerAvailable: existsSync(audienceAiRunnerPath),
  audienceAiMaxConcurrent: readInt(process.env.XHS_AUDIENCE_AI_MAX_CONCURRENT, 2, 1, 8),
  audienceProfileSupplementPath,
  staticDir: path.resolve(process.env.XHS_STATIC_DIR || path.join(serverDir, '..', 'dist')),
  projectRoot: path.resolve(serverDir, '..'),
  windowsPrerequisiteScriptPath: path.resolve(serverDir, '..', 'scripts', 'ensure-windows-prerequisites.ps1'),
  dataDir,
  managedBrowserDataDir: path.resolve(process.env.XHS_BROWSER_DATA_DIR || path.join(dataDir, '..', 'browser')),
  relayConfigPath: path.resolve(process.env.XHS_RELAY_CONFIG_PATH || path.join(dataDir, '..', 'relay-config.json')),
  aiConfigPath: path.resolve(process.env.XHS_AI_CONFIG_PATH || path.join(dataDir, '..', 'ai-config.json')),
  smtpConfigPath: path.resolve(process.env.XHS_SMTP_CONFIG_PATH || path.join(dataDir, '..', 'smtp-config.json')),
  dataRetentionPath: path.resolve(process.env.XHS_DATA_RETENTION_PATH || path.join(dataDir, '..', 'data-retention.json')),
  deletionAuditPath: path.resolve(process.env.XHS_DELETION_AUDIT_PATH || path.join(dataDir, '..', 'deletion-audit.jsonl')),
  diagnosticsPath: path.resolve(process.env.XHS_DIAGNOSTICS_PATH || path.join(dataDir, '..', 'diagnostics.jsonl')),
  profileDir: path.resolve(process.env.XHS_PROFILE_DATA_DIR || path.join(serverDir, '..', 'data', 'profiles')),
  profileScriptPath: path.resolve(serverDir, '..', 'scripts', 'profile_memory.py'),
  relayConnectionCheckScriptPath: path.resolve(serverDir, '..', 'scripts', 'check_relay_connection.py'),
  legacyProfilePath: path.resolve(serverDir, '..', 'profiles', 'candidate_profile.json'),
  smtp: Object.freeze({
    provider: String(process.env.SMTP_PROVIDER || '').trim(),
    host: String(process.env.SMTP_HOST || '').trim(),
    port: smtpPort,
    secure: readBoolean(process.env.SMTP_SECURE, smtpPort === 465),
    requireTls: readBoolean(process.env.SMTP_REQUIRE_TLS, smtpPort === 587),
    auth: ['auto', 'login', 'oauth2', 'none'].includes(smtpAuth) ? smtpAuth : 'auto',
    user: smtpUser,
    pass: smtpPass,
    from: smtpFrom,
    oauth: Object.freeze({
      tenant: smtpOAuthTenant,
      clientId: String(process.env.SMTP_OAUTH_CLIENT_ID || '').trim(),
      clientSecret: String(process.env.SMTP_OAUTH_CLIENT_SECRET || ''),
      refreshToken: String(process.env.SMTP_OAUTH_REFRESH_TOKEN || ''),
      scope: String(process.env.SMTP_OAUTH_SCOPE || 'https://outlook.office.com/SMTP.Send offline_access openid profile email').trim(),
    }),
  }),
  openClawConfigPath:
    process.env.OPENCLAW_CONFIG_PATH ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json'),
  maxBodyBytes: readInt(process.env.XHS_MAX_BODY_BYTES, 32 * 1024 * 1024, 1024, 64 * 1024 * 1024),
  relayMonitorIntervalMs: readInt(process.env.XHS_RELAY_MONITOR_INTERVAL_MS, 15_000, 2_000, 300_000),
  relayFailureThreshold: readInt(process.env.XHS_RELAY_FAILURE_THRESHOLD, 2, 1, 10),
  relayRecoveryCooldownMs: readInt(process.env.XHS_RELAY_RECOVERY_COOLDOWN_MS, 60_000, 5_000, 900_000),
  relayConnectTimeoutMs: readInt(process.env.XHS_RELAY_CONNECT_TIMEOUT_MS, 25_000, 1_000, 120_000),
  relayPlaywrightTimeoutMs: readInt(process.env.XHS_RELAY_PLAYWRIGHT_TIMEOUT_MS, 60_000, 1_000, 180_000),
});

function readPort(value, fallback) {
  return readInt(value, fallback, 1, 65535);
}

function readInt(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function readBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeMicrosoftTenant(value) {
  const tenant = String(value || 'organizations').trim();
  return /^[a-zA-Z0-9.-]+$/.test(tenant) ? tenant : 'organizations';
}
