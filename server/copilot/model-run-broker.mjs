import crypto from 'node:crypto';

import { createModelGateway } from './model-gateway.mjs';

export class ModelRunBrokerError extends Error {
  constructor(code, message, status = 502, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ModelRunBrokerError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Converts the provider-neutral ModelGateway transport into the turn result
 * consumed by the interactive and subagent runtimes. Provider credentials stay
 * inside the transport request and are never copied into projected events.
 */
export class ModelRunBroker {
  constructor({
    gateway = null,
    modelGateway = null,
    compatibilityCaller = null,
    now = () => new Date(),
    clock = () => performance.now(),
    idFactory = () => crypto.randomUUID(),
  } = {}) {
    if (compatibilityCaller !== null && typeof compatibilityCaller !== 'function') {
      throw new ModelRunBrokerError('MODEL_BROKER_COMPATIBILITY_CALLER_INVALID', 'Compatibility caller must be a function.', 500);
    }
    this.gateway = gateway || modelGateway || createModelGateway({ now });
    if (!this.gateway && !compatibilityCaller) {
      throw new ModelRunBrokerError('MODEL_BROKER_GATEWAY_REQUIRED', 'Model gateway is required.', 500);
    }
    this.compatibilityCaller = compatibilityCaller;
    this.now = now;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  async runTurn({
    session,
    messages = [],
    toolDefinitions = [],
    signal,
    onEvent = () => {},
    executionContext = {},
  } = {}) {
    assertNotAborted(signal);
    if (typeof onEvent !== 'function') throw new ModelRunBrokerError('MODEL_BROKER_EVENT_HANDLER_INVALID', 'Model event handler must be a function.', 400);

    const startedAt = this.clock();
    const wireApi = normalizeWireApi(session?.wireApi);
    const emit = (event) => emitProjectedEvent(onEvent, event);

    if (this.compatibilityCaller) {
      const result = await this.compatibilityCaller({
        session: cloneSession(session),
        messages: cloneMessages(messages),
        toolDefinitions: cloneToolDefinitions(toolDefinitions),
        signal,
        onEvent: emit,
        executionContext: redactSensitive(executionContext),
      });
      assertNotAborted(signal);
      return normalizeTurnResult(result, wireApi, this.idFactory, elapsedMs(this.clock, startedAt));
    }

    const request = gatewayRequest(session, messages, toolDefinitions, wireApi);
    let result;
    if (shouldStream(session, this.gateway)) {
      try {
        result = await this.#stream(request, wireApi, signal, emit);
      } catch (error) {
        if (!canFallBackToCompletion(error, signal) || typeof this.gateway.complete !== 'function') throw error;
        result = await this.gateway.complete(request);
      }
    } else {
      if (typeof this.gateway.complete !== 'function') {
        throw new ModelRunBrokerError('MODEL_BROKER_COMPLETION_UNAVAILABLE', 'Model gateway does not support completion requests.', 503);
      }
      result = await this.gateway.complete(request);
    }
    assertNotAborted(signal);
    return normalizeTurnResult(result, wireApi, this.idFactory, elapsedMs(this.clock, startedAt));
  }

  async retrieve({ session, responseId, signal } = {}) {
    if (typeof this.gateway?.retrieve !== 'function') {
      throw new ModelRunBrokerError('MODEL_BROKER_RETRIEVE_UNAVAILABLE', 'Model gateway does not support response retrieval.', 400);
    }
    assertNotAborted(signal);
    const startedAt = this.clock();
    const wireApi = normalizeWireApi(session?.wireApi);
    const result = await this.gateway.retrieve({
      ...gatewaySession(session, wireApi),
      responseId: String(responseId || ''),
      signal,
    });
    assertNotAborted(signal);
    return normalizeTurnResult(result, wireApi, this.idFactory, elapsedMs(this.clock, startedAt));
  }

  async cancel({ session, responseId, signal } = {}) {
    if (typeof this.gateway?.cancel !== 'function') {
      throw new ModelRunBrokerError('MODEL_BROKER_CANCEL_UNAVAILABLE', 'Model gateway does not support response cancellation.', 400);
    }
    assertNotAborted(signal);
    const startedAt = this.clock();
    const wireApi = normalizeWireApi(session?.wireApi);
    const result = await this.gateway.cancel({
      ...gatewaySession(session, wireApi),
      responseId: String(responseId || ''),
      signal,
    });
    assertNotAborted(signal);
    return normalizeTurnResult(result, wireApi, this.idFactory, elapsedMs(this.clock, startedAt));
  }

  /** Adapter for the pre-V3 positional caller used by existing runtimes. */
  asLegacyCaller() {
    return (_fetchImpl, session, messages, toolDefinitions, signal, onEvent) => this.runTurn({
      session,
      messages,
      toolDefinitions,
      signal,
      onEvent,
    });
  }

  async #stream(request, wireApi, signal, emit) {
    if (typeof this.gateway?.stream !== 'function') {
      throw new ModelRunBrokerError('MODEL_BROKER_STREAM_UNAVAILABLE', 'Model gateway does not support streaming.', 400);
    }
    const state = createStreamState(wireApi);
    try {
      for await (const envelope of this.gateway.stream(request)) {
        assertNotAborted(signal);
        state.seenEvent = true;
        consumeStreamEvent(state, envelope, wireApi, emit);
      }
      assertNotAborted(signal);
      return finalizeStreamState(state, wireApi);
    } catch (error) {
      if (error && typeof error === 'object') error.modelStreamStarted = state.seenEvent;
      throw error;
    }
  }
}

export function createModelRunBroker(options) {
  return new ModelRunBroker(options);
}

function gatewayRequest(session, messages, toolDefinitions, wireApi) {
  const base = gatewaySession(session, wireApi);
  const tools = toWireTools(toolDefinitions, wireApi);
  return {
    ...base,
    ...(wireApi === 'responses'
      ? { input: toResponsesInput(messages) }
      : { messages: cloneMessages(messages) }),
    tools,
    toolChoice: 'auto',
    temperature: session?.temperature === undefined ? 0.1 : Number(session.temperature),
  };
}

function gatewaySession(session, wireApi) {
  const source = session && typeof session === 'object' ? session : {};
  const request = {
    provider: String(source.provider || ''),
    wireApi,
  };
  if (source.model) request.model = String(source.model);
  if (source.baseUrl) request.baseUrl = String(source.baseUrl);
  if (source.apiKey) request.apiKey = String(source.apiKey);
  if (source.organization) request.organization = String(source.organization);
  if (source.project) request.project = String(source.project);
  if (source.capabilities && typeof source.capabilities === 'object') request.capabilities = structuredClone(source.capabilities);
  if (source.supportsStreaming !== undefined) request.supportsStreaming = Boolean(source.supportsStreaming);
  if (source.maxOutputTokens !== undefined) request.maxOutputTokens = source.maxOutputTokens;
  if (source.previousResponseId) request.previousResponseId = String(source.previousResponseId);
  if (source.conversationId) request.conversationId = String(source.conversationId);
  if (source.background === true) request.background = true;
  if (source.reasoningSummary) request.reasoningSummary = String(source.reasoningSummary);
  if (source.reasoningEffort) request.reasoningEffort = String(source.reasoningEffort);
  if (source.store !== undefined) request.store = Boolean(source.store);
  return request;
}

function shouldStream(session, gateway) {
  if (typeof gateway?.stream !== 'function') return false;
  const source = session && typeof session === 'object' ? session : {};
  if (source.supportsStreaming === false || source.capabilities?.streaming === false) return false;
  try {
    const described = gateway.describeProvider?.(source.provider);
    return described?.supportsStreaming !== false;
  } catch {
    return true;
  }
}

function canFallBackToCompletion(error, signal) {
  if (signal?.aborted || error?.code === 'MODEL_REQUEST_ABORTED' || error?.name === 'AbortError') return false;
  if (error?.modelStreamStarted) return false;
  return error?.code === 'MODEL_CAPABILITY_UNSUPPORTED'
    || (error?.code === 'MODEL_PROVIDER_ERROR' && [400, 415, 422].includes(Number(error?.status)));
}

function createStreamState(wireApi) {
  return {
    wireApi,
    seenEvent: false,
    responseId: '',
    model: '',
    usage: null,
    text: '',
    reasoning: '',
    calls: new Map(),
    response: null,
  };
}

function consumeStreamEvent(state, envelope, wireApi, emit) {
  const value = envelope?.raw && typeof envelope.raw === 'object' ? envelope.raw : envelope || {};
  const type = String(value?.type || envelope?.type || '');
  if (wireApi === 'responses') consumeResponsesEvent(state, value, type, envelope, emit);
  else consumeChatEvent(state, value, envelope, emit);
}

function consumeChatEvent(state, value, envelope, emit) {
  state.responseId ||= String(value?.id || envelope?.responseId || '');
  state.model ||= String(value?.model || '');
  state.usage = value?.usage || state.usage;
  const choice = Array.isArray(value?.choices) ? value.choices[0] : null;
  const delta = choice?.delta || value?.delta || {};
  const textDelta = contentText(delta?.content || (envelope?.type === 'assistant.delta' ? envelope?.delta : ''));
  if (textDelta) {
    state.text += textDelta;
    emit({ type: 'assistant.delta', delta: textDelta, text: state.text });
  }
  const reasoningDelta = contentText(
    delta?.reasoning_content
    || delta?.reasoning
    || delta?.reasoning_text
    || (envelope?.type === 'assistant.reasoning.delta' ? envelope?.delta : ''),
  );
  if (reasoningDelta) {
    state.reasoning += reasoningDelta;
    emit({ type: 'assistant.reasoning.delta', delta: reasoningDelta, text: state.reasoning });
  }
  const toolCalls = Array.isArray(delta?.tool_calls)
    ? delta.tool_calls
    : delta?.function_call
      ? [{ index: 0, id: delta.function_call.id, function: delta.function_call }]
      : [];
  for (const call of toolCalls) appendChatToolCall(state, call, emit);
}

function consumeResponsesEvent(state, value, type, envelope, emit) {
  state.responseId ||= String(value?.response_id || value?.response?.id || envelope?.responseId || '');
  if (type === 'response.output_text.delta' || envelope?.type === 'assistant.delta') {
    const delta = String(value?.delta ?? envelope?.delta ?? '');
    if (delta) {
      state.text += delta;
      emit({ type: 'assistant.delta', delta, text: state.text });
    }
    return;
  }
  if ([
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary.delta',
    'response.reasoning.delta',
  ].includes(type) || envelope?.type === 'assistant.reasoning.delta') {
    const delta = String(value?.delta ?? envelope?.delta ?? '');
    if (delta) {
      state.reasoning += delta;
      emit({ type: 'assistant.reasoning.delta', delta, text: state.reasoning });
    }
    return;
  }
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    if (value?.item?.type === 'function_call') mergeResponsesToolCall(state, value.item, value, emit);
    return;
  }
  if (type === 'response.function_call_arguments.delta') {
    mergeResponsesToolCall(state, {
      id: value?.item_id,
      call_id: value?.call_id,
      name: value?.name,
      arguments: value?.delta,
    }, value, emit, { appendArguments: true });
    return;
  }
  if (type === 'response.completed') {
    state.response = value?.response || state.response;
    state.responseId ||= String(value?.response?.id || '');
    state.usage = value?.response?.usage || state.usage;
  }
}

function appendChatToolCall(state, call, emit) {
  const key = Number.isInteger(call?.index) ? String(call.index) : String(call?.id || state.calls.size);
  const current = state.calls.get(key) || { id: '', name: '', arguments: '' };
  current.id ||= String(call?.id || '');
  const nextName = String(call?.function?.name || '');
  if (nextName) current.name = current.name ? `${current.name}${nextName}` : nextName;
  const argumentsDelta = String(call?.function?.arguments || '');
  current.arguments += argumentsDelta;
  state.calls.set(key, current);
  emit({
    type: 'tool.call.delta',
    callId: current.id || key,
    name: fromWireToolName(current.name),
    argumentsDelta,
    arguments: current.arguments,
  });
}

function mergeResponsesToolCall(state, item, event, emit, { appendArguments = false } = {}) {
  const key = String(item?.id || event?.item_id || item?.call_id || event?.call_id || event?.output_index || state.calls.size);
  const current = state.calls.get(key) || { id: '', callId: '', name: '', arguments: '' };
  current.id ||= String(item?.id || event?.item_id || '');
  current.callId ||= String(item?.call_id || event?.call_id || '');
  current.name ||= String(item?.name || event?.name || '');
  const argumentsDelta = String(item?.arguments || '');
  current.arguments = appendArguments ? `${current.arguments}${argumentsDelta}` : argumentsDelta || current.arguments;
  state.calls.set(key, current);
  emit({
    type: 'tool.call.delta',
    callId: current.callId || current.id || key,
    name: fromWireToolName(current.name),
    argumentsDelta,
    arguments: current.arguments,
  });
}

function finalizeStreamState(state, wireApi) {
  if (state.response && typeof state.response === 'object') return { raw: state.response };
  if (wireApi === 'responses') {
    const output = [];
    if (state.text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: state.text }] });
    for (const [index, call] of [...state.calls.values()].entries()) {
      output.push({
        type: 'function_call',
        id: call.id || `item-stream-${index}`,
        call_id: call.callId || call.id || `call-stream-${index}`,
        name: call.name,
        arguments: call.arguments || '{}',
      });
    }
    return { raw: { id: state.responseId, output_text: state.text, output, usage: state.usage } };
  }
  return {
    raw: {
      id: state.responseId,
      model: state.model,
      usage: state.usage,
      choices: [{
        message: {
          role: 'assistant',
          content: state.text || null,
          tool_calls: [...state.calls.values()].map((call, index) => ({
            id: call.id || `call-stream-${index}`,
            type: 'function',
            function: { name: call.name, arguments: call.arguments || '{}' },
          })),
        },
      }],
    },
  };
}

function normalizeTurnResult(value, wireApi, idFactory, durationMs) {
  const source = value && typeof value === 'object' ? value : {};
  const raw = source.raw && typeof source.raw === 'object' ? source.raw : source;
  const parsed = Array.isArray(source.calls)
    ? {
        text: String(source.text || ''),
        calls: normalizeCalls(source.calls, idFactory),
        rawAssistant: source.rawAssistant ?? source.assistantMessage ?? rawAssistant(raw, wireApi),
      }
    : parseProviderPayload(raw, wireApi, idFactory, source.text);
  const responseId = String(source.responseId || raw?.id || '');
  const usage = source.usage ?? raw?.usage ?? null;
  const assistantMessage = parsed.rawAssistant;
  return {
    text: parsed.text,
    calls: parsed.calls,
    rawAssistant: parsed.rawAssistant,
    assistantMessage,
    responseId,
    usage,
    durationMs: Number.isFinite(Number(source.durationMs)) ? Math.max(0, Math.round(Number(source.durationMs))) : durationMs,
  };
}

function parseProviderPayload(raw, wireApi, idFactory, fallbackText = '') {
  if (wireApi === 'responses') {
    const output = Array.isArray(raw?.output) ? raw.output : [];
    const calls = output
      .filter((item) => item?.type === 'function_call')
      .map((call) => ({
        id: String(call.call_id || call.id || idFactory()),
        wireId: String(call.call_id || call.id || ''),
        name: fromWireToolName(call.name),
        input: parseArguments(call.arguments),
      }));
    const text = responseText(raw) || String(fallbackText || '');
    return calls.length ? { text, calls, rawAssistant: output } : parseJsonIntent(text, output, idFactory);
  }
  const choice = Array.isArray(raw?.choices) ? raw.choices[0] || {} : {};
  const message = choice?.message || {};
  const calls = (Array.isArray(message?.tool_calls)
    ? message.tool_calls
    : message?.function_call
      ? [{ id: message.function_call.id, function: message.function_call }]
      : [])
    .map((call) => ({
      id: String(call?.id || idFactory()),
      wireId: String(call?.id || ''),
      name: fromWireToolName(call?.function?.name),
      input: parseArguments(call?.function?.arguments),
    }));
  const text = contentText(message?.content) || contentText(choice?.text) || String(fallbackText || '');
  return calls.length ? { text, calls, rawAssistant: message } : parseJsonIntent(text, message, idFactory);
}

function normalizeCalls(value, idFactory) {
  return value.map((call) => ({
    id: String(call?.id || call?.wireId || idFactory()),
    wireId: String(call?.wireId || call?.id || ''),
    name: fromWireToolName(call?.name || call?.function?.name),
    input: call?.input !== undefined ? cloneValue(call.input) : parseArguments(call?.arguments || call?.function?.arguments),
  })).filter((call) => call.name);
}

function parseJsonIntent(text, rawAssistant, idFactory) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  try {
    const value = JSON.parse(cleaned);
    const source = Array.isArray(value?.toolCalls) ? value.toolCalls : value?.tool ? [value] : [];
    const calls = source.map((item) => ({
      id: String(item?.id || idFactory()),
      wireId: String(item?.wireId || ''),
      name: fromWireToolName(item?.tool || item?.name),
      input: cloneValue(item?.arguments ?? item?.input ?? {}),
    })).filter((call) => call.name);
    if (calls.length) return { text: String(value.message || ''), calls, rawAssistant: value };
  } catch {
    // Ordinary assistant text is the normal case.
  }
  return { text: String(text || ''), calls: [], rawAssistant };
}

function rawAssistant(raw, wireApi) {
  return wireApi === 'responses' ? (Array.isArray(raw?.output) ? raw.output : raw) : (raw?.choices?.[0]?.message || raw);
}

function responseText(raw) {
  if (typeof raw?.output_text === 'string') return raw.output_text;
  return (Array.isArray(raw?.output) ? raw.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((item) => item?.text || item?.output_text || '')
    .filter(Boolean)
    .join('\n');
}

function parseArguments(value) {
  if (value && typeof value === 'object') return cloneValue(value);
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Normalize the provider-specific parse failure below.
  }
  throw new ModelRunBrokerError('MODEL_TOOL_ARGUMENTS_INVALID', 'The model returned invalid tool arguments.', 502);
}

function toWireTools(definitions, wireApi) {
  return (Array.isArray(definitions) ? definitions : [])
    .filter((tool) => String(tool?.name || '').trim())
    .map((tool) => {
      const definition = {
        name: wireToolName(tool?.name),
        description: String(tool?.description || ''),
        parameters: cloneValue(tool?.inputSchema || { type: 'object', properties: {}, additionalProperties: false }),
      };
      if (supportsStrictToolSchema(definition.parameters)) definition.strict = true;
      return wireApi === 'responses' ? { type: 'function', ...definition } : { type: 'function', function: definition };
    });
}

function toResponsesInput(messages) {
  return cloneMessages(messages).flatMap((message) => {
    if (message.role === 'tool') return { type: 'function_call_output', call_id: message.tool_call_id, output: message.content };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const items = [];
      if (message.content) items.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls) {
        items.push({
          type: 'function_call',
          call_id: call?.id || call?.function?.id,
          name: call?.function?.name || call?.name,
          arguments: call?.function?.arguments || call?.arguments || '{}',
        });
      }
      return items;
    }
    return { role: message.role, content: message.content };
  });
}

function supportsStrictToolSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.every(supportsStrictToolSchema);
  if (Array.isArray(schema.oneOf)) return schema.oneOf.every(supportsStrictToolSchema);
  if (Array.isArray(schema.allOf)) return schema.allOf.every(supportsStrictToolSchema);
  if (schema.type === 'array') return supportsStrictToolSchema(schema.items);
  if (schema.type !== 'object') return typeof schema.type === 'string';
  if (schema.additionalProperties !== false) return false;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(properties).every((name) => required.has(name) && supportsStrictToolSchema(properties[name]));
}

function emitProjectedEvent(onEvent, event) {
  const type = String(event?.type || '');
  if (!['assistant.delta', 'assistant.reasoning.delta', 'tool.call.delta'].includes(type)) return;
  const projected = { type };
  if (event?.delta !== undefined) projected.delta = String(event.delta);
  if (event?.text !== undefined) projected.text = String(event.text);
  if (event?.callId !== undefined) projected.callId = String(event.callId);
  if (event?.name !== undefined) projected.name = fromWireToolName(event.name);
  if (event?.argumentsDelta !== undefined) projected.argumentsDelta = String(event.argumentsDelta);
  if (event?.arguments !== undefined) projected.arguments = String(event.arguments);
  onEvent(projected);
}

function cloneSession(session) {
  const source = session && typeof session === 'object' ? session : {};
  return cloneValue(source);
}

function cloneMessages(messages) {
  return cloneValue(Array.isArray(messages) ? messages : []);
}

function cloneToolDefinitions(definitions) {
  return cloneValue(Array.isArray(definitions) ? definitions : []);
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function redactSensitive(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(?:api[_-]?key|authorization|secret|token|password|credential)/iu.test(key)
      ? '[redacted]'
      : redactSensitive(item, seen),
  ]));
}

function normalizeWireApi(value) {
  return String(value || '').trim().toLowerCase() === 'responses' ? 'responses' : 'chat_completions';
}

function wireToolName(name) {
  return `copilot_${String(name || '').replaceAll('.', '__')}`;
}

function fromWireToolName(name) {
  return String(name || '').replace(/^copilot_/u, '').replaceAll('__', '.');
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n');
  return '';
}

function elapsedMs(clock, startedAt) {
  return Math.max(0, Math.round(Number(clock()) - Number(startedAt)));
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  throw new ModelRunBrokerError('MODEL_REQUEST_ABORTED', 'Model request was aborted.', 504, signal.reason);
}
