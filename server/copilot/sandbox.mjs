import { answerAstFromText, normalizeAnswerAst } from './answer-ast.mjs';

const SQL_PATTERN = /^select\s+(?<select>.+?)\s+from\s+(?<table>[A-Za-z_][\w]*)\s*(?:where\s+(?<where>.+?))?\s*(?:group\s+by\s+(?<groupBy>[A-Za-z_][\w]*))?\s*(?:order\s+by\s+(?<orderBy>[A-Za-z_][\w]*)(?:\s+(?<direction>asc|desc))?)?\s*(?:limit\s+(?<limit>\d+))?\s*;?$/iu;

function rows(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => structuredClone(item))
    : [];
}

export function profileRows(input = []) {
  const data = rows(input);
  const columns = [...new Set(data.flatMap((row) => Object.keys(row)))];
  return {
    rowCount: data.length,
    columns: columns.map((name) => {
      const values = data.map((row) => row[name]).filter((value) => value !== null && value !== undefined);
      const numeric = values.map(Number).filter(Number.isFinite);
      return {
        name,
        nonNull: values.length,
        nullCount: data.length - values.length,
        distinct: new Set(values.map(stableValue)).size,
        type: inferType(values),
        sample: values[0] ?? null,
        ...(numeric.length ? { min: Math.min(...numeric), max: Math.max(...numeric), mean: numeric.reduce((sum, value) => sum + value, 0) / numeric.length } : {}),
      };
    }),
  };
}

export function aggregateRows(input = [], { groupBy, metric, operation = 'count' } = {}) {
  const data = rows(input);
  const groups = new Map();
  for (const row of data) {
    const key = groupBy ? String(row[groupBy] ?? '') : '__all__';
    const entry = groups.get(key) || { [groupBy || 'group']: groupBy ? row[groupBy] ?? null : 'all', values: [] };
    if (metric) entry.values.push(Number(row[metric])); else entry.values.push(1);
    groups.set(key, entry);
  }
  return [...groups.values()].map(({ values, ...entry }) => {
    const numeric = values.filter(Number.isFinite);
    const value = operation === 'sum'
      ? numeric.reduce((sum, item) => sum + item, 0)
      : operation === 'avg'
        ? numeric.reduce((sum, item) => sum + item, 0) / Math.max(1, numeric.length)
        : operation === 'min'
          ? (numeric.length ? Math.min(...numeric) : null)
          : operation === 'max'
            ? (numeric.length ? Math.max(...numeric) : null)
            : values.length;
    return { ...entry, value };
  }).sort((left, right) => Number(right.value ?? 0) - Number(left.value ?? 0) || String(left[groupBy || 'group']).localeCompare(String(right[groupBy || 'group'])));
}

export function queryRows(input = [], { sql = '', table = 'data' } = {}) {
  const source = rows(input);
  const query = String(sql || '').trim();
  if (/\b(insert|update|delete|drop|alter|create|attach|pragma|copy|vacuum)\b/iu.test(query)) {
    throw sandboxError('SANDBOX_SQL_READ_ONLY', 'Only read-only SELECT statements are supported.');
  }
  const match = SQL_PATTERN.exec(query);
  if (!match?.groups || match.groups.table.toLowerCase() !== String(table).toLowerCase()) {
    throw sandboxError('SANDBOX_SQL_INVALID', `Use a single SELECT statement against table ${table}.`);
  }
  const selectors = splitCsv(match.groups.select);
  const filtered = match.groups.where ? source.filter(buildWherePredicate(match.groups.where)) : source;
  let result;
  const aggregate = selectors.find((selector) => /^(count|sum|avg|min|max)\s*\(/iu.test(selector));
  if (match.groups.groupBy || aggregate) {
    const parsed = parseAggregate(aggregate || 'count(*)');
    result = aggregateRows(filtered, { groupBy: match.groups.groupBy, metric: parsed.metric, operation: parsed.operation });
    const alias = parsed.alias || 'value';
    if (alias !== 'value') result = result.map(({ value, ...row }) => ({ ...row, [alias]: value }));
  } else {
    result = selectors.length === 1 && selectors[0] === '*'
      ? filtered
      : filtered.map((row) => Object.fromEntries(selectors.map((selector) => {
        const column = selector.replace(/\s+as\s+[A-Za-z_][\w]*$/iu, '').trim();
        const alias = /\s+as\s+(?<alias>[A-Za-z_][\w]*)$/iu.exec(selector)?.groups?.alias || column;
        return [alias, row[column]];
      })));
  }
  if (match.groups.orderBy) {
    const column = match.groups.orderBy;
    const direction = match.groups.direction?.toLowerCase() === 'desc' ? -1 : 1;
    result.sort((left, right) => compareValues(left[column], right[column]) * direction);
  }
  const limit = Math.min(1000, Math.max(1, Number(match.groups.limit || 100)));
  return { columns: [...new Set(result.flatMap((row) => Object.keys(row)))], rows: result.slice(0, limit), rowCount: result.length, truncated: result.length > limit };
}

export function analyzeRows(input = [], spec = {}) {
  const operation = String(spec.operation || 'profile');
  if (operation === 'profile') return profileRows(input);
  if (operation === 'aggregate') return {
    rows: aggregateRows(input, {
      ...spec,
      operation: String(spec.aggregation || spec.method || 'count'),
    }),
  };
  if (operation === 'correlation') return correlationMatrix(input, spec.columns);
  throw sandboxError('SANDBOX_ANALYSIS_UNSUPPORTED', `Unsupported analysis operation: ${operation}.`);
}

export function createChartSpec(input = [], { type = 'bar', x, y, title = '' } = {}) {
  const supported = new Set(['bar', 'line', 'area', 'scatter', 'pie']);
  const chartType = supported.has(String(type)) ? String(type) : 'bar';
  const data = rows(input).slice(0, 500);
  if (!x || !y) throw sandboxError('SANDBOX_CHART_FIELDS_REQUIRED', 'Chart x and y fields are required.');
  return {
    schemaVersion: 1,
    kind: 'chart',
    type: chartType,
    title: String(title || ''),
    data,
    encoding: { x: { field: String(x) }, y: { field: String(y), type: 'quantitative' } },
  };
}

export function composeReport({ title = 'Analysis report', summary = '', sections = [], evidence = [] } = {}) {
  const blocks = [{ kind: 'heading', level: 1, content: String(title) }];
  if (summary) blocks.push(...answerAstFromText(String(summary)).blocks);
  for (const section of Array.isArray(sections) ? sections : []) {
    blocks.push({ kind: 'heading', level: 2, content: String(section.title || 'Section') });
    blocks.push(...answerAstFromText(String(section.content || '')).blocks);
  }
  for (const item of Array.isArray(evidence) ? evidence : []) {
    blocks.push({ kind: 'citation', content: structuredClone(item), sourceRefs: item.sourceId ? [String(item.sourceId)] : [] });
  }
  return normalizeAnswerAst({ blocks, metadata: { generatedBy: 'report.compose' } });
}

export function semanticSearch(items = [], { query = '', limit = 10, fields = [] } = {}) {
  const terms = [...tokenize(query)];
  const maximum = Math.min(100, Math.max(1, Number(limit) || 10));
  return rows(items).map((item, index) => {
    const selected = fields.length ? fields.map((field) => item[field]) : Object.values(item);
    const tokens = tokenize(selected.join(' '));
    const matches = terms.filter((term) => tokens.has(term)).length;
    const score = terms.length ? matches / terms.length : 0;
    return { item, score, index };
  }).filter((result) => result.score > 0 || terms.length === 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maximum)
    .map(({ item, score }) => ({ item, score }));
}

export function createReadOnlySandbox() {
  const tools = Object.freeze({
    'dataset.profile': ({ rows: value = [] } = {}) => profileRows(value),
    'sql.query': ({ rows: value = [], ...options } = {}) => queryRows(value, options),
    'python.analyze': ({ rows: value = [], ...options } = {}) => analyzeRows(value, options),
    'chart.create': ({ rows: value = [], ...options } = {}) => createChartSpec(value, options),
    'report.compose': (options = {}) => composeReport(options),
    'semantic.search': ({ items = [], ...options } = {}) => semanticSearch(items, options),
  });
  return Object.freeze({
    tools,
    listTools: () => Object.keys(tools),
    execute: async (name, input = {}) => {
      const tool = tools[String(name || '')];
      if (!tool) throw sandboxError('SANDBOX_TOOL_NOT_FOUND', `Unknown sandbox tool: ${name}.`, 404);
      return structuredClone(await tool(structuredClone(input)));
    },
    profileRows,
    aggregateRows,
    queryRows,
    analyzeRows,
    createChartSpec,
    composeReport,
    semanticSearch,
  });
}

function buildWherePredicate(expression) {
  const match = /^([A-Za-z_][\w]*)\s*(=|!=|>=|<=|>|<)\s*(.+)$/u.exec(expression.trim());
  if (!match) throw sandboxError('SANDBOX_SQL_WHERE_INVALID', 'WHERE supports one simple column comparison.');
  const [, column, operator, raw] = match;
  const expected = parseLiteral(raw);
  return (row) => {
    const actual = row[column];
    if (operator === '=') return actual == expected; // SQL-like scalar coercion.
    if (operator === '!=') return actual != expected;
    if (operator === '>') return actual > expected;
    if (operator === '<') return actual < expected;
    if (operator === '>=') return actual >= expected;
    return actual <= expected;
  };
}

function parseAggregate(value) {
  const match = /^(count|sum|avg|min|max)\s*\(\s*([A-Za-z_][\w]*|\*)\s*\)(?:\s+as\s+([A-Za-z_][\w]*))?$/iu.exec(String(value || '').trim());
  if (!match) throw sandboxError('SANDBOX_SQL_AGGREGATE_INVALID', 'Unsupported aggregate expression.');
  return { operation: match[1].toLowerCase(), metric: match[2] === '*' ? undefined : match[2], alias: match[3] || 'value' };
}

function correlationMatrix(input, fields = []) {
  const data = rows(input);
  const columns = (Array.isArray(fields) && fields.length ? fields : [...new Set(data.flatMap((row) => Object.keys(row)))])
    .filter((field) => data.some((row) => Number.isFinite(Number(row[field]))));
  return {
    columns,
    matrix: columns.map((left) => columns.map((right) => pearson(data.map((row) => [Number(row[left]), Number(row[right])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))))),
  };
}

function pearson(pairs) {
  if (pairs.length < 2) return null;
  const count = pairs.length;
  const sumX = pairs.reduce((sum, pair) => sum + pair[0], 0);
  const sumY = pairs.reduce((sum, pair) => sum + pair[1], 0);
  const numerator = count * pairs.reduce((sum, pair) => sum + pair[0] * pair[1], 0) - sumX * sumY;
  const denominator = Math.sqrt((count * pairs.reduce((sum, pair) => sum + pair[0] ** 2, 0) - sumX ** 2) * (count * pairs.reduce((sum, pair) => sum + pair[1] ** 2, 0) - sumY ** 2));
  return denominator ? numerator / denominator : null;
}

function inferType(values) {
  if (!values.length) return 'unknown';
  if (values.every((value) => typeof value === 'boolean')) return 'boolean';
  if (values.every((value) => Number.isFinite(Number(value)))) return 'number';
  if (values.every((value) => !Number.isNaN(Date.parse(String(value))))) return 'date';
  return 'string';
}

function splitCsv(value) { return String(value).split(',').map((item) => item.trim()).filter(Boolean); }
function parseLiteral(value) { const text = String(value).trim(); if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) return text.slice(1, -1); if (/^null$/iu.test(text)) return null; if (/^(true|false)$/iu.test(text)) return text.toLowerCase() === 'true'; return Number.isFinite(Number(text)) ? Number(text) : text; }
function stableValue(value) { return typeof value === 'object' ? JSON.stringify(value) : `${typeof value}:${String(value)}`; }
function compareValues(left, right) { if (left === right) return 0; if (left === null || left === undefined) return 1; if (right === null || right === undefined) return -1; return typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right)); }
function tokenize(value) { return new Set(String(value || '').toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []); }
function sandboxError(code, message, status = 400) { const error = new Error(message); error.name = 'SandboxError'; error.code = code; error.status = status; return error; }
