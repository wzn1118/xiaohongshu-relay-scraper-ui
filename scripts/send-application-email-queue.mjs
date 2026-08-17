import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMailSender } from '../server/mail-sender.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultOutputDir = path.join(repoRoot, 'outputs', '019fd23f-5213-7503-906f-a68757a199d7');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const next = argv[index + 1];
    values[rawKey] = inlineValue ?? (next && !next.startsWith('--') ? (index += 1, next) : true);
  }
  return values;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(?:1|true|yes|on)$/iu.test(String(value));
}

function numberValue(value, fallback) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

function maskEmail(value) {
  return String(value || '').replace(/^(.)([^@]*)(@.*)$/u, '$1***$3');
}

async function readJsonIfPresent(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function smtpConfig(fileConfig = {}) {
  const oauth = fileConfig.oauth ?? {};
  return {
    host: process.env.SMTP_HOST || fileConfig.host || '',
    port: Number(process.env.SMTP_PORT || fileConfig.port || 587),
    secure: booleanValue(process.env.SMTP_SECURE, booleanValue(fileConfig.secure)),
    requireTls: booleanValue(process.env.SMTP_REQUIRE_TLS, booleanValue(fileConfig.requireTls, true)),
    auth: process.env.SMTP_AUTH || fileConfig.auth || 'auto',
    user: process.env.SMTP_USER || fileConfig.user || '',
    pass: process.env.SMTP_PASS || fileConfig.pass || '',
    from: process.env.SMTP_FROM || fileConfig.from || '',
    oauth: {
      tenant: process.env.SMTP_OAUTH_TENANT || oauth.tenant || '',
      clientId: process.env.SMTP_OAUTH_CLIENT_ID || oauth.clientId || '',
      clientSecret: process.env.SMTP_OAUTH_CLIENT_SECRET || oauth.clientSecret || '',
      refreshToken: process.env.SMTP_OAUTH_REFRESH_TOKEN || oauth.refreshToken || '',
      scope: process.env.SMTP_OAUTH_SCOPE || oauth.scope || '',
    },
  };
}

async function fileSha256(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex').toUpperCase();
}

async function validateQueue(queue) {
  if (queue?.schemaVersion !== 2) throw new Error('发送队列版本不正确，请先重新生成最新版队列。');
  if (!Array.isArray(queue.items) || !queue.items.length) throw new Error('发送队列中没有可审核条目。');
  const issues = [];
  const recipients = new Set();
  for (const item of queue.items) {
    if (!item.noteId || !item.to || !item.subject || !item.emailBody) issues.push(`${item.noteId || 'unknown'}: 邮件字段不完整`);
    if (recipients.has(item.to.toLowerCase())) issues.push(`${item.noteId}: 收件邮箱在可发送队列中重复`);
    recipients.add(item.to.toLowerCase());
    if (item.attachment?.status !== 'ready' || !item.attachment?.sourcePath || !item.attachment?.displayName) {
      issues.push(`${item.noteId}: 附件规则未准备完成`);
      continue;
    }
    try {
      const actualHash = await fileSha256(item.attachment.sourcePath);
      if (actualHash !== String(item.attachment.sha256 || '').toUpperCase()) issues.push(`${item.noteId}: 简历附件哈希不一致`);
    } catch (error) {
      issues.push(`${item.noteId}: 无法读取简历附件（${error?.code || error?.message}）`);
    }
  }
  return issues;
}

function publicConfigStatus(sender, config) {
  return {
    ...sender.status(),
    hostConfigured: Boolean(config.host),
    port: config.port,
    secure: config.secure,
    requireTls: config.requireTls,
    userConfigured: Boolean(config.user),
    fromConfigured: Boolean(config.from),
    passwordConfigured: Boolean(config.pass),
    oauthClientConfigured: Boolean(config.oauth?.clientId),
    oauthRefreshTokenConfigured: Boolean(config.oauth?.refreshToken),
  };
}

async function writeState(statePath, state) {
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(tempPath, statePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await fs.copyFile(tempPath, statePath);
    await fs.unlink(tempPath);
  }
}

function blankState(queue) {
  return {
    schemaVersion: 1,
    jobId: queue.jobId,
    queueGeneratedAt: queue.generatedAt,
    updatedAt: new Date().toISOString(),
    sent: {},
    failed: {},
    unknown: {},
  };
}

function preview(queue, items, configStatus, issues) {
  return {
    mode: 'preview',
    jobId: queue.jobId,
    queueGeneratedAt: queue.generatedAt,
    candidateAvailability: queue.candidateAvailability,
    queueItems: queue.items.length,
    selectedItems: items.length,
    recipients: items.map((item) => maskEmail(item.to)),
    sample: items.slice(0, 3).map((item) => ({
      noteId: item.noteId,
      role: item.role,
      to: maskEmail(item.to),
      subject: item.subject,
      attachment: item.attachment.displayName,
      matchedResumeEvidence: item.matchedResumeEvidence,
    })),
    smtp: configStatus,
    validationIssues: issues,
    realMessagesSent: 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || 'preview').toLowerCase();
  if (!['preview', 'verify', 'send'].includes(mode)) throw new Error(`未知模式：${mode}`);
  const queuePath = path.resolve(String(args.queue || path.join(defaultOutputDir, '岗位邮件待人工审核发送队列.json')));
  const outputDir = path.dirname(queuePath);
  const configPath = path.resolve(String(args.config || path.join(outputDir, 'smtp-config.json')));
  const statePath = path.resolve(String(args.state || path.join(outputDir, 'smtp-send-state.json')));
  const reportPath = path.resolve(String(args.report || path.join(outputDir, `smtp-${mode}-report.json`)));
  const [queue, fileConfig] = await Promise.all([
    fs.readFile(queuePath, 'utf8').then(JSON.parse),
    readJsonIfPresent(configPath, {}),
  ]);
  const config = smtpConfig(fileConfig);
  const sender = createMailSender(config);
  const limit = Math.floor(numberValue(args.limit, queue.items.length));
  const selectedNoteIds = String(args['note-id'] || '').split(',').map((item) => item.trim()).filter(Boolean);
  const selected = queue.items
    .filter((item) => !selectedNoteIds.length || selectedNoteIds.includes(item.noteId))
    .slice(0, limit);
  const issues = await validateQueue({ ...queue, items: selected });
  const configStatus = publicConfigStatus(sender, config);

  if (mode === 'preview') {
    const report = preview(queue, selected, configStatus, issues);
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ reportPath, ...report }, null, 2));
    return;
  }

  if (issues.length) throw new Error(`发送前校验未通过：\n- ${issues.join('\n- ')}`);
  const verified = await sender.verify();
  if (mode === 'verify') {
    const report = {
      mode,
      verifiedAt: new Date().toISOString(),
      smtp: { ...configStatus, ...verified },
      selectedItems: selected.length,
      validationIssues: [],
      realMessagesSent: 0,
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ reportPath, ...report }, null, 2));
    return;
  }

  const confirmation = `SEND_${selected.length}`;
  if (args.confirm !== confirmation) {
    throw new Error(`真实发送需要参数 --confirm ${confirmation}。当前没有发送任何邮件。`);
  }
  const state = await readJsonIfPresent(statePath, blankState(queue));
  if (state.jobId !== queue.jobId || state.queueGeneratedAt !== queue.generatedAt) {
    throw new Error('发送状态与当前队列不匹配。请先归档旧状态，再重新预览。');
  }
  const delayMs = Math.max(1000, numberValue(args['delay-ms'], 3000));
  const results = [];
  for (const [index, item] of selected.entries()) {
    if (state.sent[item.noteId]) {
      results.push({ noteId: item.noteId, status: 'skipped_already_sent' });
      continue;
    }
    if (state.unknown[item.noteId]) {
      throw new Error(`${item.noteId} 的上次投递结果未知。请先在发件箱中人工确认，当前批次已停止。`);
    }
    try {
      const result = await sender.send({
        to: item.to,
        replyTo: item.replyTo || queue.candidate?.email,
        subject: item.subject,
        text: item.emailBody,
        headers: {
          'X-Application-Job-Id': queue.jobId,
          'X-Application-Note-Id': item.noteId,
        },
        attachments: [{
          filename: item.attachment.displayName,
          path: item.attachment.sourcePath,
          contentType: item.attachment.mediaType || 'application/pdf',
        }],
      });
      state.sent[item.noteId] = {
        sentAt: new Date().toISOString(),
        to: maskEmail(item.to),
        subject: item.subject,
        attachment: item.attachment.displayName,
        messageId: result.messageId,
        accepted: result.accepted.map(maskEmail),
        rejected: result.rejected.map(maskEmail),
      };
      delete state.failed[item.noteId];
      results.push({ noteId: item.noteId, status: 'sent', messageId: result.messageId });
    } catch (error) {
      const failure = {
        failedAt: new Date().toISOString(),
        code: error?.code || 'SMTP_SEND_FAILED',
        message: error?.message || '邮件发送失败。',
        safeToRetry: Boolean(error?.safeToRetry),
        deliveryStatus: error?.deliveryStatus || 'unknown',
      };
      if (failure.deliveryStatus === 'unknown') state.unknown[item.noteId] = failure;
      else state.failed[item.noteId] = failure;
      results.push({ noteId: item.noteId, status: failure.deliveryStatus, code: failure.code });
      state.updatedAt = new Date().toISOString();
      await writeState(statePath, state);
      throw error;
    }
    state.updatedAt = new Date().toISOString();
    await writeState(statePath, state);
    if (index < selected.length - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const report = {
    mode,
    completedAt: new Date().toISOString(),
    selectedItems: selected.length,
    sentThisRun: results.filter((item) => item.status === 'sent').length,
    skippedAlreadySent: results.filter((item) => item.status === 'skipped_already_sent').length,
    results,
    statePath,
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
