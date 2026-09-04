import crypto from 'node:crypto';
import { createModelGateway } from './copilot/model-gateway.mjs';
import { createProxyAwareFetch } from './lib/proxy-aware-fetch.mjs';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const MAX_LATENCY_SAMPLES = 100;

export function createCodexModelBridgeService({
  aiSessions,
  preferredProvider = '',
  fetchImpl = null,
  gateway = null,
  token = crypto.randomBytes(32).toString('base64url'),
  now = () => new Date(),
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (!aiSessions?.controlProvider) throw new TypeError('AI session store with controlProvider() is required.');
  const modelGateway = gateway || createModelGateway({
    fetchImpl: fetchImpl || createProxyAwareFetch(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  const bridgeToken = String(token || '');
  let requestCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let lastRequestAt = null;
  let lastCompletedAt = null;
  let lastError = null;
  let lastRequest = null;
  let inFlightCount = 0;
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let lastFailureAt = null;
  let lastLatencyMs = null;
  let latencySamples = [];
  let probeCount = 0;
  let probeFailedCount = 0;
  let lastProbe = null;

  function authorize({ authorization = '', remoteAddress = '' } = {}) {
    if (!isLoopbackAddress(remoteAddress)) {
      throw bridgeError('CODEX_MODEL_BRIDGE_LOOPBACK_REQUIRED', 'The Codex model bridge accepts loopback requests only.', 403);
    }
    const presented = /^Bearer\s+(.+)$/iu.exec(String(authorization || ''))?.[1] || '';
    if (!secureEqual(bridgeToken, presented)) {
      throw bridgeError('CODEX_MODEL_BRIDGE_UNAUTHORIZED', 'The Codex model bridge credential is invalid.', 401);
    }
  }

  function status() {
    const upstream = aiSessions.controlProviderStatus?.(preferredProvider) || { configured: false };
    const configured = Boolean(upstream.configured);
    return {
      configured,
      protocol: 'responses-v1',
      transport: 'loopback-http-sse',
      endpoint: '/api/codex-model/v1/responses',
      probeEndpoint: '/api/codex-model/probe',
      upstream,
      requests: requestCount,
      completed: completedCount,
      failed: failedCount,
      lastRequestAt,
      lastCompletedAt,
      lastError,
      lastRequest,
      health: {
        state: configured ? (consecutiveFailures > 0 ? 'degraded' : lastSuccessAt ? 'ready' : 'unknown') : 'unconfigured',
        inFlight: inFlightCount,
        consecutiveFailures,
        lastSuccessAt,
        lastFailureAt,
        latency: {
          samples: latencySamples.length,
          lastMs: lastLatencyMs,
          p50Ms: percentile(latencySamples, 0.5),
          p95Ms: percentile(latencySamples, 0.95),
        },
        reliability: modelGateway.reliability?.() || {
          timeoutMs: DEFAULT_TIMEOUT_MS,
          retryAttempts: 3,
          retryDelayMs: 400,
        },
        probes: {
          total: probeCount,
          failed: probeFailedCount,
          last: lastProbe,
        },
      },
    };
  }

  async function probe({ signal } = {}) {
    probeCount += 1;
    const startedAtMs = beginOperation();
    const checkedAt = now().toISOString();
    const upstream = aiSessions.controlProvider(preferredProvider);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('codex_model_probe_timeout')), Math.max(1_000, Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS));
    const abort = () => controller.abort(signal?.reason || new Error('codex_model_probe_aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const completion = await modelGateway.complete({
        provider: upstream.provider,
        ...upstream,
        messages: [
          { role: 'system', content: 'This is a model health check. Reply with exactly READY.' },
          { role: 'user', content: 'READY' },
        ],
        maxOutputTokens: 32,
        temperature: 0,
        signal: controller.signal,
      });
      const latencyMs = recordHealthy(startedAtMs);
      const text = completionText(completion).slice(0, 120);
      lastProbe = {
        ok: true,
        checkedAt,
        latencyMs,
        provider: String(upstream.provider || ''),
        model: String(upstream.model || ''),
        response: text,
      };
      return { ...lastProbe, health: status().health };
    } catch (error) {
      probeFailedCount += 1;
      recordUnhealthy(error, startedAtMs, { countFailure: false });
      lastProbe = {
        ok: false,
        checkedAt,
        latencyMs: lastLatencyMs,
        provider: String(upstream.provider || ''),
        model: String(upstream.model || ''),
        error: sanitizeError(error),
      };
      throw bridgeError('CODEX_MODEL_PROBE_FAILED', `Codex model probe failed: ${String(error?.message || error)}`, Number(error?.status) || 502, {
        probe: lastProbe,
        health: status().health,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function responses(body = {}, { authorization = '', remoteAddress = '', signal } = {}) {
    authorize({ authorization, remoteAddress });
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw bridgeError('CODEX_MODEL_BRIDGE_BODY_INVALID', 'A Responses API request body is required.', 400);
    }
    requestCount += 1;
    const startedAtMs = beginOperation();
    lastRequestAt = now().toISOString();
    lastError = null;
    const upstream = aiSessions.controlProvider(preferredProvider);
    const additionalTools = extractAdditionalTools(body.input);
    lastRequest = {
      stream: body.stream === true,
      requestedModel: String(body.model || ''),
      upstreamProvider: upstream.provider,
      upstreamModel: upstream.model,
      upstreamWireApi: upstream.wireApi,
      fields: Object.keys(body).sort(),
      inputItems: Array.isArray(body.input) ? body.input.length : (body.input == null ? 0 : 1),
      inputItemTypes: Array.isArray(body.input)
        ? [...new Set(body.input.map((item) => String(item?.type || typeof item)))]
        : [typeof body.input],
      instructionsLength: String(body.instructions || '').length,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      toolNames: Array.isArray(body.tools)
        ? body.tools.map((tool) => String(tool?.name || tool?.function?.name || '')).filter(Boolean).slice(0, 100)
        : [],
      additionalToolCount: additionalTools.length,
      additionalToolNames: additionalTools.map((tool) => String(tool?.name || tool?.function?.name || '')).filter(Boolean).slice(0, 100),
    };
    try {
      if (upstream.wireApi === 'responses') {
        const result = await passThroughResponses(modelGateway, upstream, body, { signal });
        if (!result.stream) recordCompleted(startedAtMs);
        return result.stream ? { ...result, events: countStream(result.events, startedAtMs) } : result;
      }
      const mapped = mapResponsesToChat(body);
      if (body.stream === true) {
        const events = await createChatResponseStream(modelGateway, upstream, body, mapped, { signal, now });
        return { stream: true, events: countStream(events, startedAtMs) };
      }
      const completion = await modelGateway.complete({
        provider: upstream.provider,
        ...upstream,
        messages: mapped.messages,
        tools: mapped.tools,
        toolChoice: mapped.toolChoice,
        reasoningEffort: body?.reasoning?.effort,
        maxOutputTokens: body.max_output_tokens,
        temperature: body.temperature,
        signal,
      });
      recordCompleted(startedAtMs);
      return {
        stream: false,
        body: chatCompletionToResponse(completion.raw, body, mapped, { now }),
      };
    } catch (error) {
      recordFailed(error, startedAtMs);
      throw error;
    }
  }

  function beginOperation() {
    inFlightCount += 1;
    return timestampMs(now());
  }

  function recordHealthy(startedAtMs) {
    inFlightCount = Math.max(0, inFlightCount - 1);
    consecutiveFailures = 0;
    lastSuccessAt = now().toISOString();
    lastError = null;
    return recordLatency(startedAtMs);
  }

  function recordUnhealthy(error, startedAtMs, { countFailure = true } = {}) {
    inFlightCount = Math.max(0, inFlightCount - 1);
    consecutiveFailures += 1;
    lastFailureAt = now().toISOString();
    recordLatency(startedAtMs);
    if (countFailure) failedCount += 1;
    lastError = sanitizeError(error, now().toISOString());
  }

  function recordCompleted(startedAtMs) {
    completedCount += 1;
    lastCompletedAt = now().toISOString();
    recordHealthy(startedAtMs);
  }

  function recordFailed(error, startedAtMs) {
    recordUnhealthy(error, startedAtMs);
  }

  function recordLatency(startedAtMs) {
    const latencyMs = Math.max(0, timestampMs(now()) - startedAtMs);
    lastLatencyMs = latencyMs;
    latencySamples = [...latencySamples, latencyMs].slice(-MAX_LATENCY_SAMPLES);
    return latencyMs;
  }

  async function* countStream(events, startedAtMs) {
    try {
      for await (const event of events) yield event;
      recordCompleted(startedAtMs);
    } catch (error) {
      recordFailed(error, startedAtMs);
      throw error;
    }
  }

  return Object.freeze({ token: bridgeToken, authorize, probe, responses, status });
}

async function passThroughResponses(gateway, upstream, body, { signal } = {}) {
  const input = prependInstructions(body.instructions, body.input);
  const request = {
    provider: upstream.provider,
    ...upstream,
    input,
    previousResponseId: body.previous_response_id,
    conversationId: typeof body.conversation === 'string' ? body.conversation : body.conversation?.id,
    background: body.background,
    reasoningEffort: body?.reasoning?.effort,
    reasoningSummary: body?.reasoning?.summary,
    maxOutputTokens: body.max_output_tokens,
    metadata: body.metadata,
    tools: body.tools,
    toolChoice: body.tool_choice,
    store: body.store,
    temperature: body.temperature,
    signal,
  };
  if (body.stream === true) {
    const iterator = gateway.stream(request)[Symbol.asyncIterator]();
    const first = await iterator.next();
    return { stream: true, events: rawResponseEvents(iterator, first) };
  }
  const completion = await gateway.complete(request);
  return { stream: false, body: completion.raw };
}

async function* rawResponseEvents(iterator, first) {
  if (!first.done && first.value?.raw) yield first.value.raw;
  while (true) {
    const next = await iterator.next();
    if (next.done) return;
    if (next.value?.raw) yield next.value.raw;
  }
}

export function mapResponsesToChat(body = {}) {
  const messages = [];
  if (String(body.instructions || '').trim()) messages.push({ role: 'system', content: String(body.instructions) });
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) appendResponseInput(messages, item);
  }
  const toolTypes = new Map();
  const responseTools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...extractAdditionalTools(input),
  ];
  const tools = responseTools.length
    ? responseTools.map((tool) => responseToolToChat(tool, toolTypes)).filter(Boolean)
    : undefined;
  return {
    messages,
    tools,
    toolChoice: responseToolChoiceToChat(body.tool_choice),
    toolTypes,
  };
}

function appendResponseInput(messages, item) {
  if (!item || typeof item !== 'object') return;
  if (item.type === 'message' || (!item.type && item.role)) {
    const role = ['assistant', 'system', 'developer'].includes(item.role) ? item.role : 'user';
    messages.push({ role, content: responseContentToChat(item.content) });
    return;
  }
  if (item.type === 'function_call') {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: String(item.call_id || item.id || `call_${crypto.randomUUID()}`),
        type: 'function',
        function: { name: String(item.name || ''), arguments: String(item.arguments || '{}') },
      }],
    });
    return;
  }
  if (item.type === 'custom_tool_call') {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: String(item.call_id || item.id || `call_${crypto.randomUUID()}`),
        type: 'function',
        function: { name: String(item.name || ''), arguments: JSON.stringify({ input: String(item.input || '') }) },
      }],
    });
    return;
  }
  if (String(item.type || '').endsWith('_call_output')) {
    messages.push({
      role: 'tool',
      tool_call_id: String(item.call_id || item.id || ''),
      content: outputToText(item.output),
    });
  }
}

function responseContentToChat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return outputToText(content);
  const parts = content.flatMap((part) => {
    if (typeof part === 'string') return [{ type: 'text', text: part }];
    if (!part || typeof part !== 'object') return [];
    if (['input_text', 'output_text', 'text'].includes(part.type)) return [{ type: 'text', text: String(part.text || '') }];
    if (part.type === 'input_image' || part.type === 'image_url') {
      const url = part.image_url?.url || part.image_url || part.url;
      return url ? [{ type: 'image_url', image_url: { url: String(url), ...(part.detail ? { detail: part.detail } : {}) } }] : [];
    }
    return [{ type: 'text', text: outputToText(part) }];
  });
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('');
  return parts;
}

function responseToolToChat(tool, toolTypes) {
  if (!tool || typeof tool !== 'object' || !tool.name) return null;
  const name = String(tool.name);
  if (tool.type === 'custom') {
    toolTypes.set(name, 'custom');
    return {
      type: 'function',
      function: {
        name,
        description: [String(tool.description || ''), 'Return the custom tool input in the required input string property.'].filter(Boolean).join('\n'),
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        },
      },
    };
  }
  toolTypes.set(name, 'function');
  return {
    type: 'function',
    function: {
      name,
      ...(tool.description ? { description: String(tool.description) } : {}),
      parameters: (tool.parameters || tool.inputSchema || tool.input_schema) && typeof (tool.parameters || tool.inputSchema || tool.input_schema) === 'object'
        ? structuredClone(tool.parameters || tool.inputSchema || tool.input_schema)
        : { type: 'object', properties: {} },
      ...(tool.strict !== undefined ? { strict: Boolean(tool.strict) } : {}),
    },
  };
}

function extractAdditionalTools(input) {
  if (!Array.isArray(input)) return [];
  const tools = [];
  for (const item of input) {
    if (item?.type !== 'additional_tools') continue;
    const candidates = [item.tools, item.additional_tools, item.additionalTools, item.definitions];
    const found = candidates.find(Array.isArray) || [];
    tools.push(...found.filter((tool) => tool && typeof tool === 'object'));
  }
  return tools;
}

function responseToolChoiceToChat(value) {
  if (value == null || typeof value === 'string') return value;
  if (typeof value !== 'object' || !value.name) return value;
  return { type: 'function', function: { name: String(value.name) } };
}

export function chatCompletionToResponse(chat = {}, request = {}, mapped = mapResponsesToChat(request), { now = () => new Date() } = {}) {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const responseId = responseIdFrom(chat.id);
  const output = [];
  if (String(message.content || '')) output.push(messageOutputItem(String(message.content), 0));
  for (const call of message.tool_calls || []) {
    output.push(toolOutputItem(call, mapped.toolTypes, output.length));
  }
  return responseEnvelope({
    id: responseId,
    status: 'completed',
    model: chat.model || request.model,
    output,
    request,
    usage: responseUsage(chat.usage),
    createdAt: Number(chat.created) || Math.floor(now().getTime() / 1000),
  });
}

async function createChatResponseStream(gateway, upstream, request, mapped, { signal, now }) {
  const iterator = gateway.stream({
    provider: upstream.provider,
    ...upstream,
    messages: mapped.messages,
    tools: mapped.tools,
    toolChoice: mapped.toolChoice,
    reasoningEffort: request?.reasoning?.effort,
    maxOutputTokens: request.max_output_tokens,
    temperature: request.temperature,
    signal,
  })[Symbol.asyncIterator]();
  const first = await iterator.next();
  return chatResponseEvents(iterator, first, request, mapped, { now });
}

async function* chatResponseEvents(iterator, first, request, mapped, { now }) {
  const responseId = responseIdFrom('');
  const createdAt = Math.floor(now().getTime() / 1000);
  let sequence = 0;
  let model = String(request.model || '');
  let text = '';
  let messageAdded = false;
  let usage = null;
  const toolCalls = new Map();
  const envelope = () => responseEnvelope({ id: responseId, status: 'in_progress', model, output: [], request, usage: null, createdAt });
  yield withSequence({ type: 'response.created', response: envelope() }, sequence++);
  yield withSequence({ type: 'response.in_progress', response: envelope() }, sequence++);
  let current = first;
  try {
    while (true) {
      if (current.done) break;
      const raw = current.value?.raw || {};
      if (raw.model) model = String(raw.model);
      if (raw.usage) usage = raw.usage;
      const delta = raw?.choices?.[0]?.delta || {};
      if (delta.content) {
        if (!messageAdded) {
          messageAdded = true;
          yield withSequence({ type: 'response.output_item.added', output_index: 0, item: messageOutputItem('', 0, 'in_progress') }, sequence++);
          yield withSequence({ type: 'response.content_part.added', item_id: 'msg_0', output_index: 0, content_index: 0, part: { type: 'output_text', annotations: [], text: '' } }, sequence++);
        }
        const chunk = String(delta.content);
        text += chunk;
        yield withSequence({ type: 'response.output_text.delta', item_id: 'msg_0', output_index: 0, content_index: 0, delta: chunk, logprobs: [] }, sequence++);
      }
      for (const part of delta.tool_calls || []) {
        const index = Number.isSafeInteger(part.index) ? part.index : toolCalls.size;
        let call = toolCalls.get(index);
        if (!call) {
          const name = String(part.function?.name || 'tool');
          call = {
            id: String(part.id || `call_${crypto.randomUUID()}`),
            name,
            arguments: '',
            custom: mapped.toolTypes.get(name) === 'custom',
            outputIndex: (messageAdded ? 1 : 0) + toolCalls.size,
          };
          toolCalls.set(index, call);
          yield withSequence({ type: 'response.output_item.added', output_index: call.outputIndex, item: toolOutputItemFromState(call, 'in_progress') }, sequence++);
        }
        if (part.id) call.id = String(part.id);
        if (part.function?.name) {
          call.name = String(part.function.name);
          call.custom = mapped.toolTypes.get(call.name) === 'custom';
        }
        const argumentDelta = String(part.function?.arguments || '');
        if (argumentDelta) {
          call.arguments += argumentDelta;
          if (!call.custom) {
            yield withSequence({ type: 'response.function_call_arguments.delta', item_id: call.id, output_index: call.outputIndex, delta: argumentDelta }, sequence++);
          }
        }
      }
      current = await iterator.next();
    }
    const output = [];
    if (messageAdded) {
      const item = messageOutputItem(text, 0);
      output.push(item);
      yield withSequence({ type: 'response.output_text.done', item_id: 'msg_0', output_index: 0, content_index: 0, text, logprobs: [] }, sequence++);
      yield withSequence({ type: 'response.content_part.done', item_id: 'msg_0', output_index: 0, content_index: 0, part: item.content[0] }, sequence++);
      yield withSequence({ type: 'response.output_item.done', output_index: 0, item }, sequence++);
    }
    for (const call of toolCalls.values()) {
      if (call.custom) {
        call.input = customInput(call.arguments);
        yield withSequence({ type: 'response.custom_tool_call_input.done', item_id: call.id, output_index: call.outputIndex, input: call.input }, sequence++);
      } else {
        yield withSequence({ type: 'response.function_call_arguments.done', item_id: call.id, output_index: call.outputIndex, arguments: call.arguments }, sequence++);
      }
      const item = toolOutputItemFromState(call, 'completed');
      output.push(item);
      yield withSequence({ type: 'response.output_item.done', output_index: call.outputIndex, item }, sequence++);
    }
    yield withSequence({
      type: 'response.completed',
      response: responseEnvelope({ id: responseId, status: 'completed', model, output, request, usage: responseUsage(usage), createdAt }),
    }, sequence++);
  } catch (error) {
    yield withSequence({
      type: 'response.failed',
      response: responseEnvelope({
        id: responseId,
        status: 'failed',
        model,
        output: [],
        request,
        usage: responseUsage(usage),
        createdAt,
        error: { code: String(error?.code || 'model_error'), message: String(error?.message || error), type: 'server_error' },
      }),
    }, sequence++);
  }
}

function responseEnvelope({ id, status, model, output, request, usage, createdAt, error = null }) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    max_tool_calls: request.max_tool_calls ?? null,
    model: String(model || request.model || ''),
    output,
    parallel_tool_calls: request.parallel_tool_calls !== false,
    previous_response_id: request.previous_response_id ?? null,
    prompt_cache_key: request.prompt_cache_key ?? null,
    reasoning: request.reasoning || null,
    safety_identifier: request.safety_identifier ?? null,
    service_tier: request.service_tier || 'default',
    store: Boolean(request.store),
    temperature: request.temperature ?? null,
    text: request.text || { format: { type: 'text' } },
    tool_choice: request.tool_choice || 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_logprobs: request.top_logprobs || 0,
    top_p: request.top_p ?? 1,
    truncation: request.truncation || 'disabled',
    usage,
    metadata: request.metadata || {},
  };
}

function messageOutputItem(text, index, status = 'completed') {
  return {
    id: `msg_${index}`,
    type: 'message',
    status,
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], text: String(text || '') }],
  };
}

function toolOutputItem(call, toolTypes, index) {
  const state = {
    id: String(call.id || `call_${crypto.randomUUID()}`),
    name: String(call.function?.name || ''),
    arguments: String(call.function?.arguments || '{}'),
    custom: toolTypes.get(String(call.function?.name || '')) === 'custom',
    outputIndex: index,
  };
  if (state.custom) state.input = customInput(state.arguments);
  return toolOutputItemFromState(state, 'completed');
}

function toolOutputItemFromState(call, status) {
  if (call.custom) {
    return {
      id: call.id,
      type: 'custom_tool_call',
      status,
      call_id: call.id,
      name: call.name,
      input: call.input || '',
    };
  }
  return {
    id: call.id,
    type: 'function_call',
    status,
    call_id: call.id,
    name: call.name,
    arguments: call.arguments || '',
  };
}

function customInput(argumentsText) {
  try {
    const value = JSON.parse(String(argumentsText || '{}'));
    if (typeof value?.input === 'string') return value.input;
  } catch { /* Return the provider's original payload below. */ }
  return String(argumentsText || '');
}

function responseUsage(value) {
  if (!value) return null;
  const input = Number(value.input_tokens ?? value.prompt_tokens ?? 0) || 0;
  const output = Number(value.output_tokens ?? value.completion_tokens ?? 0) || 0;
  return {
    input_tokens: input,
    input_tokens_details: value.input_tokens_details || { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: value.output_tokens_details || { reasoning_tokens: 0 },
    total_tokens: Number(value.total_tokens ?? input + output) || input + output,
  };
}

function prependInstructions(instructions, input) {
  const text = String(instructions || '').trim();
  if (!text) return input;
  const item = { type: 'message', role: 'system', content: [{ type: 'input_text', text }] };
  return Array.isArray(input) ? [item, ...input] : [item, { type: 'message', role: 'user', content: [{ type: 'input_text', text: String(input || '') }] }];
}

function responseIdFrom(value) {
  const id = String(value || '').replace(/[^A-Za-z0-9_-]/gu, '');
  return id.startsWith('resp_') ? id : `resp_${id || crypto.randomUUID().replace(/-/g, '')}`;
}

function withSequence(event, sequenceNumber) {
  return { ...event, sequence_number: sequenceNumber };
}

function outputToText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? ''); } catch { return String(value ?? ''); }
}

function completionText(completion) {
  if (typeof completion?.text === 'string') return completion.text;
  const raw = completion?.raw;
  if (typeof raw?.output_text === 'string') return raw.output_text;
  const responseText = (raw?.output || [])
    .flatMap((item) => item?.content || [])
    .map((part) => part?.text || '')
    .join('');
  return String(responseText || raw?.choices?.[0]?.message?.content || raw?.choices?.[0]?.text || '');
}

function sanitizeError(error, at = new Date().toISOString()) {
  return {
    code: String(error?.code || 'CODEX_MODEL_BRIDGE_FAILED'),
    message: String(error?.message || error).slice(0, 500),
    at,
  };
}

function timestampMs(value) {
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function percentile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1));
  return ordered[index];
}

function secureEqual(expected, actual) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(actual || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isLoopbackAddress(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
    || normalized.startsWith('127.');
}

function bridgeError(code, message, status, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}
