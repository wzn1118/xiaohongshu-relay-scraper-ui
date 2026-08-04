export class UsageTracker {
  constructor({ now = () => new Date() } = {}) { this.now = now; this.records = []; }

  record(value = {}) {
    const record = {
      occurredAt: String(value.occurredAt || this.now().toISOString()),
      conversationId: String(value.conversationId || ''),
      runId: String(value.runId || ''),
      provider: String(value.provider || ''),
      model: String(value.model || ''),
      inputTokens: count(value.inputTokens ?? value.prompt_tokens),
      outputTokens: count(value.outputTokens ?? value.completion_tokens),
      toolCalls: count(value.toolCalls),
      latencyMs: count(value.latencyMs),
    };
    this.records.push(record);
    if (this.records.length > 10_000) this.records.splice(0, this.records.length - 10_000);
    return structuredClone(record);
  }

  summarize({ conversationId = '', runId = '' } = {}) {
    const records = this.records.filter((record) => (!conversationId || record.conversationId === conversationId) && (!runId || record.runId === runId));
    return {
      records: records.length,
      inputTokens: records.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: records.reduce((sum, item) => sum + item.outputTokens, 0),
      toolCalls: records.reduce((sum, item) => sum + item.toolCalls, 0),
      latencyMs: records.reduce((sum, item) => sum + item.latencyMs, 0),
    };
  }
}

export function createUsageTracker(options) { return new UsageTracker(options); }
function count(value) { const number = Number(value || 0); return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0; }
