import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_PENDING_FRAMES = 1_000;

/**
 * Handles only /api/copilot routes. It returns false for unrelated paths so it
 * can be mounted near the top of the existing application request handler.
 */
export async function handleDataCopilotRequest({
  req,
  res,
  url = new URL(req.url || '/', 'http://localhost'),
  service,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  securityContext = {},
} = {}) {
  if (!url.pathname.startsWith('/api/copilot')) return false;
  if (!service) {
    writeError(res, serviceError('COPILOT_SERVICE_UNAVAILABLE', 'Data Copilot is unavailable.', 503));
    return true;
  }

  try {
    const parts = decodePath(url.pathname);
    const method = String(req.method || 'GET').toUpperCase();
    if (parts[0] !== 'api' || parts[1] !== 'copilot') return false;

    if (parts.length === 3 && parts[2] === 'capabilities' && method === 'GET') {
      writeJson(res, 200, service.getCapabilities());
      return true;
    }

    if (parts.length === 3 && parts[2] === 'tools' && method === 'GET') {
      writeJson(res, 200, service.listTools({
        query: url.searchParams.get('query'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 4 && parts[2] === 'v1' && parts[3] === 'executions' && method === 'GET') {
      writeJson(res, 200, service.listExecutions({
        taskId: url.searchParams.get('taskId'),
        runId: url.searchParams.get('runId'),
        status: url.searchParams.get('status'),
        limit: url.searchParams.get('limit'),
      }, securityContext));
      return true;
    }

    if (parts.length === 5 && parts[2] === 'v1' && parts[3] === 'executions' && method === 'GET') {
      writeJson(res, 200, service.getExecution(parts[4], securityContext));
      return true;
    }

    if (parts.length === 6 && parts[2] === 'v1' && parts[3] === 'executions' && method === 'GET') {
      const executionId = parts[4];
      if (parts[5] === 'steps') {
        writeJson(res, 200, service.listExecutionSteps(executionId, {
          status: url.searchParams.get('status'),
          limit: url.searchParams.get('limit'),
        }, securityContext));
      } else if (parts[5] === 'artifacts') {
        writeJson(res, 200, service.listExecutionArtifacts(executionId, {
          stepId: url.searchParams.get('stepId'),
          kind: url.searchParams.get('kind'),
          limit: url.searchParams.get('limit'),
        }, securityContext));
      } else if (parts[5] === 'events') {
        writeJson(res, 200, service.listExecutionEvents(executionId, {
          scope: url.searchParams.get('scope'),
          afterSequence: url.searchParams.get('afterSequence'),
          limit: url.searchParams.get('limit'),
        }, securityContext));
      } else {
        writeJson(res, 404, { error: { code: 'COPILOT_ROUTE_NOT_FOUND', message: 'Execution resource was not found.' } });
      }
      return true;
    }

    if (
      parts.length === 6
      && parts[2] === 'v1'
      && parts[3] === 'executions'
      && parts[5] === 'cancel'
      && method === 'POST'
    ) {
      requireJsonContentType(req);
      const result = await service.cancelExecution(
        parts[4],
        await readJsonBody(req, maxBodyBytes),
        securityContext,
      );
      writeJson(res, isPendingExecution(result?.execution) ? 202 : 200, result);
      return true;
    }

    if (parts.length === 3 && parts[2] === 'projects') {
      if (method === 'GET') {
        writeJson(res, 200, service.listProjects({
          includeArchived: parseBoolean(url.searchParams.get('includeArchived')),
        }, securityContext));
        return true;
      }
      if (method === 'POST') {
        requireJsonContentType(req);
        writeJson(res, 201, await service.createProject(await readJsonBody(req, maxBodyBytes), securityContext));
        return true;
      }
    }

    if (parts.length === 4 && parts[2] === 'projects') {
      if (method === 'GET') {
        writeJson(res, 200, service.getProject(parts[3], securityContext));
        return true;
      }
      if (method === 'PATCH') {
        requireJsonContentType(req);
        writeJson(res, 200, await service.updateProject(parts[3], await readJsonBody(req, maxBodyBytes), securityContext));
        return true;
      }
    }

    if (parts.length === 5 && parts[2] === 'projects' && parts[4] === 'workspaces') {
      if (method === 'GET') {
        writeJson(res, 200, service.listProjectWorkspaces(parts[3], {
          includeArchived: parseBoolean(url.searchParams.get('includeArchived')),
        }, securityContext));
        return true;
      }
      if (method === 'POST') {
        requireJsonContentType(req);
        writeJson(res, 201, await service.createProjectWorkspace(parts[3], await readJsonBody(req, maxBodyBytes), securityContext));
        return true;
      }
    }

    if (parts.length === 6 && parts[2] === 'projects' && parts[4] === 'workspaces') {
      if (method === 'GET') {
        writeJson(res, 200, await service.getProjectWorkspace(parts[3], parts[5], {
          includeStatus: parseBoolean(url.searchParams.get('includeStatus')),
        }, securityContext));
        return true;
      }
      if (method === 'DELETE') {
        writeJson(res, 200, await service.archiveProjectWorkspace(parts[3], parts[5], {
          removeWorktree: parseBoolean(url.searchParams.get('removeWorktree')),
          force: parseBoolean(url.searchParams.get('force')),
        }, securityContext));
        return true;
      }
    }

    if (parts.length === 8 && parts[2] === 'projects' && parts[4] === 'workspaces' && parts[6] === 'lease' && method === 'POST') {
      requireJsonContentType(req);
      const body = await readJsonBody(req, maxBodyBytes);
      if (parts[7] === 'acquire') writeJson(res, 200, await service.acquireProjectWorkspaceLease(parts[3], parts[5], body, securityContext));
      else if (parts[7] === 'release') writeJson(res, 200, await service.releaseProjectWorkspaceLease(parts[3], parts[5], body, securityContext));
      else writeJson(res, 404, { error: { code: 'COPILOT_ROUTE_NOT_FOUND', message: 'Project workspace lease action was not found.' } });
      return true;
    }

    if (parts.length === 8 && parts[2] === 'projects' && parts[4] === 'workspaces' && parts[6] === 'tools' && method === 'POST') {
      requireJsonContentType(req);
      const result = await service.executeProjectWorkspaceTool(
        parts[3],
        parts[5],
        parts[7],
        await readJsonBody(req, maxBodyBytes),
        securityContext,
        {
          idempotencyKey: header(req, 'idempotency-key') || undefined,
          awaitCompletion: false,
        },
      );
      writeJson(res, isPendingToolReceipt(result?.receipt) ? 202 : 200, result);
      return true;
    }

    if (parts.length === 8 && parts[2] === 'projects' && parts[4] === 'workspaces' && parts[6] === 'tool-executions' && method === 'GET') {
      writeJson(res, 200, service.getProjectWorkspaceToolExecution(
        parts[3],
        parts[5],
        parts[7],
        {
          afterSequence: url.searchParams.get('afterSequence'),
          limit: url.searchParams.get('limit'),
        },
        securityContext,
      ));
      return true;
    }

    if (parts.length === 9 && parts[2] === 'projects' && parts[4] === 'workspaces' && parts[6] === 'tool-executions' && parts[8] === 'cancel' && method === 'POST') {
      requireJsonContentType(req);
      const result = await service.cancelProjectWorkspaceToolExecution(
        parts[3],
        parts[5],
        parts[7],
        await readJsonBody(req, maxBodyBytes),
        securityContext,
      );
      writeJson(res, isPendingToolReceipt(result?.receipt) ? 202 : 200, result);
      return true;
    }

    if (parts.length === 7 && parts[2] === 'projects' && parts[4] === 'workspaces' && parts[6] === 'terminals') {
      if (method === 'GET') {
        writeJson(res, 200, service.listProjectWorkspaceTerminals(parts[3], parts[5], {
          includeCompleted: !parseBoolean(url.searchParams.get('activeOnly')),
        }, securityContext));
        return true;
      }
      if (method === 'POST') {
        requireJsonContentType(req);
        writeJson(res, 201, await service.startProjectWorkspaceTerminal(
          parts[3],
          parts[5],
          await readJsonBody(req, maxBodyBytes),
          securityContext,
        ));
        return true;
      }
    }

    if (parts.length === 8 && parts[2] === 'projects' && parts[4] === 'workspaces' && parts[6] === 'terminals' && method === 'GET') {
      writeJson(res, 200, service.getProjectWorkspaceTerminal(parts[3], parts[5], parts[7], {
        afterSequence: url.searchParams.get('afterSequence'),
        limit: url.searchParams.get('limit'),
      }, securityContext));
      return true;
    }

    if (parts.length === 9 && parts[2] === 'projects' && parts[4] === 'workspaces' && parts[6] === 'terminals' && method === 'POST') {
      requireJsonContentType(req);
      const body = await readJsonBody(req, maxBodyBytes);
      if (parts[8] === 'input') {
        writeJson(res, 200, service.writeProjectWorkspaceTerminal(parts[3], parts[5], parts[7], body, securityContext));
      } else if (parts[8] === 'cancel') {
        writeJson(res, 202, await service.cancelProjectWorkspaceTerminal(parts[3], parts[5], parts[7], body, securityContext));
      } else {
        writeJson(res, 404, { error: { code: 'COPILOT_ROUTE_NOT_FOUND', message: 'Project workspace terminal action was not found.' } });
      }
      return true;
    }

    if (parts.length === 4 && parts[2] === 'mcp' && parts[3] === 'servers') {
      if (method === 'GET') {
        writeJson(res, 200, service.listMcpServers());
        return true;
      }
      if (method === 'POST') {
        requireJsonContentType(req);
        writeJson(res, 201, await service.upsertMcpServer(await readJsonBody(req, maxBodyBytes)));
        return true;
      }
    }

    if (parts.length === 4 && parts[2] === 'mcp' && parts[3] === 'refresh' && method === 'POST') {
      requireJsonContentType(req);
      writeJson(res, 200, await service.refreshMcpServers());
      return true;
    }

    if (parts.length === 5 && parts[2] === 'mcp' && parts[3] === 'servers') {
      if (method === 'PUT') {
        requireJsonContentType(req);
        const body = await readJsonBody(req, maxBodyBytes);
        writeJson(res, 200, await service.upsertMcpServer({ ...body, id: parts[4] }));
        return true;
      }
      if (method === 'DELETE') {
        writeJson(res, 200, await service.removeMcpServer(parts[4]));
        return true;
      }
    }

    if (parts.length === 6 && parts[2] === 'mcp' && parts[3] === 'servers' && parts[5] === 'refresh' && method === 'POST') {
      requireJsonContentType(req);
      writeJson(res, 200, await service.refreshMcpServers(parts[4]));
      return true;
    }

    if (parts.length === 3 && parts[2] === 'usage' && method === 'GET') {
      writeJson(res, 200, service.getUsage({
        conversationId: url.searchParams.get('conversationId'),
        runId: url.searchParams.get('runId'),
      }));
      return true;
    }

    if (parts.length === 3 && parts[2] === 'traces' && method === 'GET') {
      writeJson(res, 200, service.listTraces({
        conversationId: url.searchParams.get('conversationId'),
        runId: url.searchParams.get('runId'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 3 && parts[2] === 'snapshots' && method === 'GET') {
      writeJson(res, 200, service.listSnapshots({
        jobId: url.searchParams.get('jobId'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 4 && parts[2] === 'snapshots' && parts[3] === 'diff' && method === 'GET') {
      writeJson(res, 200, service.diffSnapshots({
        jobId: url.searchParams.get('jobId'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
      }));
      return true;
    }

    if (parts.length === 5 && parts[2] === 'snapshots' && method === 'GET') {
      writeJson(res, 200, service.getSnapshot(parts[3], parts[4]));
      return true;
    }

    if (parts.length === 3 && parts[2] === 'evaluations' && method === 'GET') {
      writeJson(res, 200, service.listEvaluations({
        suite: url.searchParams.get('suite'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 4 && parts[2] === 'evaluations' && parts[3] === 'golden' && method === 'POST') {
      writeJson(res, 201, await service.runGoldenEvaluation());
      return true;
    }

    if (parts.length === 5 && parts[2] === 'workbench' && parts[3] === 'tools' && method === 'POST') {
      requireJsonContentType(req);
      writeJson(res, 200, await service.executeWorkbenchTool(
        parts[4],
        await readJsonBody(req, maxBodyBytes),
        securityContext,
        { idempotencyKey: header(req, 'idempotency-key') || undefined },
      ));
      return true;
    }

    if (parts.length === 4 && parts[2] === 'workbench' && parts[3] === 'runs' && method === 'POST') {
      requireJsonContentType(req);
      writeJson(res, 200, await service.executeWorkbenchGraph(await readJsonBody(req, maxBodyBytes), securityContext));
      return true;
    }

    if (parts.length === 5 && parts[2] === 'runs' && parts[3] && parts[4] === 'events' && method === 'GET') {
      writeJson(res, 200, await service.listRunEvents(parts[3], {
        afterSeq: url.searchParams.get('afterSeq'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 3 && parts[2] === 'context' && method === 'GET') {
      writeJson(res, 200, await service.listContextRecords({
        jobId: url.searchParams.get('jobId'),
        mode: url.searchParams.get('mode'),
        kind: url.searchParams.get('kind'),
        query: url.searchParams.get('query'),
        offset: url.searchParams.get('offset'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 4 && parts[2] === 'context' && parts[3] === 'jobs' && method === 'GET') {
      writeJson(res, 200, service.listContextJobs({
        query: url.searchParams.get('query'),
        offset: url.searchParams.get('offset'),
        limit: url.searchParams.get('limit'),
      }));
      return true;
    }

    if (parts.length === 3 && parts[2] === 'conversations') {
      if (method === 'GET') {
        const result = await service.listConversations({
          jobId: url.searchParams.get('jobId'),
          mode: url.searchParams.get('mode'),
          limit: url.searchParams.get('limit'),
        });
        writeJson(res, 200, result);
        return true;
      }
      if (method === 'POST') {
        const result = await service.createConversation(await readJsonBody(req, maxBodyBytes));
        writeJson(res, 201, result);
        return true;
      }
    }

    if (parts[2] === 'conversations' && parts[3]) {
      const conversationId = parts[3];
      if (parts.length === 4 && method === 'GET') {
        writeJson(res, 200, await service.getConversation(conversationId));
        return true;
      }
      if (parts.length === 4 && method === 'PATCH') {
        writeJson(res, 200, await service.updateConversation(conversationId, await readJsonBody(req, maxBodyBytes)));
        return true;
      }
      if (parts.length === 4 && method === 'DELETE') {
        writeJson(res, 200, await service.deleteConversation(conversationId));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'messages') {
        if (method === 'GET') {
          writeJson(res, 200, await service.listMessages(conversationId, {
            afterSequence: url.searchParams.get('afterSequence'),
            limit: url.searchParams.get('limit'),
          }));
          return true;
        }
        if (method === 'POST') {
          const result = await service.sendMessage(
            conversationId,
            await readJsonBody(req, maxBodyBytes),
            securityContext,
          );
          writeJson(res, 202, result);
          return true;
        }
      }
      if (parts.length === 5 && parts[4] === 'subagent-runs' && method === 'POST') {
        requireJsonContentType(req);
        writeJson(res, 200, await service.delegateSubagents(conversationId, await readJsonBody(req, maxBodyBytes)));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'runs' && method === 'GET') {
        writeJson(res, 200, await service.listRuns(conversationId, {
          afterSequence: url.searchParams.get('afterSequence'),
          limit: url.searchParams.get('limit'),
        }));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'events' && method === 'GET') {
        if (url.searchParams.get('format') === 'json' || url.searchParams.get('stream') === '0') {
          writeJson(res, 200, await service.listEvents(conversationId, {
            afterSeq: url.searchParams.get('afterSeq') || url.searchParams.get('afterEventId'),
            limit: url.searchParams.get('limit'),
          }));
        } else {
          await openEventStream(req, res, service, conversationId);
        }
        return true;
      }
      if (parts.length === 5 && parts[4] === 'context' && method === 'GET') {
        writeJson(res, 200, await service.buildWorkingSet(conversationId, {
          kind: url.searchParams.get('kind'),
          query: url.searchParams.get('query'),
          tools: url.searchParams.getAll('tool'),
          budget: url.searchParams.get('budget'),
        }));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'context-pins') {
        if (method === 'GET') {
          writeJson(res, 200, await service.listContextPins(conversationId));
          return true;
        }
        if (method === 'POST') {
          writeJson(res, 201, await service.pinContext(conversationId, await readJsonBody(req, maxBodyBytes)));
          return true;
        }
      }
      if (parts.length === 6 && parts[4] === 'context-pins' && method === 'DELETE') {
        writeJson(res, 200, await service.removeContextPin(conversationId, parts[5]));
        return true;
      }
      if (parts.length === 6 && parts[4] === 'runs' && method === 'GET') {
        writeJson(res, 200, service.getWorkbenchRun(parts[5], conversationId));
        return true;
      }
      if (parts.length === 7 && parts[4] === 'runs' && method === 'POST') {
        const runId = parts[5];
        const body = await readJsonBody(req, maxBodyBytes);
        const state = service.getWorkbenchRun(runId, conversationId);
        if (parts[6] === 'pause') writeJson(res, 202, service.pauseWorkbenchRun(state.run.runId, conversationId));
        else if (parts[6] === 'resume') writeJson(res, 200, await service.resumeWorkbenchRun(state.run.runId, conversationId, body));
        else if (parts[6] === 'cancel') writeJson(res, 202, service.cancelWorkbenchRun(state.run.runId, conversationId));
        else if (parts[6] === 'steer') writeJson(res, 200, await service.steerWorkbenchRun(state.run.runId, conversationId, body));
        else writeJson(res, 404, { error: { code: 'COPILOT_ROUTE_NOT_FOUND', message: 'Data Copilot run action was not found.' } });
        return true;
      }
      if (parts.length === 5 && parts[4] === 'verify' && method === 'POST') {
        writeJson(res, 200, service.verifyAnswer(await readJsonBody(req, maxBodyBytes)));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'mcp' && method === 'POST') {
        res.setHeader('Deprecation', 'true');
        res.setHeader('Sunset', 'Tue, 01 Dec 2026 00:00:00 GMT');
        res.setHeader('Link', '</mcp>; rel="successor-version"');
        const result = await service.handleMcpRequest(
          conversationId,
          await readJsonBody(req, maxBodyBytes),
        );
        if (result === null) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
        } else {
          writeJson(res, 200, result);
        }
        return true;
      }
      if (parts.length === 5 && parts[4] === 'cancel' && method === 'POST') {
        writeJson(res, 200, await service.cancel(conversationId, await readJsonBody(req, maxBodyBytes)));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'retry' && method === 'POST') {
        writeJson(res, 202, await service.retry(
          conversationId,
          await readJsonBody(req, maxBodyBytes),
          securityContext,
        ));
        return true;
      }
      if (parts.length === 5 && parts[4] === 'attachments' && method === 'POST') {
        const result = await service.uploadAttachment(conversationId, req, {
          idempotencyKey: header(req, 'idempotency-key') || undefined,
        });
        writeJson(res, 201, result);
        return true;
      }
      if (parts.length === 5 && parts[4] === 'artifacts' && method === 'POST') {
        writeJson(res, 201, await service.createArtifact(conversationId, await readJsonBody(req, maxBodyBytes)));
        return true;
      }
      if (parts.length === 6 && parts[4] === 'snapshot' && parts[5] === 'upgrade' && method === 'POST') {
        writeJson(res, 201, await service.upgradeConversationSnapshot(conversationId, await readJsonBody(req, maxBodyBytes)));
        return true;
      }
      if (
        parts.length === 6
        && parts[4] === 'attachments'
        && ['GET', 'HEAD'].includes(method)
      ) {
        const resolved = await service.resolveAttachment(conversationId, parts[5]);
        await sendStoredFile(req, res, resolved.attachment, resolved.absolutePath, 'attachment');
        return true;
      }
      if (
        parts.length === 6
        && ['artifact', 'artifacts'].includes(parts[4])
        && ['GET', 'HEAD'].includes(method)
      ) {
        await sendArtifact(req, res, service, conversationId, parts[5]);
        return true;
      }
      if (
        parts.length === 7
        && parts[4] === 'approvals'
        && parts[6] === 'confirm'
        && method === 'POST'
      ) {
        const result = await service.confirmApproval(
          conversationId,
          parts[5],
          await readJsonBody(req, maxBodyBytes),
          securityContext,
        );
        writeJson(res, result.run ? 202 : 200, result);
        return true;
      }
    }

    writeJson(res, 404, {
      error: { code: 'COPILOT_ROUTE_NOT_FOUND', message: 'Data Copilot endpoint was not found.' },
    });
    return true;
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return true;
    }
    writeError(res, error);
    return true;
  }
}

export async function readDataCopilotJsonBody(request, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
  return readJsonBody(request, maxBodyBytes);
}

async function openEventStream(req, res, service, conversationId) {
  const details = await service.getConversation(conversationId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  let closed = false;
  let heartbeat;
  let unsubscribe = () => {};
  let waitingForDrain = false;
  const pendingFrames = [];

  function close() {
    if (closed) return;
    closed = true;
    pendingFrames.length = 0;
    clearInterval(heartbeat);
    res.off('drain', onDrain);
    unsubscribe();
  }

  function abortSlowClient() {
    if (closed) return;
    close();
    res.destroy();
  }

  function pump() {
    if (closed || res.destroyed || res.writableEnded) {
      close();
      return;
    }
    while (pendingFrames.length > 0) {
      const frame = pendingFrames.shift();
      if (!res.write(frame)) {
        waitingForDrain = true;
        res.once('drain', onDrain);
        return;
      }
    }
  }

  function onDrain() {
    waitingForDrain = false;
    pump();
  }

  function enqueue(frame) {
    if (closed || res.destroyed || res.writableEnded) return;
    if (pendingFrames.length >= SSE_MAX_PENDING_FRAMES) {
      // The durable event log is the source of truth. Disconnecting a slow
      // consumer prevents it from building an unbounded in-process queue; the
      // browser resumes from Last-Event-ID on its next EventSource connection.
      abortSlowClient();
      return;
    }
    pendingFrames.push(frame);
    if (!waitingForDrain) pump();
  }

  const write = (event) => {
    if (closed || res.destroyed || res.writableEnded) return;
    const type = String(event.type || 'message').replace(/[^A-Za-z0-9_.-]/gu, '_');
    enqueue(`id: ${Number(event.eventId || 0)}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const requestedEventId = Number(
    header(req, 'last-event-id')
    || new URL(req.url || '/', 'http://localhost').searchParams.get('afterEventId')
    || 0,
  );
  const afterEventId = Number.isSafeInteger(requestedEventId) && requestedEventId > 0 ? requestedEventId : 0;
  req.once('aborted', close);
  res.once('close', close);
  const registered = service.subscribe(conversationId, write, { afterEventId });
  if (closed) registered();
  else unsubscribe = registered;
  enqueue(`event: ready\ndata: ${JSON.stringify({
    type: 'ready',
    conversationId,
    status: details.conversation.status,
    lastSequences: details.conversation.lastSequences,
  })}\n\n`);
  if (!closed) {
    heartbeat = setInterval(() => {
      enqueue(`: heartbeat ${Date.now()}\n\n`);
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
  }
}

async function sendArtifact(req, res, service, conversationId, artifactId) {
  const { artifact, absolutePath } = await service.resolveArtifact(conversationId, artifactId);
  await sendStoredFile(req, res, artifact, absolutePath, 'artifact');
}

async function sendStoredFile(req, res, record, absolutePath, fallbackPrefix) {
  const displayName = record.displayName || `${fallbackPrefix}.${record.extension || 'bin'}`;
  const fallback = asciiDownloadName(displayName);
  res.writeHead(200, {
    'Content-Type': record.mediaType || 'application/octet-stream',
    'Content-Length': String(record.size),
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(displayName)}`,
    'Cache-Control': 'private, no-store',
    ETag: `"sha256-${record.sha256}"`,
  });
  if (String(req.method).toUpperCase() === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(absolutePath), res);
}

async function readJsonBody(req, maxBodyBytes) {
  const maximum = boundedMaximum(maxBodyBytes);
  const declared = Number(header(req, 'content-length') || 0);
  if (Number.isFinite(declared) && declared > maximum) {
    throw serviceError('COPILOT_BODY_TOO_LARGE', 'Request body is too large.', 413);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximum) throw serviceError('COPILOT_BODY_TOO_LARGE', 'Request body is too large.', 413);
    chunks.push(buffer);
  }
  if (total === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw serviceError('COPILOT_JSON_INVALID', 'Request body must contain valid JSON.', 400, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw serviceError('COPILOT_JSON_INVALID', 'Request body must be a JSON object.');
  }
  return parsed;
}

function requireJsonContentType(req) {
  const mediaType = header(req, 'content-type').split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return;
  throw serviceError(
    'COPILOT_CONTENT_TYPE_UNSUPPORTED',
    'MCP management requests must use application/json.',
    415,
  );
}

function parseBoolean(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function writeJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function writeError(res, error) {
  const status = Number.isInteger(Number(error?.status))
    ? Math.min(599, Math.max(400, Number(error.status)))
    : 500;
  writeJson(res, status, {
    error: {
      code: String(error?.code || 'COPILOT_INTERNAL_ERROR'),
      message: status >= 500 && !error?.code
        ? 'Data Copilot request failed.'
        : String(error?.message || 'Data Copilot request failed.'),
    },
  });
}

function decodePath(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch (error) {
    throw serviceError('COPILOT_PATH_INVALID', 'Request path is invalid.', 400, error);
  }
}

function header(request, name) {
  const value = request?.headers?.[name] ?? request?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function isPendingToolReceipt(receipt) {
  const status = String(receipt?.status || '').trim().toLowerCase();
  return status === 'queued' || status === 'running';
}

function isPendingExecution(execution) {
  return ['queued', 'running', 'waiting'].includes(String(execution?.status || '').trim().toLowerCase());
}

function asciiDownloadName(value) {
  const name = String(value || 'artifact.bin')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._ -]/gu, '_')
    .replace(/["\\]/gu, '_')
    .slice(0, 160)
    .trim();
  return name || 'artifact.bin';
}

function boundedMaximum(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1024 ? number : DEFAULT_MAX_BODY_BYTES;
}

function serviceError(code, message, status, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.status = status;
  return error;
}
