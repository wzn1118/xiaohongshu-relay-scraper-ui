import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';

import {
  AttachmentError,
  buildEmailPreview,
  createApplicationAttachment,
  deleteApplicationAttachment,
  finalizeSendBundle,
  hashAttachmentBundle,
  listApplicationAttachments,
  prepareSendBundle,
  readFinalizedSendBundle,
  resolveApplicationAttachmentDownload,
  resolveApplicationAttachments,
  sealPreparedSendBundle,
  updateApplicationAttachment,
} from './lib/application-attachments.mjs';

const NOTE_ID = 'note-attachment-001';
const LIMITS = { maxFiles: 5, maxFileBytes: 1024, maxTotalBytes: 2048 };
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');
const DOCX = Buffer.concat([
  Buffer.from('504b0304', 'hex'),
  Buffer.from('[Content_Types].xml\nword/document.xml\nfixture', 'utf8'),
]);

async function fixtureDir(t) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-attachments-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  return outputDir;
}

async function waitForChild(child) {
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(code, 0, `child exited with code=${code} signal=${signal}: ${stderr}`);
}

function upload(file, overrides = {}) {
  return {
    jobId: 'job-001',
    noteId: NOTE_ID,
    source: 'uploaded',
    selected: true,
    file,
    ...overrides,
  };
}

test('PDF, DOCX, and UTF-8 filenames persist in a revisioned manifest', async (t) => {
  const outputDir = await fixtureDir(t);
  const pdf = await createApplicationAttachment(outputDir, upload({
    originalName: '中文简历.pdf', clientMediaType: 'application/pdf', buffer: PDF,
  }), LIMITS);
  const docx = await createApplicationAttachment(outputDir, upload({
    originalName: '作品说明.docx',
    clientMediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: DOCX,
  }), LIMITS);

  assert.equal(pdf.duplicate, false);
  assert.equal(docx.duplicate, false);
  const restored = await listApplicationAttachments(outputDir, NOTE_ID, LIMITS);
  assert.equal(restored.schemaVersion, 1);
  assert.equal(restored.revision, 2);
  assert.deepEqual(restored.attachments.map((item) => item.displayName), ['中文简历.pdf', '作品说明.docx']);
  assert.equal(restored.selectedSummary.totalBytes, PDF.length + DOCX.length);
  const manifest = JSON.parse(await readFile(path.join(outputDir, 'application-attachments', 'manifest.json'), 'utf8'));
  assert.equal(manifest.attachments.some((item) => path.isAbsolute(item.relativePath)), false);
});

test('invalid, empty, oversized, mismatched, and traversing uploads are rejected', async (t) => {
  const outputDir = await fixtureDir(t);
  const cases = [
    [upload({ originalName: 'empty.pdf', clientMediaType: 'application/pdf', buffer: Buffer.alloc(0) }), 'ATTACHMENT_EMPTY'],
    [upload({ originalName: 'large.txt', clientMediaType: 'text/plain', buffer: Buffer.alloc(1025, 65) }), 'ATTACHMENT_TOO_LARGE'],
    [upload({ originalName: 'resume.pdf', clientMediaType: 'text/plain', buffer: PDF }), 'ATTACHMENT_SIGNATURE_MISMATCH'],
    [upload({ originalName: 'script.js', clientMediaType: 'text/javascript', buffer: Buffer.from('alert(1)') }), 'ATTACHMENT_TYPE_NOT_ALLOWED'],
    [upload({ originalName: '../resume.pdf', clientMediaType: 'application/pdf', buffer: PDF }), 'ATTACHMENT_PATH_INVALID'],
    [upload({ originalName: 'fake.pdf', clientMediaType: 'application/pdf', buffer: Buffer.from('not-a-pdf') }), 'ATTACHMENT_SIGNATURE_MISMATCH'],
  ];
  for (const [value, code] of cases) {
    await assert.rejects(createApplicationAttachment(outputDir, value, LIMITS), (error) => {
      assert.ok(error instanceof AttachmentError);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test('duplicate upload is idempotent and deletion survives a fresh manifest read', async (t) => {
  const outputDir = await fixtureDir(t);
  const first = await createApplicationAttachment(outputDir, upload({
    originalName: 'resume.pdf', clientMediaType: 'application/pdf', buffer: PDF,
  }), LIMITS);
  const duplicate = await createApplicationAttachment(outputDir, upload({
    originalName: 'renamed.pdf', clientMediaType: 'application/pdf', buffer: PDF,
  }), LIMITS);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.attachment.attachmentId, first.attachment.attachmentId);
  assert.equal((await listApplicationAttachments(outputDir, NOTE_ID, LIMITS)).attachments.length, 1);

  await deleteApplicationAttachment(outputDir, first.attachment.attachmentId);
  const restored = await listApplicationAttachments(outputDir, NOTE_ID, LIMITS);
  assert.equal(restored.attachments.length, 0);
  assert.equal(restored.revision, 2);
  const noteFiles = await readdir(path.join(outputDir, 'application-attachments', NOTE_ID));
  assert.deepEqual(noteFiles, []);
});

test('listing persists a missing ready attachment and excludes it from the selected summary', async (t) => {
  const outputDir = await fixtureDir(t);
  const created = await createApplicationAttachment(outputDir, upload({
    originalName: 'resume.pdf', clientMediaType: 'application/pdf', buffer: PDF,
  }), LIMITS);
  const manifestPath = path.join(outputDir, 'application-attachments', 'manifest.json');
  const initialManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const storedPath = path.join(outputDir, ...initialManifest.attachments[0].relativePath.split('/'));
  await rm(storedPath);

  const listed = await listApplicationAttachments(outputDir, NOTE_ID, LIMITS);
  assert.equal(listed.revision, 2);
  assert.equal(listed.attachments[0].attachmentId, created.attachment.attachmentId);
  assert.equal(listed.attachments[0].status, 'missing');
  assert.equal(listed.attachments[0].selected, false);
  assert.equal(listed.attachments[0].validationStatus, 'failed');
  assert.equal(listed.attachments[0].validationError, 'Attachment file is missing.');
  assert.equal(listed.attachments[0].validationError.includes(outputDir), false);
  assert.deepEqual(listed.selectedSummary, { count: 0, totalBytes: 0 });

  const persisted = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.attachments[0].status, 'missing');
  assert.equal((await listApplicationAttachments(outputDir, NOTE_ID, LIMITS)).revision, 2);
});

test('listing persists a tampered ready attachment as invalid and excludes it from the selected summary', async (t) => {
  const outputDir = await fixtureDir(t);
  const created = await createApplicationAttachment(outputDir, upload({
    originalName: 'resume.pdf', clientMediaType: 'application/pdf', buffer: PDF,
  }), LIMITS);
  const manifestPath = path.join(outputDir, 'application-attachments', 'manifest.json');
  const initialManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const storedPath = path.join(outputDir, ...initialManifest.attachments[0].relativePath.split('/'));
  const tampered = Buffer.from(PDF);
  tampered[tampered.length - 2] ^= 1;
  await writeFile(storedPath, tampered);

  const listed = await listApplicationAttachments(outputDir, NOTE_ID, LIMITS);
  assert.equal(listed.revision, 2);
  assert.equal(listed.attachments[0].attachmentId, created.attachment.attachmentId);
  assert.equal(listed.attachments[0].status, 'invalid');
  assert.equal(listed.attachments[0].selected, false);
  assert.equal(listed.attachments[0].validationStatus, 'failed');
  assert.equal(listed.attachments[0].validationError, 'Attachment file failed integrity validation.');
  assert.equal(listed.attachments[0].validationError.includes(outputDir), false);
  assert.deepEqual(listed.selectedSummary, { count: 0, totalBytes: 0 });

  const persisted = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.attachments[0].status, 'invalid');
  assert.equal((await listApplicationAttachments(outputDir, NOTE_ID, LIMITS)).revision, 2);
});

test('attachment inventory may exceed five while the selected message bundle stays within limits', async (t) => {
  const outputDir = await fixtureDir(t);
  const created = [];
  for (let index = 0; index < LIMITS.maxFiles; index += 1) {
    created.push(await createApplicationAttachment(outputDir, upload({
      originalName: `attachment-${index}.txt`,
      clientMediaType: 'text/plain',
      buffer: Buffer.from(`attachment content ${index}`, 'utf8'),
    }), LIMITS));
  }

  await updateApplicationAttachment(
    outputDir,
    created[0].attachment.attachmentId,
    { selected: false },
    LIMITS,
  );
  const sixth = await createApplicationAttachment(outputDir, upload({
    originalName: 'attachment-5.txt',
    clientMediaType: 'text/plain',
    buffer: Buffer.from('attachment content 5', 'utf8'),
  }), LIMITS);
  const seventh = await createApplicationAttachment(outputDir, upload({
    originalName: 'attachment-6.txt',
    clientMediaType: 'text/plain',
    buffer: Buffer.from('attachment content 6', 'utf8'),
  }, { selected: false }), LIMITS);

  const listed = await listApplicationAttachments(outputDir, NOTE_ID, LIMITS);
  assert.equal(listed.attachments.length, 7);
  assert.equal(listed.selectedSummary.count, LIMITS.maxFiles);
  assert.equal(sixth.attachment.selected, true);
  assert.equal(seventh.attachment.selected, false);

  await assert.rejects(
    updateApplicationAttachment(outputDir, seventh.attachment.attachmentId, { selected: true }, LIMITS),
    (error) => error.code === 'ATTACHMENT_LIMIT_EXCEEDED',
  );
});

test('two Node processes update one attachment manifest without losing either file', async (t) => {
  const outputDir = await fixtureDir(t);
  const moduleUrl = new URL('./lib/application-attachments.mjs', import.meta.url).href;
  const script = `
    const { createApplicationAttachment } = await import(process.env.ATTACHMENT_MODULE_URL);
    await createApplicationAttachment(process.env.OUTPUT_DIR, {
      jobId: 'job-cross-process',
      noteId: process.env.NOTE_ID,
      source: 'uploaded',
      selected: true,
      file: {
        originalName: process.env.FILE_NAME,
        clientMediaType: 'text/plain',
        buffer: Buffer.from(process.env.FILE_CONTENT, 'utf8'),
      },
    }, { maxFiles: 5, maxFileBytes: 1024, maxTotalBytes: 2048 });
  `;
  const children = ['alpha', 'beta'].map((name) => spawn(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      env: {
        ...process.env,
        ATTACHMENT_MODULE_URL: moduleUrl,
        OUTPUT_DIR: outputDir,
        NOTE_ID,
        FILE_NAME: `${name}.txt`,
        FILE_CONTENT: `${name} attachment content`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  ));

  await Promise.all(children.map(waitForChild));
  const result = await listApplicationAttachments(outputDir, NOTE_ID, LIMITS);
  assert.equal(result.revision, 2);
  assert.deepEqual(result.attachments.map((item) => item.originalName).sort(), ['alpha.txt', 'beta.txt']);
});

test('attachment download rejects checksum tampering and symbolic-link replacement', async (t) => {
  const outputDir = await fixtureDir(t);
  const created = await createApplicationAttachment(outputDir, upload({
    originalName: 'resume.pdf', clientMediaType: 'application/pdf', buffer: PDF,
  }), LIMITS);
  const resolved = await resolveApplicationAttachments(outputDir, NOTE_ID, [created.attachment.attachmentId], LIMITS);
  const originalPath = resolved.attachments[0].absolutePath;
  const download = await resolveApplicationAttachmentDownload(outputDir, created.attachment.attachmentId);
  const downloaded = [];
  for await (const chunk of download.stream()) downloaded.push(chunk);
  assert.deepEqual(Buffer.concat(downloaded), PDF);

  const altered = Buffer.from(PDF);
  altered[altered.length - 2] ^= 1;
  await writeFile(originalPath, altered);
  await assert.rejects(
    resolveApplicationAttachmentDownload(outputDir, created.attachment.attachmentId),
    (error) => error.code === 'ATTACHMENT_SIGNATURE_MISMATCH',
  );

  await rm(originalPath);
  const replacement = path.join(outputDir, 'replacement.pdf');
  await writeFile(replacement, PDF);
  try {
    await symlink(replacement, originalPath, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`File symlinks are unavailable in this Windows environment: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    resolveApplicationAttachmentDownload(outputDir, created.attachment.attachmentId),
    (error) => error.code === 'ATTACHMENT_SIGNATURE_MISMATCH',
  );
});

test('preview revision binds sender identity, reply-to, and the full SMTP configuration', () => {
  const input = {
    noteId: NOTE_ID,
    recipient: 'jobs@example.test',
    from: 'sender@example.test',
    replyTo: 'candidate@example.test',
    subject: 'Application',
    text: 'Please see the application.',
    draftId: 'draft-1',
    draftVersion: 1,
    contentHash: 'content-hash',
    quality: {
      qualityReportRef: 'application_intelligence.json#/records/0/cover_letter_evaluation',
      qualityStatus: 'passed',
      qualityCheckedHash: 'content-hash',
    },
    attachmentSummary: { count: 0, totalBytes: 0, attachments: [] },
    attachmentBundleHash: hashAttachmentBundle([]),
    smtpConfigurationRevision: 7,
    smtpConfigurationFingerprint: 'smtp-fingerprint-7',
    warnings: [],
  };
  const preview = buildEmailPreview(input);

  for (const changed of [
    { from: 'other@example.test' },
    { replyTo: 'other-candidate@example.test' },
    { smtpConfigurationRevision: 8 },
    { smtpConfigurationFingerprint: 'smtp-fingerprint-8' },
  ]) {
    assert.notEqual(buildEmailPreview({ ...input, ...changed }).previewRevision, preview.previewRevision);
  }
  assert.equal(preview.smtpConfigurationRevision, 7);
  assert.equal(preview.smtpConfigurationFingerprint, 'smtp-fingerprint-7');
  assert.equal(preview.readiness, 'ready');
});

test('send bundle preparation rejects an attachment changed after resolution and removes the temporary copy', async (t) => {
  const outputDir = await fixtureDir(t);
  const created = await createApplicationAttachment(outputDir, upload({
    originalName: 'resume.pdf', clientMediaType: 'application/pdf', buffer: PDF,
  }), LIMITS);
  const resolved = await resolveApplicationAttachments(outputDir, NOTE_ID, [created.attachment.attachmentId], LIMITS);
  const changed = Buffer.from(PDF);
  changed[changed.length - 2] ^= 1;
  await writeFile(resolved.attachments[0].absolutePath, changed);

  await assert.rejects(prepareSendBundle(outputDir, resolved), (error) => {
    assert.equal(error.code, 'ATTACHMENT_SIGNATURE_MISMATCH');
    return true;
  });
  const bundleRoot = path.join(outputDir, 'application-attachments', 'send-bundles');
  assert.deepEqual(await readdir(bundleRoot), []);
});

test('resolved attachments are checksum verified and a finalized send bundle stays immutable', async (t) => {
  const outputDir = await fixtureDir(t);
  const created = await createApplicationAttachment(outputDir, upload({
    originalName: '中文简历.pdf', clientMediaType: 'application/pdf', buffer: PDF,
  }), LIMITS);
  const resolved = await resolveApplicationAttachments(outputDir, NOTE_ID, [created.attachment.attachmentId], LIMITS);
  const bundle = await prepareSendBundle(outputDir, resolved);
  const copiedBeforeSend = await readFile(bundle.mailAttachments[0].path);
  assert.equal(createHash('sha256').update(copiedBeforeSend).digest('hex'), created.attachment.sha256);

  await writeFile(resolved.attachments[0].absolutePath, Buffer.from('%PDF-1.7\nchanged\n', 'utf8'));
  await finalizeSendBundle(bundle, {
    status: 'sent', noteId: NOTE_ID, recipient: 'jobs@example.test', draftId: 'draft-1', draftVersion: 1,
    contentHash: 'content-hash', attachmentBundleHash: resolved.attachmentBundleHash,
    attachments: resolved.attachments, preparedAt: new Date().toISOString(), sentAt: new Date().toISOString(),
    messageId: 'message-1', smtpConfigurationRevision: 2,
  });
  const finalAttachment = await readFile(path.join(bundle.finalDir, 'attachments', `${created.attachment.attachmentId}.pdf`));
  assert.deepEqual(finalAttachment, PDF);
  const sendManifest = JSON.parse(await readFile(path.join(bundle.finalDir, 'manifest.json'), 'utf8'));
  assert.equal(sendManifest.attachments[0].sha256, created.attachment.sha256);
  assert.equal(JSON.stringify(sendManifest).includes(outputDir), false);
  assert.deepEqual(await readFinalizedSendBundle(outputDir, bundle.sendId), sendManifest);

  await assert.rejects(
    resolveApplicationAttachments(outputDir, NOTE_ID, [created.attachment.attachmentId], LIMITS),
    (error) => error.code === 'ATTACHMENT_SIGNATURE_MISMATCH',
  );
  assert.notEqual(hashAttachmentBundle([]), resolved.attachmentBundleHash);
});

test('recovery rejects an immutable send bundle whose copied attachment was modified', async (t) => {
  const outputDir = await fixtureDir(t);
  const created = await createApplicationAttachment(outputDir, upload({
    originalName: 'resume.pdf', clientMediaType: 'application/pdf', buffer: PDF,
  }), LIMITS);
  const resolved = await resolveApplicationAttachments(outputDir, NOTE_ID, [created.attachment.attachmentId], LIMITS);
  const bundle = await prepareSendBundle(outputDir, resolved);
  const preparedAt = new Date().toISOString();
  await sealPreparedSendBundle(bundle, {
    noteId: NOTE_ID,
    recipient: 'jobs@example.test',
    draftId: 'draft-1',
    draftVersion: 1,
    contentHash: 'content-hash',
    attachmentBundleHash: resolved.attachmentBundleHash,
    attachments: resolved.attachments,
    preparedAt,
    attachmentCount: 1,
    attachmentBytes: PDF.length,
  });
  await finalizeSendBundle(bundle, {
    status: 'sent', sentAt: new Date().toISOString(), messageId: 'message-1',
  });
  const copiedPath = path.join(bundle.finalDir, 'attachments', `${created.attachment.attachmentId}.pdf`);
  const tampered = Buffer.from(PDF);
  tampered[tampered.length - 2] ^= 1;
  await writeFile(copiedPath, tampered);

  await assert.rejects(
    readFinalizedSendBundle(outputDir, bundle.sendId),
    (error) => error.code === 'ATTACHMENT_SEND_BUNDLE_INVALID',
  );
});
