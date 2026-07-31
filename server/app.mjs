import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { assertPathInside, enumerateArtifacts, resolveDownload } from './lib/artifacts.mjs';
import { ValidationError, validateRunRequest } from './lib/contracts.mjs';
import { probeRelay } from './lib/relay.mjs';
import { connectRelay, openRelayLogin } from './lib/relay-connect.mjs';
import { setupRelayRuntime } from './lib/relay-setup.mjs';
import { recoverRelay } from './lib/relay-recovery.mjs';
import { isIncompleteApplicationRecord, isIncompleteGeneralRecord } from './lib/application-records.mjs';
import { readAudienceResults } from './lib/audience-results.mjs';
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
const CONTENT_RESEARCH_LABELS = Object.freeze({
  auto: 'AI 自动识别',
  experience: '经验攻略',
  people: '人群与风格',
  trend: '趋势观察',
  product: '产品口碑',
  place: '地点清单',
  custom: '自定义研究',
});

export function createApp({ manager, config, aiSessions, profileStore, relayConfig, smtpConfig, mailSender, localModels, relayConnector = connectRelay, relayLoginOpener = openRelayLogin, relaySetup = setupRelayRuntime, relayRecoverer = recoverRelay, preflightService, dataLifecycle, mediaFetcher = globalThis.fetch }) {
  const getRelayConfig = () => relayConfig?.get?.() || { ...DEFAULT_RELAY_CONFIG };
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
  let smtpOperationTail = Promise.resolve();
  const withSmtpOperationLock = (operation) => {
    const current = smtpOperationTail.catch(() => {}).then(operation);
    smtpOperationTail = current.catch(() => {});
    return current;
  };
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
  return async function app(req, res) {
    setSecurityHeaders(res);
    if (req.method === 'OPTIONS') return noContent(res);
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
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
          const snapshot = smtpConfig?.getVerificationSnapshot?.();
          try {
            const status = await deliveryMailer.verify();
            const saved = await smtpConfig?.markVerified?.(snapshot);
            return { ok: true, ...status, lastVerifiedAt: saved?.lastVerifiedAt || new Date().toISOString() };
          } catch (error) {
            await smtpConfig?.markVerificationFailed?.(snapshot, error.code).catch(() => {});
            throw error;
          }
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/relay/status') {
        const configured = getRelayConfig();
        const requested = url.searchParams.get('port');
        const port = requested === null ? configured.port : Number(requested);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, errorBody('INVALID_PORT', 'Invalid relay port.'));
        const status = await probeRelay({ port, openClawConfigPath: config.openClawConfigPath });
        return json(res, status.ok ? 200 : 503, status);
      }
      if (req.method === 'POST' && url.pathname === '/api/relay/connect') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const configured = getRelayConfig();
        const requested = body?.port;
        const port = requested === undefined ? configured.port : Number(requested);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, errorBody('INVALID_PORT', 'Invalid relay port.'));
        const status = await relayConnector({
          port,
          openClawConfigPath: config.openClawConfigPath,
          managedBrowserDataDir: config.managedBrowserDataDir,
          profile: body?.profile || configured.profile,
        });
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
        const connection = await relayConnector({
          port,
          openClawConfigPath: config.openClawConfigPath,
          managedBrowserDataDir: config.managedBrowserDataDir,
          profile,
        });
        if (!connection.running || !connection.cdpReady) {
          return json(res, 503, { ...connection, ready: false, repaired: false, port, profile });
        }
        const recovery = await relayRecoverer({
          port,
          profile,
          openClawConfigPath: config.openClawConfigPath,
          pythonBin: config.pythonBin,
          connectionCheckScriptPath: config.relayConnectionCheckScriptPath,
        });
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
        const status = await relayConnector({
          port,
          openClawConfigPath: config.openClawConfigPath,
          managedBrowserDataDir: config.managedBrowserDataDir,
          profile,
        });
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
        const connection = await relayConnector({
          port: Number(configured.port),
          openClawConfigPath: config.openClawConfigPath,
          managedBrowserDataDir: config.managedBrowserDataDir,
          profile,
        });
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
          return serveCachedMedia(res, {
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
          return json(res, 200, await updateApplicationDraft(internal.outputDir, body));
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
      if (error instanceof ValidationError) return json(res, 400, errorBody('VALIDATION_ERROR', error.message, error.details));
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
      if (['SMTP_NOT_VERIFIED', 'SMTP_VERIFICATION_EXPIRED', 'SMTP_CONFIG_CONFLICT', 'EMAIL_SEND_STATUS_UNKNOWN', 'EMAIL_IDEMPOTENCY_CONFLICT'].includes(error.code)) {
        return json(res, 409, errorBody(error.code, error.message));
      }
      if (error.code === 'SMTP_RATE_LIMITED') return json(res, 429, errorBody(error.code, error.message));
      if (['SMTP_SENDER_REJECTED', 'SMTP_RECIPIENT_REJECTED'].includes(error.code)) return json(res, 422, errorBody(error.code, error.message));
      if (['MAIL_CONNECTION_FAILED', 'MAIL_SEND_FAILED', 'SMTP_AUTH_FAILED', 'SMTP_DNS_FAILED', 'SMTP_CONNECTION_TIMEOUT', 'SMTP_TLS_FAILED', 'SMTP_VERIFICATION_FAILED', 'SMTP_SEND_FAILED'].includes(error.code)) {
        return json(res, 502, errorBody(error.code, error.message));
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
  return {
    ...result,
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
      ? payload.records.map((record) => mergeApplicationState(
        hydrateApplicationMedia(record, legacyMedia.get(record.note_id)),
        delivery[record.note_id],
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
        return { filePath, modifiedAt: metadata.mtimeMs };
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
      if (payload && Array.isArray(payload.records)) return payload;
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
  const payload = JSON.parse(await readFile(path.join(outputDir, 'application_intelligence.json'), 'utf8'));
  const record = Array.isArray(payload.records) ? payload.records.find((item) => item.note_id === noteId) : null;
  if (!record) throw new ValidationError('Application record not found.');
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

async function updateDeliveryState(outputDir, value) {
  const noteId = String(value?.noteId || '').trim();
  const action = String(value?.action || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  if (!['ready_to_apply', 'ready_to_message', 'applied', 'messaged', 'reset'].includes(action)) {
    throw new ValidationError('Invalid delivery action.');
  }
  await readApplicationRecord(outputDir, noteId);
  const state = await readDeliveryState(outputDir);
  if (action === 'reset') delete state[noteId];
  else state[noteId] = { ...state[noteId], action, updatedAt: new Date().toISOString() };
  await writeDeliveryState(outputDir, state);
  return { noteId, delivery: publicDeliveryState(state[noteId]) };
}

async function updateApplicationDraft(outputDir, value) {
  const noteId = String(value?.noteId || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  await readApplicationRecord(outputDir, noteId);
  const draft = normalizeDraft(value?.outreach);
  const state = await readDeliveryState(outputDir);
  state[noteId] = {
    ...state[noteId],
    action: 'draft_saved',
    updatedAt: new Date().toISOString(),
    draft,
  };
  await writeDeliveryState(outputDir, state);
  return { noteId, outreach: draft, delivery: publicDeliveryState(state[noteId]) };
}

async function sendApplicationEmail(outputDir, value, mailer, replyTo, smtpConfig) {
  const noteId = String(value?.noteId || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  const record = await readApplicationRecord(outputDir, noteId);
  const qualityThreshold = Math.max(90, Number(record.cover_letter_evaluation?.threshold || 90));
  if (!record.cover_letter_evaluation?.passed || Number(record.cover_letter_evaluation?.score || 0) < qualityThreshold) {
    throw new ValidationError(`Cover Letter must pass the ${qualityThreshold}-point quality gate before delivery.`);
  }
  const extracted = extractedEmails(record);
  const requested = String(value?.to || '').trim().toLowerCase();
  const to = extracted.find((item) => item.toLowerCase() === requested) || (!requested ? extracted[0] : '');
  if (!to) throw new ValidationError('Recipient must be an email extracted from this application record.');

  let smtpState = assertSmtpVerified(mailer, smtpConfig);
  const state = await readDeliveryState(outputDir);
  const draft = normalizeDraft(value?.outreach || state[noteId]?.draft || record.outreach);
  if (!draft.email_subject || !draft.email_body) throw new ValidationError('Email subject and body are required.');
  validateDeliveryDraft(draft, record);
  const existing = state[noteId] || {};
  const requestKey = normalizeEmailIdempotencyKey(value?.idempotencyKey);
  const draftId = String(value?.draftId || existing.draftId || `legacy:${noteId}`);
  const draftVersion = Number(value?.version || value?.draftVersion || existing.draftVersion?.version || existing.draftVersion || 1);
  const contentHash = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
  const idempotencyKey = createHash('sha256').update(JSON.stringify({
    configHash: smtpState.configHash || '',
    credentialRevision: smtpState.credentialRevision ?? null,
    draftId,
    draftVersion,
    contentHash,
    recipient: to.toLowerCase(),
  })).digest('hex');
  const priorAudits = Array.isArray(existing.sendAudit) ? existing.sendAudit : [];
  const requestKeyAudit = requestKey ? priorAudits.find((audit) => audit.requestKey === requestKey) : null;
  if (requestKeyAudit && requestKeyAudit.idempotencyKey !== idempotencyKey) {
    throw emailDeliveryError('EMAIL_IDEMPOTENCY_CONFLICT', 'The email idempotency key was already used for different content.');
  }
  const completed = priorAudits.find((audit) => audit.idempotencyKey === idempotencyKey && audit.status === 'sent');
  if (completed) {
    const duplicateAt = new Date().toISOString();
    const duplicateAudit = buildSendAudit({
      status: 'duplicate', draftId, draftVersion, contentHash, idempotencyKey,
      requestKey, recipient: to, timestamp: duplicateAt, smtpState, errorCode: 'EMAIL_DUPLICATE_SEND',
    });
    state[noteId] = {
      ...existing,
      sendAudit: [...priorAudits, duplicateAudit],
      updatedAt: duplicateAt,
    };
    await writeDeliveryState(outputDir, state);
    return {
      noteId,
      outreach: draft,
      delivery: publicDeliveryState(state[noteId]),
      duplicate: true,
      code: 'EMAIL_DUPLICATE_SEND',
      sendIdempotencyKey: idempotencyKey,
    };
  }
  if (existing.pendingSend) {
    throw emailDeliveryError('EMAIL_SEND_STATUS_UNKNOWN', 'A previous persisted send intent has no final delivery result.');
  }
  const verificationSnapshot = smtpConfig?.getVerificationSnapshot?.() || smtpState;
  try {
    await mailer.verify();
  } catch (error) {
    await smtpConfig?.markVerificationFailed?.(verificationSnapshot, error.code).catch(() => {});
    const failedAt = new Date().toISOString();
    const audit = buildSendAudit({
      status: 'failed', draftId, draftVersion, contentHash, idempotencyKey,
      requestKey, recipient: to, timestamp: failedAt, smtpState, errorCode: error.code || 'SMTP_VERIFICATION_FAILED',
    });
    state[noteId] = {
      ...existing,
      draft,
      action: 'email_failed',
      updatedAt: failedAt,
      email: { status: 'failed', to, failedAt, errorCode: error.code || 'SMTP_VERIFICATION_FAILED' },
      sendAudit: [...priorAudits, audit],
    };
    await writeDeliveryState(outputDir, state);
    throw error;
  }
  const refreshedVerification = await smtpConfig?.markVerified?.(verificationSnapshot);
  if (refreshedVerification) {
    smtpState = {
      ...smtpState,
      configHash: refreshedVerification.configHash || smtpState.configHash,
      credentialRevision: refreshedVerification.credentialRevision ?? smtpState.credentialRevision,
      verificationStatus: refreshedVerification.verificationStatus || 'verified',
    };
  }
  const pendingAt = new Date().toISOString();
  state[noteId] = {
    ...existing,
    draft,
    updatedAt: pendingAt,
    pendingSend: { idempotencyKey, draftId, draftVersion, contentHash, recipient: maskEmail(to), createdAt: pendingAt },
  };
  await writeDeliveryState(outputDir, state);
  try {
    const sent = await mailer.send({
      to,
      subject: draft.email_subject,
      text: draft.email_body,
      replyTo: EMAIL.test(replyTo) ? replyTo : '',
      ...(Array.isArray(value?.attachments) ? { attachments: value.attachments } : {}),
    });
    const sentAt = new Date().toISOString();
    const audit = buildSendAudit({
      status: 'sent', draftId, draftVersion, contentHash, idempotencyKey,
      requestKey, recipient: to, timestamp: sentAt, smtpState,
    });
    state[noteId] = {
      ...state[noteId],
      action: 'email_sent',
      updatedAt: sentAt,
      email: {
        status: 'sent',
        to,
        sentAt,
        messageId: sent.messageId || '',
      },
      sendAudit: [...priorAudits, audit],
    };
    delete state[noteId].pendingSend;
    await writeDeliveryState(outputDir, state);
    return {
      noteId,
      outreach: draft,
      delivery: publicDeliveryState(state[noteId]),
      duplicate: false,
      sendIdempotencyKey: idempotencyKey,
    };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const status = error.deliveryStatus === 'unknown' ? 'unknown' : 'failed';
    const audit = buildSendAudit({
      status, draftId, draftVersion, contentHash, idempotencyKey,
      requestKey, recipient: to, timestamp: failedAt, smtpState, errorCode: error.code || 'SMTP_SEND_FAILED',
    });
    state[noteId] = {
      ...state[noteId],
      action: 'email_failed',
      updatedAt: failedAt,
      email: { status, to, failedAt, errorCode: error.code || 'SMTP_SEND_FAILED' },
      sendAudit: [...priorAudits, audit],
    };
    if (status !== 'unknown') delete state[noteId].pendingSend;
    await writeDeliveryState(outputDir, state);
    throw error;
  }
}

function assertSmtpVerified(mailer, smtpConfig) {
  if (smtpConfig?.assertReadyForSend) return smtpConfig.assertReadyForSend();
  const configured = mailer.status?.().configured;
  const saved = smtpConfig?.getPublic?.() || {};
  if (!configured) throw emailDeliveryError('SMTP_NOT_CONFIGURED', '请先配置 SMTP 邮件发送。');
  if (!(saved.verified ?? Boolean(saved.lastVerifiedAt))) {
    throw emailDeliveryError('SMTP_NOT_VERIFIED', '当前 SMTP 配置尚未通过连接验证。');
  }
  return {
    configHash: saved.configHash || '',
    credentialRevision: saved.credentialRevision ?? null,
    verificationStatus: 'verified',
  };
}

function normalizeEmailIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new ValidationError('idempotencyKey must be a non-empty string of at most 200 characters.');
  }
  return value.trim();
}

function buildSendAudit({ status, draftId, draftVersion, contentHash, idempotencyKey, requestKey, recipient, timestamp, smtpState, errorCode = '' }) {
  return {
    status,
    recipient: maskEmail(recipient),
    draftId,
    draftVersion,
    contentHash,
    idempotencyKey,
    requestKey,
    timestamp,
    configHash: smtpState.configHash || '',
    credentialRevision: smtpState.credentialRevision ?? null,
    errorCode,
  };
}

function maskEmail(value) {
  const match = String(value || '').match(/^(.)([^@]*)(@.+)$/);
  return match ? `${match[1]}***${match[3]}` : '';
}

function emailDeliveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeDraft(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const limits = { greeting: 2000, email_subject: 240, email_body: 20000, cover_letter: 20000 };
  const draft = {};
  for (const [field, limit] of Object.entries(limits)) {
    const text = String(source[field] || '').trim();
    if (text.length > limit) throw new ValidationError(`${field} is too long.`);
    draft[field] = text;
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
  const values = routes.flatMap((route) => `${route?.value || ''}\n${route?.evidence || ''}`.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []);
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function mergeApplicationState(record, state) {
  if (!state) return { ...record, delivery: null };
  return {
    ...record,
    outreach: { ...record.outreach, ...(state.draft || {}) },
    delivery: publicDeliveryState(state),
  };
}

function publicDeliveryState(state) {
  if (!state) return null;
  const { draft, ...publicState } = state;
  return publicState;
}

async function writeDeliveryState(outputDir, state) {
  const target = path.join(outputDir, 'delivery-state.json');
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporary, target);
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
  return {
    ...saved,
    configured: status.configured,
    verified: saved.verified ?? Boolean(saved.lastVerifiedAt),
    maskedFrom: status.from,
    authMode: status.authMode,
  };
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
