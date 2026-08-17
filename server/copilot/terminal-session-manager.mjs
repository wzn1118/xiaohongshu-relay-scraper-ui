import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

import { createExecutionContext } from './runtime-v3/index.mjs';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_MAX_EVENT_COUNT = 2_000;
const DEFAULT_MAX_PERSISTED_EVENT_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 64;

export class TerminalSessionError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'TerminalSessionError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Owns interactive, shell-free local processes. A caller supplies a verified
 * workspace root and owns the corresponding lease; the manager owns process
 * lifecycle, bounded terminal history, incremental stdin, and cancellation.
 */
export class TerminalSessionManager {
  constructor({
    spawnImpl = spawn,
    now = () => new Date(),
    idFactory = () => randomUUID(),
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxEventCount = DEFAULT_MAX_EVENT_COUNT,
    maxSessions = MAX_SESSIONS,
    repository = null,
    maxPersistedEventBytes = DEFAULT_MAX_PERSISTED_EVENT_BYTES,
  } = {}) {
    this.spawnImpl = spawnImpl;
    this.now = now;
    this.idFactory = idFactory;
    this.defaultTimeoutMs = boundedInteger(defaultTimeoutMs, DEFAULT_TIMEOUT_MS, 50, MAX_TIMEOUT_MS);
    this.maxOutputBytes = boundedInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, 8 * 1024 * 1024);
    this.maxEventCount = boundedInteger(maxEventCount, DEFAULT_MAX_EVENT_COUNT, 10, 10_000);
    this.maxSessions = boundedInteger(maxSessions, MAX_SESSIONS, 1, MAX_SESSIONS);
    this.repository = repository && supportsRuntimeV3Repository(repository) ? repository : null;
    this.maxPersistedEventBytes = boundedInteger(
      maxPersistedEventBytes,
      DEFAULT_MAX_PERSISTED_EVENT_BYTES,
      512,
      256 * 1024,
    );
    this.sessions = new Map();
  }

  list({ workspaceId = '', includeCompleted = true } = {}) {
    const normalizedWorkspaceId = String(workspaceId || '').trim();
    const sessions = new Map();
    for (const session of this.#listPersistedSessions()) sessions.set(session.sessionId, session);
    for (const session of this.sessions.values()) sessions.set(session.id, publicSession(session));
    return [...sessions.values()]
      .filter((session) => !normalizedWorkspaceId || session.workspaceId === normalizedWorkspaceId)
      .filter((session) => includeCompleted || isPublicSessionActive(session))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  get(sessionId, { afterSequence = 0, limit = 400 } = {}) {
    const id = requiredId(sessionId, 'terminal session ID');
    const session = this.sessions.get(id);
    const cursor = nonNegativeInteger(afterSequence, 0);
    const maximum = boundedInteger(limit, 400, 1, this.maxEventCount);
    if (!session) return this.#getPersistedSession(id, { afterSequence: cursor, limit: maximum });
    const events = session.events
      .filter((event) => event.sequence > cursor)
      .slice(0, maximum)
      .map((event) => structuredClone(event));
    return {
      session: publicSession(session),
      events,
      nextSequence: events.at(-1)?.sequence || cursor,
      hasMore: session.events.some((event) => event.sequence > (events.at(-1)?.sequence || cursor)),
    };
  }

  async start(input = {}) {
    if (this.#activeCount() >= this.maxSessions) {
      throw terminalError('TERMINAL_SESSION_LIMIT', 'The local terminal session limit has been reached.', 429);
    }
    const workspaceRoot = await verifiedWorkspaceRoot(input.workspaceRoot);
    const cwd = await resolveWorkspaceDirectory(workspaceRoot, input.cwd);
    const command = requiredCommand(input.command);
    const args = commandArguments(input.args);
    const timeoutMs = boundedInteger(input.timeoutMs, this.defaultTimeoutMs, 50, MAX_TIMEOUT_MS);
    const outputLimit = boundedInteger(input.maxOutputBytes, this.maxOutputBytes, 1024, this.maxOutputBytes);
    const environment = resolveEnvironment(input, process.env);
    const session = {
      id: `terminal-${this.idFactory()}`,
      workspaceId: requiredId(input.workspaceId, 'workspace ID'),
      projectId: optionalId(input.projectId),
      runId: optionalId(input.runId),
      toolRunId: optionalId(input.toolRunId),
      workspaceRoot,
      command,
      args,
      cwd,
      envKeys: environment.keys,
      envReferenceKeys: environment.referenceKeys,
      startedAt: this.#timestamp(),
      completedAt: null,
      status: 'starting',
      exitCode: null,
      signal: null,
      error: null,
      stopReason: null,
      output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false },
      outputLimit,
      events: [],
      sequence: 0,
      listeners: new Set(),
      child: null,
      timeout: null,
      abortSignal: isAbortSignal(input.signal) ? input.signal : null,
      abortListener: null,
      onSettled: typeof input.onSettled === 'function' ? input.onSettled : null,
      settled: false,
      done: null,
      resolveDone: null,
      executionId: '',
      executionContext: null,
      streamId: '',
      persistenceError: null,
    };
    session.done = new Promise((resolve) => { session.resolveDone = resolve; });
    this.#beginDurableSession(session, input, timeoutMs);
    this.sessions.set(session.id, session);
    this.#append(session, { type: 'terminal.started', stream: 'system', text: '' });

    let child;
    try {
      child = this.spawnImpl(command, args, {
        cwd,
        env: environment.value,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.#settle(session, { status: 'failed', error: normalizeError(error, 'TERMINAL_SPAWN_FAILED') });
      return publicSession(session);
    }
    session.child = child;
    session.status = 'running';
    this.#persistSession(session);
    this.#append(session, { type: 'terminal.running', stream: 'system', text: '' });
    // A process may close stdin before a browser finishes writing. Keep that
    // expected EPIPE from becoming an unhandled stream error.
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (chunk) => this.#appendOutput(session, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => this.#appendOutput(session, 'stderr', chunk));
    child.once('error', (error) => {
      this.#settle(session, { status: 'failed', error: normalizeError(error, 'TERMINAL_SPAWN_FAILED') });
    });
    child.once('close', (exitCode, signal) => {
      const wasCancelled = Boolean(session.stopReason);
      this.#settle(session, {
        status: wasCancelled ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed',
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || null,
        error: !wasCancelled && exitCode !== 0
          ? { code: 'TERMINAL_EXIT_NONZERO', message: `Terminal process exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}.`, status: 422 }
          : null,
      });
    });
    session.timeout = setTimeout(() => {
      void this.cancel(session.id, { reason: 'timeout' });
    }, timeoutMs);
    if (session.abortSignal) {
      session.abortListener = () => { void this.cancel(session.id, { reason: 'aborted' }); };
      session.abortSignal.addEventListener('abort', session.abortListener, { once: true });
      if (session.abortSignal.aborted) void this.cancel(session.id, { reason: 'aborted' });
    }
    if (input.stdin !== undefined && input.stdin !== null && String(input.stdin)) {
      this.write(session.id, String(input.stdin));
    }
    return publicSession(session);
  }

  write(sessionId, value) {
    const session = this.#session(sessionId);
    if (!isActive(session) || !session.child?.stdin || session.child.stdin.destroyed || !session.child.stdin.writable) {
      throw terminalError('TERMINAL_INPUT_CLOSED', 'The terminal session is not accepting input.', 409);
    }
    const input = String(value ?? '');
    if (!input) return { sessionId: session.id, writtenBytes: 0 };
    if (Buffer.byteLength(input) > 64 * 1024) {
      throw terminalError('TERMINAL_INPUT_TOO_LARGE', 'Terminal input exceeds 65536 bytes.', 413);
    }
    session.child.stdin.write(input, 'utf8');
    this.#append(session, { type: 'terminal.input', stream: 'stdin', text: input });
    return { sessionId: session.id, writtenBytes: Buffer.byteLength(input) };
  }

  async cancel(sessionId, { reason = 'cancelled' } = {}) {
    const id = requiredId(sessionId, 'terminal session ID');
    const session = this.sessions.get(id);
    if (!session) {
      const details = this.#getPersistedSession(id, { afterSequence: 0, limit: 1 });
      return { cancelled: false, session: details.session };
    }
    if (!isActive(session)) return { cancelled: false, session: publicSession(session) };
    session.stopReason = String(reason || 'cancelled').slice(0, 80);
    session.status = 'cancelling';
    this.#persistSession(session);
    this.#append(session, { type: 'terminal.cancelling', stream: 'system', text: session.stopReason });
    await terminateProcessTree(session.child);
    return { cancelled: true, session: publicSession(session) };
  }

  async wait(sessionId) {
    const id = requiredId(sessionId, 'terminal session ID');
    const session = this.sessions.get(id);
    if (!session) return this.#getPersistedSession(id, { afterSequence: 0, limit: 1 }).session;
    await session.done;
    return publicSession(session);
  }

  subscribe(sessionId, listener) {
    const session = this.#session(sessionId);
    if (typeof listener !== 'function') throw new TypeError('A terminal event listener is required.');
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  async close() {
    await Promise.all([...this.sessions.values()].filter(isActive).map(async (session) => {
      await this.cancel(session.id, { reason: 'manager_closed' }).catch(() => {});
      await this.wait(session.id).catch(() => {});
    }));
  }

  /**
   * After a process restart there is no safe way to reattach to the child
   * process. Mark unfinished durable records for explicit inspection instead
   * of presenting them as live terminals or silently starting another command.
   */
  recover() {
    if (!this.repository) return { recovered: 0 };
    let recovered = 0;
    for (const record of this.repository.listExecutions({ limit: 1_000 })) {
      if (record.kind !== 'terminal_session' || !['queued', 'running', 'cancelling'].includes(record.status)) continue;
      const session = persistedSession(record, { status: 'reconcile_required' });
      try {
        this.repository.updateExecution(record.executionId, {
          status: 'reconcile_required',
          result: durableResult(session),
          error: {
            code: 'TERMINAL_SESSION_ORPHANED',
            message: 'The service restarted before this terminal session produced a durable completion receipt.',
            status: 409,
            retryable: false,
          },
          completedAt: this.#timestamp(),
        });
        this.#appendDurableEvent(record.context, terminalStreamId(record.context, record.executionId), {
          type: 'terminal.reconcile_required',
          stream: 'system',
          text: 'service_restart',
          sessionId: record.executionId,
        });
        recovered += 1;
      } catch {
        // Startup recovery remains best effort. The original record is still
        // queryable and must never trigger a blind process replay.
      }
    }
    return { recovered };
  }

  #appendOutput(session, stream, rawChunk) {
    if (session.settled) return;
    const chunk = Buffer.from(rawChunk);
    const currentBytesKey = stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
    const remaining = Math.max(0, session.outputLimit - session.output[currentBytesKey]);
    const kept = remaining ? chunk.subarray(0, remaining) : Buffer.alloc(0);
    session.output[currentBytesKey] += chunk.length;
    if (kept.length < chunk.length) session.output.truncated = true;
    if (kept.length) {
      session.output[stream] += kept.toString('utf8');
      this.#append(session, { type: 'terminal.output', stream, text: kept.toString('utf8') });
    }
  }

  #append(session, event) {
    const record = {
      sequence: ++session.sequence,
      type: event.type,
      stream: event.stream,
      text: String(event.text || ''),
      createdAt: this.#timestamp(),
    };
    session.events.push(record);
    if (session.events.length > this.maxEventCount) session.events.splice(0, session.events.length - this.maxEventCount);
    this.#appendDurableEvent(session.executionContext, session.streamId, {
      ...record,
      sessionId: session.id,
    }, session);
    for (const listener of session.listeners) {
      try { listener(structuredClone(record), publicSession(session)); } catch { /* Event consumers cannot break process state. */ }
    }
  }

  #settle(session, { status, exitCode = null, signal = null, error = null } = {}) {
    if (session.settled) return;
    session.settled = true;
    session.status = status || 'failed';
    session.exitCode = exitCode;
    session.signal = signal;
    session.error = error;
    session.completedAt = this.#timestamp();
    clearTimeout(session.timeout);
    if (session.abortListener && session.abortSignal) session.abortSignal.removeEventListener('abort', session.abortListener);
    this.#append(session, {
      type: `terminal.${session.status}`,
      stream: 'system',
      text: session.error?.message || session.stopReason || '',
    });
    this.#persistSession(session, { completed: true });
    session.resolveDone(publicSession(session));
    Promise.resolve(session.onSettled?.(publicSession(session))).catch(() => {});
  }

  #activeCount() {
    return [...this.sessions.values()].filter(isActive).length;
  }

  #session(sessionId) {
    const id = requiredId(sessionId, 'terminal session ID');
    const session = this.sessions.get(id);
    if (!session) throw terminalError('TERMINAL_SESSION_NOT_FOUND', 'The terminal session does not exist.', 404);
    return session;
  }

  #beginDurableSession(session, input, timeoutMs) {
    if (!this.repository) return;
    const context = terminalExecutionContext(input, session, timeoutMs, this.now);
    const metadata = durableMetadata(session);
    let record;
    try {
      record = this.repository.createExecution({
        executionId: session.id,
        context,
        kind: 'terminal_session',
        status: 'queued',
        metadata,
      });
    } catch (error) {
      throw terminalError(
        'TERMINAL_RECEIPT_PERSIST_FAILED',
        `Unable to persist the terminal session receipt: ${String(error?.message || error)}`,
        Number.isInteger(error?.status) ? error.status : 500,
      );
    }
    if (record.executionId !== session.id) {
      throw terminalError('TERMINAL_SESSION_DUPLICATE', 'A durable terminal session with this idempotency key already exists.', 409, {
        sessionId: record.executionId,
      });
    }
    session.executionId = record.executionId;
    session.executionContext = record.context;
    session.streamId = terminalStreamId(record.context, record.executionId);
  }

  #persistSession(session, { completed = false } = {}) {
    if (!this.repository || !session.executionId) return null;
    try {
      return this.repository.updateExecution(session.executionId, {
        status: durableStatus(session.status),
        result: durableResult(publicSession(session)),
        error: session.error ? structuredClone(session.error) : {},
        ...(completed ? { completedAt: session.completedAt || this.#timestamp() } : {}),
      });
    } catch (error) {
      session.persistenceError = normalizePersistenceError(error);
      return null;
    }
  }

  #appendDurableEvent(context, streamId, event, session = null) {
    if (!this.repository || !context || !streamId) return null;
    try {
      return this.repository.appendEvent({
        streamId,
        type: String(event.type || 'terminal.event'),
        occurredAt: event.createdAt || this.#timestamp(),
        taskId: context.taskId,
        runId: context.runId,
        attemptId: context.attemptId,
        payload: durableEventPayload(event, this.maxPersistedEventBytes),
      });
    } catch (error) {
      if (session) session.persistenceError = normalizePersistenceError(error);
      return null;
    }
  }

  #listPersistedSessions() {
    if (!this.repository) return [];
    try {
      return this.repository.listExecutions({ limit: 1_000 })
        .filter((record) => record.kind === 'terminal_session')
        .map((record) => persistedSession(record));
    } catch {
      return [];
    }
  }

  #getPersistedSession(sessionId, { afterSequence = 0, limit = 400 } = {}) {
    if (!this.repository) throw terminalError('TERMINAL_SESSION_NOT_FOUND', 'The terminal session does not exist.', 404);
    let record;
    try {
      record = this.repository.getExecution(sessionId);
    } catch (error) {
      throw terminalError('TERMINAL_RECEIPT_UNAVAILABLE', 'The durable terminal receipt is unavailable.', 503);
    }
    if (!record || record.kind !== 'terminal_session') {
      throw terminalError('TERMINAL_SESSION_NOT_FOUND', 'The terminal session does not exist.', 404);
    }
    const cursor = nonNegativeInteger(afterSequence, 0);
    const maximum = boundedInteger(limit, 400, 1, this.maxEventCount);
    let events = [];
    let hasMore = false;
    try {
      const streamId = terminalStreamId(record.context, record.executionId);
      events = this.repository.listEvents({ streamId, afterSequence: cursor, limit: maximum })
        .map(persistedTerminalEvent);
      const nextSequence = events.at(-1)?.sequence || cursor;
      hasMore = this.repository.latestSequence(streamId) > nextSequence;
    } catch {
      // The durable execution receipt remains useful even when its event
      // projection was pruned or is temporarily unavailable.
    }
    return {
      session: persistedSession(record),
      events,
      nextSequence: events.at(-1)?.sequence || cursor,
      hasMore,
    };
  }

  #timestamp() {
    return this.now().toISOString();
  }
}

export function createTerminalSessionManager(options) {
  return new TerminalSessionManager(options);
}

function publicSession(session) {
  const result = {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    envKeys: [...session.envKeys],
    envReferenceKeys: [...session.envReferenceKeys],
    maxOutputBytes: session.outputLimit,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    status: session.status,
    exitCode: session.exitCode,
    signal: session.signal,
    stopReason: session.stopReason,
    error: session.error ? structuredClone(session.error) : null,
    output: structuredClone(session.output),
    eventSequence: session.sequence,
  };
  if (session.projectId) result.projectId = session.projectId;
  if (session.runId) result.runId = session.runId;
  if (session.toolRunId) result.toolRunId = session.toolRunId;
  if (session.executionId) result.executionId = session.executionId;
  return result;
}

function supportsRuntimeV3Repository(value) {
  return Boolean(
    value
      && typeof value.createExecution === 'function'
      && typeof value.getExecution === 'function'
      && typeof value.listExecutions === 'function'
      && typeof value.updateExecution === 'function'
      && typeof value.appendEvent === 'function'
      && typeof value.listEvents === 'function'
      && typeof value.latestSequence === 'function',
  );
}

function terminalExecutionContext(input, session, timeoutMs, now) {
  const base = input?.executionContext
    ? createExecutionContext(input.executionContext)
    : createExecutionContext({
      taskId: `terminal:${session.projectId || 'local'}:${session.workspaceId}`,
      runId: session.runId || `terminal-run:${session.id}`,
      attemptId: session.toolRunId || session.id,
      traceId: optionalText(input?.traceId) || session.runId || session.id,
      deadlineAt: input?.deadlineAt || deadlineAt(now, timeoutMs),
      idempotencyKey: optionalText(input?.idempotencyKey) || session.id,
      environment: {},
      authority: objectValue(input?.authority),
      modelPolicy: { kind: 'terminal_session' },
      contextSnapshotId: optionalText(input?.contextSnapshotId) || `terminal:${session.id}`,
    });
  return createExecutionContext({
    ...base,
    taskId: `terminal:${base.taskId}:${session.id}`,
    attemptId: session.id,
    idempotencyKey: `terminal:${base.idempotencyKey}:${session.id}`,
    environment: {
      ...base.environment,
      terminal: {
        sessionId: session.id,
        projectId: session.projectId || '',
        workspaceId: session.workspaceId,
        toolRunId: session.toolRunId || '',
      },
    },
    modelPolicy: {
      ...base.modelPolicy,
      kind: 'terminal_session',
    },
    contextSnapshotId: `terminal:${base.contextSnapshotId}:${session.id}`,
  });
}

function durableMetadata(session) {
  return {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    projectId: session.projectId || '',
    runId: session.runId || '',
    toolRunId: session.toolRunId || '',
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    envKeys: [...session.envKeys],
    envReferenceKeys: [...session.envReferenceKeys],
    startedAt: session.startedAt,
  };
}

function durableResult(session) {
  const output = objectValue(session?.output);
  return {
    sessionId: String(session?.sessionId || session?.id || ''),
    workspaceId: String(session?.workspaceId || ''),
    projectId: optionalText(session?.projectId),
    runId: optionalText(session?.runId),
    toolRunId: optionalText(session?.toolRunId),
    command: String(session?.command || ''),
    args: Array.isArray(session?.args) ? session.args.map((value) => String(value)) : [],
    cwd: String(session?.cwd || ''),
    envKeys: stringList(session?.envKeys),
    envReferenceKeys: stringList(session?.envReferenceKeys),
    startedAt: String(session?.startedAt || ''),
    completedAt: session?.completedAt ? String(session.completedAt) : null,
    status: String(session?.status || 'failed'),
    exitCode: Number.isInteger(session?.exitCode) ? session.exitCode : null,
    signal: session?.signal ? String(session.signal) : null,
    stopReason: session?.stopReason ? String(session.stopReason) : null,
    error: session?.error && typeof session.error === 'object' ? structuredClone(session.error) : null,
    output: {
      stdout: String(output.stdout || ''),
      stderr: String(output.stderr || ''),
      stdoutBytes: nonNegativeInteger(output.stdoutBytes, 0),
      stderrBytes: nonNegativeInteger(output.stderrBytes, 0),
      truncated: output.truncated === true,
    },
    eventSequence: nonNegativeInteger(session?.eventSequence, 0),
  };
}

function durableStatus(status) {
  if (status === 'completed') return 'succeeded';
  if (['starting', 'queued'].includes(status)) return 'queued';
  if (['running', 'cancelling', 'cancelled', 'failed', 'reconcile_required'].includes(status)) return status;
  return 'failed';
}

function terminalStatus(status) {
  if (status === 'succeeded') return 'completed';
  if (['queued', 'running', 'cancelling', 'cancelled', 'failed', 'reconcile_required'].includes(status)) return status;
  return 'failed';
}

function terminalStreamId(context, executionId) {
  return `execution:${context.runId}:terminal:${executionId}`;
}

function persistedSession(record, { status = '' } = {}) {
  const metadata = objectValue(record?.metadata);
  const result = objectValue(record?.result);
  const output = objectValue(result.output);
  const session = {
    sessionId: String(result.sessionId || metadata.sessionId || record.executionId),
    workspaceId: String(result.workspaceId || metadata.workspaceId || record.context?.environment?.terminal?.workspaceId || ''),
    command: String(result.command || metadata.command || ''),
    args: Array.isArray(result.args) ? result.args.map((value) => String(value)) : stringList(metadata.args),
    cwd: String(result.cwd || metadata.cwd || ''),
    envKeys: stringList(result.envKeys?.length ? result.envKeys : metadata.envKeys),
    envReferenceKeys: stringList(result.envReferenceKeys?.length ? result.envReferenceKeys : metadata.envReferenceKeys),
    startedAt: String(result.startedAt || metadata.startedAt || record.createdAt),
    completedAt: result.completedAt || record.completedAt || null,
    status: status || String(result.status || terminalStatus(record.status)),
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    signal: result.signal ? String(result.signal) : null,
    stopReason: result.stopReason ? String(result.stopReason) : null,
    error: result.error && typeof result.error === 'object'
      ? structuredClone(result.error)
      : Object.keys(objectValue(record.error)).length ? structuredClone(record.error) : null,
    output: {
      stdout: String(output.stdout || ''),
      stderr: String(output.stderr || ''),
      stdoutBytes: nonNegativeInteger(output.stdoutBytes, 0),
      stderrBytes: nonNegativeInteger(output.stderrBytes, 0),
      truncated: output.truncated === true,
    },
    eventSequence: nonNegativeInteger(result.eventSequence, 0),
    executionId: record.executionId,
  };
  const projectId = optionalText(result.projectId || metadata.projectId || record.context?.environment?.terminal?.projectId);
  const runId = optionalText(result.runId || metadata.runId || record.context?.runId);
  const toolRunId = optionalText(result.toolRunId || metadata.toolRunId || record.context?.environment?.terminal?.toolRunId);
  if (projectId) session.projectId = projectId;
  if (runId) session.runId = runId;
  if (toolRunId) session.toolRunId = toolRunId;
  return session;
}

function persistedTerminalEvent(event) {
  const payload = objectValue(event?.payload);
  return {
    sequence: Number(event.sequence),
    type: String(event.type || 'terminal.event'),
    stream: String(payload.stream || 'system'),
    text: String(payload.text || ''),
    createdAt: String(event.occurredAt || ''),
    ...(payload.truncated === true ? { truncated: true } : {}),
  };
}

function durableEventPayload(event, maximumBytes) {
  const originalText = String(event?.text || '');
  const input = String(event?.stream || '') === 'stdin';
  const limited = input ? { text: '[redacted]', truncated: false } : truncateUtf8(originalText, maximumBytes);
  return {
    sessionId: String(event?.sessionId || ''),
    stream: String(event?.stream || 'system'),
    text: limited.text,
    textBytes: Buffer.byteLength(originalText),
    truncated: limited.truncated,
  };
}

function truncateUtf8(value, maximumBytes) {
  const source = Buffer.from(String(value || ''), 'utf8');
  if (source.length <= maximumBytes) return { text: source.toString('utf8'), truncated: false };
  return { text: source.subarray(0, maximumBytes).toString('utf8'), truncated: true };
}

function isPublicSessionActive(session) {
  return ['starting', 'queued', 'running', 'cancelling'].includes(String(session?.status || ''));
}

function normalizePersistenceError(error) {
  return {
    code: String(error?.code || 'TERMINAL_RECEIPT_PERSIST_FAILED'),
    message: String(error?.message || error || 'Unable to persist terminal receipt.').slice(0, 500),
  };
}

function deadlineAt(now, timeoutMs) {
  const current = now();
  const date = current instanceof Date ? current : new Date(current);
  if (!Number.isFinite(date.getTime())) {
    throw terminalError('TERMINAL_CLOCK_INVALID', 'The terminal clock returned an invalid date.', 500);
  }
  return new Date(date.getTime() + timeoutMs).toISOString();
}

function optionalText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function stringList(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item));
}

async function verifiedWorkspaceRoot(value) {
  const raw = String(value || '').trim();
  if (!raw || !path.isAbsolute(raw)) {
    throw terminalError('TERMINAL_WORKSPACE_REQUIRED', 'A verified absolute workspace root is required.', 400);
  }
  const root = await realpath(raw).catch(() => {
    throw terminalError('TERMINAL_WORKSPACE_NOT_FOUND', 'The terminal workspace root does not exist.', 404);
  });
  const info = await stat(root);
  if (!info.isDirectory()) throw terminalError('TERMINAL_WORKSPACE_NOT_DIRECTORY', 'The terminal workspace root must be a directory.', 400);
  return root;
}

async function resolveWorkspaceDirectory(root, value) {
  const requested = value === undefined || value === null || value === '' ? '.' : String(value);
  if (requested.includes('\0') || path.isAbsolute(requested) || path.win32.isAbsolute(requested)) {
    throw terminalError('TERMINAL_CWD_INVALID', 'The terminal working directory must be workspace-relative.', 400);
  }
  const target = path.resolve(root, requested);
  if (!isPathInside(root, target)) throw terminalError('TERMINAL_CWD_ESCAPE', 'The terminal working directory escapes its workspace.', 403);
  const resolved = await realpath(target).catch(() => {
    throw terminalError('TERMINAL_CWD_NOT_FOUND', 'The terminal working directory does not exist.', 404);
  });
  const info = await stat(resolved);
  if (!info.isDirectory()) throw terminalError('TERMINAL_CWD_NOT_DIRECTORY', 'The terminal working directory must be a directory.', 400);
  if (!isPathInside(root, resolved)) throw terminalError('TERMINAL_CWD_ESCAPE', 'The terminal working directory escapes its workspace.', 403);
  return resolved;
}

function resolveEnvironment(input, sourceEnvironment) {
  const inherit = input.inheritEnv !== false;
  const value = inherit ? { ...sourceEnvironment } : {};
  const keys = [];
  const referenceKeys = [];
  for (const [key, raw] of Object.entries(objectValue(input.env))) {
    assertEnvironmentName(key);
    value[key] = String(raw);
    keys.push(key);
  }
  for (const [key, sourceKeyValue] of Object.entries(objectValue(input.envRefs))) {
    assertEnvironmentName(key);
    const sourceKey = String(sourceKeyValue || '');
    assertEnvironmentName(sourceKey);
    if (sourceEnvironment[sourceKey] === undefined) {
      throw terminalError('TERMINAL_ENV_REFERENCE_MISSING', `Environment variable ${sourceKey} is not configured.`, 422);
    }
    value[key] = String(sourceEnvironment[sourceKey]);
    referenceKeys.push(key);
  }
  return { value, keys: keys.sort(), referenceKeys: referenceKeys.sort() };
}

function requiredCommand(value) {
  const command = String(value || '').trim();
  if (!command || command.includes('\0') || /[\r\n]/u.test(command)) {
    throw terminalError('TERMINAL_COMMAND_INVALID', 'A direct executable command is required.', 400);
  }
  return command;
}

function commandArguments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 512) throw terminalError('TERMINAL_ARGUMENTS_INVALID', 'Terminal arguments must be an array of at most 512 values.', 400);
  return value.map((entry) => {
    const argument = String(entry);
    if (argument.includes('\0') || Buffer.byteLength(argument) > 32 * 1024) {
      throw terminalError('TERMINAL_ARGUMENT_INVALID', 'A terminal argument is invalid or too large.', 400);
    }
    return argument;
  });
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = Number(child.pid);
  if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return;
  }
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await delay(250);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } else {
    child.kill('SIGTERM');
  }
}

function isActive(session) {
  return ['starting', 'running', 'cancelling'].includes(session.status);
}

function isAbortSignal(value) {
  return value && typeof value === 'object' && typeof value.addEventListener === 'function' && typeof value.aborted === 'boolean';
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requiredId(value, label) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(id)) {
    throw terminalError('TERMINAL_ID_INVALID', `${label} must use letters, digits, dashes, or underscores.`, 400);
  }
  return id;
}

function optionalId(value) {
  const id = String(value || '').trim();
  return id ? id.slice(0, 200) : '';
}

function assertEnvironmentName(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(value || ''))) {
    throw terminalError('TERMINAL_ENV_NAME_INVALID', 'Terminal environment names must be valid environment variable names.', 400);
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(numeric)));
}

function nonNegativeInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback;
}

function normalizeError(error, fallbackCode) {
  return {
    code: String(error?.code || fallbackCode),
    message: String(error?.message || 'The terminal process could not be started.').slice(0, 2_000),
    status: Number.isInteger(error?.status) ? error.status : 502,
  };
}

function terminalError(code, message, status, details) {
  return new TerminalSessionError(code, message, status, details);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
