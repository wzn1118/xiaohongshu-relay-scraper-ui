import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { assertPathInside, enumerateArtifacts, resolveDownload } from './lib/artifacts.mjs';
import { ValidationError, validateAudienceGrowthRequest, validateExpansionCancelRequest, validateExpansionResumeRequest, validateExpansionStartRequest, validateRunRequest } from './lib/contracts.mjs';
import { validateBodyImportRequest } from './lib/body-import.mjs';
import { probeRelay } from './lib/relay.mjs';
import { connectRelay, openRelayLogin } from './lib/relay-connect.mjs';
import { setupRelayRuntime } from './lib/relay-setup.mjs';
import { recoverRelay } from './lib/relay-recovery.mjs';
import { createRelaySupervisor } from './lib/relay-supervisor.mjs';
import { isIncompleteApplicationRecord, isIncompleteGeneralRecord } from './lib/application-records.mjs';
import { readAudienceResults } from './lib/audience-results.mjs';
import { readExpansionSeeds, readExpansionSnapshot } from './lib/expansion-results.mjs';
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
import { createCoverLetterRewriter } from './lib/cover-letter-rewriter.mjs';
import { normalizeDiagnosticRoute } from './lib/diagnostics.mjs';
import {
  AttachmentError,
  attachmentLimits,
  buildEmailPreview,
  createApplicationAttachment,
  deleteApplicationAttachment,
  discardSendBundle,
  finalizeSendBundle,
  listApplicationAttachments,
  prepareSendBundle,
  readApplicationAttachmentUpload,
  readFinalizedSendBundle,
  resolveApplicationAttachmentDownload,
  resolveApplicationAttachments,
  resolveSelectedApplicationAttachments,
  sealPreparedSendBundle,
  updateApplicationAttachment,
  withApplicationDeliveryLock,
} from './lib/application-attachments.mjs';
import { DEFAULT_RELAY_CONFIG } from './relay-config-store.mjs';
import { createPreflightService } from './preflight-service.mjs';
import { AudienceAiService } from './audience-ai-service.mjs';
import { createAudienceAiProfileRunner } from './lib/audience-ai-profile-runner.mjs';
import { handleDataCopilotRequest } from './data-copilot-http.mjs';
import { handleMcpManagementRequest } from './mcp-management-http.mjs';
import { writeCopilotJsonAtomically } from './data-copilot-store.mjs';
import { ApplicationBatchManager } from './application-batch-manager.mjs';
import { ApplicationBatchService, ApplicationBatchServiceError } from './application-batch-service.mjs';
import {
  ApplicationDeliveryCandidateError,
  normalizeApplicationDeliveryCandidateLimit,
  buildApplicationDeliveryCandidates,
  withResolvedApplicationSubject,
} from './application-delivery-candidates.mjs';
import { ApplicationContactOcrService } from './application-contact-ocr-service.mjs';
import { ApplicationContactResolutionService } from './application-contact-resolution-service.mjs';
import { detectApplicationAttachmentRule } from './lib/application-attachment-rule.mjs';
import {
  applicationContactSourceRevision,
  enrichApplicationRecordContacts,
  resolveApplicationContactsBatch,
} from './lib/application-contact-resolver.mjs';
import {
  MAX_APPLICATION_EMAIL_SUBJECT_LENGTH,
  normalizeApplicationRoleTitle,
  resolveApplicationEmailSubject,
} from './lib/application-email-draft.mjs';
import { classifyApplicationSource } from './lib/application-source-disposition.mjs';
import { createCodexHostCommandService } from './codex-host-command-service.mjs';
import { createCodexConnectService } from './codex-connect-service.mjs';
import { TOOL_DEFINITIONS as CODEX_PRODUCT_TOOL_DEFINITIONS } from './codex-product-service.mjs';
import { TOOL_DEFINITIONS as XHS_CONTEXT_TOOL_DEFINITIONS } from './xhs-context-service.mjs';
import { createCodexSourceArchive } from './codex-source-archive.mjs';

const INTERNAL_COVER_LETTER_TOKEN = /(?<![\w])(?:exp|resume|evidence)[_-][A-Za-z0-9][A-Za-z0-9_-]{3,}(?![\w])/i;
import {
  AudienceAiValidationError,
  validateAudienceAiEmptyRequest,
  validateAudienceAiPreviewRequest,
  validateAudienceAiResultsQuery,
  validateAudienceAiStartRequest,
} from './lib/audience-ai-contracts.mjs';

export { isIncompleteApplicationRecord, isIncompleteGeneralRecord } from './lib/application-records.mjs';

const JOB_ID = /^[0-9]{14}-[a-f0-9]{8}$/;
const RESUME_SCOPES = new Set(['full', 'discovery', 'body_completion', 'analysis', 'audience', 'artifacts']);
const ACTIVE_JOB_STATUSES = new Set(['queued', 'resuming', 'running']);
const NOTE_ID = /^[\p{L}\p{N}_.:-]{1,160}$/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i;
const MEDIA_CACHE_MAX_BYTES = 15 * 1024 * 1024;
const MEDIA_CACHE_TIMEOUT_MS = 15_000;
const APPLICATION_ATTACHMENT_MEDIA_TYPES = Object.freeze({
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
});
const APPLICATION_RECORD_INDEX = Symbol('applicationRecordIndex');

export function createPersistentSmtpSendGate({
  filePath,
  withLock = async (operation) => operation(),
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const target = String(filePath || '').trim();
  if (!target) throw smtpSendGateError('SMTP_SEND_GATE_PATH_REQUIRED', 'SMTP send gate path is required.');
  if (typeof withLock !== 'function' || typeof now !== 'function' || typeof sleep !== 'function') {
    throw smtpSendGateError('SMTP_SEND_GATE_CONFIG_INVALID', 'SMTP send gate callbacks are invalid.');
  }
  const resolvedPath = path.resolve(target);
  const acquire = async (rawMinIntervalMs = 0) => {
    const parsedInterval = Number(rawMinIntervalMs);
    const minIntervalMs = Number.isSafeInteger(parsedInterval)
      ? Math.min(60_000, Math.max(0, parsedInterval))
      : 0;
    const scheduledAtMs = await withLock(async () => {
      const currentMs = smtpSendGateClock(now);
      const state = await readSmtpSendGateState(resolvedPath);
      const scheduled = Math.max(currentMs, state?.nextAllowedAtMs || 0);
      await writeCopilotJsonAtomically(resolvedPath, {
        schemaVersion: 1,
        nextAllowedAt: new Date(scheduled + minIntervalMs).toISOString(),
        reservedAt: new Date(currentMs).toISOString(),
        minIntervalMs,
      });
      return scheduled;
    });
    const waitMs = Math.max(0, scheduledAtMs - smtpSendGateClock(now));
    if (waitMs > 0) await sleep(waitMs);
    return {
      scheduledAt: new Date(scheduledAtMs).toISOString(),
      minIntervalMs,
      waitedMs: waitMs,
    };
  };
  return { filePath: resolvedPath, acquire };
}

async function readSmtpSendGateState(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw smtpSendGateError('SMTP_SEND_GATE_READ_FAILED', 'SMTP send gate state could not be read.', error);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw smtpSendGateError('SMTP_SEND_GATE_STATE_INVALID', 'SMTP send gate state is invalid JSON.', error);
  }
  const nextAllowedAtMs = Date.parse(String(value?.nextAllowedAt || ''));
  if (value?.schemaVersion !== 1 || !Number.isFinite(nextAllowedAtMs)) {
    throw smtpSendGateError('SMTP_SEND_GATE_STATE_INVALID', 'SMTP send gate state is invalid.');
  }
  return { nextAllowedAtMs };
}

function smtpSendGateClock(now) {
  const value = now();
  const milliseconds = (value instanceof Date ? value : new Date(value)).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw smtpSendGateError('SMTP_SEND_GATE_CLOCK_INVALID', 'SMTP send gate clock returned an invalid value.');
  }
  return milliseconds;
}

function smtpSendGateError(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  error.status = 500;
  error.safeToRetry = true;
  error.deliveryStatus = 'not_sent';
  return error;
}
const APPLICATION_ARTIFACT_FILENAME = Symbol('applicationArtifactFilename');
const APPLICATION_CONTACT_OCR_OVERLAY = 'application-contact-ocr.json';
const CONTENT_RESEARCH_LABELS = Object.freeze({
  auto: 'AI 自动识别',
  experience: '经验攻略',
  people: '人群与风格',
  trend: '趋势观察',
  product: '产品口碑',
  place: '地点清单',
  custom: '自定义研究',
});

export function contactOcrDrainState(state) {
  if (!state || typeof state !== 'object') return { ready: false, signature: '' };
  const report = state.report && typeof state.report === 'object' ? state.report : {};
  const queue = report.queue && typeof report.queue === 'object' ? report.queue : {};
  const processed = Number(queue.processed || 0);
  const total = Number(queue.total || 0);
  const status = String(state.status || '');
  const queueDrained = total === 0 || processed >= total;
  const terminal = !state.active && ['completed', 'partial', 'failed', 'interrupted'].includes(status);
  const watcherCaughtUp = status === 'watching' && Boolean(report.finishedAt) && queueDrained;
  const ready = state.sourceArtifactChanged !== true && (terminal || watcherCaughtUp);
  return {
    ready,
    signature: ready
      ? `${String(state.sourceArtifactModifiedAt || '')}:${String(report.finishedAt || '')}:${processed}:${total}`
      : '',
  };
}

export function createApp({ manager, config, aiSessions, profileStore, relayConfig, smtpConfig, mailSender, localModels, relayConnector = connectRelay, relayLoginOpener = openRelayLogin, relaySetup = setupRelayRuntime, relayRecoverer = recoverRelay, relaySupervisor, preflightService, dataLifecycle, mediaFetcher = globalThis.fetch, draftQualityChecker, coverLetterRewriter, deliveryStateWriter = writeDeliveryState, sendAuditAppender = appendSendAuditJournal, sendAuditReader = readSendAuditJournal, diagnostics, audienceAiService, applicationContactOcrService, applicationContactResolutionService, dataCopilotService, codexDesktopService, codexBrowserService, codexProductService, codexProductWorkspaceService, codexModelBridgeService, codexRelayService, codexHostCommandService, codexHostRpcService, codexRuntimeCompatibility, codexNativeMirrorService, codexDeviceGatewayService, codexConnectService, xhsContextService, mcpAccessService, authStore }) {
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
  const codexHostCommands = codexHostCommandService || createCodexHostCommandService({
    config,
    codexBrowserService,
    relayService: codexRelayService,
  });
  const codexConnect = codexConnectService || (codexDeviceGatewayService?.createPairingIntent && codexDeviceGatewayService?.claimPairing
    ? createCodexConnectService({
      deviceGatewayService: codexDeviceGatewayService,
      allowedOrigins: config.codexConnectAllowedOrigins?.length
        ? config.codexConnectAllowedOrigins
        : (config.authOrigin ? [config.authOrigin] : []),
      connectorVersion: config.codexConnectConnectorVersion || '1.2.3',
    })
    : null);
  let codexConnectInstallerCache = null;
  const deliveryAttachmentLimits = attachmentLimits(config);
  const checkDraftQuality = draftQualityChecker || createDraftQualityChecker({
    pythonBin: config.pythonBin || (process.platform === 'win32' ? 'python' : 'python3'),
    scriptPath: path.join(config.projectRoot || process.cwd(), 'scripts', 'recheck_application_draft.py'),
  });
  const runCoverLetterRewrite = coverLetterRewriter || createCoverLetterRewriter({
    pythonBin: config.pythonBin || (process.platform === 'win32' ? 'python' : 'python3'),
    scriptPath: path.join(config.projectRoot || process.cwd(), 'scripts', 'rewrite_cover_letter.py'),
  });
  const audienceAi = audienceAiService || new AudienceAiService({
    manager,
    aiSessions,
    config,
    profileEnricher: createAudienceAiProfileRunner({ manager, config, getRelayConfig }),
  });
  const applicationContactOcr = applicationContactOcrService || new ApplicationContactOcrService({ config });
  const applicationContactResolution = applicationContactResolutionService || new ApplicationContactResolutionService({
    loadRecords: readApplicationContactRecords,
    resolveBatch: resolveApplicationContactsBatch,
    buildReport: applicationContactResolutionReport,
  });
  const contactResolutionFallbackDirs = (jobId, outputDir) => audienceHistoryJobIds(
    manager,
    audienceContentSourceJobId(manager, jobId),
    jobId,
  )
    .map((historyJobId) => manager.getInternal?.(historyJobId)?.outputDir)
    .filter((historyOutputDir) => historyOutputDir && path.resolve(historyOutputDir) !== path.resolve(outputDir));

  const assertDirectRecipientEvidence = async (jobId, internal, body) => {
    const requestedAddress = String(body?.to || '').trim().toLowerCase();
    if (!requestedAddress) return null;
    const suppliedEvidenceHash = String(body?.evidenceHash || '').trim();
    const suppliedSourceRevision = String(body?.sourceRevision || '').trim();
    if (!suppliedEvidenceHash || !suppliedSourceRevision) {
      const error = applicationDraftError(
        'EMAIL_RECIPIENT_EVIDENCE_REQUIRED',
        'Recipient evidenceHash and sourceRevision are required.',
      );
      error.status = 400;
      throw error;
    }
    const noteId = String(body?.noteId || '').trim();
    const cachedResolution = await applicationContactResolution.refresh({
      outputDir: internal.outputDir,
      fallbackOutputDirs: contactResolutionFallbackDirs(jobId, internal.outputDir),
      task: internal,
    });
    const reportItem = (Array.isArray(cachedResolution?.report?.items) ? cachedResolution.report.items : [])
      .find((item) => String(item?.noteId || '') === noteId);
    const candidate = (Array.isArray(reportItem?.candidates) ? reportItem.candidates : []).find((item) => (
      item?.actionable !== false && String(item?.address || '').trim().toLowerCase() === requestedAddress
    ));
    const currentSourceRevision = candidate
      ? String(candidate.sourceRevision || applicationContactSourceRevision(candidate))
      : '';
    if (
      !candidate
      || candidate.evidenceHash !== suppliedEvidenceHash
      || currentSourceRevision !== suppliedSourceRevision
    ) {
      const error = applicationDraftError(
        'EMAIL_RECIPIENT_EVIDENCE_STALE',
        'Recipient evidence changed after it was displayed. Refresh the recipient before sending.',
      );
      error.status = 409;
      throw error;
    }
    return candidate;
  };

  const refreshSupervisedContactResolution = () => {
    const active = manager.active;
    const activeInternal = active?.id ? (manager.getInternal?.(active.id) || active) : null;
    const targetIds = new Set();
    if (activeInternal?.id && activeInternal.params?.analysisMode !== 'general') {
      if (activeInternal.params?.audienceOnly === true) {
        targetIds.add(audienceContentSourceJobId(manager, activeInternal.id));
      } else {
        targetIds.add(activeInternal.id);
      }
    }
    for (const targetId of targetIds) {
      const internal = manager.getInternal?.(targetId);
      if (!internal?.outputDir || internal.params?.analysisMode === 'general' || internal.params?.audienceOnly === true) continue;
      void applicationContactResolution.refresh({
        outputDir: internal.outputDir,
        fallbackOutputDirs: contactResolutionFallbackDirs(targetId, internal.outputDir),
        task: internal,
      }).catch(() => {});
    }
  };
  // Keep image contact OCR attached to the active collection. The results
  // endpoint remains a read path; opening the UI is no longer required to
  // start recognition. The worker watches collection snapshots and is stopped
  // as soon as the owning collection leaves the active slot.
  const supervisedContactOcrDirs = new Set();
  const contactOcrDrainCandidates = new Map();
  const contactOcrDrainGraceMs = 3000;
  const contactOcrSupervisor = setInterval(() => {
    if (config.applicationContactOcrEnabled !== true) return;
    const active = manager.active;
    const activeOutputDir = active?.outputDir && active?.params?.analysisMode !== 'general'
      ? path.resolve(active.outputDir)
      : null;
    if (activeOutputDir) {
      supervisedContactOcrDirs.add(activeOutputDir);
      contactOcrDrainCandidates.delete(activeOutputDir);
      void applicationContactOcr.ensureStarted(activeOutputDir, {
        watch: true,
        pollSeconds: 1,
        retryPartial: true,
      }).catch(() => {});
    }
    refreshSupervisedContactResolution();
    for (const outputDir of [...supervisedContactOcrDirs]) {
      if (outputDir === activeOutputDir) continue;
      // Collection can finish while the last OCR snapshot is still being
      // processed. Keep the watcher alive until its report has drained the
      // queue (or exhausted bounded retries); only then reclaim the child.
      void (async () => {
        const state = await applicationContactOcr.getState?.(outputDir);
        if (!state) return;
        const drain = contactOcrDrainState(state);
        if (!drain.ready) {
          contactOcrDrainCandidates.delete(outputDir);
          if (!state.active && state.sourceAvailable) {
            await applicationContactOcr.ensureStarted(outputDir, {
              watch: true,
              pollSeconds: 1,
              retryPartial: true,
            }).catch(() => {});
          }
          return;
        }
        const candidate = contactOcrDrainCandidates.get(outputDir);
        if (!candidate || candidate.signature !== drain.signature) {
          contactOcrDrainCandidates.set(outputDir, { signature: drain.signature, since: Date.now() });
          return;
        }
        if (Date.now() - candidate.since < contactOcrDrainGraceMs) return;
        const confirmed = contactOcrDrainState(await applicationContactOcr.getState?.(outputDir));
        if (!confirmed.ready || confirmed.signature !== candidate.signature) {
          contactOcrDrainCandidates.delete(outputDir);
          return;
        }
        supervisedContactOcrDirs.delete(outputDir);
        contactOcrDrainCandidates.delete(outputDir);
        const stopping = applicationContactOcr.stop?.(outputDir, 'collection_finished');
        if (stopping && typeof stopping.catch === 'function') await stopping.catch(() => {});
      })().catch(() => {});
    }
  }, 1500);
  contactOcrSupervisor.unref?.();
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
  const smtpSendGate = String(config?.smtpConfigPath || '').trim()
    ? createPersistentSmtpSendGate({
        filePath: path.join(path.dirname(config.smtpConfigPath), 'smtp-send-gate.json'),
        withLock: withSmtpOperationLock,
      })
    : null;
  const resolveCandidateProfile = async (internal) => {
    const basic = internal?.params?.candidateProfile
      && typeof internal.params.candidateProfile === 'object'
      && !Array.isArray(internal.params.candidateProfile)
      ? internal.params.candidateProfile
      : {};
    const profileId = String(internal?.params?.profileId || '').trim();
    if (!profileId || typeof profileStore?.get !== 'function') return { ...basic };
    const stored = await profileStore.get(profileId);
    return {
      ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}),
      ...basic,
      profileId,
    };
  };
  const applicationBatchServices = new Map();
  const getApplicationBatchService = async (jobId, internal) => {
    const cacheKey = path.resolve(internal.outputDir);
    if (!applicationBatchServices.has(cacheKey)) {
      const pending = (async () => {
        const batchManager = new ApplicationBatchManager({ rootDir: internal.outputDir });
        await batchManager.initialize();
        const candidateProfile = await resolveCandidateProfile(internal);
        const fallbackOutputDirs = audienceHistoryJobIds(
          manager,
          audienceContentSourceJobId(manager, jobId),
          jobId,
        )
          .map((historyJobId) => manager.getInternal(historyJobId)?.outputDir)
          .filter((outputDir) => outputDir && path.resolve(outputDir) !== cacheKey);
          const loadRecord = async (noteId) => {
            const records = (await readApplicationContactRecords(internal.outputDir, internal))
              .map(withApplicationAttachmentRequirement)
              .map(withResolvedApplicationSubject);
            const record = records.find((item) => String(item?.note_id || '') === String(noteId));
            if (!record) {
              const error = new Error(`Application record not found: ${noteId}`);
              error.code = 'APPLICATION_RECORD_NOT_FOUND';
              throw error;
            }
            try {
              const cachedResolution = await applicationContactResolution.refresh({
                outputDir: internal.outputDir,
                fallbackOutputDirs,
                task: internal,
              });
              const reportItem = (Array.isArray(cachedResolution?.report?.items)
                ? cachedResolution.report.items
                : [])
                .find((item) => String(item?.noteId || '') === String(noteId));
              return {
                ...record,
                contactDiscovery: reportItem || null,
              };
            } catch {
              return { ...record, contactDiscovery: null };
            }
          };
        const replyTo = String(internal.params?.candidateProfile?.email || '').trim();
        return new ApplicationBatchService({
          jobId,
          outputDir: internal.outputDir,
          manager: batchManager,
          candidateProfile,
          fallbackOutputDirs,
          loadRecord,
          listAttachments: (noteId) => listApplicationAttachments(
            internal.outputDir,
            noteId,
            deliveryAttachmentLimits,
          ),
          renameAttachment: (attachmentId, displayName) => mutateApplicationAttachments(
            internal.outputDir,
            deliveryStateWriter,
            () => updateApplicationAttachment(
              internal.outputDir,
              attachmentId,
              { displayName },
              deliveryAttachmentLimits,
            ),
          ),
          checkQuality: async (noteId, attachmentIds, aiSessionId) => {
            const record = await loadRecord(noteId);
            const ai = resolveDraftAiRuntime(aiSessions, internal, { aiSessionId });
            return recheckApplicationDraft(
              internal.outputDir,
              {
                noteId,
                draftId: record.draftVersion?.draftId,
                version: record.draftVersion?.version,
                attachmentIds,
              },
              checkDraftQuality,
              ai,
              candidateProfile,
              deliveryStateWriter,
              deliveryAttachmentLimits,
            );
          },
          previewEmail: (value, allowedRecipients) => previewApplicationEmail(
            internal.outputDir,
            value,
            replyTo,
            deliveryMailer,
            smtpConfig,
            deliveryAttachmentLimits,
            deliveryStateWriter,
            { allowedRecipients, persist: value?.persist !== false },
          ),
          sendEmail: (value, allowedRecipients) => withSmtpOperationLock(() => sendApplicationEmail(
            internal.outputDir,
            value,
            deliveryMailer,
            replyTo,
            smtpConfig,
            {
              writeState: deliveryStateWriter,
              appendAudit: sendAuditAppender,
              readAudit: sendAuditReader,
              attachmentLimits: deliveryAttachmentLimits,
              allowedRecipients,
            },
          )),
          acquireSendSlot: smtpSendGate?.acquire,
        });
      })().catch((error) => {
        applicationBatchServices.delete(cacheKey);
        throw error;
      });
      applicationBatchServices.set(cacheKey, pending);
    }
    return applicationBatchServices.get(cacheKey);
  };
  return async function app(req, res) {
    const requestStartedAt = performance.now();
    const requestId = diagnostics?.requestId?.(req.headers['x-request-id']);
    if (requestId) res.setHeader('X-Request-Id', requestId);
    const requestOrigin = String(req.headers.origin || '').trim();
    setSecurityHeaders(res, config, requestOrigin);
    const secureRedirect = resolveSecurePublicRedirect(req, config);
    if (secureRedirect) {
      res.writeHead(301, { Location: secureRedirect, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const originError = validateRequestOrigin(req, config, { preflight: req.method === 'OPTIONS' });
    if (req.method === 'OPTIONS') {
      if (originError) return json(res, originError.status, errorBody(originError.code, originError.message));
      return noContent(res);
    }
    if (originError && isStateChangingMethod(req.method)) {
      return json(res, originError.status, errorBody(originError.code, originError.message));
    }
    const url = new URL(req.url, 'http://localhost');
    if (
      url.pathname === '/codex'
      || url.pathname.startsWith('/codex/')
      || url.pathname === '/codex-native-mirror.html'
      || url.pathname === '/codex-native-mirror.js'
      || url.pathname === '/codex-native-mirror.css'
    ) {
      setCodexBrowserSecurityHeaders(req, res, config);
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const authUser = authStore?.authenticate(req) || null;
    const trustedCopilotLocal = isLoopbackAddress(req.socket?.remoteAddress)
      && isLoopbackHost(req.headers.host);
    const localOwnerActor = !authStore?.required && trustedCopilotLocal
      ? { id: 'local-owner', roles: ['owner'] }
      : null;
    const noAuthPresentationOwner = !authStore?.required
      && String(authUser?.email || '').trim().toLowerCase() === 'local'
      && Array.isArray(authUser?.roles)
      && authUser.roles.map((role) => String(role).toLowerCase()).includes('owner')
      ? { id: 'local-owner', roles: ['owner'] }
      : null;
    // In no-auth desktop mode the auth store exposes a presentation user with
    // an email but no stable actor id. Prefer the server-derived loopback
    // owner for Copilot authority, and retain email as an identity fallback
    // for authenticated stores that similarly omit an id field.
    const copilotActor = localOwnerActor || noAuthPresentationOwner || authUser;
    const copilotRoles = Array.isArray(copilotActor?.roles)
      ? copilotActor.roles.map((role) => String(role).toLowerCase())
      : [];
    const copilotSecurityContext = {
      actorId: String(copilotActor?.id || copilotActor?.email || '').trim(),
      trustedLocal: trustedCopilotLocal,
      ownerLocal: trustedCopilotLocal
        && config.copilotApprovalMode === 'never'
        && copilotRoles.includes('owner'),
    };
    const codexOwnerId = String(copilotActor?.id || copilotActor?.email || localOwnerActor?.id || '').trim();
    res.once('finish', () => diagnostics?.record?.('http_request_completed', {
      requestId,
      method: req.method,
      route: normalizeDiagnosticRoute(url.pathname),
      statusCode: res.statusCode,
      durationMs: performance.now() - requestStartedAt,
    }));
    try {
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        return json(res, 200, { authenticated: Boolean(authUser), required: Boolean(authStore?.required), user: authUser });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        if (!authStore) return json(res, 503, errorBody('AUTH_UNAVAILABLE', '认证服务未配置。'));
        const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 64 * 1024));
        const user = await authStore.login(body.email, body.password);
        authStore.setSession(res, user);
        return json(res, 200, { authenticated: true, required: true, user });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        authStore?.clearSession(res);
        return json(res, 200, { authenticated: false });
      }
    const publicApiRoutes = new Set(['/api/auth/me', '/api/auth/login', '/api/auth/logout', '/api/health', '/api/xhs-context/mcp', '/api/codex-product/mcp', '/api/codex-model/v1/responses', '/api/codex-relay/device-claims', '/api/codex-connect/installer', '/api/codex-connect/manifest']);
      const deviceCredentialRoute = req.method === 'POST' && /^\/api\/codex-relay\/devices\/[^/]+\/heartbeat$/u.test(url.pathname);
      const codexConnectClaimRoute = req.method === 'POST' && /^\/api\/codex-connect\/intents\/[^/]+\/claim$/u.test(url.pathname);
      const mirrorCredentialRoute = /^\/api\/codex-native-mirror\/sessions\/mirror-[A-Za-z0-9-]{8,140}(?:\/.*)?$/u.test(url.pathname)
        && String(req.headers['x-codex-mirror-role'] || '').length > 0
        && String(req.headers['x-codex-mirror-token'] || '').length > 0;
      if (authStore?.required && url.pathname.startsWith('/api/') && !publicApiRoutes.has(url.pathname) && !deviceCredentialRoute && !codexConnectClaimRoute && !mirrorCredentialRoute) {
        if (!authUser) return json(res, 401, errorBody('AUTH_REQUIRED', '请先登录后再访问此功能。'));
        if (config.authOrigin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
          const origin = String(req.headers.origin || '').trim();
          const trustedLoopbackOrigin = trustedCopilotLocal && Boolean(loopbackOrigin(origin));
          if (origin && origin !== config.authOrigin && !trustedLoopbackOrigin) return json(res, 403, errorBody('CSRF_ORIGIN_REJECTED', '请求来源未通过校验。'));
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/diagnostics/bundle') {
        if (!diagnostics?.bundle) return json(res, 503, errorBody('DIAGNOSTICS_UNAVAILABLE', 'Diagnostics are unavailable.'));
        return json(res, 200, diagnostics.bundle());
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        if (authStore?.required && !authUser) {
          return json(res, 200, { ok: true, service: 'xiaohongshu-relay-scraper', authRequired: true, timestamp: new Date().toISOString() });
        }
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
          audienceAi: {
            enabled: config.audienceAiEnabled === true,
            runnerAvailable: config.audienceAiRunnerAvailable === true,
          },
          mcp: mcpAccessService ? {
            enabled: config.mcpEnabled === true,
            host: config.mcpHost,
            port: config.mcpPort,
            ...mcpAccessService.status(),
          } : { enabled: false },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/codex-desktop/status') {
        if (!codexDesktopService?.status) {
          return json(res, 503, errorBody('CODEX_DESKTOP_UNAVAILABLE', 'Codex desktop integration is unavailable.'));
        }
        return json(res, 200, await codexDesktopService.status());
      }
      if (req.method === 'POST' && url.pathname === '/api/codex-desktop/launch') {
        if (!codexDesktopService?.launch) {
          return json(res, 503, errorBody('CODEX_DESKTOP_UNAVAILABLE', 'Codex desktop integration is unavailable.'));
        }
        return json(res, 200, await codexDesktopService.launch());
      }
      if (url.pathname.startsWith('/api/xhs-context')) {
        if (!xhsContextService) {
          return json(res, 503, errorBody('XHS_CONTEXT_UNAVAILABLE', 'Local xhs-context is unavailable.'));
        }
        if (req.method === 'POST' && url.pathname === '/api/xhs-context/mcp') {
          const authorization = String(req.headers.authorization || '');
          const bearerToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || '';
          xhsContextService.authorizeHttp(req, req.headers['x-xhs-context-token'] || bearerToken);
          const response = await xhsContextService.handleMcpRequest(await readJsonBody(req, Math.min(config.maxBodyBytes, 2 * 1024 * 1024)));
          if (response === null) return noContent(res);
          return json(res, 200, response);
        }
        if (req.method === 'GET' && url.pathname === '/api/xhs-context/status') {
          return json(res, 200, {
            ...xhsContextService.status(),
            mcp: {
              endpoint: `http://127.0.0.1:${Number(config.port) || 4317}/api/xhs-context/mcp`,
              credentialFile: xhsContextService.tokenPath,
              header: 'X-Xhs-Context-Token',
              bearerTokenEnvVar: 'XHS_CONTEXT_TOKEN',
            },
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/xhs-context/bundles') {
          return json(res, 200, { bundles: xhsContextService.listBundles() });
        }
        if (req.method === 'POST' && url.pathname === '/api/xhs-context/bundles/from-job') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const jobId = String(body?.jobId || '').trim();
          const job = manager.getInternal(jobId);
          if (!job) return json(res, 404, errorBody('JOB_NOT_FOUND', 'Job not found.'));
          return json(res, 201, await xhsContextService.createBundleFromJob({
            jobId,
            outputDir: job.outputDir,
            title: body?.title,
          }));
        }
        const contextParts = url.pathname.split('/').filter(Boolean);
        const bundleId = contextParts[3] || '';
        if (contextParts[0] === 'api' && contextParts[1] === 'xhs-context' && contextParts[2] === 'bundles' && bundleId) {
          if (req.method === 'GET' && contextParts.length === 4) return json(res, 200, xhsContextService.overview(bundleId));
          if (req.method === 'POST' && contextParts[4] === 'search' && contextParts.length === 5) {
            const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 256 * 1024));
            return json(res, 200, xhsContextService.search(bundleId, body?.query, body));
          }
          if (req.method === 'POST' && contextParts[4] === 'verify' && contextParts.length === 5) return json(res, 200, xhsContextService.verify(bundleId));
          if (req.method === 'GET' && contextParts[4] === 'records' && contextParts[5] && contextParts.length === 6) {
            return json(res, 200, xhsContextService.openRecord(decodeURIComponent(contextParts[5])));
          }
          if (req.method === 'GET' && contextParts[4] === 'artifacts' && contextParts.length === 5) {
            return json(res, 200, await xhsContextService.readArtifact(bundleId, url.searchParams.get('path') || ''));
          }
          if (req.method === 'POST' && contextParts[4] === 'aggregate' && contextParts.length === 5) {
            return json(res, 200, xhsContextService.aggregate(bundleId, await readJsonBody(req, Math.min(config.maxBodyBytes, 256 * 1024))));
          }
          if (req.method === 'POST' && contextParts[4] === 'cite' && contextParts.length === 5) {
            const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 256 * 1024));
            return json(res, 200, xhsContextService.cite(bundleId, body?.recordIds));
          }
        }
        return json(res, 404, errorBody('XHS_CONTEXT_ROUTE_NOT_FOUND', 'xhs-context route not found.'));
      }
      if (url.pathname.startsWith('/api/codex-product')) {
        if (!codexProductService) return json(res, 503, errorBody('CODEX_PRODUCT_UNAVAILABLE', 'The Codex product integration is unavailable.'));
        const productParts = url.pathname.split('/').filter(Boolean);
        if (req.method === 'POST'
          && productParts[0] === 'api'
          && productParts[1] === 'codex-product'
          && productParts[2] === 'workspaces'
          && productParts[3]
          && productParts[4] === 'threads'
          && productParts.length === 5) {
          if (!codexHostCommands?.startWorkspaceThread) {
            return json(res, 503, errorBody('CODEX_WORKSPACE_THREAD_UNAVAILABLE', 'The Codex workspace task service is unavailable.'));
          }
          const projectId = safeDecodePathSegment(productParts[3]);
          if (!projectId) return json(res, 400, errorBody('CODEX_WORKSPACE_ID_INVALID', 'Codex workspace id is invalid.'));
          return json(res, 201, await codexHostCommands.startWorkspaceThread(projectId));
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-product/workspaces') {
          return json(res, 200, codexProductWorkspaceService?.publicSnapshot?.() || { available: false, source: null, history: [] });
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-product/integration') {
          const workspace = codexProductWorkspaceService?.publicSnapshot?.() || { available: false, source: null, history: [] };
          return json(res, 200, {
            schemaVersion: 1,
            workspace,
            mcp: {
              embedded: ['xhs-context', 'codex-product'],
              localInstall: {
                command: 'powershell -ExecutionPolicy Bypass -File scripts/install-codex-product-mcp.ps1',
                bridgeScript: 'scripts/codex-product-mcp-bridge.mjs',
                requiresLocalProduct: true,
                includes: [
                  ...XHS_CONTEXT_TOOL_DEFINITIONS.map((tool) => `xhs-context.${tool.name}`),
                  ...CODEX_PRODUCT_TOOL_DEFINITIONS.map((tool) => `codex-product.${tool.name}`),
                ],
              },
            },
            launch: {
              workspaceRoot: config.workspaceRoot,
              endpoint: '/api/codex-desktop/launch',
            },
            sourceDownload: {
              path: '/api/codex-product/source-archive',
              format: 'tar.gz',
              excludesSecrets: true,
            },
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-product/source-archive') {
          const workspaceRoot = codexProductWorkspaceService?.workspaceRoot || config.workspaceRoot;
          const archive = await createCodexSourceArchive({ workspaceRoot });
          const release = () => void archive.release().catch(() => {});
          res.once('close', release);
          const stream = createReadStream(archive.archivePath);
          stream.once('error', (error) => {
            release();
            res.destroy(error);
          });
          stream.once('end', release);
          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Length': archive.size,
            'Content-Disposition': `attachment; filename="${archive.fileName}"`,
            'Cache-Control': 'no-store',
          });
          stream.pipe(res);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/codex-product/mcp') {
          const authorization = String(req.headers.authorization || '');
          const bearerToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || '';
          codexProductService.authorizeHttp(req, req.headers['x-codex-product-token'] || bearerToken);
          const response = await codexProductService.handleMcpRequest(await readJsonBody(req, Math.min(config.maxBodyBytes, 2 * 1024 * 1024)));
          if (response === null) return noContent(res);
          return json(res, 200, response);
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-product/status') return json(res, 200, codexProductService.status());
        return json(res, 404, errorBody('CODEX_PRODUCT_ROUTE_NOT_FOUND', 'codex-product route not found.'));
      }
      if (url.pathname.startsWith('/api/codex-native-mirror')) {
        if (!codexNativeMirrorService) {
          return json(res, 503, errorBody('CODEX_MIRROR_UNAVAILABLE', 'Native Mirror signaling is unavailable.'));
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-native-mirror/status') {
          return json(res, 200, codexNativeMirrorService.status());
        }
        if (req.method === 'POST' && url.pathname === '/api/codex-native-mirror/sessions') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const remote = body?.remote === true;
          const autoLaunchSource = remote || body?.autoLaunchSource === true;
          const created = codexNativeMirrorService.createSession({
            deviceId: body?.deviceId,
            remote,
            ownerId: remote ? (codexOwnerId || 'local-owner') : '',
          });
          if (autoLaunchSource) {
            const sourceUrl = new URL('/codex-native-mirror.html?v=20260819-local-capture-1', `${requestPublicProtocol(req, config)}://${requestPublicHost(req, config)}`);
            sourceUrl.hash = new URLSearchParams({
              sessionId: created.session.id,
              role: created.source.role,
              token: created.source.token,
              remote: '1',
              autostart: '1',
              targetTitle: 'ChatGPT',
              ...(!remote ? { sameHost: '1' } : {}),
            }).toString();
            try {
              const launched = remote
                ? await codexNativeMirrorService.launchRemoteSource(created.session.id, created.source, { sourceUrl: sourceUrl.toString() })
                : await codexNativeMirrorService.launchLocalSource(created.session.id, created.source, {
                    sourceUrl: sourceUrl.toString(),
                    captureTitle: 'ChatGPT',
                  });
              created.session = launched.session;
            } catch (error) {
              codexNativeMirrorService.closeSession(created.session.id, created.source);
              throw error;
            }
          }
          return json(res, 201, created);
        }
        const mirrorParts = url.pathname.split('/').filter(Boolean);
        const mirrorSessionId = mirrorParts[3] || '';
        if (mirrorParts[0] === 'api' && mirrorParts[1] === 'codex-native-mirror' && mirrorParts[2] === 'sessions' && mirrorSessionId) {
          const credentials = {
            role: String(req.headers['x-codex-mirror-role'] || ''),
            token: String(req.headers['x-codex-mirror-token'] || ''),
          };
          if (req.method === 'GET' && mirrorParts.length === 4) {
            return json(res, 200, codexNativeMirrorService.getSession(mirrorSessionId, credentials));
          }
          if (req.method === 'DELETE' && mirrorParts.length === 4) {
            return json(res, 200, codexNativeMirrorService.closeSession(mirrorSessionId, credentials));
          }
          if (req.method === 'POST' && mirrorParts[4] === 'input-target' && mirrorParts.length === 5) {
            return json(res, 200, await codexNativeMirrorService.setInputTarget(
              mirrorSessionId,
              credentials,
              await readJsonBody(req, Math.min(config.maxBodyBytes, 64 * 1024)),
            ));
          }
          if (req.method === 'POST' && mirrorParts[4] === 'input' && mirrorParts.length === 5) {
            return json(res, 202, await codexNativeMirrorService.sendInput(
              mirrorSessionId,
              credentials,
              await readJsonBody(req, Math.min(config.maxBodyBytes, 32 * 1024)),
            ));
          }
          if (mirrorParts[4] === 'signals' && mirrorParts.length === 5) {
            if (req.method === 'GET') {
              return json(res, 200, codexNativeMirrorService.listSignals(mirrorSessionId, {
                ...credentials,
                after: url.searchParams.get('after') || 0,
              }));
            }
            if (req.method === 'POST') {
              return json(res, 202, codexNativeMirrorService.postSignal(mirrorSessionId, {
                ...credentials,
                ...await readJsonBody(req, Math.min(config.maxBodyBytes, 768 * 1024)),
              }));
            }
          }
        }
        return json(res, 404, errorBody('CODEX_MIRROR_ROUTE_NOT_FOUND', 'Native Mirror route not found.'));
      }
      if (url.pathname.startsWith('/api/codex-connect')) {
        if (!codexConnect) return json(res, 503, errorBody('CODEX_CONNECT_UNAVAILABLE', 'The local connector control plane is unavailable.'));
        if (req.method === 'GET' && url.pathname === '/api/codex-connect/manifest') {
          const installer = await describeCodexConnectInstaller(config.codexConnectInstallerPath, codexConnectInstallerCache);
          codexConnectInstallerCache = installer.cache;
          return json(res, 200, codexConnect.manifest({
            installerUrl: installer.available ? '/api/codex-connect/installer' : '',
            installerAvailable: installer.available,
            installerSha256: installer.sha256,
          }));
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-connect/installer') {
          const installer = await describeCodexConnectInstaller(config.codexConnectInstallerPath, codexConnectInstallerCache);
          codexConnectInstallerCache = installer.cache;
          if (!installer.available) {
            return json(res, 404, errorBody('CODEX_CONNECT_INSTALLER_UNAVAILABLE', 'The local connector installer has not been packaged.'));
          }
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': installer.size,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(installer.path))}`,
            ...(installer.sha256 ? { 'X-Checksum-Sha256': installer.sha256 } : {}),
          });
          return createReadStream(installer.path).pipe(res);
        }
        if (req.method === 'POST' && url.pathname === '/api/codex-connect/intents') {
          if (!codexOwnerId) return json(res, 401, errorBody('AUTH_REQUIRED', 'A signed-in owner is required to connect a local device.'));
          const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 64 * 1024));
          const origin = `${requestPublicProtocol(req, config)}://${requestPublicHost(req, config)}`;
          const created = codexConnect.createIntent({ ...body, ownerId: codexOwnerId, origin });
          return json(res, 201, {
            ...created,
            manifestUrl: '/api/codex-connect/manifest',
            installerUrl: '/api/codex-connect/installer',
            statusUrl: `/api/codex-connect/intents/${encodeURIComponent(created.intent.id)}`,
          });
        }
        const connectParts = url.pathname.split('/').filter(Boolean);
        const connectIntentId = connectParts[3] || '';
        if (connectParts[0] === 'api' && connectParts[1] === 'codex-connect' && connectParts[2] === 'intents' && connectIntentId) {
          if (req.method === 'GET' && connectParts.length === 4) {
            if (!codexOwnerId) return json(res, 401, errorBody('AUTH_REQUIRED', 'A signed-in owner is required to read a connection intent.'));
            return json(res, 200, codexConnect.getIntent(connectIntentId, { ownerId: codexOwnerId }));
          }
          if (req.method === 'POST' && connectParts[4] === 'claim' && connectParts.length === 5) {
            return json(res, 201, await codexConnect.claimIntent(connectIntentId, await readJsonBody(req, Math.min(config.maxBodyBytes, 128 * 1024))));
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-connect/devices') {
          if (!codexOwnerId) return json(res, 401, errorBody('AUTH_REQUIRED', 'A signed-in owner is required to list connected devices.'));
          return json(res, 200, { devices: codexConnect.listDevices({ ownerId: codexOwnerId }) });
        }
        const connectDeviceId = connectParts[3] || '';
        if (connectParts[0] === 'api' && connectParts[1] === 'codex-connect' && connectParts[2] === 'devices' && connectDeviceId) {
          if (!codexOwnerId) return json(res, 401, errorBody('AUTH_REQUIRED', 'A signed-in owner is required to manage a connected device.'));
          if (req.method === 'GET' && connectParts[4] === 'health' && connectParts.length === 5) {
            return json(res, 200, codexConnect.getDeviceHealth(connectDeviceId, { ownerId: codexOwnerId }));
          }
          if (req.method === 'POST' && connectParts[4] === 'reconnect' && connectParts.length === 5) {
            return json(res, 202, codexConnect.reconnectDevice(connectDeviceId, { ownerId: codexOwnerId }));
          }
          if (req.method === 'POST' && connectParts[4] === 'repair' && connectParts.length === 5) {
            return json(res, 202, codexConnect.repairDevice(connectDeviceId, { ownerId: codexOwnerId }));
          }
          if (req.method === 'POST' && connectParts[4] === 'rollback' && connectParts.length === 5) {
            return json(res, 202, codexConnect.rollbackDevice(connectDeviceId, { ownerId: codexOwnerId }));
          }
          if (req.method === 'POST' && connectParts[4] === 'revoke' && connectParts.length === 5) {
            return json(res, 200, await codexConnect.revokeDevice(connectDeviceId, { ownerId: codexOwnerId }));
          }
        }
        return json(res, 404, errorBody('CODEX_CONNECT_ROUTE_NOT_FOUND', 'Local connector route not found.'));
      }
      if (url.pathname.startsWith('/api/codex-relay')) {
        if (!codexRelayService) {
          return json(res, 503, errorBody('CODEX_RELAY_UNAVAILABLE', 'Local Codex Relay is unavailable.'));
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-relay/status') {
          return json(res, 200, {
            ...await codexRelayService.status(),
            hostRpc: codexHostRpcService?.status?.() || { available: false, protocol: 'codex-host-rpc.v1' },
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-relay/gateway/status') {
          if (!codexDeviceGatewayService) return json(res, 503, errorBody('CODEX_GATEWAY_UNAVAILABLE', 'The device gateway is unavailable.'));
          return json(res, 200, codexDeviceGatewayService.status());
        }
        if (req.method === 'GET' && url.pathname === '/api/codex-relay/devices') {
          return json(res, 200, { devices: codexRelayService.listDevices({ ownerId: codexOwnerId || 'local-owner' }) });
        }
        if (req.method === 'POST' && url.pathname === '/api/codex-relay/pair') {
          return json(res, 201, { device: codexRelayService.pair(await readJsonBody(req, config.maxBodyBytes)) });
        }
        if (req.method === 'POST' && url.pathname === '/api/codex-relay/pairing-intents') {
          if (!codexDeviceGatewayService) return json(res, 503, errorBody('CODEX_GATEWAY_UNAVAILABLE', 'The device gateway is unavailable.'));
          if (!codexOwnerId) return json(res, 401, errorBody('AUTH_REQUIRED', 'A signed-in owner is required to create a pairing intent.'));
          const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 64 * 1024));
          const created = codexDeviceGatewayService.createPairingIntent({
            ...body,
            ownerId: codexOwnerId,
          });
          const protocol = requestPublicProtocol(req, config);
          const gatewayHost = requestPublicHost(req, config);
          return json(res, 201, {
            ...created,
            gateway: {
              websocketUrl: `${protocol === 'https' ? 'wss' : 'ws'}://${gatewayHost}/v1/device-tunnel`,
              claimUrl: `${protocol}://${gatewayHost}/api/codex-relay/device-claims`,
            },
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/codex-relay/device-claims') {
          if (!codexDeviceGatewayService) return json(res, 503, errorBody('CODEX_GATEWAY_UNAVAILABLE', 'The device gateway is unavailable.'));
          return json(res, 201, await codexDeviceGatewayService.claimPairing(
            await readJsonBody(req, Math.min(config.maxBodyBytes, 128 * 1024)),
          ));
        }
        const deviceParts = url.pathname.split('/').filter(Boolean);
        const pairedDeviceId = deviceParts[3] || '';
        if (deviceParts[0] === 'api' && deviceParts[1] === 'codex-relay' && deviceParts[2] === 'devices' && pairedDeviceId) {
          if (!codexDeviceGatewayService) return json(res, 503, errorBody('CODEX_GATEWAY_UNAVAILABLE', 'The device gateway is unavailable.'));
          if (req.method === 'POST' && deviceParts[4] === 'heartbeat' && deviceParts.length === 5) {
            const authorization = String(req.headers.authorization || '');
            const deviceToken = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || String(req.headers['x-codex-device-token'] || '');
            return json(res, 200, await codexDeviceGatewayService.heartbeat(
              pairedDeviceId,
              deviceToken,
              await readJsonBody(req, Math.min(config.maxBodyBytes, 128 * 1024)),
            ));
          }
          if (req.method === 'DELETE' && deviceParts.length === 4) {
            if (!codexOwnerId) return json(res, 401, errorBody('AUTH_REQUIRED', 'A signed-in owner is required to revoke a device.'));
            return json(res, 200, await codexDeviceGatewayService.revokeDevice(pairedDeviceId, { ownerId: codexOwnerId }));
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/codex-relay/sessions') {
          return json(res, 201, codexRelayService.createSession({
            ...await readJsonBody(req, config.maxBodyBytes),
            ownerId: codexOwnerId || 'local-owner',
          }));
        }
        if (req.method === 'POST' && url.pathname === '/api/codex-relay/invites') {
          const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 64 * 1024));
          const invite = codexRelayService.createShareInvite({
            deviceId: body?.deviceId,
            ownerId: codexOwnerId || 'local-owner',
          });
          const shareUrl = new URL('/codex/', `${requestPublicProtocol(req, config)}://${requestPublicHost(req, config)}`);
          shareUrl.searchParams.set('relaySessionId', invite.invite.sessionId);
          shareUrl.searchParams.set('relayTicket', invite.invite.ticket);
          shareUrl.searchParams.set('relayBrowserInstanceId', invite.invite.browserInstanceId);
          return json(res, 201, { ...invite, shareUrl: shareUrl.toString() });
        }
        const relayParts = url.pathname.split('/').filter(Boolean);
        const relaySessionId = relayParts[3] || '';
        if (relayParts[0] === 'api' && relayParts[1] === 'codex-relay' && relayParts[2] === 'sessions' && relaySessionId) {
          if (req.method === 'POST' && relayParts[4] === 'connect' && relayParts.length === 5) {
            return json(res, 200, codexRelayService.connect(relaySessionId, await readJsonBody(req, config.maxBodyBytes)));
          }
          if (req.method === 'GET' && relayParts.length === 4) {
            return json(res, 200, codexRelayService.getSession(relaySessionId, {
              connectionToken: codexRelayConnectionToken(req),
            }));
          }
          if (req.method === 'DELETE' && relayParts.length === 4) {
            return json(res, 200, codexRelayService.closeSession(relaySessionId, {
              connectionToken: codexRelayConnectionToken(req),
            }));
          }
          if (req.method === 'POST' && relayParts[4] === 'lease' && relayParts[5] === 'renew' && relayParts.length === 6) {
            const body = await readJsonBody(req, config.maxBodyBytes);
            return json(res, 200, codexRelayService.renewLease(relaySessionId, {
              ...body,
              connectionToken: codexRelayConnectionToken(req, body),
            }));
          }
          if (req.method === 'POST' && relayParts[4] === 'lease' && relayParts[5] === 'release' && relayParts.length === 6) {
            const body = await readJsonBody(req, config.maxBodyBytes);
            return json(res, 200, codexRelayService.releaseLease(relaySessionId, {
              ...body,
              connectionToken: codexRelayConnectionToken(req, body),
            }));
          }
          if (req.method === 'GET' && relayParts[4] === 'events' && relayParts.length === 5) {
            return json(res, 200, codexRelayService.listEvents(relaySessionId, {
              connectionToken: codexRelayConnectionToken(req),
              after: url.searchParams.get('after') || 0,
              limit: url.searchParams.get('limit') || 30,
            }));
          }
          if (req.method === 'POST' && relayParts[4] === 'stream-ticket' && relayParts.length === 5) {
            const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 64 * 1024));
            return json(res, 201, {
              ticket: codexRelayService.issueStreamTicket(relaySessionId, {
                ...body,
                connectionToken: codexRelayConnectionToken(req, body),
              }),
            });
          }
          if (req.method === 'POST' && relayParts[4] === 'messages' && relayParts.length === 5) {
            const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 2 * 1024 * 1024));
            const message = body?.message && typeof body.message === 'object' ? body.message : body;
            const result = await codexHostCommands.sendRelay(relaySessionId, {
              ...body,
              message,
              connectionToken: codexRelayConnectionToken(req, body),
            });
            return json(res, 200, result);
          }
          if (req.method === 'POST' && relayParts[4] === 'worker-messages' && relayParts.length === 5) {
            const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 2 * 1024 * 1024));
            const result = await codexHostCommands.sendWorkerRelay(relaySessionId, {
              ...body,
              connectionToken: codexRelayConnectionToken(req, body),
            });
            return json(res, 200, result);
          }
        }
        return json(res, 404, errorBody('CODEX_RELAY_ROUTE_NOT_FOUND', 'Codex Relay route not found.'));
      }
      if (req.method === 'GET' && url.pathname === '/api/codex-browser/status') {
        const webviewRoot = codexWebviewRoot(config);
        const runtime = codexRuntimeCompatibility?.status?.() || { state: 'legacy', ready: true };
        const staticReady = Boolean(await safeStaticFile(webviewRoot, path.join(webviewRoot, 'index.html')));
        const ready = staticReady && runtime.ready !== false;
        return json(res, ready ? 200 : 503, {
          ready,
          mode: 'browser',
          version: runtime.desktop?.version || '26.803.81509',
          buildNumber: runtime.desktop?.buildNumber || '6415',
          workspaceRoot: config.workspaceRoot,
          webviewRoot,
          runtime,
          backend: codexBrowserService?.status?.() || { running: false, initialized: false, pid: null },
          modelBridge: codexModelBridgeService?.status?.() || { configured: false },
          product: codexProductService?.status?.() || { service: 'codex-product', available: false },
          observedMessageTypes: codexHostCommands.observedMessageTypes(),
          hostCommands: codexHostCommands.status(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/codex-model/v1/responses') {
        if (!codexModelBridgeService?.responses) {
          return json(res, 503, errorBody('CODEX_MODEL_BRIDGE_UNAVAILABLE', 'The Codex model bridge is unavailable.'));
        }
        const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 16 * 1024 * 1024));
        const result = await codexModelBridgeService.responses(body, {
          authorization: req.headers.authorization,
          remoteAddress: req.socket?.remoteAddress,
        });
        if (!result.stream) return json(res, 200, result.body);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        for await (const event of result.events) {
          res.write(`event: ${String(event?.type || 'message')}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/codex-model/probe') {
        if (!codexModelBridgeService?.probe) {
          return json(res, 503, errorBody('CODEX_MODEL_BRIDGE_UNAVAILABLE', 'The Codex model bridge is unavailable.'));
        }
        return json(res, 200, await codexModelBridgeService.probe());
      }
      if (req.method === 'GET' && url.pathname === '/api/codex-browser/events') {
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) {
          return json(res, 400, errorBody('CODEX_BROWSER_CURSOR_INVALID', 'Codex browser event cursor is invalid.'));
        }
        const sessionId = String(url.searchParams.get('sessionId') || '').trim();
        const events = (codexBrowserService?.listEvents?.({ after, sessionId }) || []).slice(0, 30);
        return json(res, 200, {
          events,
          cursor: events.at(-1)?.sequence ?? after,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/codex-browser/messages') {
        const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 2 * 1024 * 1024));
        const message = body?.message && typeof body.message === 'object' ? body.message : body;
        const sessionId = String(body?.sessionId || '').trim();
        return json(res, 200, await codexHostCommands.sendLegacy({
          sessionId,
          commandId: body?.commandId,
          message,
        }));
      }
      if (req.method === 'POST' && url.pathname === '/api/codex-browser/worker-messages') {
        const body = await readJsonBody(req, Math.min(config.maxBodyBytes, 2 * 1024 * 1024));
        return json(res, 200, await codexHostCommands.sendWorkerLegacy({
          sessionId: String(body?.sessionId || '').trim(),
          commandId: body?.commandId,
          workerId: body?.workerId,
          message: body?.message,
        }));
      }
      if (await handleMcpManagementRequest({
        req,
        res,
        url,
        service: mcpAccessService,
        actor: copilotActor || { id: 'anonymous', roles: [] },
        maxBodyBytes: Math.min(config.maxBodyBytes, config.mcpMaxBodyBytes || config.maxBodyBytes),
      })) return;
      const requiresCopilotOwnerControl = isCopilotMcpControlPath(url.pathname)
        || (
          isStateChangingMethod(req.method)
          && url.pathname.startsWith('/api/mcp')
        )
        || (
          config.copilotApprovalMode === 'never'
          && isStateChangingMethod(req.method)
          && url.pathname.startsWith('/api/copilot/')
        );
      if (requiresCopilotOwnerControl) {
        const controlError = validateCopilotOwnerRequest(req, config, copilotActor, {
          authenticationRequired: Boolean(authStore?.required),
        });
        if (controlError) {
          return json(res, controlError.status, errorBody(controlError.code, controlError.message));
        }
      }
      if (await handleDataCopilotRequest({
        req,
        res,
        url,
        service: dataCopilotService,
        maxBodyBytes: config.maxBodyBytes,
        securityContext: copilotSecurityContext,
      })) return;
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
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'ai' && parts[2] === 'sessions' && parts[3] && parts[4] === 'probe') {
        return json(res, 200, await aiSessions.probe(parts[3]));
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
      if (req.method === 'POST' && url.pathname === '/api/body-imports') {
        const imported = validateBodyImportRequest(await readJsonBody(req, config.maxBodyBytes));
        const job = await manager.startImportedBodies(imported.params, imported.cards, {
          queueIfBusy: true,
          requestedBy: 'body_import_api',
        });
        return json(res, 202, {
          summary: imported.summary,
          job,
          message: job.status === 'queued'
            ? 'Body collection task queued.'
            : 'Body collection task started.',
        });
      }
      if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
        const id = parts[2];
        const audienceAiRoute = isAudienceAiRouteParts(parts);
        if (!JOB_ID.test(id)) {
          if (audienceAiRoute) {
            const error = Object.assign(new Error('The requested task was not found.'), { code: 'AUDIENCE_AI_JOB_NOT_FOUND', jobId: id });
            return json(res, 404, audienceAiErrorBody(error, {
              code: error.code, requestId, jobId: id, postId: safeDecodePathSegment(parts[5]), runId: null,
            }));
          }
          return json(res, 404, errorBody('NOT_FOUND', 'Task not found.'));
        }
        const internal = manager.getInternal(id);
        if (!internal) {
          if (audienceAiRoute) {
            const error = Object.assign(new Error('The requested task was not found.'), { code: 'AUDIENCE_AI_JOB_NOT_FOUND', jobId: id });
            return json(res, 404, audienceAiErrorBody(error, {
              code: error.code, requestId, jobId: id, postId: safeDecodePathSegment(parts[5]), runId: null,
            }));
          }
          return json(res, 404, errorBody('NOT_FOUND', 'Task not found.'));
        }
        if (req.method === 'GET' && parts.length === 3) return json(res, 200, manager.get(id));
        if (req.method === 'GET' && parts[3] === 'experience-snapshot' && parts.length === 4) {
          const job = manager.get(id);
          return json(res, 200, job.experienceSnapshot || job.experience);
        }
        if (req.method === 'GET' && parts[3] === 'issues' && parts.length === 4) {
          const job = manager.get(id);
          const snapshot = job.experienceSnapshot || job.experience;
          return json(res, 200, {
            jobId: id,
            throughSequence: Number(snapshot?.throughSequence || 0),
            issues: Array.isArray(snapshot?.issues) ? snapshot.issues : [],
          });
        }
        if (req.method === 'GET' && parts[3] === 'technical-diagnostics' && parts.length === 4) {
          return json(res, 200, experienceDiagnostics(manager.get(id), diagnostics));
        }
        if (req.method === 'POST' && parts[3] === 'actions' && parts[4] === 'retry-stage' && parts.length === 5) {
          const body = validateExperienceActionBody(
            await readJsonBody(req, config.maxBodyBytes),
            new Set(['stage', 'aiSessionId', 'idempotencyKey']),
          );
          const currentJob = manager.get(id);
          const snapshot = currentJob.experienceSnapshot || currentJob.experience;
          const stage = validateExperienceStage(
            body.stage || snapshot?.activeStage || snapshot?.issues?.[0]?.affectedStage || 'task',
          );
          const scope = experienceResumeScope(stage);
          const options = validateResumeRequest({
            scope,
            ...(Object.hasOwn(body, 'aiSessionId') ? { aiSessionId: body.aiSessionId } : {}),
            ...(Object.hasOwn(body, 'idempotencyKey') ? { idempotencyKey: body.idempotencyKey } : {}),
          });
          try {
            const resumeCheckpointJobIds = scope === 'audience'
              ? (await resolveAudienceResumeOwner(manager, id)).readThroughJobIds
              : [];
            const job = await manager.resume(id, {
              ...options,
              requestedBy: 'experience_retry_stage_api',
              ...(resumeCheckpointJobIds.length ? { resumeCheckpointJobIds } : {}),
            });
            return json(res, 202, {
              action: 'started',
              jobId: id,
              stage,
              scope,
              job,
              snapshot: job.experienceSnapshot || job.experience || snapshot,
            });
          } catch (error) {
            const failure = experienceActionFailure(error, currentJob);
            if (!failure) throw error;
            return json(res, failure.status, failure.body);
          }
        }
        if (req.method === 'POST' && parts[3] === 'actions' && parts[4] === 'check-recovery' && parts.length === 5) {
          const body = validateExperienceActionBody(
            await readJsonBody(req, config.maxBodyBytes),
            new Set(['idempotencyKey']),
          );
          const currentJob = manager.get(id);
          const snapshot = currentJob.experienceSnapshot || currentJob.experience;
          const issue = Array.isArray(snapshot?.issues)
            ? snapshot.issues.find((item) => item?.code === 'RATE_LIMITED') || snapshot.issues[0]
            : null;
          const stage = validateExperienceStage(issue?.affectedStage || snapshot?.activeStage || 'body');
          const scope = experienceResumeScope(stage);
          try {
            if (typeof manager.signalRateLimitRecovery === 'function') {
              const signal = await manager.signalRateLimitRecovery(id, {
                idempotencyKey: body.idempotencyKey,
              });
              if (signal?.signaled) {
                const job = signal.job || manager.get(id);
                return json(res, 202, {
                  action: 'signaled',
                  jobId: id,
                  stage,
                  scope,
                  job,
                  snapshot: job?.experienceSnapshot || job?.experience || snapshot,
                });
              }
            }
            if (ACTIVE_JOB_STATUSES.has(currentJob.status)) {
              return json(res, 200, {
                action: 'attached',
                jobId: id,
                stage,
                scope,
                job: currentJob,
                snapshot,
              });
            }
            const options = validateResumeRequest({
              scope,
              ...(Object.hasOwn(body, 'idempotencyKey') ? { idempotencyKey: body.idempotencyKey } : {}),
            });
            const resumeCheckpointJobIds = scope === 'audience'
              ? (await resolveAudienceResumeOwner(manager, id)).readThroughJobIds
              : [];
            const job = await manager.resume(id, {
              ...options,
              requestedBy: 'experience_check_recovery_api',
              forceCompleted: true,
              rateLimitRecoveryMode: 'manual',
              ...(resumeCheckpointJobIds.length ? { resumeCheckpointJobIds } : {}),
            });
            return json(res, 202, {
              action: 'started',
              jobId: id,
              stage,
              scope,
              job,
              snapshot: job.experienceSnapshot || job.experience || snapshot,
            });
          } catch (error) {
            const failure = experienceActionFailure(error, currentJob);
            if (!failure) throw error;
            return json(res, failure.status, failure.body);
          }
        }
        if (req.method === 'POST' && parts[3] === 'actions' && parts[4] === 'open-login' && parts.length === 5) {
          validateExperienceActionBody(await readJsonBody(req, config.maxBodyBytes), new Set());
          const currentJob = manager.get(id);
          const configured = getRelayConfig();
          const profile = String(configured.profile || 'openclaw').trim();
          const urlToOpen = 'https://www.xiaohongshu.com';
          if (!/^[\p{L}\p{N}_.-]+$/u.test(profile)) {
            return json(res, 400, experienceErrorPayload('INVALID_PROFILE', 'Invalid browser profile.', currentJob));
          }
          const connection = await relayRuntime.connect({ port: Number(configured.port), profile });
          if (!connection.ready && !(connection.running && connection.cdpReady)) {
            return json(res, 503, experienceErrorPayload(
              'RELAY_DISCONNECTED',
              connection.message || 'The collection browser is not ready.',
              currentJob,
            ));
          }
          const opened = await relayLoginOpener({
            port: Number(configured.port),
            openClawConfigPath: config.openClawConfigPath,
            profile,
            url: urlToOpen,
          });
          if (!opened.opened) {
            return json(res, 503, experienceErrorPayload(
              'LOGIN_PAGE_UNAVAILABLE',
              opened.message || 'The login page could not be opened.',
              currentJob,
            ));
          }
          return json(res, 200, {
            action: 'opened',
            jobId: id,
            opened: true,
            profile,
            url: urlToOpen,
            message: opened.message || 'Login page opened.',
          });
        }
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
          const incompleteBefore = applicationCompletionCount(currentResults);
          if (incompleteBefore === 0) {
            return json(res, 200, {
              action: 'already_complete',
              sourceJobId: id,
              incompleteBefore: 0,
              job: sourceJob,
              message: 'All records are already complete.',
            });
          }

          const requestedAiSessionId = Object.hasOwn(body, 'aiSessionId') ? body.aiSessionId : null;
          const params = validateRunRequest({
            ...sourceParams,
            analysisMode,
            searchSort: 'latest',
            maxAgeDays: sourceParams.maxAgeDays ?? 14,
            limit: 0,
            mode: 'resume',
            resumeFromJobId: id,
            completeMissingOnly: true,
            checkOnly: false,
            skipPostprocess: false,
            useCodexRuntime: true,
            aiSessionId: requestedAiSessionId,
          });
          const job = await manager.resume(id, {
            scope: 'body_completion',
            params,
            aiSessionId: requestedAiSessionId,
            idempotencyKey: body.idempotencyKey,
            forceCompleted: true,
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
        if (req.method === 'GET' && parts[3] === 'events' && parts.length === 4) return streamEvents(req, res, manager, id, url.searchParams);
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
          let results = await readApplicationResults(internal.outputDir, url.searchParams, internal);
          let contactResolution = null;
          if (config.applicationContactOcrEnabled === true && results.available && results.filters.stats.withImages > 0) {
            try {
              const activeCollection = manager.active?.id === id
                && internal.params?.analysisMode !== 'general';
              const operation = config.applicationContactOcrAutoEnabled === true
                ? await applicationContactOcr.ensureStarted(internal.outputDir, activeCollection
                  ? { watch: true, pollSeconds: 1, retryPartial: true }
                  : {})
                : { action: 'status', state: await applicationContactOcr.getState(internal.outputDir) };
              contactResolution = { action: operation.action, ...operation.state };
            } catch (error) {
              contactResolution = {
                action: 'error',
                status: 'failed',
                active: false,
                error: String(error?.message || error),
              };
            }
          }
          let contactDiscovery = null;
          if (results.available && results.analysisMode === 'job') {
            try {
              const cachedResolution = await applicationContactResolution.refresh({
                outputDir: internal.outputDir,
                fallbackOutputDirs: contactResolutionFallbackDirs(id, internal.outputDir),
                task: internal,
              });
              const report = cachedResolution.report || { summary: {}, items: [] };
              const discoveryByNoteId = new Map(report.items.map((item) => [String(item.noteId || ''), item]));
              results = {
                ...results,
                items: results.items.map((item) => ({
                  ...item,
                  contactDiscovery: discoveryByNoteId.get(String(item.note_id || '')) || null,
                })),
              };
              contactDiscovery = {
                generatedAt: cachedResolution.generatedAt,
                sourceSignature: cachedResolution.sourceSignature,
                summary: report.summary,
              };
            } catch (error) {
              contactDiscovery = { error: String(error?.message || error) };
            }
          }
          return json(res, 200, { ...results, contactResolution, contactDiscovery });
        }
        if (req.method === 'GET' && parts[3] === 'application-delivery-candidates' && parts.length === 4) {
          let records = [];
          try {
            records = (await readApplicationContactRecords(internal.outputDir, internal))
              .map(withApplicationAttachmentRequirement);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          let contactDiscovery = null;
          if (records.length) {
            try {
              const cachedResolution = await applicationContactResolution.refresh({
                outputDir: internal.outputDir,
                fallbackOutputDirs: contactResolutionFallbackDirs(id, internal.outputDir),
                task: internal,
              });
              const report = cachedResolution.report || { summary: {}, items: [] };
              const discoveryByNoteId = new Map(report.items.map((item) => [String(item.noteId || ''), item]));
              records = records.map((record) => ({
                ...record,
                contactDiscovery: discoveryByNoteId.get(String(record.note_id || '')) || null,
              }));
              contactDiscovery = {
                generatedAt: cachedResolution.generatedAt,
                sourceSignature: cachedResolution.sourceSignature,
                summary: report.summary,
              };
            } catch (error) {
              contactDiscovery = { error: String(error?.message || error) };
            }
          }
          const service = await getApplicationBatchService(id, internal);
          const response = buildApplicationDeliveryCandidates({
            jobId: id,
            records,
            batches: await service.listBatches(),
            limit: normalizeApplicationDeliveryCandidateLimit(url.searchParams.get('limit')),
            query: {
              q: url.searchParams.get('q') || url.searchParams.get('query'),
              deliveryStatus: url.searchParams.get('deliveryStatus'),
              recipientStatus: url.searchParams.get('recipientStatus'),
              recipientSource: url.searchParams.get('recipientSource'),
              copyStatus: url.searchParams.get('copyStatus'),
              subjectRuleStatus: url.searchParams.get('subjectRuleStatus'),
              attachmentStatus: url.searchParams.get('attachmentStatus'),
              readiness: url.searchParams.get('readiness'),
              hasCoverLetter: url.searchParams.get('hasCoverLetter'),
              batchId: url.searchParams.get('batchId'),
              sort: url.searchParams.get('sort'),
              cursor: url.searchParams.get('cursor'),
            },
          });
          return json(res, 200, { ...response, contactDiscovery });
        }
        if (parts[3] === 'contact-resolution' && parts.length === 4) {
          if (req.method === 'GET') {
            const offset = boundedInteger(url.searchParams.get('offset'), 0, 0, 1000000);
            const limit = boundedInteger(url.searchParams.get('limit'), 50, 1, 100);
            const cachedResolution = await applicationContactResolution.refresh({
              outputDir: internal.outputDir,
              fallbackOutputDirs: contactResolutionFallbackDirs(id, internal.outputDir),
              task: internal,
            });
            const report = cachedResolution.report || { summary: {}, items: [] };
            return json(res, 200, {
              available: true,
              jobId: id,
              generatedAt: cachedResolution.generatedAt,
              sourceSignature: cachedResolution.sourceSignature,
              ...report,
              offset,
              limit,
              items: report.items.slice(offset, offset + limit),
              state: await applicationContactOcr.getState(internal.outputDir),
            });
          }
          if (req.method === 'POST') {
            if (config.applicationContactOcrEnabled !== true) {
              return json(res, 409, errorBody('CONTACT_OCR_DISABLED', 'Local image contact OCR is disabled.'));
            }
            const body = await readJsonBody(req, config.maxBodyBytes);
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              throw new ValidationError('Request body must be a JSON object.');
            }
            const unsupported = Object.keys(body).filter((key) => !['force', 'maxRecords', 'noteIds'].includes(key));
            if (unsupported.length) {
              throw new ValidationError('Unsupported contact OCR parameters.', unsupported.map((field) => ({ field, reason: 'not_allowed' })));
            }
            const operation = await applicationContactOcr.start(internal.outputDir, {
              force: body.force === true,
              maxRecords: boundedInteger(body.maxRecords, 0, 0, 1000000),
              noteIds: Array.isArray(body.noteIds) ? body.noteIds : [],
            });
            return json(res, operation.action === 'started' ? 202 : 200, operation);
          }
        }
        if (req.method === 'GET' && parts[3] === 'media' && parts.length === 4) {
          return await serveCachedMedia(res, {
            outputDir: internal.outputDir,
            sourceUrl: url.searchParams.get('url'),
            mediaFetcher,
            mediaDownloads,
          });
        }
        if (parts[3] === 'audience' && parts[4] === 'posts' && parts[5] && parts[6] === 'ai') {
          const postId = decodePathSegment(parts[5]);
          if (req.method === 'GET' && parts.length === 7) {
            return json(res, 200, await audienceAi.getState(id, postId));
          }
          if (req.method === 'POST' && parts[7] === 'preview' && parts.length === 8) {
            const request = validateAudienceAiPreviewRequest(await readJsonBody(req, config.maxBodyBytes));
            return json(res, 200, await audienceAi.preview(id, postId, request));
          }
          if (req.method === 'POST' && parts[7] === 'runs' && parts.length === 8) {
            const request = validateAudienceAiStartRequest(await readJsonBody(req, config.maxBodyBytes));
            return json(res, 202, await audienceAi.start(id, postId, request));
          }
          if (req.method === 'GET' && parts[7] === 'events' && parts.length === 8) {
            return await streamAudienceAiEvents(req, res, audienceAi, id, postId, url.searchParams);
          }
          if (req.method === 'GET' && parts[7] === 'results' && parts.length === 8) {
            return json(res, 200, await audienceAi.getResults(id, postId, validateAudienceAiResultsQuery(url.searchParams)));
          }
          if (parts[7] === 'runs' && parts[8]) {
            const runId = decodePathSegment(parts[8]);
            if (req.method === 'GET' && parts.length === 9) {
              return json(res, 200, await audienceAi.getRun(id, postId, runId));
            }
            if (req.method === 'GET' && parts[9] === 'results' && parts.length === 10) {
              const query = validateAudienceAiResultsQuery(url.searchParams);
              return json(res, 200, await audienceAi.getResults(id, postId, { ...query, runId }));
            }
            if (req.method === 'POST' && ['cancel', 'resume'].includes(parts[9]) && parts.length === 10) {
              validateAudienceAiEmptyRequest(await readJsonBody(req, config.maxBodyBytes));
              const result = parts[9] === 'cancel'
                ? await audienceAi.cancel(id, postId, runId)
                : await audienceAi.resume(id, postId, runId);
              return json(res, 202, result);
            }
          }
        }
        if (
          req.method === 'GET'
          && parts[3] === 'audience'
          && parts[4] === 'posts'
          && parts[5]
          && ['comments', 'users'].includes(parts[6])
          && parts[7]
          && parts[8] === 'anchor'
          && parts.length === 9
        ) {
          const postId = decodePathSegment(parts[5]);
          const entityType = parts[6] === 'comments' ? 'comment' : 'user';
          const entityId = decodePathSegment(parts[7]);
          const pageSize = strictBoundedInteger(url.searchParams.get('pageSize'), 50, 1, 500, 'pageSize');
          return json(res, 200, await audienceAi.getAnchor(id, postId, entityType, entityId, pageSize));
        }
        if (req.method === 'GET' && parts[3] === 'audience' && parts.length === 4) {
          return json(res, 200, await readAudienceSnapshot(manager, id, url.searchParams));
        }
        if (req.method === 'GET' && parts[3] === 'expansion' && parts.length === 4) {
          return json(res, 200, localizeExpansionMedia(await readExpansionSnapshot(
            internal.outputDir,
            url.searchParams,
            manager.get(id)?.workflowSummary?.expansion || {},
          ), id));
        }
        if (req.method === 'POST' && parts[3] === 'expansion' && parts[4] === 'start' && parts.length === 5) {
          const request = validateExpansionStartRequest(await readJsonBody(req, config.maxBodyBytes));
          const ownedSeedIds = new Set((await readExpansionSeeds(internal.outputDir)).filter((item) => item.available).map((item) => item.postId));
          const foreign = request.seedPostIds.filter((postId) => !ownedSeedIds.has(postId));
          if (foreign.length) {
            throw new ValidationError('Expansion seeds must belong to the current task.', foreign.map((postId) => ({ field: 'seedPostIds', reason: 'not_owned_by_task', value: postId })));
          }
          const result = await manager.startExpansion(id, request);
          return json(res, 202, { ...result, expansion: localizeExpansionMedia(await readExpansionSnapshot(internal.outputDir, new URLSearchParams(), result.job.workflowSummary?.expansion || {}), id) });
        }
        if (req.method === 'POST' && parts[3] === 'expansion' && parts[4] === 'attempts' && parts.length === 5) {
          const request = validateExpansionStartRequest(await readJsonBody(req, config.maxBodyBytes));
          const ownedSeedIds = new Set((await readExpansionSeeds(internal.outputDir)).filter((item) => item.available).map((item) => item.postId));
          const foreign = request.seedPostIds.filter((postId) => !ownedSeedIds.has(postId));
          if (foreign.length) {
            throw new ValidationError('Expansion seeds must belong to the current task.', foreign.map((postId) => ({ field: 'seedPostIds', reason: 'not_owned_by_task', value: postId })));
          }
          const result = await manager.createExpansionAttempt(id, request);
          return json(res, 202, { ...result, expansion: localizeExpansionMedia(await readExpansionSnapshot(internal.outputDir, new URLSearchParams(), result.job.workflowSummary?.expansion || {}), id) });
        }
        if (req.method === 'POST' && parts[3] === 'expansion' && parts[4] === 'resume' && parts.length === 5) {
          const request = validateExpansionResumeRequest(await readJsonBody(req, config.maxBodyBytes));
          const result = await manager.resumeExpansion(id, request);
          return json(res, 202, { ...result, expansion: localizeExpansionMedia(await readExpansionSnapshot(internal.outputDir, new URLSearchParams(), result.job.workflowSummary?.expansion || {}), id) });
        }
        if (req.method === 'POST' && parts[3] === 'expansion' && parts[4] === 'cancel' && parts.length === 5) {
          validateExpansionCancelRequest(await readJsonBody(req, config.maxBodyBytes));
          const result = await manager.cancelExpansion(id);
          return json(res, 202, { ...result, expansion: localizeExpansionMedia(await readExpansionSnapshot(internal.outputDir, new URLSearchParams(), result.job.workflowSummary?.expansion || {}), id) });
        }
        if (
          req.method === 'POST'
          && parts[3] === 'audience'
          && ['resume', 'recover-rate-limit'].includes(parts[4])
          && parts.length === 5
        ) {
          const rateLimitRecovery = parts[4] === 'recover-rate-limit';
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
          if (rateLimitRecovery && typeof manager.signalRateLimitRecovery === 'function') {
            const recoverySignal = await manager.signalRateLimitRecovery(id, {
              idempotencyKey: resumeOptions.idempotencyKey,
            });
            if (recoverySignal.signaled) {
              return json(res, 202, {
                action: 'signaled',
                sourceJobId,
                checkpointJobId: id,
                stateOwnerJobId,
                job: recoverySignal.job,
                message: 'The running collector will skip the remaining cooldown and probe immediately.',
              });
            }
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
            maxAgeDays: sourceParams.maxAgeDays ?? 14,
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
            requestedBy: resumeOptions.requestedBy || (rateLimitRecovery ? 'rate_limit_manual_recovery' : 'audience_resume_api'),
            resumeCheckpointJobIds,
            forceCompleted: rateLimitRecovery || resumeOptions.forceCompleted,
            rateLimitRecoveryMode: rateLimitRecovery ? 'manual' : undefined,
          });
          return json(res, 202, {
            action: 'started',
            sourceJobId,
            checkpointJobId: id,
            stateOwnerJobId,
            readThroughJobIds: resumeCheckpointJobIds,
            job,
            message: rateLimitRecovery
              ? 'Rate-limit cooldown was cancelled and audience collection resumed from the saved checkpoint.'
              : 'Audience collection resumed in the original task from the saved checkpoint.',
          });
        }
        if (req.method === 'POST' && parts[3] === 'audience' && parts[4] === 'grow' && parts.length === 5) {
          const request = validateAudienceGrowthRequest(await readJsonBody(req, config.maxBodyBytes));
          const {
            sourceJobId,
            stateOwnerJobId,
            readThroughJobIds: resumeCheckpointJobIds,
          } = await resolveAudienceResumeOwner(manager, id);
          const sourceInternal = manager.getInternal(sourceJobId);
          const sourceJob = manager.get(sourceJobId);
          const requestedJob = manager.get(id);
          if (!sourceInternal || !sourceJob || !requestedJob) {
            const error = new Error('Audience growth source task was not found.');
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
          const sourceParams = sourceInternal.params || sourceInternal.config || sourceJob.config || {};
          const params = validateRunRequest({
            ...sourceParams,
            analysisMode: 'general',
            searchSort: 'latest',
            maxAgeDays: sourceParams.maxAgeDays ?? 14,
            limit: 0,
            maxScrolls: request.maxScrolls,
            mode: 'resume',
            resumeFromJobId: sourceJobId,
            completeMissingOnly: false,
            collectAudience: true,
            audienceOnly: false,
            discoverMore: true,
            checkOnly: false,
            securityVerificationTimeoutSeconds: 86400,
            aiSessionId: null,
            profileId: null,
          });
          const job = await manager.resume(id, {
            scope: 'full',
            params,
            requestedBy: 'audience_grow_api',
            resumeCheckpointJobIds,
            forceCompleted: true,
          });
          return json(res, 202, {
            action: 'started',
            sourceJobId,
            checkpointJobId: id,
            stateOwnerJobId,
            readThroughJobIds: resumeCheckpointJobIds,
            maxScrolls: request.maxScrolls,
            job,
            message: 'Latest-first discovery started; existing audience data will be retained and merged.',
          });
        }
        if (parts[3] === 'application-attachments' && parts.length === 4 && req.method === 'GET') {
          return json(res, 200, await listApplicationAttachments(
            internal.outputDir,
            url.searchParams.get('noteId'),
            deliveryAttachmentLimits,
          ));
        }
        if (parts[3] === 'application-attachments' && parts.length === 4 && req.method === 'POST') {
          const upload = await readApplicationAttachmentUpload(req, deliveryAttachmentLimits);
          const result = await mutateApplicationAttachments(
            internal.outputDir,
            deliveryStateWriter,
            () => createApplicationAttachment(internal.outputDir, {
              jobId: id,
              noteId: String(upload.fields.noteId || ''),
              source: 'uploaded',
              displayName: upload.fields.displayName,
              selected: upload.fields.selected !== 'false',
              file: upload.file,
            }, deliveryAttachmentLimits),
          );
          return json(res, result.duplicate ? 200 : 201, result);
        }
        if (parts[3] === 'application-attachments' && parts[4] === 'from-artifact' && parts.length === 5 && req.method === 'POST') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const artifact = await resolveDownload(internal.outputDir, String(body?.artifactId || ''));
          const portablePath = artifact.relative.replaceAll('\\', '/');
          if (portablePath.startsWith('application-attachments/')) {
            throw new AttachmentError('ATTACHMENT_PATH_INVALID', 'Application delivery internals cannot be re-imported as Job artifacts.');
          }
          if (artifact.size > deliveryAttachmentLimits.maxFileBytes) {
            throw new AttachmentError(
              'ATTACHMENT_TOO_LARGE',
              `Attachment exceeds ${deliveryAttachmentLimits.maxFileBytes} bytes.`,
              413,
            );
          }
          const originalName = path.basename(artifact.relative);
          const clientMediaType = applicationAttachmentMediaType(originalName);
          const artifactBuffer = await readFile(artifact.absolute);
          const result = await mutateApplicationAttachments(
            internal.outputDir,
            deliveryStateWriter,
            () => createApplicationAttachment(internal.outputDir, {
              jobId: id,
              noteId: String(body?.noteId || ''),
              source: 'job_artifact',
              displayName: body?.displayName || originalName,
              generatedFrom: `artifact:${String(body?.artifactId || '')}`,
              draftId: body?.draftId,
              draftVersion: body?.draftVersion,
              selected: body?.selected !== false,
              file: {
                originalName,
                clientMediaType,
                buffer: artifactBuffer,
              },
            }, deliveryAttachmentLimits),
          );
          return json(res, result.duplicate ? 200 : 201, result);
        }
        if (parts[3] === 'application-attachments' && parts[4] === 'from-cover-letter' && parts.length === 5 && req.method === 'POST') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const noteId = String(body?.noteId || '').trim();
          const draftId = String(body?.draftId || '').trim();
          const draftVersion = Number(body?.draftVersion);
          if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
          if (!draftId || !Number.isInteger(draftVersion) || draftVersion < 1) {
            throw applicationDraftError('DRAFT_VERSION_REQUIRED', 'A saved draft version is required to export the Cover Letter.');
          }
          const record = await readApplicationRecord(internal.outputDir, noteId);
          const savedDraft = await withDeliveryStateLock(internal.outputDir, async () => {
            const state = await readDeliveryState(internal.outputDir);
            return resolveStoredDraftForAction(record, state[noteId] || {}, {
              draftId,
              version: draftVersion,
            });
          });
          const content = String(savedDraft.content.cover_letter || '').trim();
          if (!content) throw new ValidationError('The saved Cover Letter is empty.');
          const title = String(record?.title || noteId).replace(/[\\/:*?"<>|]/gu, '-').slice(0, 80) || noteId;
          const originalName = `${title}-Cover-Letter.txt`;
          const result = await mutateApplicationAttachments(
            internal.outputDir,
            deliveryStateWriter,
            () => createApplicationAttachment(internal.outputDir, {
              jobId: id,
              noteId,
              source: 'generated_cover_letter',
              displayName: originalName,
              generatedFrom: `draft:${savedDraft.draftId}:v${savedDraft.version}`,
              draftId: savedDraft.draftId,
              draftVersion: savedDraft.version,
              selected: body?.selected !== false,
              file: {
                originalName,
                clientMediaType: 'text/plain',
                buffer: Buffer.from(content, 'utf8'),
              },
            }, deliveryAttachmentLimits),
          );
          return json(res, result.duplicate ? 200 : 201, result);
        }
        if (parts[3] === 'application-attachments' && parts[4] === 'from-profile' && parts.length === 5 && req.method === 'POST') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const profileId = String(body?.profileId || '').trim();
          if (!profileId || profileId !== String(internal.params?.profileId || '')) {
            throw applicationDraftError(
              'PROFILE_SOURCE_JOB_MISMATCH',
              'The selected candidate profile is not attached to this Job.',
            );
          }
          if (typeof profileStore?.readSourceFile !== 'function') {
            throw applicationDraftError('PROFILE_SOURCE_UNAVAILABLE', 'Candidate profile sources are unavailable.');
          }
          const file = await profileStore.readSourceFile(profileId, body?.sourceFile);
          const result = await mutateApplicationAttachments(
            internal.outputDir,
            deliveryStateWriter,
            () => createApplicationAttachment(internal.outputDir, {
              jobId: id,
              noteId: String(body?.noteId || ''),
              source: 'candidate_profile',
              displayName: body?.displayName || file.originalName,
              generatedFrom: `candidate_profile:${profileId}`,
              draftId: body?.draftId,
              draftVersion: body?.draftVersion,
              selected: body?.selected !== false,
              file,
            }, deliveryAttachmentLimits),
          );
          return json(res, result.duplicate ? 200 : 201, result);
        }
        if (parts[3] === 'application-attachments' && parts[4] && parts[5] === 'content' && parts.length === 6 && req.method === 'GET') {
          const file = await resolveApplicationAttachmentDownload(internal.outputDir, parts[4]);
          res.writeHead(200, {
            'Content-Type': file.attachment.mediaType,
            'Content-Length': file.size,
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.attachment.displayName)}`,
            'Cache-Control': 'private, no-store',
          });
          return file.stream().pipe(res);
        }
        if (parts[3] === 'application-attachments' && parts[4] && parts.length === 5 && req.method === 'PATCH') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          return json(res, 200, await mutateApplicationAttachments(
            internal.outputDir,
            deliveryStateWriter,
            () => updateApplicationAttachment(
              internal.outputDir,
              parts[4],
              body,
              deliveryAttachmentLimits,
            ),
          ));
        }
        if (parts[3] === 'application-attachments' && parts[4] && parts.length === 5 && req.method === 'DELETE') {
          return json(res, 200, await mutateApplicationAttachments(
            internal.outputDir,
            deliveryStateWriter,
            () => deleteApplicationAttachment(internal.outputDir, parts[4]),
          ));
        }
        if (req.method === 'POST' && parts[3] === 'delivery' && parts.length === 4) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          return json(res, 200, await updateDeliveryState(internal.outputDir, body));
        }
        if (req.method === 'POST' && parts[3] === 'draft' && parts.length === 4) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          return json(res, 200, await updateApplicationDraft(internal.outputDir, body, deliveryStateWriter));
        }
        if (req.method === 'POST' && parts[3] === 'application-generation' && parts[4] === 'writeback' && parts.length === 5) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          return json(res, 200, await writeApplicationGeneration(internal.outputDir, body, deliveryStateWriter));
        }
        if (req.method === 'POST' && parts[3] === 'draft' && parts[4] === 'rewrite' && parts.length === 5) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const ai = resolveDraftAiRuntime(aiSessions, internal, body);
          const candidateProfile = await resolveCandidateProfile(internal);
          return json(res, 200, await rewriteApplicationCoverLetter(
            internal.outputDir,
            body,
            runCoverLetterRewrite,
            ai,
            candidateProfile,
            deliveryStateWriter,
          ));
        }
        if (req.method === 'POST' && parts[3] === 'draft' && parts[4] === 'quality' && parts.length === 5) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const ai = resolveDraftAiRuntime(aiSessions, internal, body);
          const candidateProfile = await resolveCandidateProfile(internal);
          return json(res, 200, await recheckApplicationDraft(
            internal.outputDir,
            body,
            checkDraftQuality,
            ai,
            candidateProfile,
            deliveryStateWriter,
            deliveryAttachmentLimits,
          ));
        }
        if (parts[3] === 'application-batches') {
          const service = await getApplicationBatchService(id, internal);
          if (req.method === 'POST' && parts[4] === 'dry-run' && parts.length === 5) {
            return json(res, 200, await service.dryRun(await readJsonBody(req, config.maxBodyBytes)));
          }
          if (req.method === 'GET' && parts.length === 4) {
            return json(res, 200, { batches: await service.listBatches() });
          }
          if (req.method === 'POST' && parts.length === 4) {
            const result = await service.createBatch(await readJsonBody(req, config.maxBodyBytes));
            return json(res, result.idempotentReplay ? 200 : 201, result);
          }
          const batchId = String(parts[4] || '').trim();
          if (req.method === 'GET' && batchId && parts.length === 5) {
            return json(res, 200, await service.getBatch(batchId));
          }
          if (req.method === 'GET' && batchId && parts[5] === 'events' && parts.length === 6) {
            return await streamApplicationBatchEvents(req, res, service, batchId, url.searchParams);
          }
          if (
            req.method === 'POST'
            && batchId
            && parts[5] === 'items'
            && parts[6]
            && parts[7] === 'reconcile'
            && parts.length === 8
          ) {
            return json(
              res,
              200,
              await service.reconcileItem(batchId, String(parts[6]).trim(), await readJsonBody(req, config.maxBodyBytes)),
            );
          }
          if (req.method === 'POST' && batchId && parts.length === 6) {
            const body = await readJsonBody(req, config.maxBodyBytes);
            if (parts[5] === 'approve') return json(res, 200, await service.approveBatch(batchId, body));
            if (parts[5] === 'start' || parts[5] === 'resume') {
              return json(res, 202, await service.startBatch(batchId, body));
            }
            if (parts[5] === 'pause') return json(res, 202, await service.pauseBatch(batchId, body));
            if (parts[5] === 'cancel') return json(res, 202, await service.cancelBatch(batchId, body));
          }
        }
        if (req.method === 'POST' && parts[3] === 'send-email' && parts[4] === 'preview' && parts.length === 5) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const replyTo = String(internal.params?.candidateProfile?.email || '').trim();
          const recipientEvidence = await assertDirectRecipientEvidence(id, internal, body);
          return json(res, 200, await previewApplicationEmail(
            internal.outputDir,
            body,
            replyTo,
             deliveryMailer,
             smtpConfig,
             deliveryAttachmentLimits,
             deliveryStateWriter,
             { allowedRecipients: recipientEvidence ? [recipientEvidence.address] : [] },
           ));
        }
        if (req.method === 'POST' && parts[3] === 'send-email' && parts.length === 4) {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const replyTo = String(internal.params?.candidateProfile?.email || '').trim();
          const recipientEvidence = await assertDirectRecipientEvidence(id, internal, body);
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
               attachmentLimits: deliveryAttachmentLimits,
               allowedRecipients: recipientEvidence ? [recipientEvidence.address] : [],
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
      if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/codex' || url.pathname.startsWith('/codex/'))) {
        if (url.pathname === '/codex') {
          res.writeHead(302, { Location: '/codex/' });
          return res.end();
        }
        const runtime = codexRuntimeCompatibility?.status?.();
        if (runtime && runtime.ready === false) {
          return json(res, 503, errorBody(
            'CODEX_BROWSER_RUNTIME_INCOMPATIBLE',
            'Codex browser runtime is not compatible with the active known-good baseline.',
            { runtime },
          ));
        }
        try {
          if (await serveCodexWebview(req, res, config, url.pathname, codexRuntimeCompatibility)) return;
        } catch (error) {
          if (String(error?.code || '').startsWith('CODEX_RUNTIME_')) {
            return json(res, 503, errorBody('CODEX_BROWSER_RUNTIME_INCOMPATIBLE', 'Codex browser runtime changed after compatibility inspection.'));
          }
          throw error;
        }
        return json(res, 404, errorBody('CODEX_BROWSER_ASSET_NOT_FOUND', 'Codex browser asset not found.'));
      }
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
      if (error instanceof AudienceAiValidationError || String(error.code || '').startsWith('AUDIENCE_AI_')) {
        const code = error.code || 'AUDIENCE_AI_INVALID_SCOPE';
        return json(res, audienceAiHttpStatus(code), audienceAiErrorBody(error, {
          code,
          requestId,
          jobId: error.jobId || parts[2] || null,
          postId: error.postId || (parts[5] ? safeDecodePathSegment(parts[5]) : null),
          runId: error.runId || (parts[7] === 'runs' && parts[8] ? safeDecodePathSegment(parts[8]) : null),
        }));
      }
      if (error instanceof ApplicationBatchServiceError || String(error.code || '').startsWith('APPLICATION_BATCH_')) {
        return json(res, Number(error.status || 400), {
          ...errorBody(error.code || 'APPLICATION_BATCH_FAILED', error.message),
          ...(error.details !== undefined ? { details: error.details } : {}),
        });
      }
      if (error instanceof ApplicationDeliveryCandidateError || String(error.code || '').startsWith('APPLICATION_CANDIDATE_')) {
        return json(res, Number(error.status || 400), errorBody(error.code || 'APPLICATION_CANDIDATE_QUERY_INVALID', error.message));
      }
      if (error instanceof AttachmentError || String(error.code || '').startsWith('ATTACHMENT_')) {
        return json(res, Number(error.status || 400), errorBody(error.code || 'ATTACHMENT_INVALID', error.message));
      }
      if (String(error.code || '').startsWith('EMAIL_RECIPIENT_EVIDENCE_')) {
        return json(res, Number(error.status || 400), errorBody(error.code, error.message));
      }
      if (String(error.code || '').startsWith('XHS_CONTEXT_')) {
        return json(res, Number(error.status || 400), {
          ...errorBody(error.code, error.message),
          ...(error.details !== undefined ? { details: error.details } : {}),
        });
      }
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
      if (error.code === 'EVENT_CURSOR_INVALID') return json(res, 400, errorBody(error.code, error.message));
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
        'EXPANSION_SOURCE_INVALID',
        'EXPANSION_ALREADY_INITIALIZED',
        'EXPANSION_NOT_RESUMABLE',
        'EXPANSION_ALREADY_RUNNING',
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
      if (['AUTH_INVALID_CREDENTIALS', 'AUTH_RATE_LIMITED'].includes(error.code)) {
        return json(res, Number(error.status || (error.code === 'AUTH_RATE_LIMITED' ? 429 : 401)), {
          ...errorBody(error.code, error.message),
          ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        });
      }
      if (String(error.code || '').startsWith('AUTH_')) return json(res, Number(error.status || 500), errorBody(error.code, error.message));
      if (['AI_VALIDATION', 'AI_SESSION_EXPIRED', 'PROFILE_VALIDATION', 'PROFILE_AI_SESSION_REQUIRED', 'RELAY_CONFIG_VALIDATION', 'SMTP_CONFIG_VALIDATION'].includes(error.code)) return json(res, 400, errorBody(error.code, error.message));
      if (['AI_MODEL_DISCOVERY_FAILED', 'AI_PROBE_FAILED'].includes(error.code)) return json(res, 502, errorBody(error.code, error.message));
      if (error.code === 'LOCAL_MODEL_VALIDATION') return json(res, 400, errorBody(error.code, error.message));
      if (error.code === 'LOCAL_MODEL_BUSY') return json(res, 409, { ...errorBody(error.code, error.message), install: error.install });
      if (error.code === 'LOCAL_MODEL_RUNTIME_UNAVAILABLE') return json(res, 503, errorBody(error.code, error.message));
      if (['PROFILE_NOT_FOUND', 'PROFILE_SOURCE_NOT_FOUND'].includes(error.code)) return json(res, 404, errorBody(error.code, error.message));
      if (['PROFILE_SOURCE_JOB_MISMATCH', 'PROFILE_SOURCE_UNAVAILABLE'].includes(error.code)) {
        return json(res, 409, errorBody(error.code, error.message));
      }
      if (error.code === 'PROFILE_IMPORT_FAILED') return json(res, 422, errorBody(error.code, error.message));
      if (['MAIL_NOT_CONFIGURED', 'SMTP_NOT_CONFIGURED'].includes(error.code)) return json(res, 503, errorBody(error.code, error.message));
      if (error.code === 'SMTP_CONFIG_CONFLICT') {
        return json(res, 409, {
          ...errorBody(error.code, error.message),
          currentRevision: error.currentRevision ?? null,
        });
      }
      if ([
        'SMTP_NOT_VERIFIED',
        'SMTP_VERIFICATION_EXPIRED',
        'EMAIL_IDEMPOTENCY_CONFLICT',
        'EMAIL_IDEMPOTENCY_REQUIRED',
        'EMAIL_PREVIEW_REQUIRED',
        'EMAIL_PREVIEW_STALE',
      ].includes(error.code)) {
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
      if (error.code === 'AI_COVER_LETTER_REWRITE_FAILED' || String(error.code || '').startsWith('COVER_LETTER_REWRITE_')) {
        return json(res, 502, errorBody(error.code, error.message));
      }
      if (error.code === 'EMAIL_SEND_STATUS_UNKNOWN') return json(res, 409, errorBody(error.code, error.message));
      if (error.code === 'DELIVERY_STATE_REVISION_CONFLICT') {
        return json(res, 409, errorBody(error.code, error.message));
      }
      if (['DELIVERY_STATE_INVALID', 'DELIVERY_AUDIT_INVALID'].includes(error.code)) {
        return json(res, 500, errorBody(error.code, error.message));
      }
      if (['EMAIL_DELIVERED_AUDIT_STATE_PENDING', 'EMAIL_DELIVERED_AUDIT_UNCERTAIN'].includes(error.code)) {
        return json(res, 500, errorBody(error.code, error.message));
      }
      if (error instanceof SyntaxError) return json(res, 400, errorBody('INVALID_JSON', 'Request body must contain valid JSON.'));
      if (String(error.code || '').startsWith('CODEX_DESKTOP_')) {
        return json(res, Number(error.status || 500), errorBody(error.code, error.message, error.details));
      }
      if (String(error.code || '').startsWith('CODEX_RELAY_')) {
        return json(res, Number(error.status || 500), errorBody(error.code, error.message, error.details));
      }
      if (String(error.code || '').startsWith('CODEX_CONNECT')) {
        return json(res, Number(error.status || 500), errorBody(error.code, error.message, error.details));
      }
      if (String(error.code || '').startsWith('CODEX_MIRROR_')) {
        return json(res, Number(error.status || 500), errorBody(error.code, error.message, error.details));
      }
      if (
        String(error.code || '').startsWith('CODEX_GATEWAY_')
        || String(error.code || '').startsWith('CODEX_DEVICE_')
        || String(error.code || '').startsWith('CODEX_PAIRING_')
        || String(error.code || '').startsWith('CODEX_TURN_')
        || String(error.code || '').startsWith('CODEX_ICE_')
      ) {
        return json(res, Number(error.status || 500), errorBody(error.code, error.message, error.details));
      }
      if (error.code === 'ENOENT' || /Path escapes/.test(error.message)) {
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

const EXPERIENCE_STAGES = new Set([
  'preflight', 'discovery', 'body', 'classify', 'extract', 'match', 'draft', 'quality',
  'audience', 'artifact', 'delivery', 'checkpoint', 'task',
]);

function validateExperienceActionBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  const unsupported = Object.keys(body).filter((field) => !allowed.has(field));
  if (unsupported.length) {
    throw new ValidationError(
      'Unsupported job action parameters.',
      unsupported.map((field) => ({ field, reason: 'not_allowed' })),
    );
  }
  return body;
}

function validateExperienceStage(value) {
  const stage = String(value || '').trim();
  if (!EXPERIENCE_STAGES.has(stage)) {
    throw new ValidationError('Unsupported workflow stage.', [{ field: 'stage', reason: 'unsupported_stage' }]);
  }
  return stage;
}

function experienceResumeScope(stage) {
  if (stage === 'discovery') return 'discovery';
  if (stage === 'body') return 'body_completion';
  if (['classify', 'extract', 'match', 'draft', 'quality'].includes(stage)) return 'analysis';
  if (stage === 'audience') return 'audience';
  if (stage === 'artifact') return 'artifacts';
  return 'full';
}

function experienceActionFailure(error, job) {
  const code = String(error?.code || '');
  const status = code === 'JOB_NOT_FOUND'
    ? 404
    : ['RESUME_SOURCE_NOT_FOUND', 'RESUME_CHECKPOINTS_MISSING', 'RESUME_SCOPE_INVALID', 'IDEMPOTENCY_KEY_INVALID'].includes(code)
      ? 400
      : [
          'JOB_BUSY',
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
        ].includes(code)
        ? 409
        : 0;
  if (!status) return null;
  return {
    status,
    body: experienceErrorPayload(code, String(error.message || 'The job action failed.'), job, error.details),
  };
}

function experienceErrorPayload(code, message, job, details) {
  const snapshot = job?.experienceSnapshot || job?.experience;
  const issues = Array.isArray(snapshot?.issues) ? snapshot.issues : [];
  const problem = issues.find((item) => item?.code === code) || issues[0] || null;
  return {
    code,
    message,
    ...(problem ? {
      problem,
      retryAt: problem.retryAt || null,
      action: problem.action || null,
    } : {}),
    resumable: problem?.retryable === true || snapshot?.checkpoint?.resumeAvailable === true || job?.resumeAvailable === true,
    ...(details !== undefined ? { details } : {}),
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

function experienceDiagnostics(job, diagnostics) {
  const snapshot = job?.experienceSnapshot || job?.experience || {};
  const bundle = diagnostics?.bundle?.() || {};
  const events = Array.isArray(bundle.events)
    ? bundle.events.filter((event) => event?.jobId === job.id).slice(-100)
    : [];
  return {
    schemaVersion: 1,
    generatedAt: bundle.generatedAt || new Date().toISOString(),
    jobId: job.id,
    status: job.status,
    state: snapshot.state || null,
    activeStage: snapshot.activeStage || null,
    activeAttemptId: snapshot.activeAttemptId || job.activeAttemptId || null,
    currentAttemptId: job.currentAttemptId || null,
    revision: Number(snapshot.revision || job.revision || 0),
    throughSequence: Number(snapshot.throughSequence || job.throughSequence || 0),
    checkpoint: snapshot.checkpoint || null,
    connection: snapshot.connection || null,
    issues: Array.isArray(snapshot.issues)
      ? snapshot.issues.map((issue) => ({
          code: String(issue.code || ''),
          affectedStage: String(issue.affectedStage || ''),
          technicalRef: String(issue.technicalRef || ''),
        }))
      : [],
    rateLimit: publicAccessRestriction(job.rateLimit, [
      'detected', 'status', 'detectedAt', 'nextRetryAt', 'retryAfterSeconds', 'stableSuccesses', 'recoveryAction',
    ]),
    securityRestriction: publicAccessRestriction(job.securityRestriction, [
      'detected', 'status', 'detectedAt', 'timeoutSeconds', 'recoveryAction',
    ]),
    runtime: bundle.runtime || { node: process.version, platform: process.platform, architecture: process.arch },
    events,
  };
}

function publicAccessRestriction(value, fields) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
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

function applicationCompletionCount(results) {
  const incomplete = nonNegativeCount(results?.filters?.stats?.incomplete);
  const sourcePending = nonNegativeCount(results?.sourceCoverage?.pendingCount);
  const publishedWithoutBody = Math.max(
    0,
    nonNegativeCount(results?.sourceCoverage?.totalRecordCount)
      - nonNegativeCount(results?.sourceCoverage?.fullBodyCount),
  );
  return sourcePending + Math.max(0, incomplete - publishedWithoutBody);
}

function applicationCoverageFromRecords(records, payload, task) {
  const workflowSummary = isRecord(task?.workflowSummary) ? task.workflowSummary : {};
  const bodyMetrics = isRecord(workflowSummary.bodyMetrics) ? workflowSummary.bodyMetrics : {};
  const sourceCoverage = isRecord(payload?.source_coverage)
    ? payload.source_coverage
    : (isRecord(workflowSummary.sourceCoverage) ? workflowSummary.sourceCoverage : {});
  const qualityGate = isRecord(payload?.quality_gate) ? payload.quality_gate : {};
  const recordList = Array.isArray(records) ? records : [];
  const count = (predicate) => recordList.filter(predicate).length;
  const generatedDrafts = count((record) => {
    const outreach = isRecord(record?.outreach) ? record.outreach : {};
    return ['greeting', 'email_subject', 'email_body', 'cover_letter']
      .every((field) => String(outreach[field] || '').trim());
  });
  const generatedJobCards = count((record) => isRecord(record?.job_card) || isRecord(record?.application_info));
  const normalizedTimes = count((record) => {
    const publishTime = isRecord(record?.publish_time) ? record.publish_time : {};
    return Boolean(publishTime.value ?? publishTime.normalized);
  });
  const qualityPassed = count((record) => {
    const quality = isRecord(record?.quality) ? record.quality : null;
    return Boolean(quality) && Object.values(quality).every(Boolean);
  });
  const firstFinite = (...values) => values.find((value) => (
    value !== null
    && value !== undefined
    && Number.isFinite(Number(value))
  ));
  const discovered = firstFinite(
    sourceCoverage.targetCount,
    qualityGate.discovered_count,
    workflowSummary.cardsDiscovered,
    workflowSummary.discovered,
    recordList.length,
  ) ?? 0;
  const bodyAttempted = firstFinite(
    bodyMetrics.attempted,
    sourceCoverage.totalRecordCount,
    workflowSummary.bodyAttempted,
    recordList.length,
  ) ?? 0;
  const bodySucceeded = firstFinite(
    bodyMetrics.succeeded,
    sourceCoverage.fullBodyCount,
    workflowSummary.bodySucceeded,
    count((record) => String(record?.body || '').trim().length > 0),
  ) ?? 0;
  const generatedRecordCount = recordList.length || Number(qualityGate.record_count) || 0;
  return {
    discovered: nonNegativeCount(discovered),
    bodyAttempted: nonNegativeCount(bodyAttempted),
    bodySucceeded: nonNegativeCount(bodySucceeded),
    bodyFailed: nonNegativeCount(firstFinite(bodyMetrics.failed, workflowSummary.bodyFailed)),
    bodyNotAttempted: nonNegativeCount(firstFinite(bodyMetrics.notAttempted, workflowSummary.bodyNotAttempted)),
    bodyBlocked: nonNegativeCount(firstFinite(bodyMetrics.blocked, workflowSummary.bodyBlocked)),
    bodyCancelled: nonNegativeCount(firstFinite(bodyMetrics.cancelled, workflowSummary.bodyCancelled)),
    bodyCompletionRatePercent: bodyAttempted > 0 ? Math.round((bodySucceeded / bodyAttempted) * 10000) / 100 : 0,
    timesNormalized: recordList.length ? normalizedTimes : nonNegativeCount(workflowSummary.timesNormalized),
    applicationInfo: recordList.length ? generatedJobCards : nonNegativeCount(workflowSummary.applicationInfo),
    draftsGenerated: recordList.length ? generatedDrafts : nonNegativeCount(workflowSummary.draftsGenerated),
    generationCoveragePercent: generatedRecordCount > 0
      ? Math.round((generatedDrafts / generatedRecordCount) * 10000) / 100
      : nonNegativeCount(workflowSummary.generationCoveragePercent),
    qualityPassed: Number.isFinite(Number(workflowSummary.qualityPassed))
      ? nonNegativeCount(workflowSummary.qualityPassed)
      : (recordList.length ? qualityPassed : 0),
    gatePassed: typeof qualityGate.passed === 'boolean' ? qualityGate.passed : undefined,
    issueCount: Array.isArray(qualityGate.issues) ? qualityGate.issues.length : undefined,
  };
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

function applicationResultSearchText(record) {
  const applicationInfo = record?.application_info || {};
  const contactsAndRoutes = [
    ...(Array.isArray(applicationInfo.contacts) ? applicationInfo.contacts : []),
    ...(Array.isArray(applicationInfo.application_routes) ? applicationInfo.application_routes : []),
    ...(Array.isArray(applicationInfo.routes) ? applicationInfo.routes : []),
  ];
  return [
    record?.note_id,
    record?.title,
    record?.body,
    record?.job_card?.role_name,
    record?.job_card?.title,
    ...contactsAndRoutes.flatMap((item) => [item?.value, item?.evidence]),
    record?.outreach?.email_subject,
    record?.outreach?.email_body,
  ]
    .map((value) => String(value ?? ''))
    .join('\n')
    .toLocaleLowerCase('zh-CN');
}

function withApplicationAttachmentRequirement(record) {
  const rule = detectApplicationAttachmentRule(record);
  const subjectResolution = resolveApplicationEmailSubject(record, record?.outreach?.email_subject);
  const subjectRule = subjectResolution.rule;
  return {
    ...record,
    attachmentRequirement: {
      detected: rule.detected,
      template: rule.template,
      evidence: rule.evidence,
      fields: rule.fields,
    },
    emailSubjectRequirement: {
      detected: subjectRule.detected,
      template: subjectRule.template,
      evidence: subjectRule.evidence,
      fields: subjectRule.fields,
      source: subjectRule.source,
      ...(subjectRule.attachmentTemplate
        ? { attachmentTemplate: subjectRule.attachmentTemplate }
        : {}),
      ...(subjectRule.literal ? { literal: true } : {}),
    },
    emailSubjectPreview: subjectResolution.subject,
    emailSubjectGuard: subjectResolution.subjectGuard,
  };
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
      )).map((record) => enrichApplicationRecordContacts(localizeApplicationMedia(record, task.id)))
      : [];
    const source = analysisMode === 'general'
      ? hydratedSource.map(toGeneralContentRecord)
      : hydratedSource;
    const queried = query
      ? source.filter((record) => applicationResultSearchText(record).includes(query))
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
      items: records.slice(offset, offset + limit).map(withApplicationAttachmentRequirement),
      filters: { sort, timeRange, stats: filterStats },
      codexRuntime: payload.ai_workflow || payload.codex_runtime || null,
      qualityGate: payload.quality_gate || null,
      sourceCoverage: payload.source_coverage || task.workflowSummary?.sourceCoverage || null,
      coverage: applicationCoverageFromRecords(hydratedSource, payload, task),
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
      sourceCoverage: task.workflowSummary?.sourceCoverage || null,
      coverage: null,
    };
    throw error;
  }
}

async function readApplicationContactRecords(outputDir, task = {}) {
  const payload = await readLatestApplicationPayload(outputDir);
  const delivery = await readDeliveryState(outputDir);
  const legacyMedia = await readLegacyMediaSources(outputDir);
  return Array.isArray(payload.records)
    ? payload.records.map((record, recordIndex) => {
      const hydratedRecord = hydrateApplicationCandidateProfile(record, payload);
      return enrichApplicationRecordContacts(
        localizeApplicationMedia(
          mergeApplicationState(
            hydrateApplicationMedia(hydratedRecord, legacyMedia.get(record.note_id)),
            delivery[record.note_id],
            recordIndex,
            payload[APPLICATION_ARTIFACT_FILENAME],
          ),
          task.id,
        ),
      );
    })
    : [];
}

function applicationContactResolutionReport(records, resolutions) {
  const items = records.map((record, index) => {
    const resolution = resolutions[index] || {};
    const images = Array.isArray(record.media?.images) ? record.media.images : [];
    const analysis = record.media?.analysis && typeof record.media.analysis === 'object'
      ? record.media.analysis
      : {};
    const contactOcr = analysis.contact_ocr && typeof analysis.contact_ocr === 'object'
      ? analysis.contact_ocr
      : {};
    const candidates = Array.isArray(resolution.candidates) ? resolution.candidates : [];
    const hasBodyEmail = candidates.some((candidate) => candidate.source === 'body' && candidate.actionable !== false);
    const persistedImageOcrStatus = contactOcr.status || (
      analysis.status === 'analyzed' && ['vision_model', 'image_ocr_model', 'image_ocr', 'ocr'].includes(analysis.source)
        ? 'complete'
        : ''
    );
    return {
      noteId: String(record.note_id || record.post_id || record.id || ''),
      postId: String(resolution.postId || record.post_id || record.note_id || ''),
      title: String(record.title || record.job_card?.role_name || ''),
      imageCount: images.length,
      imageOcrStatus: persistedImageOcrStatus
        || (images.length ? (hasBodyEmail ? 'skipped_body_email' : 'pending') : 'not_applicable'),
      imageOcrAttempts: Number(contactOcr.attempts || 0),
      status: String(resolution.status || 'pending'),
      reason: String(resolution.reason || ''),
      collectionStatus: String(resolution.collectionStatus || 'pending'),
      requiresReview: resolution.requiresReview === true,
      candidates: candidates.map((candidate) => ({
        address: candidate.address,
        source: candidate.source,
        noteId: candidate.noteId,
        postId: candidate.postId,
        confidence: candidate.confidence,
        collectionStatus: candidate.collectionStatus,
        verificationStatus: candidate.verificationStatus,
        normalizationApplied: candidate.normalizationApplied,
        sourceFields: candidate.sourceFields,
        evidenceText: candidate.evidenceText,
        evidenceHash: candidate.evidenceHash,
        sourceRevision: applicationContactSourceRevision(candidate),
        commentId: candidate.commentId,
        authorId: candidate.authorId,
        ownershipStatus: candidate.ownershipStatus,
        actionable: candidate.actionable,
        requiresReview: candidate.requiresReview,
      })),
    };
  });
  const hasCandidateSource = (item, sources) => item.candidates.some((candidate) => sources.has(candidate.source));
  const withImages = items.filter((item) => item.imageCount > 0);
  return {
    summary: {
      totalRecords: items.length,
      withImages: withImages.length,
      imageOcrComplete: withImages.filter((item) => item.imageOcrStatus === 'complete').length,
      imageOcrPending: withImages.filter((item) => item.imageOcrStatus === 'pending').length,
      imageOcrFailed: withImages.filter((item) => item.imageOcrStatus === 'failed').length,
      imageOcrSkippedBodyEmail: withImages.filter((item) => item.imageOcrStatus === 'skipped_body_email').length,
      bodyEmailRecords: items.filter((item) => hasCandidateSource(item, new Set(['body']))).length,
      imageEmailRecords: items.filter((item) => hasCandidateSource(item, new Set(['image']))).length,
      commentEmailRecords: items.filter((item) => hasCandidateSource(item, new Set(['author_comment', 'other_comment']))).length,
      ready: items.filter((item) => item.status === 'ready').length,
      manualReview: items.filter((item) => item.status === 'manual_review').length,
      commentsPending: items.filter((item) => item.collectionStatus === 'pending' && !item.candidates.length).length,
      commentsPartial: items.filter((item) => item.collectionStatus === 'partial' && !item.candidates.length).length,
      noEmailConfirmed: items.filter((item) => item.status === 'no_email').length,
    },
    items,
  };
}

async function readLatestApplicationPayload(outputDir) {
  const candidates = await Promise.all(
    [
      'application_intelligence.checkpoint.json',
      'application_intelligence.json',
      'xiaohongshu_notes_latest.json',
      'xiaohongshu_cards_latest.json',
    ].map(async (filename) => {
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
  // Keep the existing analyzed snapshot authoritative whenever it exists. Raw
  // collection files are a live fallback while analysis has not produced a
  // snapshot yet; letting a newer raw file win would drop hydrated fields and
  // break legacy result semantics during an in-progress collection.
  const intelligence = available.filter((candidate) => candidate.filename.startsWith('application_intelligence'));
  const ordered = intelligence.length
    ? [...intelligence, ...available.filter((candidate) => !candidate.filename.startsWith('application_intelligence'))]
    : available;
  let lastError = null;
  for (const candidate of ordered) {
    try {
      const decoded = JSON.parse(await readFile(candidate.filePath, 'utf8'));
      const payload = Array.isArray(decoded)
        ? { schema_version: 1, analysis_mode: 'job', source_kind: 'collection', records: decoded }
        : decoded;
      if (payload && Array.isArray(payload.records)) {
        if (payload.source_kind === 'collection') {
          payload.records = payload.records.map(normalizeCollectionApplicationRecord);
        }
        await mergeApplicationContactOcrOverlay(outputDir, payload.records);
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

function normalizeCollectionApplicationRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  const roleName = String(record.title || record.card_title || '').trim();
  const publishTime = record.publish_time && typeof record.publish_time === 'object'
    ? record.publish_time
    : {
        value: String(record.publish_time || '').trim(),
        is_estimated: true,
        precision: 'unknown',
        source: 'collection_snapshot',
      };
  const applicationInfo = record.application_info && typeof record.application_info === 'object'
    ? record.application_info
    : {};
  const outreach = record.outreach && typeof record.outreach === 'object' ? record.outreach : {};
  return {
    ...record,
    note_id: String(record.note_id || record.post_id || record.id || '').trim(),
    title: roleName,
    body: String(record.body || '').trim(),
    publish_time: publishTime,
    media: record.media && typeof record.media === 'object' ? record.media : undefined,
    job_card: record.job_card && typeof record.job_card === 'object'
      ? record.job_card
      : { role_name: roleName, title: roleName, parse_basis: 'search_card' },
    application_info: {
      ...applicationInfo,
      contacts: Array.isArray(applicationInfo.contacts) ? applicationInfo.contacts : [],
      application_routes: Array.isArray(applicationInfo.application_routes) ? applicationInfo.application_routes : [],
      responsibilities: Array.isArray(applicationInfo.responsibilities) && applicationInfo.responsibilities.length > 0
        ? applicationInfo.responsibilities
        : Array.isArray(record.responsibilities) ? record.responsibilities : [],
      requirements: Array.isArray(applicationInfo.requirements) && applicationInfo.requirements.length > 0
        ? applicationInfo.requirements
        : Array.isArray(record.requirements) ? record.requirements : [],
    },
    outreach: {
      greeting: String(outreach.greeting || ''),
      email_subject: String(outreach.email_subject || ''),
      email_body: String(outreach.email_body || ''),
      cover_letter: String(outreach.cover_letter || ''),
      ...outreach,
    },
    quality: record.quality && typeof record.quality === 'object' ? record.quality : {},
  };
}

async function mergeApplicationContactOcrOverlay(outputDir, records) {
  let overlay;
  try {
    overlay = JSON.parse(await readFile(path.join(outputDir, APPLICATION_CONTACT_OCR_OVERLAY), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
    throw error;
  }
  const entries = overlay?.records && typeof overlay.records === 'object' && !Array.isArray(overlay.records)
    ? overlay.records
    : {};
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object') continue;
    const noteId = String(record.note_id || record.post_id || record.id || `record-${index + 1}`).trim();
    const entry = entries[noteId];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const contactOcr = entry.contactOcr && typeof entry.contactOcr === 'object'
      ? entry.contactOcr
      : {};
    const media = record.media && typeof record.media === 'object' ? record.media : {};
    const analysis = media.analysis && typeof media.analysis === 'object' ? media.analysis : {};
    const routes = Array.isArray(entry.routes) ? entry.routes.filter((route) => route && typeof route === 'object') : [];
    const complete = contactOcr.status === 'complete';
    record.media = {
      ...media,
      analysis: {
        ...analysis,
        ...(complete ? {
          status: 'analyzed',
          source: 'image_ocr_model',
          visible_text: String(entry.visibleText || ''),
          ocr_text: String(entry.visibleText || ''),
          application_routes: routes,
          application_route_count: routes.length,
        } : {}),
        contact_ocr: contactOcr,
      },
    };
    if (!complete || routes.length === 0) continue;
    const applicationInfo = record.application_info && typeof record.application_info === 'object'
      ? record.application_info
      : {};
    const existingRoutes = Array.isArray(applicationInfo.application_routes)
      ? applicationInfo.application_routes.filter((route) => route && typeof route === 'object')
      : [];
    const merged = [];
    const positions = new Map();
    for (const route of [...existingRoutes, ...routes]) {
      const key = `${String(route.channel || route.type || 'other').toLowerCase()}:${String(route.value || '').trim().toLowerCase()}`;
      if (key.endsWith(':')) continue;
      if (positions.has(key)) {
        merged[positions.get(key)] = { ...merged[positions.get(key)], ...route };
      } else {
        positions.set(key, merged.length);
        merged.push({ ...route });
      }
    }
    record.application_info = { ...applicationInfo, application_routes: merged };
  }
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

function localizeExpansionMedia(result, jobId) {
  if (!result || !jobId) return result;
  const seeds = Array.isArray(result.seeds)
    ? result.seeds.map((seed) => {
      const sourceUrl = String(seed?.coverUrl || '').trim();
      if (!isCacheableMediaUrl(sourceUrl)) return seed;
      return {
        ...seed,
        coverUrl: `/api/jobs/${encodeURIComponent(jobId)}/media?url=${encodeURIComponent(sourceUrl)}`,
        coverOriginalUrl: sourceUrl,
      };
    })
    : [];
  return { ...result, seeds };
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
  const applicationInfo = record.application_info && typeof record.application_info === 'object'
    && !Array.isArray(record.application_info)
    ? record.application_info
    : {};
  record.application_info = {
    ...applicationInfo,
    responsibilities: Array.isArray(applicationInfo.responsibilities) && applicationInfo.responsibilities.length > 0
      ? applicationInfo.responsibilities
      : Array.isArray(record.responsibilities) ? record.responsibilities : [],
    requirements: Array.isArray(applicationInfo.requirements) && applicationInfo.requirements.length > 0
      ? applicationInfo.requirements
      : Array.isArray(record.requirements) ? record.requirements : [],
  };
  hydrateApplicationCandidateProfile(record, payload);
  Object.defineProperty(record, APPLICATION_RECORD_INDEX, { value: recordIndex, enumerable: false });
  Object.defineProperty(record, APPLICATION_ARTIFACT_FILENAME, {
    value: payload[APPLICATION_ARTIFACT_FILENAME],
    enumerable: false,
  });
  return record;
}

function hydrateApplicationCandidateProfile(record, payload) {
  const snapshot = payload?.profile_snapshot && typeof payload.profile_snapshot === 'object' && !Array.isArray(payload.profile_snapshot)
    ? payload.profile_snapshot
    : null;
  if (!snapshot || !record || typeof record !== 'object' || Array.isArray(record)) return record;
  const snapshotCandidate = snapshot.candidate && typeof snapshot.candidate === 'object' && !Array.isArray(snapshot.candidate)
    ? snapshot.candidate
    : {};
  const existingCandidate = record.candidate_profile && typeof record.candidate_profile === 'object' && !Array.isArray(record.candidate_profile)
    ? record.candidate_profile
    : {};
  const evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence : [];
  const resumeArtifacts = Array.isArray(snapshot.resumeArtifacts) ? snapshot.resumeArtifacts : [];
  const candidateProfile = {
    ...snapshotCandidate,
    ...existingCandidate,
    evidence_items: evidence,
    evidence,
    resumeArtifacts,
    profile_snapshot: {
      profileSnapshotId: String(snapshot.profileSnapshotId || '').trim(),
      evidence,
      resumeArtifacts,
      provenancePolicy: snapshot.provenancePolicy && typeof snapshot.provenancePolicy === 'object'
        ? snapshot.provenancePolicy
        : {},
    },
  };
  Object.defineProperty(record, 'candidate_profile', {
    value: candidateProfile,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return record;
}

async function readDeliveryState(outputDir) {
  try {
    const value = JSON.parse(await readFile(path.join(outputDir, 'delivery-state.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw deliveryStateInvalid('Delivery state root must be a JSON object.');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error?.code === 'DELIVERY_STATE_INVALID') throw error;
    if (error instanceof SyntaxError) throw deliveryStateInvalid('Delivery state JSON is malformed.', error);
    throw error;
  }
}

function withDeliveryStateLock(outputDir, operation) {
  return withApplicationDeliveryLock(outputDir, operation);
}

function deliveryStateInvalid(message, cause) {
  const error = applicationDraftError('DELIVERY_STATE_INVALID', message);
  if (cause) error.cause = cause;
  return error;
}

async function mutateApplicationAttachments(outputDir, writeState, operation) {
  return withDeliveryStateLock(outputDir, async () => {
    const state = await readDeliveryState(outputDir);
    const result = await operation();
    if (!result?.attachmentBundleChanged) return result;

    const noteId = String(result.noteId || result.attachment?.noteId || '').trim();
    if (!NOTE_ID.test(noteId)) {
      throw new AttachmentError('ATTACHMENT_PATH_INVALID', 'Attachment mutation did not identify a valid note.');
    }
    const record = await readApplicationRecord(outputDir, noteId);
    const existing = state[noteId] || {};
    const store = draftStoreFor(record, existing);
    const current = currentDraftVersion(store);
    if (current.qualityStatus === 'stale') return result;

    const updatedAt = new Date().toISOString();
    const updatedStore = {
      ...store,
      versions: store.versions.map((version) => (
        Number(version.version) === Number(store.currentVersion)
          ? {
              ...version,
              qualityStatus: 'stale',
              qualityCheckedVersion: null,
              qualityCheckedHash: null,
              qualityReportRef: null,
              updatedAt,
            }
          : { ...version }
      )),
    };
    state[noteId] = {
      ...existing,
      updatedAt,
      draft: { ...current.content },
      draftStore: updatedStore,
    };
    await writeState(outputDir, state);
    return result;
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
    await assertQualityReportReference(
      outputDir,
      record,
      resolved,
      null,
      applicationPeerCorpusHash(savedPeerDrafts(state, noteId)),
      persistedApplicationContextHash(existing),
    );
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

async function rewriteApplicationCoverLetter(
  outputDir,
  value,
  rewriter,
  ai,
  candidateProfile = {},
  writeState = writeDeliveryState,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Cover Letter rewrite body must be an object.');
  }
  const noteId = String(value.noteId || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  if (typeof value.instructions !== 'string') {
    throw new ValidationError('Cover Letter rewrite instructions must be a string.');
  }
  const instructions = value.instructions.trim();
  if (Array.from(instructions).length > 4_000) {
    throw new ValidationError('Cover Letter rewrite instructions must not exceed 4000 characters.');
  }
  if (typeof rewriter !== 'function') {
    throw applicationDraftError('AI_COVER_LETTER_REWRITE_FAILED', 'Cover Letter rewrite service is unavailable.');
  }

  const record = await readApplicationRecord(outputDir, noteId);
  const state = await readDeliveryState(outputDir);
  const existing = state[noteId] || {};
  const store = draftStoreFor(record, existing);
  const current = currentDraftVersion(store);
  const suppliedVersion = value.baseVersion ?? value.expectedVersion ?? value.version;
  const expectedVersion = suppliedVersion == null ? store.currentVersion : Number(suppliedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw applicationDraftError('DRAFT_VERSION_REQUIRED', 'A valid baseVersion is required for Cover Letter rewrite.');
  }
  if (expectedVersion !== store.currentVersion) {
    throw draftVersionConflict(expectedVersion, store.currentVersion);
  }
  const requestedDraftId = String(value.draftId || store.draftId).trim();
  if (requestedDraftId !== store.draftId) {
    throw applicationDraftError('DRAFT_ID_MISMATCH', 'The requested draftId does not match the stored draft.');
  }

  const currentDraft = normalizeDraft(value.outreach, current.content);
  const applicationContext = resolveApplicationContext(record, existing, value);
  const mergedCandidateProfile = {
    ...(record.candidate_profile && typeof record.candidate_profile === 'object' ? record.candidate_profile : {}),
    ...(candidateProfile && typeof candidateProfile === 'object' ? candidateProfile : {}),
  };
  // Some historical jobs stored only role-matched resume evidence on each
  // application record while the profile snapshot's evidence array was empty.
  // Rehydrate that evidence before prompting and before the server-side gate.
  const profileEvidence = Array.isArray(mergedCandidateProfile.evidence_items)
    ? mergedCandidateProfile.evidence_items
    : Array.isArray(mergedCandidateProfile.evidence)
      ? mergedCandidateProfile.evidence
      : [];
  if (profileEvidence.length === 0 && Array.isArray(record.fit_evidence) && record.fit_evidence.length > 0) {
    const fitEvidence = record.fit_evidence
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        ...item,
        source: String(item.source || 'application.fit_evidence').trim(),
      }));
    mergedCandidateProfile.evidence_items = fitEvidence;
    mergedCandidateProfile.evidence = fitEvidence;
    const snapshot = mergedCandidateProfile.profile_snapshot && typeof mergedCandidateProfile.profile_snapshot === 'object'
      ? mergedCandidateProfile.profile_snapshot
      : {};
    mergedCandidateProfile.profile_snapshot = {
      ...snapshot,
      evidence: fitEvidence,
    };
  }
  const requestId = randomUUID();
  let rewritten;
  try {
    rewritten = await rewriter({
      record,
      outreach: currentDraft,
      instructions,
      candidateProfile: mergedCandidateProfile,
      applicationContext,
      maxAttempts: 2,
    }, ai);
  } catch (error) {
    if (String(error?.code || '').startsWith('COVER_LETTER_REWRITE_')) throw error;
    const wrapped = applicationDraftError(
      'AI_COVER_LETTER_REWRITE_FAILED',
      `Cover Letter rewrite failed: ${String(error?.message || error)}`,
    );
    wrapped.cause = error;
    throw wrapped;
  }

  const normalizedRewrite = normalizeCoverLetterRewriteOutput(
    rewritten,
    currentDraft,
    record,
  );
  const coverLetter = normalizedRewrite.coverLetter;
  const requestedEmailSubject = normalizedRewrite.emailSubject;
  const emailSubjectResolution = resolveApplicationEmailSubject(record, requestedEmailSubject, {
    ...currentDraft,
    candidateProfile: mergedCandidateProfile,
  });
  const emailSubject = emailSubjectResolution.subject;
  if (!emailSubject || emailSubjectResolution.missingFields.length > 0) {
    throw applicationDraftError(
      'AI_COVER_LETTER_REWRITE_FAILED',
      'Cover Letter rewrite could not resolve a compliant email subject from the required naming rule.',
    );
  }
  const charCount = unicodeNonWhitespaceCount(coverLetter);
  const responsibilityCoverage = Array.isArray(rewritten?.responsibility_coverage)
    ? rewritten.responsibility_coverage
    : Array.isArray(rewritten?.responsibilityCoverage)
      ? rewritten.responsibilityCoverage
      : [];
  const evidenceCoverage = Array.isArray(rewritten?.evidence_coverage)
    ? rewritten.evidence_coverage
    : Array.isArray(rewritten?.evidenceCoverage)
      ? rewritten.evidenceCoverage
      : [];
  const usedEvidenceIds = Array.isArray(rewritten?.used_evidence_ids)
    ? rewritten.used_evidence_ids
    : Array.isArray(rewritten?.usedEvidenceIds)
      ? rewritten.usedEvidenceIds
      : [];
  assertCoverLetterRewriteResult(
    record,
    mergedCandidateProfile,
    coverLetter,
    charCount,
    responsibilityCoverage,
    usedEvidenceIds,
    evidenceCoverage,
  );

  const generatedAt = new Date().toISOString();
  const promptVersion = String(rewritten?.prompt_version || rewritten?.promptVersion || 'cover-letter-rewrite-v2').trim();
  const runtime = rewritten?.runtime && typeof rewritten.runtime === 'object' ? rewritten.runtime : {};
  const provider = String(runtime.provider || ai?.provider || '').trim();
  const model = String(runtime.model || ai?.model || '').trim();
  const wireApi = String(runtime.wireApi || runtime.wire_api || ai?.wireApi || '').trim();
  const strategy = String(rewritten?.generation_strategy || rewritten?.generationStrategy || 'direct_model_rewrite').trim();
  const modelCalls = Math.max(1, Math.min(10, Number(rewritten?.model_calls || rewritten?.modelCalls) || 1));
  const reviewScoreValue = rewritten?.review_score ?? rewritten?.reviewScore;
  const reviewScore = reviewScoreValue == null
    ? null
    : Math.max(0, Math.min(100, Number(reviewScoreValue) || 0));
  const styleViolationCount = Math.max(0, Number(
    rewritten?.style_violation_count ?? rewritten?.styleViolationCount ?? 0,
  ) || 0);
  const requestedSignatureEvidenceIds = [...new Set((Array.isArray(rewritten?.signature_evidence_ids)
    ? rewritten.signature_evidence_ids
    : Array.isArray(rewritten?.signatureEvidenceIds)
      ? rewritten.signatureEvidenceIds
      : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))].slice(0, 4);
  if (styleViolationCount !== 0) {
    throw applicationDraftError(
      'AI_COVER_LETTER_STYLE_GATE_FAILED',
      `Cover Letter rewrite reported ${styleViolationCount} prohibited defensive or contrast expressions.`,
    );
  }
  const profileSnapshot = mergedCandidateProfile.profile_snapshot
    && typeof mergedCandidateProfile.profile_snapshot === 'object'
    && !Array.isArray(mergedCandidateProfile.profile_snapshot)
    ? mergedCandidateProfile.profile_snapshot
    : {};
  const profileSnapshotId = String(profileSnapshot.profileSnapshotId || '').trim() || createHash('sha256')
    .update(JSON.stringify(['cover-letter-profile:v2', mergedCandidateProfile]), 'utf8')
    .digest('hex');
  const resumeArtifacts = Array.isArray(profileSnapshot.resumeArtifacts)
    ? profileSnapshot.resumeArtifacts
    : Array.isArray(mergedCandidateProfile.resumeArtifacts)
      ? mergedCandidateProfile.resumeArtifacts
      : [];
  const resumeArtifactIds = [...new Set(resumeArtifacts
    .map((item) => String(item?.id || '').trim())
    .filter(Boolean))].slice(0, 6);
  const evidenceIds = [...new Set((Array.isArray(mergedCandidateProfile.evidence_items)
    ? mergedCandidateProfile.evidence_items
    : Array.isArray(mergedCandidateProfile.evidence)
      ? mergedCandidateProfile.evidence
      : [])
    .map((item) => String(item?.id || '').trim())
    .filter(Boolean))];
  const normalizedUsedEvidenceIds = [...new Set(usedEvidenceIds
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
  const signatureEvidenceIds = requestedSignatureEvidenceIds
    .filter((evidenceId) => normalizedUsedEvidenceIds.includes(evidenceId));
  const capabilityMatches = responsibilityCoverage
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const responsibility = String(item.responsibility || '').trim();
      const evidenceIdList = Array.isArray(item.evidence_ids)
        ? item.evidence_ids.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      const responseSentence = String(item.response_sentence || '').trim();
      return [
        responsibility ? `岗位职责：${responsibility}` : '',
        evidenceIdList.length ? `证据 ${evidenceIdList.join('、')}` : '',
        responseSentence ? `可迁移价值：${responseSentence}` : '',
      ].filter(Boolean).join('；');
    })
    .filter(Boolean);
  const roleResponsibilities = Array.isArray(record.application_info?.responsibilities)
    && record.application_info.responsibilities.length > 0
    ? record.application_info.responsibilities
    : Array.isArray(record.responsibilities) ? record.responsibilities : [];
  const roleRequirements = Array.isArray(record.application_info?.requirements)
    && record.application_info.requirements.length > 0
    ? record.application_info.requirements
    : Array.isArray(record.requirements) ? record.requirements : [];
  const inputHashPayload = [
      'cover-letter-rewrite-input:v3-signature-evidence',
      noteId,
      hashDraftContent(currentDraft),
      instructions,
      applicationContext,
      record.job_card?.role_name || record.application_info?.role_name || record.title || '',
      roleResponsibilities,
      roleRequirements,
      profileSnapshotId,
      evidenceIds,
      resumeArtifactIds,
    ];
  const inputHash = createHash('sha256')
    .update(JSON.stringify(inputHashPayload), 'utf8')
    .digest('hex');
  const saved = await updateApplicationDraft(outputDir, {
    noteId,
    draftId: requestedDraftId,
    baseVersion: expectedVersion,
    outreach: {
      ...currentDraft,
      email_subject: emailSubject,
      cover_letter: coverLetter,
    },
    applicationContext,
    generation: {
      runId: requestId,
      promptVersion,
      model,
      provider,
      strategy,
      modelCalls,
      reviewScore,
      styleViolationCount,
      signatureEvidenceIds,
      profileSnapshotId,
      inputHash,
      usedEvidenceIds,
      capabilityMatches,
      resumeArtifactIds,
      status: 'saved',
      generatedAt,
    },
  }, writeState);
  return {
    ...saved,
    generation: {
      provider,
      model,
      wireApi,
      requestId,
      generatedAt,
      promptVersion,
      strategy,
      modelCalls,
      reviewScore,
      styleViolationCount,
      signatureEvidenceIds,
      usedEvidenceIds: normalizedUsedEvidenceIds,
      evidenceCoverage,
      resumeArtifactIds,
      responsibilityCoverage,
      charCount,
      attempts: Math.max(1, Number(rewritten?.attempts) || 1),
    },
  };
}

function unicodeNonWhitespaceCount(value) {
  return Array.from(String(value || '').replace(/\s+/gu, '')).length;
}

function normalizeCoverLetterRewriteOutput(rewritten, currentDraft, record) {
  let coverLetter = String(rewritten?.cover_letter ?? rewritten?.coverLetter ?? '').trim();
  let emailSubject = String(rewritten?.email_subject ?? rewritten?.emailSubject ?? '').trim();
  const draftSubject = String(currentDraft?.email_subject || '').trim();
  emailSubject = emailSubject.replace(/^(?:\u4e3b\u9898|\u90ae\u4ef6\u4e3b\u9898|Subject)\s*[:：]\s*/iu, '').trim();
  const heading = coverLetter.match(/^\s*(?:\u4e3b\u9898|\u90ae\u4ef6\u4e3b\u9898|Subject)\s*[:：]\s*([^\r\n]+)\s*(?:\r?\n|$)/iu);
  if (heading) {
    emailSubject = emailSubject || draftSubject || String(heading[1] || '').trim();
    coverLetter = coverLetter.slice(heading[0].length).trim();
  } else {
    const firstBreak = coverLetter.indexOf('\n');
    if (firstBreak > 0) {
      const firstLine = coverLetter.slice(0, firstBreak).trim();
      const remainder = coverLetter.slice(firstBreak + 1).trim();
      const looksLikeHeading = firstLine.length <= 120
        && !/^(?:尊敬|Dear|您好|Hi)\b/iu.test(firstLine)
        && (/尊敬|招聘负责人|Dear/iu.test(remainder.slice(0, 160)) || /申请|应聘|求职/u.test(firstLine) || firstLine.includes('｜'));
      if (looksLikeHeading) {
        emailSubject = emailSubject || draftSubject || firstLine;
        coverLetter = remainder;
      }
    }
  }
  if (!emailSubject) emailSubject = draftSubject;
  if (!emailSubject) {
    const roleName = String(record?.application_info?.role_name || record?.job_card?.role_name || record?.title || '').trim();
    emailSubject = roleName ? `${roleName}申请` : '求职申请';
  }
  return { emailSubject, coverLetter };
}

function assertCoverLetterRewriteResult(
  record,
  candidateProfile,
  coverLetter,
  charCount,
  responsibilityCoverage,
  usedEvidenceIds,
  evidenceCoverage,
) {
  if (INTERNAL_COVER_LETTER_TOKEN.test(String(coverLetter || ''))) {
    throw applicationDraftError(
      'AI_COVER_LETTER_REWRITE_FAILED',
      'AI Cover Letter contains an internal evidence identifier and cannot be sent.',
    );
  }
  if (charCount < 800 || charCount > 1_600) {
    throw applicationDraftError(
      'AI_COVER_LETTER_REWRITE_FAILED',
      `AI Cover Letter has ${charCount} non-whitespace characters; required range is 800-1600.`,
    );
  }
  const application = record?.application_info && typeof record.application_info === 'object'
    ? record.application_info
    : {};
  const responsibilities = Array.isArray(application.responsibilities)
    ? application.responsibilities
        .map((item) => String(item?.text ?? item ?? '').trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const expectedIds = new Set(responsibilities.map((_, index) => `responsibility-${index + 1}`));
  const seenIds = new Set();
  for (const item of responsibilityCoverage) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = String(item.responsibility_id || item.responsibilityId || '').trim();
    const responseSentence = String(item.response_sentence || item.responseSentence || '').trim();
    if (id) seenIds.add(id);
    if (!responseSentence || !coverLetter.replace(/\s+/gu, '').includes(responseSentence.replace(/\s+/gu, ''))) {
      throw applicationDraftError(
        'AI_COVER_LETTER_REWRITE_FAILED',
        `AI Cover Letter did not include the declared response for ${id || 'a responsibility'}.`,
      );
    }
  }
  if ([...expectedIds].some((id) => !seenIds.has(id))) {
    throw applicationDraftError(
      'AI_COVER_LETTER_REWRITE_FAILED',
      'AI Cover Letter did not cover every extracted job responsibility.',
    );
  }

  const candidateEvidence = Array.isArray(candidateProfile?.evidence_items)
    ? candidateProfile.evidence_items
    : Array.isArray(candidateProfile?.evidence)
      ? candidateProfile.evidence
      : [];
  const evidenceById = new Map(candidateEvidence
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => [String(item.id || '').trim(), item])
    .filter(([id]) => id));
  const normalizedUsedEvidenceIds = new Set((Array.isArray(usedEvidenceIds) ? usedEvidenceIds : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean));
  if ([...normalizedUsedEvidenceIds].some((id) => !evidenceById.has(id))) {
    throw applicationDraftError(
      'AI_COVER_LETTER_REWRITE_FAILED',
      'AI Cover Letter referenced evidence outside the candidate profile snapshot.',
    );
  }
  const seenEvidenceIds = new Set();
  for (const item of Array.isArray(evidenceCoverage) ? evidenceCoverage : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = String(item.evidence_id || item.evidenceId || '').trim();
    const sentence = String(item.evidence_sentence || item.evidenceSentence || '').trim();
    if (id) seenEvidenceIds.add(id);
    if (!normalizedUsedEvidenceIds.has(id) || !sentence || !coverLetter.replace(/\s+/gu, '').includes(sentence.replace(/\s+/gu, ''))) {
      throw applicationDraftError(
        'AI_COVER_LETTER_REWRITE_FAILED',
        `AI Cover Letter did not include the declared personal-experience sentence for ${id || 'an evidence item'}.`,
      );
    }
    const anchor = candidateEvidenceAnchor(evidenceById.get(id));
    if (anchor && !sentence.replace(/\s+/gu, '').includes(anchor.replace(/\s+/gu, ''))) {
      throw applicationDraftError(
        'AI_COVER_LETTER_REWRITE_FAILED',
        `AI Cover Letter did not name the candidate experience ${anchor}.`,
      );
    }
  }
  if ([...normalizedUsedEvidenceIds].some((id) => !seenEvidenceIds.has(id))) {
    throw applicationDraftError(
      'AI_COVER_LETTER_REWRITE_FAILED',
      'AI Cover Letter did not ground every used candidate experience in the body.',
    );
  }
}

function candidateEvidenceAnchor(item) {
  const organization = String(item?.organization || '').trim();
  if (organization) return organization;
  const label = String(item?.label || item?.title || '').trim();
  const latin = label.match(/^([A-Za-z][A-Za-z0-9.+#-]{1,30})/u);
  if (latin) return latin[1];
  const entity = label.match(/^(.{2,10}?)(?:海外|用户研究|达人|舆情|直播|社区|需求|市场|数据|内容运营|AI产品)/u);
  return String(entity?.[1] || label).replace(/^[ 、，/|]+|[ 、，/|]+$/gu, '');
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
    const subjectResolution = resolveApplicationEmailSubject(record, draft.email_subject, value?.outreach || {});
    if (subjectResolution.rule.detected && (
      !subjectResolution.subject
      || subjectResolution.missingFields.length > 0
    )) {
      draft.email_subject = '';
    } else if (
      value?.preserveEmailSubject !== true
      && subjectResolution.subject
      && subjectResolution.missingFields.length === 0
      && (
        subjectResolution.rule.detected
        || subjectResolution.subjectGuard.rejectedSubject
      )
    ) {
      draft.email_subject = subjectResolution.subject;
    }
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
    const savedAt = new Date().toISOString();
    const savedStore = saveDraftVersion(store, {
      draftId: value?.draftId || store.draftId,
      expectedVersion,
      content: draft,
      now: savedAt,
    });
    const hasApplicationContext = Object.hasOwn(value || {}, 'applicationContext');
    const applicationContext = hasApplicationContext
      ? normalizeApplicationContext(value.applicationContext)
      : persistedApplicationContext(existing);
    const applicationContextHash = applicationContext
      ? hashApplicationContext(applicationContext)
      : null;
    const contextChanged = hasApplicationContext
      && applicationContextHash !== persistedApplicationContextHash(existing);
    const updatedStore = contextChanged
      ? staleCurrentDraftQuality(savedStore, new Date().toISOString())
      : savedStore;
    const updated = currentDraftVersion(updatedStore);
    const generation = normalizeGenerationMetadata(value?.generation);
    const boundGeneration = generation ? {
      ...generation,
      draftId: updatedStore.draftId,
      draftVersion: updated.version,
      contentHash: updated.contentHash,
    } : null;
    state[noteId] = {
      ...existing,
      action: 'draft_saved',
      updatedAt: contextChanged ? savedAt : updated.updatedAt,
      draft: { ...updated.content },
      draftStore: updatedStore,
      draftWriteProtocol: isVersionedWrite ? 'versioned' : (writeProtocol || 'legacy'),
      ...(hasApplicationContext ? { applicationContext, applicationContextHash } : {}),
      ...(boundGeneration ? { generation: boundGeneration } : {}),
    };
    await writeState(outputDir, state);
    return {
      noteId,
      outreach: {
        ...updated.content,
        ...(applicationContext ? { applicationContext } : {}),
      },
      draftVersion: draftVersionMetadata(updatedStore),
      delivery: publicDeliveryState(state[noteId]),
    };
  });
}

function normalizeGenerationMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const bounded = (input, limit) => String(input || '').trim().slice(0, limit);
  const usedEvidenceIds = Array.isArray(value.usedEvidenceIds)
    ? [...new Set(value.usedEvidenceIds.map((item) => bounded(item, 120)).filter(Boolean))].slice(0, 5)
    : [];
  const resumeArtifactIds = Array.isArray(value.resumeArtifactIds)
    ? [...new Set(value.resumeArtifactIds.map((item) => bounded(item, 100)).filter(Boolean))].slice(0, 6)
    : [];
  const signatureEvidenceIds = Array.isArray(value.signatureEvidenceIds)
    ? [...new Set(value.signatureEvidenceIds.map((item) => bounded(item, 120)).filter(Boolean))].slice(0, 4)
    : [];
  const capabilityMatches = Array.isArray(value.capabilityMatches)
    ? [...new Set(value.capabilityMatches.map((item) => bounded(item, 600)).filter(Boolean))].slice(0, 12)
    : [];
  const sourceHash = bounded(value.sourceHash, 64);
  if (sourceHash && !/^[a-f0-9]{64}$/iu.test(sourceHash)) {
    throw new ValidationError('Generation sourceHash must be a 64-character hexadecimal hash.');
  }
  const metadata = {
    runId: bounded(value.runId, 160),
    promptVersion: bounded(value.promptVersion, 120),
    model: bounded(value.model, 160),
    provider: bounded(value.provider, 120),
    strategy: bounded(value.strategy, 120),
    modelCalls: Math.max(0, Math.min(10, Number(value.modelCalls) || 0)),
    reviewScore: value.reviewScore == null
      ? null
      : Math.max(0, Math.min(100, Number(value.reviewScore) || 0)),
    styleViolationCount: Math.max(0, Number(value.styleViolationCount) || 0),
    signatureEvidenceIds,
    profileSnapshotId: bounded(value.profileSnapshotId, 128),
    targetRole: bounded(value.targetRole, 160),
    inputHash: bounded(value.inputHash, 128),
    usedEvidenceIds,
    capabilityMatches,
    sourceHash,
    resumeArtifactIds,
    recommendedResumeId: bounded(value.recommendedResumeId, 120),
    resumeReason: bounded(value.resumeReason, 600),
    status: bounded(value.status, 40) || 'validated',
    generatedAt: bounded(value.generatedAt, 40) || new Date().toISOString(),
    draftId: bounded(value.draftId, 96),
    draftVersion: Math.max(0, Number(value.draftVersion) || 0),
    contentHash: bounded(value.contentHash, 64),
  };
  if (!metadata.runId || !metadata.profileSnapshotId) {
    throw new ValidationError('Generation metadata requires runId and profileSnapshotId.');
  }
  if (metadata.recommendedResumeId && !metadata.resumeArtifactIds.includes(metadata.recommendedResumeId)) {
    throw new ValidationError('Recommended resume must reference a resumeArtifactIds entry.');
  }
  if (!['validated', 'saved'].includes(metadata.status)) {
    throw new ValidationError('Generation metadata status is invalid.');
  }
  return metadata;
}

async function writeApplicationGeneration(outputDir, value, writeState = writeDeliveryState) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Generation writeback body must be an object.');
  }
  const runId = String(value.runId || '').trim();
  const items = Array.isArray(value.items) ? value.items : [];
  if (!runId || runId.length > 160) throw new ValidationError('A valid generation runId is required.');
  if (!items.length || items.length > 100) throw new ValidationError('Generation writeback requires 1-100 items.');
  const results = [];
  for (const item of items) {
    const noteId = String(item?.noteId || '').trim();
    try {
      if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
      const generation = {
        ...(item.generation || {}),
        runId,
        promptVersion: item.generation?.promptVersion || value.promptVersion,
        model: item.generation?.model || value.model,
        provider: item.generation?.provider || value.provider,
        profileSnapshotId: item.generation?.profileSnapshotId || value.profileSnapshotId,
        status: 'validated',
      };
      const saved = await updateApplicationDraft(outputDir, {
        noteId,
        draftId: item.draftId,
        baseVersion: item.baseVersion,
        outreach: item.outreach,
        generation,
      }, writeState);
      results.push({
        noteId,
        status: 'saved',
        draftVersion: saved.draftVersion,
        generation: saved.delivery?.generation || null,
      });
    } catch (error) {
      if (error?.code === 'DRAFT_VERSION_CONFLICT') {
        results.push({
          noteId,
          status: 'writeback_conflict',
          error: {
            code: error.code,
            message: error.message,
            expectedVersion: error.expectedVersion ?? null,
            currentVersion: error.currentVersion ?? null,
          },
        });
      } else {
        results.push({
          noteId,
          status: 'writeback_failed',
          error: { code: error?.code || 'WRITEBACK_FAILED', message: String(error?.message || error) },
        });
      }
    }
  }
  const saved = results.filter((item) => item.status === 'saved').length;
  const conflicts = results.filter((item) => item.status === 'writeback_conflict').length;
  const failed = results.length - saved - conflicts;
  return {
    runId,
    status: saved === results.length ? 'completed' : saved ? 'partial' : 'failed',
    requested: results.length,
    saved,
    conflicts,
    failed,
    items: results,
  };
}

async function recheckApplicationDraft(
  outputDir,
  value,
  checker,
  ai,
  candidateProfile,
  writeState = writeDeliveryState,
  limits = attachmentLimits(),
) {
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
    const attachmentBundle = await resolveSelectedApplicationAttachments(
      outputDir,
      noteId,
      Object.hasOwn(value || {}, 'attachmentIds') ? value.attachmentIds : undefined,
      limits,
    );
    const blockingWarning = attachmentConsistencyWarnings(current.content.email_body, attachmentBundle.snapshots)
      .find((item) => item.blocking);
    if (blockingWarning) throw new AttachmentError(blockingWarning.code, blockingWarning.message);
    const peerDrafts = savedPeerDrafts(state, noteId);
    const applicationContext = resolveApplicationContext(record, existing, value);
    const generation = existing.generation && typeof existing.generation === 'object'
      ? existing.generation
      : {};
    const generationMatches = !generation.contentHash || generation.contentHash === current.contentHash;
    const usedEvidenceIds = generationMatches && Array.isArray(generation.usedEvidenceIds)
      ? generation.usedEvidenceIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const capabilityMatches = generationMatches && Array.isArray(generation.capabilityMatches)
      ? generation.capabilityMatches.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const sourceHash = generationMatches && /^[a-f0-9]{64}$/iu.test(String(generation.sourceHash || ''))
      ? String(generation.sourceHash)
      : '';
    const targetRole = generationMatches
      ? String(generation.targetRole || '').trim()
      : '';
    return {
      draftId: store.draftId,
      version: current.version,
      contentHash: current.contentHash,
      content: {
        ...current.content,
        ...(usedEvidenceIds.length ? { used_evidence_ids: usedEvidenceIds } : {}),
        ...(capabilityMatches.length ? { capability_matches: capabilityMatches } : {}),
      },
      sourceHash,
      targetRole,
      attachmentBundleHash: attachmentBundle.attachmentBundleHash,
      peerCorpusHash: applicationPeerCorpusHash(peerDrafts),
      attachmentContext: normalizedAttachmentContext(
        attachmentBundle,
        peerDrafts,
      ),
      applicationContext,
      applicationContextHash: hashApplicationContext(applicationContext),
      persistedApplicationContextHash: persistedApplicationContextHash(existing),
    };
  });

  const threshold = Math.max(90, Number(record?.cover_letter_evaluation?.threshold || 90));
  let report;
  try {
    const qualityRecord = snapshot.targetRole
      ? {
          ...record,
          job_card: {
            ...(record?.job_card && typeof record.job_card === 'object' ? record.job_card : {}),
            role_name: snapshot.targetRole,
          },
        }
      : record;
    const qualitySubjectResolution = resolveApplicationEmailSubject(
      qualityRecord,
      snapshot.content.email_subject,
      candidateProfile,
    );
    const qualityRecordWithSubjectRule = {
      ...qualityRecord,
      qualitySubjectRule: {
        detected: Boolean(qualitySubjectResolution.rule?.detected),
        fields: Array.isArray(qualitySubjectResolution.rule?.fields)
          ? qualitySubjectResolution.rule.fields
          : [],
      },
      qualitySourceDisposition: (() => {
        const disposition = classifyApplicationSource(record);
        return {
          status: disposition.status,
          roleName: disposition.roleName,
        };
      })(),
    };
    report = await checker({
      record: { ...qualityRecordWithSubjectRule, applicationContext: snapshot.applicationContext },
      draft: snapshot.content,
      candidateProfile: candidateProfile && Object.keys(candidateProfile).length
        ? candidateProfile
        : record?.candidate_profile || {},
      attachmentContext: snapshot.attachmentContext,
      applicationContext: snapshot.applicationContext,
      ...(snapshot.sourceHash ? { sourceHash: snapshot.sourceHash } : {}),
      ...(value?.evaluationMode === 'deterministic_strict'
        ? { evaluationMode: 'deterministic_strict' }
        : {}),
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
    const currentAttachments = await resolveSelectedApplicationAttachments(
      outputDir,
      noteId,
      Object.hasOwn(value || {}, 'attachmentIds') ? value.attachmentIds : undefined,
      limits,
    );
    if (currentAttachments.attachmentBundleHash !== snapshot.attachmentBundleHash) {
      throw new AttachmentError(
        'ATTACHMENT_BUNDLE_CHANGED',
        'The selected attachment bundle changed while quality checking was in progress.',
        409,
      );
    }
    if (applicationPeerCorpusHash(savedPeerDrafts(state, noteId)) !== snapshot.peerCorpusHash) {
      throw applicationDraftError(
        'DRAFT_PEER_CORPUS_CHANGED',
        'Another saved application email changed while quality checking was in progress.',
      );
    }
    if (persistedApplicationContextHash(existing) !== snapshot.persistedApplicationContextHash) {
      throw applicationDraftError(
        'DRAFT_APPLICATION_CONTEXT_CHANGED',
        'The application context changed while quality checking was in progress.',
      );
    }
    const checkedAt = new Date().toISOString();
    const evaluation = normalizeDraftQualityReport(report, record?.cover_letter_evaluation);
    const qualityChecks = Array.isArray(existing.qualityChecks) ? existing.qualityChecks : [];
    const qualityCheckId = `quality_${randomUUID()}`;
    const qualityReportRef = `delivery-state.json#/${jsonPointerToken(noteId)}/qualityChecks/${qualityChecks.length}`;
    const qualityCheck = {
      evidenceSchemaVersion: 2,
      id: qualityCheckId,
      draftId: snapshot.draftId,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
      checkedAt,
      attachmentBundleHash: snapshot.attachmentBundleHash,
      peerCorpusHash: snapshot.peerCorpusHash,
      attachmentContext: snapshot.attachmentContext,
      applicationContext: snapshot.applicationContext,
      applicationContextHash: snapshot.applicationContextHash,
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
      applicationContext: snapshot.applicationContext,
      applicationContextHash: snapshot.applicationContextHash,
    };
    await writeState(outputDir, state);
    return {
      noteId,
      outreach: { ...current.content, applicationContext: snapshot.applicationContext },
      draftVersion: draftVersionMetadata(updatedStore),
      cover_letter_evaluation: evaluation,
      delivery: publicDeliveryState(state[noteId]),
    };
  });
}

export async function previewApplicationEmail(
  outputDir,
  value,
  replyTo,
  mailer,
  smtpConfig,
  limits,
  writeState = writeDeliveryState,
  options = {},
) {
  const noteId = String(value?.noteId || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  const record = await readApplicationRecord(outputDir, noteId);
  const extracted = extractedEmails(record, options.allowedRecipients);
  const requested = String(value?.to || '').trim().toLowerCase();
  if (!requested) throw new ValidationError('Recipient is required.');
  const recipient = extracted.find((item) => item.toLowerCase() === requested) || '';
  if (!recipient) throw new ValidationError('Recipient must be an email extracted from this application record.');
  return withDeliveryStateLock(outputDir, async () => {
    const state = await readDeliveryState(outputDir);
    const existing = state[noteId] || {};
    const qualityBundle = await resolveApplicationAttachments(outputDir, noteId, value?.attachmentIds, limits);
    const bundle = value?.attachmentFilenameOverrides
      ? await resolveApplicationAttachments(
          outputDir,
          noteId,
          value?.attachmentIds,
          limits,
          value.attachmentFilenameOverrides,
        )
      : qualityBundle;
    const resolved = resolveStoredDraftForAction(record, existing, value);
    const draft = { ...resolved.content };
    const subjectResolution = assertApplicationSubjectRule(record, draft.email_subject);
    assertRequestedApplicationSubject(value, subjectResolution.subject);
    draft.email_subject = subjectResolution.subject;
    if (!draft.email_subject || !draft.email_body) throw new ValidationError('Email subject and body are required.');
    validateDeliveryDraft(draft, record);
    const peerCorpusHash = applicationPeerCorpusHash(savedPeerDrafts(state, noteId));
    const applicationContextHash = persistedApplicationContextHash(existing);
    await assertQualityReportReference(
      outputDir,
      record,
      resolved,
      qualityBundle.attachmentBundleHash,
      peerCorpusHash,
      applicationContextHash,
    );
    const quality = previewQualityResult(
      existing,
      resolved,
      record,
      qualityBundle.attachmentBundleHash,
      peerCorpusHash,
      applicationContextHash,
    );
    const smtp = smtpConfigurationContext(mailer, smtpConfig);
    const warnings = [
      ...attachmentConsistencyWarnings(draft.email_body, bundle.snapshots),
      ...smtpPreviewWarnings(smtp),
    ];
    const preview = buildEmailPreview({
      noteId,
      recipient,
      from: smtp.from,
      replyTo: EMAIL.test(replyTo) ? replyTo : '',
      subject: draft.email_subject,
      text: draft.email_body,
      draftId: resolved.draftId,
      draftVersion: resolved.version,
      contentHash: resolved.contentHash,
      quality,
      attachmentSummary: bundle.summary,
      attachmentBundleHash: bundle.attachmentBundleHash,
      smtpConfigurationRevision: smtp.revision,
      smtpConfigurationFingerprint: smtp.fingerprint,
      smtp: {
        configured: smtp.configured,
        verificationStatus: smtp.verificationStatus,
        verificationFailureCode: smtp.verificationFailureCode,
      },
      warnings,
    });
    if (options.persist !== false) {
      const previewedAt = new Date().toISOString();
      state[noteId] = {
        ...existing,
        ...deliveryStatusPatch(existing, preview.readiness === 'ready' ? 'preview_ready' : 'blocked', previewedAt),
        action: 'email_previewed',
        updatedAt: previewedAt,
        preview: {
          previewRevision: preview.previewRevision,
          attachmentBundleHash: preview.attachmentBundleHash,
          draftId: preview.draftId,
          draftVersion: preview.draftVersion,
          readiness: preview.readiness,
          preparedAt: previewedAt,
        },
      };
      await writeState(outputDir, state);
    }
    return preview;
  });
}

function previewQualityResult(
  existing,
  resolved,
  record,
  attachmentBundleHash = null,
  peerCorpusHash = null,
  applicationContextHash = null,
) {
  const exact = [...(Array.isArray(existing?.qualityChecks) ? existing.qualityChecks : [])]
    .reverse()
    .find((item) => (
      item?.draftId === resolved.draftId
      && Number(item?.version) === Number(resolved.version)
      && item?.contentHash === resolved.contentHash
      && qualityAttachmentBundleMatches(item, attachmentBundleHash)
      && qualityPeerCorpusMatches(item, peerCorpusHash)
      && qualityApplicationContextMatches(item, applicationContextHash)
    ));
  const legacy = applicationContextHash === null
    && Number(resolved.version) === 1
    && attachmentBundleHash === emptyAttachmentBundleHash()
    ? record?.cover_letter_evaluation
    : null;
  return {
    ...draftVersionMetadata(resolved.store),
    checkedAt: exact?.checkedAt || null,
    evaluation: exact?.evaluation || legacy || null,
  };
}

function qualityAttachmentBundleMatches(check, attachmentBundleHash) {
  if (attachmentBundleHash === null) return true;
  if (check?.attachmentBundleHash) return check.attachmentBundleHash === attachmentBundleHash;
  return attachmentBundleHash === emptyAttachmentBundleHash();
}

function qualityPeerCorpusMatches(check, peerCorpusHash) {
  if (peerCorpusHash === null) return true;
  if (!check?.peerCorpusHash) return Number(check?.evidenceSchemaVersion || 0) < 2;
  return check.peerCorpusHash === peerCorpusHash;
}

function qualityApplicationContextMatches(check, applicationContextHash) {
  if (applicationContextHash === null) return !check?.applicationContextHash;
  return check?.applicationContextHash === applicationContextHash;
}

function emptyAttachmentBundleHash() {
  return createHash('sha256').update('application-attachments:v1\n[]', 'utf8').digest('hex');
}

function smtpConfigurationContext(mailer, smtpConfig) {
  const publicConfig = smtpConfig?.getPublic?.() || {};
  const verification = smtpConfig?.getVerificationState?.() || {};
  const snapshot = smtpConfig?.getVerificationSnapshot?.() || {};
  const mailerStatus = mailer?.status?.() || {};
  const verifiedAt = String(verification.verifiedAt || publicConfig.lastVerifiedAt || publicConfig.verifiedAt || '');
  const verificationStatus = String(
    verification.verificationStatus
      || publicConfig.verificationStatus
      || (publicConfig.verified === true || (verifiedAt && Number.isFinite(Date.parse(verifiedAt))) ? 'verified' : 'unverified'),
  );
  const revision = Number(publicConfig.revision ?? snapshot.revision ?? 0);
  const configHash = String(verification.configHash || publicConfig.configHash || snapshot.configHash || snapshot.fingerprint || '');
  const credentialRevision = Number(verification.credentialRevision ?? publicConfig.credentialRevision ?? snapshot.credentialRevision ?? 0);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    'smtp-configuration:v1',
    revision,
    configHash,
    credentialRevision,
  ])).digest('hex');
  return {
    configured: Boolean(verification.configured ?? mailerStatus.configured),
    from: String(publicConfig.from || mailerStatus.from || ''),
    revision,
    configHash,
    credentialRevision,
    fingerprint,
    verificationStatus,
    verificationFailureCode: String(verification.verificationFailureCode || publicConfig.verificationFailureCode || ''),
  };
}

function smtpPreviewWarnings(smtp) {
  if (!smtp.configured) {
    return [{ code: 'SMTP_NOT_CONFIGURED', message: 'SMTP is not configured.', blocking: true }];
  }
  if (smtp.verificationStatus !== 'verified') {
    const code = smtp.verificationStatus === 'expired' ? 'SMTP_VERIFICATION_EXPIRED' : 'SMTP_NOT_VERIFIED';
    return [{ code, message: 'SMTP configuration must be verified before sending.', blocking: true }];
  }
  return [];
}

function attachmentConsistencyWarnings(text, attachments) {
  const body = String(text || '');
  const claimsAttachment = /(?:附件|随信|附上|简历见附|resume\s+attached|attached\s+(?:my\s+)?resume)/iu.test(body);
  const hasResume = attachments.some((item) => /(?:简历|resume|cv)/iu.test(item.filename));
  const claimsResume = /(?:附件.{0,8}简历|附上.{0,8}简历|简历.{0,8}附件|resume\s+attached|attached\s+(?:my\s+)?resume)/iu.test(body);
  const warnings = [];
  if (claimsAttachment && attachments.length === 0) {
    warnings.push({ code: 'ATTACHMENT_CLAIM_WITHOUT_FILE', message: '正文提到附件，但本次发送没有选择任何附件。', blocking: true });
  }
  if (claimsResume && !hasResume) {
    warnings.push({ code: 'RESUME_CLAIM_WITHOUT_RESUME', message: '正文声称附有简历，但所选附件中没有简历。', blocking: true });
  }
  if (attachments.length > 0 && !claimsAttachment) {
    warnings.push({ code: 'ATTACHMENTS_NOT_MENTIONED', message: '本次将发送附件，但正文没有说明附件内容。', blocking: false });
  }
  return warnings;
}

function normalizedAttachmentContext(bundle, peerDrafts = []) {
  return {
    schemaVersion: 1,
    attachmentBundleHash: bundle.attachmentBundleHash,
    count: Number(bundle.summary?.count || 0),
    totalBytes: Number(bundle.summary?.totalBytes || 0),
    attachments: (Array.isArray(bundle.snapshots) ? bundle.snapshots : []).map((item) => ({
      attachmentId: String(item.attachmentId || ''),
      filename: String(item.filename || ''),
      mediaType: String(item.mediaType || ''),
      size: Number(item.size || 0),
      sha256: String(item.sha256 || ''),
    })),
    peerDrafts: peerDrafts.map((item) => ({ ...item })),
  };
}

function savedPeerDrafts(state, currentNoteId) {
  return Object.entries(state || {})
    .flatMap(([noteId, entry]) => {
      if (noteId === currentNoteId || !NOTE_ID.test(noteId) || !entry || typeof entry !== 'object') return [];
      const directBody = String(entry.draft?.email_body || '').trim();
      const currentVersion = Number(entry.draftStore?.currentVersion);
      const version = Array.isArray(entry.draftStore?.versions)
        ? entry.draftStore.versions.find((item) => Number(item?.version) === currentVersion)
        : null;
      const emailBody = directBody || String(version?.content?.email_body || '').trim();
      return emailBody ? [{ noteId, emailBody }] : [];
    })
    .sort((left, right) => left.noteId.localeCompare(right.noteId));
}

function applicationPeerCorpusHash(peerDrafts) {
  const normalized = (Array.isArray(peerDrafts) ? peerDrafts : []).map((item) => [
    String(item?.noteId || ''),
    createHash('sha256').update(String(item?.emailBody || ''), 'utf8').digest('hex'),
  ]);
  return createHash('sha256').update(JSON.stringify(['application-peer-corpus:v1', normalized]), 'utf8').digest('hex');
}

export async function sendApplicationEmail(outputDir, value, mailer, replyTo, smtpConfig, options = {}) {
  const writeState = options.writeState || writeDeliveryState;
  const appendAudit = options.appendAudit || appendSendAuditJournal;
  const readAudit = options.readAudit || readSendAuditJournal;
  const limits = options.attachmentLimits || attachmentLimits();
  const noteId = String(value?.noteId || '').trim();
  if (!NOTE_ID.test(noteId)) throw new ValidationError('Invalid noteId.');
  const modernRequest = Object.hasOwn(value || {}, 'attachmentIds');
  const requestIdempotencyKey = normalizeSendRequestKey(value?.idempotencyKey);
  if (modernRequest && !requestIdempotencyKey) {
    throw applicationDraftError('EMAIL_IDEMPOTENCY_REQUIRED', 'A modern send request requires an idempotencyKey.');
  }
  if (modernRequest && (!value?.attachmentBundleHash || !value?.previewRevision)) {
    throw applicationDraftError(
      'EMAIL_PREVIEW_REQUIRED',
      'A modern send request requires the attachment bundle hash and preview revision returned by the preview endpoint.',
    );
  }
  const record = await readApplicationRecord(outputDir, noteId);
  const extracted = extractedEmails(record, options.allowedRecipients);
  const requested = String(value?.to || '').trim().toLowerCase();
  if (!requested) throw new ValidationError('Recipient is required.');
  const to = extracted.find((item) => item.toLowerCase() === requested) || '';
  if (!to) throw new ValidationError('Recipient must be an email extracted from this application record.');

  return withDeliveryStateLock(outputDir, async () => {
    const state = await readDeliveryState(outputDir);
    let existing = state[noteId] || {};
    const journalAudits = await readAudit(outputDir);
    const recovered = await recoverDurableEmailDelivery({
      outputDir,
      noteId,
      requestIdempotencyKey,
      requestPreviewRevision: String(value?.previewRevision || ''),
      state,
      existing,
      record,
      recipient: to,
      appendAudit,
      writeState,
      journalAudits,
    });
    if (recovered) return recovered;
    existing = state[noteId] || {};
    const resolved = resolveStoredDraftForAction(record, existing, value);
    const draft = { ...resolved.content };
    const subjectResolution = assertApplicationSubjectRule(record, draft.email_subject);
    assertRequestedApplicationSubject(value, subjectResolution.subject);
    draft.email_subject = subjectResolution.subject;
    if (!draft.email_subject || !draft.email_body) throw new ValidationError('Email subject and body are required.');
    validateDeliveryDraft(draft, record);
    const qualityAttachmentBundle = await resolveApplicationAttachments(outputDir, noteId, value?.attachmentIds, limits);
    const attachmentBundle = value?.attachmentFilenameOverrides
      ? await resolveApplicationAttachments(
          outputDir,
          noteId,
          value?.attachmentIds,
          limits,
          value.attachmentFilenameOverrides,
        )
      : qualityAttachmentBundle;
    const peerCorpusHash = applicationPeerCorpusHash(savedPeerDrafts(state, noteId));
    await assertQualityReportReference(
      outputDir,
      record,
      resolved,
      qualityAttachmentBundle.attachmentBundleHash,
      peerCorpusHash,
      persistedApplicationContextHash(existing),
    );
    const warnings = attachmentConsistencyWarnings(draft.email_body, attachmentBundle.snapshots);
    const blockingWarning = warnings.find((item) => item.blocking);
    if (blockingWarning) throw new AttachmentError(blockingWarning.code, blockingWarning.message);
    const smtpPreview = smtpConfigurationContext(mailer, smtpConfig);
    const preview = buildEmailPreview({
      noteId,
      recipient: to,
      from: smtpPreview.from,
      replyTo: EMAIL.test(replyTo) ? replyTo : '',
      subject: draft.email_subject,
      text: draft.email_body,
      draftId: resolved.draftId,
      draftVersion: resolved.version,
      contentHash: resolved.contentHash,
      quality: previewQualityResult(
        existing,
        resolved,
        record,
        qualityAttachmentBundle.attachmentBundleHash,
        peerCorpusHash,
        persistedApplicationContextHash(existing),
      ),
      attachmentSummary: attachmentBundle.summary,
      attachmentBundleHash: attachmentBundle.attachmentBundleHash,
      smtpConfigurationRevision: smtpPreview.revision,
      smtpConfigurationFingerprint: smtpPreview.fingerprint,
      warnings,
    });
    if (value?.attachmentBundleHash && value.attachmentBundleHash !== attachmentBundle.attachmentBundleHash) {
      throw new AttachmentError('ATTACHMENT_BUNDLE_CHANGED', 'The selected attachment bundle changed after preview.', 409);
    }
    if (value?.previewRevision && value.previewRevision !== preview.previewRevision) {
      throw applicationDraftError('EMAIL_PREVIEW_STALE', 'The email preview is stale; review the current message before sending.');
    }
    const idempotencyKey = sendIdempotencyKey({
      draftId: resolved.draftId,
      version: resolved.version,
      contentHash: resolved.contentHash,
      recipient: to,
      attachmentBundleHash: attachmentBundle.attachmentBundleHash,
    });
    const sendIdentity = {
      draftId: resolved.draftId,
      version: resolved.version,
      contentHash: resolved.contentHash,
      recipient: to,
      recipientHash: recipientAuditHash(to),
      attachmentBundleHash: attachmentBundle.attachmentBundleHash,
      attachmentCount: attachmentBundle.summary.count,
      idempotencyKey,
    };
    const auditAttachmentDetails = {
      attachmentBundleHash: attachmentBundle.attachmentBundleHash,
      attachmentCount: attachmentBundle.summary.count,
      attachmentBytes: attachmentBundle.summary.totalBytes,
      attachments: attachmentBundle.snapshots,
      previewRevision: preview.previewRevision,
    };
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
        ...deliveryStatusPatch(existing, 'sent', reconciledAt),
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
        ...auditAttachmentDetails,
        requestIdempotencyKey,
        smtpState,
        status: 'failed',
        errorCode: String(error?.code || 'SMTP_VERIFICATION_FAILED'),
        timestamp: failedAt,
        qualityReportRef: resolved.qualityReportRef,
      });
      state[noteId] = {
        ...existing,
        ...deliveryStatusPatch(existing, 'failed', failedAt),
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
    const smtpConfiguration = smtpConfigurationContext(mailer, smtpConfig);
    if (modernRequest && (
      smtpConfiguration.revision !== smtpPreview.revision
      || smtpConfiguration.fingerprint !== smtpPreview.fingerprint
    )) {
      throw applicationDraftError(
        'EMAIL_PREVIEW_STALE',
        'The SMTP configuration changed during verification; review the current message before sending.',
      );
    }
    smtpState = {
      ...smtpState,
      smtpConfigurationRevision: smtpConfiguration.revision,
      smtpConfigurationFingerprint: smtpConfiguration.fingerprint,
    };
    const preparedAt = new Date().toISOString();
    const sendBundle = await prepareSendBundle(outputDir, attachmentBundle);
    const pendingSend = {
      ...sendIdentity,
      ...auditAttachmentDetails,
      noteId,
      sendId: sendBundle.sendId,
      requestIdempotencyKey,
      configHash: smtpState?.configHash || '',
      credentialRevision: Number(smtpState?.credentialRevision || 0),
      smtpConfigurationRevision: smtpConfiguration.revision,
      smtpConfigurationFingerprint: smtpConfiguration.fingerprint,
      preparedAt,
      qualityReportRef: resolved.qualityReportRef,
    };
    try {
      await sealPreparedSendBundle(sendBundle, {
        ...pendingSend,
        recipient: to,
        draftVersion: resolved.version,
        attachments: attachmentBundle.attachments,
      });
    } catch (error) {
      await discardSendBundle(sendBundle);
      throw error;
    }
    const preparingState = {
      ...existing,
      ...deliveryStatusPatch(existing, 'preparing', preparedAt),
    };
    state[noteId] = {
      ...preparingState,
      ...deliveryStatusPatch(preparingState, 'sending', preparedAt),
      draft,
      draftStore: resolved.store,
      updatedAt: preparedAt,
      pendingSend,
    };
    try {
      await writeState(outputDir, state);
    } catch (error) {
      await discardSendBundle(sendBundle);
      throw error;
    }
    let sent;
    try {
      const message = {
        to,
        subject: draft.email_subject,
        text: draft.email_body,
        replyTo: EMAIL.test(replyTo) ? replyTo : '',
      };
      if (sendBundle.mailAttachments.length > 0) message.attachments = sendBundle.mailAttachments;
      sent = await mailer.send(message);
    } catch (error) {
      const knownNotSent = error?.safeToRetry === true || error?.deliveryStatus === 'not_sent';
      const failedAt = new Date().toISOString();
      await finalizeSendBundle(sendBundle, {
        status: knownNotSent ? 'failed' : 'unknown',
        failedAt,
        errorCode: String(error?.code || 'SMTP_SEND_FAILED'),
      }).catch(() => {});
      const failureAudit = createSendAuditRecord(sendIdentity, {
        ...auditAttachmentDetails,
        sendId: sendBundle.sendId,
        requestIdempotencyKey,
        smtpState,
        status: knownNotSent ? 'failed' : 'unknown',
        errorCode: String(error?.code || 'SMTP_SEND_FAILED'),
        timestamp: failedAt,
        qualityReportRef: resolved.qualityReportRef,
      });
      const failedState = {
        ...state[noteId],
        ...deliveryStatusPatch(state[noteId], knownNotSent ? 'failed' : 'unknown', failedAt),
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
    try {
      await finalizeSendBundle(sendBundle, {
        status: 'sent',
        sentAt,
        messageId: sent.messageId || '',
      });
    } catch (error) {
      await persistAcceptedDeliveryUnknown(outputDir, state, noteId, {
        to,
        unknownAt: sentAt,
        messageId: sent.messageId || '',
      }, writeState);
      const uncertain = applicationDraftError(
        'EMAIL_DELIVERED_AUDIT_UNCERTAIN',
        'SMTP accepted the email, but its immutable send bundle could not be finalized; retry is blocked to prevent duplicate delivery.',
      );
      uncertain.cause = error;
      throw uncertain;
    }
    const audit = createSendAuditRecord(sendIdentity, {
      ...auditAttachmentDetails,
      sendId: sendBundle.sendId,
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
      await persistAcceptedDeliveryUnknown(outputDir, state, noteId, {
        to,
        unknownAt: sentAt,
        messageId: sent.messageId || '',
      }, writeState);
      const uncertain = applicationDraftError(
        'EMAIL_DELIVERED_AUDIT_UNCERTAIN',
        'SMTP accepted the email, but its durable audit journal could not be written; retry is blocked to prevent duplicate delivery.',
      );
      uncertain.cause = error;
      throw uncertain;
    }
    state[noteId] = stateWithoutPendingSend({
      ...state[noteId],
      ...deliveryStatusPatch(state[noteId], 'sent', sentAt),
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
      sendId: sendBundle.sendId,
      attachmentBundleHash: attachmentBundle.attachmentBundleHash,
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

function normalizeApplicationContext(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const channel = ['email', 'direct_message'].includes(String(source.channel || '').trim())
    ? String(source.channel).trim()
    : 'email';
  const contactStage = ['first_contact', 'follow_up'].includes(String(source.contactStage || '').trim())
    ? String(source.contactStage).trim()
    : 'first_contact';
  const tone = ['formal', 'natural', 'concise'].includes(String(source.tone || '').trim())
    ? String(source.tone).trim()
    : 'natural';
  return {
    channel,
    contactStage,
    tone,
    resumeAttached: source.resumeAttached === true,
    coverLetterAttached: source.coverLetterAttached === true,
    recipientType: String(source.recipientType || '').trim().slice(0, 80) || 'recruiter',
  };
}

function hashApplicationContext(value) {
  const context = normalizeApplicationContext(value);
  const canonical = JSON.stringify([
    ['channel', context.channel],
    ['contactStage', context.contactStage],
    ['tone', context.tone],
    ['resumeAttached', context.resumeAttached],
    ['coverLetterAttached', context.coverLetterAttached],
    ['recipientType', context.recipientType],
  ]);
  return createHash('sha256').update(`application-context:v1\n${canonical}`, 'utf8').digest('hex');
}

function persistedApplicationContext(state) {
  if (!state?.applicationContext || typeof state.applicationContext !== 'object' || Array.isArray(state.applicationContext)) {
    return null;
  }
  return normalizeApplicationContext(state.applicationContext);
}

function persistedApplicationContextHash(state) {
  const context = persistedApplicationContext(state);
  return context ? hashApplicationContext(context) : null;
}

function resolveApplicationContext(record, state, value = {}) {
  if (Object.hasOwn(value || {}, 'applicationContext')) {
    return normalizeApplicationContext(value.applicationContext);
  }
  const persisted = persistedApplicationContext(state);
  if (persisted) return persisted;
  return normalizeApplicationContext(
    record?.applicationContext
      ?? record?.application_context
      ?? record?.outreach?.applicationContext
      ?? record?.outreach?.application_context,
  );
}

function staleCurrentDraftQuality(store, updatedAt) {
  const current = currentDraftVersion(store);
  if (current.qualityStatus === 'stale') return store;
  return {
    ...store,
    versions: store.versions.map((version) => (
      Number(version.version) === Number(store.currentVersion)
        ? {
            ...version,
            qualityStatus: 'stale',
            qualityCheckedVersion: null,
            qualityCheckedHash: null,
            qualityReportRef: null,
            updatedAt,
          }
        : { ...version }
    )),
  };
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

async function assertQualityReportReference(
  outputDir,
  record,
  resolved,
  attachmentBundleHash = null,
  peerCorpusHash = null,
  applicationContextHash = null,
) {
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
    && String(report.contentHash || '') === resolved.contentHash
    && qualityAttachmentBundleMatches(report, attachmentBundleHash)
    && qualityPeerCorpusMatches(report, peerCorpusHash)
    && qualityApplicationContextMatches(report, applicationContextHash);
  const legacyBound = reference === expectedLegacyRef
    && resolved.version === 1
    && applicationContextHash === null
    && (attachmentBundleHash === null || attachmentBundleHash === emptyAttachmentBundleHash())
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

function assertApplicationSubjectRule(record, subject) {
  const resolution = resolveApplicationEmailSubject(record, subject);
  const subjectGuard = resolution.subjectGuard;
  if (!subjectGuard.explicitRule && (
    ['rejected_noisy_title', 'rejected_bare_title', 'rejected_unverified_subject'].includes(subjectGuard.sourceStatus)
    || subjectGuard.requiresReview
  )) {
    const error = applicationDraftError(
      'APPLICATION_SUBJECT_TITLE_REVIEW_REQUIRED',
      '邮件主题需使用准确岗位名；原帖标题中的招聘口号已排除，请补全岗位名后重新生成。',
    );
    error.subjectGuard = subjectGuard;
    throw error;
  }
  const rule = resolution.rule;
  if (!rule.detected) return resolution;
  const validation = resolveApplicationEmailSubject(record, resolution.subject).validation;
  if (validation.status === 'compliant' && resolution.missingFields.length === 0) {
    return { ...resolution, validation };
  }
  const error = applicationDraftError(
    'APPLICATION_SUBJECT_RULE_MISMATCH',
    '正文要求的邮件标题与当前草稿不一致，请重新保存或生成草稿后再发送。',
  );
  error.subjectRule = {
    ...rule,
    status: validation.status,
    missingFields: validation.missingFields,
    missingValues: validation.missingValues,
  };
  throw error;
}

function assertRequestedApplicationSubject(value, resolvedSubject) {
  if (!Object.hasOwn(value || {}, 'subject')) return;
  const requested = String(value?.subject || '').trim();
  if (requested === resolvedSubject) return;
  const error = applicationDraftError(
    'APPLICATION_SUBJECT_RESOLUTION_MISMATCH',
    '请求中的邮件主题与当前草稿及岗位命名要求不一致，请重新执行 Dry Run。',
  );
  error.expectedSubject = resolvedSubject;
  throw error;
}

function resolveDraftAiRuntime(aiSessions, internal, value) {
  const aiSessionId = String(value?.aiSessionId || internal?.params?.aiSessionId || '').trim();
  if (!aiSessionId || !aiSessions?.resolve) {
    throw applicationDraftError(
      'AI_SESSION_UNAVAILABLE',
      'A configured AI session is required to use AI draft features.',
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
    String(value?.attachmentBundleHash || ''),
  ]);
  return createHash('sha256').update(`application-email:v2\n${canonical}`, 'utf8').digest('hex');
}

function sendAuditMatches(audit, identity) {
  const status = String(audit?.status || 'sent').toLowerCase();
  const recipientMatches = audit?.recipientHash
    ? audit.recipientHash === identity.recipientHash
    : String(audit?.recipient || '').toLowerCase() === String(identity.recipient || '').toLowerCase();
  const attachmentIdentityMatches = audit?.attachmentBundleHash
    ? audit.attachmentBundleHash === identity.attachmentBundleHash
      && audit.idempotencyKey === identity.idempotencyKey
    : Number(identity.attachmentCount || 0) === 0;
  return Boolean(audit)
    && status === 'sent'
    && audit.draftId === identity.draftId
    && Number(audit.version ?? audit.draftVersion) === Number(identity.version)
    && audit.contentHash === identity.contentHash
    && recipientMatches
    && attachmentIdentityMatches;
}

function findSendAudit(audits, identity) {
  return Array.isArray(audits) ? audits.find((audit) => sendAuditMatches(audit, identity)) || null : null;
}

async function recoverDurableEmailDelivery({
  outputDir,
  noteId,
  requestIdempotencyKey,
  requestPreviewRevision,
  state,
  existing,
  record,
  recipient,
  appendAudit,
  writeState,
  journalAudits,
}) {
  const stateAudits = Array.isArray(existing?.sendAudit) ? existing.sendAudit : [];
  const requestAudit = [...stateAudits, ...journalAudits].find((audit) => (
    String(audit?.status || 'sent').toLowerCase() === 'sent'
    && requestIdempotencyKey
    && String(audit?.requestIdempotencyKey || '') === requestIdempotencyKey
  ));
  if (requestAudit) {
    assertRecoveredRequestMatches(requestAudit, requestPreviewRevision);
    const journalHasAudit = journalAudits.some((audit) => sameSendEvidence(audit, requestAudit));
    if (!journalHasAudit) {
      await appendRecoveredSendAudit(outputDir, appendAudit, sanitizeSendAudit(requestAudit));
    }
    return reconcileRecoveredDelivery({
      outputDir,
      noteId,
      state,
      existing,
      record,
      recipient,
      audit: sanitizeSendAudit(requestAudit),
      writeState,
      clearPending: true,
    });
  }

  const pending = existing?.pendingSend;
  if (!pending) return null;
  const bundle = await readFinalizedSendBundle(outputDir, pending.sendId);
  if (!durableBundleIdentityMatchesPending(bundle, pending)) {
    throw applicationDraftError(
      'EMAIL_SEND_STATUS_UNKNOWN',
      'A previous email attempt has a persisted send intent without confirmed immutable delivery evidence.',
    );
  }

  const pendingRequestKey = String(pending.requestIdempotencyKey || '');
  const requestMatches = pendingRequestKey === requestIdempotencyKey;
  if (requestMatches) assertRecoveredRequestMatches(pending, requestPreviewRevision);
  const identity = {
    draftId: String(bundle.draftId || pending.draftId || ''),
    version: Number(bundle.draftVersion ?? pending.version ?? 0),
    contentHash: String(bundle.contentHash || pending.contentHash || ''),
    recipient: String(bundle.recipient || recipient || ''),
    recipientHash: String(bundle.recipientHash || pending.recipientHash || recipientAuditHash(bundle.recipient || recipient)),
    attachmentBundleHash: String(bundle.attachmentBundleHash || pending.attachmentBundleHash || ''),
    attachmentCount: Number(bundle.attachmentCount ?? bundle.attachments?.length ?? pending.attachmentCount ?? 0),
    idempotencyKey: String(bundle.idempotencyKey || pending.idempotencyKey || ''),
  };
  if (bundle.status === 'failed') {
    const failedAt = String(bundle.completedAt || pending.preparedAt || new Date().toISOString());
    const failureAudit = createSendAuditRecord(identity, {
      sendId: bundle.sendId,
      requestIdempotencyKey: pendingRequestKey,
      smtpState: {
        configHash: pending.configHash || '',
        credentialRevision: Number(pending.credentialRevision || 0),
        smtpConfigurationRevision: Number(bundle.smtpConfigurationRevision || pending.smtpConfigurationRevision || 0),
        smtpConfigurationFingerprint: String(bundle.smtpConfigurationFingerprint || pending.smtpConfigurationFingerprint || ''),
      },
      status: 'failed',
      errorCode: String(bundle.errorCode || 'SMTP_SEND_FAILED'),
      timestamp: failedAt,
      qualityReportRef: bundle.qualityReportRef || pending.qualityReportRef || null,
      attachmentBundleHash: identity.attachmentBundleHash,
      attachmentCount: identity.attachmentCount,
      attachmentBytes: Number(bundle.attachmentBytes ?? pending.attachmentBytes ?? 0),
      attachments: Array.isArray(bundle.attachments) ? bundle.attachments : pending.attachments,
      previewRevision: String(bundle.previewRevision || pending.previewRevision || ''),
    });
    state[noteId] = stateWithoutPendingSend({
      ...existing,
      ...deliveryStatusPatch(existing, 'failed', failedAt),
      action: 'email_failed',
      updatedAt: failedAt,
      email: { status: 'failed', to: identity.recipient, failedAt },
      sendAudit: appendSendAuditEvent(existing.sendAudit, failureAudit),
    });
    await writeState(outputDir, state);
    return null;
  }
  if (bundle.status !== 'sent') {
    throw applicationDraftError(
      'EMAIL_SEND_STATUS_UNKNOWN',
      'A previous email attempt has no immutable proof that SMTP either accepted or rejected it.',
    );
  }
  const sentAt = String(bundle.sentAt || pending.preparedAt || new Date().toISOString());
  const existingDurableAudit = [...stateAudits, ...journalAudits].find((audit) => (
    String(audit?.status || '').toLowerCase() === 'sent'
    && String(audit?.sendId || '') === String(bundle.sendId || '')
  ));
  const recoveredAudit = existingDurableAudit || createSendAuditRecord(identity, {
    sendId: bundle.sendId,
    requestIdempotencyKey: pendingRequestKey,
    smtpState: {
      configHash: pending.configHash || '',
      credentialRevision: Number(pending.credentialRevision || 0),
      smtpConfigurationRevision: Number(bundle.smtpConfigurationRevision || pending.smtpConfigurationRevision || 0),
      smtpConfigurationFingerprint: String(bundle.smtpConfigurationFingerprint || pending.smtpConfigurationFingerprint || ''),
    },
    status: 'sent',
    errorCode: '',
    timestamp: sentAt,
    sentAt,
    qualityReportRef: bundle.qualityReportRef || pending.qualityReportRef || null,
    messageId: bundle.messageId || '',
    attachmentBundleHash: identity.attachmentBundleHash,
    attachmentCount: identity.attachmentCount,
    attachmentBytes: Number(bundle.attachmentBytes ?? pending.attachmentBytes ?? 0),
    attachments: Array.isArray(bundle.attachments) ? bundle.attachments : pending.attachments,
    previewRevision: String(bundle.previewRevision || pending.previewRevision || ''),
  });
  if (!journalAudits.some((audit) => sameSendEvidence(audit, recoveredAudit))) {
    await appendRecoveredSendAudit(outputDir, appendAudit, recoveredAudit);
  }
  const response = await reconcileRecoveredDelivery({
    outputDir,
    noteId,
    state,
    existing,
    record,
    recipient: identity.recipient,
    audit: recoveredAudit,
    writeState,
    clearPending: true,
    sendId: bundle.sendId,
    attachmentBundleHash: identity.attachmentBundleHash,
  });
  if (!requestMatches) {
    throw applicationDraftError(
      'EMAIL_IDEMPOTENCY_CONFLICT',
      'A different email operation was reconciled from the immutable pending send bundle; retry the new operation.',
    );
  }
  return response;
}

async function reconcileRecoveredDelivery({
  outputDir,
  noteId,
  state,
  existing,
  record,
  recipient,
  audit,
  writeState,
  clearPending,
  sendId = '',
  attachmentBundleHash = '',
}) {
  const store = draftStoreFor(record, existing);
  const current = currentDraftVersion(store);
  const sentAt = String(audit.sentAt || audit.timestamp || new Date().toISOString());
  let reconciled = {
    ...existing,
    ...deliveryStatusPatch(existing, 'sent', sentAt),
    action: 'email_sent',
    updatedAt: sentAt,
    draft: { ...current.content },
    draftStore: store,
    email: {
      status: 'sent',
      to: String(existing?.email?.to || recipient || ''),
      sentAt,
      messageId: String(audit.messageId || ''),
    },
    sendAudit: appendUniqueSendAudit(existing.sendAudit, sanitizeSendAudit(audit)),
  };
  if (clearPending) reconciled = stateWithoutPendingSend(reconciled);
  const changed = JSON.stringify(existing) !== JSON.stringify(reconciled);
  if (changed) {
    state[noteId] = reconciled;
    await writeState(outputDir, state);
  }
  return {
    noteId,
    outreach: { ...current.content },
    draftVersion: draftVersionMetadata(store),
    delivery: publicDeliveryState(reconciled),
    duplicate: true,
    code: 'EMAIL_DUPLICATE_SEND',
    sendIdempotencyKey: String(audit.idempotencyKey || ''),
    ...(sendId || audit.sendId ? { sendId: String(sendId || audit.sendId) } : {}),
    ...(attachmentBundleHash || audit.attachmentBundleHash
      ? { attachmentBundleHash: String(attachmentBundleHash || audit.attachmentBundleHash) }
      : {}),
  };
}

function assertRecoveredRequestMatches(evidence, previewRevision) {
  const storedPreview = String(evidence?.previewRevision || '');
  if (storedPreview && previewRevision && storedPreview !== previewRevision) {
    throw applicationDraftError(
      'EMAIL_IDEMPOTENCY_CONFLICT',
      'The idempotency key is already bound to a different email preview.',
    );
  }
}

function sameSendEvidence(left, right) {
  return Boolean(left && right) && (
    (left.sendId && right.sendId && left.sendId === right.sendId)
    || (left.idempotencyKey && right.idempotencyKey && left.idempotencyKey === right.idempotencyKey)
  );
}

function durableBundleIdentityMatchesPending(bundle, pending) {
  return Boolean(bundle)
    && ['prepared', 'sent', 'failed', 'unknown'].includes(String(bundle.status || ''))
    && bundle.sendId === pending?.sendId
    && (!pending?.noteId || bundle.noteId === pending.noteId)
    && bundle.draftId === pending?.draftId
    && Number(bundle.draftVersion) === Number(pending?.version)
    && bundle.contentHash === pending?.contentHash
    && String(bundle.recipient || '').toLowerCase() === String(pending?.recipient || '').toLowerCase()
    && (!bundle.recipientHash || bundle.recipientHash === pending?.recipientHash)
    && bundle.attachmentBundleHash === pending?.attachmentBundleHash
    && Number(bundle.attachmentCount ?? bundle.attachments?.length ?? 0) === Number(pending?.attachmentCount || 0)
    && Number(bundle.attachmentBytes || 0) === Number(pending?.attachmentBytes || 0)
    && Number(bundle.smtpConfigurationRevision || 0) === Number(pending?.smtpConfigurationRevision || 0)
    && String(bundle.smtpConfigurationFingerprint || '') === String(pending?.smtpConfigurationFingerprint || '')
    && (!bundle.idempotencyKey || bundle.idempotencyKey === pending?.idempotencyKey)
    && (!bundle.requestIdempotencyKey || bundle.requestIdempotencyKey === String(pending?.requestIdempotencyKey || ''))
    && (!bundle.previewRevision || bundle.previewRevision === String(pending?.previewRevision || ''));
}

async function appendRecoveredSendAudit(outputDir, appendAudit, audit) {
  try {
    await appendAudit(outputDir, audit);
  } catch (cause) {
    const error = applicationDraftError(
      'EMAIL_DELIVERED_AUDIT_UNCERTAIN',
      'Immutable delivery evidence exists, but the durable audit journal could not be reconciled.',
    );
    error.cause = cause;
    throw error;
  }
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
    sendId: String(details.sendId || ''),
    attachmentBundleHash: String(details.attachmentBundleHash || identity.attachmentBundleHash || ''),
    attachmentCount: Number(details.attachmentCount || 0),
    attachmentBytes: Number(details.attachmentBytes || 0),
    attachments: Array.isArray(details.attachments) ? details.attachments.map((item) => ({
      attachmentId: String(item.attachmentId || ''),
      filename: String(item.filename || ''),
      mediaType: String(item.mediaType || ''),
      size: Number(item.size || 0),
      sha256: String(item.sha256 || ''),
    })) : [],
    previewRevision: String(details.previewRevision || ''),
    idempotencyKey: identity.idempotencyKey,
    ...(details.requestIdempotencyKey ? { requestIdempotencyKey: details.requestIdempotencyKey } : {}),
    configHash: String(details.smtpState?.configHash || ''),
    credentialRevision: Number(details.smtpState?.credentialRevision || 0),
    smtpConfigurationRevision: Number(details.smtpState?.smtpConfigurationRevision ?? details.smtpState?.revision ?? 0),
    smtpConfigurationFingerprint: String(details.smtpState?.smtpConfigurationFingerprint || ''),
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

async function persistAcceptedDeliveryUnknown(outputDir, state, noteId, details, writeState) {
  const existing = state[noteId] || {};
  const unknownAt = String(details?.unknownAt || new Date().toISOString());
  state[noteId] = {
    ...existing,
    ...deliveryStatusPatch(existing, 'unknown', unknownAt),
    action: 'email_unknown',
    updatedAt: unknownAt,
    email: {
      status: 'unknown',
      to: String(details?.to || ''),
      unknownAt,
      messageId: String(details?.messageId || ''),
    },
  };
  await writeState(outputDir, state).catch(() => {});
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
  if (subject.length < 8 || subject.length > MAX_APPLICATION_EMAIL_SUBJECT_LENGTH) {
    throw new ValidationError(`Email subject must contain 8-${MAX_APPLICATION_EMAIL_SUBJECT_LENGTH} characters.`);
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
  if (/(?:原帖|岗位提到|候选人|材料显示)/.test(metaScan)) {
    throw new ValidationError('Email contains unsupported meta wording.');
  }
  const roleName = normalizeApplicationRoleTitle(record?.job_card?.role_name || record?.job_card?.title || record?.title);
  if (roleName && !subject.includes(roleName) && !body.includes(roleName)) {
    throw new ValidationError('Email subject or body must identify the current role.');
  }
  if (!/(?:期待|希望|方便|愿意).{0,18}(?:沟通|交流|面试|进一步了解)/.test(body)) {
    throw new ValidationError('Email body must include a clear communication next step.');
  }
}

function extractedEmails(record, allowedRecipients) {
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
  const serverAllowed = (Array.isArray(allowedRecipients) ? allowedRecipients : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => EMAIL.test(value));
  if (Array.isArray(allowedRecipients)) return [...new Set(serverAllowed)];
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function mergeApplicationState(record, state, recordIndex, artifactFilename) {
  const store = draftStoreFor(record, state || {}, recordIndex, artifactFilename);
  const current = currentDraftVersion(store);
  const modelRewrite = state?.generation?.promptVersion === 'cover-letter-rewrite-v1';
  const qualityChecks = Array.isArray(state?.qualityChecks) ? state.qualityChecks : [];
  const recordApplicationContext = record?.outreach?.applicationContext
    ?? record?.outreach?.application_context
    ?? record?.applicationContext
    ?? record?.application_context;
  const applicationContext = persistedApplicationContext(state)
    || (recordApplicationContext
      ? normalizeApplicationContext(recordApplicationContext)
      : null);
  const applicationContextHash = persistedApplicationContextHash(state);
  const currentQuality = [...qualityChecks].reverse().find((item) => (
    item?.draftId === store.draftId
    && Number(item?.version) === current.version
    && item?.contentHash === current.contentHash
    && qualityApplicationContextMatches(item, applicationContextHash)
  ));
  return {
    ...record,
    outreach: {
      ...record.outreach,
      ...current.content,
      ...(modelRewrite ? { generation_mode: 'model_rewrite' } : {}),
      ...(applicationContext ? { applicationContext } : {}),
    },
    cover_letter_evaluation: currentQuality?.evaluation
      || (applicationContextHash === null ? record.cover_letter_evaluation : null),
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

function deliveryStatusPatch(existing, status, at) {
  const transitions = Array.isArray(existing?.deliveryTransitions)
    ? existing.deliveryTransitions.filter((item) => item && typeof item === 'object')
    : [];
  const latest = transitions.at(-1);
  const next = latest?.status === status
    ? transitions
    : [...transitions, { status, at }].slice(-64);
  return { deliveryStatus: status, deliveryTransitions: next };
}

async function appendSendAuditJournal(outputDir, audit) {
  await mkdir(outputDir, { recursive: true });
  const handle = await open(path.join(outputDir, 'delivery-send-audit.jsonl'), 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, event: 'email_sent', ...audit })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSendAuditJournal(outputDir) {
  let content;
  try {
    content = await readFile(path.join(outputDir, 'delivery-send-audit.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const audits = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid audit record');
      audits.push(value);
    } catch (cause) {
      const error = applicationDraftError(
        'DELIVERY_AUDIT_INVALID',
        `Delivery audit journal contains an invalid record at line ${index + 1}.`,
      );
      error.cause = cause;
      throw error;
    }
  }
  return audits;
}

export async function writeDeliveryState(outputDir, state) {
  await mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, 'delivery-state.json');
  let current = {};
  let previous = null;
  try {
    previous = await readFile(target, 'utf8');
    try {
      current = JSON.parse(previous);
      if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('invalid root');
    } catch (cause) {
      throw deliveryStateInvalid('Delivery state JSON is malformed.', cause);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const expectedRevision = Math.max(0, Number(state?._revision || 0));
  const actualRevision = Math.max(0, Number(current?._revision || 0));
  if (expectedRevision !== actualRevision) {
    const error = applicationDraftError(
      'DELIVERY_STATE_REVISION_CONFLICT',
      `Delivery state revision conflict: expected ${expectedRevision}, found ${actualRevision}.`,
    );
    error.expectedRevision = expectedRevision;
    error.currentRevision = actualRevision;
    throw error;
  }
  if (previous !== null && Number(current?._schemaVersion || 0) < 2) {
    try {
      await writeFile(path.join(outputDir, 'delivery-state.v1.backup.json'), previous, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const persisted = {
    ...state,
    _schemaVersion: 2,
    _revision: actualRevision + 1,
  };
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(persisted, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
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

function applicationAttachmentMediaType(filename) {
  const mediaType = APPLICATION_ATTACHMENT_MEDIA_TYPES[path.extname(String(filename || '')).toLowerCase()];
  if (!mediaType) throw new AttachmentError('ATTACHMENT_TYPE_NOT_ALLOWED', 'Attachment type is not allowed.');
  return mediaType;
}

function boundedInteger(raw, fallback, min, max) {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function strictBoundedInteger(raw, fallback, min, max, field) {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AudienceAiValidationError('Invalid audience AI query.', [{ field, reason: `must_be_integer_${min}_to_${max}` }]);
  }
  return value;
}

function decodePathSegment(value) {
  try {
    const decoded = decodeURIComponent(String(value || ''));
    if (!decoded || decoded.includes('/') || decoded.includes('\\') || /\p{Cc}/u.test(decoded)) throw new Error('invalid');
    return decoded;
  } catch {
    throw new AudienceAiValidationError('Invalid audience AI path identifier.', [{ field: 'path', reason: 'invalid_identifier' }]);
  }
}

export async function streamApplicationBatchEvents(
  req,
  res,
  service,
  batchId,
  searchParams = new URL(req.url || '/', 'http://localhost').searchParams,
) {
  const cursorValue = req.headers?.['last-event-id'] || searchParams.get('after') || '0';
  let cursor = Number(cursorValue);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    const error = new Error('Application batch event cursor must be a non-negative safe integer.');
    error.code = 'APPLICATION_BATCH_SEQUENCE_INVALID';
    error.status = 400;
    throw error;
  }
  const batch = await service.getBatch(batchId);
  let closed = false;
  let polling = false;
  let pollTimer;
  let heartbeat;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  req.once('close', close);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  writeEvent(res, 'snapshot', {
    type: 'snapshot',
    batch,
    sequence: cursor,
    throughSequence: Number(batch.lastEventSequence || 0),
  });

  const publish = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const events = await service.listEvents(batchId, { afterSequence: cursor });
      for (const event of events) {
        if (closed || !Number.isSafeInteger(event.sequence) || event.sequence <= cursor) continue;
        res.write(`id: ${event.sequence}\nevent: batch\ndata: ${JSON.stringify({
          type: 'batch',
          batchId,
          sequence: event.sequence,
          event,
        })}\n\n`);
        cursor = event.sequence;
      }
    } catch (error) {
      if (!closed) {
        writeEvent(res, 'error', {
          type: 'error',
          error: {
            code: String(error?.code || 'APPLICATION_BATCH_EVENTS_FAILED'),
            message: String(error?.message || 'Application batch event stream failed.'),
          },
        });
        close();
      }
    } finally {
      polling = false;
    }
  };
  await publish();
  if (closed) return;
  pollTimer = setInterval(() => void publish(), 750);
  heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15_000);
}

export async function streamEvents(req, res, manager, id, searchParams = new URL(req.url || '/', 'http://localhost').searchParams) {
  const lastEventId = req.headers?.['last-event-id'];
  const afterRaw = lastEventId !== undefined && lastEventId !== ''
    ? lastEventId
    : searchParams.get('after') || '0';
  const after = Number(afterRaw);
  if (!Number.isSafeInteger(after) || after < 0) {
    const error = new Error('Event cursor must be a non-negative safe integer.');
    error.code = 'EVENT_CURSOR_INVALID';
    throw error;
  }
  let closed = false;
  let heartbeat;
  let unsubscribe = () => {};
  let live = false;
  let lastSent = after;
  const buffered = [];
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };
  req.on('close', close);
  const deliver = (incoming) => {
    if (closed) return;
    const event = Number.isSafeInteger(incoming?.sequence)
      ? incoming
      : {
          ...incoming,
          sequence: lastSent + buffered.length + 1,
          eventId: `${id}:${lastSent + buffered.length + 1}`,
          jobId: id,
          attemptId: manager.get(id)?.activeAttemptId || `${id}:legacy`,
          occurredAt: new Date().toISOString(),
        };
    if (event.sequence <= lastSent) return;
    if (!live) {
      buffered.push(event);
      return;
    }
    writeJobSequencedEvent(res, event, manager, id);
    lastSent = event.sequence;
    if (event.type === 'closing') close();
  };
  unsubscribe = manager.subscribe(id, deliver);
  try {
    const throughSequence = typeof manager.getEventHighWater === 'function'
      ? await manager.getEventHighWater(id)
      : Number(manager.get(id)?.throughSequence || 0);
    const job = manager.get(id);
    if (closed) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const experienceSnapshot = job?.experienceSnapshot || job?.experience || null;
    writeEvent(res, 'snapshot', {
      type: 'snapshot',
      sequence: after,
      throughSequence,
      job,
      snapshot: experienceSnapshot,
      experienceSnapshot,
    });

    let cursor = after;
    while (cursor < throughSequence && typeof manager.listEventPage === 'function') {
      const page = await manager.listEventPage(id, cursor, { limit: 500, throughSequence });
      if (closed) return;
      for (const event of page.events) {
        if (event.sequence <= lastSent) continue;
        writeJobSequencedEvent(res, event, manager, id);
        lastSent = event.sequence;
      }
      if (!page.hasMore || page.nextAfter <= cursor) break;
      cursor = page.nextAfter;
    }

    buffered.sort((left, right) => left.sequence - right.sequence);
    for (const event of buffered) {
      if (event.sequence <= lastSent) continue;
      writeJobSequencedEvent(res, event, manager, id);
      lastSent = event.sequence;
      if (event.type === 'closing') {
        close();
        return;
      }
    }
    buffered.length = 0;
    live = true;
    heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  } catch (error) {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    req.off('close', close);
    throw error;
  }
}

function writeJobSequencedEvent(res, event, manager, id) {
  const currentJob = manager.get(id);
  const experienceSnapshot = event.data?.experienceSnapshot
    || event.data?.experience
    || currentJob?.experienceSnapshot
    || currentJob?.experience
    || null;
  let eventName = 'workflow';
  let payload = {
    type: 'workflow',
    snapshot: experienceSnapshot,
    experienceSnapshot,
  };
  if (event.type === 'log') {
    eventName = 'log';
    payload = {
      type: 'log',
      line: event.data?.message,
      level: event.data?.stream === 'stderr' ? 'error' : 'info',
      snapshot: experienceSnapshot,
      experienceSnapshot,
    };
  } else if (event.type === 'state') {
    eventName = 'status';
    payload = {
      type: 'status',
      job: event.data,
      snapshot: experienceSnapshot,
      experienceSnapshot,
    };
  } else if (event.type === 'closing') {
    eventName = 'status';
    const job = manager.get(id);
    payload = {
      type: 'status',
      job,
      snapshot: experienceSnapshot,
      experienceSnapshot,
      lifecycle: 'closing',
    };
  } else if (event.type === 'end') {
    eventName = 'done';
    const job = manager.get(id);
    payload = {
      type: 'done',
      job,
      snapshot: experienceSnapshot,
      experienceSnapshot,
    };
  }
  res.write(`id: ${event.sequence}\nevent: ${eventName}\ndata: ${JSON.stringify({
    ...payload,
    sequence: event.sequence,
    eventId: event.eventId,
    jobId: event.jobId,
    attemptId: event.attemptId,
    occurredAt: event.occurredAt,
    workflowEvent: event.workflowEvent,
    problem: event.workflowEvent?.problem || null,
  })}\n\n`);
}

async function streamAudienceAiEvents(req, res, service, jobId, postId, searchParams) {
  const afterRaw = searchParams.get('after') || req.headers['last-event-id'] || '0';
  const after = strictBoundedInteger(afterRaw, 0, 0, Number.MAX_SAFE_INTEGER, 'after');
  let closed = false;
  let heartbeat;
  let unsubscribe = () => {};
  let live = false;
  let lastSent = after;
  const buffered = [];
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };
  req.on('close', close);
  const deliver = (event) => {
    if (closed || !Number.isSafeInteger(event?.sequence) || event.sequence <= lastSent) return;
    if (!live) {
      buffered.push(event);
      return;
    }
    writeSequencedEvent(res, event);
    lastSent = event.sequence;
  };
  unsubscribe = service.subscribe(jobId, postId, deliver);
  try {
    const throughSequence = await service.getEventHighWater(jobId, postId);
    const snapshot = await service.getState(jobId, postId);
    if (closed) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    writeEvent(res, 'audience_ai_snapshot', { type: 'audience_ai_snapshot', jobId, postId, state: snapshot });

    let cursor = after;
    while (cursor < throughSequence) {
      const page = await service.listEventPage(jobId, postId, cursor, { limit: 500, throughSequence });
      if (closed) return;
      for (const event of page.events) {
        if (event.sequence <= lastSent) continue;
        writeSequencedEvent(res, event);
        lastSent = event.sequence;
      }
      if (!page.hasMore || page.nextAfter <= cursor) break;
      cursor = page.nextAfter;
    }

    buffered.sort((left, right) => left.sequence - right.sequence);
    for (const event of buffered) {
      if (event.sequence <= lastSent) continue;
      writeSequencedEvent(res, event);
      lastSent = event.sequence;
    }
    buffered.length = 0;
    live = true;
    heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
  } catch (error) {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    req.off('close', close);
    throw error;
  }
}

function writeSequencedEvent(res, event) {
  res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({
    ...event.data,
    type: event.type,
    sequence: event.sequence,
    runId: event.runId,
    jobId: event.jobId,
    postId: event.postId,
    createdAt: event.createdAt,
  })}\n\n`);
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

const CORS_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const CORS_HEADERS = new Set(['content-type', 'x-request-id']);

function isStateChangingMethod(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

function isCopilotMcpControlPath(pathname) {
  return String(pathname || '').startsWith('/api/copilot/mcp/');
}

function validateCopilotOwnerRequest(req, config = {}, actor, { authenticationRequired = false } = {}) {
  const roles = Array.isArray(actor?.roles) ? actor.roles.map((role) => String(role).toLowerCase()) : [];
  if (!actor || !roles.includes('owner')) {
    return { status: 403, code: 'COPILOT_MCP_OWNER_REQUIRED', message: 'Copilot autonomous execution requires an owner session.' };
  }

  const origin = String(req.headers.origin || '').trim();
  const fetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Request origin is not allowed.' };
  }

  if (authenticationRequired) {
    const expectedOrigin = String(config.authOrigin || '').trim();
    if (origin && expectedOrigin && origin !== expectedOrigin) {
      return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Request origin is not allowed.' };
    }
    return null;
  }

  if (!isLoopbackAddress(req.socket?.remoteAddress) || !isLoopbackHost(req.headers.host)) {
    return {
      status: 403,
      code: 'COPILOT_MCP_LOCAL_ONLY',
      message: 'Copilot autonomous execution requires a local owner session outside the loopback interface.',
    };
  }
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Request origin is not allowed.' };
    }
    if (!isLoopbackHost(originUrl.host)) {
      return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Request origin is not allowed.' };
    }
  }
  return null;
}

function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase().split('%', 1)[0];
  return address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
}

function isLoopbackHost(value) {
  const host = String(value || '').trim();
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

function validateRequestOrigin(req, config = {}, { preflight = false } = {}) {
  const expectedOrigin = String(config.authOrigin || '').trim();
  if (!expectedOrigin) return null;
  const origin = String(req.headers.origin || '').trim();
  const trustedLoopbackOrigin = isLoopbackAddress(req.socket?.remoteAddress)
    && isLoopbackHost(req.headers.host)
    && Boolean(loopbackOrigin(origin));
  if (origin && origin !== expectedOrigin && !trustedLoopbackOrigin) {
    return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Request origin is not allowed.' };
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (!origin && fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Request origin is not allowed.' };
  }
  if (!preflight) return null;
  const requestedMethod = String(req.headers['access-control-request-method'] || '').trim().toUpperCase();
  if (requestedMethod && !CORS_METHODS.has(requestedMethod)) {
    return { status: 405, code: 'CORS_METHOD_NOT_ALLOWED', message: 'Requested CORS method is not allowed.' };
  }
  const requestedHeaders = String(req.headers['access-control-request-headers'] || '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => !CORS_HEADERS.has(header))) {
    return { status: 403, code: 'CORS_HEADER_NOT_ALLOWED', message: 'Requested CORS header is not allowed.' };
  }
  return null;
}

function resolveSecurePublicRedirect(req, config = {}) {
  const configuredOrigin = String(config.authOrigin || '').trim();
  if (!configuredOrigin.startsWith('https://')) return '';
  let publicUrl;
  try {
    publicUrl = new URL(configuredOrigin);
  } catch {
    return '';
  }
  const requestHost = String(req.headers.host || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (!requestHost || requestHost !== publicUrl.host.toLowerCase()) return '';
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  let cfVisitorScheme = '';
  try {
    const cfVisitor = JSON.parse(String(req.headers['cf-visitor'] || '{}'));
    cfVisitorScheme = String(cfVisitor?.scheme || '').trim().toLowerCase();
  } catch {
    cfVisitorScheme = '';
  }
  if (forwardedProto !== 'http' && cfVisitorScheme !== 'http') return '';
  const requestUrl = String(req.url || '/');
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) return '';
  try {
    return new URL(requestUrl, publicUrl).toString();
  } catch {
    return '';
  }
}

function requestPublicProtocol(req, config = {}) {
  try {
    const configured = new URL(String(config.authOrigin || ''));
    if (configured.protocol === 'https:' || configured.protocol === 'http:') return configured.protocol.slice(0, -1);
  } catch {
    // Local deployments do not require a configured public origin.
  }
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (forwardedProto === 'https' || req.socket?.encrypted) return 'https';
  return 'http';
}

function requestPublicHost(req, config = {}) {
  try {
    const configured = new URL(String(config.authOrigin || ''));
    if (configured.host) return configured.host;
  } catch {
    // Local deployments use the request host.
  }
  const forwardedHost = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  return forwardedHost || String(req.headers.host || '').trim();
}

function setSecurityHeaders(res, config = {}, requestOrigin = '') {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  const configuredOrigin = String(config.authOrigin || '').trim();
  if (configuredOrigin.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://static.cloudflareinsights.com",
    "connect-src 'self' https: wss:",
  ].join('; '));
  res.setHeader('Permissions-Policy', 'accelerometer=(), autoplay=(self), camera=(), display-capture=(self), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()');
  const defaultDevOrigin = 'http://127.0.0.1:5173';
  const allowedOrigin = configuredOrigin || (config.authRequired === true ? '' : defaultDevOrigin);
  if (allowedOrigin && (!requestOrigin || requestOrigin === allowedOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
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

async function describeCodexConnectInstaller(filePath, previous = null) {
  const resolved = String(filePath || '').trim();
  if (!resolved) return { available: false, cache: null };
  try {
    const details = await stat(resolved);
    if (!details.isFile()) return { available: false, cache: null };
    if (previous?.path === resolved && previous.size === details.size && previous.modifiedAtMs === details.mtimeMs) {
      return { ...previous, available: true, cache: previous };
    }
    const sha256 = createHash('sha256').update(await readFile(resolved)).digest('hex');
    const cache = {
      path: resolved,
      size: details.size,
      modifiedAtMs: details.mtimeMs,
      sha256,
    };
    return { ...cache, available: true, cache };
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, cache: null };
    throw error;
  }
}

function audienceAiHttpStatus(code) {
  if (['AUDIENCE_AI_DISABLED', 'AUDIENCE_AI_JOB_NOT_FOUND', 'AUDIENCE_AI_POST_NOT_FOUND', 'AUDIENCE_AI_POST_NOT_OWNED', 'AUDIENCE_AI_RUN_NOT_FOUND', 'AUDIENCE_AI_RESULT_NOT_FOUND', 'AUDIENCE_AI_ANCHOR_NOT_FOUND'].includes(code)) return 404;
  if (['AUDIENCE_AI_ALREADY_RUNNING', 'AUDIENCE_AI_REVISION_CONFLICT', 'AUDIENCE_AI_RUN_NOT_RESUMABLE', 'AUDIENCE_AI_CANCELLED', 'AUDIENCE_AI_RELAY_BUSY', 'AUDIENCE_AI_SECURITY_BLOCKED'].includes(code)) return 409;
  if (code === 'AUDIENCE_AI_PROVIDER_RATE_LIMITED') return 429;
  if (['AUDIENCE_AI_PROVIDER_FAILED'].includes(code)) return 502;
  if (['AUDIENCE_AI_SCHEMA_INVALID', 'AUDIENCE_AI_EVIDENCE_INVALID'].includes(code)) return 422;
  if (code === 'AUDIENCE_AI_INTERNAL_ERROR') return 503;
  return 400;
}

function audienceAiErrorBody(error, { code, requestId, jobId, postId, runId }) {
  const message = String(error.message || 'Audience AI request failed.');
  const details = Array.isArray(error.details) ? error.details : undefined;
  const resumable = Boolean(error.resumable || ['AUDIENCE_AI_PROVIDER_FAILED', 'AUDIENCE_AI_PROVIDER_RATE_LIMITED', 'AUDIENCE_AI_RELAY_BUSY'].includes(code));
  return {
    errorCode: code,
    message,
    jobId,
    postId,
    runId,
    resumable,
    retryAfter: Number.isFinite(Number(error.retryAfter)) ? Number(error.retryAfter) : null,
    requestId: requestId || null,
    error: { code, message, ...(details?.length ? { details } : {}) },
  };
}

function safeDecodePathSegment(value) {
  try { return decodeURIComponent(String(value || '')) || null; } catch { return null; }
}

function isAudienceAiRouteParts(parts) {
  return parts[3] === 'audience'
    && parts[4] === 'posts'
    && Boolean(parts[5])
    && (parts[6] === 'ai' || ['comments', 'users'].includes(parts[6]));
}

function codexWebviewRoot(config) {
  return path.join(
    config.codexDesktopRuntimeDir || path.join(config.projectRoot || process.cwd(), 'output', 'codex-desktop-runtime-55d9fb967596'),
    'app',
    'resources',
    'app-unpacked',
    'webview',
  );
}

function codexRelayConnectionToken(req, body = null) {
  const header = req.headers['x-codex-relay-connection'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && typeof header[0] === 'string' && header[0].trim()) return header[0].trim();
  return typeof body?.connectionToken === 'string' ? body.connectionToken : '';
}

function setCodexBrowserSecurityHeaders(req, res, config = {}) {
  const allowLoopbackDevFrame = config.authRequired !== true
    && isLoopbackAddress(req.socket?.remoteAddress)
    && isLoopbackHost(req.headers.host);
  const loopbackFrameOrigin = allowLoopbackDevFrame
    ? loopbackOrigin(req.headers.referer)
    : '';
  if (allowLoopbackDevFrame) res.removeHeader('X-Frame-Options');
  else res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const frameAncestors = `frame-ancestors 'self'${loopbackFrameOrigin ? ` ${loopbackFrameOrigin}` : ''}`;
  const requestPath = new URL(String(req.url || '/'), 'http://localhost').pathname;
  const mirrorLoopbackSources = requestPath === '/codex-native-mirror.html'
    ? ' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*'
    : '';
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    frameAncestors,
    "img-src 'self' app: blob: data: https:",
    "child-src 'self' blob: https:",
    "frame-src 'self' blob: https:",
    "worker-src 'self' blob:",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "media-src 'self' app: blob: data:",
    `connect-src 'self' https: wss:${mirrorLoopbackSources}`,
  ].join('; '));
}

function loopbackOrigin(value) {
  try {
    const origin = new URL(String(value || '')).origin;
    return /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u.test(origin) ? origin : '';
  } catch {
    return '';
  }
}

async function serveCodexWebview(req, res, config, pathname, codexRuntimeCompatibility = null) {
  const root = codexWebviewRoot(config);
  let decoded;
  try {
    decoded = decodeURIComponent(pathname.slice('/codex/'.length));
  } catch {
    return false;
  }
  const relative = decoded.replace(/^\/+/, '').replaceAll('/', path.sep);
  const requested = relative === 'browser-host.js'
    ? path.join(config.projectRoot || config.workspaceRoot || process.cwd(), 'public', 'codex-browser-host.js')
    : path.resolve(root, relative || 'index.html');
  const allowedRoot = relative === 'browser-host.js'
    ? path.join(config.projectRoot || config.workspaceRoot || process.cwd(), 'public')
    : root;
  try {
    assertPathInside(allowedRoot, requested);
  } catch {
    return false;
  }
  const file = await safeStaticFile(allowedRoot, requested);
  if (!file) return false;
  const isIndex = path.basename(file.absolute).toLowerCase() === 'index.html';
  if (isIndex) {
    const source = await readFile(file.absolute, 'utf8');
    const marker = '<script type="module"';
    const injection = '<link rel="icon" href="data:,">\n    <script src="/codex/browser-host.js"></script>\n    ';
    const html = source.includes(marker) ? source.replace(marker, `${injection}${marker}`) : source;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(html);
    return true;
  }
  const isBrowserAppInitial = path.basename(file.absolute) === 'app-initial-KpqQCW_k.js';
  if (isBrowserAppInitial || codexRuntimeCompatibility?.status?.().patchAssets?.some((entry) => entry.kind === 'app-initial' && path.resolve(entry.file).toLowerCase() === path.resolve(file.absolute).toLowerCase())) {
    const source = await readFile(file.absolute, 'utf8');
    const runtimeTransform = codexRuntimeCompatibility?.transform?.(file.absolute, source);
    if (runtimeTransform?.ok === false) {
      const error = new Error(runtimeTransform.errorMessage || 'Codex browser runtime patch anchor changed.');
      error.code = runtimeTransform.errorCode || 'CODEX_RUNTIME_PATCH_ANCHOR_CHANGED';
      throw error;
    }
    if (runtimeTransform?.matched) {
      const browserSource = runtimeTransform.source;
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(browserSource),
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      res.end(browserSource);
      return true;
    }
    const desktopConnect = 'async function J8e(){Y8e=q8e(),Am=await Y8e.services,Am.clientCoordination!=null&&h8e(Am.clientCoordination),Am.terminal!=null&&G3e(Am.terminal),Am.devboxService}';
    const browserConnect = 'async function J8e(){Am={localThreadCatalog:null,threadProjectAssignments:{setAssignment:async()=>{}},clientCoordination:null,terminal:null,devboxService:null,startup:null,requestUserInputAutoResolution:{setConversationPresented(){},recordConversationActivity(){},snooze(){}},appInfo:{get:async()=>({appVersion:"26.803.81509",version:"26.803.81509",buildNumber:"6415",buildFlavor:"prod"})}}}';
    if (!source.includes(desktopConnect)) {
      const error = new Error('Codex app-initial startup anchor was not found.');
      error.code = 'CODEX_RUNTIME_PATCH_ANCHOR_CHANGED';
      throw error;
    }
    const browserSource = source.replace(desktopConnect, browserConnect);
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(browserSource),
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(browserSource);
    return true;
  }
  const isBrowserAppMain = path.basename(file.absolute) === 'app-main-CCNMdQcy.js';
  if (isBrowserAppMain || codexRuntimeCompatibility?.status?.().patchAssets?.some((entry) => entry.kind === 'app-main' && path.resolve(entry.file).toLowerCase() === path.resolve(file.absolute).toLowerCase())) {
    const source = await readFile(file.absolute, 'utf8');
    const runtimeTransform = codexRuntimeCompatibility?.transform?.(file.absolute, source);
    if (runtimeTransform?.ok === false) {
      const error = new Error(runtimeTransform.errorMessage || 'Codex browser runtime patch anchor changed.');
      error.code = runtimeTransform.errorCode || 'CODEX_RUNTIME_PATCH_ANCHOR_CHANGED';
      throw error;
    }
    if (runtimeTransform?.matched) {
      const browserSource = runtimeTransform.source;
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(browserSource),
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      res.end(browserSource);
      return true;
    }
    const browserSource = source
      .replace('await V(),await ne(),u(),', 'await V(),ne().catch(()=>{}),u(),')
      .replace(
        'let e=G||K||l.startup==null?void 0:Promise.resolve(l.startup.whenReady());',
        'let e=G||K||l==null||l.startup==null?void 0:Promise.resolve(l.startup.whenReady());',
      )
      .replaceAll('l.startup', 'l?.startup');
    if (browserSource === source) {
      const error = new Error('Codex app-main startup anchors were not found.');
      error.code = 'CODEX_RUNTIME_PATCH_ANCHOR_CHANGED';
      throw error;
    }
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(browserSource),
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(browserSource);
    return true;
  }
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
    '.avif': 'image/avif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
