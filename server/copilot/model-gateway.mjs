const DEFAULT_TIMEOUT_MS = 120_000;

export class ModelGatewayError extends Error {
  constructor(code, message, status = 502, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ModelGatewayError';
    this.code = code;
    this.status = status;
  }
}

export class ModelGateway {
  constructor({ fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, providers = {} } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.providers = new Map(Object.entries(providers));
  }

  registerProvider(id, config = {}) {
    const providerId = String(id || '').trim();
    if (!providerId) throw new ModelGatewayError('MODEL_PROVIDER_ID_REQUIRED', 'Model provider ID is required.', 400);
    this.providers.set(providerId, { ...config });
    return this.describeProvider(providerId);
  }

  describeProvider(id) {
    const provider = this.providers.get(String(id || '').trim()) || {};
    const wireApi = provider.wireApi === 'responses' ? 'responses' : 'chat_completions';
    const capabilities = normalizeCapabilities(provider.capabilities, wireApi, provider.supportsStreaming);
    return {
      id: String(id || '').trim(),
      wireApi,
      baseUrl: String(provider.baseUrl || '').replace(/\/$/u, ''),
      configured: Boolean(provider.baseUrl),
      supportsStreaming: capabilities.streaming,
      capabilities,
    };
  }

  async complete(input = {}) {
    const request = this.#buildRequest(input, false);
    const response = await this.#fetch(request, input.signal);
    const body = await readJson(response);
    if (!response.ok) throw gatewayError(body?.error?.message || `Model request failed with ${response.status}.`, response.status);
    return normalizeCompletion(body, request.wireApi, request.body);
  }

  async retrieve({ provider: providerId, responseId, signal, ...input } = {}) {
    const provider = { ...(this.providers.get(String(providerId || '').trim()) || {}), ...input };
    const wireApi = provider.wireApi === 'responses' ? 'responses' : 'chat_completions';
    if (wireApi !== 'responses') throw new ModelGatewayError('MODEL_CAPABILITY_UNSUPPORTED', 'Response retrieval requires the Responses wire API.', 400);
    const baseUrl = String(provider.baseUrl || '').replace(/\/$/u, '');
    const id = String(responseId || '').trim();
    if (!baseUrl || !id) throw new ModelGatewayError('MODEL_CONFIGURATION_INCOMPLETE', 'Model base URL and response ID are required.', 400);
    const headers = this.#headers(provider);
    const response = await this.#fetch({ wireApi, url: `${baseUrl}/responses/${encodeURIComponent(id)}`, headers, method: 'GET' }, signal);
    const body = await readJson(response);
    if (!response.ok) throw classifyProviderError(body?.error?.message || `Model request failed with ${response.status}.`, response.status);
    return normalizeCompletion(body, wireApi, {});
  }

  async cancel({ provider: providerId, responseId, signal, ...input } = {}) {
    const provider = { ...(this.providers.get(String(providerId || '').trim()) || {}), ...input };
    const wireApi = provider.wireApi === 'responses' ? 'responses' : 'chat_completions';
    if (wireApi !== 'responses') throw new ModelGatewayError('MODEL_CAPABILITY_UNSUPPORTED', 'Response cancellation requires the Responses wire API.', 400);
    const capabilities = normalizeCapabilities(provider.capabilities, wireApi, provider.supportsStreaming);
    if (!capabilities.background) throw new ModelGatewayError('MODEL_CAPABILITY_UNSUPPORTED', 'This provider does not declare background response support.', 400);
    const baseUrl = String(provider.baseUrl || '').replace(/\/$/u, '');
    const id = String(responseId || '').trim();
    if (!baseUrl || !id) throw new ModelGatewayError('MODEL_CONFIGURATION_INCOMPLETE', 'Model base URL and response ID are required.', 400);
    const response = await this.#fetch({ wireApi, url: `${baseUrl}/responses/${encodeURIComponent(id)}/cancel`, headers: this.#headers(provider), method: 'POST', body: {} }, signal);
    const body = await readJson(response);
    if (!response.ok) throw classifyProviderError(body?.error?.message || `Model request failed with ${response.status}.`, response.status);
    return normalizeCompletion(body, wireApi, {});
  }

  async *stream(input = {}) {
    const request = this.#buildRequest(input, true);
    const response = await this.#fetch(request, input.signal);
    if (!response.ok) {
      const body = await readJson(response);
      throw gatewayError(body?.error?.message || `Model request failed with ${response.status}.`, response.status);
    }
    if (!response.body) throw gatewayError('The model returned an empty stream.', 502);
    const cancelBody = () => {
      void response.body.cancel?.(input.signal?.reason).catch?.(() => {});
    };
    input.signal?.addEventListener('abort', cancelBody, { once: true });
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        if (input.signal?.aborted) throw new ModelGatewayError('MODEL_REQUEST_ABORTED', 'Model request was aborted or timed out.', 504);
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const data = line.startsWith('data:') ? line.slice(5).trim() : '';
          if (!data || data === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          yield normalizeStreamEvent(parsed, request.wireApi, this.now);
        }
      }
    } finally {
      input.signal?.removeEventListener('abort', cancelBody);
    }
  }

  #buildRequest(input, stream) {
    const providerId = String(input.provider || '').trim();
    const provider = { ...(this.providers.get(providerId) || {}), ...input };
    const wireApi = provider.wireApi === 'responses' ? 'responses' : 'chat_completions';
    const capabilities = normalizeCapabilities(provider.capabilities, wireApi, provider.supportsStreaming);
    const baseUrl = String(provider.baseUrl || '').replace(/\/$/u, '');
    const model = String(provider.model || '').trim();
    if (!baseUrl || !model) throw new ModelGatewayError('MODEL_CONFIGURATION_INCOMPLETE', 'Model base URL and model are required.', 400);
    const urls = modelEndpointCandidates({ providerId, baseUrl }, wireApi);
    const url = urls[0];
    const headers = this.#headers(provider);
    if (stream) headers.Accept = 'text/event-stream, application/json';
    validateCapabilities(input, capabilities, wireApi, stream);
    const body = wireApi === 'responses'
      ? { model, input: input.input || input.messages || [], stream }
      : { model, messages: input.messages || [], stream };
    if (input.temperature !== undefined) body.temperature = Number(input.temperature);
    if (wireApi === 'responses') {
      if (input.previousResponseId) body.previous_response_id = String(input.previousResponseId);
      if (input.conversationId) body.conversation = String(input.conversationId);
      if (input.background === true) body.background = true;
      const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort);
      if (input.reasoningSummary || reasoningEffort) {
        body.reasoning = {
          ...(input.reasoningSummary ? { summary: String(input.reasoningSummary) } : {}),
          ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        };
      }
      if (input.maxOutputTokens !== undefined) body.max_output_tokens = positiveInteger(input.maxOutputTokens, 'maxOutputTokens');
      if (input.metadata && typeof input.metadata === 'object') body.metadata = structuredClone(input.metadata);
      if (Array.isArray(input.tools)) body.tools = structuredClone(input.tools);
      if (input.toolChoice !== undefined) body.tool_choice = structuredClone(input.toolChoice);
      if (input.store !== undefined) body.store = Boolean(input.store);
    } else if (input.maxOutputTokens !== undefined) {
      body.max_tokens = positiveInteger(input.maxOutputTokens, 'maxOutputTokens');
    }
    if (wireApi !== 'responses') {
      if (Array.isArray(input.tools)) body.tools = structuredClone(input.tools);
      if (input.toolChoice !== undefined) body.tool_choice = structuredClone(input.toolChoice);
    }
    return { providerId, wireApi, url, urls, headers, body, method: 'POST', capabilities };
  }

  #headers(provider) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (provider.apiKey) headers.Authorization = `Bearer ${String(provider.apiKey)}`;
    if (provider.organization) headers['OpenAI-Organization'] = String(provider.organization);
    if (provider.project) headers['OpenAI-Project'] = String(provider.project);
    return headers;
  }

  async #fetch(request, signal) {
    if (typeof this.fetchImpl !== 'function') throw new ModelGatewayError('MODEL_FETCH_UNAVAILABLE', 'Model fetch implementation is unavailable.', 503);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('model_timeout')), this.timeoutMs);
    const abort = () => controller.abort(signal?.reason || new Error('model_aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const urls = Array.isArray(request.urls) && request.urls.length ? request.urls : [request.url];
      for (const [index, url] of urls.entries()) {
        const response = await this.fetchImpl(url, {
          method: request.method || 'POST',
          headers: request.headers,
          ...(request.method === 'GET' ? {} : { body: JSON.stringify(request.body || {}) }),
          signal: controller.signal,
        });
        if (![404, 405].includes(response.status) || index === urls.length - 1) return response;
      }
      throw new ModelGatewayError('MODEL_REQUEST_FAILED', 'Model request did not produce a response.', 502);
    } catch (error) {
      if (controller.signal.aborted) throw new ModelGatewayError('MODEL_REQUEST_ABORTED', 'Model request was aborted or timed out.', 504, error);
      throw new ModelGatewayError('MODEL_REQUEST_FAILED', 'Model request failed.', 502, error);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export function createModelGateway(options) { return new ModelGateway(options); }

function normalizeCompletion(body, wireApi, requestBody = {}) {
  const text = wireApi === 'responses'
    ? extractResponseText(body)
    : body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || '';
  return {
    text: String(text || ''),
    model: String(body?.model || ''),
    usage: body?.usage || null,
    responseId: String(body?.id || ''),
    previousResponseId: String(body?.previous_response_id || requestBody?.previous_response_id || ''),
    conversationId: String(body?.conversation?.id || body?.conversation || requestBody?.conversation || ''),
    status: String(body?.status || (wireApi === 'responses' ? 'completed' : 'completed')),
    cursor: String(body?.cursor || body?.output_cursor || ''),
    background: Boolean(body?.background ?? requestBody?.background),
    error: body?.error || null,
    raw: body,
  };
}

function normalizeStreamEvent(value, wireApi, now) {
  const delta = wireApi === 'responses'
    ? value?.delta || value?.output_text?.delta || ''
    : value?.choices?.[0]?.delta?.content || '';
  return { type: delta ? 'message.delta' : String(value?.type || 'message.progress'), delta: String(delta || ''), occurredAt: now().toISOString(), raw: value };
}

function extractResponseText(body) {
  if (typeof body?.output_text === 'string') return body.output_text;
  return (body?.output || []).flatMap((item) => item?.content || []).map((part) => part?.text || '').join('');
}

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

function gatewayError(message, status) { return classifyProviderError(message, status); }

function normalizeCapabilities(value, wireApi, supportsStreaming) {
  const declared = value && typeof value === 'object' ? value : {};
  return {
    streaming: declared.streaming !== false && supportsStreaming !== false,
    background: wireApi === 'responses' && declared.background === true,
    statefulResponses: wireApi === 'responses' && declared.statefulResponses !== false,
    conversationState: wireApi === 'responses' && declared.conversationState === true,
    reasoningSummary: wireApi === 'responses' && declared.reasoningSummary === true,
    reasoningEffort: wireApi === 'responses' && declared.reasoningEffort !== false,
    structuredOutputs: declared.structuredOutputs === true,
    tools: declared.tools !== false,
    maxContextTokens: Number.isFinite(Number(declared.maxContextTokens)) ? Math.max(0, Math.floor(Number(declared.maxContextTokens))) : 0,
    inputModalities: Array.isArray(declared.inputModalities) ? declared.inputModalities.map(String) : ['text'],
  };
}

function validateCapabilities(input, capabilities, wireApi, stream) {
  const unsupported = [];
  if (stream && !capabilities.streaming) unsupported.push('streaming');
  if (input.background === true && !capabilities.background) unsupported.push('background');
  if (input.previousResponseId && !capabilities.statefulResponses) unsupported.push('previous_response_id');
  if (input.conversationId && !capabilities.conversationState) unsupported.push('conversation');
  if (input.reasoningSummary && !capabilities.reasoningSummary) unsupported.push('reasoning_summary');
  if (input.reasoningEffort && !capabilities.reasoningEffort) unsupported.push('reasoning_effort');
  if (Array.isArray(input.tools) && input.tools.length && !capabilities.tools) unsupported.push('tools');
  if (wireApi !== 'responses' && (input.background || input.previousResponseId || input.conversationId || input.reasoningSummary || input.reasoningEffort)) unsupported.push('responses_state');
  if (unsupported.length) {
    throw new ModelGatewayError('MODEL_CAPABILITY_UNSUPPORTED', `Provider does not support: ${[...new Set(unsupported)].join(', ')}.`, 400);
  }
}

function normalizeReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return '';
  const effort = String(value).trim().toLowerCase();
  if (['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort;
  throw new ModelGatewayError(
    'MODEL_REASONING_EFFORT_INVALID',
    'Reasoning effort must be none, low, medium, high, xhigh, or max.',
    400,
  );
}

function classifyProviderError(message, status) {
  const code = status === 401 || status === 403
    ? 'MODEL_AUTHENTICATION_FAILED'
    : status === 429
      ? 'MODEL_RATE_LIMITED'
      : status === 413
        ? 'MODEL_CONTEXT_EXCEEDED'
        : status === 404
          ? 'MODEL_NOT_FOUND'
          : status >= 500
            ? 'MODEL_PROVIDER_UNAVAILABLE'
            : 'MODEL_PROVIDER_ERROR';
  const error = new ModelGatewayError(code, String(message), status);
  error.retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  return error;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new ModelGatewayError('MODEL_PARAMETER_INVALID', `${name} must be a positive integer.`, 400);
  return Math.floor(number);
}

function modelEndpointCandidates({ providerId, baseUrl }, wireApi) {
  const endpoint = wireApi === 'responses' ? 'responses' : 'chat/completions';
  const direct = `${baseUrl}/${endpoint}`;
  let pathname = '';
  try {
    pathname = new URL(baseUrl).pathname.toLowerCase();
  } catch {
    return [direct];
  }
  if (pathname.endsWith('/v1')) return [direct];
  return ['relay', 'custom'].includes(String(providerId || '').toLowerCase())
    ? [`${baseUrl}/v1/${endpoint}`, direct]
    : [direct];
}
