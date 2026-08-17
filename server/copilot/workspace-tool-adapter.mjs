import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/iu;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class WorkspaceToolError extends Error {
  constructor(code, message, status = 400, receipt = null) {
    super(message);
    this.name = 'WorkspaceToolError';
    this.code = code;
    this.status = status;
    if (receipt) this.receipt = jsonValue(receipt);
  }
}

export class WorkspaceToolAdapter {
  constructor({
    workspaceRoot = process.cwd(),
    fetchImpl = globalThis.fetch,
    env = process.env,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    execTimeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
    httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
    this.workspaceRoot = path.resolve(String(workspaceRoot || process.cwd()));
    this.fetchImpl = fetchImpl;
    this.env = env && typeof env === 'object' ? env : {};
    this.maxFileBytes = positiveInteger(maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1, 64 * 1024 * 1024);
    this.maxOutputBytes = positiveInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1, 8 * 1024 * 1024);
    this.execTimeoutMs = positiveInteger(execTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 50, MAX_TIMEOUT_MS);
    this.httpTimeoutMs = positiveInteger(httpTimeoutMs, DEFAULT_HTTP_TIMEOUT_MS, 50, MAX_TIMEOUT_MS);
    this.tools = new Map();
    this.#registerBuiltins();
  }

  list({ names = null } = {}) {
    const selected = names ? new Set(arrayOfStrings(names)) : null;
    return [...this.tools.values()]
      .filter((definition) => !selected || selected.has(definition.name))
      .map(({ handler, ...definition }) => structuredClone(definition));
  }

  get(name) {
    return this.tools.get(String(name || '')) || null;
  }

  /**
   * Creates a sibling adapter with the exact same execution limits and
   * environment policy, scoped to a previously validated workspace root.
   * ProjectWorkspaceService owns validation and lifecycle; this adapter owns
   * filesystem containment once a root has been selected.
   */
  forWorkspace(workspaceRoot) {
    const root = String(workspaceRoot || '').trim();
    if (!root || !path.isAbsolute(root)) {
      throw workspaceError('WORKSPACE_ROOT_INVALID', 'A valid absolute workspace root is required.', 400);
    }
    return new WorkspaceToolAdapter({
      workspaceRoot: root,
      fetchImpl: this.fetchImpl,
      env: this.env,
      maxFileBytes: this.maxFileBytes,
      maxOutputBytes: this.maxOutputBytes,
      execTimeoutMs: this.execTimeoutMs,
      httpTimeoutMs: this.httpTimeoutMs,
    });
  }

  search(query = '', { limit = 20 } = {}) {
    const tokens = String(query || '').trim().toLowerCase().split(/\s+/u).filter(Boolean);
    return this.list()
      .map((tool, index) => ({
        tool,
        index,
        score: tokens.reduce((score, token) => score + (`${tool.name} ${tool.description} ${tool.tags.join(' ')}`.toLowerCase().includes(token) ? 1 : 0), 0),
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, positiveInteger(limit, 20, 1, 100))
      .map(({ tool }) => tool);
  }

  async execute(name, input = {}, context = {}) {
    const tool = this.get(name);
    if (!tool) throw workspaceError('WORKSPACE_TOOL_UNKNOWN', `Unknown workspace tool: ${name}.`, 404);
    assertNotCancelled(context.signal);
    const result = await tool.handler(normalizeObject(input), { ...context, toolName: tool.name });
    assertNotCancelled(context.signal);
    return jsonValue(result);
  }

  register(definition) {
    if (!definition?.name || typeof definition.handler !== 'function') {
      throw new TypeError('A tool name and handler are required.');
    }
    const name = String(definition.name).trim();
    const category = String(definition.category || name.split('.')[0] || 'workspace');
    this.tools.set(name, Object.freeze({
      version: '1.0.0',
      category,
      tags: [category, ...name.split('.')],
      risk: 'read',
      scopes: [],
      idempotent: true,
      parallelSafe: true,
      inputSchema: objectSchema(),
      ...definition,
      name,
      category,
    }));
    return this;
  }

  #registerBuiltins() {
    this.register({
      name: 'workspace.list',
      description: 'List files and directories below the configured workspace root without following symbolic links.',
      inputSchema: objectSchema({
        path: stringSchema('Workspace-relative directory. Defaults to the workspace root.'),
        recursive: booleanSchema('Recurse into child directories.'),
        maxDepth: integerSchema(0, 12),
        limit: integerSchema(1, 2_000),
        includeHidden: booleanSchema('Include entries whose names begin with a dot.'),
      }),
      handler: (input, context) => this.#listWorkspace(input, context),
    });

    this.register({
      name: 'workspace.read',
      description: 'Read a bounded byte range from a file below the configured workspace root.',
      inputSchema: objectSchema({
        path: stringSchema('Workspace-relative file path.'),
        encoding: enumSchema(['utf8', 'base64']),
        offset: integerSchema(0),
        maxBytes: integerSchema(1, this.maxFileBytes),
      }, ['path']),
      handler: (input, context) => this.#readWorkspace(input, context),
    });

    this.register({
      name: 'workspace.write',
      description: 'Atomically replace a workspace file with UTF-8 or base64 content.',
      risk: 'approval_required',
      parallelSafe: false,
      inputSchema: objectSchema({
        path: stringSchema('Workspace-relative file path.'),
        content: stringSchema('Complete replacement content.'),
        encoding: enumSchema(['utf8', 'base64']),
        createDirectories: booleanSchema('Create missing parent directories.'),
        expectedSha256: stringSchema('Optional optimistic-concurrency SHA-256 for the existing file.'),
      }, ['path', 'content']),
      handler: (input, context) => this.#writeWorkspace(input, context),
    });

    this.register({
      name: 'workspace.patch',
      description: 'Atomically apply exact text edits or a single-file unified diff to a UTF-8 workspace file.',
      risk: 'approval_required',
      idempotent: false,
      parallelSafe: false,
      inputSchema: objectSchema({
        path: stringSchema('Workspace-relative UTF-8 file path.'),
        edits: {
          type: 'array',
          minItems: 1,
          items: objectSchema({
            oldText: stringSchema('Exact source text.'),
            newText: stringSchema('Replacement text.'),
            replaceAll: booleanSchema('Replace every match instead of requiring a unique match.'),
          }, ['oldText', 'newText']),
        },
        patch: stringSchema('Single-file unified diff.'),
        expectedSha256: stringSchema('Optional optimistic-concurrency SHA-256 for the existing file.'),
      }, ['path']),
      handler: (input, context) => this.#patchWorkspace(input, context),
    });

    this.register({
      name: 'exec.run',
      description: 'Run one executable directly with an argument array and shell disabled.',
      risk: 'approval_required',
      idempotent: false,
      parallelSafe: false,
      inputSchema: objectSchema({
        command: stringSchema('Executable name or path. Shell expressions are not interpreted.'),
        args: arraySchema(stringSchema('One literal executable argument.')),
        cwd: stringSchema('Workspace-relative working directory.'),
        env: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        envRefs: { type: 'object', additionalProperties: stringSchema('Source process environment variable name.') },
        inheritEnv: booleanSchema('Inherit the server process environment. Defaults to true.'),
        stdin: stringSchema('Optional UTF-8 standard input.'),
        timeoutMs: integerSchema(50, MAX_TIMEOUT_MS),
        maxOutputBytes: integerSchema(1, 8 * 1024 * 1024),
      }, ['command']),
      handler: (input, context) => this.#runExecutable(input, context),
    });

    this.register({
      name: 'http.request',
      description: 'Send a bounded HTTP(S) request. Sensitive request headers must reference server environment variables.',
      risk: 'approval_required',
      idempotent: false,
      inputSchema: objectSchema({
        url: stringSchema('Absolute HTTP or HTTPS URL.'),
        method: stringSchema('HTTP method. Defaults to GET.'),
        headers: {
          type: 'object',
          additionalProperties: {
            oneOf: [
              { type: 'string' },
              objectSchema({
                env: stringSchema('Source process environment variable name.'),
                prefix: stringSchema('Optional value prefix, such as Bearer followed by a space.'),
              }, ['env']),
            ],
          },
        },
        body: { type: ['string', 'object', 'array', 'number', 'boolean', 'null'] },
        bodyEncoding: enumSchema(['utf8', 'base64', 'json']),
        responseEncoding: enumSchema(['utf8', 'base64']),
        timeoutMs: integerSchema(50, MAX_TIMEOUT_MS),
        maxResponseBytes: integerSchema(1, 8 * 1024 * 1024),
      }, ['url']),
      handler: (input, context) => this.#requestHttp(input, context),
    });
  }

  async #listWorkspace(input, context) {
    const root = await this.#canonicalRoot();
    const target = await this.#resolveExistingPath(input.path ?? '.', { root, kind: 'directory' });
    const recursive = input.recursive === true;
    const maxDepth = positiveInteger(input.maxDepth, recursive ? 4 : 0, 0, 12);
    const limit = positiveInteger(input.limit, 500, 1, 2_000);
    const includeHidden = input.includeHidden === true;
    const entries = [];
    let truncated = false;

    const visit = async (directory, relativeDirectory, depth) => {
      assertNotCancelled(context.signal);
      const children = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (!includeHidden && child.name.startsWith('.')) continue;
        if (entries.length >= limit) {
          truncated = true;
          return;
        }
        const absolute = path.join(directory, child.name);
        const relative = portablePath(path.join(relativeDirectory, child.name));
        const info = await lstat(absolute);
        const entry = {
          path: relative,
          name: child.name,
          type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.isFile() ? info.size : null,
          modifiedAt: info.mtime.toISOString(),
        };
        if (info.isSymbolicLink()) {
          entry.targetInsideRoot = await realpath(absolute)
            .then((resolved) => isPathInside(root, resolved))
            .catch(() => false);
        }
        entries.push(entry);
        if (info.isDirectory() && recursive && depth < maxDepth) {
          const canonicalChild = await realpath(absolute);
          assertPathInside(root, canonicalChild);
          await visit(canonicalChild, relative, depth + 1);
          if (truncated) return;
        }
      }
    };

    await visit(target.absolute, target.relative === '.' ? '' : target.relative, 0);
    return {
      type: 'workspace.list.receipt',
      root: '.',
      path: target.relative,
      entries,
      count: entries.length,
      truncated,
    };
  }

  async #readWorkspace(input, context) {
    assertNotCancelled(context.signal);
    const root = await this.#canonicalRoot();
    const target = await this.#resolveExistingPath(requiredPath(input.path), { root, kind: 'file' });
    const offset = positiveInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = positiveInteger(input.maxBytes, Math.min(this.maxFileBytes, 1024 * 1024), 1, this.maxFileBytes);
    const handle = await open(target.absolute, 'r');
    try {
      const info = await handle.stat();
      const requested = Math.max(0, Math.min(maxBytes, info.size - offset));
      const buffer = Buffer.alloc(requested);
      const { bytesRead } = requested ? await handle.read(buffer, 0, requested, offset) : { bytesRead: 0 };
      assertNotCancelled(context.signal);
      const content = buffer.subarray(0, bytesRead);
      const encoding = input.encoding === 'base64' ? 'base64' : 'utf8';
      return {
        type: 'workspace.read.receipt',
        path: target.relative,
        encoding,
        content: content.toString(encoding),
        size: info.size,
        offset,
        bytesRead,
        truncated: offset + bytesRead < info.size,
        contentSha256: sha256(content),
        sha256: offset === 0 && bytesRead === info.size ? sha256(content) : null,
      };
    } finally {
      await handle.close();
    }
  }

  async #writeWorkspace(input, context) {
    assertNotCancelled(context.signal);
    const content = decodeContent(input.content, input.encoding, this.maxFileBytes);
    const root = await this.#canonicalRoot();
    const target = await this.#resolveWritablePath(requiredPath(input.path), {
      root,
      createDirectories: input.createDirectories !== false,
    });
    const previous = await this.#existingFileReceipt(target.absolute);
    assertExpectedSha(input.expectedSha256, previous?.sha256 || null);
    await atomicWrite(target.absolute, content, context.signal);
    return {
      type: 'workspace.write.receipt',
      path: target.relative,
      created: !previous,
      bytesWritten: content.length,
      sha256: sha256(content),
      previousSha256: previous?.sha256 || null,
      atomic: true,
    };
  }

  async #patchWorkspace(input, context) {
    assertNotCancelled(context.signal);
    const root = await this.#canonicalRoot();
    const target = await this.#resolveExistingPath(requiredPath(input.path), { root, kind: 'file', rejectSymlink: true });
    const before = await readBoundedFile(target.absolute, this.maxFileBytes);
    const beforeSha256 = sha256(before);
    assertExpectedSha(input.expectedSha256, beforeSha256);
    const source = before.toString('utf8');
    let applied;
    if (typeof input.patch === 'string' && input.patch.trim()) {
      applied = applyUnifiedDiff(source, input.patch);
    } else {
      applied = applyExactEdits(source, input.edits);
    }
    const after = Buffer.from(applied.content, 'utf8');
    if (after.length > this.maxFileBytes) {
      throw workspaceError('WORKSPACE_FILE_TOO_LARGE', `Patched content exceeds ${this.maxFileBytes} bytes.`, 413);
    }
    assertNotCancelled(context.signal);
    await atomicWrite(target.absolute, after, context.signal);
    return {
      type: 'workspace.patch.receipt',
      path: target.relative,
      replacements: applied.replacements,
      bytesWritten: after.length,
      previousSha256: beforeSha256,
      sha256: sha256(after),
      changed: !before.equals(after),
      atomic: true,
    };
  }

  async #runExecutable(input, context) {
    const command = requiredString(input.command, 'command');
    if (/[\0\r\n]/u.test(command)) throw workspaceError('WORKSPACE_EXEC_COMMAND_INVALID', 'command contains a null byte or line break.');
    const args = arrayOfStrings(input.args);
    const root = await this.#canonicalRoot();
    const cwd = await this.#resolveExistingPath(input.cwd ?? '.', { root, kind: 'directory' });
    const timeoutMs = positiveInteger(input.timeoutMs, this.execTimeoutMs, 50, MAX_TIMEOUT_MS);
    const maxOutputBytes = positiveInteger(input.maxOutputBytes, this.maxOutputBytes, 1, 8 * 1024 * 1024);
    const environment = resolveProcessEnvironment(input, this.env);
    const startedAt = Date.now();
    const receiptBase = {
      type: 'exec.run.receipt',
      command,
      args,
      cwd: cwd.relative,
      shell: false,
      timeoutMs,
      envKeys: environment.keys,
      envReferenceKeys: environment.referenceKeys,
    };
    assertNotCancelled(context.signal);

    const launch = await resolveExecutableLaunch(command, args, {
      cwd: cwd.absolute,
      environment: environment.value,
    });

    const child = spawn(launch.command, launch.args, {
      cwd: cwd.absolute,
      env: environment.value,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = createBoundedCollector(maxOutputBytes);
    const stderr = createBoundedCollector(maxOutputBytes);
    child.stdout.on('data', stdout.append);
    child.stderr.on('data', stderr.append);

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let terminationPromise = null;
    const stop = () => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return;
      terminationPromise ||= terminateProcessTree(child.pid, child);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timeout.unref?.();
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    context.signal?.addEventListener('abort', onAbort, { once: true });

    if (input.stdin !== undefined) child.stdin.end(String(input.stdin));
    else child.stdin.end();

    try {
      const outcome = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      }).catch((error) => {
        throw workspaceError('WORKSPACE_EXEC_SPAWN_FAILED', `Failed to start ${command}: ${error.message}`, 400);
      });
      settled = true;
      const receipt = {
        ...receiptBase,
        resolvedCommand: launch.command,
        commandShim: launch.shim,
        status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'completed',
        exitCode: outcome.exitCode,
        signal: outcome.signal || null,
        durationMs: Date.now() - startedAt,
        timedOut,
        cancelled,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutBytes: stdout.totalBytes(),
        stderrBytes: stderr.totalBytes(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
      };
      if (terminationPromise) await terminationPromise;
      if (cancelled) throw workspaceError('COPILOT_RUN_CANCELLED', 'Workspace execution was cancelled.', 499, receipt);
      return receipt;
    } finally {
      settled = true;
      clearTimeout(timeout);
      context.signal?.removeEventListener('abort', onAbort);
    }
  }

  async #requestHttp(input, context) {
    const url = parseHttpUrl(input.url);
    const method = String(input.method || 'GET').trim().toUpperCase();
    if (!/^[A-Z]+$/u.test(method)) throw workspaceError('WORKSPACE_HTTP_METHOD_INVALID', 'HTTP method must contain letters only.');
    const headers = resolveHttpHeaders(input.headers, this.env);
    const body = encodeHttpBody(input.body, input.bodyEncoding, headers.values);
    if ((method === 'GET' || method === 'HEAD') && body !== undefined) {
      throw workspaceError('WORKSPACE_HTTP_BODY_INVALID', `${method} requests cannot include a body.`);
    }
    const timeoutMs = positiveInteger(input.timeoutMs, this.httpTimeoutMs, 50, MAX_TIMEOUT_MS);
    const maxResponseBytes = positiveInteger(input.maxResponseBytes, this.maxOutputBytes, 1, 8 * 1024 * 1024);
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      controller.abort(context.signal?.reason);
    };
    context.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('HTTP request timed out.'));
    }, timeoutMs);
    timeout.unref?.();
    const startedAt = Date.now();
    assertNotCancelled(context.signal);

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: headers.values,
        body,
        redirect: 'follow',
        signal: controller.signal,
      });
      const content = await readResponseBody(response.body, maxResponseBytes, controller.signal);
      if (cancelled) throw cancelledError();
      const encoding = input.responseEncoding === 'base64' ? 'base64' : 'utf8';
      return {
        type: 'http.request.receipt',
        url: url.toString(),
        method,
        requestHeaders: headers.receipt,
        requestBodyBytes: body === undefined ? 0 : Buffer.byteLength(body),
        status: response.status,
        statusText: String(response.statusText || ''),
        ok: response.ok,
        responseHeaders: responseHeadersReceipt(response.headers),
        body: content.buffer.toString(encoding),
        bodyEncoding: encoding,
        responseBytes: content.totalBytes,
        responseTruncated: content.truncated,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (cancelled || context.signal?.aborted) throw cancelledError();
      if (timedOut) {
        throw workspaceError('WORKSPACE_HTTP_TIMEOUT', `HTTP request exceeded ${timeoutMs} ms.`, 408, {
          type: 'http.request.receipt',
          url: url.toString(),
          method,
          status: 'timed_out',
          timeoutMs,
          durationMs: Date.now() - startedAt,
        });
      }
      if (error instanceof WorkspaceToolError) throw error;
      throw workspaceError('WORKSPACE_HTTP_FAILED', `HTTP request failed: ${error.message}`, 502);
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener('abort', onAbort);
    }
  }

  async #canonicalRoot() {
    try {
      return await realpath(this.workspaceRoot);
    } catch (error) {
      throw workspaceError('WORKSPACE_ROOT_UNAVAILABLE', `Workspace root is unavailable: ${error.message}`, 500);
    }
  }

  async #resolveExistingPath(value, { root, kind = null, rejectSymlink = false } = {}) {
    const relative = normalizeRelativePath(value);
    const lexical = path.resolve(root, relative);
    assertPathInside(root, lexical);
    let info;
    try {
      info = await lstat(lexical);
    } catch (error) {
      if (error.code === 'ENOENT') throw workspaceError('WORKSPACE_PATH_NOT_FOUND', `Workspace path does not exist: ${relative}.`, 404);
      throw error;
    }
    if (rejectSymlink && info.isSymbolicLink()) {
      throw workspaceError('WORKSPACE_SYMLINK_WRITE_DENIED', `Symbolic-link writes are not allowed: ${relative}.`, 403);
    }
    const absolute = await realpath(lexical);
    assertPathInside(root, absolute);
    const targetInfo = await lstat(absolute);
    if (kind === 'file' && !targetInfo.isFile()) throw workspaceError('WORKSPACE_FILE_REQUIRED', `Workspace path is not a file: ${relative}.`);
    if (kind === 'directory' && !targetInfo.isDirectory()) throw workspaceError('WORKSPACE_DIRECTORY_REQUIRED', `Workspace path is not a directory: ${relative}.`);
    return { absolute, relative };
  }

  async #resolveWritablePath(value, { root, createDirectories = true } = {}) {
    const relative = normalizeRelativePath(value, { allowRoot: false });
    const absolute = path.resolve(root, relative);
    assertPathInside(root, absolute);
    await ensureSafeDirectory(root, path.dirname(absolute), createDirectories);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw workspaceError('WORKSPACE_SYMLINK_WRITE_DENIED', `Symbolic-link writes are not allowed: ${relative}.`, 403);
      if (!info.isFile()) throw workspaceError('WORKSPACE_FILE_REQUIRED', `Workspace path is not a file: ${relative}.`);
      assertPathInside(root, await realpath(absolute));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { absolute, relative };
  }

  async #existingFileReceipt(absolute) {
    try {
      const content = await readBoundedFile(absolute, this.maxFileBytes);
      return { bytes: content.length, sha256: sha256(content) };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
}

async function ensureSafeDirectory(root, target, createDirectories) {
  assertPathInside(root, target);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw workspaceError('WORKSPACE_SYMLINK_WRITE_DENIED', `Symbolic-link directory traversal is not allowed: ${portablePath(path.relative(root, current))}.`, 403);
      if (!info.isDirectory()) throw workspaceError('WORKSPACE_DIRECTORY_REQUIRED', `Workspace parent is not a directory: ${portablePath(path.relative(root, current))}.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!createDirectories) throw workspaceError('WORKSPACE_PARENT_NOT_FOUND', `Workspace parent does not exist: ${portablePath(path.relative(root, current))}.`, 404);
      await mkdir(current).catch(async (mkdirError) => {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      });
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) throw workspaceError('WORKSPACE_DIRECTORY_REQUIRED', 'Workspace parent directory could not be created safely.');
    }
    assertPathInside(root, await realpath(current));
  }
}

async function atomicWrite(target, content, signal) {
  assertNotCancelled(signal);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    assertNotCancelled(signal);
    await rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readBoundedFile(filePath, maximum) {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw workspaceError('WORKSPACE_FILE_REQUIRED', 'Workspace path is not a file.');
    if (info.size > maximum) throw workspaceError('WORKSPACE_FILE_TOO_LARGE', `Workspace file exceeds ${maximum} bytes.`, 413);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function applyExactEdits(source, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw workspaceError('WORKSPACE_PATCH_REQUIRED', 'workspace.patch requires edits or a unified diff.');
  }
  let content = source;
  let replacements = 0;
  for (const [index, edit] of edits.entries()) {
    const oldText = typeof edit?.oldText === 'string' ? edit.oldText : null;
    const newText = typeof edit?.newText === 'string' ? edit.newText : null;
    if (!oldText) throw workspaceError('WORKSPACE_PATCH_EDIT_INVALID', `Edit ${index + 1} requires non-empty oldText.`);
    if (newText === null) throw workspaceError('WORKSPACE_PATCH_EDIT_INVALID', `Edit ${index + 1} requires newText.`);
    const matches = countOccurrences(content, oldText);
    if (matches === 0) throw workspaceError('WORKSPACE_PATCH_CONTEXT_MISSING', `Edit ${index + 1} did not match the file.`, 409);
    if (edit.replaceAll === true) {
      content = content.split(oldText).join(newText);
      replacements += matches;
    } else {
      if (matches !== 1) throw workspaceError('WORKSPACE_PATCH_CONTEXT_AMBIGUOUS', `Edit ${index + 1} matched ${matches} locations; set replaceAll or provide more context.`, 409);
      content = content.replace(oldText, newText);
      replacements += 1;
    }
  }
  return { content, replacements };
}

function applyUnifiedDiff(source, patchText) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const sourceEndsWithNewline = /\r?\n$/u.test(source);
  const sourceLines = source.replaceAll('\r\n', '\n').split('\n');
  if (sourceEndsWithNewline) sourceLines.pop();
  const patchLines = String(patchText).replaceAll('\r\n', '\n').split('\n');
  const hunkIndexes = patchLines.map((line, index) => line.startsWith('@@ ') ? index : -1).filter((index) => index >= 0);
  if (!hunkIndexes.length) throw workspaceError('WORKSPACE_PATCH_INVALID', 'Unified diff contains no hunks.');
  const fileHeaders = patchLines.filter((line) => line.startsWith('--- '));
  if (fileHeaders.length > 1) throw workspaceError('WORKSPACE_PATCH_MULTIPLE_FILES', 'workspace.patch accepts one file per call.');
  const output = [];
  let sourceIndex = 0;
  let replacements = 0;
  for (let hunkNumber = 0; hunkNumber < hunkIndexes.length; hunkNumber += 1) {
    const hunkIndex = hunkIndexes[hunkNumber];
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(patchLines[hunkIndex]);
    if (!header) throw workspaceError('WORKSPACE_PATCH_INVALID', `Invalid unified diff hunk header: ${patchLines[hunkIndex]}.`);
    const expectedIndex = Math.max(0, Number(header[1]) - 1);
    if (expectedIndex < sourceIndex) throw workspaceError('WORKSPACE_PATCH_INVALID', 'Unified diff hunks overlap or are out of order.');
    output.push(...sourceLines.slice(sourceIndex, expectedIndex));
    sourceIndex = expectedIndex;
    const end = hunkNumber + 1 < hunkIndexes.length ? hunkIndexes[hunkNumber + 1] : patchLines.length;
    for (const line of patchLines.slice(hunkIndex + 1, end)) {
      if (line.startsWith('\\ No newline at end of file') || line === '') continue;
      const marker = line[0];
      const value = line.slice(1);
      if (marker === ' ' || marker === '-') {
        if (sourceLines[sourceIndex] !== value) {
          throw workspaceError('WORKSPACE_PATCH_CONTEXT_MISSING', `Unified diff context did not match at source line ${sourceIndex + 1}.`, 409);
        }
        if (marker === ' ') output.push(value);
        else replacements += 1;
        sourceIndex += 1;
      } else if (marker === '+') {
        output.push(value);
        replacements += 1;
      } else if (!line.startsWith('--- ') && !line.startsWith('+++ ')) {
        throw workspaceError('WORKSPACE_PATCH_INVALID', `Invalid unified diff line: ${line}.`);
      }
    }
  }
  output.push(...sourceLines.slice(sourceIndex));
  return { content: `${output.join(newline)}${sourceEndsWithNewline ? newline : ''}`, replacements };
}

async function resolveExecutableLaunch(command, args, { cwd, environment }) {
  if (process.platform !== 'win32') return { command, args, shim: null };

  const executable = await findWindowsExecutable(command, cwd, environment);
  if (!executable || !/\.(?:bat|cmd)$/iu.test(executable)) {
    return { command: executable || command, args, shim: null };
  }

  const entrypoint = await parseNodeCommandShim(executable);
  return {
    command: process.execPath,
    args: [entrypoint, ...args],
    shim: executable,
  };
}

async function findWindowsExecutable(command, cwd, environment) {
  const hasDirectory = path.win32.isAbsolute(command) || /[\\/]/u.test(command);
  const extension = path.win32.extname(command);
  const pathExtensions = extension
    ? ['']
    : environmentValue(environment, 'PATHEXT', '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean);
  const directories = hasDirectory
    ? ['']
    : environmentValue(environment, 'PATH', '')
      .split(path.delimiter)
      .map((value) => value.trim().replace(/^"|"$/gu, ''))
      .filter(Boolean);

  for (const directory of directories) {
    for (const suffix of pathExtensions) {
      const candidate = hasDirectory
        ? path.resolve(cwd, `${command}${suffix}`)
        : path.resolve(directory, `${command}${suffix}`);
      try {
        const info = await lstat(candidate);
        if (info.isFile()) return await realpath(candidate);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
  }
  return null;
}

async function parseNodeCommandShim(shimPath) {
  const source = (await readBoundedFile(shimPath, 256 * 1024)).toString('utf8');
  const variables = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const assignment = /^\s*SET\s+"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"\s*$/iu.exec(line);
    const name = assignment?.[1].toUpperCase();
    if (name && !variables.has(name)) variables.set(name, assignment[2]);
  }

  let invocation = null;
  for (const line of source.split(/\r?\n/u)) {
    if (!/%\*\s*$/u.test(line)) continue;
    const match = /"([^"]+)"\s+"([^"]+)"\s+%\*\s*$/u.exec(line);
    if (match) invocation = { executable: match[1], entrypoint: match[2] };
  }
  if (!invocation || !/%(?:_prog|NODE_EXE)%/iu.test(invocation.executable)) {
    throw workspaceError(
      'WORKSPACE_EXEC_SHIM_UNSUPPORTED',
      `Command shim is not a supported Node launcher: ${shimPath}.`,
      422,
    );
  }

  const expanded = expandCommandShimValue(invocation.entrypoint, variables, path.dirname(shimPath));
  if (!/\.(?:cjs|js|mjs)$/iu.test(expanded)) {
    throw workspaceError('WORKSPACE_EXEC_SHIM_UNSUPPORTED', `Command shim entrypoint is not JavaScript: ${shimPath}.`, 422);
  }
  try {
    const info = await lstat(expanded);
    if (!info.isFile()) throw new Error('entrypoint is not a file');
    return await realpath(expanded);
  } catch (error) {
    throw workspaceError('WORKSPACE_EXEC_SHIM_INVALID', `Command shim entrypoint is unavailable: ${error.message}`, 422);
  }
}

function expandCommandShimValue(value, variables, shimDirectory, seen = new Set()) {
  const variable = /^%([A-Za-z_][A-Za-z0-9_]*)%$/u.exec(value);
  if (variable) {
    const name = variable[1].toUpperCase();
    if (seen.has(name) || !variables.has(name)) {
      throw workspaceError('WORKSPACE_EXEC_SHIM_UNSUPPORTED', `Command shim contains an unresolved variable: ${variable[0]}.`, 422);
    }
    return expandCommandShimValue(variables.get(name), variables, shimDirectory, new Set([...seen, name]));
  }

  const withDirectory = value
    .replace(/^%~dp0/iu, `${shimDirectory}${path.win32.sep}`)
    .replace(/^%dp0%/iu, `${shimDirectory}${path.win32.sep}`);
  if (/%[^%]+%/u.test(withDirectory) || /[\r\n\0]/u.test(withDirectory)) {
    throw workspaceError('WORKSPACE_EXEC_SHIM_UNSUPPORTED', 'Command shim entrypoint contains unsupported expansion syntax.', 422);
  }
  return path.win32.resolve(withDirectory);
}

function environmentValue(environment, name, fallback) {
  const match = Object.keys(environment).find((key) => key.toUpperCase() === name);
  return match ? String(environment[match]) : fallback;
}

async function terminateProcessTree(pid, child) {
  if (!Number.isInteger(pid) || pid <= 0 || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(pid, child);
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill('SIGTERM');
  }
  await waitForProcessGroupExit(pid, 400);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function terminateWindowsProcessTree(pid, child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise((resolve) => {
    killer.once('error', resolve);
    killer.once('close', resolve);
  });
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The exact child handle may already have been reaped by taskkill.
    }
  }
}

async function waitForProcessGroupExit(pid, maximumWaitMs) {
  const deadline = Date.now() + maximumWaitMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function resolveProcessEnvironment(input, sourceEnvironment) {
  const inherit = input.inheritEnv !== false;
  const value = inherit ? { ...sourceEnvironment } : {};
  const explicit = normalizeObject(input.env);
  for (const [name, raw] of Object.entries(explicit)) {
    assertEnvironmentName(name);
    value[name] = String(raw);
  }
  const referenceKeys = [];
  for (const [name, sourceNameValue] of Object.entries(normalizeObject(input.envRefs))) {
    assertEnvironmentName(name);
    const sourceName = String(sourceNameValue || '');
    assertEnvironmentName(sourceName);
    if (sourceEnvironment[sourceName] === undefined) throw workspaceError('WORKSPACE_ENV_REFERENCE_MISSING', `Environment variable ${sourceName} is not configured.`, 422);
    value[name] = String(sourceEnvironment[sourceName]);
    referenceKeys.push(name);
  }
  return { value, keys: Object.keys(explicit).sort(), referenceKeys: referenceKeys.sort() };
}

function resolveHttpHeaders(input, environment) {
  const values = {};
  const receipt = {};
  for (const [rawName, rawValue] of Object.entries(normalizeObject(input))) {
    const name = String(rawName).trim().toLowerCase();
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) throw workspaceError('WORKSPACE_HTTP_HEADER_INVALID', `Invalid HTTP header name: ${rawName}.`);
    const reference = parseEnvironmentReference(rawValue);
    if (SENSITIVE_HEADER.test(name) && !reference) {
      throw workspaceError('WORKSPACE_HTTP_SENSITIVE_HEADER_ENV_REQUIRED', `Sensitive header ${name} must use an environment reference.`, 422);
    }
    if (reference) {
      const secret = environment[reference.name];
      if (secret === undefined) throw workspaceError('WORKSPACE_ENV_REFERENCE_MISSING', `Environment variable ${reference.name} is not configured.`, 422);
      values[name] = `${reference.prefix}${String(secret)}`;
      receipt[name] = { env: reference.name, redacted: true };
    } else {
      values[name] = String(rawValue);
      receipt[name] = String(rawValue);
    }
  }
  return { values, receipt };
}

function parseEnvironmentReference(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.env === 'string') {
    assertEnvironmentName(value.env);
    return { name: value.env, prefix: String(value.prefix || '') };
  }
  if (typeof value !== 'string') return null;
  const match = /^(?:env:([A-Za-z_][A-Za-z0-9_]*)|\$\{(?:ENV:)?([A-Za-z_][A-Za-z0-9_]*)\})$/u.exec(value.trim());
  if (!match) return null;
  return { name: match[1] || match[2], prefix: '' };
}

function encodeHttpBody(body, encoding, headers) {
  if (body === undefined || body === null) return body === null && encoding === 'json' ? 'null' : undefined;
  if (encoding === 'base64') return Buffer.from(requiredString(body, 'body'), 'base64');
  if (encoding === 'json' || typeof body !== 'string') {
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    return JSON.stringify(body);
  }
  return body;
}

async function readResponseBody(body, maximum, signal) {
  if (!body) return { buffer: Buffer.alloc(0), totalBytes: 0, truncated: false };
  const chunks = [];
  let keptBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  for await (const rawChunk of body) {
    if (signal.aborted) throw signal.reason || new Error('HTTP response was aborted.');
    const chunk = Buffer.from(rawChunk);
    totalBytes += chunk.length;
    const remaining = maximum - keptBytes;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      chunks.push(kept);
      keptBytes += kept.length;
    }
    if (totalBytes > maximum) {
      truncated = true;
      await body.cancel?.().catch?.(() => {});
      break;
    }
  }
  return { buffer: Buffer.concat(chunks), totalBytes, truncated };
}

function responseHeadersReceipt(headers) {
  const receipt = {};
  for (const [name, value] of headers.entries()) receipt[name] = SENSITIVE_HEADER.test(name) ? '<redacted>' : value;
  return receipt;
}

function createBoundedCollector(maximum) {
  const chunks = [];
  let kept = 0;
  let total = 0;
  const append = (rawChunk) => {
    const chunk = Buffer.from(rawChunk);
    total += chunk.length;
    if (kept >= maximum) return;
    const value = chunk.subarray(0, maximum - kept);
    chunks.push(value);
    kept += value.length;
  };
  return {
    append,
    text: () => Buffer.concat(chunks).toString('utf8'),
    totalBytes: () => total,
    truncated: () => total > maximum,
  };
}

function decodeContent(value, encoding, maximum) {
  if (typeof value !== 'string') throw workspaceError('WORKSPACE_CONTENT_REQUIRED', 'content must be a string.');
  const content = Buffer.from(value, encoding === 'base64' ? 'base64' : 'utf8');
  if (content.length > maximum) throw workspaceError('WORKSPACE_FILE_TOO_LARGE', `Content exceeds ${maximum} bytes.`, 413);
  return content;
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(requiredString(value, 'url'));
  } catch {
    throw workspaceError('WORKSPACE_HTTP_URL_INVALID', 'url must be an absolute HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw workspaceError('WORKSPACE_HTTP_URL_INVALID', 'Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password) throw workspaceError('WORKSPACE_HTTP_URL_CREDENTIALS_DENIED', 'URL credentials are not allowed; use an environment-backed header.');
  return url;
}

function normalizeRelativePath(value, { allowRoot = true } = {}) {
  const text = value === undefined || value === null || value === '' ? '.' : String(value);
  if (text.includes('\0')) throw workspaceError('WORKSPACE_PATH_INVALID', 'Workspace path contains a null byte.');
  const portable = text.replaceAll('\\', '/');
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(text) || /^[A-Za-z]:/u.test(portable)) {
    throw workspaceError('WORKSPACE_PATH_ABSOLUTE', 'Workspace paths must be relative.');
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === '..' || normalized.startsWith('../')) throw workspaceError('WORKSPACE_PATH_ESCAPE', 'Workspace path escapes the configured root.', 403);
  if (!allowRoot && normalized === '.') throw workspaceError('WORKSPACE_FILE_PATH_REQUIRED', 'A file path below the workspace root is required.');
  return normalized;
}

function assertPathInside(root, target) {
  if (isPathInside(root, target)) return;
  throw workspaceError('WORKSPACE_PATH_ESCAPE', 'Workspace path escapes the configured root.', 403);
}

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function portablePath(value) {
  const text = String(value || '').split(path.sep).join('/');
  return text || '.';
}

function assertExpectedSha(expected, actual) {
  if (expected === undefined || expected === null || expected === '') return;
  const normalized = String(expected).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw workspaceError('WORKSPACE_SHA256_INVALID', 'expectedSha256 must contain 64 hexadecimal characters.');
  if (normalized !== actual) throw workspaceError('WORKSPACE_SHA256_MISMATCH', 'Workspace file changed since it was read.', 409);
}

function countOccurrences(value, search) {
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(search, index)) !== -1) {
    count += 1;
    index += search.length;
  }
  return count;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError() {
  return workspaceError('COPILOT_RUN_CANCELLED', 'Workspace tool execution was cancelled.', 499);
}

function workspaceError(code, message, status = 400, receipt = null) {
  return new WorkspaceToolError(code, message, status, receipt);
}

function requiredPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw workspaceError('WORKSPACE_PATH_REQUIRED', 'path is required.');
  return value;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw workspaceError('WORKSPACE_INPUT_REQUIRED', `${field} is required.`);
  return value;
}

function assertEnvironmentName(value) {
  if (!ENVIRONMENT_NAME.test(String(value || ''))) throw workspaceError('WORKSPACE_ENV_NAME_INVALID', `Invalid environment variable name: ${value}.`);
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function jsonValue(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function objectSchema(properties = {}, required = []) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

function stringSchema(description = '') {
  return { type: 'string', ...(description ? { description } : {}) };
}

function integerSchema(minimum = 0, maximum = undefined) {
  return { type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }) };
}

function booleanSchema(description = '') {
  return { type: 'boolean', ...(description ? { description } : {}) };
}

function enumSchema(values) {
  return { type: 'string', enum: values };
}

function arraySchema(items) {
  return { type: 'array', items };
}
