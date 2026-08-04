import { createHash, randomUUID } from 'node:crypto';

import { buildApplicationAttachmentRule } from './lib/application-attachment-rule.mjs';
import { resolveApplicationContacts } from './lib/application-contact-resolver.mjs';

const NOTE_ID = /^[\p{L}\p{N}_.:-]{1,160}$/u;
const IDEMPOTENCY_KEY = /^[\p{L}\p{N}_.:-]{8,160}$/u;
const DEFAULT_MAX_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 100;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const MAX_MIN_INTERVAL_MS = 60_000;
const RETRYABLE_CODES = new Set([
  'EMAIL_PREVIEW_STALE',
  'SMTP_NOT_CONFIGURED',
  'SMTP_NOT_VERIFIED',
  'SMTP_VERIFICATION_EXPIRED',
  'SMTP_RATE_LIMITED',
  'SMTP_AUTH_FAILED',
  'SMTP_DNS_FAILED',
  'SMTP_CONNECTION_TIMEOUT',
  'SMTP_TLS_FAILED',
  'SMTP_VERIFICATION_FAILED',
  'MAIL_CONNECTION_FAILED',
]);

export class ApplicationBatchServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'ApplicationBatchServiceError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export class ApplicationBatchService {
  constructor({
    jobId,
    outputDir,
    manager,
    candidateProfile = {},
    fallbackOutputDirs = [],
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
    loadRecord,
    listAttachments,
    renameAttachment,
    checkQuality,
    previewEmail,
    sendEmail,
    acquireSendSlot = null,
    now = () => new Date(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) {
    if (!manager) throw batchServiceError('APPLICATION_BATCH_MANAGER_REQUIRED', 'Application batch manager is required.', 500);
    for (const [name, callback] of Object.entries({ loadRecord, listAttachments, renameAttachment, checkQuality, previewEmail, sendEmail })) {
      if (typeof callback !== 'function') {
        throw batchServiceError('APPLICATION_BATCH_CALLBACK_REQUIRED', `Application batch callback ${name} is required.`, 500);
      }
    }
    this.jobId = String(jobId || '').trim();
    this.outputDir = String(outputDir || '').trim();
    this.manager = manager;
    this.candidateProfile = candidateProfile && typeof candidateProfile === 'object' ? candidateProfile : {};
    this.fallbackOutputDirs = [...new Set((Array.isArray(fallbackOutputDirs) ? fallbackOutputDirs : []).map(String).filter(Boolean))];
    this.maxBatchSize = boundedInteger(maxBatchSize, 1, MAX_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE);
    this.loadRecord = loadRecord;
    this.listAttachments = listAttachments;
    this.renameAttachment = renameAttachment;
    this.checkQuality = checkQuality;
    this.previewEmail = previewEmail;
    this.sendEmail = sendEmail;
    if (acquireSendSlot !== null && typeof acquireSendSlot !== 'function') {
      throw batchServiceError('APPLICATION_BATCH_CALLBACK_REQUIRED', 'Application batch callback acquireSendSlot must be a function.', 500);
    }
    this.acquireSendSlot = acquireSendSlot;
    this.now = now;
    this.sleep = sleep;
    this.runners = new Map();
  }

  async dryRun(value = {}) {
    const batchId = randomUUID();
    const prepared = await this.#prepare(value, { batchId, applyChanges: false });
    return {
      schemaVersion: 1,
      dryRun: true,
      generatedAt: isoNow(this.now),
      maxBatchSize: this.maxBatchSize,
      ...prepared,
    };
  }

  async createBatch(value = {}) {
    const createIdentity = normalizedCreateIdentity(value, this.maxBatchSize);
    const createIdempotencyKey = optionalIdempotencyKey(value.idempotencyKey);
    const createRequestHash = hashJson(createIdentity);
    const batchId = createIdempotencyKey
      ? stableBatchId(this.jobId, createIdempotencyKey)
      : randomUUID();
    if (createIdempotencyKey) {
      const replay = await this.#idempotentReplay(batchId, createIdempotencyKey, createRequestHash);
      if (replay) return replay;
    }
    const prepared = await this.#prepare(value, { batchId, applyChanges: true });
    const readyItems = prepared.items.filter((item) => item.status === 'ready');
    if (!readyItems.length) {
      throw batchServiceError(
        'APPLICATION_BATCH_NO_READY_ITEMS',
        'No application is ready to freeze. Review the preflight blockers and try again.',
        409,
        prepared,
      );
    }
    const readyIds = new Set(readyItems.map((item) => item.noteId));
    const items = prepared.items.map((item) => ({
      itemId: item.noteId,
      noteId: item.noteId,
      contactCandidateId: item.contact?.evidenceHash || null,
      status: readyIds.has(item.noteId) ? 'ready' : 'skipped',
      payload: item.payload || preflightPayload(item),
      error: readyIds.has(item.noteId) ? null : {
        code: item.blockers[0]?.code || 'APPLICATION_BATCH_ITEM_EXCLUDED',
        message: item.blockers[0]?.message || 'The item was excluded by preflight.',
      },
    }));
    const minIntervalMs = boundedInteger(value.minIntervalMs, 0, MAX_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS);
    let batch;
    try {
      batch = await this.manager.createBatch({
      batchId,
      jobId: this.jobId,
      title: normalizedText(value.title, 240) || `批量投递 ${isoNow(this.now).slice(0, 10)}`,
      metadata: {
        generatedAt: isoNow(this.now),
        selectedCount: prepared.items.length,
        readyCount: readyItems.length,
        excludedCount: prepared.items.length - readyItems.length,
        preflightHash: hashJson(prepared.items.map(preflightPayload)),
        ...(createIdempotencyKey ? {
          createIdempotencyKey,
          createRequestHash,
        } : {}),
      },
      settings: {
        concurrency: 1,
        minIntervalMs,
        maxBatchSize: this.maxBatchSize,
        stagedLimit: this.maxBatchSize,
      },
      items,
      });
    } catch (error) {
      if (createIdempotencyKey && error?.code === 'APPLICATION_BATCH_CONFLICT') {
        const replay = await this.#idempotentReplay(batchId, createIdempotencyKey, createRequestHash);
        if (replay) return replay;
      }
      throw error;
    }
    return { schemaVersion: 1, batch, preflight: prepared };
  }

  async reconcileItem(batchId, itemId, value = {}) {
    const expectedBatchRevision = requiredRevision(value.expectedRevision);
    const expectedItemRevision = requiredRevision(value.expectedItemRevision);
    const actor = normalizedText(value.actor, 160);
    const reason = normalizedText(value.reason, 1_000);
    const outcome = String(value.outcome || '').trim();
    if (!actor) {
      throw batchServiceError('APPLICATION_BATCH_RECONCILIATION_ACTOR_REQUIRED', 'A reconciliation actor is required.');
    }
    if (!reason) {
      throw batchServiceError('APPLICATION_BATCH_RECONCILIATION_REASON_REQUIRED', 'A reconciliation reason is required.');
    }
    if (!['sent', 'not_sent'].includes(outcome)) {
      throw batchServiceError(
        'APPLICATION_BATCH_RECONCILIATION_OUTCOME_INVALID',
        'Reconciliation outcome must be sent or not_sent.',
      );
    }
    const batch = await this.manager.getBatch(batchId);
    const item = batch.items.find((candidate) => candidate.itemId === itemId);
    if (!item) {
      throw batchServiceError('APPLICATION_BATCH_ITEM_NOT_FOUND', 'Application batch item was not found.', 404);
    }
    if (item.status !== 'unknown_manual_review') {
      throw batchServiceError(
        'APPLICATION_BATCH_RECONCILIATION_STATE_INVALID',
        'Only an item awaiting manual delivery review can be reconciled.',
        409,
      );
    }
    const attempt = Math.max(1, Number(item.error?.attempt || 1));
    return this.manager.updateItem(batchId, itemId, {
      status: outcome === 'sent' ? 'sent' : 'failed_retryable',
      error: {
        code: outcome === 'sent'
          ? 'APPLICATION_DELIVERY_CONFIRMED_SENT'
          : 'APPLICATION_DELIVERY_CONFIRMED_NOT_SENT',
        message: reason,
        attempt,
        ...(outcome === 'not_sent' ? {
          backoffMs: 0,
          retryAt: isoNow(this.now),
        } : {}),
      },
    }, {
      expectedBatchRevision,
      expectedItemRevision,
      actor,
    });
  }

  async approveBatch(batchId, value = {}) {
    return this.manager.approveBatch(batchId, {
      expectedRevision: requiredRevision(value.expectedRevision),
      actor: normalizedText(value.actor, 160) || 'user',
      reason: normalizedText(value.reason, 1_000) || 'batch preview reviewed',
    });
  }

  async startBatch(batchId, value = {}) {
    const batch = await this.manager.resumeBatch(batchId, {
      expectedRevision: optionalRevision(value.expectedRevision),
      actor: normalizedText(value.actor, 160) || 'user',
      reason: normalizedText(value.reason, 1_000) || 'batch started',
    });
    this.#schedule(batchId);
    return batch;
  }

  async pauseBatch(batchId, value = {}) {
    return this.manager.pauseBatch(batchId, {
      expectedRevision: optionalRevision(value.expectedRevision),
      actor: normalizedText(value.actor, 160) || 'user',
      reason: normalizedText(value.reason, 1_000) || 'batch paused',
    });
  }

  async cancelBatch(batchId, value = {}) {
    return this.manager.cancelBatch(batchId, {
      expectedRevision: optionalRevision(value.expectedRevision),
      actor: normalizedText(value.actor, 160) || 'user',
      reason: normalizedText(value.reason, 1_000) || 'batch cancelled',
    });
  }

  async getBatch(batchId) {
    return this.manager.getBatch(batchId);
  }

  async listBatches() {
    return this.manager.listBatches({ jobId: this.jobId });
  }

  async listEvents(batchId, value = {}) {
    return this.manager.listEvents(batchId, { afterSequence: boundedInteger(value.afterSequence, 0, Number.MAX_SAFE_INTEGER, 0) });
  }

  async waitForIdle(batchId) {
    await this.runners.get(batchId);
  }

  async #idempotentReplay(batchId, createIdempotencyKey, createRequestHash) {
    let existing;
    try {
      existing = await this.manager.getBatch(batchId);
    } catch (error) {
      if (error?.code === 'APPLICATION_BATCH_NOT_FOUND') return null;
      throw error;
    }
    if (
      existing.jobId !== this.jobId
      || existing.metadata?.createIdempotencyKey !== createIdempotencyKey
      || existing.metadata?.createRequestHash !== createRequestHash
    ) {
      throw batchServiceError(
        'APPLICATION_BATCH_IDEMPOTENCY_CONFLICT',
        'The application batch idempotency key was already used with different content.',
        409,
      );
    }
    return {
      schemaVersion: 1,
      batch: existing,
      preflight: null,
      idempotentReplay: true,
    };
  }

  async #prepare(value, { batchId, applyChanges }) {
    const noteIds = normalizedNoteIds(value.noteIds, this.maxBatchSize);
    const approvals = normalizedContactApprovals(value.contactApprovals);
    const items = [];
    for (const noteId of noteIds) {
      items.push(await this.#prepareItem({
        noteId,
        batchId,
        approvals,
        defaultAttachmentTemplate: value.defaultAttachmentTemplate,
        aiSessionId: value.aiSessionId,
        applyChanges,
      }));
    }
    return {
      batchId,
      items,
      counts: countPreflightStatuses(items),
      readyNoteIds: items.filter((item) => item.status === 'ready').map((item) => item.noteId),
      preparableNoteIds: items.filter((item) => item.canPrepare).map((item) => item.noteId),
    };
  }

  async #prepareItem({ noteId, batchId, approvals, defaultAttachmentTemplate, aiSessionId, applyChanges }) {
    let record;
    try {
      record = await this.loadRecord(noteId);
    } catch (error) {
      return blockedItem(noteId, 'draft_pending', 'APPLICATION_RECORD_UNAVAILABLE', publicErrorMessage(error));
    }
    const roleName = String(record?.job_card?.role_name || record?.job_card?.title || record?.title || '未命名岗位').trim();
    const contactResolution = await resolveApplicationContacts(record, {
      outputDir: this.outputDir,
      fallbackOutputDirs: this.fallbackOutputDirs,
    });
    const contact = selectedContact(contactResolution, approvals.get(noteId));
    if (!contact) {
      const status = contactResolution.status === 'no_email' ? 'blocked_no_email' : 'blocked_ambiguous';
      return {
        ...blockedItem(noteId, status, contactBlockerCode(contactResolution), contactBlockerMessage(contactResolution)),
        title: String(record?.title || roleName),
        roleName,
        contactResolution,
      };
    }

    let attachmentList = await this.listAttachments(noteId);
    let selected = selectedReadyAttachments(attachmentList);
    if (!selected.length) {
      return {
        ...blockedItem(noteId, 'filename_pending', 'APPLICATION_ATTACHMENT_REQUIRED', '该岗位没有已选择且校验通过的附件。'),
        title: String(record?.title || roleName),
        roleName,
        contact,
        contactResolution,
        attachments: [],
      };
    }
    const planned = selected.map((attachment) => ({
      attachment,
      rule: buildApplicationAttachmentRule(record, {
        defaultTemplate: defaultAttachmentTemplate,
        originalName: attachment.originalName,
        candidateName: this.candidateProfile.name,
        jobTitle: roleName,
        values: candidateRuleValues(this.candidateProfile),
      }),
    }));
    const invalidRule = planned.find((item) => item.rule.status !== 'ready');
    if (invalidRule) {
      return {
        ...blockedItem(noteId, 'filename_pending', attachmentRuleCode(invalidRule.rule), attachmentRuleMessage(invalidRule.rule)),
        title: String(record?.title || roleName),
        roleName,
        contact,
        contactResolution,
        attachments: attachmentPreviews(planned),
      };
    }
    const duplicateName = duplicateDisplayName(planned.map((item) => item.rule.displayName));
    if (duplicateName) {
      return {
        ...blockedItem(noteId, 'filename_pending', 'APPLICATION_ATTACHMENT_NAME_CONFLICT', `多个附件会得到同一发送名：${duplicateName}`),
        title: String(record?.title || roleName),
        roleName,
        contact,
        contactResolution,
        attachments: attachmentPreviews(planned),
      };
    }
    const renameRequired = planned.some(({ attachment, rule }) => attachment.displayName !== rule.displayName);
    if (!applyChanges && renameRequired) {
      return {
        ...blockedItem(noteId, 'filename_pending', 'APPLICATION_ATTACHMENT_RENAME_PENDING', '冻结批次时将应用确定性的附件发送名，并使旧预览与旧审批失效。', true),
        title: String(record?.title || roleName),
        roleName,
        contact,
        contactResolution,
        attachments: attachmentPreviews(planned),
      };
    }
    if (applyChanges && renameRequired) {
      try {
        for (const { attachment, rule } of planned) {
          if (attachment.displayName === rule.displayName) continue;
          await this.renameAttachment(attachment.attachmentId, rule.displayName);
        }
      } catch (error) {
        const originalNames = new Map(planned.map(({ attachment }) => [attachment.attachmentId, attachment.displayName]));
        try {
          const currentAttachments = await this.listAttachments(noteId);
          for (const attachment of selectedReadyAttachments(currentAttachments)) {
            const originalName = originalNames.get(attachment.attachmentId);
            if (originalName && attachment.displayName !== originalName) {
              await this.renameAttachment(attachment.attachmentId, originalName);
            }
          }
        } catch (rollbackError) {
          error.rollbackCode = String(rollbackError?.code || 'APPLICATION_ATTACHMENT_RENAME_ROLLBACK_FAILED');
          error.rollbackMessage = publicErrorMessage(rollbackError);
        }
        throw error;
      }
      attachmentList = await this.listAttachments(noteId);
      selected = selectedReadyAttachments(attachmentList);
      record = await this.loadRecord(noteId);
    }

    const attachmentIds = selected.map((attachment) => attachment.attachmentId);
    if (!hasUsableDraft(record)) {
      return {
        ...blockedItem(noteId, 'draft_pending', 'APPLICATION_DRAFT_REQUIRED', '该岗位缺少可发送的个性化邮件主题或正文。'),
        title: String(record?.title || roleName),
        roleName,
        contact,
        contactResolution,
        attachments: attachmentPreviewsFromSelected(selected, planned),
      };
    }
    if (applyChanges && record?.draftVersion?.qualityStatus !== 'passed') {
      try {
        await this.checkQuality(noteId, attachmentIds, aiSessionId);
        record = await this.loadRecord(noteId);
      } catch (error) {
        return {
          ...blockedItem(noteId, 'quality_pending', error?.code || 'APPLICATION_QUALITY_CHECK_FAILED', publicErrorMessage(error)),
          title: String(record?.title || roleName),
          roleName,
          contact,
          contactResolution,
          attachments: attachmentPreviewsFromSelected(selected, planned),
        };
      }
    }
    if (record?.draftVersion?.qualityStatus !== 'passed') {
      return {
        ...blockedItem(noteId, 'quality_pending', 'APPLICATION_QUALITY_PENDING', '个性化正文尚未通过当前附件版本的质量门禁。', !applyChanges),
        title: String(record?.title || roleName),
        roleName,
        contact,
        contactResolution,
        attachments: attachmentPreviewsFromSelected(selected, planned),
      };
    }

    let preview;
    try {
      preview = await this.previewEmail({
        noteId,
        to: contact.address,
        attachmentIds,
        draftId: record.draftVersion?.draftId,
        version: record.draftVersion?.version,
      }, [contact.address]);
    } catch (error) {
      return {
        ...blockedItem(noteId, previewBlockStatus(error), error?.code || 'APPLICATION_PREVIEW_FAILED', publicErrorMessage(error)),
        title: String(record?.title || roleName),
        roleName,
        contact,
        contactResolution,
        attachments: attachmentPreviewsFromSelected(selected, planned),
      };
    }
    if (preview.readiness !== 'ready') {
      const warning = preview.warnings?.find((item) => item.blocking);
      return {
        ...blockedItem(noteId, 'quality_pending', warning?.code || 'APPLICATION_PREVIEW_BLOCKED', warning?.message || '邮件预览被质量门禁阻塞。'),
        title: String(record?.title || roleName),
        roleName,
        contact,
        contactResolution,
        attachments: attachmentPreviewsFromPreview(preview, selected),
        preview: publicPreview(preview),
      };
    }
    const idempotencyKey = `${batchId}:${noteId}:${preview.previewRevision}`.slice(0, 200);
    const payload = {
      title: String(record?.title || roleName),
      roleName,
      recipient: preview.recipient,
      contact: publicContact(contact),
      subject: preview.subject,
      body: preview.text,
      bodyHash: sha256(preview.text),
      draftId: preview.draftId,
      draftVersion: preview.draftVersion,
      contentHash: String(preview.quality?.contentHash || record?.draftVersion?.contentHash || ''),
      qualityReportRef: preview.quality?.qualityReportRef || null,
      attachmentBundleHash: preview.attachmentBundleHash,
      attachments: preview.attachmentSummary.attachments,
      finalFilenames: preview.attachmentSummary.attachments.map((item) => item.filename),
      previewRevision: preview.previewRevision,
      smtpConfigurationRevision: Number(preview.smtpConfigurationRevision || 0),
      smtpConfigurationFingerprint: String(preview.smtpConfigurationFingerprint || ''),
      sendRequest: {
        noteId,
        to: preview.recipient,
        attachmentIds: preview.attachmentSummary.attachments.map((item) => item.attachmentId),
        attachmentBundleHash: preview.attachmentBundleHash,
        previewRevision: preview.previewRevision,
        idempotencyKey,
        draftId: preview.draftId,
        version: preview.draftVersion,
      },
    };
    return {
      noteId,
      title: payload.title,
      roleName,
      status: 'ready',
      canPrepare: true,
      blockers: [],
      contact: publicContact(contact),
      contactResolution,
      attachments: attachmentPreviewsFromPreview(preview, selected),
      preview: publicPreview(preview),
      payload,
    };
  }

  #schedule(batchId) {
    if (this.runners.has(batchId)) return;
    const runner = Promise.resolve()
      .then(() => this.#run(batchId))
      .finally(() => this.runners.delete(batchId));
    this.runners.set(batchId, runner);
  }

  async #run(batchId) {
    let lastAttemptAt = 0;
    while (true) {
      let batch = await this.manager.getBatch(batchId);
      if (batch.status !== 'running') return;
      const item = batch.items.find((candidate) => ['ready', 'failed_retryable'].includes(candidate.status));
      if (!item) return;
      const retryAt = Date.parse(String(item.error?.retryAt || ''));
      while (Number.isFinite(retryAt) && retryAt > this.now().getTime()) {
        await this.sleep(Math.min(500, retryAt - this.now().getTime()));
        batch = await this.manager.getBatch(batchId);
        if (batch.status !== 'running') return;
      }
      const minIntervalMs = boundedInteger(batch.settings?.minIntervalMs, 0, MAX_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS);
      if (!this.acquireSendSlot) {
        const delay = minIntervalMs - (this.now().getTime() - lastAttemptAt);
        if (delay > 0) await this.sleep(delay);
      }
      batch = await this.manager.getBatch(batchId);
      if (batch.status !== 'running') return;
      const current = batch.items.find((candidate) => candidate.itemId === item.itemId);
      if (!current || !['ready', 'failed_retryable'].includes(current.status)) continue;
      batch = await this.manager.updateItem(batchId, current.itemId, { status: 'sending', error: null }, {
        expectedBatchRevision: batch.revision,
        expectedItemRevision: current.revision,
        actor: 'batch_worker',
      });
      let sendStarted = false;
      try {
        if (this.acquireSendSlot) await this.acquireSendSlot(minIntervalMs);
        lastAttemptAt = this.now().getTime();
        sendStarted = true;
        await this.sendEmail(current.payload.sendRequest, [current.payload.recipient]);
        const sending = batch.items.find((candidate) => candidate.itemId === current.itemId);
        await this.manager.updateItem(batchId, current.itemId, { status: 'sent', error: null }, {
          expectedBatchRevision: batch.revision,
          expectedItemRevision: sending?.revision,
          actor: 'batch_worker',
        });
      } catch (error) {
        batch = await this.manager.getBatch(batchId);
        const sending = batch.items.find((candidate) => candidate.itemId === current.itemId);
        if (!sending || sending.status !== 'sending') continue;
        const retryable = !sendStarted || isKnownNotSent(error);
        const attempt = Number(current.error?.attempt || 0) + 1;
        const backoffMs = retryable ? Math.min(60_000, 1_000 * (2 ** Math.min(attempt - 1, 6))) : 0;
        batch = await this.manager.updateItem(batchId, current.itemId, {
          status: retryable ? 'failed_retryable' : 'unknown_manual_review',
          error: {
            code: String(error?.code || (sendStarted ? 'SMTP_SEND_FAILED' : 'SMTP_SEND_GATE_FAILED')),
            message: publicErrorMessage(error),
            attempt,
            ...(retryable ? {
              backoffMs,
              retryAt: new Date(this.now().getTime() + backoffMs).toISOString(),
            } : {}),
          },
        }, {
          expectedBatchRevision: batch.revision,
          expectedItemRevision: sending.revision,
          actor: 'batch_worker',
        });
        if (batch.status === 'running') {
          await this.manager.pauseBatch(batchId, {
            expectedRevision: batch.revision,
            actor: 'batch_worker',
            reason: retryable ? 'retryable send failure' : 'delivery status requires manual review',
          });
        }
        return;
      }
    }
  }
}

function normalizedNoteIds(value, maxBatchSize) {
  if (!Array.isArray(value) || value.length < 1) {
    throw batchServiceError('APPLICATION_BATCH_ITEMS_REQUIRED', 'Select at least one application.');
  }
  const noteIds = [...new Set(value.map((item) => String(item || '').trim()))];
  if (noteIds.length > maxBatchSize) {
    throw batchServiceError('APPLICATION_BATCH_LIMIT_EXCEEDED', `This release accepts at most ${maxBatchSize} applications per batch.`, 409);
  }
  if (noteIds.some((noteId) => !NOTE_ID.test(noteId))) {
    throw batchServiceError('APPLICATION_BATCH_NOTE_INVALID', 'Application batch contains an invalid note ID.');
  }
  return noteIds;
}

function normalizedContactApprovals(value) {
  const approvals = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const noteId = String(item?.noteId || '').trim();
    const evidenceHash = String(item?.evidenceHash || '').trim().toLowerCase();
    if (!NOTE_ID.test(noteId) || !/^[a-f0-9]{64}$/u.test(evidenceHash) || item?.confirmed !== true) continue;
    approvals.set(noteId, evidenceHash);
  }
  return approvals;
}

function normalizedCreateIdentity(value, maxBatchSize) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    noteIds: normalizedNoteIds(input.noteIds, maxBatchSize),
    contactApprovals: [...normalizedContactApprovals(input.contactApprovals).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([noteId, evidenceHash]) => ({ noteId, evidenceHash })),
    defaultAttachmentTemplate: normalizedText(input.defaultAttachmentTemplate, 240),
    aiSessionId: normalizedText(input.aiSessionId, 160),
    title: normalizedText(input.title, 240),
    minIntervalMs: boundedInteger(input.minIntervalMs, 0, MAX_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS),
  };
}

function optionalIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  const key = String(value).normalize('NFC').trim();
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw batchServiceError(
      'APPLICATION_BATCH_IDEMPOTENCY_KEY_INVALID',
      'Application batch idempotency key must contain 8 to 160 safe characters.',
    );
  }
  return key;
}

function stableBatchId(jobId, idempotencyKey) {
  return `batch-${sha256(`${jobId}\0${idempotencyKey}`).slice(0, 40)}`;
}

function selectedContact(resolution, approvedEvidenceHash) {
  if (resolution?.status === 'ready' && resolution.selectedCandidate) return resolution.selectedCandidate;
  if (!approvedEvidenceHash || resolution?.collectionStatus !== 'complete') return null;
  return resolution.candidates?.find((candidate) => candidate.evidenceHash === approvedEvidenceHash) || null;
}

function selectedReadyAttachments(value) {
  return (Array.isArray(value?.attachments) ? value.attachments : [])
    .filter((item) => item?.selected === true && item?.status === 'ready' && item?.validationStatus === 'passed');
}

function hasUsableDraft(record) {
  return Boolean(String(record?.outreach?.email_subject || '').trim() && String(record?.outreach?.email_body || '').trim());
}

function candidateRuleValues(profile) {
  return {
    candidateName: profile?.name,
    school: profile?.school || profile?.education?.school,
    major: profile?.major || profile?.education?.major,
    degreeYear: profile?.degreeYear || profile?.graduationYear,
    availabilityDays: profile?.availabilityDays,
    internshipDuration: profile?.internshipDuration,
    arrivalDate: profile?.arrivalDate || profile?.availableFrom,
    phone: profile?.phone || profile?.phoneWeChat || profile?.mobile,
    email: profile?.email,
  };
}

function attachmentPreviews(planned) {
  return planned.map(({ attachment, rule }) => ({
    attachmentId: attachment.attachmentId,
    originalName: attachment.originalName,
    currentDisplayName: attachment.displayName,
    finalDisplayName: rule.displayName,
    sha256: attachment.sha256,
    rule,
  }));
}

function attachmentPreviewsFromSelected(selected, planned) {
  const rules = new Map(planned.map((item) => [item.attachment.attachmentId, item.rule]));
  return selected.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    originalName: attachment.originalName,
    currentDisplayName: attachment.displayName,
    finalDisplayName: rules.get(attachment.attachmentId)?.displayName || attachment.displayName,
    sha256: attachment.sha256,
    rule: rules.get(attachment.attachmentId) || null,
  }));
}

function attachmentPreviewsFromPreview(preview, selected) {
  const originals = new Map(selected.map((item) => [item.attachmentId, item]));
  return preview.attachmentSummary.attachments.map((item) => ({
    attachmentId: item.attachmentId,
    originalName: originals.get(item.attachmentId)?.originalName || item.filename,
    currentDisplayName: item.filename,
    finalDisplayName: item.filename,
    sha256: item.sha256,
    size: item.size,
    mediaType: item.mediaType,
  }));
}

function duplicateDisplayName(names) {
  const seen = new Set();
  for (const name of names) {
    const key = String(name || '').toLocaleLowerCase('en-US');
    if (seen.has(key)) return name;
    seen.add(key);
  }
  return '';
}

function blockedItem(noteId, status, code, message, canPrepare = false) {
  return {
    noteId,
    title: '',
    roleName: '',
    status,
    canPrepare,
    blockers: [{ code, message }],
    contact: null,
    contactResolution: null,
    attachments: [],
    preview: null,
    payload: null,
  };
}

function preflightPayload(item) {
  return {
    title: item.title,
    roleName: item.roleName,
    preflightStatus: item.status,
    blockers: item.blockers,
    contact: item.contact,
    contactResolution: item.contactResolution,
    attachments: item.attachments,
    preview: item.preview,
  };
}

function publicContact(candidate) {
  return candidate ? {
    address: candidate.address,
    source: candidate.source,
    noteId: candidate.noteId,
    postId: candidate.postId,
    commentId: candidate.commentId,
    authorId: candidate.authorId,
    evidenceText: candidate.evidenceText,
    evidenceHash: candidate.evidenceHash,
    confidence: candidate.confidence,
    collectionStatus: candidate.collectionStatus,
    verificationStatus: candidate.verificationStatus,
    ownershipStatus: candidate.ownershipStatus,
    normalizationApplied: Boolean(candidate.normalizationApplied),
    sourceFields: Array.isArray(candidate.sourceFields) ? candidate.sourceFields : [],
  } : null;
}

function publicPreview(preview) {
  return {
    recipient: preview.recipient,
    from: preview.from,
    replyTo: preview.replyTo,
    subject: preview.subject,
    text: preview.text,
    draftId: preview.draftId,
    draftVersion: preview.draftVersion,
    attachmentSummary: preview.attachmentSummary,
    attachmentBundleHash: preview.attachmentBundleHash,
    previewRevision: preview.previewRevision,
    smtpConfigurationRevision: Number(preview.smtpConfigurationRevision || 0),
    smtpConfigurationFingerprint: String(preview.smtpConfigurationFingerprint || ''),
    warnings: preview.warnings || [],
    readiness: preview.readiness,
    estimatedMessageSize: preview.estimatedMessageSize,
  };
}

function contactBlockerCode(resolution) {
  if (resolution?.status === 'no_email') return 'APPLICATION_EMAIL_NOT_FOUND';
  if (resolution?.collectionStatus !== 'complete') return 'APPLICATION_COMMENTS_INCOMPLETE';
  if (resolution?.candidates?.length > 1) return 'APPLICATION_EMAIL_AMBIGUOUS';
  return 'APPLICATION_EMAIL_REVIEW_REQUIRED';
}

function contactBlockerMessage(resolution) {
  if (resolution?.status === 'no_email') return '正文、图片及已完整采集的同帖评论中均未发现明确邮箱。';
  if (resolution?.collectionStatus !== 'complete') return '评论采集未完成，当前不判定为没有邮箱。';
  if (resolution?.candidates?.length > 1) return '发现多个冲突邮箱，请逐项核对证据后确认。';
  if (resolution?.candidates?.[0]?.source === 'author_comment') return '发现帖主评论邮箱，需核对证据后确认。';
  if (resolution?.candidates?.length) return '发现评论邮箱，但归属需要人工核验。';
  return '邮箱来源尚未达到自动发送条件。';
}

function attachmentRuleCode(rule) {
  if (rule.status === 'missing_fields') return 'APPLICATION_ATTACHMENT_FIELDS_MISSING';
  if (rule.status === 'extension_mismatch') return 'APPLICATION_ATTACHMENT_EXTENSION_MISMATCH';
  return 'APPLICATION_ATTACHMENT_NAME_INVALID';
}

function attachmentRuleMessage(rule) {
  if (rule.status === 'missing_fields') return `附件命名缺少字段：${rule.missingFields.join('、')}`;
  if (rule.status === 'extension_mismatch') return '帖子要求的扩展名与原附件扩展名不一致。';
  return '附件发送名不符合确定性安全规则。';
}

function previewBlockStatus(error) {
  const code = String(error?.code || '');
  if (code.startsWith('ATTACHMENT_')) return 'filename_pending';
  if (code.includes('DRAFT')) return 'draft_pending';
  return 'quality_pending';
}

function countPreflightStatuses(items) {
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

function isKnownNotSent(error) {
  if (error?.deliveryStatus === 'unknown' || error?.safeToRetry === false) return false;
  return error?.deliveryStatus === 'not_sent'
    || error?.safeToRetry === true
    || RETRYABLE_CODES.has(String(error?.code || ''));
}

function optionalRevision(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredRevision(value);
}

function requiredRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw batchServiceError('APPLICATION_BATCH_REVISION_REQUIRED', 'A current positive batch revision is required.');
  }
  return revision;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizedText(value, maxLength) {
  return String(value || '').normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}

function publicErrorMessage(error) {
  return normalizedText(error?.message, 1_000) || 'The operation did not complete.';
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function hashJson(value) {
  return sha256(JSON.stringify(value));
}

function batchServiceError(code, message, status = 400, details = undefined) {
  return new ApplicationBatchServiceError(code, message, status, details);
}
