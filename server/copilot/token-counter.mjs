const DEFAULT_CHARS_PER_TOKEN = 3.5;

export class TokenCounter {
  constructor({ countTokens = null, model = '', charsPerToken = DEFAULT_CHARS_PER_TOKEN } = {}) {
    this.countTokens = typeof countTokens === 'function' ? countTokens : null;
    this.model = String(model || '');
    this.charsPerToken = Math.max(1, Number(charsPerToken) || DEFAULT_CHARS_PER_TOKEN);
  }

  count(value, options = {}) {
    const serialized = typeof value === 'string' ? value : stableSerialize(value);
    if (this.countTokens) {
      const result = Number(this.countTokens(serialized, { model: options.model || this.model, ...options }));
      if (Number.isFinite(result) && result >= 0) return { tokens: Math.ceil(result), method: 'provider' };
    }
    return { tokens: fallbackTokenEstimate(serialized, this.charsPerToken), method: 'fallback' };
  }

  countMessages(messages = [], options = {}) {
    const items = Array.isArray(messages) ? messages : [];
    const counts = items.map((message) => this.count(message, options));
    return {
      tokens: counts.reduce((total, item) => total + item.tokens + 4, 2),
      method: counts.every((item) => item.method === 'provider') ? 'provider' : 'fallback',
    };
  }
}

export function createTokenCounter(options) { return new TokenCounter(options); }

export function fallbackTokenEstimate(value, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const text = String(value || '');
  if (!text) return 1;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu) || []).length;
  const nonCjk = Math.max(0, text.length - cjk);
  const punctuation = (text.match(/[{}\[\]():,.;!?`"']/gu) || []).length;
  const whitespaceRuns = (text.match(/\s+/gu) || []).length;
  return Math.max(1, Math.ceil(cjk * 0.92 + nonCjk / Math.max(1, charsPerToken) + punctuation * 0.12 + whitespaceRuns * 0.08));
}

function stableSerialize(value) {
  try { return JSON.stringify(value ?? ''); } catch { return String(value ?? ''); }
}
