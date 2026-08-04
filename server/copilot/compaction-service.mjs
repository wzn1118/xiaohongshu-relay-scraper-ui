import crypto from 'node:crypto';

import { createTokenCounter } from './token-counter.mjs';

export class CompactionService {
  constructor({ tokenCounter = createTokenCounter(), now = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    this.tokenCounter = tokenCounter;
    this.now = now;
    this.idFactory = idFactory;
  }

  compact({ conversationId = '', runId = '', items = [], preserveSourceRefs = [] } = {}) {
    const records = Array.isArray(items) ? items : [];
    const summary = {
      facts: unique(records.flatMap((item) => taggedValues(item, 'facts', ['fact']))),
      decisions: unique(records.flatMap((item) => taggedValues(item, 'decisions', ['decision']))),
      openQuestions: unique(records.flatMap((item) => taggedValues(item, 'openQuestions', ['question', 'open_question']))),
      constraints: unique(records.flatMap((item) => taggedValues(item, 'constraints', ['constraint']))),
      sourceRefs: unique([
        ...preserveSourceRefs.map(String),
        ...records.flatMap((item) => sourceRefs(item)),
      ]),
      invalidationConditions: unique(records.flatMap((item) => taggedValues(item, 'invalidationConditions', ['invalidation']))),
    };
    const inputTokens = records.reduce((total, item) => total + this.tokenCounter.count(item).tokens, 0);
    const outputTokens = this.tokenCounter.count(summary).tokens;
    return {
      schemaVersion: 2,
      compactionId: this.idFactory(),
      conversationId: String(conversationId || ''),
      runId: String(runId || ''),
      summary,
      sourceRefs: summary.sourceRefs,
      inputTokens,
      outputTokens,
      createdAt: this.now().toISOString(),
    };
  }
}

export function createCompactionService(options) { return new CompactionService(options); }

function taggedValues(item, field, tags) {
  const direct = Array.isArray(item?.[field]) ? item[field] : [];
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const tagged = tags.includes(String(metadata.kind || metadata.type || '').toLowerCase())
    ? [item?.content || item?.text || item?.value]
    : [];
  return [...direct, ...tagged].map(toText).filter(Boolean);
}

function sourceRefs(item) {
  const refs = item?.sourceRefs || item?.metadata?.sourceRefs || [];
  return Array.isArray(refs) ? refs.map(String).filter(Boolean) : [];
}

function unique(values) { return [...new Set(values.map(toText).filter(Boolean))]; }
function toText(value) { return typeof value === 'string' ? value.trim().slice(0, 4000) : ''; }
