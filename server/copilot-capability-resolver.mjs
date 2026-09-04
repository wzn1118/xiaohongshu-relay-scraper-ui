const DEFAULT_LIMIT = 24;
const ALWAYS_AVAILABLE = Object.freeze([
  'tool.search',
  'tool.describe',
  'dataset.list',
  'workspace.list',
  'workspace.read',
  'agent.delegate',
  'agent.status',
]);

const DOMAIN_HINTS = Object.freeze([
  { pattern: /(?:\bsubagents?\b|\bdelegate\b|\bspecialists?\b|\bparallel\b|\u5b50agent|\u5b50\u4ee3\u7406|\u59d4\u6d3e|\u5e76\u884c|\u5206\u5de5)/iu, prefixes: ['agent.'] },
  { pattern: /(?:\bworkspace\b|\bfiles?\b|\bfolders?\b|\bdirector(?:y|ies)\b|\brepositor(?:y|ies)\b|\bsource\b|\bcode\b|\bpatch\b|\bedit\b|\bread\b|\bwrite\b|\u6587\u4ef6|\u76ee\u5f55|\u5de5\u4f5c\u533a|\u4ee3\u7801|\u6e90\u7801|\u4fee\u6539|\u8865\u4e01)/iu, prefixes: ['workspace.'] },
  { pattern: /(?:\bexec\b|\bshell\b|\bterminal\b|\bcommand\b|\bpowershell\b|\bbash\b|\bnpm\b|\bnode\b|\bpython\b|\btests?\b|\bbuild\b|\brun\b|\u547d\u4ee4|\u7ec8\u7aef|\u6267\u884c|\u8fd0\u884c|\u6d4b\u8bd5|\u6784\u5efa)/iu, prefixes: ['exec.'] },
  { pattern: /(?:\bhttps?\b|\bapi\b|\burls?\b|\brequest\b|\bendpoint\b|\bfetch\b|\u63a5\u53e3|\u8bf7\u6c42|\u7f51\u5740|\u94fe\u63a5)/iu, prefixes: ['http.'] },
  { pattern: /(?:\bmcp\b|\bmodel context protocol\b|\btool server\b|\u6a21\u578b\u4e0a\u4e0b\u6587\u534f\u8bae|\u5de5\u5177\u670d\u52a1\u5668)/iu, prefixes: ['mcp.'] },
  { pattern: /(?:\bjobs?\b|\bapplications?\b|岗位|职位|投递)/iu, prefixes: ['jobs.', 'applications.', 'records.'] },
  { pattern: /(?:\bposts?\b|\bcontent\b|正文|原帖|帖子|笔记|图片)/iu, prefixes: ['content.', 'records.', 'dataset.'] },
  { pattern: /(?:\baudience\b|\bcomments?\b|\busers?\b|评论|回复|用户|受众|主页)/iu, prefixes: ['audience.', 'comments.', 'users.', 'records.'] },
  { pattern: /(?:\bexpansion\b|\bgraph\b|扩散|关系|节点|边|路径)/iu, prefixes: ['expansion.', 'records.'] },
  { pattern: /(?:\battachments?\b|附件|上传|解析|ocr)/iu, prefixes: ['attachment.'] },
  { pattern: /(?:\bartifacts?\b|\bexports?\b|导出|表格|文件|报告|csv|xlsx|json|markdown|pdf|docx)/iu, prefixes: ['artifact.', 'records.'] },
  { pattern: /(?:\bemail\b|\bmail\b|邮件|发送|投递|收件人)/iu, prefixes: ['email.', 'applications.', 'artifact.'] },
  { pattern: /(?:\bcompare\b|\bfilter\b|\bgroup\b|\baggregate\b|\bsearch\b|比较|筛选|聚合|分组|搜索|统计)/iu, prefixes: ['records.', 'dataset.'] },
]);

export class CopilotCapabilityResolver {
  constructor({ maximumTools = DEFAULT_LIMIT, minimumTools = 6 } = {}) {
    this.maximumTools = bounded(maximumTools, DEFAULT_LIMIT, 4, 48);
    this.minimumTools = bounded(minimumTools, 6, 3, this.maximumTools);
  }

  resolve(catalog, { query = '', activeToolNames = [], plan = null, limit = this.maximumTools } = {}) {
    const definitions = normalizeCatalog(catalog);
    const maximum = bounded(limit, this.maximumTools, this.minimumTools, 48);
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));
    const planText = plan && typeof plan === 'object'
      ? JSON.stringify({ objective: plan.objective, steps: plan.steps })
      : '';
    const searchText = `${String(query || '')}\n${planText}`.trim();
    const ranked = searchToolCatalog(definitions, searchText, { limit: definitions.length });
    const orderedNames = [
      ...ALWAYS_AVAILABLE,
      ...normalizeNames(activeToolNames),
      ...ranked.map((definition) => definition.name),
      ...definitions.map((definition) => definition.name),
    ];
    const selected = [];
    const seen = new Set();
    for (const name of orderedNames) {
      const definition = byName.get(name);
      if (!definition || seen.has(name)) continue;
      seen.add(name);
      selected.push(definition);
      if (selected.length >= maximum) break;
    }
    return selected;
  }
}

export function searchToolCatalog(catalog, query = '', { limit = 20 } = {}) {
  const definitions = normalizeCatalog(catalog);
  const text = normalizeText(query);
  const tokens = tokenize(text);
  const hintedPrefixes = DOMAIN_HINTS
    .filter((hint) => hint.pattern.test(text))
    .flatMap((hint) => hint.prefixes);

  return definitions
    .map((definition, index) => ({ definition, index, score: scoreDefinition(definition, text, tokens, hintedPrefixes) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, bounded(limit, 20, 1, 200))
    .map(({ definition }) => definition);
}

function scoreDefinition(definition, text, tokens, hintedPrefixes) {
  const name = normalizeText(definition.name);
  const category = normalizeText(definition.category);
  const haystack = normalizeText([
    definition.name,
    definition.title,
    definition.description,
    definition.category,
    ...(Array.isArray(definition.tags) ? definition.tags : []),
  ].join(' '));
  let score = ALWAYS_AVAILABLE.includes(definition.name) ? 20 : 0;
  if (hintedPrefixes.some((prefix) => name.startsWith(prefix))) score += 40;
  for (const token of tokens) {
    if (name === token) score += 80;
    else if (name.includes(token)) score += 30;
    if (category === token) score += 20;
    if (haystack.includes(token)) score += 8;
  }
  if (text && haystack.includes(text)) score += 25;
  return score;
}

function normalizeCatalog(catalog) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((item) => item && typeof item === 'object' && String(item.name || '').trim())
    .map((item) => structuredClone(item));
}

function normalizeNames(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function tokenize(value) {
  const tokens = new Set(normalizeText(value).match(/[\p{L}\p{N}_.-]{2,}/gu) || []);
  for (const hint of DOMAIN_HINTS) {
    if (hint.pattern.test(value)) {
      for (const prefix of hint.prefixes) tokens.add(prefix.replace(/\.$/u, ''));
    }
  }
  return [...tokens].slice(0, 80);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}
