export type CopilotProject = {
  projectId: string
  name: string
  rootPath: string
  description?: string | null
  status?: string
  archivedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export type CopilotWorkspaceKind = 'shared' | 'worktree'

export type CopilotWorkspaceLease = {
  leaseId?: string
  runId?: string
  mode?: 'read' | 'write'
  expiresAt?: string
}

export type CopilotWorkspace = {
  workspaceId: string
  projectId: string
  name: string
  kind: CopilotWorkspaceKind
  rootPath: string
  branch?: string | null
  ref?: string | null
  status?: string
  lease?: CopilotWorkspaceLease | null
  createdAt?: string
  updatedAt?: string
}

export type CopilotWorkspaceStatus = {
  branch?: string | null
  head?: string | null
  dirty?: boolean
  ahead?: number
  behind?: number
  lease?: CopilotWorkspaceLease | null
  [key: string]: unknown
}

export type CopilotCapabilityReceipt = {
  type?: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'reconcile_required'
  runId?: string
  toolRunId?: string
  toolExecutionId?: string
  executionId?: string
  tool?: string | {
    name?: string
    source?: string
    risk?: string
  }
  result?: unknown
  error?: {
    code?: string
    message?: string
  } | string
  durable?: {
    status?: string
    createdAt?: string
    updatedAt?: string
    completedAt?: string
  }
}

export type CopilotToolExecutionEvent = {
  eventId?: string | number
  sequence?: number
  type?: string
  occurredAt?: string
  payload?: unknown
}

export type CopilotProjectWorkspaceCapabilities = {
  localRuntime?: {
    workspaceRoot?: string | null
    filesystem?: boolean
    exec?: boolean
  }
  projectWorkspaces?: {
    enabled?: boolean
    tools?: string[]
    allowedTools?: string[]
  }
}

export type CreateProjectInput = {
  name: string
  rootPath: string
  description?: string
}

export type CreateWorkspaceInput = {
  name: string
  kind: CopilotWorkspaceKind
  rootPath?: string
  ref?: string
  branch?: string
}

export type CopilotProjectWorkspaceApi = {
  getCapabilities: () => Promise<CopilotProjectWorkspaceCapabilities>
  listProjects: () => Promise<CopilotProject[]>
  createProject: (input: CreateProjectInput) => Promise<CopilotProject>
  listWorkspaces: (projectId: string) => Promise<CopilotWorkspace[]>
  getWorkspace: (projectId: string, workspaceId: string) => Promise<{
    project: CopilotProject
    workspace: CopilotWorkspace
    status?: CopilotWorkspaceStatus
  }>
  createWorkspace: (projectId: string, input: CreateWorkspaceInput) => Promise<CopilotWorkspace>
  executeTool: (
    projectId: string,
    workspaceId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{
    project: CopilotProject
    workspace: CopilotWorkspace
    receipt: CopilotCapabilityReceipt
  }>
  getToolExecution: (
    projectId: string,
    workspaceId: string,
    toolExecutionId: string,
    options?: { afterSequence?: number; limit?: number },
  ) => Promise<{
    project: CopilotProject
    workspace: CopilotWorkspace
    receipt: CopilotCapabilityReceipt
    events: CopilotToolExecutionEvent[]
  }>
  cancelToolExecution: (
    projectId: string,
    workspaceId: string,
    toolExecutionId: string,
    input?: { reason?: string },
  ) => Promise<{
    project: CopilotProject
    workspace: CopilotWorkspace
    receipt: CopilotCapabilityReceipt
  }>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

type JsonObject = Record<string, unknown>

export class CopilotProjectWorkspaceApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'CopilotProjectWorkspaceApiError'
    this.status = status
  }
}

export function createCopilotProjectWorkspaceApi(
  fetchImpl: FetchLike = globalThis.fetch,
): CopilotProjectWorkspaceApi {
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetchImpl(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const body = objectValue(payload)
      const error = objectValue(body.error)
      throw new CopilotProjectWorkspaceApiError(
        stringValue(error.message) || stringValue(body.message) || `Project workspace request failed (${response.status})`,
        response.status,
      )
    }
    return objectValue(payload)
  }

  return {
    async getCapabilities() {
      return request('/api/copilot/capabilities') as Promise<CopilotProjectWorkspaceCapabilities>
    },

    async listProjects() {
      const payload = await request('/api/copilot/projects?includeArchived=1')
      return arrayValue(payload.projects).map(projectValue).filter((project) => project.projectId)
    },

    async createProject(input) {
      const payload = await request('/api/copilot/projects', jsonInit('POST', input))
      return projectValue(payload.project)
    },

    async listWorkspaces(projectId) {
      const payload = await request(projectPath(projectId, 'workspaces'))
      return arrayValue(payload.workspaces).map(workspaceValue).filter((workspace) => workspace.workspaceId)
    },

    async getWorkspace(projectId, workspaceId) {
      const payload = await request(`${projectPath(projectId, 'workspaces', workspaceId)}?includeStatus=1`)
      return {
        project: projectValue(payload.project),
        workspace: workspaceValue(payload.workspace),
        status: Object.keys(objectValue(payload.status)).length
          ? objectValue(payload.status) as CopilotWorkspaceStatus
          : undefined,
      }
    },

    async createWorkspace(projectId, input) {
      const payload = await request(projectPath(projectId, 'workspaces'), jsonInit('POST', input))
      return workspaceValue(payload.workspace)
    },

    async executeTool(projectId, workspaceId, toolName, input) {
      const idempotencyKey = nextIdempotencyKey()
      const payload = await request(
        projectPath(projectId, 'workspaces', workspaceId, 'tools', toolName),
        {
          ...jsonInit('POST', input),
          headers: { 'Idempotency-Key': idempotencyKey },
        },
      )
      return {
        project: projectValue(payload.project),
        workspace: workspaceValue(payload.workspace),
        receipt: receiptValue(payload.receipt),
      }
    },

    async getToolExecution(projectId, workspaceId, toolExecutionId, options = {}) {
      const query = new URLSearchParams()
      if (Number.isSafeInteger(options.afterSequence) && (options.afterSequence ?? 0) >= 0) {
        query.set('afterSequence', String(options.afterSequence))
      }
      if (Number.isSafeInteger(options.limit) && (options.limit ?? 0) > 0) {
        query.set('limit', String(options.limit))
      }
      const suffix = query.size ? `?${query.toString()}` : ''
      const payload = await request(
        `${projectPath(projectId, 'workspaces', workspaceId, 'tool-executions', toolExecutionId)}${suffix}`,
      )
      return {
        project: projectValue(payload.project),
        workspace: workspaceValue(payload.workspace),
        receipt: receiptValue(payload.receipt),
        events: arrayValue(payload.events).map(toolExecutionEventValue),
      }
    },

    async cancelToolExecution(projectId, workspaceId, toolExecutionId, input = {}) {
      const payload = await request(
        projectPath(projectId, 'workspaces', workspaceId, 'tool-executions', toolExecutionId, 'cancel'),
        jsonInit('POST', input),
      )
      return {
        project: projectValue(payload.project),
        workspace: workspaceValue(payload.workspace),
        receipt: receiptValue(payload.receipt),
      }
    },
  }
}

function projectPath(projectId: string, ...parts: string[]) {
  return [
    '/api/copilot/projects',
    encodeURIComponent(projectId),
    ...parts.map((part) => encodeURIComponent(part)),
  ].join('/')
}

function jsonInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) }
}

function projectValue(value: unknown): CopilotProject {
  const project = objectValue(value)
  return {
    projectId: stringValue(project.projectId) || stringValue(project.id),
    name: stringValue(project.name),
    rootPath: stringValue(project.rootPath),
    description: nullableString(project.description),
    status: optionalString(project.status),
    archivedAt: nullableString(project.archivedAt),
    createdAt: optionalString(project.createdAt),
    updatedAt: optionalString(project.updatedAt),
  }
}

function workspaceValue(value: unknown): CopilotWorkspace {
  const workspace = objectValue(value)
  return {
    workspaceId: stringValue(workspace.workspaceId) || stringValue(workspace.id),
    projectId: stringValue(workspace.projectId),
    name: stringValue(workspace.name),
    kind: workspace.kind === 'worktree' ? 'worktree' : 'shared',
    rootPath: stringValue(workspace.rootPath),
    branch: nullableString(workspace.branch),
    ref: nullableString(workspace.ref),
    status: optionalString(workspace.status),
    lease: leaseValue(workspace.lease),
    createdAt: optionalString(workspace.createdAt),
    updatedAt: optionalString(workspace.updatedAt),
  }
}

function receiptValue(value: unknown): CopilotCapabilityReceipt {
  const receipt = objectValue(value)
  const error = receipt.error
  const tool = typeof receipt.tool === 'string'
    ? receipt.tool
    : objectValue(receipt.tool)
  return {
    type: optionalString(receipt.type),
    status: receiptStatus(receipt.status),
    runId: optionalString(receipt.runId),
    toolRunId: optionalString(receipt.toolRunId),
    toolExecutionId: optionalString(receipt.toolExecutionId),
    executionId: optionalString(receipt.executionId),
    tool,
    result: receipt.result,
    error: typeof error === 'string'
      ? error
      : Object.keys(objectValue(error)).length
        ? {
            code: optionalString(objectValue(error).code),
            message: optionalString(objectValue(error).message),
          }
        : undefined,
    durable: Object.keys(objectValue(receipt.durable)).length
      ? {
          status: optionalString(objectValue(receipt.durable).status),
          createdAt: optionalString(objectValue(receipt.durable).createdAt),
          updatedAt: optionalString(objectValue(receipt.durable).updatedAt),
          completedAt: optionalString(objectValue(receipt.durable).completedAt),
        }
      : undefined,
  }
}

function receiptStatus(value: unknown): CopilotCapabilityReceipt['status'] {
  switch (value) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'reconcile_required':
      return value
    default:
      return 'failed'
  }
}

function toolExecutionEventValue(value: unknown): CopilotToolExecutionEvent {
  const event = objectValue(value)
  const eventId = event.eventId
  return {
    eventId: typeof eventId === 'number' || typeof eventId === 'string' ? eventId : undefined,
    sequence: typeof event.sequence === 'number' ? event.sequence : undefined,
    type: optionalString(event.type),
    occurredAt: optionalString(event.occurredAt),
    payload: event.payload,
  }
}

function nextIdempotencyKey() {
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 16)}`
  return `workspace-tool:${randomId}`
}

function leaseValue(value: unknown): CopilotWorkspaceLease | null {
  const lease = objectValue(value)
  if (!Object.keys(lease).length) return null
  return {
    leaseId: optionalString(lease.leaseId),
    runId: optionalString(lease.runId),
    mode: lease.mode === 'write' ? 'write' : lease.mode === 'read' ? 'read' : undefined,
    expiresAt: optionalString(lease.expiresAt),
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}
