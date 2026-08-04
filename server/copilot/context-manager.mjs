import { createCompactionService } from './compaction-service.mjs';
import { createTokenCounter, fallbackTokenEstimate } from './token-counter.mjs';

const DEFAULT_BUDGET = 24_000;
const PARTITION_ORDER = ['constraints', 'goal', 'recent_turns', 'sources', 'tools', 'memories'];

export class ContextManager {
  constructor({
    budget = DEFAULT_BUDGET,
    reservedOutputTokens = 2_048,
    tokenCounter = createTokenCounter(),
    compactionService = null,
    now = () => new Date(),
  } = {}) {
    this.budget = Math.max(256, Number(budget) || DEFAULT_BUDGET);
    this.reservedOutputTokens = Math.max(0, Number(reservedOutputTokens) || 0);
    this.tokenCounter = tokenCounter;
    this.compactionService = compactionService || createCompactionService({ tokenCounter, now });
    this.now = now;
  }

  buildWorkingSet({
    query = '',
    system = [],
    constraints = [],
    goal = null,
    messages = [],
    sources = [],
    tools = [],
    memories = [],
    pins = [],
    requiredContextIds = [],
    budget = this.budget,
    reservedOutputTokens = this.reservedOutputTokens,
    conversationId = '',
    runId = '',
    compact = true,
  } = {}) {
    const limit = Math.max(256, Number(budget) || this.budget);
    const reserved = Math.min(limit - 64, Math.max(0, Number(reservedOutputTokens) || 0));
    const available = Math.max(64, limit - reserved);
    const pinnedIds = new Set((Array.isArray(pins) ? pins : []).map(pinIdentity).filter(Boolean));
    const candidates = buildCandidates({ system, constraints, goal, messages, sources, tools, memories })
      .map((item) => {
        const count = this.tokenCounter.count(item.value);
        const pinned = pinnedIds.has(item.id) || item.value?.pinned === true;
        return {
          ...item,
          tokens: count.tokens,
          tokenMethod: count.method,
          pinned,
          relevance: relevanceScore(item, query),
        };
      });
    candidates.sort((left, right) => (
      Number(right.pinned) - Number(left.pinned)
      || PARTITION_ORDER.indexOf(left.partition) - PARTITION_ORDER.indexOf(right.partition)
      || right.relevance - left.relevance
      || right.recency - left.recency
      || left.tokens - right.tokens
      || left.id.localeCompare(right.id)
    ));

    const included = [];
    const excluded = [];
    let usedTokens = 0;
    for (const item of candidates) {
      const fits = usedTokens + item.tokens <= available;
      if (fits || item.pinned || included.length === 0) {
        included.push(item);
        usedTokens += item.tokens;
      } else {
        excluded.push({ id: item.id, type: item.type, partition: item.partition, tokens: item.tokens, reason: 'budget' });
      }
    }

    const selectedIds = new Set(included.map((item) => item.id));
    const missingRequired = (Array.isArray(requiredContextIds) ? requiredContextIds : [])
      .map(String)
      .filter((id) => id && !selectedIds.has(id));
    const pinnedOverflow = included.filter((item) => item.pinned).length > 0 && usedTokens > available;
    const missingContext = [
      ...(missingRequired.length ? [{ code: 'required_context_missing', itemIds: missingRequired }] : []),
      ...(pinnedOverflow ? [{ code: 'pinned_context_exceeds_budget', overflowTokens: usedTokens - available }] : []),
    ];
    const omittedMessages = excluded
      .filter((item) => item.type === 'message')
      .map((item) => candidates.find((candidate) => candidate.id === item.id)?.value)
      .filter(Boolean);
    const compaction = compact && omittedMessages.length
      ? this.compactionService.compact({ conversationId, runId, items: omittedMessages, preserveSourceRefs: included.flatMap((item) => sourceRefs(item.value)) })
      : null;
    const partitions = partitionReport(candidates, included, excluded);
    return {
      schemaVersion: 2,
      query: String(query || '').trim(),
      budget: limit,
      availableTokens: available,
      reservedOutputTokens: reserved,
      usedTokens,
      remainingTokens: Math.max(0, available - usedTokens),
      tokenMethod: candidates.every((item) => item.tokenMethod === 'provider') ? 'provider' : 'fallback',
      included: included.map(({ type, id, partition, value, tokens, tokenMethod, relevance, pinned }) => ({
        type, id, partition, value, tokens, tokenMethod, relevance, pinned,
      })),
      excluded,
      partitions,
      pins: included.filter((item) => item.pinned).map((item) => ({ id: item.id, partition: item.partition, tokens: item.tokens })),
      missingContext,
      canExecute: missingContext.length === 0,
      compaction,
      summary: `${included.length} items selected, ${excluded.length} omitted, ${usedTokens}/${available} input tokens`,
      createdAt: this.now().toISOString(),
    };
  }
}

export function createContextManager(options) { return new ContextManager(options); }
export function estimateTokens(value) { return fallbackTokenEstimate(typeof value === 'string' ? value : JSON.stringify(value ?? '')); }

function buildCandidates({ system, constraints, goal, messages, sources, tools, memories }) {
  const values = [];
  const append = (items, config) => {
    const list = Array.isArray(items) ? items : items === null || items === undefined ? [] : [items];
    list.forEach((value, index) => values.push({
      type: config.type,
      partition: config.partition,
      id: identity(value, config.idKeys, `${config.type}-${index}`),
      value,
      recency: config.recency ? index / Math.max(1, list.length - 1) : 0,
    }));
  };
  append(system, { type: 'constraint', partition: 'constraints', idKeys: ['constraintId', 'id'] });
  append(constraints, { type: 'constraint', partition: 'constraints', idKeys: ['constraintId', 'id'] });
  append(goal, { type: 'goal', partition: 'goal', idKeys: ['goalId', 'id'] });
  append(messages, { type: 'message', partition: 'recent_turns', idKeys: ['messageId', 'id'], recency: true });
  append(sources, { type: 'source', partition: 'sources', idKeys: ['sourceId', 'id', 'uri'] });
  append(tools, { type: 'tool', partition: 'tools', idKeys: ['name', 'id'] });
  append(memories, { type: 'memory', partition: 'memories', idKeys: ['memoryId', 'id'] });
  return values;
}

function relevanceScore(item, query) {
  const terms = lexicalTerms(query);
  if (!terms.length) return Number(item.value?.priority || 0) / 100 + item.recency * 0.2;
  const fields = searchableFields(item.value);
  const haystackTerms = lexicalTerms(fields.join(' '));
  const frequencies = new Map();
  haystackTerms.forEach((term) => frequencies.set(term, (frequencies.get(term) || 0) + 1));
  const lengthNorm = 1 + Math.max(0, haystackTerms.length - 40) / 80;
  const lexical = terms.reduce((total, term) => total + Math.min(3, frequencies.get(term) || 0), 0) / lengthNorm;
  const sourceQuality = Math.max(0, Math.min(1, Number(item.value?.quality ?? item.value?.confidence ?? 0)));
  return lexical + item.recency * 0.25 + Number(item.value?.priority || 0) / 100 + sourceQuality * 0.35;
}

function lexicalTerms(value) {
  const text = String(value || '').toLocaleLowerCase();
  const words = text.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]/gu) || [];
  const cjk = words.filter((term) => /[\u3400-\u9fff]/u.test(term));
  const bigrams = cjk.slice(0, -1).map((term, index) => `${term}${cjk[index + 1]}`);
  return [...words, ...bigrams].slice(0, 5000);
}

function searchableFields(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [String(value ?? '')];
  return ['title', 'name', 'label', 'content', 'text', 'summary', 'description', 'kind']
    .map((key) => value[key])
    .filter((item) => typeof item === 'string');
}

function partitionReport(candidates, included, excluded) {
  return PARTITION_ORDER.map((partition) => {
    const all = candidates.filter((item) => item.partition === partition);
    const selected = included.filter((item) => item.partition === partition);
    return {
      id: partition,
      totalItems: all.length,
      includedItems: selected.length,
      excludedItems: excluded.filter((item) => item.partition === partition).length,
      tokens: selected.reduce((total, item) => total + item.tokens, 0),
      pinnedItems: selected.filter((item) => item.pinned).length,
    };
  });
}

function pinIdentity(value) {
  if (typeof value === 'string') return value;
  return String(value?.itemId || value?.id || '');
}

function identity(value, keys, fallback) {
  if (typeof value === 'string') return fallback;
  for (const key of keys) {
    const result = String(value?.[key] || '').trim();
    if (result) return result;
  }
  return fallback;
}

function sourceRefs(value) {
  const refs = value?.sourceRefs || value?.metadata?.sourceRefs || [];
  return Array.isArray(refs) ? refs.map(String).filter(Boolean) : [];
}
