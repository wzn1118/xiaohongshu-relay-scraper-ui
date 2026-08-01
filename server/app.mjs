import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { assertPathInside, enumerateArtifacts, resolveDownload } from './lib/artifacts.mjs';
import { ValidationError, validateRunRequest } from './lib/contracts.mjs';
import { probeRelay } from './lib/relay.mjs';
import { connectRelay, openRelayLogin } from './lib/relay-connect.mjs';
import { setupRelayRuntime } from './lib/relay-setup.mjs';
import { recoverRelay } from './lib/relay-recovery.mjs';
import { createRelaySupervisor } from './lib/relay-supervisor.mjs';
import { isIncompleteApplicationRecord, isIncompleteGeneralRecord } from './lib/application-records.mjs';
import { readAudienceResults } from './lib/audience-results.mjs';
import {
  bindDraftQuality,
  currentDraftVersion,
  hashDraftContent,
  migrateDraftStore,
  normalizeDraftContent,
  publicDraftMetadata,
  resolveDraftForSend,
  saveDraftVersion,
} from './lib/draft-store.mjs';
import { createDraftQualityChecker } from './lib/draft-quality-checker.mjs';
import { normalizeDiagnosticRoute } from './lib/diagnostics.mjs';
import { DEFAULT_RELAY_CONFIG } from './relay-config-store.mjs';
import { createPreflightService } from './preflight-service.mjs';

export { isIncompleteApplicationRecord, isIncompleteGeneralRecord } from './lib/application-records.mjs';

const JOB_ID = /^[0-9]{14}-[a-f0-9]{8}$/;
const RESUME_SCOPES = new Set(['full', 'discovery', 'body_completion', 'analysis', 'audience', 'artifacts']);
const ACTIVE_JOB_STATUSES = new Set(['queued', 'resuming', 'running']);
const NOTE_ID = /^[\p{L}\p{N}_.:-]{1,160}$/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i;
const MEDIA_CACHE_MAX_BYTES = 15 * 1024 * 1024;
const MEDIA_CACHE_TIMEOUT_MS = 15_000;
const APPLICATION_RECORD_INDEX = Symbol('applicationRecordIndex');
const APPLICATION_ARTIFACT_FILENAME = Symbol('applicationArtifactFilename');
const deliveryStateLocks = new Map();
const CONTENT_RESEARCH_LABELS = Object.freeze({
  auto: 'AI 自动识别',
  experience: '经验攻略',
  people: '人群与风格',
  trend: '趋势观察',
  product: '产品口碑',
  place: '地点清单',
  custom: '自定义研究',
});

export function createApp({ manager, config, aiSessions, profileStore, relayConfig, smtpConfig, mailSender, localModels, relayConnector = connectRelay, relayLoginOpener = openRelayLogin, relaySetup = setupRelayRuntime, relayRecoverer = recoverRelay, relaySupervisor, preflightService, dataLifecycle, mediaFetcher = globalThis.fetch, draftQualityChecker, deliveryStateWriter = writeDeliveryState, sendAuditAppender = appendSendAuditJournal, sendAuditReader = readSendAuditJournal, diagnostics }) {
  const getRelayConfig = () => relayConfig?.get?.() || { ...DEFAULT_RELAY_CONFIG };
  const relayRuntime = relaySupervisor || createRelaySupervisor({
    getConfig: getRelayConfig,
    getActiveJob: () => manager.active,
    openClawConfigPath: config.openClawConfigPath,
    managedBrowserDataDir: config.managedBrowserDataDir,
    pythonBin: config.pythonBin,
    connectionCheckScriptPath: config.relayConnectionCheckScriptPath,
    relayConnector,
    relayRecoverer,
    monitorIntervalMs: config.relayMonitorIntervalMs,
    failureThreshold: config.relayFailureThreshold,
    recoveryCooldownMs: config.relayRecoveryCooldownMs,
    connectTimeoutMs: config.relayConnectTimeoutMs,
    playwrightTimeoutMs: config.relayPlaywrightTimeoutMs,
  });
  const readiness = preflightService || createPreflightService({
    config,
    aiSessions,
    profileStore,
    smtpConfig,
    relayRuntime: {
      probe: ({ port }) => probeRelay({ port, openClawConfigPath: config.openClawConfigPath }),
    },
    getRelayConfig,
  });
  const mediaDownloads = new Map();
  const checkDraftQuality = draftQualityChecker || createDraftQualityChecker({
    pythonBin: config.pythonBin || (process.platform === 'win32' ? 'python' : 'python3'),
    scriptPath: path.join(config.projectRoot || process.cwd(), 'scripts', 'recheck_application_draft.py'),
  });
  const deliveryMailer = mailSender || {
    status: () => ({ configured: false, from: '' }),
    configure: () => ({ configured: false, from: '' }),
    verify: async () => {
      const error = new Error('请先配置 SMTP 邮件发送。');
      error.code = 'MAIL_NOT_CONFIGURED';
      throw error;
    },
    send: async () => {
      const error = new Error('请先配置 SMTP 邮件发送。');
      error.code = 'MAIL_NOT_CONFIGURED';
      throw error;
    },
  };
  let smtpOperationTail = Promise.resolve();
  const withSmtpOperationLock = (operation) => {
    const current = smtpOperationTail.catch(() => {}).then(operation);
    smtpOperationTail = current.catch(() => {});
    return current;
  };
  return async function app(req, res) {
    const requestStartedAt = performance.now();
    const requestId = diagnostics?.requestId?.(req.headers['x-request-id']);
    if (requestId) res.setHeader('X-Request-Id', requestId);
    setSecurityHeaders(res);
    if (req.method === 'OPTIONS') return noContent(res);
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    res.once('finish', () => diagnostics?.record?.('http_request_completed', {
      requestId,
      method: req.method,
      route: normalizeDiagnosticRoute(url.pathname),
      statusCode: res.statusCode,
      durationMs: performance.now() - requestStartedAt,
    }));
    try {
      if (req.method === 'GET' && url.pathname === '/api/diagnostics/bundle') {
        if (!diagnostics?.bundle) return json(res, 503, errorBody('DIAGNOSTICS_UNAVAILABLE', 'Diagnostics are unavailable.'));
        return json(res, 200, diagnostics.bundle());
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          service: 'xiaohongshu-relay-scraper',
          version: '3.0.0',
          runnerAvailable: config.runnerAvailable,
          timestamp: new Date().toISOString(),
          pid: process.pid,
          host: config.host,
          port: config.port,
          activeJob: manager.active?.id || null,
          emailDelivery: deliveryMailer.status(),
          relaySupervisor: relayRuntime.snapshot(),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/relay/config') {
        return json(res, 200, getRelayConfig());
      }
      if (req.method === 'PUT' && url.pathname === '/api/relay/config') {
        if (!relayConfig?.update) return json(res, 503, errorBody('RELAY_CONFIG_UNAVAILABLE', 'Relay configuration storage is unavailable.'));
        const body = await readJsonBody(req, config.maxBodyBytes);
        return json(res, 200, await relayConfig.update(body));
      }
      if (req.method === 'GET' && url.pathname === '/api/email/config') {
        return json(res, 200, publicSmtpConfig(smtpConfig, deliveryMailer));
      }
      if (req.method === 'PUT' && url.pathname === '/api/email/config') {
        if (!smtpConfig?.update || !smtpConfig?.getForMailer) {
          return json(res, 503, errorBody('SMTP_CONFIG_UNAVAILABLE', 'SMTP configuration storage is unavailable.'));
        }
        const body = await readJsonBody(req, config.maxBodyBytes);
        return json(res, 200, await withSmtpOperationLock(async () => {
          await smtpConfig.update(body);
          deliveryMailer.configure(smtpConfig.getForMailer());
          return publicSmtpConfig(smtpConfig, deliveryMailer);
        }));
      }
      if (req.method === 'DELETE' && url.pathname === '/api/email/config') {
        if (!smtpConfig?.clear || !smtpConfig?.getForMailer) {
          return json(res, 503, errorBody('SMTP_CONFIG_UNAVAILABLE', 'SMTP configuration storage is unavailable.'));
        }
        return json(res, 200, await withSmtpOperationLock(async () => {
          await smtpConfig.clear();
          deliveryMailer.configure(smtpConfig.getForMailer());
          return publicSmtpConfig(smtpConfig, deliveryMailer);
        }));
      }
      if (req.method === 'POST' && url.pathname === '/api/email/test') {
        return json(res, 200, await withSmtpOperationLock(async () => {
          const verificationSnapshot = smtpConfig?.getVerificationSnapshot?.();
          try {
            const status = await deliveryMailer.verify();
            const saved = await smtpConfig?.markVerified?.(verificationSnapshot);
            return { ok: true, ...status, lastVerifiedAt: saved?.lastVerifiedAt || new Date().toISOString() };
          } catch (error) {
            await smtpConfig?.markVerificationFailed?.(
              verificationSnapshot,
              String(error?.code || 'SMTP_VERIFICATION_FAILED'),
            ).catch(() => {});
            throw error;
          }
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/relay/status') {
        const configured = getRelayConfig();
        const requested = url.searchParams.get('port');
        const port = requested === null ? configured.port : Number(requested);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, errorBody('INVALID_PORT', 'Invalid relay port.'));
        const status = await relayRuntime.probe({ port });
        return json(res, 200, status);
      }
      if (req.method === 'POST' && url.pathname === '/api/relay/connect') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const configured = getRelayConfig();
        const requested = body?.port;
        const port = requested === undefined ? configured.port : Number(requested);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, errorBody('INVALID_PORT', 'Invalid relay port.'));
        const status = await relayRuntime.connect({ port, profile: body?.profile || configured.profile });
        return json(res, 200, status);
      }
      if (req.method === 'POST' && url.pathname === '/api/relay/recover') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const configured = getRelayConfig();
        const requested = body?.port;
        const port = requested === undefined ? configured.port : Number(requested);
        const profile = String(body?.profile || configured.profile || 'openclaw').trim();
        if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, errorBody('INVALID_PORT', 'Invalid relay port.'));
        if (!/^[\p{L}\p{N}_.-]+$/u.test(profile)) return json(res, 400, errorBody('INVALID_PROFILE', 'Invalid browser profile.'));
        const recovery = await relayRuntime.recover({ port, profile, reason: 'manual' });
        return json(res, recovery.ok ? 200 : 503, recovery);
      }
      if (req.method === 'POST' && url.pathname === '/api/relay/setup') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const configured = getRelayConfig();
        const requested = body?.port;
        const port = requested === undefined ? configured.port : Number(requested);
        const profile = String(body?.profile || configured.profile || 'openclaw').trim();
        if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, errorBody('INVALID_PORT', 'Invalid relay port.'));
        if (!/^[\p{L}\p{N}_.-]+$/u.test(profile)) return json(res, 400, errorBody('INVALID_PROFILE', 'Invalid browser profile.'));
        const setup = await relaySetup({
          projectRoot: config.projectRoot,
          scriptPath: config.windowsPrerequisiteScriptPath,
          relayPort: port,
          profile,
          browserDataDir: config.managedBrowserDataDir,
        });
        if (!setup.ok) return json(res, 503, { ...setup, ready: false, port, profile });
        const status = await relayRuntime.connect({ port, profile });
        return json(res, status.ready ? 200 : 503, { ...status, ...setup, setup, port, profile });
      }
      if (req.method === 'POST' && url.pathname === '/api/relay/login') {
        const configured = getRelayConfig();
        const body = await readJsonBody(req, config.maxBodyBytes);
        const profile = String(body?.profile || configured.profile || 'openclaw').trim();
        const urlToOpen = String(body?.url || 'https://www.xiaohongshu.com').trim();
        if (!/^[\p{L}\p{N}_.-]+$/u.test(profile)) {
          return json(res, 400, errorBody('INVALID_PROFILE', 'Invalid browser profile.'));
        }
        if (!/^https:\/\/www\.xiaohongshu\.com(?:\/|$)/i.test(urlToOpen)) {
          return json(res, 400, errorBody('INVALID_LOGIN_URL', 'Login URL must be on the target website.'));
        }
        const connection = await relayRuntime.connect({ port: Number(configured.port), profile });
        if (!connection.ready && !(connection.running && connection.cdpReady)) {
          return json(res, 503, { ...connection, opened: false, profile, url: urlToOpen });
        }
        const opened = await relayLoginOpener({
          port: Number(configured.port),
          openClawConfigPath: config.openClawConfigPath,
          profile,
          url: urlToOpen,
        });
        return json(res, opened.opened ? 200 : 503, { ...connection, ...opened, profile, url: urlToOpen });
      }
      if (req.method === 'GET' && url.pathname === '/api/ai/providers') return json(res, 200, aiSessions.providers());
      if (req.method === 'GET' && url.pathname === '/api/ai/local-models') {
        if (!localModels?.status) return json(res, 503, errorBody('LOCAL_MODEL_UNAVAILABLE', 'Local model management is unavailable.'));
        return json(res, 200, await localModels.status());
      }
      if (req.method === 'POST' && url.pathname === '/api/ai/local-models/install') {
        if (!localModels?.startInstall) return json(res, 503, errorBody('LOCAL_MODEL_UNAVAILABLE', 'Local model management is unavailable.'));
        const body = await readJsonBody(req, config.maxBodyBytes);
        return json(res, 202, await localModels.startInstall(body.modelId));
      }
      if (req.method === 'POST' && url.pathname === '/api/ai/models') {
        return json(res, 200, await aiSessions.discoverModels(await readJsonBody(req, config.maxBodyBytes)));
      }
      if (req.method === 'POST' && url.pathname === '/api/ai/sessions') {
        return json(res, 201, await aiSessions.create(await readJsonBody(req, config.maxBodyBytes)));
      }
      if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'ai' && parts[2] === 'sessions' && parts[3]) {
        return json(res, aiSessions.delete(parts[3]) ? 200 : 404, { deleted: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/profiles') return json(res, 200, await profileStore.list());
      if (req.method === 'POST' && url.pathname === '/api/profiles/import') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const session = aiSessions.resolve(body.aiSessionId);
        return json(res, 201, await profileStore.create(body, session));
      }
      if (url.pathname.startsWith('/api/data/') && !dataLifecycle) {
        return json(res, 503, errorBody('DATA_LIFECYCLE_UNAVAILABLE', 'Local data lifecycle management is unavailable.'));
      }
      if (req.method === 'GET' && url.pathname === '/api/data/ownership') {
        return json(res, 200, dataLifecycle.ownership());
      }
      if (req.method === 'POST' && url.pathname === '/api/data/deletions/preview') {
        return json(res, 200, await dataLifecycle.preview(await readJsonBody(req, config.maxBodyBytes)));
      }
      if (req.method === 'POST' && url.pathname === '/api/data/deletions/execute') {
        return json(res, 200, await dataLifecycle.execute(await readJsonBody(req, config.maxBodyBytes)));
      }
      if (req.method === 'GET' && url.pathname === '/api/data/retention') {
        return json(res, 200, dataLifecycle.getRetention());
      }
      if (req.method === 'PUT' && url.pathname === '/api/data/retention') {
        return json(res, 200, await dataLifecycle.updateRetention(await readJsonBody(req, config.maxBodyBytes)));
      }
      if (req.method === 'POST' && url.pathname === '/api/data/retention/cleanup') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        return json(res, 200, await dataLifecycle.cleanupExpired({ dryRun: body.dryRun !== false }));
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, manager.list());
      if (req.method === 'POST' && url.pathname === '/api/preflight') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new ValidationError('Request body must be a JSON object.');
        }
        const { idempotencyKey: _ignoredIdempotencyKey, ...runBody } = body;
        const params = validateRunRequest({ ...runBody, checkOnly: true });
        return json(res, 200, await readiness.run(params));
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new ValidationError('Request body must be a JSON object.');
        }
        const { idempotencyKey, ...runBody } = body;
        const params = validateRunRequest(runBody);
        if (params.checkOnly) return json(res, 200, await readiness.run(params));
        const resumeScope = legacyResumeScope(params);
        const resumeCheckpointJobIds = params.resumeFromJobId && ['audience', 'full'].includes(resumeScope)
          ? (await resolveAudienceResumeOwner(manager, params.resumeFromJobId)).readThroughJobIds
          : [];
        if (!params.resumeFromJobId) {
          const preflight = await readiness.run(params);
          if (!preflight.ready) {
            const expiredAiSession = preflight.checks.find((item) => item.code === 'AI_PROVIDER' && item.details?.errorCode === 'AI_SESSION_EXPIRED');
            const code = expiredAiSession ? 'AI_SESSION_EXPIRED' : 'PREFLIGHT_BLOCKED';
            const message = expiredAiSession
              ? 'AI session is missing or expired. Configure the provider again.'
              : 'Formal job creation was blocked by preflight checks.';
            return json(res, 409, { ...errorBody(code, message), preflight });
          }
        }
        const job = params.resumeFromJobId
          ? await manager.resume(params.resumeFromJobId, {
              scope: resumeScope,
              params,
              aiSessionId: params.aiSessionId,
              idempotencyKey,
              requestedBy: 'legacy_jobs_api',
              ...(resumeCheckpointJobIds.length ? { resumeCheckpointJobIds } : {}),
            })
          : await manager.start(params);
        return json(res, 202, job);
      }
      if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
        const id = parts[2];
        if (!JOB_ID.test(id)) return json(res, 404, errorBody('NOT_FOUND', 'Task not found.'));
        const internal = manager.getInternal(id);
        if (!internal) return json(res, 404, errorBody('NOT_FOUND', 'Task not found.'));
        if (req.method === 'GET' && parts.length === 3) return json(res, 200, manager.get(id));
        if (req.method === 'POST' && parts[3] === 'resume' && parts.length === 4) {
          const options = validateResumeRequest(await readJsonBody(req, config.maxBodyBytes));
          const resumeCheckpointJobIds = ['audience', 'full'].includes(options.scope)
            ? (await resolveAudienceResumeOwner(manager, id)).readThroughJobIds
            : [];
          const job = await manager.resume(id, {
            ...options,
            requestedBy: options.requestedBy || 'resume_api',
            ...(resumeCheckpointJobIds.length ? { resumeCheckpointJobIds } : {}),
          });
          return json(res, 202, job);
        }
        if (req.method === 'POST' && parts[3] === 'complete-missing' && parts.length === 4) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new ValidationError('Request body must be a JSON object.');
          }
          const unsupported = Object.keys(body).filter((key) => !['aiSessionId', 'idempotencyKey'].includes(key));
          if (unsupported.length) {
            throw new ValidationError('Unsupported completion parameters.', unsupported.map((field) => ({ field, reason: 'not_allowed' })));
          }

          const sourceJob = manager.get(id);
          if (sourceJob && ACTIVE_JOB_STATUSES.has(sourceJob.status)) {
            return json(res, 200, {
              action: 'attached',
              sourceJobId: id,
              incompleteBefore: null,
              job: sourceJob,
              message: 'The original task is already running.',
            });
          }

          const sourceParams = internal.params || internal.config || sourceJob?.config || {};
          const analysisMode = sourceParams.analysisMode === 'general' ? 'general' : 'job';
          const currentResults = await readApplicationResults(
            internal.outputDir,
            new URLSearchParams({ analysisMode, offset: '0', limit: '1', sort: 'newest', timeRange: 'all' }),
            internal,
          );
          if (!currentResults.available) {
            const error = new Error('The source task does not have structured results to complete yet.');
            error.code = 'COMPLETION_SOURCE_UNAVAILABLE';
            throw error;
          }
          const incompleteBefore = Number(currentResults.filters?.stats?.incomplete || 0);
          if (incompleteBefore === 0) {
            return json(res, 200, {
              action: 'already_complete',
              sourceJobId: id,
              incompleteBefore: 0,
              job: sourceJob,
              message: 'All records are already complete.',
            });
          }

          const params = validateRunRequest({
            ...sourceParams,
            analysisMode,
            searchSort: 'latest',
            maxAgeDays: 0,
            limit: 0,
            mode: 'resume',
            resumeFromJobId: id,
            completeMissingOnly: true,
            checkOnly: false,
            ...(Object.hasOwn(body, 'aiSessionId') ? { aiSessionId: body.aiSessionId } : {}),
          });
          const job = await manager.resume(id, {
            scope: 'body_completion',
            params,
            aiSessionId: Object.hasOwn(body, 'aiSessionId') ? body.aiSessionId : undefined,
            idempotencyKey: body.idempotencyKey,
            requestedBy: 'complete_missing_api',
          });
          return json(res, 202, {
            action: 'started',
            sourceJobId: id,
            incompleteBefore,
            job,
            message: `Started completion for ${incompleteBefore} incomplete records.`,
          });
        }
        if (req.method === 'POST' && parts[3] === 'cancel' && parts.length === 4) {
          const result = await manager.cancel(id);
          return json(res, 202, { ...result.job, cancelRequested: result.changed });
        }
        if (req.method === 'GET' && parts[3] === 'events' && parts.length === 4) return streamEvents(req, res, manager, id);
        if (req.method === 'GET' && parts[3] === 'logs' && parts.length === 4) {
          const maxBytes = 256 * 1024;
          try {
            const content = await readFile(internal.logPath, 'utf8');
            return json(res, 200, { log: content.slice(-maxBytes), truncated: content.length > maxBytes });
          } catch (error) {
            if (error.code === 'ENOENT') return json(res, 200, { log: '', truncated: false });
            throw error;
          }
        }
        if (req.method === 'GET' && parts[3] === 'results' && parts.length === 4) {
          return json(res, 200, await readApplicationResults(internal.outputDir, url.searchParams, internal));
        }
        if (req.method === 'GET' && parts[3] === 'media' && parts.length === 4) {
          return await serveCachedMedia(res, {
            outputDir: internal.outputDir,
            sourceUrl: url.searchParams.get('url'),
            mediaFetcher,
            mediaDownloads,
          });
        }
        if (req.method === 'GET' && parts[3] === 'audience' && parts.length === 4) {
          return json(res, 200, await readAudienceSnapshot(manager, id, url.searchParams));
        }
        if (req.method === 'POST' && parts[3] === 'audience' && parts[4] === 'resume' && parts.length === 5) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const resumeOptions = validateResumeRequest({ ...body, scope: 'audience' }, { fixedScope: 'audience' });
          const {
            sourceJobId,
            stateOwnerJobId,
            readThroughJobIds: resumeCheckpointJobIds,
          } = await resolveAudienceResumeOwner(manager, id);
          const sourceInternal = manager.getInternal(sourceJobId);
          const sourceJob = manager.get(sourceJobId);
          const requestedJob = manager.get(id);
          if (!sourceInternal || !sourceJob || !requestedJob) {
            const error = new Error('Audience collection source task was not found.');
            error.code = 'RESUME_SOURCE_NOT_FOUND';
            throw error;
          }
          if (ACTIVE_JOB_STATUSES.has(requestedJob.status)) {
            return json(res, 200, {
              action: 'attached',
              sourceJobId,
              checkpointJobId: id,
              stateOwnerJobId,
              job: requestedJob,
              message: 'The original task is already running.',
            });
          }
          const current = await readAudienceSnapshot(
            manager,
            id,
            new URLSearchParams({ limit: '1' }),
          );
          if (current.summary.status === 'complete') {
            return json(res, 200, {
              action: 'already_complete',
              sourceJobId,
              checkpointJobId: id,
              stateOwnerJobId,
              job: requestedJob,
              message: 'All comments and public audience profiles are already complete.',
            });
          }
          const sourceParams = sourceInternal.params || sourceInternal.config || sourceJob.config || {};
          const params = validateRunRequest({
            ...sourceParams,
            analysisMode: 'general',
            searchSort: 'latest',
            maxAgeDays: 0,
            limit: 0,
            mode: 'resume',
            resumeFromJobId: sourceJobId,
            completeMissingOnly: false,
            collectAudience: true,
            audienceOnly: true,
            checkOnly: false,
            securityVerificationTimeoutSeconds: 86400,
            aiSessionId: null,
            profileId: null,
          });
          const job = await manager.resume(id, {
            ...resumeOptions,
            params,
            requestedBy: resumeOptions.requestedBy || 'audience_resume_api',
            resumeCheckpointJobIds,
          });
          return json(res, 202, {
            action: 'started',
            sourceJobId,
            checkpointJobId: id,
            stateOwnerJobId,
            readThroughJobIds: resumeCheckpointJobIds,
            job,
            message: 'Audience collection resumed in the original task from the saved checkpoint.',
          });
        }
        if (req.method === 'POST' && parts[3] === 'delivery' && parts.length === 4) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          return json(res, 200, await updateDeliveryState(internal.outputDir, body));
        }
        if (req.method === 'POST' && parts[3] === 'draft' && parts.length === 4) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          return json(res, 200, await updateApplicationDraft(internal.outputDir, body, deliveryStateWriter));
        }
        if (req.method === 'POST' && parts[3] === 'draft' && parts[4] === 'quality' && parts.length === 5) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const ai = resolveDraftAiRuntime(aiSessions, internal, body);
          return json(res, 200, await recheckApplicationDraft(
            internal.outputDir,
            body,
            checkDraftQuality,
            ai,
            internal.params?.candidateProfile,
            deliveryStateWriter,
          ));
        }
        if (req.method === 'POST' && parts[3] === 'send-email' && parts.length === 4) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const replyTo = String(internal.params?.candidateProfile?.email || '').trim();
          return json(res, 200, await withSmtpOperationLock(() => sendApplicationEmail(
            internal.outputDir,
            body,
            deliveryMailer,
            replyTo,
            smtpConfig,
            {
              writeState: deliveryStateWriter,
              appendAudit: sendAuditAppender,
              readAudit: sendAuditReader,
            },
          )));
        }
        if (req.method === 'GET' && parts[3] === 'artifacts' && parts.length === 4) {
          return json(res, 200, await enumerateArtifacts(internal.outputDir));
        }
        if (req.method === 'GET' && parts[3] === 'artifacts' && parts[4] && parts.length === 5) {
          const file = await resolveDownload(internal.outputDir, parts[4]);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': file.size,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.relative))}`,
          });
          return createReadStream(file.absolute).pipe(res);
        }
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, errorBody('NOT_FOUND', 'Endpoint not found.'));
      if ((req.method === 'GET' || req.method === 'HEAD') && await serveSpa(req, res, config.staticDir, url.pathname)) return;
      return json(res, 404, errorBody('NOT_FOUND', 'Endpoint not found.'));
    } catch (error) {
      diagnostics?.record?.('http_request_failed', {
        level: 'error',
        requestId,
        method: req.method,
        route: normalizeDiagnosticRoute(url.pathname),
        errorCode: error?.code || error?.name || 'INTERNAL_ERROR',
        durationMs: performance.now() - requestStartedAt,
      });
      if (error instanceof ValidationError) return json(res, 400, errorBody('VALIDATION_ERROR', error.message, error.details));
      if (error.code === 'DRAFT_VERSION_CONFLICT') {
        return json(res, 409, {
          ...errorBody(error.code, error.message),
          expectedVersion: error.expectedVersion ?? null,
          currentVersion: error.currentVersion ?? null,
        });
      }
      if (String(error.code || '').startsWith('DRAFT_')) return json(res, 400, errorBody(error.code, error.message));
      if (error.code === 'JOB_BUSY') return json(res, 409, { ...errorBody('JOB_BUSY', error.message), activeJob: error.activeJob });
      if (error.code === 'JOB_NOT_FOUND') return json(res, 404, errorBody(error.code, error.message));
      if (['ARTIFACT_NOT_FOUND', 'DRAFT_NOT_FOUND'].includes(error.code)) return json(res, 404, errorBody(error.code, error.message));
      if (['DELETION_BLOCKED', 'DELETION_PLAN_CHANGED', 'JOB_STOP_TIMEOUT', 'JOB_RESOURCES_BUSY', 'JOB_ACTIVE_RETENTION'].includes(error.code)) {
        return json(res, 409, { ...errorBody(error.code, error.message), ...(error.plan ? { plan: error.plan } : {}) });
      }
      if (String(error.code || '').startsWith('DELETION_') || error.code === 'CLEAR_ALL_CONFIRMATION_REQUIRED' || error.code === 'RETENTION_CONFIG_INVALID') {
        return json(res, 400, errorBody(error.code, error.message));
      }
      if ([
        'JOB_ALREADY_RUNNING',
        'JOB_ALREADY_COMPLETED',
        'JOB_ATTEMPT_ACTIVE',
        'JOB_DELETION_IN_PROGRESS',
        'JOB_NOT_RESUMABLE',
        'RESUME_CONTEXT_UNAVAILABLE',
        'RESUME_OUTPUT_MISSING',
        'WORKFLOW_STATE_INVALID',
        'WORKFLOW_REVISION_CONFLICT',
        'JOB_RECOVERY_INCOMPLETE',
        'AI_SESSION_UNAVAILABLE',
        'PROFILE_UNAVAILABLE',
      ].includes(error.code)) {
        return json(res, 409, {
          ...errorBody(error.code, error.message),
          ...(error.activeJob ? { activeJob: error.activeJob } : {}),
          ...(error.attemptId ? { attemptId: error.attemptId } : {}),
        });
      }
      if (error.code === 'RESUME_SOURCE_NOT_FOUND' || error.code === 'RESUME_CHECKPOINTS_MISSING' || error.code === 'RESUME_SCOPE_INVALID' || error.code === 'IDEMPOTENCY_KEY_INVALID') {
        return json(res, 400, errorBody(error.code, error.message));
      }
      if (error.code === 'COMPLETION_SOURCE_UNAVAILABLE') return json(res, 409, errorBody(error.code, error.message));
      if (error.code === 'MEDIA_SOURCE_INVALID') return json(res, 400, errorBody(error.code, error.message));
      if (error.code === 'MEDIA_SOURCE_UNAVAILABLE') return json(res, 502, errorBody(error.code, error.message));
      if (error.code === 'BODY_TOO_LARGE') return json(res, 413, errorBody('BODY_TOO_LARGE', 'Request body is too large.'));
      if (['AI_VALIDATION', 'AI_SESSION_EXPIRED', 'PROFILE_VALIDATION', 'RELAY_CONFIG_VALIDATION', 'SMTP_CONFIG_VALIDATION'].includes(error.code)) return json(res, 400, errorBody(error.code, error.message));
      if (error.code === 'AI_MODEL_DISCOVERY_FAILED') return json(res, 502, errorBody(error.code, error.message));
      if (error.code === 'LOCAL_MODEL_VALIDATION') return json(res, 400, errorBody(error.code, error.message));
      if (error.code === 'LOCAL_MODEL_BUSY') return json(res, 409, { ...errorBody(error.code, error.message), install: error.install });
      if (error.code === 'LOCAL_MODEL_RUNTIME_UNAVAILABLE') return json(res, 503, errorBody(error.code, error.message));
      if (error.code === 'PROFILE_NOT_FOUND') return json(res, 404, errorBody(error.code, error.message));
      if (error.code === 'PROFILE_IMPORT_FAILED') return json(res, 422, errorBody(error.code, error.message));
      if (['MAIL_NOT_CONFIGURED', 'SMTP_NOT_CONFIGURED'].includes(error.code)) return json(res, 503, errorBody(error.code, error.message));
      if (error.code === 'SMTP_CONFIG_CONFLICT') {
        return json(res, 409, {
          ...errorBody(error.code, error.message),
          currentRevision: error.currentRevision ?? null,
        });
      }
      if (['SMTP_NOT_VERIFIED', 'SMTP_VERIFICATION_EXPIRED', 'EMAIL_IDEMPOTENCY_CONFLICT'].includes(error.code)) {
        return json(res, 409, errorBody(error.code, error.message));
      }
      if (error.code === 'SMTP_RATE_LIMITED') return json(res, 429, errorBody(error.code, error.message));
      if (['SMTP_SENDER_REJECTED', 'SMTP_RECIPIENT_REJECTED'].includes(error.code)) {
        return json(res, 422, errorBody(error.code, error.message));
      }
      if ([
        'SMTP_AUTH_FAILED',
        'SMTP_DNS_FAILED',
        'SMTP_CONNECTION_TIMEOUT',
        'SMTP_TLS_FAILED',
        'SMTP_VERIFICATION_FAILED',
        'SMTP_SEND_FAILED',
      ].includes(error.code)) return json(res, 502, errorBody(error.code, error.message));
      if (error.code === 'MAIL_CONNECTION_FAILED') return json(res, 502, errorBody(error.code, error.message));
      if (error.code === 'MAIL_SEND_FAILED') return json(res, 502, errorBody(error.code, error.message));
      if (error.code === 'AI_QUALITY_CHECK_FAILED') return json(res, 502, errorBody(error.code, error.message));
      if (error.code === 'EMAIL_SEND_STATUS_UNKNOWN') return json(res, 409, errorBody(error.code, error.message));
      if (['EMAIL_DELIVERED_AUDIT_STATE_PENDING', 'EMAIL_DELIVERED_AUDIT_UNCERTAIN'].includes(error.code)) {
        return json(res, 500, errorBody(error.code, error.message));
      }
      if (error instanceof SyntaxError) return json(res, 400, errorBody('INVALID_JSON', 'Request body must contain valid JSON.'));
      if (error.code === 'ENOENT' || /artifact/i.test(error.message) || /Path escapes/.test(error.message)) {
        return json(res, 404, errorBody('ARTIFACT_NOT_FOUND', 'Artifact not found.'));
      }
      console.error(error);
      return json(res, 500, errorBody('INTERNAL_ERROR', 'Unexpected server error.'));
    }
  };
}

function legacyResumeScope(params) {
  if (params.audienceOnly) return 'audience';
  if (params.completeMissingOnly) return 'body_completion';
  return 'full';
}

function validateResumeRequest(body, { fixedScope } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  const allowed = new Set(['scope', 'aiSessionId', 'idempotencyKey']);
  const unsupported = Object.keys(body).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    throw new ValidationError('Unsupported resume parameters.', unsupported.map((field) => ({ field, reason: 'not_allowed' })));
  }
  const scope = fixedScope || body.scope || 'full';
  if (typeof scope !== 'string' || !RESUME_SCOPES.has(scope)) {
    const error = new Error(`Unsupported resume scope: ${String(scope)}`);
    error.code = 'RESUME_SCOPE_INVALID';
    throw error;
  }
  if (Object.hasOwn(body, 'aiSessionId') && body.aiSessionId !== null && typeof body.aiSessionId !== 'string') {
    throw new ValidationError('aiSessionId must be a string or null.', [{ field: 'aiSessionId', reason: 'invalid_type' }]);
  }
  if (Object.hasOwn(body, 'idempotencyKey')) {
    if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) {
      throw new ValidationError('idempotencyKey must be a non-empty string of at most 200 characters.', [{ field: 'idempotencyKey', reason: 'invalid' }]);
    }
  }
  return {
    scope,
    ...(Object.hasOwn(body, 'aiSessionId') ? { aiSessionId: body.aiSessionId } : {}),
    ...(Object.hasOwn(body, 'idempotencyKey') ? { idempotencyKey: body.idempotencyKey.trim() } : {}),
  };
}

function toGeneralContentRecord(record) {
  return {
    note_id: record.note_id,
    title: record.title,
    note_url: record.note_url,
    body: record.body,
    access_status: record.access_status,
    collected_at: record.collected_at,
    publish_time: record.publish_time,
    media: record.media,
    ...(record.content_analysis ? { content_analysis: record.content_analysis } : {}),
    quality: record.quality || {},
  };
}

function contentResearchContext(payload, task) {
  const stored = payload?.content_research && typeof payload.content_research === 'object'
    ? payload.content_research
    : {};
  const presetCandidate = String(stored.preset || task.params?.contentPreset || task.config?.contentPreset || 'auto');
  const preset = Object.hasOwn(CONTENT_RESEARCH_LABELS, presetCandidate) ? presetCandidate : 'auto';
  const goal = String(stored.goal || task.params?.contentGoal || task.config?.contentGoal || '').trim().slice(0, 500);
  return {
    preset,
    label: String(stored.label || CONTENT_RESEARCH_LABELS[preset]),
    goal,
  };
}

async function readAudienceSnapshot(manager, jobId, searchParams) {
  const lineage = audienceJobLineage(manager, jobId);
  const current = manager.getInternal(jobId);
  if (!current) {
    const error = new Error('Audience checkpoint task was not found.');
    error.code = 'RESUME_SOURCE_NOT_FOUND';
    throw error;
  }
  const sourceJobId = lineage.at(-1) || jobId;
  const readableCheckpoints = audienceHistoryJobIds(manager, sourceJobId, jobId)
    .map((id) => ({ id, outputDir: manager.getInternal(id)?.outputDir }))
    .filter((item) => item.outputDir);
  const primary = readableCheckpoints.at(-1) || { id: jobId, outputDir: current.outputDir };
  const fallbackOutputDirs = readableCheckpoints
    .slice(0, -1)
    .map((item) => item.outputDir);
  const result = await readAudienceResults(primary.outputDir, searchParams, { fallbackOutputDirs });
  const localized = localizeAudienceAvatars(result, jobId);
  return {
    ...localized,
    sourceJobId,
    checkpointJobId: jobId,
    readThroughJobIds: lineage,
    mergedCheckpointJobIds: readableCheckpoints.map((item) => item.id),
  };
}

async function bestAudienceCheckpointJobId(manager, sourceJobId) {
  const allCandidates = audienceHistoryJobIds(manager, sourceJobId)
    .map((id) => ({ id, job: manager.get(id), internal: manager.getInternal(id) }))
    .filter(({ internal }) => Boolean(internal));
  const activeCandidate = allCandidates
    .filter(({ job }) => ACTIVE_JOB_STATUSES.has(job?.status))
    .at(-1);
  if (activeCandidate) return activeCandidate.id;
  const candidates = allCandidates
    .filter(({ id, internal }) => (
      internal
      && !internal.resumeCheckpointsPending
      && (id === sourceJobId || !ACTIVE_JOB_STATUSES.has(internal.status))
    ));
  const inspected = await Promise.all(candidates.map(async (candidate, order) => ({
    ...candidate,
    order,
    progress: await inspectAudienceCheckpoint(candidate.internal.outputDir),
  })));
  const eligible = inspected.filter(({ id, progress }) => (
    progress.hasResumeBase
    && (id === sourceJobId || progress.hasAudienceData)
  ));
  let best = eligible.find((candidate) => candidate.id === sourceJobId) || null;
  for (const candidate of eligible) {
    if (!best || compareAudienceProgress(candidate, best) >= 0) best = candidate;
  }
  return best?.id || sourceJobId;
}

async function resolveAudienceResumeOwner(manager, requestedJobId) {
  const sourceJobId = audienceContentSourceJobId(manager, requestedJobId);
  const stateOwnerJobId = await bestAudienceCheckpointJobId(manager, sourceJobId);
  return {
    sourceJobId,
    stateOwnerJobId,
    readThroughJobIds: audienceHistoryJobIds(manager, sourceJobId, requestedJobId),
  };
}

function audienceHistoryJobIds(manager, sourceJobId, requestedJobId = sourceJobId) {
  const ordered = [sourceJobId];
  const seen = new Set(ordered);
  const oldestFirst = [...manager.list()].reverse();
  for (const job of oldestFirst) {
    if (!job.config?.audienceOnly) continue;
    if (audienceContentSourceJobId(manager, job.id) !== sourceJobId) continue;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    ordered.push(job.id);
  }
  for (const id of audienceJobLineage(manager, requestedJobId).reverse()) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

async function inspectAudienceCheckpoint(outputDir) {
  const [cards, notes, posts, comments, users, summary] = await Promise.all([
    readCheckpointJson(path.join(outputDir, 'xiaohongshu_cards_latest.json'), []),
    readCheckpointJson(path.join(outputDir, 'xiaohongshu_notes_latest.json'), []),
    readCheckpointJson(path.join(outputDir, 'audience-posts.json'), []),
    readCheckpointJson(path.join(outputDir, 'audience-comments.json'), []),
    readCheckpointJson(path.join(outputDir, 'audience-users.json'), []),
    readCheckpointJson(path.join(outputDir, 'audience-summary.json'), {}),
  ]);
  const postItems = Array.isArray(posts.value) ? posts.value.filter(isRecord) : [];
  const commentItems = Array.isArray(comments.value) ? comments.value.filter(isRecord) : [];
  const userItems = Array.isArray(users.value) ? users.value.filter(isRecord) : [];
  const completePosts = postItems.filter((post) => post.status === 'complete').length;
  const partialPosts = postItems.filter((post) => (
    ['partial', 'failed'].includes(post.status)
    || Number(post.collected_comment_count || 0) > 0
    || Boolean(post.last_collected_at || post.failure_reason)
  )).length;
  const summaryValue = isRecord(summary.value) ? summary.value : {};
  const reportedComments = nonNegativeCount(summaryValue.commentsCollected);
  const reportedUsers = nonNegativeCount(summaryValue.usersDiscovered);
  const reportedCompletePosts = nonNegativeCount(summaryValue.postsComplete);
  const reportedPartialPosts = nonNegativeCount(summaryValue.postsPartial);
  const reportedPosts = nonNegativeCount(summaryValue.postsTotal);
  return {
    hasResumeBase: cards.exists && notes.exists && Array.isArray(cards.value) && Array.isArray(notes.value),
    hasAudienceData: postItems.length > 0 || commentItems.length > 0 || userItems.length > 0,
    score: [
      commentItems.length + userItems.length,
      commentItems.length,
      userItems.length,
      (completePosts * 2) + partialPosts,
      postItems.length,
      reportedComments + reportedUsers,
      (reportedCompletePosts * 2) + reportedPartialPosts,
      reportedPosts,
    ],
  };
}

function compareAudienceProgress(left, right) {
  for (let index = 0; index < left.progress.score.length; index += 1) {
    const difference = left.progress.score[index] - right.progress.score[index];
    if (difference !== 0) return difference;
  }
  return left.order - right.order;
}

async function readCheckpointJson(filePath, fallback) {
  try {
    return { exists: true, value: JSON.parse(await readFile(filePath, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { exists: false, value: fallback };
    throw error;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function audienceContentSourceJobId(manager, jobId) {
  return audienceJobLineage(manager, jobId).at(-1) || jobId;
}

function audienceJobLineage(manager, jobId) {
  const lineage = [];
  const visited = new Set();
  let currentId = jobId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    lineage.push(currentId);
    const current = manager.getInternal(currentId);
    if (!current?.params?.audienceOnly || !current.params.resumeFromJobId) break;
    currentId = current.params.resumeFromJobId;
  }
  return lineage;
}

async function readApplicationResults(outputDir, searchParams, task = {}) {
  const offset = boundedInteger(searchParams.get('offset'), 0, 0, 1000000);
  const limit = boundedInteger(searchParams.get('limit'), 50, 1, 100);
  const requestedAnalysisMode = ['job', 'general'].includes(searchParams.get('analysisMode'))
    ? searchParams.get('analysisMode')
    : null;
  const query = String(searchParams.get('query') || '').trim().toLocaleLowerCase('zh-CN').slice(0, 100);
  const sort = searchParams.get('sort') === 'oldest' ? 'oldest' : 'newest';
  const requestedTimeRange = String(searchParams.get('timeRange') || 'all');
  const timeRange = ['all', '1', '3', '7', '30', '90', 'unknown'].includes(requestedTimeRange) ? requestedTimeRange : 'all';
  try {
    const payload = await readLatestApplicationPayload(outputDir);
    const storedAnalysisMode = ['job', 'general'].includes(payload.analysis_mode) ? payload.analysis_mode : null;
    const analysisMode = requestedAnalysisMode || storedAnalysisMode || 'job';
    const incompleteRecord = analysisMode === 'general' ? isIncompleteGeneralRecord : isIncompleteApplicationRecord;
    const delivery = await readDeliveryState(outputDir);
    const legacyMedia = await readLegacyMediaSources(outputDir);
    const hydratedSource = Array.isArray(payload.records)
      ? payload.records.map((record, recordIndex) => mergeApplicationState(
        hydrateApplicationMedia(record, legacyMedia.get(record.note_id)),
        delivery[record.note_id],
        recordIndex,
        payload[APPLICATION_ARTIFACT_FILENAME],
      )).map((record) => localizeApplicationMedia(record, task.id))
      : [];
    const source = analysisMode === 'general'
      ? hydratedSource.map(toGeneralContentRecord)
      : hydratedSource;
    const queried = query
      ? source.filter((record) => `${record.title || ''}\n${record.body || ''}`.toLocaleLowerCase('zh-CN').includes(query))
      : source;
    const filterStats = {
      all: queried.length,
      dated: queried.filter((record) => applicationTimestamp(record) !== null).length,
      unknown: queried.filter((record) => applicationTimestamp(record) === null).length,
      incomplete: queried.filter(incompleteRecord).length,
      withImages: queried.filter((record) => Array.isArray(record.media?.images) && record.media.images.length > 0).length,
    };
    const cutoff = /^\d+$/.test(timeRange)
      ? Date.now() - (Number(timeRange) * 24 * 60 * 60 * 1000)
      : null;
    const filtered = queried.filter((record) => {
      const timestamp = applicationTimestamp(record);
      if (timeRange === 'unknown') return timestamp === null;
      if (cutoff !== null) return timestamp !== null && timestamp >= cutoff;
      return true;
    });
    const records = filtered
      .map((record, index) => ({ record, index, timestamp: applicationTimestamp(record) }))
      .sort((left, right) => {
        if (left.timestamp === null && right.timestamp !== null) return 1;
        if (left.timestamp !== null && right.timestamp === null) return -1;
        if (left.timestamp !== null && right.timestamp !== null && left.timestamp !== right.timestamp) {
          return sort === 'oldest' ? left.timestamp - right.timestamp : right.timestamp - left.timestamp;
        }
        return left.index - right.index;
      })
      .map(({ record }) => record);
    return {
      available: true,
      analysisMode,
      keyword: String(payload.keyword || task.params?.keyword || task.config?.keyword || ''),
      research: analysisMode === 'general' ? contentResearchContext(payload, task) : null,
      presentation: analysisMode === 'general' && payload.content_presentation ? payload.content_presentation : null,
      insights: analysisMode === 'general' && payload.content_insights ? payload.content_insights : null,
      total: records.length,
      offset,
      limit,
      items: records.slice(offset, offset + limit),
      filters: { sort, timeRange, stats: filterStats },
      codexRuntime: payload.ai_workflow || payload.codex_runtime || null,
      qualityGate: payload.quality_gate || null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return {
      available: false,
      analysisMode: requestedAnalysisMode || 'job',
      keyword: '',
      research: null,
      presentation: null,
      insights: null,
      total: 0,
      offset,
      limit,
      items: [],
      filters: { sort, timeRange, stats: { all: 0, dated: 0, unknown: 0, incomplete: 0, withImages: 0 } },
      codexRuntime: null,
      qualityGate: null,
    };
    throw error;
  }
}

async function readLatestApplicationPayload(outputDir) {
  const candidates = await Promise.all(
    ['application_intelligence.checkpoint.json', 'application_intelligence.json'].map(async (filename) => {
      const filePath = path.join(outputDir, filename);
      try {
        const metadata = await stat(filePath);
        return { filePath, filename, modifiedAt: metadata.mtimeMs };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }),
  );
  const available = candidates.filter(Boolean).sort((left, right) => right.modifiedAt - left.modifiedAt);
  let lastError = null;
  for (const candidate of available) {
    try {
      const payload = JSON.parse(await readFile(candidate.filePath, 'utf8'));
      if (payload && Array.isArray(payload.records)) {
        Object.defineProperty(payload, APPLICATION_ARTIFACT_FILENAME, {
          value: candidate.filename,
          enumerable: false,
        });
        return payload;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  const error = new Error('Application results are not available.');
  error.code = 'ENOENT';
  throw error;
}

async function readLegacyMediaSources(outputDir) {
  const files = ['xiaohongshu_cards_latest.json', 'xiaohongshu_notes_latest.json'];
  const sources = new Map();
  for (const file of files) {
    try {
      const payload = JSON.parse(await readFile(path.join(outputDir, file), 'utf8'));
      for (const item of Array.isArray(payload) ? payload : []) {
        const noteId = String(item?.note_id || '').trim();
        if (noteId) sources.set(noteId, { ...(sources.get(noteId) || {}), ...item });
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return sources;
}

function hydrateApplicationMedia(record, legacy = {}) {
  const existing = record?.media && typeof record.media === 'object' ? record.media : {};
  const existingImages = Array.isArray(existing.images)
    ? existing.images.filter((item) => isContentImageUrl(String(item?.url || '')))
    : [];
  if (existingImages.length) {
    return { ...record, media: { ...existing, images: existingImages } };
  }
  const detailUrls = mediaValues(legacy.detail_image_urls);
  const detailAlts = mediaValues(legacy.detail_image_alts);
  const candidates = [
    ...detailUrls.map((url, index) => ({ url, alt: detailAlts[index] || '', source: 'detail' })),
    ...mediaValues(legacy.card_image_urls).map((url) => ({ url, alt: '', source: 'card' })),
    ...mediaValues(legacy.card_cover_url).map((url) => ({ url, alt: String(legacy.card_cover_alt || ''), source: 'cover' })),
  ];
  const seen = new Set();
  const images = candidates.filter((item) => {
    if (!isContentImageUrl(item.url) || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).slice(0, 20);
  return {
    ...record,
    media: {
      ...existing,
      images,
      cover_url: String(existing.cover_url || legacy.card_cover_url || images[0]?.url || ''),
      analysis: existing.analysis || {
        status: images.some((item) => item.alt) ? 'alt_text_available' : images.length ? 'pending_ai' : 'no_images',
        summary: '',
        job_signals: [],
        source: images.some((item) => item.alt) ? 'image_alt_text' : 'none',
      },
    },
  };
}

function mediaValues(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split('|').map((item) => item.trim()).filter(Boolean);
}

function isContentImageUrl(value) {
  const lowered = String(value || '').toLowerCase();
  return /^https?:\/\//i.test(lowered)
    && !['sns-avatar', '/avatar/', 'avatar_'].some((marker) => lowered.includes(marker));
}

function localizeApplicationMedia(record, jobId) {
  const media = record?.media && typeof record.media === 'object' ? record.media : null;
  if (!media || !jobId) return record;
  const proxy = (value) => {
    const sourceUrl = String(value || '').trim();
    if (!isCacheableMediaUrl(sourceUrl)) return sourceUrl;
    return `/api/jobs/${encodeURIComponent(jobId)}/media?url=${encodeURIComponent(sourceUrl)}`;
  };
  const images = Array.isArray(media.images)
    ? media.images.map((image) => {
      const sourceUrl = String(image?.url || '').trim();
      return isCacheableMediaUrl(sourceUrl)
        ? { ...image, url: proxy(sourceUrl), original_url: sourceUrl }
        : image;
    })
    : [];
  const coverUrl = String(media.cover_url || '').trim();
  return {
    ...record,
    media: {
      ...media,
      images,
      ...(coverUrl ? {
        cover_url: proxy(coverUrl),
        ...(isCacheableMediaUrl(coverUrl) ? { cover_original_url: coverUrl } : {}),
      } : {}),
    },
  };
}

function localizeAudienceProfileAvatar(user, jobId) {
  if (!user || typeof user !== 'object' || !jobId) return user;
  const sourceUrl = String(user.avatar_original_url || user.avatar_url || '').trim();
  if (!isCacheableMediaUrl(sourceUrl)) return user;
  return {
    ...user,
    avatar_url: `/api/jobs/${encodeURIComponent(jobId)}/media?url=${encodeURIComponent(sourceUrl)}`,
    avatar_original_url: sourceUrl,
  };
}

function localizeAudienceAvatars(result, jobId) {
  const posts = Array.isArray(result?.posts)
    ? result.posts.map((post) => ({
      ...post,
      author: localizeAudienceProfileAvatar(post?.author, jobId),
    }))
    : [];
  const items = Array.isArray(result?.items)
    ? result.items.map((item) => (
      result.kind === 'comments'
        ? { ...item, user: localizeAudienceProfileAvatar(item?.user, jobId) }
        : localizeAudienceProfileAvatar(item, jobId)
    ))
    : [];
  return { ...result, posts, items };
}

async function serveCachedMedia(res, { outputDir, sourceUrl, mediaFetcher, mediaDownloads }) {
  const source = validatedMediaUrl(sourceUrl);
  if (typeof mediaFetcher !== 'function') {
    const error = new Error('The media fetch runtime is unavailable.');
    error.code = 'MEDIA_SOURCE_UNAVAILABLE';
    throw error;
  }
  const key = createHash('sha256').update(source.href).digest('hex');
  let pending = mediaDownloads.get(key);
  if (!pending) {
    pending = loadOrCacheMedia(outputDir, key, source, mediaFetcher);
    mediaDownloads.set(key, pending);
    pending.finally(() => mediaDownloads.delete(key)).catch(() => {});
  }
  const file = await pending;
  res.writeHead(200, {
    'Content-Type': file.contentType,
    'Content-Length': file.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  createReadStream(file.absolute).pipe(res);
}

async function loadOrCacheMedia(outputDir, key, source, mediaFetcher) {
  const cacheDir = path.join(outputDir, '.media-cache');
  const dataPath = path.join(cacheDir, `${key}.image`);
  const metadataPath = path.join(cacheDir, `${key}.json`);
  try {
    const [info, metadata] = await Promise.all([
      stat(dataPath),
      readFile(metadataPath, 'utf8').then(JSON.parse),
    ]);
    if (info.isFile() && /^image\//i.test(metadata.contentType || '')) {
      return { absolute: dataPath, size: info.size, contentType: metadata.contentType };
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  const response = await fetchMedia(source, mediaFetcher);
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (!response.ok || !/^image\//.test(contentType) || contentLength > MEDIA_CACHE_MAX_BYTES) {
    const error = new Error(`The source image could not be refreshed (HTTP ${response.status}).`);
    error.code = 'MEDIA_SOURCE_UNAVAILABLE';
    throw error;
  }
  const body = await readLimitedMediaBody(response, MEDIA_CACHE_MAX_BYTES);
  await mkdir(cacheDir, { recursive: true });
  const tempPath = `${dataPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, body);
  await rename(tempPath, dataPath);
  await writeFile(metadataPath, JSON.stringify({ sourceUrl: source.href, contentType }), 'utf8');
  return { absolute: dataPath, size: body.length, contentType };
}

async function fetchMedia(initialUrl, mediaFetcher) {
  let current = initialUrl;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEDIA_CACHE_TIMEOUT_MS);
    let response;
    try {
      response = await mediaFetcher(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: 'https://www.xiaohongshu.com/',
        },
      });
    } catch (cause) {
      const error = new Error('The source image request failed.', { cause });
      error.code = 'MEDIA_SOURCE_UNAVAILABLE';
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirect === 3) break;
    current = validatedMediaUrl(new URL(location, current).href);
  }
  const error = new Error('The source image redirected too many times.');
  error.code = 'MEDIA_SOURCE_UNAVAILABLE';
  throw error;
}

async function readLimitedMediaBody(response, maxBytes) {
  if (!response.body?.getReader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length <= maxBytes) return body;
  } else {
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
    }
  }
  const error = new Error('The source image is too large to cache.');
  error.code = 'MEDIA_SOURCE_UNAVAILABLE';
  throw error;
}

function validatedMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || !isCacheableMediaUrl(url.href)) {
    const error = new Error('Only Xiaohongshu CDN image URLs can be cached.');
    error.code = 'MEDIA_SOURCE_INVALID';
    throw error;
  }
  return url;
}

function isCacheableMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (hostname === 'xhscdn.com' || hostname.endsWith('.xhscdn.com'));
  } catch {
    return false;
  }
}

function applicationTimestamp(record) {
  const value = String(record?.publish_time?.value || '').trim();
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? value.replace(' ', 'T') : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function readApplicationRecord(outputDir, noteId) {
  const payload = await readLatestApplicationPayload(outputDir);
  const recordIndex = Array.isArray(payload.records)
    ? payload.records.findIndex((item) => item.note_id === noteId)
    : -1;
  const record = recordIndex >= 0 ? payload.records[recordIndex] : null;
  if (!record) throw new ValidationError('Application record not found.');
  Object.defineProperty(record, APPLICATION_RECORD_INDEX, { value: recordIndex, enumerable: false });
  Object.defineProperty(record, APPLICATION_ARTIFACT_FILENAME, {
    value: payload[APPLICATION_ARTIFACT_FILENAME],
    enumerable: false,
  });
  return record;
}

async function readDeliveryState(outputDir) {
  try {
    const value = JSON.parse(await readFile(path.join(outputDir, 'delivery-state.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

function withDeliveryStateLock(outputDir, operation) {
  const key = path.resolve(outputDir, 'delivery-state.json');
  const previous = deliveryStateLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  deliveryStateLocks.set(key, current);
  return current.finally(() => {
    if (deliveryStateLocks.get(key) === current) deliveryStateLocks.delete(key);
  });
}

async function updateDeliveryState(outputDir, value) {
  const noteId = String(value?.noteId || '').trim();
  const action = String(value?.action || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  if (!['ready_to_apply', 'ready_to_message', 'applied', 'messaged', 'reset'].includes(action)) {
    throw new ValidationError('Invalid delivery action.');
  }
  const record = await readApplicationRecord(outputDir, noteId);
  return withDeliveryStateLock(outputDir, async () => {
    const state = await readDeliveryState(outputDir);
    const existing = state[noteId] || {};
    const store = draftStoreFor(record, existing);
    const current = currentDraftVersion(store);
    if (action === 'reset') {
      const { action: _action, email: _email, pendingSend: _pendingSend, updatedAt: _updatedAt, ...preserved } = existing;
      state[noteId] = {
        ...preserved,
        draft: { ...current.content },
        draftStore: store,
      };
      await writeDeliveryState(outputDir, state);
      return {
        noteId,
        draftVersion: draftVersionMetadata(store),
        delivery: publicDeliveryState(state[noteId]),
      };
    }

    const resolved = resolveStoredDraftForAction(record, existing, value);
    await assertQualityReportReference(outputDir, record, resolved);
    if (['ready_to_message', 'messaged'].includes(action) && !resolved.content.greeting) {
      throw new ValidationError('Direct-message greeting is required.');
    }
    if (['ready_to_message', 'messaged'].includes(action) && !hasActionableDirectMessageRoute(record)) {
      throw new ValidationError('This application record does not contain an actionable direct-message route.');
    }
    if (['ready_to_apply', 'applied'].includes(action) && !resolved.content.cover_letter) {
      throw new ValidationError('Cover Letter is required.');
    }
    const updatedAt = new Date().toISOString();
    state[noteId] = {
      ...existing,
      action,
      updatedAt,
      draft: { ...resolved.content },
      draftStore: resolved.store,
    };
    await writeDeliveryState(outputDir, state);
    return {
      noteId,
      draftVersion: draftVersionMetadata(resolved.store),
      delivery: publicDeliveryState(state[noteId]),
    };
  });
}

async function updateApplicationDraft(outputDir, value, writeState = writeDeliveryState) {
  const noteId = String(value?.noteId || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  const record = await readApplicationRecord(outputDir, noteId);
  return withDeliveryStateLock(outputDir, async () => {
    const state = await readDeliveryState(outputDir);
    const existing = state[noteId] || {};
    const store = draftStoreFor(record, existing);
    const current = currentDraftVersion(store);
    const draft = normalizeDraft(value?.outreach, current.content);
    const suppliedVersion = value?.baseVersion ?? value?.expectedVersion ?? value?.version;
    const requestedHash = hashDraftContent(draft);
    const isIdempotentRetry = requestedHash === current.contentHash;
    const isVersionedWrite = suppliedVersion != null;
    const writeProtocol = String(existing.draftWriteProtocol || '').trim();
    if (!isVersionedWrite && !isIdempotentRetry && (
      writeProtocol === 'versioned'
      || (store.currentVersion > 1 && writeProtocol !== 'legacy')
    )) {
      throw draftVersionConflict(null, store.currentVersion);
    }
    const expectedVersion = isVersionedWrite
      ? Number(suppliedVersion)
      : store.currentVersion;
    const updatedStore = saveDraftVersion(store, {
      draftId: value?.draftId || store.draftId,
      expectedVersion,
      content: draft,
      now: new Date(),
    });
    const updated = currentDraftVersion(updatedStore);
    state[noteId] = {
      ...existing,
      action: 'draft_saved',
      updatedAt: updated.updatedAt,
      draft: { ...updated.content },
      draftStore: updatedStore,
      draftWriteProtocol: isVersionedWrite ? 'versioned' : (writeProtocol || 'legacy'),
    };
    await writeState(outputDir, state);
    return {
      noteId,
      outreach: { ...updated.content },
      draftVersion: draftVersionMetadata(updatedStore),
      delivery: publicDeliveryState(state[noteId]),
    };
  });
}

async function recheckApplicationDraft(outputDir, value, checker, ai, candidateProfile, writeState = writeDeliveryState) {
  const noteId = String(value?.noteId || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  const record = await readApplicationRecord(outputDir, noteId);
  const snapshot = await withDeliveryStateLock(outputDir, async () => {
    const state = await readDeliveryState(outputDir);
    const existing = state[noteId] || {};
    const store = draftStoreFor(record, existing);
    const requestedVersion = Number(value?.version);
    const draftId = String(value?.draftId || '').trim();
    if (!Number.isInteger(requestedVersion) || requestedVersion < 1) {
      throw applicationDraftError('DRAFT_VERSION_REQUIRED', 'A valid draft version is required for quality checking.');
    }
    if (requestedVersion !== store.currentVersion) {
      throw draftVersionConflict(requestedVersion, store.currentVersion);
    }
    const current = currentDraftVersion(store);
    if (draftId !== store.draftId) {
      throw applicationDraftError('DRAFT_ID_MISMATCH', 'The requested draftId does not match the stored draft.');
    }
    if (hashDraftContent(current.content) !== current.contentHash) {
      throw applicationDraftError('DRAFT_CONTENT_HASH_MISMATCH', 'Stored draft content no longer matches its content hash.');
    }
    return {
      draftId: store.draftId,
      version: current.version,
      contentHash: current.contentHash,
      content: { ...current.content },
    };
  });

  const threshold = Math.max(90, Number(record?.cover_letter_evaluation?.threshold || 90));
  let report;
  try {
    report = await checker({
      record,
      draft: snapshot.content,
      candidateProfile: candidateProfile || record?.candidate_profile || {},
      threshold,
    }, ai);
  } catch (error) {
    const failure = applicationDraftError(
      'AI_QUALITY_CHECK_FAILED',
      `Draft quality check failed: ${String(error?.message || 'unknown error')}`,
    );
    failure.cause = error;
    throw failure;
  }

  return withDeliveryStateLock(outputDir, async () => {
    const state = await readDeliveryState(outputDir);
    const existing = state[noteId] || {};
    const store = draftStoreFor(record, existing);
    const current = currentDraftVersion(store);
    if (
      store.draftId !== snapshot.draftId
      || store.currentVersion !== snapshot.version
      || current.contentHash !== snapshot.contentHash
      || hashDraftContent(current.content) !== snapshot.contentHash
    ) {
      throw draftVersionConflict(snapshot.version, store.currentVersion);
    }
    const checkedAt = new Date().toISOString();
    const evaluation = normalizeDraftQualityReport(report, record?.cover_letter_evaluation);
    const qualityChecks = Array.isArray(existing.qualityChecks) ? existing.qualityChecks : [];
    const qualityCheckId = `quality_${randomUUID()}`;
    const qualityReportRef = `delivery-state.json#/${jsonPointerToken(noteId)}/qualityChecks/${qualityChecks.length}`;
    const qualityCheck = {
      id: qualityCheckId,
      draftId: snapshot.draftId,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
      checkedAt,
      evaluation,
    };
    const updatedStore = bindDraftQuality(store, {
      draftId: snapshot.draftId,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
      passed: evaluation.passed,
      qualityReportRef,
      now: checkedAt,
    });
    state[noteId] = {
      ...existing,
      action: 'draft_checked',
      updatedAt: checkedAt,
      draft: { ...current.content },
      draftStore: updatedStore,
      qualityChecks: [...qualityChecks, qualityCheck],
    };
    await writeState(outputDir, state);
    return {
      noteId,
      outreach: { ...current.content },
      draftVersion: draftVersionMetadata(updatedStore),
      cover_letter_evaluation: evaluation,
      delivery: publicDeliveryState(state[noteId]),
    };
  });
}

async function sendApplicationEmail(outputDir, value, mailer, replyTo, smtpConfig, options = {}) {
  const writeState = options.writeState || writeDeliveryState;
  const appendAudit = options.appendAudit || appendSendAuditJournal;
  const readAudit = options.readAudit || readSendAuditJournal;
  const noteId = String(value?.noteId || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  const requestIdempotencyKey = normalizeSendRequestKey(value?.idempotencyKey);
  const record = await readApplicationRecord(outputDir, noteId);
  const extracted = extractedEmails(record);
  const requested = String(value?.to || '').trim().toLowerCase();
  const to = extracted.find((item) => item.toLowerCase() === requested) || (!requested ? extracted[0] : '');
  if (!to) throw new ValidationError('Recipient must be an email extracted from this application record.');

  return withDeliveryStateLock(outputDir, async () => {
    const state = await readDeliveryState(outputDir);
    const existing = state[noteId] || {};
    const resolved = resolveStoredDraftForAction(record, existing, value);
    await assertQualityReportReference(outputDir, record, resolved);
    const draft = { ...resolved.content };
    if (!draft.email_subject || !draft.email_body) throw new ValidationError('Email subject and body are required.');
    validateDeliveryDraft(draft, record);
    const idempotencyKey = sendIdempotencyKey({
      draftId: resolved.draftId,
      version: resolved.version,
      contentHash: resolved.contentHash,
      recipient: to,
    });
    const sendIdentity = {
      draftId: resolved.draftId,
      version: resolved.version,
      contentHash: resolved.contentHash,
      recipient: to,
      recipientHash: recipientAuditHash(to),
      idempotencyKey,
    };
    const journalAudits = await readAudit(outputDir);
    assertSendRequestKeyAvailable(
      [
        ...Object.values(state).flatMap((item) => Array.isArray(item?.sendAudit) ? item.sendAudit : []),
        ...Object.values(state).flatMap((item) => item?.pendingSend ? [item.pendingSend] : []),
        ...journalAudits,
      ],
      requestIdempotencyKey,
      idempotencyKey,
    );
    const existingAudit = findSendAudit(existing.sendAudit, sendIdentity);
    if (existingAudit) {
      return {
        noteId,
        outreach: draft,
        draftVersion: draftVersionMetadata(resolved.store),
        delivery: publicDeliveryState(existing),
        duplicate: true,
        code: 'EMAIL_DUPLICATE_SEND',
        sendIdempotencyKey: idempotencyKey,
      };
    }
    const journalAudit = findSendAudit(journalAudits, sendIdentity);
    if (journalAudit) {
      const reconciledAt = journalAudit.sentAt || journalAudit.timestamp || new Date().toISOString();
      const reconciled = stateWithoutPendingSend({
        ...existing,
        action: 'email_sent',
        updatedAt: reconciledAt,
        draft,
        draftStore: resolved.store,
        email: {
          status: 'sent',
          to,
          sentAt: reconciledAt,
          messageId: journalAudit.messageId || '',
        },
        sendAudit: appendUniqueSendAudit(existing.sendAudit, sanitizeSendAudit(journalAudit)),
      });
      state[noteId] = reconciled;
      await writeState(outputDir, state);
      return {
        noteId,
        outreach: draft,
        draftVersion: draftVersionMetadata(resolved.store),
        delivery: publicDeliveryState(reconciled),
        duplicate: true,
        code: 'EMAIL_DUPLICATE_SEND',
        sendIdempotencyKey: idempotencyKey,
      };
    }
    if (existing.pendingSend) {
      throw applicationDraftError(
        'EMAIL_SEND_STATUS_UNKNOWN',
        'A previous email attempt has a persisted send intent without a confirmed audit; retry is blocked to prevent duplicate delivery.',
      );
    }
    let smtpState = assertSmtpVerified(mailer, smtpConfig);
    const verificationSnapshot = smtpConfig?.getVerificationSnapshot?.() || {
      configHash: smtpState?.configHash || '',
      credentialRevision: Number(smtpState?.credentialRevision || 0),
    };
    try {
      await mailer.verify();
      const verified = await smtpConfig?.markVerified?.(verificationSnapshot);
      smtpState = smtpConfig?.getVerificationState?.() || verified || smtpState;
    } catch (error) {
      await smtpConfig?.markVerificationFailed?.(
        verificationSnapshot,
        String(error?.code || 'SMTP_VERIFICATION_FAILED'),
      ).catch(() => {});
      const failedAt = new Date().toISOString();
      const failureAudit = createSendAuditRecord(sendIdentity, {
        requestIdempotencyKey,
        smtpState,
        status: 'failed',
        errorCode: String(error?.code || 'SMTP_VERIFICATION_FAILED'),
        timestamp: failedAt,
        qualityReportRef: resolved.qualityReportRef,
      });
      state[noteId] = {
        ...existing,
        action: 'email_failed',
        updatedAt: failedAt,
        draft,
        draftStore: resolved.store,
        email: { status: 'failed', to, failedAt },
        sendAudit: appendSendAuditEvent(existing.sendAudit, failureAudit),
      };
      await writeState(outputDir, state);
      throw error;
    }
    const preparedAt = new Date().toISOString();
    state[noteId] = {
      ...existing,
      draft,
      draftStore: resolved.store,
      updatedAt: preparedAt,
      pendingSend: {
        ...sendIdentity,
        requestIdempotencyKey,
        configHash: smtpState?.configHash || '',
        credentialRevision: Number(smtpState?.credentialRevision || 0),
        preparedAt,
        qualityReportRef: resolved.qualityReportRef,
      },
    };
    await writeState(outputDir, state);
    let sent;
    try {
      sent = await mailer.send({
        to,
        subject: draft.email_subject,
        text: draft.email_body,
        replyTo: EMAIL.test(replyTo) ? replyTo : '',
      });
    } catch (error) {
      const knownNotSent = error?.safeToRetry === true || error?.deliveryStatus === 'not_sent';
      const failedAt = new Date().toISOString();
      const failureAudit = createSendAuditRecord(sendIdentity, {
        requestIdempotencyKey,
        smtpState,
        status: knownNotSent ? 'failed' : 'unknown',
        errorCode: String(error?.code || 'SMTP_SEND_FAILED'),
        timestamp: failedAt,
        qualityReportRef: resolved.qualityReportRef,
      });
      const failedState = {
        ...state[noteId],
        action: knownNotSent ? 'email_failed' : 'email_unknown',
        updatedAt: failedAt,
        email: { status: knownNotSent ? 'failed' : 'unknown', to, failedAt },
        sendAudit: appendSendAuditEvent(state[noteId]?.sendAudit, failureAudit),
      };
      state[noteId] = knownNotSent ? stateWithoutPendingSend(failedState) : failedState;
      await writeState(outputDir, state);
      throw error;
    }
    const sentAt = new Date().toISOString();
    const audit = createSendAuditRecord(sendIdentity, {
      requestIdempotencyKey,
      smtpState,
      status: 'sent',
      errorCode: '',
      timestamp: sentAt,
      sentAt,
      qualityReportRef: resolved.qualityReportRef,
      messageId: sent.messageId || '',
    });
    try {
      await appendAudit(outputDir, audit);
    } catch (error) {
      const uncertain = applicationDraftError(
        'EMAIL_DELIVERED_AUDIT_UNCERTAIN',
        'SMTP accepted the email, but its durable audit journal could not be written; retry is blocked to prevent duplicate delivery.',
      );
      uncertain.cause = error;
      throw uncertain;
    }
    state[noteId] = stateWithoutPendingSend({
      ...state[noteId],
      action: 'email_sent',
      updatedAt: sentAt,
      email: {
        status: 'sent',
        to,
        sentAt,
        messageId: sent.messageId || '',
      },
      sendAudit: appendUniqueSendAudit(state[noteId]?.sendAudit, audit),
    });
    try {
      await writeState(outputDir, state);
    } catch (error) {
      const pending = applicationDraftError(
        'EMAIL_DELIVERED_AUDIT_STATE_PENDING',
        'SMTP accepted the email and the durable audit was written, but delivery-state reconciliation is pending.',
      );
      pending.cause = error;
      throw pending;
    }
    return {
      noteId,
      outreach: draft,
      draftVersion: draftVersionMetadata(resolved.store),
      delivery: publicDeliveryState(state[noteId]),
      duplicate: false,
      sendIdempotencyKey: idempotencyKey,
    };
  });
}

function draftStoreFor(
  record,
  state,
  recordIndex = record?.[APPLICATION_RECORD_INDEX],
  artifactFilename = record?.[APPLICATION_ARTIFACT_FILENAME],
) {
  const migrationTimestamp = stableDraftTimestamp(record, state);
  const actualQualityReportRef = Number.isInteger(recordIndex) && recordIndex >= 0 && artifactFilename
    ? `${artifactFilename}#/records/${recordIndex}/cover_letter_evaluation`
    : null;
  const migrationRecord = actualQualityReportRef && record?.cover_letter_evaluation
    ? {
        ...record,
        cover_letter_evaluation: withoutEmbeddedQualityReportRef(record.cover_letter_evaluation),
      }
    : record;
  return migrateDraftStore(migrationRecord, state, {
    now: migrationTimestamp,
    legacyUpdatedAt: migrationTimestamp,
    ...(actualQualityReportRef
      ? { legacyQualityReportRef: actualQualityReportRef }
      : {}),
  });
}

function withoutEmbeddedQualityReportRef(evaluation) {
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) return evaluation;
  const {
    qualityReportRef: _qualityReportRef,
    reportRef: _reportRef,
    ...quality
  } = evaluation;
  return quality;
}

function stableDraftTimestamp(record, state) {
  const candidates = [
    state?.updatedAt,
    record?.updated_at,
    record?.created_at,
    record?.collected_at,
  ];
  for (const candidate of candidates) {
    const timestamp = Date.parse(String(candidate || ''));
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return '1970-01-01T00:00:00.000Z';
}

function draftVersionMetadata(store) {
  const { currentVersion, ...metadata } = publicDraftMetadata(store);
  return { ...metadata, version: currentVersion };
}

function resolveStoredDraftForAction(record, state, value) {
  const store = draftStoreFor(record, state);
  const requestedVersion = value?.version == null ? store.currentVersion : Number(value.version);
  if (!Number.isInteger(requestedVersion) || requestedVersion < 1) {
    throw applicationDraftError('DRAFT_VERSION_REQUIRED', 'A valid draft version is required.');
  }
  if (requestedVersion !== store.currentVersion) {
    throw draftVersionConflict(requestedVersion, store.currentVersion);
  }
  const draftId = String(value?.draftId || store.draftId).trim();
  const resolved = resolveDraftForSend(store, { draftId, version: requestedVersion });
  if (Object.hasOwn(value || {}, 'outreach')) {
    const requestedDraft = normalizeDraft(value.outreach, resolved.content);
    if (hashDraftContent(requestedDraft) !== resolved.contentHash) {
      throw applicationDraftError(
        'DRAFT_REQUEST_CONTENT_MISMATCH',
        'Client-supplied draft content does not match the stored checked version.',
      );
    }
  }
  return { ...resolved, store };
}

async function assertQualityReportReference(outputDir, record, resolved) {
  const reference = resolved?.qualityReportRef;
  if (typeof reference !== 'string' || !reference.trim()) {
    throw invalidQualityReportReference('The checked draft quality report reference is invalid.');
  }
  const separator = reference.indexOf('#');
  const relativePath = separator > 0 ? reference.slice(0, separator) : '';
  const pointer = separator > 0 ? reference.slice(separator + 1) : '';
  if (!relativePath || !pointer.startsWith('/') || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw invalidQualityReportReference('The checked draft quality report reference must use an artifact JSON Pointer.');
  }

  let document;
  let targetPath;
  try {
    const root = await realpath(outputDir);
    targetPath = path.resolve(root, relativePath);
    assertPathInside(root, targetPath);
    const targetRealPath = await realpath(targetPath);
    assertPathInside(root, targetRealPath);
    document = JSON.parse(await readFile(targetRealPath, 'utf8'));
  } catch (error) {
    const invalid = invalidQualityReportReference('The checked draft quality report artifact is unavailable or invalid.');
    invalid.cause = error;
    throw invalid;
  }

  const report = resolveJsonPointer(document, pointer);
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw invalidQualityReportReference('The checked draft quality report JSON Pointer does not resolve to a report.');
  }

  const noteId = String(record?.note_id || record?.noteId || '').trim();
  const recordIndex = record?.[APPLICATION_RECORD_INDEX];
  const artifactFilename = record?.[APPLICATION_ARTIFACT_FILENAME];
  const expectedLegacyRef = Number.isInteger(recordIndex) && recordIndex >= 0 && artifactFilename
    ? `${artifactFilename}#/records/${recordIndex}/cover_letter_evaluation`
    : null;
  const expectedStatePrefix = `delivery-state.json#/${jsonPointerToken(noteId)}/qualityChecks/`;
  const versionBound = String(report.draftId || '') === resolved.draftId
    && Number(report.version) === resolved.version
    && String(report.contentHash || '') === resolved.contentHash;
  const legacyBound = reference === expectedLegacyRef
    && resolved.version === 1
    && hashDraftContent(record?.outreach) === resolved.contentHash
    && JSON.stringify(report) === JSON.stringify(record?.cover_letter_evaluation);
  if ((versionBound && !reference.startsWith(expectedStatePrefix)) || (!versionBound && !legacyBound)) {
    throw invalidQualityReportReference('The quality report is not bound to this exact stored draft version and content hash.');
  }

  const evaluation = versionBound ? report.evaluation : report;
  const thresholdValue = Number(evaluation?.threshold ?? 90);
  const threshold = Number.isFinite(thresholdValue) ? Math.max(90, thresholdValue) : 90;
  const score = Number(evaluation?.score);
  if (evaluation?.passed !== true || !Number.isFinite(score) || score < threshold) {
    throw invalidQualityReportReference('The bound quality report does not contain a passing evaluation.');
  }
}

function resolveJsonPointer(document, pointer) {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let current = document;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, token)) {
      return undefined;
    }
    current = current[token];
  }
  return current;
}

function invalidQualityReportReference(message) {
  return applicationDraftError('DRAFT_QUALITY_REPORT_INVALID', message);
}

function draftVersionConflict(expectedVersion, currentVersion) {
  const error = applicationDraftError(
    'DRAFT_VERSION_CONFLICT',
    `Draft version conflict: expected ${expectedVersion}, current ${currentVersion}.`,
  );
  error.expectedVersion = expectedVersion;
  error.currentVersion = currentVersion;
  return error;
}

function applicationDraftError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveDraftAiRuntime(aiSessions, internal, value) {
  const aiSessionId = String(value?.aiSessionId || internal?.params?.aiSessionId || '').trim();
  if (!aiSessionId || !aiSessions?.resolve) {
    throw applicationDraftError(
      'AI_SESSION_UNAVAILABLE',
      'A configured AI session is required to check the edited draft.',
    );
  }
  return aiSessions.resolve(aiSessionId);
}

function normalizeDraftQualityReport(report, legacyEvaluation = {}) {
  const source = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const fallback = legacyEvaluation && typeof legacyEvaluation === 'object' && !Array.isArray(legacyEvaluation)
    ? legacyEvaluation
    : {};
  const score = Math.max(0, Math.min(100, Number(source.score)));
  if (!Number.isFinite(score)) {
    throw applicationDraftError('AI_QUALITY_CHECK_FAILED', 'The draft quality checker returned an invalid score.');
  }
  const thresholdValue = Number(source.threshold ?? fallback.threshold ?? 90);
  const threshold = Math.max(90, Math.min(100, Number.isFinite(thresholdValue) ? thresholdValue : 90));
  const stringList = (value) => Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const rubricSource = source.rubric && typeof source.rubric === 'object' && !Array.isArray(source.rubric)
    ? source.rubric
    : {};
  const rubric = Object.fromEntries(Object.entries(rubricSource).flatMap(([key, value]) => {
    const numeric = Number(value);
    return key && Number.isFinite(numeric) ? [[key, numeric]] : [];
  }));
  return {
    ...fallback,
    ...source,
    score,
    threshold,
    passed: source.passed === true && score >= threshold,
    attempts: Math.max(1, Number.isInteger(Number(source.attempts)) ? Number(source.attempts) : 1),
    strengths: stringList(source.strengths),
    problems: stringList(source.problems),
    rubric,
  };
}

function jsonPointerToken(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function hasActionableDirectMessageRoute(record) {
  const routes = [
    ...(record?.application_info?.contacts || []),
    ...(record?.application_info?.application_routes || []),
  ];
  return routes.some((route) => {
    if (!route || route.actionable === false) return false;
    const verificationStatus = String(route.verification_status || route.verificationStatus || '').toLowerCase();
    if (['invalid', 'rejected', 'unverified'].includes(verificationStatus)) return false;
    const descriptor = `${route.channel || ''} ${route.type || ''} ${route.value || ''}`.toLowerCase();
    return route.channel === 'direct_message'
      || /(?:direct.?message|\bdm\b|message|私信|站内)/iu.test(descriptor);
  });
}

function sendIdempotencyKey(value) {
  const canonical = JSON.stringify([
    String(value?.draftId || ''),
    Number(value?.version || 0),
    String(value?.contentHash || ''),
    String(value?.recipient || '').trim().toLowerCase(),
  ]);
  return createHash('sha256').update(`application-email:v1\n${canonical}`, 'utf8').digest('hex');
}

function sendAuditMatches(audit, identity) {
  const status = String(audit?.status || 'sent').toLowerCase();
  const recipientMatches = audit?.recipientHash
    ? audit.recipientHash === identity.recipientHash
    : String(audit?.recipient || '').toLowerCase() === String(identity.recipient || '').toLowerCase();
  return Boolean(audit)
    && status === 'sent'
    && audit.draftId === identity.draftId
    && Number(audit.version ?? audit.draftVersion) === Number(identity.version)
    && audit.contentHash === identity.contentHash
    && recipientMatches
    && audit.idempotencyKey === identity.idempotencyKey;
}

function findSendAudit(audits, identity) {
  return Array.isArray(audits) ? audits.find((audit) => sendAuditMatches(audit, identity)) || null : null;
}

function appendUniqueSendAudit(audits, audit) {
  const existing = Array.isArray(audits) ? audits : [];
  return findSendAudit(existing, audit) ? [...existing] : [...existing, { ...audit }];
}

function appendSendAuditEvent(audits, audit) {
  return [...(Array.isArray(audits) ? audits : []), { ...audit }];
}

function normalizeSendRequestKey(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new ValidationError('idempotencyKey must be a non-empty string of at most 200 characters.');
  }
  return value.trim();
}

function assertSendRequestKeyAvailable(records, requestIdempotencyKey, idempotencyKey) {
  if (!requestIdempotencyKey) return;
  const conflict = (Array.isArray(records) ? records : []).find((record) => (
    String(record?.requestIdempotencyKey || record?.requestKey || '') === requestIdempotencyKey
    && String(record?.idempotencyKey || '') !== idempotencyKey
  ));
  if (conflict) {
    throw applicationDraftError(
      'EMAIL_IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to a different email operation.',
    );
  }
}

function recipientAuditHash(recipient) {
  return createHash('sha256')
    .update(`application-email-recipient:v1\n${String(recipient || '').trim().toLowerCase()}`, 'utf8')
    .digest('hex');
}

function maskAuditRecipient(recipient) {
  const value = String(recipient || '').trim();
  const separator = value.lastIndexOf('@');
  if (separator <= 0) return value ? '***' : '';
  return `${value.slice(0, 1)}***${value.slice(separator)}`;
}

function sanitizeSendAudit(audit) {
  const recipient = String(audit?.recipient || '');
  const version = Number(audit?.version ?? audit?.draftVersion ?? 0);
  return {
    ...audit,
    recipient: recipient.includes('*') ? recipient : maskAuditRecipient(recipient),
    recipientHash: audit?.recipientHash || recipientAuditHash(recipient),
    version,
    draftVersion: version,
    status: String(audit?.status || 'sent'),
    errorCode: String(audit?.errorCode || ''),
    timestamp: audit?.timestamp || audit?.sentAt || '',
  };
}

function createSendAuditRecord(identity, details = {}) {
  const version = Number(identity.version || 0);
  return {
    recipient: maskAuditRecipient(identity.recipient),
    recipientHash: identity.recipientHash || recipientAuditHash(identity.recipient),
    status: String(details.status || ''),
    draftId: identity.draftId,
    version,
    draftVersion: version,
    contentHash: identity.contentHash,
    idempotencyKey: identity.idempotencyKey,
    ...(details.requestIdempotencyKey ? { requestIdempotencyKey: details.requestIdempotencyKey } : {}),
    configHash: String(details.smtpState?.configHash || ''),
    credentialRevision: Number(details.smtpState?.credentialRevision || 0),
    timestamp: String(details.timestamp || ''),
    errorCode: String(details.errorCode || ''),
    qualityReportRef: details.qualityReportRef || null,
    messageId: String(details.messageId || ''),
    ...(details.sentAt ? { sentAt: details.sentAt } : {}),
  };
}

function stateWithoutPendingSend(state) {
  const { pendingSend: _pendingSend, ...next } = state;
  return next;
}

function assertSmtpVerified(mailer, smtpConfig) {
  if (!mailer?.status?.()?.configured) {
    const error = new Error('Please configure SMTP email delivery first.');
    error.code = 'MAIL_NOT_CONFIGURED';
    throw error;
  }
  if (typeof smtpConfig?.assertReadyForSend === 'function') {
    try {
      return smtpConfig.assertReadyForSend();
    } catch (error) {
      if (error?.code !== 'SMTP_NOT_VERIFIED') throw error;
      const compatible = applicationDraftError(
        'DRAFT_SMTP_NOT_VERIFIED',
        'SMTP must be verified before sending a checked draft.',
      );
      compatible.cause = error;
      throw compatible;
    }
  }
  const saved = smtpConfig?.getPublic?.() || {};
  const lastVerifiedAt = String(saved.lastVerifiedAt || '').trim();
  const verified = typeof smtpConfig?.isVerified === 'function'
    ? smtpConfig.isVerified()
    : Object.hasOwn(saved, 'verified')
      ? saved.verified === true
      : Boolean(lastVerifiedAt && Number.isFinite(Date.parse(lastVerifiedAt)));
  if (!verified || !lastVerifiedAt || !Number.isFinite(Date.parse(lastVerifiedAt))) {
    throw applicationDraftError('DRAFT_SMTP_NOT_VERIFIED', 'SMTP must be verified before sending a checked draft.');
  }
  return {
    configured: true,
    configHash: String(saved.configHash || ''),
    credentialRevision: Number(saved.credentialRevision || 0),
    verificationStatus: 'verified',
  };
}

function normalizeDraft(value, base = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const merged = Object.fromEntries(['greeting', 'email_subject', 'email_body', 'cover_letter'].map((field) => [
    field,
    Object.hasOwn(source, field) ? source[field] : base?.[field],
  ]));
  const draft = { ...normalizeDraftContent(merged) };
  const limits = { greeting: 2000, email_subject: 240, email_body: 20000, cover_letter: 20000 };
  for (const [field, limit] of Object.entries(limits)) {
    if (draft[field].length > limit) throw new ValidationError(`${field} is too long.`);
  }
  return draft;
}

function validateDeliveryDraft(draft, record) {
  const subject = String(draft.email_subject || '').trim();
  const body = String(draft.email_body || '').trim();
  if (subject.length < 8 || subject.length > 120) {
    throw new ValidationError('Email subject must contain 8-120 characters.');
  }
  if (body.length < 80 || body.length > 300) {
    throw new ValidationError('Email body must contain 80-300 characters before delivery.');
  }
  if (!body.includes('我')) {
    throw new ValidationError('Email body must use a clear first-person introduction.');
  }
  const combined = `${subject}\n${body}`;
  if (/(?:X{2,}|候选人姓名|公司名|岗位名|可用天数|实习时长|此处填|待补充|待填写)/i.test(combined)) {
    throw new ValidationError('Email still contains placeholder content.');
  }
  const candidateName = String(record?.candidate_profile?.name || '').trim();
  const metaScan = candidateName ? combined.replaceAll(candidateName, '') : combined;
  if (/(?:简历|附件|原帖|岗位提到|候选人|材料显示)/.test(metaScan)) {
    throw new ValidationError('Email contains unsupported meta wording or refers to an attachment that is not sent.');
  }
  const roleName = String(record?.job_card?.role_name || record?.title || '').trim();
  if (roleName && !subject.includes(roleName) && !body.includes(roleName)) {
    throw new ValidationError('Email subject or body must identify the current role.');
  }
  if (!/(?:期待|希望|方便|愿意).{0,18}(?:沟通|交流|面试|进一步了解)/.test(body)) {
    throw new ValidationError('Email body must include a clear communication next step.');
  }
}

function extractedEmails(record) {
  const routes = [...(record.application_info?.contacts || []), ...(record.application_info?.application_routes || [])];
  const values = routes.flatMap((route) => {
    const routeType = `${route?.type || ''} ${route?.channel || ''}`;
    const verificationStatus = String(route?.verification_status || route?.verificationStatus || '').toLowerCase();
    const routeValue = String(route?.value || '').trim();
    const explicitEmailValue = EMAIL.test(routeValue);
    if ((!/(?:e-?mail|邮箱|邮件)/i.test(routeType) && !explicitEmailValue) || route?.actionable === false) return [];
    if (['invalid', 'rejected', 'unverified'].includes(verificationStatus)) return [];
    return `${routeValue}\n${route?.evidence || ''}`.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  });
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function mergeApplicationState(record, state, recordIndex, artifactFilename) {
  const store = draftStoreFor(record, state || {}, recordIndex, artifactFilename);
  const current = currentDraftVersion(store);
  const qualityChecks = Array.isArray(state?.qualityChecks) ? state.qualityChecks : [];
  const currentQuality = [...qualityChecks].reverse().find((item) => (
    item?.draftId === store.draftId
    && Number(item?.version) === current.version
    && item?.contentHash === current.contentHash
  ));
  return {
    ...record,
    outreach: { ...record.outreach, ...current.content },
    cover_letter_evaluation: currentQuality?.evaluation || record.cover_letter_evaluation,
    draftVersion: draftVersionMetadata(store),
    delivery: publicDeliveryState(state),
  };
}

function publicDeliveryState(state) {
  if (!state) return null;
  const { draft, draftStore, draftWriteProtocol, qualityChecks, pendingSend, ...publicState } = state;
  if (Array.isArray(publicState.sendAudit)) {
    publicState.sendAudit = publicState.sendAudit.map((audit) => sanitizeSendAudit(audit));
  }
  return Object.keys(publicState).length ? publicState : null;
}

async function appendSendAuditJournal(outputDir, audit) {
  await mkdir(outputDir, { recursive: true });
  await appendFile(
    path.join(outputDir, 'delivery-send-audit.jsonl'),
    `${JSON.stringify({ schemaVersion: 1, event: 'email_sent', ...audit })}\n`,
    { encoding: 'utf8', flag: 'a' },
  );
}

async function readSendAuditJournal(outputDir) {
  let content;
  try {
    content = await readFile(path.join(outputDir, 'delivery-send-audit.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return content.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

async function writeDeliveryState(outputDir, state) {
  const target = path.join(outputDir, 'delivery-state.json');
  try {
    const previous = await readFile(target, 'utf8');
    let previousSchemaVersion = 0;
    try {
      previousSchemaVersion = Number(JSON.parse(previous)?._schemaVersion || 0);
    } catch {
      previousSchemaVersion = 0;
    }
    if (previousSchemaVersion < 2) {
      try {
        await writeFile(path.join(outputDir, 'delivery-state.v1.backup.json'), previous, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const persisted = {
    ...state,
    _schemaVersion: 2,
    _revision: Math.max(0, Number(state?._revision || 0)) + 1,
  };
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(persisted, null, 2), 'utf8');
  await rename(temporary, target);
  state._schemaVersion = persisted._schemaVersion;
  state._revision = persisted._revision;
}

function publicSmtpConfig(smtpConfig, mailer) {
  const saved = smtpConfig?.getPublic?.() || {
    provider: 'custom',
    host: '',
    port: 465,
    secure: true,
    requireTls: false,
    auth: 'login',
    user: '',
    from: '',
    hasPassword: false,
  };
  const status = mailer.status();
  const verified = Object.hasOwn(saved, 'verified') ? saved.verified === true : Boolean(saved.lastVerifiedAt);
  return { ...saved, configured: status.configured, verified, maskedFrom: status.from, authMode: status.authMode };
}

function boundedInteger(raw, fallback, min, max) {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function streamEvents(req, res, manager, id) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  writeEvent(res, 'snapshot', { type: 'snapshot', job: manager.get(id) });
  let closed = false;
  let heartbeat;
  let unsubscribe = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };
  unsubscribe = manager.subscribe(id, ({ type, data }) => {
    if (type === 'log') {
      const level = data.stream === 'stderr' ? 'error' : data.stream === 'system' ? 'info' : 'info';
      return writeEvent(res, 'log', { type: 'log', line: data.message, level });
    }
    if (type === 'state') return writeEvent(res, 'status', { type: 'status', job: data });
    if (type === 'closing') {
      writeEvent(res, 'status', { type: 'status', job: manager.get(id), lifecycle: 'closing' });
      return close();
    }
    if (type === 'end') return writeEvent(res, 'done', { type: 'done', job: manager.get(id) });
  });
  heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  req.on('close', close);
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error('Request body is too large.');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function noContent(res) {
  res.writeHead(204);
  res.end();
}

function errorBody(code, message, details) {
  return { message, error: { code, message, ...(details?.length ? { details } : {}) } };
}

async function serveSpa(req, res, staticDir, pathname) {
  if (!staticDir) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const relative = decoded.replace(/^\/+/, '').replaceAll('/', path.sep);
  const requested = path.resolve(staticDir, relative || 'index.html');
  try {
    assertPathInside(staticDir, requested);
  } catch {
    return false;
  }

  let file = await safeStaticFile(staticDir, requested);
  if (!file && !path.extname(relative)) file = await safeStaticFile(staticDir, path.join(staticDir, 'index.html'));
  if (!file) return false;
  const cacheControl = /[\\/]assets[\\/]/.test(file.absolute)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, {
    'Content-Type': mimeType(file.absolute),
    'Content-Length': file.size,
    'Cache-Control': cacheControl,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file.absolute).pipe(res);
  return true;
}

async function safeStaticFile(root, candidate) {
  try {
    const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(candidate)]);
    assertPathInside(rootReal, targetReal);
    const info = await stat(targetReal);
    return info.isFile() ? { absolute: targetReal, size: info.size } : null;
  } catch (error) {
    if (error.code === 'ENOENT' || /Path escapes/.test(error.message)) return null;
    throw error;
  }
}

function mimeType(file) {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
