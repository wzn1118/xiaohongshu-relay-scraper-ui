import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PASS = 'passed';
const WARNING = 'warning';
const BLOCKED = 'blocked';

export class PreflightService {
  constructor({
    config,
    aiSessions,
    profileStore,
    smtpConfig,
    relayRuntime,
    getRelayConfig,
    timeoutMs = 5_000,
    checks,
    operations = {},
  }) {
    this.config = config || {};
    this.aiSessions = aiSessions;
    this.profileStore = profileStore;
    this.smtpConfig = smtpConfig;
    this.relayRuntime = relayRuntime;
    this.getRelayConfig = getRelayConfig || (() => ({}));
    this.timeoutMs = timeoutMs;
    this.operations = operations;
    this.checks = checks || createDefaultChecks(this);
  }

  async run(params = {}) {
    const startedAt = Date.now();
    const context = { params, service: this };
    const checks = await Promise.all(this.checks.map((definition) => executeCheck(definition, context, this.timeoutMs)));
    const ready = !checks.some((item) => item.status === BLOCKED);
    return {
      schemaVersion: 1,
      kind: 'preflight',
      status: ready ? 'ready' : 'blocked',
      ready,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      checks,
    };
  }
}

export function createPreflightService(options) {
  return new PreflightService(options);
}

function createDefaultChecks(service) {
  return [
    {
      code: 'CHROME_RELAY',
      blocking: true,
      action: 'Start or reconnect the Chrome Relay and keep a signed-in target tab open.',
      run: async ({ params }) => {
        const relayConfig = service.getRelayConfig() || {};
        const port = normalizePort(params.relayPort, relayConfig.port);
        const profile = String(params.browserProfile || relayConfig.profile || 'openclaw').trim();
        const probe = service.operations.relayProbe
          ? await service.operations.relayProbe({ port, profile })
          : await service.relayRuntime.probe({ port, profile });
        const ready = Boolean(probe?.ready || (probe?.ok && probe?.running && probe?.cdpReady));
        return ready
          ? passed('Chrome Relay is ready.', { port, profile, tabs: Number(probe?.tabs ?? probe?.tabCount ?? 0), xiaohongshuTabs: Number(probe?.xiaohongshuTabs ?? 0) })
          : blocked('Chrome Relay is not ready.', safeErrorDetails(probe, { port, profile }));
      },
    },
    {
      code: 'AI_PROVIDER',
      blocking: true,
      action: 'Reconnect the AI provider so the server receives a valid session.',
      run: async ({ params }) => {
        if (params.useCodexRuntime === false) return passed('AI processing is disabled for this run.', { enabled: false });
        if (!params.aiSessionId) return blocked('No AI provider session is configured.', { errorCode: 'AI_SESSION_MISSING' });
        try {
          const session = service.operations.resolveAiSession
            ? await service.operations.resolveAiSession(params.aiSessionId)
            : service.aiSessions.resolve(params.aiSessionId);
          if (!String(session?.provider || '').trim()) return blocked('The AI provider configuration is incomplete.', { errorCode: 'AI_PROVIDER_MISSING' });
          return passed('AI provider session is available.', { provider: session.provider, sessionId: String(params.aiSessionId) });
        } catch (error) {
          return blocked('The AI provider session is unavailable or expired.', { errorCode: error?.code || 'AI_SESSION_UNAVAILABLE' });
        }
      },
    },
    {
      code: 'AI_MODEL',
      blocking: true,
      action: 'Select a model and verify its Base URL and wire API.',
      run: async ({ params }) => {
        if (params.useCodexRuntime === false) return passed('AI model validation is not required for this run.', { enabled: false });
        if (!params.aiSessionId) return blocked('No AI model configuration is available.', { errorCode: 'AI_SESSION_MISSING' });
        try {
          const session = service.operations.resolveAiSession
            ? await service.operations.resolveAiSession(params.aiSessionId)
            : service.aiSessions.resolve(params.aiSessionId);
          const model = String(session?.model || '').trim();
          const baseUrl = String(session?.baseUrl || '').trim();
          const wireApi = String(session?.wireApi || 'responses').trim();
          if (!model || !baseUrl || !['responses', 'chat_completions'].includes(wireApi)) {
            return blocked('The AI model configuration is incomplete.', { provider: session?.provider || '', hasModel: Boolean(model), hasBaseUrl: Boolean(baseUrl), wireApi });
          }
          return passed('AI model configuration is complete.', { provider: session.provider, model, baseUrl, wireApi });
        } catch (error) {
          return blocked('The AI model configuration cannot be resolved.', { errorCode: error?.code || 'AI_MODEL_UNAVAILABLE' });
        }
      },
    },
    {
      code: 'PROFILE',
      blocking: ({ params }) => params.analysisMode === 'job',
      action: 'Import a complete profile or fill in name, school, major, and email.',
      run: async ({ params }) => {
        const profile = await resolveProfile(service, params);
        const complete = profileIsComplete(profile, params.candidateProfile);
        if (complete) return passed('Profile data is complete.', profileSummary(profile, params.candidateProfile));
        if (params.analysisMode === 'job') return blocked('The job-analysis profile is missing or incomplete.', profileSummary(profile, params.candidateProfile));
        return warning('No complete profile is attached; content analysis can continue.', profileSummary(profile, params.candidateProfile));
      },
    },
    {
      code: 'SMTP',
      blocking: false,
      action: 'Configure and verify SMTP before using email delivery.',
      run: async () => {
        const value = service.operations.smtpStatus
          ? await service.operations.smtpStatus()
          : service.smtpConfig?.getPublic?.() || service.smtpConfig?.getForMailer?.() || {};
        const configured = smtpIsConfigured(value);
        const verified = value.verified ?? service.smtpConfig?.isVerified?.() ?? false;
        if (!configured) return warning('SMTP is not configured; collection can continue without email delivery.', { configured: false, verified: false });
        if (!verified) return warning('SMTP is configured but has not been verified; collection can continue.', { configured: true, verified: false, provider: value.provider || 'custom', host: value.host || '' });
        return passed('SMTP configuration is verified.', { configured: true, verified: true, provider: value.provider || 'custom', host: value.host || '' });
      },
    },
    {
      code: 'OUTPUT_DIRECTORY',
      blocking: true,
      action: 'Create the output directory and grant the server account access.',
      run: async () => {
        const outputDir = path.resolve(service.config.dataDir || path.join(process.cwd(), 'data', 'jobs'));
        if (service.operations.ensureOutputDirectory) await service.operations.ensureOutputDirectory(outputDir);
        else {
          await mkdir(outputDir, { recursive: true });
          const info = await stat(outputDir);
          if (!info.isDirectory()) throw new Error('Output path is not a directory.');
        }
        return passed('Output directory is available.', { outputDir });
      },
    },
    {
      code: 'FILE_WRITE_PERMISSION',
      blocking: true,
      action: 'Grant create and delete permission in the output directory.',
      run: async () => {
        const outputDir = path.resolve(service.config.dataDir || path.join(process.cwd(), 'data', 'jobs'));
        const marker = path.join(outputDir, `.preflight-${process.pid}-${randomUUID()}.tmp`);
        if (service.operations.testWritePermission) await service.operations.testWritePermission(outputDir);
        else {
          try {
            await writeFile(marker, 'preflight', { encoding: 'utf8', flag: 'wx' });
          } finally {
            await rm(marker, { force: true }).catch(() => {});
          }
        }
        return passed('Output directory is writable.', { outputDir });
      },
    },
    {
      code: 'RUNTIME_DEPENDENCIES',
      blocking: true,
      action: 'Restore Python and the checked-in workflow runner before starting a formal job.',
      timeoutMs: 10_000,
      run: async () => {
        const pythonBin = service.config.pythonBin || (process.platform === 'win32' ? 'python' : 'python3');
        const runnerPath = service.config.runnerPath;
        if (service.operations.checkRuntimeDependencies) {
          const details = await service.operations.checkRuntimeDependencies({ pythonBin, runnerPath });
          return passed('Runtime dependencies are available.', details || { pythonBin, runnerPath });
        }
        if (!runnerPath) throw Object.assign(new Error('Workflow runner path is not configured.'), { code: 'RUNNER_PATH_MISSING' });
        await access(runnerPath, fsConstants.R_OK);
        const result = await execFileAsync(pythonBin, ['--version'], { timeout: 7_500, windowsHide: true });
        return passed('Runtime dependencies are available.', { pythonBin, runnerPath, pythonVersion: String(result.stdout || result.stderr || '').trim() });
      },
    },
    {
      code: 'PORT_PROCESS_STATE',
      blocking: true,
      action: 'Resolve the port conflict or restart the Relay process on the configured port.',
      run: async ({ params }) => {
        const relayConfig = service.getRelayConfig() || {};
        const relayPort = normalizePort(params.relayPort, relayConfig.port);
        const apiPort = normalizePort(service.config.port, null);
        if (!relayPort) return blocked('The Relay port is invalid.', { apiPort, relayPort });
        if (apiPort && relayPort === apiPort) return blocked('The API and Relay ports must be different.', { apiPort, relayPort });
        const listening = service.operations.checkPort
          ? await service.operations.checkPort(relayPort)
          : await checkTcpPort(relayPort);
        return listening
          ? passed('Required ports and Relay process state are available.', { apiPort, relayPort, relayListening: true })
          : blocked('No Relay process is listening on the configured port.', { apiPort, relayPort, relayListening: false });
      },
    },
  ];
}

async function executeCheck(definition, context, defaultTimeoutMs) {
  const startedAt = Date.now();
  const blocking = typeof definition.blocking === 'function' ? Boolean(definition.blocking(context)) : Boolean(definition.blocking);
  const timeoutMs = Number(definition.timeoutMs || defaultTimeoutMs);
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => definition.run(context)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Check timed out after ${timeoutMs} ms.`), { code: 'PREFLIGHT_TIMEOUT' })), timeoutMs);
      }),
    ]);
    const status = normalizeStatus(value?.status, blocking);
    return {
      code: definition.code,
      status,
      blocking,
      message: String(value?.message || (status === PASS ? 'Check passed.' : 'Check needs attention.')),
      action: String(value?.action || definition.action || ''),
      details: sanitizeDetails(value?.details),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const timedOut = error?.code === 'PREFLIGHT_TIMEOUT';
    return {
      code: definition.code,
      status: blocking ? BLOCKED : WARNING,
      blocking,
      message: timedOut ? `Check timed out after ${timeoutMs} ms.` : `Check failed: ${String(error?.message || error)}`,
      action: String(definition.action || ''),
      details: { errorCode: error?.code || 'PREFLIGHT_CHECK_FAILED', timedOut },
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveProfile(service, params) {
  if (params.profileId) {
    try {
      return service.operations.getProfile
        ? await service.operations.getProfile(params.profileId)
        : await service.profileStore.get(params.profileId);
    } catch {
      return null;
    }
  }
  if (params.candidateProfile && Object.values(params.candidateProfile).some((value) => String(value || '').trim())) return null;
  const legacyPath = service.config.legacyProfilePath;
  if (!legacyPath) return null;
  try {
    const text = service.operations.readProfileFile
      ? await service.operations.readProfileFile(legacyPath)
      : await readFile(legacyPath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function profileIsComplete(profile, candidateProfile) {
  const candidate = candidateProfile || {};
  const formComplete = ['name', 'school', 'major', 'email'].every((key) => String(candidate[key] || '').trim());
  if (formComplete) return true;
  if (!profile || typeof profile !== 'object') return false;
  const identity = profile.candidate || profile.candidate_application || profile;
  const name = String(identity.name || profile.display_name || '').trim();
  const email = String(identity.email || identity.contact?.email || '').trim();
  const evidence = Array.isArray(profile.evidence_items) ? profile.evidence_items.length : Array.isArray(profile.experiences) ? profile.experiences.length : 0;
  return Boolean(name && (email || evidence > 0));
}

function profileSummary(profile, candidateProfile) {
  return {
    profileId: profile?.id || null,
    imported: Boolean(profile),
    candidateFieldsComplete: ['name', 'school', 'major', 'email'].every((key) => String(candidateProfile?.[key] || '').trim()),
  };
}

function smtpIsConfigured(value) {
  if (!value || typeof value !== 'object') return false;
  const auth = String(value.auth || 'auto').toLowerCase();
  const hasCredential = auth === 'none' || Boolean(value.hasPassword || value.pass || value.oauth?.hasRefreshToken || value.oauth?.refreshToken);
  return Boolean(String(value.host || '').trim() && String(value.from || '').trim() && hasCredential);
}

function normalizeStatus(status, blocking) {
  if (status === PASS || status === WARNING || status === BLOCKED) return status;
  return blocking ? BLOCKED : WARNING;
}

function passed(message, details = {}) {
  return { status: PASS, message, details };
}

function warning(message, details = {}) {
  return { status: WARNING, message, details };
}

function blocked(message, details = {}) {
  return { status: BLOCKED, message, details };
}

function safeErrorDetails(value, fallback) {
  return {
    ...fallback,
    errorCode: value?.error?.code || value?.code || 'RELAY_NOT_READY',
    running: Boolean(value?.running),
    cdpReady: Boolean(value?.cdpReady),
    authenticated: Boolean(value?.authenticated),
  };
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    if (/apiKey|password|pass|secret|token|credential/i.test(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) sanitized[key] = value;
  }
  return sanitized;
}

function normalizePort(value, fallback) {
  const port = Number(value ?? fallback);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function checkTcpPort(port, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
