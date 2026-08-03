import crypto from 'node:crypto';

const DATA_INTENT = /(?:岗位|职位|应用|投递|原帖|帖子|笔记|正文|评论|回复|用户|受众|主页|扩散|关系|数据|记录|统计|筛选|比较|分析|查找|搜索|导出|附件|邮件|\bapplications?\b|\bposts?\b|\bcomments?\b|\busers?\b|\baudience\b|\bdatasets?\b|\brecords?\b|\bsearch\b|\bfilter\b|\bcompare\b|\banaly[sz]e\b|\bexport\b)/iu;
const ARTIFACT_INTENT = /(?:导出|下载|生成.{0,6}(?:表格|文件|报告)|csv|xlsx|json|markdown|\bartifact\b|\bexport\b)/iu;

export function createAgentPlan({ objective, tools = [], now = new Date() } = {}) {
  const text = String(objective || '').trim();
  const toolNames = [...new Set(tools.map((tool) => String(tool?.name || '')).filter(Boolean))];
  const needsEvidence = requiresDataEvidence(text);
  const needsArtifact = ARTIFACT_INTENT.test(text);
  const steps = [
    planStep('understand', '理解目标与约束', 'completed'),
    ...(needsEvidence ? [planStep('inspect', '读取并核对任务数据', 'pending', toolNames.filter(isReadTool).slice(0, 8))] : []),
    ...(needsArtifact ? [planStep('produce', '生成并校验请求的产物', 'pending', toolNames.filter((name) => name.startsWith('artifact.')))] : []),
    planStep('verify', '验证证据、范围与完成条件', 'pending'),
    planStep('respond', '整理结果并给出可追溯结论', 'pending'),
  ];
  return {
    schemaVersion: 1,
    planId: `plan-${crypto.createHash('sha256').update(text || 'conversation').digest('hex').slice(0, 20)}`,
    objective: text.slice(0, 2_000),
    status: 'in_progress',
    requiresEvidence: needsEvidence,
    requiresArtifact: needsArtifact,
    createdAt: dateValue(now),
    updatedAt: dateValue(now),
    steps,
  };
}

export function markPlanToolStarted(plan, toolName, now = new Date()) {
  return updatePlan(plan, (draft) => {
    const step = draft.steps.find((item) => item.status === 'pending' && item.id !== 'verify' && item.id !== 'respond')
      || draft.steps.find((item) => item.id === 'inspect');
    if (step) {
      step.status = 'in_progress';
      step.startedAt ||= dateValue(now);
      step.tools = [...new Set([...(step.tools || []), String(toolName || '')].filter(Boolean))];
    }
  }, now);
}

export function markPlanToolCompleted(plan, toolName, now = new Date()) {
  return updatePlan(plan, (draft) => {
    const step = draft.steps.find((item) => item.status === 'in_progress' && item.id !== 'verify' && item.id !== 'respond');
    if (step) {
      step.status = 'completed';
      step.completedAt = dateValue(now);
      step.tools = [...new Set([...(step.tools || []), String(toolName || '')].filter(Boolean))];
    }
  }, now);
}

export function markPlanVerification(plan, verification, now = new Date()) {
  return updatePlan(plan, (draft) => {
    const verify = draft.steps.find((item) => item.id === 'verify');
    if (verify) {
      verify.status = verification.passed ? 'completed' : 'blocked';
      verify.completedAt = verification.passed ? dateValue(now) : null;
      verify.issues = verification.issues;
    }
    const respond = draft.steps.find((item) => item.id === 'respond');
    if (respond) respond.status = verification.passed ? 'completed' : 'pending';
    draft.status = verification.passed ? 'completed' : 'in_progress';
  }, now);
}

export function verifyAgentAnswer({ objective = '', answer = '', evidence = [], modelMessages = [], toolResults = [] } = {}) {
  const issues = [];
  const needsEvidence = requiresDataEvidence(objective);
  const historicalEvidence = (Array.isArray(modelMessages) ? modelMessages : [])
    .some((message) => String(message?.content || '').includes('Recorded result from'));
  const normalizedEvidence = normalizeEvidence(evidence);
  const completionReceipt = hasCompletionReceipt(toolResults);
  if (needsEvidence && normalizedEvidence.length === 0 && !historicalEvidence && !completionReceipt) {
    issues.push({ code: 'missing_data_evidence', message: '需要先调用数据工具并取得可追溯来源。' });
  }
  if (ARTIFACT_INTENT.test(String(objective || '')) && !hasArtifact(toolResults)) {
    issues.push({ code: 'missing_artifact', message: '请求包含导出或文件交付，但尚未生成持久化产物。' });
  }
  if (!String(answer || '').trim()) {
    issues.push({ code: 'empty_answer', message: '模型没有返回可展示的最终答复。' });
  }
  return {
    schemaVersion: 1,
    passed: issues.length === 0,
    issues,
    evidence: normalizedEvidence,
  };
}

export function collectToolEvidence(toolName, result) {
  const sources = new Set();
  visit(result, (key, value) => {
    if ((key === 'source' || key === 'sourceUri') && typeof value === 'string') sources.add(value);
    if (key === 'sources' && Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') sources.add(item);
    }
  });
  return [...sources].slice(0, 100).map((source) => ({ toolName: String(toolName || ''), source }));
}

export function planText(plan) {
  if (!plan?.steps) return '';
  return plan.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n');
}

export function verificationRepairInstruction(verification) {
  const issues = (verification?.issues || []).map((issue) => `- ${issue.message}`).join('\n');
  return [
    'Verifier rejected the draft answer. Continue the same run and repair every issue before answering:',
    issues,
    'Use the available tools. Do not claim completion until the required evidence or artifact exists.',
  ].join('\n');
}

function requiresDataEvidence(value) {
  return DATA_INTENT.test(String(value || ''));
}

function hasArtifact(results) {
  return (Array.isArray(results) ? results : []).some((item) => item?.type === 'artifact.ready' || item?.artifact?.artifactId);
}

function hasCompletionReceipt(results) {
  return (Array.isArray(results) ? results : []).some((item) => [
    'email.sent',
    'artifact.ready',
  ].includes(item?.type));
}

function normalizeEvidence(value) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    const source = String(item?.source || '').trim();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    result.push({ toolName: String(item?.toolName || ''), source });
  }
  return result.slice(0, 200);
}

function planStep(id, title, status, tools = []) {
  return { id, title, status, tools: [...new Set(tools)] };
}

function updatePlan(plan, operation, now) {
  if (!plan || typeof plan !== 'object') return plan;
  const draft = structuredClone(plan);
  operation(draft);
  draft.updatedAt = dateValue(now);
  return draft;
}

function isReadTool(name) {
  return !String(name).startsWith('artifact.') && !String(name).startsWith('email.');
}

function visit(value, callback, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) visit(item, callback, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    callback(key, item);
    visit(item, callback, depth + 1);
  }
}

function dateValue(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
