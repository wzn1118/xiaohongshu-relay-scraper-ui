const ACTIVE_RATE_LIMIT_STATES = new Set(['waiting', 'stopped', 'scheduled', 'resuming']);
const ACTIVE_SECURITY_STATES = new Set(['detected', 'waiting', 'timed_out']);

export const WORKFLOW_EVENT_LINE_PREFIX = 'WORKFLOW_EVENT ';

export const USER_PROBLEM_TITLES = Object.freeze({
  RATE_LIMITED: '平台暂时限制访问',
  SECURITY_VERIFICATION: '需要完成页面验证',
  LOGIN_REQUIRED: '登录状态已失效',
  NETWORK_TIMEOUT: '页面响应较慢',
  RELAY_DISCONNECTED: '采集浏览器连接中断',
  NOTE_UNAVAILABLE: '这条内容当前不可查看',
  BODY_EMPTY: '正文暂时没有加载出来',
  NOTE_ID_MISMATCH: '打开的内容与目标不一致',
  RUNNER_FAILED: '采集任务意外停止',
  PROCESS_INTERRUPTED: '任务运行被中断',
  WORKFLOW_REVISION_CONFLICT: '保存进度时发生冲突',
  WORKFLOW_STATE_INVALID: '进度文件需要修复',
  DISK_WRITE_FAILED: '无法保存新的进度',
  AI_PROVIDER_BUSY: '智能整理暂时繁忙',
  ANALYSIS_FAILED: '部分岗位尚未整理完成',
  QUALITY_GATE_FAILED: '这份材料还不能标记为可投递',
  EXPORT_FAILED: '下载文件生成失败',
  SMTP_NOT_VERIFIED: '发件邮箱尚未验证',
  SMTP_RECIPIENT_REJECTED: '收件地址未被接受',
  EMAIL_SEND_STATUS_UNKNOWN: '发送结果暂时无法确认',
  UNKNOWN_ERROR: '当前步骤需要重新检查',
});

const PROBLEM_DEFINITIONS = Object.freeze({
  RATE_LIMITED: {
    category: 'access', severity: 'warning', affectedStage: 'body', retryable: true,
    automaticAction: '停止普通请求并等待恢复检查',
    message: ({ saved, total, retryAt }) => `已保存 ${saved}/${total} 篇，将在 ${retryAt || '稍后'} 做一次恢复检查`,
    action: { id: 'check_recovery', label: '立即检查是否恢复' },
  },
  SECURITY_VERIFICATION: {
    category: 'access', severity: 'blocking', affectedStage: 'body', retryable: true,
    automaticAction: '暂停采集并保留检查点', requiresUserAction: true,
    message: ({ saved }) => `已保存 ${saved} 篇；完成验证后从剩余内容继续`,
    action: { id: 'open_verification', label: '打开验证页面' },
  },
  LOGIN_REQUIRED: {
    category: 'access', severity: 'blocking', affectedStage: 'preflight', retryable: true,
    automaticAction: '暂停受影响阶段', requiresUserAction: true,
    message: () => '已有结果不会丢失，重新登录后继续',
    action: { id: 'open_login', label: '打开登录页' },
  },
  NETWORK_TIMEOUT: {
    category: 'network', severity: 'warning', affectedStage: 'body', retryable: true,
    automaticAction: '一次延迟重试',
    message: () => '当前这条已排到稍后重试，不影响其他内容',
  },
  RELAY_DISCONNECTED: {
    category: 'browser', severity: 'warning', affectedStage: 'body', retryable: true,
    automaticAction: '自动重连一次',
    message: ({ saved }) => `已保存 ${saved} 篇，正在重新连接`,
    action: { id: 'reconnect_relay', label: '重新连接浏览器' },
  },
  NOTE_UNAVAILABLE: {
    category: 'content', severity: 'info', affectedStage: 'body', retryable: false,
    automaticAction: '标记终态并继续',
    message: () => '可能已删除或限制访问，已跳过，不影响其他结果',
  },
  BODY_EMPTY: {
    category: 'content', severity: 'warning', affectedStage: 'body', retryable: true,
    automaticAction: '更长等待后重试一次',
    message: () => '当前条稍后再试，其他内容继续处理',
  },
  NOTE_ID_MISMATCH: {
    category: 'content', severity: 'warning', affectedStage: 'body', retryable: true,
    automaticAction: '校验 ID 后使用备用入口',
    message: () => '未保存错误正文，系统将换用备用入口重试一次',
  },
  RUNNER_FAILED: {
    category: 'runtime', severity: 'warning', affectedStage: 'task', retryable: true,
    automaticAction: '运行记录和已完成进度均已保存', requiresUserAction: true,
    message: ({ saved, total }) => total > 0
      ? `已保存 ${saved}/${total} 篇，可从当前任务继续未完成内容`
      : '本次尚未采集到内容，可重新启动；若再次停止，请先刷新浏览器连接',
    action: { id: 'resume', label: '重新启动采集' },
  },
  PROCESS_INTERRUPTED: {
    category: 'unknown', severity: 'warning', affectedStage: 'task', retryable: true,
    automaticAction: '标记为可续跑',
    message: () => '已完成结果和进度均已保存',
    action: { id: 'resume', label: '继续任务' },
  },
  WORKFLOW_REVISION_CONFLICT: {
    category: 'storage', severity: 'blocking', affectedStage: 'checkpoint', retryable: true,
    automaticAction: '停止写入并重新读取最新版本', requiresUserAction: true,
    message: () => '为保护已有结果，受影响步骤已暂停',
    action: { id: 'reload_workflow', label: '重新加载状态' },
  },
  WORKFLOW_STATE_INVALID: {
    category: 'storage', severity: 'blocking', affectedStage: 'checkpoint', retryable: false,
    automaticAction: '隔离损坏快照', requiresUserAction: true,
    message: () => '已有原始结果仍保留，系统不会覆盖它们',
    action: { id: 'view_repair_options', label: '查看修复选项' },
  },
  DISK_WRITE_FAILED: {
    category: 'storage', severity: 'blocking', affectedStage: 'checkpoint', retryable: true,
    automaticAction: '停止新增工作', requiresUserAction: true,
    message: () => '已保存到上一个检查点，本轮已暂停',
    action: { id: 'check_disk_space', label: '检查磁盘空间' },
  },
  AI_PROVIDER_BUSY: {
    category: 'analysis', severity: 'warning', affectedStage: 'classify', retryable: true,
    automaticAction: '进入 AI 重试队列',
    message: () => '正文和岗位信息已保存，稍后只补智能整理',
    action: { id: 'retry_analysis_later', label: '稍后重试整理' },
  },
  ANALYSIS_FAILED: {
    category: 'analysis', severity: 'warning', affectedStage: 'extract', retryable: true,
    automaticAction: '按正文版本增量重算',
    message: () => '完整正文仍可查看，仅重试失败条目',
    action: { id: 'resume_analysis', label: '继续整理' },
  },
  QUALITY_GATE_FAILED: {
    category: 'analysis', severity: 'warning', affectedStage: 'quality', retryable: true,
    automaticAction: '保留草稿与具体原因',
    message: () => '已生成草稿，但缺少来源或关键信息',
    action: { id: 'complete_quality_input', label: '补充信息' },
  },
  EXPORT_FAILED: {
    category: 'artifact', severity: 'warning', affectedStage: 'artifact', retryable: true,
    automaticAction: '等待单独重建下载文件',
    message: () => '页面结果已保存，可单独重新生成文件',
    action: { id: 'rebuild_artifact', label: '重新生成文件' },
  },
  SMTP_NOT_VERIFIED: {
    category: 'delivery', severity: 'blocking', affectedStage: 'delivery', retryable: true,
    automaticAction: '不进入发送队列', requiresUserAction: true,
    message: () => '求职材料已保存，尚未发送',
    action: { id: 'verify_smtp', label: '验证邮箱' },
  },
  SMTP_RECIPIENT_REJECTED: {
    category: 'delivery', severity: 'blocking', affectedStage: 'delivery', retryable: true,
    automaticAction: '保留幂等发送状态', requiresUserAction: true,
    message: () => '材料和发送记录已保存，请检查地址',
    action: { id: 'edit_recipient', label: '修改收件地址' },
  },
  EMAIL_SEND_STATUS_UNKNOWN: {
    category: 'delivery', severity: 'warning', affectedStage: 'delivery', retryable: false,
    automaticAction: '等待审计或人工确认',
    message: () => '不会自动重复发送，避免重复投递',
    action: { id: 'view_send_audit', label: '查看发送记录' },
  },
  UNKNOWN_ERROR: {
    category: 'unknown', severity: 'blocking', affectedStage: 'task', retryable: true,
    automaticAction: '暂停受影响模块', requiresUserAction: true,
    message: ({ saved, technicalRef }) => `已保存 ${saved} 条，错误编号 ${technicalRef}`,
    action: { id: 'retry_current_stage', label: '重试当前步骤' },
  },
});

const ERROR_CODE_ALIASES = Object.freeze({
  SECURITY_VERIFICATION_TIMEOUT: 'SECURITY_VERIFICATION',
  SERVER_RESTART: 'PROCESS_INTERRUPTED',
  SERVER_SHUTDOWN: 'PROCESS_INTERRUPTED',
  ORPHAN_CLEANUP_FAILED: 'PROCESS_INTERRUPTED',
  QUALITY_GATE_INCOMPLETE: 'QUALITY_GATE_FAILED',
  BODY_COMPLETION_PENDING: 'BODY_EMPTY',
});

export function mapUserProblem(rawCode, context = {}) {
  const requestedCode = String(rawCode || 'UNKNOWN_ERROR').trim().toUpperCase();
  const code = USER_PROBLEM_TITLES[requestedCode]
    ? requestedCode
    : ERROR_CODE_ALIASES[requestedCode] || 'UNKNOWN_ERROR';
  const definition = PROBLEM_DEFINITIONS[code];
  const saved = nonNegative(context.saved ?? context.preservedResultCount ?? context.fullText);
  const total = Math.max(saved, nonNegative(context.total ?? context.discovered ?? saved));
  const technicalRef = String(context.technicalRef || requestedCode || code);
  const values = { ...context, saved, total, technicalRef };
  return {
    code,
    category: definition.category,
    severity: definition.severity,
    userTitle: USER_PROBLEM_TITLES[code],
    userMessage: definition.message(values),
    preservedResultCount: saved,
    automaticAction: definition.automaticAction || null,
    retryable: definition.retryable === true,
    retryAt: context.retryAt || null,
    requiresUserAction: definition.requiresUserAction === true,
    action: definition.action ? { ...definition.action } : null,
    affectedStage: String(context.affectedStage || definition.affectedStage),
    technicalRef,
  };
}

export function deriveUserProblems(job = {}) {
  const body = normalizedBodyMetrics(job);
  const context = {
    saved: body.succeeded,
    total: body.discovered,
    retryAt: job.rateLimit?.nextRetryAt || null,
  };
  const codes = [];
  if (ACTIVE_RATE_LIMIT_STATES.has(job.rateLimit?.status)) codes.push('RATE_LIMITED');
  if (ACTIVE_SECURITY_STATES.has(job.securityRestriction?.status)) codes.push('SECURITY_VERIFICATION');
  if (job.status === 'interrupted') codes.push('PROCESS_INTERRUPTED');

  const currentAttemptRecord = currentAttempt(job);
  const explicitCode = currentAttemptRecord?.errorCode || job.errorCode || job.problemCode;
  if (explicitCode) codes.push(explicitCode);
  const message = String(job.message || job.error || '');
  if (/login|登录状态|not logged/i.test(message)) codes.push('LOGIN_REQUIRED');
  if (/relay.*disconnect|browser.*disconnect|连接中断/i.test(message)) codes.push('RELAY_DISCONNECTED');
  if (/revision conflict|版本冲突/i.test(message)) codes.push('WORKFLOW_REVISION_CONFLICT');
  if (/disk|ENOSPC|磁盘空间/i.test(message)) codes.push('DISK_WRITE_FAILED');

  return [...new Set(codes.map((code) => (
    USER_PROBLEM_TITLES[String(code || '').toUpperCase()]
      ? String(code).toUpperCase()
      : ERROR_CODE_ALIASES[String(code || '').toUpperCase()] || 'UNKNOWN_ERROR'
  )))].map((code) => mapUserProblem(code, { ...context, technicalRef: explicitCode || code }));
}

export function adaptLegacyJobSnapshot(job = {}, options = {}) {
  const body = normalizedBodyMetrics(job);
  const discovered = body.discovered;
  const fullText = body.succeeded;
  const summary = job.workflowSummary && typeof job.workflowSummary === 'object'
    ? job.workflowSummary
    : {};
  const journey = job.config?.bodyOnly || job.params?.bodyOnly
    ? 'body_import'
    : (job.config?.analysisMode || job.params?.analysisMode) === 'general'
      ? 'general'
      : 'job';
  const activeStage = activeStageForJob(job);
  const state = normalizeTaskState(job.status, job);
  const issues = deriveUserProblems(job);
  const throughSequence = nonNegative(options.throughSequence ?? job.throughSequence ?? job.eventSequence);
  const revision = nonNegative(job.revision);
  const attempt = normalizeAttemptProgress(job, body);
  const counts = {
    discovered,
    fullText,
    confirmedJobs: numberFrom(summary, ['confirmedJobs', 'confirmedJobCount', 'jobCount', 'jobsConfirmed']),
    nonJobs: numberFrom(summary, ['nonJobs', 'nonJobCount', 'generalRecordCount']),
    matchReady: numberFrom(summary, ['matchReady', 'matchReadyCount', 'matchesGenerated']),
    draftReady: numberFrom(summary, ['draftReady', 'draftReadyCount', 'applicationCopyGenerated'], job.applicationCount),
    applicationReady: numberFrom(summary, ['applicationReady', 'applicationReadyCount', 'qualityPassedCount']),
    pending: body.pending + body.notAttempted,
    retryable: body.pending + body.notAttempted + body.failed,
    unavailable: body.failed + body.cancelled,
  };
  const performance = summary.performance && typeof summary.performance === 'object'
    ? summary.performance
    : {};
  const lastEventAt = String(options.lastEventAt || job.updatedAt || job.progressUpdatedAt || job.createdAt || new Date(0).toISOString());
  const snapshot = {
    schemaVersion: 3,
    revision,
    throughSequence,
    jobId: String(job.id || job.jobId || ''),
    activeAttemptId: job.activeAttemptId || null,
    journey,
    state,
    activeStage,
    headline: headlineForJob(job, state, activeStage, issues),
    detail: detailForJob(job, counts, state),
    stages: stageSnapshots(job, journey, body, attempt),
    counts,
    speed: {
      activePerMinute: nullableNumber(performance.activePerMinute ?? job.activePerMinute),
      wallPerMinute: nullableNumber(performance.wallPerMinute ?? job.wallPerMinute),
      cacheHits: nonNegative(performance.cacheHits ?? job.bodyCacheReusedCount),
      networkSuccess: nonNegative(performance.networkSuccess ?? Math.max(0, fullText - nonNegative(job.bodyCacheReusedCount))),
      etaMinSeconds: nullableNumber(performance.etaMinSeconds ?? job.etaMinSeconds),
      etaMaxSeconds: nullableNumber(performance.etaMaxSeconds ?? job.etaMaxSeconds),
      confidence: String(performance.confidence || 'low'),
    },
    issues,
    connection: {
      state: String(options.connectionState || 'live'),
      lastEventAt,
    },
    checkpoint: {
      revision,
      savedAt: String(job.progressUpdatedAt || job.updatedAt || job.createdAt || lastEventAt),
      resumeAvailable: job.resumeAvailable === true,
    },
  };
  return snapshot;
}

export function createWorkflowEvent(job, transport = {}) {
  const sequence = nonNegative(transport.sequence);
  const supplied = transport.supplied && typeof transport.supplied === 'object'
    ? transport.supplied
    : {};
  const snapshot = job?.experienceSnapshot?.schemaVersion === 3
    ? { ...job.experienceSnapshot, throughSequence: sequence }
    : adaptLegacyJobSnapshot(job, { throughSequence: sequence, lastEventAt: transport.occurredAt });
  const problem = supplied.problem || snapshot.issues?.[0];
  const stage = validStage(supplied.stage) || snapshot.activeStage || 'preflight';
  return {
    schemaVersion: 1,
    eventId: String(transport.eventId || supplied.eventId || `${snapshot.jobId}:${sequence}`),
    sequence,
    jobId: String(transport.jobId || snapshot.jobId),
    attemptId: String(
      transport.attemptId
      || supplied.attemptId
      || job?.activeAttemptId
      || job?.currentAttemptId
      || `${snapshot.jobId}:legacy`,
    ),
    occurredAt: String(transport.occurredAt || supplied.occurredAt || new Date().toISOString()),
    type: validEventType(supplied.type) || eventTypeForTransport(transport.type, snapshot.state),
    stage,
    state: validEventState(supplied.state) || eventStateForSnapshot(snapshot.state),
    progress: supplied.progress || progressForEvent(snapshot, stage),
    ...(supplied.performance ? { performance: supplied.performance } : performanceForSnapshot(snapshot)),
    message: normalizeEventMessage(supplied.message, transport.type),
    ...(problem ? { problem } : {}),
    checkpoint: supplied.checkpoint || { ...snapshot.checkpoint },
    sourceRevision: nonNegative(supplied.sourceRevision ?? snapshot.revision),
    ...(Array.isArray(supplied.outputRefs) ? { outputRefs: supplied.outputRefs.map(String) } : {}),
    technicalRef: String(supplied.technicalRef || transport.technicalRef || transport.type || 'workflow'),
  };
}

export function reduceWorkflowSnapshot(currentSnapshot, event) {
  if (!currentSnapshot || currentSnapshot.schemaVersion !== 3) {
    throw new TypeError('WorkflowSnapshotV3 is required.');
  }
  if (!event || event.schemaVersion !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new TypeError('WorkflowEventV1 with a positive sequence is required.');
  }
  if (event.jobId !== currentSnapshot.jobId || event.sequence <= nonNegative(currentSnapshot.throughSequence)) {
    return structuredClone(currentSnapshot);
  }

  const next = structuredClone(currentSnapshot);
  const occurredAt = String(event.occurredAt || next.connection?.lastEventAt || new Date().toISOString());
  const stageId = validStage(event.stage) || next.activeStage || 'preflight';
  const eventState = validEventState(event.state) || next.state || 'running';
  const progress = normalizedEventProgress(event.progress);
  const messageParams = event.message?.params && typeof event.message.params === 'object'
    ? event.message.params
    : {};

  next.throughSequence = event.sequence;
  next.activeAttemptId = event.attemptId || next.activeAttemptId;
  if (event.type === 'task') {
    next.state = eventState;
    next.activeStage = ['completed', 'failed', 'cancelled'].includes(eventState) ? null : stageId;
  } else {
    next.activeStage = stageId;
  }
  next.connection = { state: 'live', lastEventAt: occurredAt };

  const stageIndex = next.stages.findIndex((stage) => (stage.stage || stage.id) === stageId);
  const previousStage = stageIndex >= 0 ? next.stages[stageIndex] : {
    stage: stageId,
    id: stageId,
    headline: stageHeadline(stageId) || stageId,
    label: stageHeadline(stageId) || stageId,
    state: 'queued',
    detail: '',
    progress: eventProgress(progress.unit, 0, progress.total, 0, 0, 0, 0, 0),
  };
  const previousProgress = previousStage.progress && typeof previousStage.progress === 'object'
    ? previousStage.progress
    : {};
  const stageProgress = { ...progress };
  if (stageId === 'body') {
    const inferredCoverage = progress.succeeded + progress.reused;
    const coverageDone = Math.max(
      nonNegative(previousProgress.coverageDone ?? next.counts.fullText),
      nonNegative(messageParams.coverageDone ?? inferredCoverage),
    );
    const coverageTotal = Math.max(
      coverageDone,
      nonNegative(previousProgress.coverageTotal ?? next.counts.discovered),
      nonNegative(messageParams.coverageTotal),
    );
    stageProgress.coverageDone = coverageDone;
    stageProgress.coverageTotal = coverageTotal || null;
    stageProgress.coveragePercent = coverageTotal ? roundPercent(coverageDone, coverageTotal) : 0;
    next.counts.discovered = Math.max(nonNegative(next.counts.discovered), coverageTotal);
    next.counts.fullText = Math.max(nonNegative(next.counts.fullText), coverageDone);
    next.counts.pending = Math.max(0, next.counts.discovered - next.counts.fullText);
    next.counts.retryable = eventState === 'waiting_system' || ['retry', 'warning', 'error'].includes(event.type)
      ? progress.retryable
      : next.counts.pending;
    next.counts.unavailable = progress.failed;
    next.speed.cacheHits = Math.max(nonNegative(next.speed.cacheHits), progress.reused);
    next.speed.networkSuccess = Math.max(nonNegative(next.speed.networkSuccess), progress.succeeded);
  }
  applyCountParams(next.counts, messageParams);

  const reducedStage = {
    ...previousStage,
    stage: stageId,
    id: previousStage.id || stageId,
    state: eventState,
    detail: stageProgressDetail(eventState, stageProgress.done, stageProgress.total),
    progress: stageProgress,
  };
  if (stageIndex >= 0) next.stages[stageIndex] = reducedStage;
  else next.stages.push(reducedStage);

  if (event.performance && typeof event.performance === 'object') {
    next.speed.activePerMinute = nullableNumber(event.performance.activePerMinute);
    next.speed.wallPerMinute = nullableNumber(event.performance.wallPerMinute);
    next.speed.etaMinSeconds = nullableNumber(event.performance.etaMinSeconds);
    next.speed.etaMaxSeconds = nullableNumber(event.performance.etaMaxSeconds);
    next.speed.confidence = ['low', 'medium', 'high'].includes(event.performance.confidence)
      ? event.performance.confidence
      : next.speed.confidence;
  }

  if (event.checkpoint && typeof event.checkpoint === 'object') {
    next.checkpoint = {
      revision: nonNegative(event.checkpoint.revision),
      savedAt: String(event.checkpoint.savedAt || occurredAt),
      resumeAvailable: event.checkpoint.resumeAvailable === true,
    };
  }
  next.revision = Math.max(
    nonNegative(next.revision),
    nonNegative(event.sourceRevision),
    nonNegative(event.checkpoint?.revision),
  );

  if (event.problem && typeof event.problem === 'object') {
    next.issues = [
      event.problem,
      ...next.issues.filter((problem) => problem.code !== event.problem.code),
    ];
    next.headline = String(event.problem.userTitle || next.headline);
    next.detail = String(event.problem.userMessage || next.detail);
  } else {
    const clearedCode = String(messageParams.clearedProblemCode || '');
    if (clearedCode) next.issues = next.issues.filter((problem) => problem.code !== clearedCode);
    next.headline = headlineForReducedEvent(stageId, eventState, next.headline);
    next.detail = String(messageParams.userMessage || messageParams.detail || reducedStage.detail);
  }
  return next;
}

export function parseWorkflowEventLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith(WORKFLOW_EVENT_LINE_PREFIX)) return null;
  try {
    const event = JSON.parse(text.slice(WORKFLOW_EVENT_LINE_PREFIX.length));
    return event && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
}

function normalizedBodyMetrics(job) {
  const source = job.bodyMetrics || job.workflowSummary?.bodyMetrics || {};
  const discovered = nonNegative(source.discovered ?? job.discoveredCount);
  const succeeded = Math.min(discovered || Number.MAX_SAFE_INTEGER, nonNegative(source.succeeded ?? job.scrapedCount));
  return {
    discovered,
    attempted: nonNegative(source.attempted ?? job.bodyProcessedCount),
    succeeded,
    failed: nonNegative(source.failed),
    notAttempted: nonNegative(source.notAttempted ?? Math.max(0, discovered - succeeded)),
    blocked: nonNegative(source.blocked),
    cancelled: nonNegative(source.cancelled),
    pending: nonNegative(source.pending),
  };
}

function normalizeAttemptProgress(job, body) {
  const current = currentAttempt(job);
  const explicit = job.attemptProgress && typeof job.attemptProgress === 'object' ? job.attemptProgress : {};
  const baseline = nonNegative(current?.coverageCountAtStart ?? explicit.coverageCountAtStart);
  const total = nonNegative(current?.targetCount ?? explicit.total ?? (current?.kind === 'initial' ? body.discovered : Math.max(0, body.discovered - baseline)));
  const done = Math.min(total || Number.MAX_SAFE_INTEGER, nonNegative(explicit.done ?? Math.max(0, body.succeeded - baseline)));
  return {
    attemptId: current?.attemptId || job.currentAttemptId || null,
    unit: String(current?.progressUnit || explicit.unit || 'body'),
    done,
    total: total || null,
    percent: total ? roundPercent(done, total) : 0,
    startedAt: current?.startedAt || explicit.startedAt || null,
  };
}

function stageSnapshots(job, journey, body, attempt) {
  const stageSource = job.stages || {};
  const analysisStatus = normalizeStageState(stageSource.analysis?.status, job.status === 'completed');
  const definitions = [
    ['preflight', '准备运行环境', job.startedAt ? 'completed' : normalizeStageState(job.status)],
    ['discovery', '寻找近 14 天相关内容', normalizeStageState(stageSource.discovery?.status)],
    ['body', journey === 'job' ? '获取完整岗位详情' : '获取完整正文', normalizeStageState(stageSource.bodyCompletion?.status)],
    ['classify', journey === 'job' ? '区分招聘信息和经验分享' : '整理内容类型', analysisStatus],
    ['extract', journey === 'job' ? '提取职责、要求和投递入口' : '提取主题与观点', analysisStatus],
    ['match', '匹配你的经历', analysisStatus],
    ['draft', journey === 'job' ? '准备求职沟通材料' : '生成内容摘要', analysisStatus],
    ['quality', '检查结果质量', analysisStatus],
    ['audience', '分析评论和相关人群', normalizeStageState(stageSource.audience?.status)],
    ['artifact', '整理页面结果和下载文件', normalizeStageState(stageSource.artifacts?.status)],
    ['delivery', '发送已确认的材料', 'queued'],
  ];
  return definitions.map(([id, label, state]) => ({
    stage: id,
    id,
    headline: label,
    label,
    state,
    detail: stageProgressDetail(state, id === 'body' ? attempt.done : stageDone(stageSource, id), id === 'body' ? attempt.total : stageTotal(stageSource, id)),
    progress: id === 'body'
      ? {
          ...eventProgress(attempt.unit, attempt.done, attempt.total, attempt.done, 0, Math.max(0, attempt.total - attempt.done), 0, body.blocked),
          coverageDone: body.succeeded,
          coverageTotal: body.discovered || null,
          coveragePercent: body.discovered ? roundPercent(body.succeeded, body.discovered) : 0,
        }
      : eventProgress(stageUnit(id), stageDone(stageSource, id), stageTotal(stageSource, id), 0, 0, 0, 0, 0),
  }));
}

function stageProgressDetail(state, done, total) {
  if (total != null && Number(total) > 0) return `本次已完成 ${Math.min(nonNegative(done), nonNegative(total))} / ${nonNegative(total)}`;
  if (nonNegative(done) > 0) return `本次已完成 ${nonNegative(done)} 项`;
  if (state === 'completed') return '已完成并保存';
  if (state === 'partial') return '已有结果已保存，可继续补全';
  if (state === 'waiting_system') return '系统正在等待合适的恢复时机';
  if (state === 'waiting_user') return '需要你完成页面操作后继续';
  if (state === 'running') return '正在处理，完成一项就保存一项';
  return '等待前一步完成';
}

function activeStageForJob(job) {
  const phase = String(job.progressPhase || '').toLowerCase();
  if (/rate_limit|scrap|body|cache|note/.test(phase)) return 'body';
  if (/discover|sort|filter|search/.test(phase)) return 'discovery';
  if (/audience|comment|profile/.test(phase)) return 'audience';
  if (/export|artifact|file/.test(phase)) return 'artifact';
  if (/quality/.test(phase)) return 'quality';
  if (/draft|copy/.test(phase)) return 'draft';
  if (/match/.test(phase)) return 'match';
  if (/analy|classif/.test(phase)) return 'classify';
  if (/extract/.test(phase)) return 'extract';
  if (['queued', 'resuming', 'running'].includes(job.status)) return 'preflight';
  return null;
}

function normalizeTaskState(status, job) {
  if (ACTIVE_SECURITY_STATES.has(job.securityRestriction?.status)) return 'waiting_user';
  if (ACTIVE_RATE_LIMIT_STATES.has(job.rateLimit?.status)) return 'waiting_system';
  const value = String(status || 'queued').toLowerCase();
  if (value === 'succeeded') return 'completed';
  if (value === 'incomplete' || value === 'interrupted' || value === 'blocked') return 'partial';
  if (value === 'resuming') return 'retrying';
  return ['queued', 'running', 'partial', 'completed', 'failed', 'cancelled'].includes(value) ? value : 'queued';
}

function normalizeStageState(status, completedFallback = false) {
  const value = String(status || '').toLowerCase();
  if (value === 'not_started' || value === '') return completedFallback ? 'completed' : 'queued';
  if (value === 'succeeded') return 'completed';
  if (value === 'interrupted' || value === 'blocked') return 'partial';
  return ['queued', 'running', 'waiting_system', 'waiting_user', 'retrying', 'partial', 'completed', 'failed', 'cancelled'].includes(value)
    ? value
    : 'queued';
}

function headlineForJob(job, state, activeStage, issues) {
  if (issues[0]?.severity === 'blocking') return issues[0].userTitle;
  if (state === 'completed') return '任务已完成';
  if (state === 'partial') return '已保留当前结果，可继续补全';
  if (state === 'failed') return issues[0]?.userTitle || '当前步骤未完成，已有结果已保留';
  if (state === 'cancelled') return '任务已取消，已有结果已保留';
  if (state === 'waiting_system') return issues[0]?.userTitle || '系统正在等待恢复';
  if (state === 'waiting_user') return issues[0]?.userTitle || '需要你完成一个操作';
  return job.progressLabel || stageHeadline(activeStage) || '任务正在准备';
}

function detailForJob(job, counts, state) {
  if (job.progressLabel && ['running', 'retrying'].includes(state)) return String(job.progressLabel);
  if (counts.discovered > 0) return `已找到 ${counts.discovered} 条，完整正文 ${counts.fullText} 条，待处理 ${counts.pending} 条`;
  return state === 'queued' ? '任务已进入队列' : '进度已保存';
}

function stageHeadline(stage) {
  return ({
    preflight: '正在准备运行环境', discovery: '正在寻找近 14 天相关内容', body: '正在获取完整正文',
    classify: '正在整理内容类型', extract: '正在提取关键信息', match: '正在匹配你的经历',
    draft: '正在准备求职沟通材料', quality: '正在检查结果质量', audience: '正在分析评论和相关人群',
    artifact: '正在整理页面结果和下载文件', delivery: '正在发送已确认的材料',
  })[stage];
}

function eventTypeForTransport(type, state) {
  if (type === 'log') return state === 'failed' ? 'error' : 'item';
  if (type === 'end' || type === 'closing') return 'task';
  return 'stage';
}

function eventStateForSnapshot(state) {
  return ['queued', 'running', 'waiting_system', 'waiting_user', 'retrying', 'partial', 'completed', 'failed', 'cancelled'].includes(state)
    ? state
    : 'running';
}

function progressForEvent(snapshot, stage) {
  const stageProgress = snapshot.stages.find((item) => item.id === stage)?.progress;
  if (stageProgress) {
    return eventProgress(
      stageProgress.unit,
      stageProgress.done,
      stageProgress.total,
      stageProgress.succeeded,
      stageProgress.reused,
      stageProgress.retryable,
      stageProgress.failed,
      stageProgress.blocked,
    );
  }
  return eventProgress('job', 0, null, 0, 0, 0, 0, 0);
}

function performanceForSnapshot(snapshot) {
  return {
    performance: {
      activePerMinute: snapshot.speed.activePerMinute,
      wallPerMinute: snapshot.speed.wallPerMinute,
      etaMinSeconds: snapshot.speed.etaMinSeconds,
      etaMaxSeconds: snapshot.speed.etaMaxSeconds,
      confidence: ['low', 'medium', 'high'].includes(snapshot.speed.confidence) ? snapshot.speed.confidence : 'low',
    },
  };
}

function normalizeEventMessage(message, transportType) {
  if (message && typeof message === 'object' && typeof message.code === 'string') {
    return { code: message.code, ...(message.params ? { params: message.params } : {}) };
  }
  return { code: transportType === 'workflow' ? 'WORKFLOW_EVENT' : `JOB_${String(transportType || 'STATE').toUpperCase()}` };
}

function eventProgress(unit, done, total, succeeded, reused, retryable, failed, blocked) {
  return {
    unit: ['card', 'body', 'job', 'draft', 'file', 'email'].includes(unit) ? unit : 'job',
    done: nonNegative(done),
    total: total == null ? null : nonNegative(total),
    succeeded: nonNegative(succeeded),
    reused: nonNegative(reused),
    retryable: nonNegative(retryable),
    failed: nonNegative(failed),
    blocked: nonNegative(blocked),
  };
}

function normalizedEventProgress(progress) {
  const source = progress && typeof progress === 'object' ? progress : {};
  return eventProgress(
    source.unit,
    source.done,
    source.total,
    source.succeeded,
    source.reused,
    source.retryable,
    source.failed,
    source.blocked,
  );
}

function applyCountParams(counts, params) {
  const aliases = {
    discovered: ['discovered', 'coverageTotal'],
    fullText: ['fullText', 'coverageDone'],
    confirmedJobs: ['confirmedJobs'],
    nonJobs: ['nonJobs'],
    matchReady: ['matchReady'],
    draftReady: ['draftReady'],
    applicationReady: ['applicationReady'],
    pending: ['pending'],
    retryable: ['retryable'],
    unavailable: ['unavailable'],
  };
  for (const [count, keys] of Object.entries(aliases)) {
    for (const key of keys) {
      if (params[key] === undefined || params[key] === null || params[key] === '') continue;
      counts[count] = Math.max(nonNegative(counts[count]), nonNegative(params[key]));
      break;
    }
  }
}

function headlineForReducedEvent(stage, state, fallback) {
  if (state === 'completed' && stage === 'delivery') return '任务已完成';
  if (state === 'waiting_system') return '系统正在等待恢复';
  if (state === 'waiting_user') return '需要你完成一个操作';
  if (state === 'partial') return '已保留当前结果，可继续补全';
  if (state === 'failed') return '当前步骤未完成，已有结果已保留';
  if (state === 'cancelled') return '任务已取消，已有结果已保留';
  const headline = stageHeadline(stage);
  return headline ? `正在${headline.replace(/^正在/, '')}` : fallback;
}

function validEventType(value) {
  return ['task', 'stage', 'item', 'checkpoint', 'retry', 'artifact', 'warning', 'error'].includes(value) ? value : null;
}

function validStage(value) {
  return ['preflight', 'discovery', 'body', 'classify', 'extract', 'match', 'draft', 'quality', 'audience', 'artifact', 'delivery'].includes(value) ? value : null;
}

function validEventState(value) {
  return ['queued', 'running', 'waiting_system', 'waiting_user', 'retrying', 'partial', 'completed', 'failed', 'cancelled'].includes(value) ? value : null;
}

function currentAttempt(job) {
  if (!Array.isArray(job.attempts)) return null;
  return job.attempts.find((attempt) => attempt?.attemptId === job.currentAttemptId) || job.attempts.at(-1) || null;
}

function numberFrom(object, keys, fallback = 0) {
  for (const key of keys) {
    if (Number.isFinite(Number(object?.[key]))) return nonNegative(object[key]);
  }
  return nonNegative(fallback);
}

function stageUnit(id) {
  if (id === 'discovery') return 'card';
  if (['artifact'].includes(id)) return 'file';
  if (id === 'delivery') return 'email';
  if (id === 'draft') return 'draft';
  return 'job';
}

function stageDone(stages, id) {
  const source = id === 'artifact' ? stages.artifacts : stages[id];
  return source?.completedCount ?? source?.processedCount ?? 0;
}

function stageTotal(stages, id) {
  const source = id === 'artifact' ? stages.artifacts : stages[id];
  const total = source?.totalCount ?? source?.discoveredCount ?? source?.postsTotal;
  return Number.isFinite(Number(total)) ? Number(total) : null;
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function roundPercent(done, total) {
  return Math.round((done / Math.max(1, total)) * 10000) / 100;
}
