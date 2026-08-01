import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { copyFile, link, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import Busboy from 'busboy';

const MANIFEST_SCHEMA_VERSION = 1;
const NOTE_ID = /^[\p{L}\p{N}_.:-]{1,160}$/u;
const ATTACHMENT_ID = /^[a-f0-9-]{36}$/u;
const SEND_ID = /^[a-f0-9-]{36}$/u;
const ALLOWED_SOURCES = new Set([
  'uploaded',
  'candidate_profile',
  'job_artifact',
  'generated_cover_letter',
  'generated_resume',
]);
const TYPE_BY_EXTENSION = Object.freeze({
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
});
const applicationLockContext = new AsyncLocalStorage();
const APPLICATION_LOCK_RETRY_MS = 25;
const APPLICATION_LOCK_TIMEOUT_MS = 30_000;
const APPLICATION_LOCK_STALE_MS = 5 * 60_000;

export const DEFAULT_ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 5,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
});

export class AttachmentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
    this.status = status;
  }
}

export function attachmentLimits(config = {}) {
  return {
    maxFiles: boundedLimit(config.attachmentMaxFiles, DEFAULT_ATTACHMENT_LIMITS.maxFiles, 1, 20),
    maxFileBytes: boundedLimit(config.attachmentMaxFileBytes, DEFAULT_ATTACHMENT_LIMITS.maxFileBytes, 1024, 64 * 1024 * 1024),
    maxTotalBytes: boundedLimit(config.attachmentMaxTotalBytes, DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes, 1024, 128 * 1024 * 1024),
  };
}

export async function readApplicationAttachmentUpload(req, limits) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data\s*;/iu.test(contentType)) {
    throw new AttachmentError('ATTACHMENT_MULTIPART_REQUIRED', 'Upload must use multipart/form-data.');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let fileSeen = false;
    let fileValue = null;
    const fields = {};
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { files: 1, fields: 12, fileSize: limits.maxFileBytes + 1, parts: 14 },
      });
    } catch {
      finish(new AttachmentError('ATTACHMENT_MULTIPART_INVALID', 'Multipart upload is invalid.'));
      return;
    }
    parser.on('field', (name, value) => {
      if (value.length <= 500) fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (name !== 'file' || fileSeen) {
        stream.resume();
        return;
      }
      fileSeen = true;
      const chunks = [];
      let size = 0;
      let limited = false;
      stream.on('limit', () => { limited = true; });
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size <= limits.maxFileBytes + 1) chunks.push(chunk);
      });
      stream.on('end', () => {
        if (limited || size > limits.maxFileBytes) {
          finish(new AttachmentError('ATTACHMENT_TOO_LARGE', `Attachment exceeds ${limits.maxFileBytes} bytes.`, 413));
          return;
        }
        fileValue = {
          originalName: info.filename,
          clientMediaType: info.mimeType,
          buffer: Buffer.concat(chunks),
        };
      });
    });
    parser.on('filesLimit', () => finish(new AttachmentError('ATTACHMENT_LIMIT_EXCEEDED', 'Only one file may be uploaded per request.')));
    parser.on('partsLimit', () => finish(new AttachmentError('ATTACHMENT_MULTIPART_INVALID', 'Multipart upload has too many parts.')));
    parser.on('error', () => finish(new AttachmentError('ATTACHMENT_MULTIPART_INVALID', 'Multipart upload is invalid.')));
    parser.on('close', () => {
      if (!fileValue) return finish(new AttachmentError('ATTACHMENT_EMPTY', 'Attachment file is required.'));
      finish(null, { fields, file: fileValue });
    });
    req.pipe(parser);
  });
}

export async function listApplicationAttachments(outputDir, noteId, limits = DEFAULT_ATTACHMENT_LIMITS) {
  assertNoteId(noteId);
  return withApplicationDeliveryLock(outputDir, async () => {
    const manifest = await readManifest(outputDir);
    const readyAttachments = manifest.attachments
      .filter((item) => item.noteId === noteId && item.status === 'ready');
    let manifestChanged = false;
    const validatedAt = new Date().toISOString();
    for (const attachment of readyAttachments) {
      const failure = await readyAttachmentValidationFailure(outputDir, attachment);
      if (!failure) continue;
      attachment.status = failure.status;
      attachment.selected = false;
      attachment.validationStatus = 'failed';
      attachment.validationError = failure.message;
      attachment.updatedAt = validatedAt;
      manifestChanged = true;
    }
    if (manifestChanged) await writeManifest(outputDir, manifest);
    const attachments = manifest.attachments
      .filter((item) => item.noteId === noteId && item.status !== 'deleted')
      .map(publicAttachment);
    return {
      schemaVersion: manifest.schemaVersion,
      revision: manifest.revision,
      noteId,
      attachments,
      selectedSummary: summarize(attachments.filter((item) => item.selected && item.status === 'ready')),
      limits,
    };
  });
}

async function readyAttachmentValidationFailure(outputDir, attachment) {
  try {
    await readVerifiedAttachmentFile(outputDir, attachment);
    return null;
  } catch (error) {
    if (error?.code === 'ATTACHMENT_NOT_FOUND' || error?.code === 'ENOENT') {
      return { status: 'missing', message: 'Attachment file is missing.' };
    }
    if (
      error?.code === 'ATTACHMENT_SIGNATURE_MISMATCH'
      || error?.code === 'ATTACHMENT_PATH_INVALID'
    ) {
      return { status: 'invalid', message: 'Attachment file failed integrity validation.' };
    }
    throw error;
  }
}

export async function createApplicationAttachment(outputDir, value, limits = DEFAULT_ATTACHMENT_LIMITS) {
  assertNoteId(value.noteId);
  const source = ALLOWED_SOURCES.has(value.source) ? value.source : 'uploaded';
  const originalName = normalizeFileName(value.file?.originalName);
  const buffer = value.file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AttachmentError('ATTACHMENT_EMPTY', 'Attachment is empty.');
  }
  if (buffer.length > limits.maxFileBytes) {
    throw new AttachmentError('ATTACHMENT_TOO_LARGE', `Attachment exceeds ${limits.maxFileBytes} bytes.`, 413);
  }
  const extension = path.extname(originalName).toLowerCase();
  const mediaType = TYPE_BY_EXTENSION[extension];
  if (!mediaType) throw new AttachmentError('ATTACHMENT_TYPE_NOT_ALLOWED', 'Attachment type is not allowed.');
  if (String(value.file.clientMediaType || '').toLowerCase() !== mediaType) {
    throw new AttachmentError('ATTACHMENT_SIGNATURE_MISMATCH', 'Attachment MIME type does not match its extension.');
  }
  assertMagicBytes(extension, buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  return withApplicationDeliveryLock(outputDir, async () => {
    const manifest = await readManifest(outputDir);
    const previousBundleHash = selectedBundleHashFromManifest(manifest, value.noteId);
    const active = manifest.attachments.filter((item) => item.noteId === value.noteId && item.status !== 'deleted');
    const duplicate = active.find((item) => item.sha256 === sha256 && item.status === 'ready');
    if (duplicate) {
      return {
        attachment: publicAttachment(duplicate),
        duplicate: true,
        revision: manifest.revision,
        noteId: value.noteId,
        attachmentBundleChanged: false,
        attachmentBundleHash: previousBundleHash,
      };
    }
    const selected = active.filter((item) => item.status === 'ready' && item.selected);
    if (value.selected !== false && selected.length >= limits.maxFiles) {
      throw new AttachmentError('ATTACHMENT_LIMIT_EXCEEDED', `A message may contain at most ${limits.maxFiles} attachments.`);
    }
    const selectedBytes = selected.reduce((sum, item) => sum + Number(item.size || 0), 0);
    if (value.selected !== false && selectedBytes + buffer.length > limits.maxTotalBytes) {
      throw new AttachmentError('ATTACHMENT_TOTAL_TOO_LARGE', `Attachments exceed ${limits.maxTotalBytes} bytes.`, 413);
    }
    const attachmentId = randomUUID();
    const relativePath = path.posix.join('application-attachments', value.noteId, `${attachmentId}${extension}`);
    const absolutePath = resolveStoredPath(outputDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const temporary = `${absolutePath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, buffer, { flag: 'wx' });
      await rename(temporary, absolutePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    const now = new Date().toISOString();
    const attachment = {
      attachmentId,
      jobId: String(value.jobId || ''),
      noteId: value.noteId,
      originalName,
      displayName: normalizeDisplayName(value.displayName || originalName, extension),
      extension: extension.slice(1),
      mediaType,
      size: buffer.length,
      sha256,
      source,
      relativePath,
      createdAt: now,
      updatedAt: now,
      status: 'ready',
      validationStatus: 'passed',
      validationError: '',
      selected: value.selected !== false,
      generatedFrom: String(value.generatedFrom || ''),
      draftId: String(value.draftId || ''),
      draftVersion: Number(value.draftVersion || 0),
    };
    manifest.attachments.push(attachment);
    try {
      await writeManifest(outputDir, manifest);
    } catch (error) {
      await rm(absolutePath, { force: true }).catch(() => {});
      throw error;
    }
    const attachmentBundleHash = selectedBundleHashFromManifest(manifest, value.noteId);
    return {
      attachment: publicAttachment(attachment),
      duplicate: false,
      revision: manifest.revision,
      noteId: value.noteId,
      attachmentBundleChanged: previousBundleHash !== attachmentBundleHash,
      attachmentBundleHash,
    };
  });
}

export async function updateApplicationAttachment(outputDir, attachmentId, value, limits = DEFAULT_ATTACHMENT_LIMITS) {
  assertAttachmentId(attachmentId);
  return withApplicationDeliveryLock(outputDir, async () => {
    const manifest = await readManifest(outputDir);
    const attachment = manifest.attachments.find((item) => item.attachmentId === attachmentId && item.status !== 'deleted');
    if (!attachment) throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'Attachment was not found.', 404);
    const previousBundleHash = selectedBundleHashFromManifest(manifest, attachment.noteId);
    if (Object.hasOwn(value || {}, 'displayName')) {
      attachment.displayName = normalizeDisplayName(value.displayName, `.${attachment.extension}`);
    }
    if (Object.hasOwn(value || {}, 'selected')) attachment.selected = value.selected === true;
    const selected = manifest.attachments.filter((item) => item.noteId === attachment.noteId && item.status === 'ready' && item.selected);
    if (selected.length > limits.maxFiles) throw new AttachmentError('ATTACHMENT_LIMIT_EXCEEDED', 'Too many selected attachments.');
    if (selected.reduce((sum, item) => sum + item.size, 0) > limits.maxTotalBytes) {
      throw new AttachmentError('ATTACHMENT_TOTAL_TOO_LARGE', 'Selected attachments exceed the total size limit.', 413);
    }
    attachment.updatedAt = new Date().toISOString();
    await writeManifest(outputDir, manifest);
    const attachmentBundleHash = selectedBundleHashFromManifest(manifest, attachment.noteId);
    return {
      attachment: publicAttachment(attachment),
      revision: manifest.revision,
      noteId: attachment.noteId,
      attachmentBundleChanged: previousBundleHash !== attachmentBundleHash,
      attachmentBundleHash,
    };
  });
}

export async function deleteApplicationAttachment(outputDir, attachmentId) {
  assertAttachmentId(attachmentId);
  return withApplicationDeliveryLock(outputDir, async () => {
    const manifest = await readManifest(outputDir);
    const attachment = manifest.attachments.find((item) => item.attachmentId === attachmentId && item.status !== 'deleted');
    if (!attachment) throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'Attachment was not found.', 404);
    const previousBundleHash = selectedBundleHashFromManifest(manifest, attachment.noteId);
    const absolutePath = resolveStoredPath(outputDir, attachment.relativePath);
    const tombstonePath = `${absolutePath}.${process.pid}-${randomUUID()}.deleted`;
    let moved = false;
    try {
      await rename(absolutePath, tombstonePath);
      moved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    attachment.status = 'deleted';
    attachment.selected = false;
    attachment.updatedAt = new Date().toISOString();
    try {
      await writeManifest(outputDir, manifest);
    } catch (error) {
      if (moved) await rename(tombstonePath, absolutePath).catch(() => {});
      throw error;
    }
    if (moved) await rm(tombstonePath, { force: true });
    const attachmentBundleHash = selectedBundleHashFromManifest(manifest, attachment.noteId);
    return {
      attachmentId,
      noteId: attachment.noteId,
      deleted: true,
      revision: manifest.revision,
      attachmentBundleChanged: previousBundleHash !== attachmentBundleHash,
      attachmentBundleHash,
    };
  });
}

export async function resolveApplicationAttachments(outputDir, noteId, attachmentIds, limits = DEFAULT_ATTACHMENT_LIMITS) {
  assertNoteId(noteId);
  return withApplicationDeliveryLock(outputDir, () => resolveApplicationAttachmentsUnlocked(
    outputDir,
    noteId,
    attachmentIds,
    limits,
  ));
}

export async function resolveSelectedApplicationAttachments(outputDir, noteId, attachmentIds, limits = DEFAULT_ATTACHMENT_LIMITS) {
  assertNoteId(noteId);
  return withApplicationDeliveryLock(outputDir, async () => {
    if (attachmentIds !== undefined) {
      return resolveApplicationAttachmentsUnlocked(outputDir, noteId, attachmentIds, limits);
    }
    const manifest = await readManifest(outputDir);
    const selectedIds = manifest.attachments
      .filter((item) => item.noteId === noteId && item.status === 'ready' && item.selected)
      .map((item) => item.attachmentId);
    return resolveApplicationAttachmentsUnlocked(outputDir, noteId, selectedIds, limits, manifest);
  });
}

async function resolveApplicationAttachmentsUnlocked(
  outputDir,
  noteId,
  attachmentIds,
  limits = DEFAULT_ATTACHMENT_LIMITS,
  suppliedManifest = null,
) {
  const ids = attachmentIds === undefined
    ? []
    : [...new Set(Array.isArray(attachmentIds) ? attachmentIds.map(String) : [])];
  if (attachmentIds !== undefined && !Array.isArray(attachmentIds)) {
    throw new AttachmentError('ATTACHMENT_INVALID_SELECTION', 'attachmentIds must be an array.');
  }
  if (ids.length > limits.maxFiles) throw new AttachmentError('ATTACHMENT_LIMIT_EXCEEDED', 'Too many attachments selected.');
  ids.forEach(assertAttachmentId);
  const manifest = suppliedManifest || await readManifest(outputDir);
  const resolved = [];
  for (const id of ids) {
    const attachment = manifest.attachments.find((item) => item.attachmentId === id && item.noteId === noteId && item.status === 'ready');
    if (!attachment || attachment.validationStatus !== 'passed') {
      throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'A selected attachment is unavailable.', 404);
    }
    const verified = await readVerifiedAttachmentFile(outputDir, attachment);
    resolved.push({ ...attachment, absolutePath: verified.absolutePath });
  }
  const totalBytes = resolved.reduce((sum, item) => sum + item.size, 0);
  if (totalBytes > limits.maxTotalBytes) throw new AttachmentError('ATTACHMENT_TOTAL_TOO_LARGE', 'Selected attachments exceed the total size limit.', 413);
  const snapshots = resolved.map(attachmentSnapshot);
  const attachmentBundleHash = hashAttachmentBundle(snapshots);
  return {
    attachments: resolved,
    snapshots,
    attachmentBundleHash,
    summary: { count: snapshots.length, totalBytes, attachments: snapshots },
  };
}

export async function resolveApplicationAttachmentDownload(outputDir, attachmentId) {
  assertAttachmentId(attachmentId);
  return withApplicationDeliveryLock(outputDir, async () => {
    const manifest = await readManifest(outputDir);
    const attachment = manifest.attachments.find((item) => item.attachmentId === attachmentId && item.status === 'ready');
    if (!attachment) throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'Attachment was not found.', 404);
    const verified = await readVerifiedAttachmentFile(outputDir, attachment);
    return {
      absolutePath: verified.absolutePath,
      size: verified.buffer.length,
      attachment: publicAttachment(attachment),
      stream: () => Readable.from(verified.buffer),
    };
  });
}

export function buildEmailPreview(value) {
  const previewRevision = createHash('sha256').update(JSON.stringify([
    'application-email-preview:v2',
    value.noteId,
    value.recipient,
    value.from || '',
    value.replyTo || '',
    value.subject,
    value.text,
    value.draftId,
    value.draftVersion,
    value.contentHash,
    value.attachmentBundleHash,
    Number(value.smtpConfigurationRevision || 0),
    String(value.smtpConfigurationFingerprint || ''),
    value.quality?.qualityReportRef || '',
    value.quality?.qualityStatus || '',
    value.quality?.qualityCheckedHash || '',
  ])).digest('hex');
  const attachmentBytes = value.attachmentSummary.totalBytes;
  return {
    recipient: value.recipient,
    from: value.from || '',
    replyTo: value.replyTo || '',
    subject: value.subject,
    text: value.text,
    htmlPreview: `<p>${escapeHtml(value.text).replaceAll('\n', '<br>')}</p>`,
    draftId: value.draftId,
    draftVersion: value.draftVersion,
    quality: value.quality || null,
    smtp: value.smtp || null,
    attachmentSummary: value.attachmentSummary,
    attachmentBundleHash: value.attachmentBundleHash,
    previewRevision,
    smtpConfigurationRevision: Number(value.smtpConfigurationRevision || 0),
    smtpConfigurationFingerprint: String(value.smtpConfigurationFingerprint || ''),
    warnings: value.warnings || [],
    readiness: (value.warnings || []).some((item) => item.blocking) ? 'blocked' : 'ready',
    estimatedMessageSize: Buffer.byteLength(`${value.subject}\n${value.text}`, 'utf8') + Math.ceil(attachmentBytes * 4 / 3),
  };
}

export async function prepareSendBundle(outputDir, value) {
  const sendId = randomUUID();
  const root = path.join(outputDir, 'application-attachments', 'send-bundles');
  const temporaryDir = path.join(root, `.${sendId}.${process.pid}.tmp`);
  await mkdir(path.join(temporaryDir, 'attachments'), { recursive: true });
  const mailAttachments = [];
  try {
    for (const attachment of value.attachments) {
      const storedName = `${attachment.attachmentId}.${attachment.extension}`;
      const target = path.join(temporaryDir, 'attachments', storedName);
      await copyFile(attachment.absolutePath, target);
      const copied = await readFile(target);
      const copiedHash = createHash('sha256').update(copied).digest('hex');
      if (copied.length !== Number(attachment.size) || copiedHash !== attachment.sha256) {
        throw new AttachmentError(
          'ATTACHMENT_SIGNATURE_MISMATCH',
          'A selected attachment changed while the immutable send bundle was being prepared.',
          409,
        );
      }
      mailAttachments.push({ filename: attachment.displayName, path: target, contentType: attachment.mediaType });
    }
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
  return { sendId, root, temporaryDir, finalDir: path.join(root, sendId), mailAttachments };
}

export async function sealPreparedSendBundle(bundle, value) {
  const manifest = sendBundleManifest(bundle, { ...value, status: 'prepared' });
  await writeFile(
    path.join(bundle.temporaryDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    { encoding: 'utf8', flag: 'wx' },
  );
  await mkdir(bundle.root, { recursive: true });
  await rename(bundle.temporaryDir, bundle.finalDir);
  bundle.mailAttachments = bundle.mailAttachments.map((item) => ({
    ...item,
    path: path.join(bundle.finalDir, path.relative(bundle.temporaryDir, item.path)),
  }));
  bundle.sealed = true;
  return manifest;
}

export async function finalizeSendBundle(bundle, value) {
  if (bundle.sealed) {
    const outcome = {
      schemaVersion: 1,
      sendId: bundle.sendId,
      status: value.status,
      completedAt: value.sentAt || value.failedAt || new Date().toISOString(),
      sentAt: value.sentAt || null,
      messageId: value.messageId || '',
      errorCode: String(value.errorCode || ''),
    };
    const outcomePath = path.join(bundle.finalDir, 'outcome.json');
    try {
      await writeFile(outcomePath, JSON.stringify(outcome, null, 2), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(outcomePath, 'utf8'));
      if (JSON.stringify(existing) !== JSON.stringify(outcome)) {
        throw new AttachmentError(
          'ATTACHMENT_SEND_BUNDLE_CONFLICT',
          'The immutable send bundle already contains a different outcome.',
          409,
        );
      }
    }
    const prepared = JSON.parse(await readFile(path.join(bundle.finalDir, 'manifest.json'), 'utf8'));
    return { ...prepared, ...outcome };
  }
  const manifest = sendBundleManifest(bundle, value);
  await writeFile(path.join(bundle.temporaryDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
  await mkdir(bundle.root, { recursive: true });
  await rename(bundle.temporaryDir, bundle.finalDir);
  return manifest;
}

function sendBundleManifest(bundle, value) {
  return {
    schemaVersion: 1,
    sendId: bundle.sendId,
    status: value.status,
    noteId: value.noteId,
    recipient: value.recipient,
    draftId: value.draftId,
    draftVersion: value.draftVersion,
    contentHash: value.contentHash,
    attachmentBundleHash: value.attachmentBundleHash,
    attachmentIds: value.attachments.map((item) => item.attachmentId),
    attachments: value.attachments.map(attachmentSnapshot),
    preparedAt: value.preparedAt,
    sentAt: value.sentAt || null,
    messageId: value.messageId || '',
    smtpConfigurationRevision: Number(value.smtpConfigurationRevision || 0),
    smtpConfigurationFingerprint: String(value.smtpConfigurationFingerprint || ''),
    idempotencyKey: String(value.idempotencyKey || ''),
    requestIdempotencyKey: String(value.requestIdempotencyKey || ''),
    recipientHash: String(value.recipientHash || ''),
    attachmentCount: Number(value.attachmentCount ?? value.attachments.length),
    attachmentBytes: Number(value.attachmentBytes || 0),
    previewRevision: String(value.previewRevision || ''),
    qualityReportRef: value.qualityReportRef || null,
  };
}

export async function readFinalizedSendBundle(outputDir, sendId) {
  if (!SEND_ID.test(String(sendId || ''))) return null;
  const manifestFile = path.join(outputDir, 'application-attachments', 'send-bundles', sendId, 'manifest.json');
  try {
    const parsed = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (!parsed || parsed.schemaVersion !== 1 || parsed.sendId !== sendId) {
      throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'The immutable send bundle manifest is invalid.', 500);
    }
    await verifySendBundleFiles(path.dirname(manifestFile), parsed);
    if (parsed.status !== 'prepared') return parsed;
    try {
      const outcome = JSON.parse(await readFile(path.join(path.dirname(manifestFile), 'outcome.json'), 'utf8'));
      if (
        !outcome
        || outcome.schemaVersion !== 1
        || outcome.sendId !== sendId
        || !['sent', 'failed', 'unknown'].includes(String(outcome.status || ''))
      ) {
        throw new Error('invalid send bundle outcome');
      }
      return {
        ...parsed,
        status: outcome.status,
        completedAt: String(outcome.completedAt || ''),
        sentAt: outcome.sentAt || null,
        messageId: String(outcome.messageId || ''),
        errorCode: String(outcome.errorCode || ''),
      };
    } catch (error) {
      if (error.code === 'ENOENT') return parsed;
      throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'The immutable send bundle outcome is invalid.', 500);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof AttachmentError) throw error;
    if (error instanceof SyntaxError) {
      throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'The immutable send bundle manifest is invalid.', 500);
    }
    throw error;
  }
}

async function verifySendBundleFiles(bundleDir, manifest) {
  if (!Array.isArray(manifest.attachments) || !Array.isArray(manifest.attachmentIds)) {
    throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'The immutable send bundle attachment index is invalid.', 500);
  }
  if (
    manifest.attachmentIds.length !== manifest.attachments.length
    || manifest.attachments.some((item, index) => item?.attachmentId !== manifest.attachmentIds[index])
    || hashAttachmentBundle(manifest.attachments) !== manifest.attachmentBundleHash
  ) {
    throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'The immutable send bundle attachment identity is invalid.', 500);
  }
  const realBundleDir = await realpath(bundleDir);
  for (const attachment of manifest.attachments) {
    const extension = path.extname(String(attachment.filename || '')).toLowerCase();
    if (!ATTACHMENT_ID.test(String(attachment.attachmentId || '')) || !TYPE_BY_EXTENSION[extension]) {
      throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'The immutable send bundle contains invalid attachment metadata.', 500);
    }
    const target = path.join(bundleDir, 'attachments', `${attachment.attachmentId}${extension}`);
    let details;
    try {
      details = await lstat(target);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'An immutable send bundle attachment is missing.', 500);
      }
      throw error;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'An immutable send bundle attachment is not a regular file.', 500);
    }
    const realTarget = await realpath(target);
    const relative = path.relative(realBundleDir, realTarget);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'An immutable send bundle attachment path is invalid.', 500);
    }
    const buffer = await readFile(realTarget);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (
      details.size !== Number(attachment.size)
      || buffer.length !== Number(attachment.size)
      || sha256 !== attachment.sha256
    ) {
      throw new AttachmentError('ATTACHMENT_SEND_BUNDLE_INVALID', 'An immutable send bundle attachment was modified.', 500);
    }
  }
}

export async function discardSendBundle(bundle) {
  if (bundle?.temporaryDir) await rm(bundle.temporaryDir, { recursive: true, force: true });
  if (bundle?.sealed && bundle?.finalDir) await rm(bundle.finalDir, { recursive: true, force: true });
}

export function hashAttachmentBundle(snapshots) {
  const canonical = [...snapshots]
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId))
    .map((item) => [item.attachmentId, item.filename, item.mediaType, item.size, item.sha256]);
  return createHash('sha256').update(`application-attachments:v1\n${JSON.stringify(canonical)}`, 'utf8').digest('hex');
}

function selectedBundleHashFromManifest(manifest, noteId) {
  return hashAttachmentBundle(
    manifest.attachments
      .filter((item) => item.noteId === noteId && item.status === 'ready' && item.selected)
      .map(attachmentSnapshot),
  );
}

function attachmentSnapshot(item) {
  return {
    attachmentId: item.attachmentId,
    filename: item.displayName,
    mediaType: item.mediaType,
    size: item.size,
    sha256: item.sha256,
  };
}

function publicAttachment(item) {
  const { relativePath: _relativePath, ...value } = item;
  return { ...value };
}

function summarize(attachments) {
  return { count: attachments.length, totalBytes: attachments.reduce((sum, item) => sum + Number(item.size || 0), 0) };
}

async function readManifest(outputDir) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(outputDir), 'utf8'));
    if (!parsed || parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(parsed.attachments)) throw new Error('invalid');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: MANIFEST_SCHEMA_VERSION, revision: 0, attachments: [], updatedAt: null };
    throw new AttachmentError('ATTACHMENT_MANIFEST_INVALID', 'Attachment manifest is invalid.', 500);
  }
}

async function writeManifest(outputDir, manifest) {
  const root = path.dirname(manifestPath(outputDir));
  await mkdir(root, { recursive: true });
  const current = await readManifest(outputDir);
  const expectedRevision = Math.max(0, Number(manifest.revision || 0));
  const actualRevision = Math.max(0, Number(current.revision || 0));
  if (expectedRevision !== actualRevision) {
    throw new AttachmentError(
      'ATTACHMENT_MANIFEST_REVISION_CONFLICT',
      `Attachment manifest revision conflict: expected ${expectedRevision}, found ${actualRevision}.`,
      409,
    );
  }
  const persisted = {
    ...manifest,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    revision: actualRevision + 1,
    updatedAt: new Date().toISOString(),
  };
  const target = manifestPath(outputDir);
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
  manifest.schemaVersion = persisted.schemaVersion;
  manifest.revision = persisted.revision;
  manifest.updatedAt = persisted.updatedAt;
}

function manifestPath(outputDir) {
  return path.join(outputDir, 'application-attachments', 'manifest.json');
}

function resolveStoredPath(outputDir, relativePath) {
  const root = path.resolve(outputDir);
  const target = path.resolve(root, ...String(relativePath).split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AttachmentError('ATTACHMENT_PATH_INVALID', 'Attachment path is invalid.');
  }
  return target;
}

async function readVerifiedAttachmentFile(outputDir, attachment) {
  const absolutePath = resolveStoredPath(outputDir, attachment.relativePath);
  let details;
  try {
    details = await lstat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'Attachment file is missing.', 404);
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new AttachmentError('ATTACHMENT_SIGNATURE_MISMATCH', 'Attachment storage entry is not a regular file.', 409);
  }
  const [realRoot, realTarget] = await Promise.all([
    realpath(outputDir),
    realpath(absolutePath),
  ]);
  const expectedTarget = path.resolve(realRoot, ...String(attachment.relativePath).split('/'));
  const relative = path.relative(realRoot, realTarget);
  if (
    realTarget !== expectedTarget
    || !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
  ) {
    throw new AttachmentError('ATTACHMENT_PATH_INVALID', 'Attachment storage path resolves outside its Job.', 409);
  }
  const buffer = await readFile(realTarget);
  if (details.size !== Number(attachment.size) || buffer.length !== Number(attachment.size)) {
    throw new AttachmentError('ATTACHMENT_SIGNATURE_MISMATCH', 'Attachment size no longer matches its manifest.', 409);
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== attachment.sha256) {
    throw new AttachmentError('ATTACHMENT_SIGNATURE_MISMATCH', 'Attachment checksum no longer matches its manifest.', 409);
  }
  return { absolutePath: realTarget, buffer };
}

function normalizeFileName(value) {
  const original = String(value || '').normalize('NFC').trim();
  if (!original || original !== path.basename(original) || original !== path.win32.basename(original) || /[\p{Cc}<>:"/\\|?*]/u.test(original)) {
    throw new AttachmentError('ATTACHMENT_PATH_INVALID', 'Attachment filename is invalid.');
  }
  const normalized = original.replace(/[. ]+$/u, '').slice(0, 180);
  if (!normalized || !path.extname(normalized)) throw new AttachmentError('ATTACHMENT_TYPE_NOT_ALLOWED', 'Attachment type is not allowed.');
  return normalized;
}

function normalizeDisplayName(value, extension) {
  const name = String(value || '').normalize('NFC').trim().replace(/[\p{Cc}<>:"/\\|?*]/gu, '').replace(/[. ]+$/u, '').slice(0, 180);
  if (!name) throw new AttachmentError('ATTACHMENT_PATH_INVALID', 'Attachment display name is invalid.');
  return path.extname(name).toLowerCase() === extension.toLowerCase() ? name : `${name}${extension}`;
}

function assertMagicBytes(extension, buffer) {
  const matches = extension === '.pdf'
    ? buffer.subarray(0, 5).toString('ascii') === '%PDF-'
    : extension === '.doc'
      ? buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
      : extension === '.docx'
        ? buffer.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))
          && buffer.includes(Buffer.from('[Content_Types].xml'))
          && buffer.includes(Buffer.from('word/'))
        : extension === '.png'
          ? buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          : ['.jpg', '.jpeg'].includes(extension)
            ? buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
            : extension === '.txt'
              ? isPlainText(buffer)
              : false;
  if (!matches) throw new AttachmentError('ATTACHMENT_SIGNATURE_MISMATCH', 'Attachment content does not match its declared type.');
}

function isPlainText(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function assertNoteId(value) {
  if (!NOTE_ID.test(String(value || ''))) throw new AttachmentError('ATTACHMENT_PATH_INVALID', 'Invalid noteId.');
}

function assertAttachmentId(value) {
  if (!ATTACHMENT_ID.test(String(value || ''))) throw new AttachmentError('ATTACHMENT_PATH_INVALID', 'Invalid attachmentId.');
}

function boundedLimit(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export async function withApplicationDeliveryLock(outputDir, operation) {
  const key = path.resolve(outputDir);
  const held = applicationLockContext.getStore();
  if (held?.has(key)) return operation();
  const lock = await acquireApplicationLock(key);
  try {
    const next = new Set(held || []);
    next.add(key);
    return await applicationLockContext.run(next, operation);
  } finally {
    await releaseApplicationLock(lock);
  }
}

async function acquireApplicationLock(outputDir) {
  const lockPath = path.join(outputDir, '.application-delivery.lock');
  const token = randomUUID();
  const startedAt = Date.now();
  const metadata = {
    schemaVersion: 1,
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  };
  await mkdir(outputDir, { recursive: true });
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      return { lockPath, token };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') {
        if (handle) await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
      if (await reclaimStaleApplicationLock(lockPath)) continue;
      if (Date.now() - startedAt >= APPLICATION_LOCK_TIMEOUT_MS) {
        const timeout = new AttachmentError(
          'APPLICATION_DELIVERY_LOCK_TIMEOUT',
          'Timed out waiting for this Job delivery workspace lock.',
          409,
        );
        timeout.lockPath = lockPath;
        throw timeout;
      }
      await sleep(APPLICATION_LOCK_RETRY_MS);
    }
  }
}

async function releaseApplicationLock({ lockPath, token }) {
  const snapshot = await readApplicationLockSnapshot(lockPath);
  if (!snapshot || snapshot.metadata?.token !== token) return;
  await rm(lockPath, { force: true });
}

async function reclaimStaleApplicationLock(lockPath) {
  const observed = await readApplicationLockSnapshot(lockPath);
  if (!observed) return true;
  const ownerAlive = lockOwnerIsAlive(observed.metadata?.pid);
  if (ownerAlive !== false && (observed.metadata || observed.ageMs < APPLICATION_LOCK_STALE_MS)) return false;
  const quarantine = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  const moved = await readApplicationLockSnapshot(quarantine);
  if (!moved || moved.raw === observed.raw) {
    await rm(quarantine, { force: true }).catch(() => {});
    return true;
  }
  try {
    await link(quarantine, lockPath);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await rm(quarantine, { force: true }).catch(() => {});
  }
  return false;
}

async function readApplicationLockSnapshot(lockPath) {
  try {
    const [raw, details] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    let metadata = null;
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed?.schemaVersion === 1
        && Number.isInteger(Number(parsed.pid))
        && Number(parsed.pid) > 0
        && ATTACHMENT_ID.test(String(parsed.token || ''))
        && Number.isFinite(Date.parse(parsed.createdAt))
      ) {
        metadata = parsed;
      }
    } catch {
      // A process can terminate between exclusive creation and metadata flush.
    }
    const createdAt = Date.parse(metadata?.createdAt);
    return {
      raw,
      metadata,
      ageMs: Math.max(0, Date.now() - (Number.isFinite(createdAt) ? createdAt : details.mtimeMs)),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { raw: '', metadata: null, ageMs: 0 };
  }
}

function lockOwnerIsAlive(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return null;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
