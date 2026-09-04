import {
  AlertCircle,
  CheckCircle2,
  CircleStop,
  FileText,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Plus,
  RefreshCw,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  createCopilotProjectWorkspaceApi,
  type CopilotCapabilityReceipt,
  type CopilotProject,
  type CopilotProjectWorkspaceApi,
  type CopilotProjectWorkspaceCapabilities,
  type CopilotToolExecutionEvent,
  type CopilotWorkspace,
  type CopilotWorkspaceKind,
  type CopilotWorkspaceStatus,
} from './copilot/project-workspace-api'
import type { DataCopilotWorkspaceBinding } from './DataCopilotContext'

type WorkspaceToolName = 'workspace.read' | 'workspace.write' | 'workspace.patch' | 'exec.run'
type GitToolName = 'git.branch' | 'git.branch.create' | 'git.branch.switch'

type GitBranch = {
  name: string
  current: boolean
  revision: string
  upstream: string | null
}

type ProjectDraft = {
  name: string
  rootPath: string
  description: string
}

type WorkspaceDraft = {
  name: string
  kind: CopilotWorkspaceKind
  rootPath: string
  ref: string
  branch: string
}

const EMPTY_PROJECT_DRAFT: ProjectDraft = { name: '', rootPath: '', description: '' }
const EMPTY_WORKSPACE_DRAFT: WorkspaceDraft = {
  name: '',
  kind: 'shared',
  rootPath: '',
  ref: '',
  branch: '',
}

const TOOL_OPTIONS: { name: WorkspaceToolName; label: string; category: 'file' | 'command' }[] = [
  { name: 'workspace.read', label: '读取', category: 'file' },
  { name: 'workspace.write', label: '写入', category: 'file' },
  { name: 'workspace.patch', label: '补丁', category: 'file' },
  { name: 'exec.run', label: '命令', category: 'command' },
]

export type CopilotProjectWorkspacePanelProps = {
  open: boolean
  onClose: () => void
  api?: CopilotProjectWorkspaceApi
  selection?: DataCopilotWorkspaceBinding | null
  onSelectionChange?: (selection: DataCopilotWorkspaceBinding | null) => void
}

export function CopilotProjectWorkspacePanel({
  open,
  onClose,
  api: suppliedApi,
  selection,
  onSelectionChange,
}: CopilotProjectWorkspacePanelProps) {
  const api = useMemo(() => suppliedApi ?? createCopilotProjectWorkspaceApi(), [suppliedApi])
  const [capabilities, setCapabilities] = useState<CopilotProjectWorkspaceCapabilities | null>(null)
  const [projects, setProjects] = useState<CopilotProject[]>([])
  const [workspaces, setWorkspaces] = useState<CopilotWorkspace[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(selection?.projectId ?? null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(selection?.workspaceId ?? null)
  const [workspaceStatus, setWorkspaceStatus] = useState<CopilotWorkspaceStatus | null>(null)
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>(EMPTY_PROJECT_DRAFT)
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDraft>(EMPTY_WORKSPACE_DRAFT)
  const [toolName, setToolName] = useState<WorkspaceToolName>('workspace.read')
  const [filePath, setFilePath] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [patch, setPatch] = useState('')
  const [command, setCommand] = useState('')
  const [argumentsText, setArgumentsText] = useState('')
  const [commandCwd, setCommandCwd] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('30000')
  const [gitBranches, setGitBranches] = useState<GitBranch[]>([])
  const [gitCurrentBranch, setGitCurrentBranch] = useState<string | null>(null)
  const [gitBranchDraft, setGitBranchDraft] = useState('')
  const [selectedGitBranch, setSelectedGitBranch] = useState('')
  const [receipt, setReceipt] = useState<CopilotCapabilityReceipt | null>(null)
  const [receiptEvents, setReceiptEvents] = useState<CopilotToolExecutionEvent[]>([])
  const [receiptRefreshing, setReceiptRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const workspaceLoadRevision = useRef(0)
  const receiptLoadRevision = useRef(0)
  const receiptExecutionIdRef = useRef<string | null>(null)
  const selectionRef = useRef<DataCopilotWorkspaceBinding | null>(selection ?? null)

  useEffect(() => {
    selectionRef.current = selection ?? null
  }, [selection])

  const selectedProject = useMemo(
    () => projects.find((project) => project.projectId === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.workspaceId === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  )
  const grantedTools = useMemo(
    () => TOOL_OPTIONS.filter((tool) => isToolGranted(capabilities, tool.name)),
    [capabilities],
  )
  const currentToolGranted = grantedTools.some((tool) => tool.name === toolName)
  const canReadGitBranches = isGitToolGranted(capabilities, 'git.branch')
  const canCreateGitBranch = isGitToolGranted(capabilities, 'git.branch.create')
  const canSwitchGitBranch = isGitToolGranted(capabilities, 'git.branch.switch')
  // The initial project and capability request determines the form's scope.
  // Keep the draft inert until that request completes so an opening transition
  // cannot race a controlled field update with the first selection projection.
  const projectDraftLoading = busy === 'load-projects'

  const loadProjects = useCallback(async () => {
    setBusy((current) => current ?? 'load-projects')
    try {
      const [nextProjects, nextCapabilities] = await Promise.all([
        api.listProjects(),
        api.getCapabilities(),
      ])
      const requestedSelection = selectionRef.current
      setProjects(nextProjects)
      setCapabilities(nextCapabilities)
      setSelectedProjectId((current) => {
        if (current && nextProjects.some((project) => project.projectId === current)) return current
        if (requestedSelection?.projectId && nextProjects.some((project) => project.projectId === requestedSelection.projectId)) {
          return requestedSelection.projectId
        }
        return nextProjects[0]?.projectId ?? null
      })
      setError(null)
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === 'load-projects' ? null : current)
    }
  }, [api])

  const loadWorkspaces = useCallback(async (projectId: string) => {
    const revision = ++workspaceLoadRevision.current
    setBusy((current) => current ?? 'load-workspaces')
    try {
      const nextWorkspaces = await api.listWorkspaces(projectId)
      if (revision !== workspaceLoadRevision.current) return
      const requestedSelection = selectionRef.current
      setWorkspaces(nextWorkspaces)
      setSelectedWorkspaceId((current) => {
        if (current && nextWorkspaces.some((workspace) => workspace.workspaceId === current)) return current
        if (
          projectId === requestedSelection?.projectId &&
          requestedSelection.workspaceId &&
          nextWorkspaces.some((workspace) => workspace.workspaceId === requestedSelection.workspaceId)
        ) {
          return requestedSelection.workspaceId
        }
        return nextWorkspaces[0]?.workspaceId ?? null
      })
      setWorkspaceStatus(null)
      setError(null)
    } catch (value) {
      if (revision !== workspaceLoadRevision.current) return
      setWorkspaces([])
      setSelectedWorkspaceId(null)
      setWorkspaceStatus(null)
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === 'load-workspaces' ? null : current)
    }
  }, [api])

  const refreshWorkspace = useCallback(async (projectId: string, workspaceId: string) => {
    setBusy((current) => current ?? 'refresh-workspace')
    try {
      const detail = await api.getWorkspace(projectId, workspaceId)
      setWorkspaces((current) => current.map((workspace) => (
        workspace.workspaceId === detail.workspace.workspaceId ? detail.workspace : workspace
      )))
      setWorkspaceStatus(detail.status ?? null)
      setError(null)
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === 'refresh-workspace' ? null : current)
    }
  }, [api])

  const refreshReceipt = useCallback(async () => {
    if (!selectedProject || !selectedWorkspace || !receipt?.toolExecutionId) return
    const toolExecutionId = receipt.toolExecutionId
    if (toolExecutionId !== receiptExecutionIdRef.current) return
    const revision = ++receiptLoadRevision.current
    setReceiptRefreshing(true)
    try {
      const response = await api.getToolExecution(
        selectedProject.projectId,
        selectedWorkspace.workspaceId,
        toolExecutionId,
      )
      if (revision !== receiptLoadRevision.current || toolExecutionId !== receiptExecutionIdRef.current) return
      receiptExecutionIdRef.current = response.receipt.toolExecutionId ?? toolExecutionId
      setReceipt((current) => (
        toolExecutionId === receiptExecutionIdRef.current ? response.receipt : current
      ))
      setReceiptEvents((current) => mergeToolExecutionEvents(current, response.events))
      setError(receiptNeedsAttention(response.receipt) ? receiptError(response.receipt) : null)
      if (!isPendingReceipt(response.receipt)) {
        await refreshWorkspace(selectedProject.projectId, selectedWorkspace.workspaceId)
      }
    } catch (value) {
      setError(toError(value).message)
    } finally {
      if (revision === receiptLoadRevision.current) setReceiptRefreshing(false)
    }
  }, [api, receipt?.toolExecutionId, refreshWorkspace, selectedProject, selectedWorkspace])

  const cancelReceipt = useCallback(async () => {
    if (!selectedProject || !selectedWorkspace || !receipt?.toolExecutionId || !isPendingReceipt(receipt)) return
    setBusy((current) => current ?? 'cancel-receipt')
    try {
      const response = await api.cancelToolExecution(
        selectedProject.projectId,
        selectedWorkspace.workspaceId,
        receipt.toolExecutionId,
        { reason: 'user_cancelled' },
      )
      receiptExecutionIdRef.current = response.receipt.toolExecutionId ?? receipt.toolExecutionId
      setReceipt(response.receipt)
      setError(receiptNeedsAttention(response.receipt) ? receiptError(response.receipt) : null)
      void refreshReceipt()
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === 'cancel-receipt' ? null : current)
    }
  }, [api, receipt, refreshReceipt, selectedProject, selectedWorkspace])

  const applyGitReceipt = useCallback((nextReceipt: CopilotCapabilityReceipt | null) => {
    if (nextReceipt?.status !== 'completed') return
    const result = objectValue(nextReceipt.result)
    const type = stringValue(result.type)
    if (!type.startsWith('git.branch')) return

    if (type === 'git.branch.receipt') {
      const branches = gitBranchesValue(result.branches)
      const current = stringValue(result.current) || branches.find((branch) => branch.current)?.name || ''
      setGitBranches(branches)
      setGitCurrentBranch(current || null)
      setSelectedGitBranch(current || branches[0]?.name || '')
      return
    }

    const branch = gitBranchValue(result.branch)
    const current = stringValue(result.current) || branch?.name || stringValue(result.name)
    if (!current) return
    setGitCurrentBranch(current)
    setSelectedGitBranch(current)
    setGitBranches((branches) => {
      const next = branch && !branches.some((item) => item.name === branch.name)
        ? [...branches, branch]
        : branches
      return next.map((item) => ({ ...item, current: item.name === current }))
    })
  }, [])

  useEffect(() => {
    applyGitReceipt(receipt)
  }, [applyGitReceipt, receipt])

  useEffect(() => {
    setGitBranches([])
    setGitCurrentBranch(null)
    setGitBranchDraft('')
    setSelectedGitBranch('')
  }, [selectedProjectId, selectedWorkspaceId])

  useEffect(() => {
    if (!open) return
    void loadProjects()
  }, [loadProjects, open])

  useEffect(() => {
    if (!open || !selection?.projectId) return
    setSelectedProjectId((current) => current ?? selection.projectId)
  }, [open, selection?.projectId])

  useEffect(() => {
    if (!open || !selection?.workspaceId || selection.projectId !== selectedProjectId) return
    setSelectedWorkspaceId((current) => current ?? selection.workspaceId)
  }, [open, selectedProjectId, selection?.projectId, selection?.workspaceId])

  useEffect(() => {
    if (!open || !selectedProjectId) {
      workspaceLoadRevision.current += 1
      setWorkspaces([])
      setSelectedWorkspaceId(null)
      return
    }
    void loadWorkspaces(selectedProjectId)
  }, [loadWorkspaces, open, selectedProjectId])

  useEffect(() => {
    if (!open || !selectedProjectId || !selectedWorkspaceId) return
    void refreshWorkspace(selectedProjectId, selectedWorkspaceId)
  }, [open, refreshWorkspace, selectedProjectId, selectedWorkspaceId])

  useEffect(() => {
    if (!open || !receipt?.toolExecutionId || !isPendingReceipt(receipt)) return
    void refreshReceipt()
  }, [open, receipt?.status, receipt?.toolExecutionId, refreshReceipt])

  useEffect(() => {
    if (!open || !isPendingReceipt(receipt)) return
    const timer = window.setTimeout(() => void refreshReceipt(), 1_000)
    return () => window.clearTimeout(timer)
  }, [open, receipt?.status, receipt?.toolExecutionId, refreshReceipt])

  useEffect(() => {
    if (!open || !onSelectionChange) return
    const next = selectedProject && selectedWorkspace && selectedWorkspace.projectId === selectedProject.projectId
      ? {
          projectId: selectedProject.projectId,
          workspaceId: selectedWorkspace.workspaceId,
          ...(selectedWorkspace.kind === 'worktree'
            ? { worktreeId: selectedWorkspace.workspaceId }
            : {}),
        }
      : null
    onSelectionChange(next)
  }, [onSelectionChange, open, selectedProject, selectedWorkspace])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose, open])

  const createProject = async (event: FormEvent) => {
    event.preventDefault()
    const name = projectDraft.name.trim()
    const rootPath = projectDraft.rootPath.trim()
    if (!name || !rootPath) {
      setError('请填写项目名称和根目录。')
      return
    }
    setBusy('create-project')
    try {
      const project = await api.createProject({
        name,
        rootPath,
        description: projectDraft.description.trim() || undefined,
      })
      setProjects((current) => [project, ...current.filter((item) => item.projectId !== project.projectId)])
      setSelectedProjectId(project.projectId)
      setProjectDraft(EMPTY_PROJECT_DRAFT)
      setError(null)
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === 'create-project' ? null : current)
    }
  }

  const createWorkspace = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedProject) return
    const name = workspaceDraft.name.trim()
    if (!name) {
      setError('请填写工作区名称。')
      return
    }
    workspaceLoadRevision.current += 1
    setBusy('create-workspace')
    try {
      const workspace = await api.createWorkspace(selectedProject.projectId, {
        name,
        kind: workspaceDraft.kind,
        rootPath: workspaceDraft.kind === 'shared' ? workspaceDraft.rootPath.trim() || undefined : undefined,
        ref: workspaceDraft.kind === 'worktree' ? workspaceDraft.ref.trim() || undefined : undefined,
        branch: workspaceDraft.kind === 'worktree' ? workspaceDraft.branch.trim() || undefined : undefined,
      })
      setWorkspaces((current) => [workspace, ...current.filter((item) => item.workspaceId !== workspace.workspaceId)])
      setSelectedWorkspaceId(workspace.workspaceId)
      setWorkspaceDraft(EMPTY_WORKSPACE_DRAFT)
      setError(null)
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === 'create-workspace' ? null : current)
    }
  }

  const executeTool = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedProject || !selectedWorkspace || !currentToolGranted) return
    let input: Record<string, unknown>
    try {
      input = toolInput(toolName, {
        path: filePath,
        content: fileContent,
        patch,
        command,
        argumentsText,
        cwd: commandCwd,
        timeoutMs,
      })
    } catch (value) {
      setError(toError(value).message)
      return
    }
    setBusy('execute-tool')
    receiptLoadRevision.current += 1
    receiptExecutionIdRef.current = null
    setReceipt(null)
    setReceiptEvents([])
    try {
      const response = await api.executeTool(
        selectedProject.projectId,
        selectedWorkspace.workspaceId,
        toolName,
        input,
      )
      receiptExecutionIdRef.current = response.receipt.toolExecutionId ?? null
      setReceipt(response.receipt)
      setWorkspaces((current) => current.map((workspace) => (
        workspace.workspaceId === response.workspace.workspaceId
          ? {
              ...workspace,
              ...response.workspace,
              projectId: response.workspace.projectId || workspace.projectId,
              rootPath: response.workspace.rootPath || workspace.rootPath,
            }
          : workspace
      )))
      setError(receiptNeedsAttention(response.receipt) ? receiptError(response.receipt) : null)
      await refreshWorkspace(selectedProject.projectId, selectedWorkspace.workspaceId)
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === 'execute-tool' ? null : current)
    }
  }

  const executeGitTool = async (name: GitToolName, input: Record<string, unknown>) => {
    if (!selectedProject || !selectedWorkspace || !isGitToolGranted(capabilities, name)) return
    setBusy(name)
    receiptLoadRevision.current += 1
    receiptExecutionIdRef.current = null
    setReceipt(null)
    setReceiptEvents([])
    try {
      const response = await api.executeTool(
        selectedProject.projectId,
        selectedWorkspace.workspaceId,
        name,
        input,
      )
      receiptExecutionIdRef.current = response.receipt.toolExecutionId ?? null
      setReceipt(response.receipt)
      applyGitReceipt(response.receipt)
      setWorkspaces((current) => current.map((workspace) => (
        workspace.workspaceId === response.workspace.workspaceId
          ? {
              ...workspace,
              ...response.workspace,
              projectId: response.workspace.projectId || workspace.projectId,
              rootPath: response.workspace.rootPath || workspace.rootPath,
            }
          : workspace
      )))
      setError(receiptNeedsAttention(response.receipt) ? receiptError(response.receipt) : null)
      await refreshWorkspace(selectedProject.projectId, selectedWorkspace.workspaceId)
    } catch (value) {
      setError(toError(value).message)
    } finally {
      setBusy((current) => current === name ? null : current)
    }
  }

  const createGitBranch = () => {
    const name = gitBranchDraft.trim()
    if (!name) {
      setError('请填写 Git 分支名称。')
      return
    }
    void executeGitTool('git.branch.create', { name, checkout: true })
  }

  if (!open) return null

  const running = Boolean(busy)
  return (
    <div
      className="copilot-project-workspace-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !running) onClose()
      }}
    >
      <style>{projectWorkspaceStyles}</style>
      <section
        className="copilot-project-workspace-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copilot-project-workspace-title"
      >
        <header className="copilot-project-workspace-header">
          <div className="copilot-project-workspace-heading">
            <span><FolderOpen size={17} aria-hidden="true" /></span>
            <div>
              <strong id="copilot-project-workspace-title">项目与工作区</strong>
              <small>{selectedWorkspace ? workspaceMeta(selectedWorkspace, workspaceStatus) : '选择项目工作区'}</small>
            </div>
          </div>
          <div className="copilot-project-workspace-actions">
            <button type="button" onClick={() => void loadProjects()} disabled={running} title="刷新项目" aria-label="刷新项目">
              {busy === 'load-projects' ? <LoaderCircle className="copilot-project-workspace-spin" size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            </button>
            <button type="button" onClick={onClose} disabled={running} title="关闭" aria-label="关闭项目与工作区"><X size={17} aria-hidden="true" /></button>
          </div>
        </header>

        {error ? <div className="copilot-project-workspace-error" role="alert"><AlertCircle size={15} aria-hidden="true" />{error}</div> : null}

        <div className="copilot-project-workspace-grid">
          <aside className="copilot-project-workspace-projects" aria-label="项目列表">
            <div className="copilot-project-workspace-section-heading">
              <strong>项目</strong>
              <span>{projects.length}</span>
            </div>
            <div className="copilot-project-workspace-list">
              {projects.map((project) => (
                <button
                  type="button"
                  key={project.projectId}
                  aria-pressed={project.projectId === selectedProjectId}
                  onClick={() => {
                    setSelectedProjectId(project.projectId)
                    setSelectedWorkspaceId(null)
                    setWorkspaces([])
                  }}
                >
                  <FolderOpen size={15} aria-hidden="true" />
                  <span><strong>{project.name || project.projectId}</strong><small title={project.rootPath}>{project.rootPath || '未设置根目录'}</small></span>
                </button>
              ))}
              {!projects.length && busy !== 'load-projects' ? <div className="copilot-project-workspace-empty">暂无项目</div> : null}
            </div>
            <form className="copilot-project-workspace-create" onSubmit={(event) => void createProject(event)}>
              <label><span>项目名称</span><input aria-label="项目名称" value={projectDraft.name} onChange={(event) => setProjectDraft((current) => ({ ...current, name: event.target.value }))} disabled={running || projectDraftLoading} /></label>
              <label><span>根目录</span><input aria-label="项目根目录" className="mono" value={projectDraft.rootPath} onChange={(event) => setProjectDraft((current) => ({ ...current, rootPath: event.target.value }))} placeholder="C:\\workspace\\project" spellCheck={false} disabled={running || projectDraftLoading} /></label>
              <label><span>备注</span><input aria-label="项目备注" value={projectDraft.description} onChange={(event) => setProjectDraft((current) => ({ ...current, description: event.target.value }))} disabled={running || projectDraftLoading} /></label>
              <button type="submit" disabled={running || projectDraftLoading}><Plus size={14} aria-hidden="true" />新建项目</button>
            </form>
          </aside>

          <section className="copilot-project-workspace-workspaces" aria-label="工作区">
            <div className="copilot-project-workspace-section-heading">
              <strong>工作区</strong>
              {selectedProject ? <button type="button" onClick={() => void loadWorkspaces(selectedProject.projectId)} disabled={running} title="刷新工作区" aria-label="刷新工作区"><RefreshCw size={14} aria-hidden="true" /></button> : null}
            </div>
            <div className="copilot-project-workspace-workspace-list">
              {workspaces.map((workspace) => (
                <button
                  type="button"
                  key={workspace.workspaceId}
                  aria-pressed={workspace.workspaceId === selectedWorkspaceId}
                  onClick={() => setSelectedWorkspaceId(workspace.workspaceId)}
                >
                  {workspace.kind === 'worktree' ? <GitBranch size={15} aria-hidden="true" /> : <FolderOpen size={15} aria-hidden="true" />}
                  <span><strong>{workspace.name || workspace.workspaceId}</strong><small>{workspace.kind}{workspace.branch ? ` · ${workspace.branch}` : ''}</small></span>
                  <em data-status={workspace.status || (workspaceStatus?.dirty ? 'dirty' : 'ready')}>{workspace.status || (workspaceStatus?.dirty ? 'dirty' : 'ready')}</em>
                </button>
              ))}
              {selectedProject && !workspaces.length && busy !== 'load-workspaces' ? <div className="copilot-project-workspace-empty">暂无工作区</div> : null}
              {!selectedProject ? <div className="copilot-project-workspace-empty">选择项目后管理工作区</div> : null}
            </div>

            <form className="copilot-project-workspace-create" onSubmit={(event) => void createWorkspace(event)}>
              <div className="copilot-project-workspace-create-title"><strong>新建工作区</strong></div>
              <label><span>名称</span><input aria-label="工作区名称" value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft((current) => ({ ...current, name: event.target.value }))} disabled={running || !selectedProject} /></label>
              <fieldset>
                <legend>类型</legend>
                <div className="copilot-project-workspace-segments">
                  {(['shared', 'worktree'] as const).map((kind) => (
                    <button key={kind} type="button" aria-pressed={workspaceDraft.kind === kind} onClick={() => setWorkspaceDraft((current) => ({ ...current, kind }))} disabled={running || !selectedProject}>{kind === 'shared' ? '共享' : 'Worktree'}</button>
                  ))}
                </div>
              </fieldset>
              {workspaceDraft.kind === 'shared' ? (
                <label><span>根目录</span><input aria-label="工作区根目录" className="mono" value={workspaceDraft.rootPath} onChange={(event) => setWorkspaceDraft((current) => ({ ...current, rootPath: event.target.value }))} placeholder={selectedProject?.rootPath || '项目根目录'} spellCheck={false} disabled={running || !selectedProject} /></label>
              ) : (
                <div className="copilot-project-workspace-worktree-fields">
                  <label><span>Ref</span><input aria-label="Worktree Ref" className="mono" value={workspaceDraft.ref} onChange={(event) => setWorkspaceDraft((current) => ({ ...current, ref: event.target.value }))} placeholder="HEAD" spellCheck={false} disabled={running || !selectedProject} /></label>
                  <label><span>Branch</span><input aria-label="Worktree Branch" className="mono" value={workspaceDraft.branch} onChange={(event) => setWorkspaceDraft((current) => ({ ...current, branch: event.target.value }))} placeholder="agent/task" spellCheck={false} disabled={running || !selectedProject} /></label>
                </div>
              )}
              <button type="submit" disabled={running || !selectedProject}><Plus size={14} aria-hidden="true" />创建工作区</button>
            </form>
          </section>
        </div>

        <section className="copilot-project-workspace-runner" aria-label="本地工作区工具">
          <div className="copilot-project-workspace-runner-heading">
            <span><Terminal size={16} aria-hidden="true" /></span>
            <div><strong>工作区工具</strong><small>{selectedWorkspace?.rootPath || '选择工作区以执行操作'}</small></div>
            {selectedProject && selectedWorkspace ? <button type="button" onClick={() => void refreshWorkspace(selectedProject.projectId, selectedWorkspace.workspaceId)} disabled={running} title="刷新工作区状态" aria-label="刷新工作区状态"><RefreshCw size={14} aria-hidden="true" /></button> : null}
          </div>
          <form onSubmit={(event) => void executeTool(event)}>
            <div className="copilot-project-workspace-tool-tabs" role="tablist" aria-label="工作区工具类型">
              {TOOL_OPTIONS.map((tool) => (
                <button
                  key={tool.name}
                  type="button"
                  role="tab"
                  aria-selected={toolName === tool.name}
                  disabled={!isToolGranted(capabilities, tool.name) || running}
                  onClick={() => setToolName(tool.name)}
                  title={isToolGranted(capabilities, tool.name) ? tool.name : '本机 Runtime 未授予此工具'}
                >
                  {tool.category === 'command' ? <Terminal size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}{tool.label}
                </button>
              ))}
            </div>
            {!currentToolGranted ? <div className="copilot-project-workspace-denied">本机 Runtime 未授予当前工具。</div> : null}
            {toolName === 'exec.run' ? (
              <div className="copilot-project-workspace-command-fields">
                <label><span>Command</span><input aria-label="工作区命令" className="mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="node" spellCheck={false} disabled={running || !selectedWorkspace || !currentToolGranted} /></label>
                <label><span>Args</span><textarea aria-label="工作区命令参数" className="mono" value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} placeholder={'--version\n--trace-warnings'} spellCheck={false} disabled={running || !selectedWorkspace || !currentToolGranted} /></label>
                <label><span>Cwd</span><input aria-label="工作目录" className="mono" value={commandCwd} onChange={(event) => setCommandCwd(event.target.value)} placeholder="." spellCheck={false} disabled={running || !selectedWorkspace || !currentToolGranted} /></label>
                <label><span>Timeout ms</span><input aria-label="命令超时毫秒" className="mono" inputMode="numeric" value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} disabled={running || !selectedWorkspace || !currentToolGranted} /></label>
              </div>
            ) : (
              <div className="copilot-project-workspace-file-fields">
                <label><span>路径</span><input aria-label="工作区文件路径" className="mono" value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="src/example.ts" spellCheck={false} disabled={running || !selectedWorkspace || !currentToolGranted} /></label>
                {toolName === 'workspace.write' ? <label className="wide"><span>内容</span><textarea aria-label="写入内容" className="mono" value={fileContent} onChange={(event) => setFileContent(event.target.value)} spellCheck={false} disabled={running || !selectedWorkspace || !currentToolGranted} /></label> : null}
                {toolName === 'workspace.patch' ? <label className="wide"><span>统一 Diff</span><textarea aria-label="统一 Diff" className="mono" value={patch} onChange={(event) => setPatch(event.target.value)} placeholder={'@@ -1 +1 @@\n-before\n+after'} spellCheck={false} disabled={running || !selectedWorkspace || !currentToolGranted} /></label> : null}
              </div>
            )}
            <button className="copilot-project-workspace-run" type="submit" disabled={running || !selectedProject || !selectedWorkspace || !currentToolGranted}>
              {busy === 'execute-tool' ? <LoaderCircle className="copilot-project-workspace-spin" size={15} aria-hidden="true" /> : <Terminal size={15} aria-hidden="true" />}
              {toolName === 'exec.run' ? '运行命令' : '执行文件操作'}
            </button>
          </form>
          <section className="copilot-project-workspace-git" aria-label="Git 分支">
            <div className="copilot-project-workspace-git-heading">
              <span><GitBranch size={16} aria-hidden="true" /></span>
              <div>
                <strong>Git 分支</strong>
                <small>{gitCurrentBranch ? `当前分支 ${gitCurrentBranch}` : selectedWorkspace ? '读取分支以创建隔离变更' : '选择工作区以管理分支'}</small>
              </div>
              <button
                type="button"
                onClick={() => void executeGitTool('git.branch', {})}
                disabled={running || !selectedWorkspace || !canReadGitBranches}
                title="刷新 Git 分支"
                aria-label="刷新 Git 分支"
              >
                {busy === 'git.branch' ? <LoaderCircle className="copilot-project-workspace-spin" size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
              </button>
            </div>
            <div className="copilot-project-workspace-git-controls">
              <label>
                <span>新建分支</span>
                <input
                  aria-label="新建 Git 分支"
                  className="mono"
                  value={gitBranchDraft}
                  onChange={(event) => setGitBranchDraft(event.target.value)}
                  placeholder="codex/task-name"
                  spellCheck={false}
                  disabled={running || !selectedWorkspace || !canCreateGitBranch}
                />
              </label>
              <button
                type="button"
                className="copilot-project-workspace-git-action"
                onClick={createGitBranch}
                disabled={running || !selectedWorkspace || !canCreateGitBranch}
              >
                {busy === 'git.branch.create' ? <LoaderCircle className="copilot-project-workspace-spin" size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
                创建并切换分支
              </button>
              <label>
                <span>已有分支</span>
                <select
                  aria-label="切换 Git 分支"
                  value={selectedGitBranch}
                  onChange={(event) => setSelectedGitBranch(event.target.value)}
                  disabled={running || !selectedWorkspace || !canSwitchGitBranch || !gitBranches.length}
                >
                  {!gitBranches.length ? <option value="">先刷新 Git 分支</option> : null}
                  {gitBranches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}{branch.current ? ' (current)' : ''}</option>)}
                </select>
              </label>
              <button
                type="button"
                className="copilot-project-workspace-git-secondary"
                onClick={() => void executeGitTool('git.branch.switch', { name: selectedGitBranch })}
                disabled={running || !selectedWorkspace || !canSwitchGitBranch || !selectedGitBranch || selectedGitBranch === gitCurrentBranch}
              >
                {busy === 'git.branch.switch' ? <LoaderCircle className="copilot-project-workspace-spin" size={14} aria-hidden="true" /> : <GitBranch size={14} aria-hidden="true" />}
                切换分支
              </button>
            </div>
          </section>
          <ReceiptView
            receipt={receipt}
            events={receiptEvents}
            onRefresh={() => void refreshReceipt()}
            refreshing={receiptRefreshing}
            onCancel={() => void cancelReceipt()}
            cancelling={busy === 'cancel-receipt'}
          />
        </section>
      </section>
    </div>
  )
}

function ReceiptView({
  receipt,
  events,
  onRefresh,
  refreshing,
  onCancel,
  cancelling,
}: {
  receipt: CopilotCapabilityReceipt | null
  events: CopilotToolExecutionEvent[]
  onRefresh: () => void
  refreshing: boolean
  onCancel: () => void
  cancelling: boolean
}) {
  if (!receipt) return null
  const result = objectValue(receipt.result)
  const stdout = stringValue(result.stdout)
  const stderr = stringValue(result.stderr)
  const content = stringValue(result.content)
  const pending = isPendingReceipt(receipt)
  const failed = receiptNeedsAttention(receipt)
  return (
    <div className="copilot-project-workspace-receipt" data-status={receipt.status}>
      <div>
        <span>{pending ? <LoaderCircle className="copilot-project-workspace-spin" size={15} aria-hidden="true" /> : receipt.status === 'completed' ? <CheckCircle2 size={15} aria-hidden="true" /> : <AlertCircle size={15} aria-hidden="true" />}</span>
        <strong>{typeof receipt.tool === 'string' ? receipt.tool : receipt.tool?.name || 'workspace tool'}</strong>
        {pending && receipt.toolExecutionId ? <button type="button" onClick={onCancel} disabled={cancelling} title="Cancel execution" aria-label="Cancel execution">{cancelling ? <LoaderCircle className="copilot-project-workspace-spin" size={13} aria-hidden="true" /> : <CircleStop size={13} aria-hidden="true" />}</button> : null}
        {receipt.toolExecutionId ? <button type="button" onClick={onRefresh} disabled={refreshing} title="Refresh execution receipt" aria-label="Refresh execution receipt">{refreshing ? <LoaderCircle className="copilot-project-workspace-spin" size={13} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}</button> : null}
        <small>{receipt.toolExecutionId || receipt.toolRunId || receipt.runId || ''}</small>
      </div>
      {stdout ? <pre aria-label="命令标准输出">{stdout}</pre> : null}
      {stderr ? <pre className="stderr" aria-label="命令标准错误">{stderr}</pre> : null}
      {!stdout && !stderr && content ? <pre aria-label="文件内容">{content}</pre> : null}
      {!stdout && !stderr && !content ? <pre aria-label="工具回执">{prettyJson(receipt.result ?? receipt.error ?? {})}</pre> : null}
      {events.length ? (
        <ol className="copilot-project-workspace-execution-events" aria-label="执行轨迹">
          {events.slice(-8).map((event, index) => (
            <li key={toolExecutionEventKey(event, index)} data-event={event.type || 'event'}>
              <span>{toolExecutionEventLabel(event.type)}</span>
              <time dateTime={event.occurredAt}>{formatToolExecutionTime(event.occurredAt)}</time>
            </li>
          ))}
        </ol>
      ) : null}
      {failed ? <p>{receiptError(receipt)}</p> : null}
    </div>
  )
}

function mergeToolExecutionEvents(
  current: CopilotToolExecutionEvent[],
  incoming: CopilotToolExecutionEvent[],
) {
  if (!incoming.length) return current
  const merged = new Map<string, CopilotToolExecutionEvent>()
  for (const [index, event] of current.entries()) {
    merged.set(toolExecutionEventKey(event, index), event)
  }
  for (const [index, event] of incoming.entries()) {
    merged.set(toolExecutionEventKey(event, index), event)
  }
  return [...merged.values()]
    .sort((left, right) => (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER))
    .slice(-64)
}

function toolExecutionEventKey(event: CopilotToolExecutionEvent, index: number) {
  if (event.eventId !== undefined && event.eventId !== null) return `event:${String(event.eventId)}`
  if (Number.isSafeInteger(event.sequence)) return `sequence:${event.sequence}`
  return `fallback:${event.type || 'event'}:${event.occurredAt || ''}:${index}`
}

function toolExecutionEventLabel(type: string | undefined) {
  switch (type) {
    case 'tool.execution.queued': return '已排队'
    case 'tool.execution.claimed': return '已领取'
    case 'tool.execution.started': return '开始执行'
    case 'tool.execution.progress': return '执行中'
    case 'tool.execution.completed': return '已完成'
    case 'tool.execution.failed': return '执行失败'
    case 'tool.execution.cancel_requested': return '正在取消'
    case 'tool.execution.cancelled': return '已取消'
    case 'tool.execution.reconcile_required': return '等待核对'
    case 'tool.execution.reconciled': return '已核对'
    default: return type?.replace(/^tool\.execution\./, '') || '执行事件'
  }
}

function formatToolExecutionTime(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function isToolGranted(capabilities: CopilotProjectWorkspaceCapabilities | null, toolName: WorkspaceToolName) {
  if (!capabilities || capabilities.projectWorkspaces?.enabled === false) return false
  const explicit = capabilities.projectWorkspaces?.allowedTools ?? capabilities.projectWorkspaces?.tools
  if (Array.isArray(explicit)) return explicit.includes(toolName)
  return toolName === 'exec.run'
    ? capabilities.localRuntime?.exec === true
    : capabilities.localRuntime?.filesystem === true
}

function isGitToolGranted(capabilities: CopilotProjectWorkspaceCapabilities | null, toolName: GitToolName) {
  if (!capabilities || capabilities.projectWorkspaces?.enabled === false) return false
  const explicit = capabilities.projectWorkspaces?.allowedTools ?? capabilities.projectWorkspaces?.tools
  if (Array.isArray(explicit)) return explicit.includes(toolName)
  return capabilities.localRuntime?.filesystem === true
}

function toolInput(
  toolName: WorkspaceToolName,
  values: {
    path: string
    content: string
    patch: string
    command: string
    argumentsText: string
    cwd: string
    timeoutMs: string
  },
): Record<string, unknown> {
  if (toolName === 'exec.run') {
    const command = values.command.trim()
    if (!command) throw new Error('请填写要执行的 Command。')
    const parsedTimeout = Number.parseInt(values.timeoutMs, 10)
    const input: Record<string, unknown> = {
      command,
      args: lines(values.argumentsText),
    }
    if (values.cwd.trim()) input.cwd = values.cwd.trim()
    if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) input.timeoutMs = parsedTimeout
    return input
  }
  const path = values.path.trim()
  if (!path) throw new Error('请填写工作区相对文件路径。')
  if (toolName === 'workspace.read') return { path }
  if (toolName === 'workspace.write') return { path, content: values.content }
  const patch = values.patch.trim()
  if (!patch) throw new Error('请填写统一 Diff。')
  return { path, patch }
}

function workspaceMeta(workspace: CopilotWorkspace, status: CopilotWorkspaceStatus | null) {
  const branch = status?.branch || workspace.branch
  const dirty = status?.dirty ? ' · 已修改' : ''
  return `${workspace.kind}${branch ? ` · ${branch}` : ''}${dirty}`
}

function receiptError(receipt: CopilotCapabilityReceipt) {
  if (typeof receipt.error === 'string') return receipt.error
  return receipt.error?.message || receipt.error?.code || '工具执行失败。'
}

function isPendingReceipt(receipt: CopilotCapabilityReceipt | null) {
  return receipt?.status === 'queued' || receipt?.status === 'running'
}

function receiptNeedsAttention(receipt: CopilotCapabilityReceipt) {
  return receipt.status === 'failed' || receipt.status === 'cancelled' || receipt.status === 'reconcile_required'
}

function lines(value: string) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value))
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function gitBranchValue(value: unknown): GitBranch | null {
  const branch = objectValue(value)
  const name = stringValue(branch.name)
  if (!name) return null
  return {
    name,
    current: branch.current === true,
    revision: stringValue(branch.revision),
    upstream: stringValue(branch.upstream) || null,
  }
}

function gitBranchesValue(value: unknown): GitBranch[] {
  if (!Array.isArray(value)) return []
  return value.map(gitBranchValue).filter((branch): branch is GitBranch => branch !== null)
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const projectWorkspaceStyles = `
  .copilot-project-workspace-backdrop{position:fixed;z-index:84;inset:0;display:grid;place-items:center;padding:24px;background:rgba(24,24,28,.44)}
  .copilot-project-workspace-panel{width:min(1120px,calc(100vw - 32px));height:min(820px,calc(100vh - 32px));display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;overflow:hidden;border:1px solid #d8d8de;border-radius:8px;background:#fff;color:#28282f;box-shadow:0 24px 70px rgba(21,21,25,.22);font:12px Inter,"Segoe UI",system-ui,sans-serif}
  .copilot-project-workspace-header{display:flex;min-height:56px;align-items:center;justify-content:space-between;gap:14px;padding:0 14px;border-bottom:1px solid #e5e5e9;background:#fff}.copilot-project-workspace-heading,.copilot-project-workspace-heading>span,.copilot-project-workspace-heading>div,.copilot-project-workspace-actions{display:flex;align-items:center}.copilot-project-workspace-heading{min-width:0;gap:9px}.copilot-project-workspace-heading>span{display:grid;width:30px;height:30px;place-items:center;border:1px solid #d7d7de;border-radius:6px;background:#f5f5f7;color:#3d3d47}.copilot-project-workspace-heading>div{min-width:0;align-items:flex-start;flex-direction:column;gap:2px}.copilot-project-workspace-heading strong{font-size:13px}.copilot-project-workspace-heading small{overflow:hidden;max-width:620px;color:#74747e;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.copilot-project-workspace-actions{gap:5px}.copilot-project-workspace-actions button,.copilot-project-workspace-section-heading>button,.copilot-project-workspace-runner-heading>button{display:grid;width:30px;height:30px;place-items:center;padding:0;border:1px solid #e0e0e5;border-radius:5px;background:#fff;color:#5e5e68;cursor:pointer}.copilot-project-workspace-actions button:hover:not(:disabled),.copilot-project-workspace-section-heading>button:hover:not(:disabled),.copilot-project-workspace-runner-heading>button:hover:not(:disabled){border-color:#c9cad1;background:#f6f6f8;color:#202026}.copilot-project-workspace-actions button:disabled,.copilot-project-workspace-section-heading>button:disabled,.copilot-project-workspace-runner-heading>button:disabled{opacity:.5;cursor:not-allowed}
  .copilot-project-workspace-error{display:flex;align-items:center;gap:7px;padding:8px 14px;border-bottom:1px solid #f0caca;background:#fff4f4;color:#a43535}.copilot-project-workspace-grid{display:grid;min-height:0;grid-template-columns:minmax(260px,.78fr) minmax(400px,1.22fr);overflow:hidden}.copilot-project-workspace-projects,.copilot-project-workspace-workspaces{display:grid;min-height:0;grid-template-rows:auto minmax(0,1fr) auto;background:#fbfbfc}.copilot-project-workspace-projects{border-right:1px solid #e4e4e8}.copilot-project-workspace-section-heading{display:flex;min-height:45px;align-items:center;justify-content:space-between;gap:8px;padding:0 12px;border-bottom:1px solid #e7e7eb;background:#fff}.copilot-project-workspace-section-heading strong{font-size:12px}.copilot-project-workspace-section-heading>span{min-width:19px;padding:2px 6px;border-radius:8px;background:#eeeeF1;color:#676772;font-size:10px;text-align:center}.copilot-project-workspace-list,.copilot-project-workspace-workspace-list{min-height:0;overflow:auto;padding:6px}.copilot-project-workspace-list>button,.copilot-project-workspace-workspace-list>button{display:grid;width:100%;min-width:0;grid-template-columns:18px minmax(0,1fr) auto;gap:7px;align-items:center;margin:1px 0;padding:8px;border:1px solid transparent;border-radius:5px;background:transparent;color:#3b3b45;text-align:left;cursor:pointer}.copilot-project-workspace-list>button{grid-template-columns:18px minmax(0,1fr)}.copilot-project-workspace-list>button:hover,.copilot-project-workspace-workspace-list>button:hover{background:#f0f0f3}.copilot-project-workspace-list>button[aria-pressed=true],.copilot-project-workspace-workspace-list>button[aria-pressed=true]{background:#eaf1ff;color:#1f4fa8;box-shadow:inset 2px 0 #2563eb}.copilot-project-workspace-list span,.copilot-project-workspace-workspace-list span{display:flex;min-width:0;flex-direction:column;gap:2px}.copilot-project-workspace-list strong,.copilot-project-workspace-workspace-list strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.copilot-project-workspace-list small,.copilot-project-workspace-workspace-list small{overflow:hidden;color:#7a7a85;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.copilot-project-workspace-workspace-list em{padding:2px 5px;border-radius:4px;background:#ececf0;color:#686873;font-size:9px;font-style:normal}.copilot-project-workspace-workspace-list em[data-status=dirty],.copilot-project-workspace-workspace-list em[data-status=failed]{background:#fff0cf;color:#945d00}.copilot-project-workspace-workspace-list em[data-status=ready],.copilot-project-workspace-workspace-list em[data-status=active]{background:#e5f5ec;color:#146b46}.copilot-project-workspace-empty{display:grid;min-height:92px;place-items:center;padding:12px;color:#85858f;font-size:11px;text-align:center}
  .copilot-project-workspace-create{display:grid;gap:7px;padding:10px 12px 12px;border-top:1px solid #e4e4e8;background:#fff}.copilot-project-workspace-create-title{display:flex;align-items:center;justify-content:space-between;color:#454550;font-size:11px}.copilot-project-workspace-create label,.copilot-project-workspace-create fieldset,.copilot-project-workspace-file-fields label,.copilot-project-workspace-command-fields label{display:flex;min-width:0;flex-direction:column;gap:4px;margin:0;padding:0;border:0}.copilot-project-workspace-create label>span,.copilot-project-workspace-create legend,.copilot-project-workspace-file-fields label>span,.copilot-project-workspace-command-fields label>span{color:#70707a;font-size:10px}.copilot-project-workspace-create input,.copilot-project-workspace-file-fields input,.copilot-project-workspace-file-fields textarea,.copilot-project-workspace-command-fields input,.copilot-project-workspace-command-fields textarea{width:100%;min-width:0;box-sizing:border-box;border:1px solid #dedee4;border-radius:5px;background:#fff;color:#292930;font:inherit;outline:0}.copilot-project-workspace-create input,.copilot-project-workspace-file-fields input,.copilot-project-workspace-command-fields input{height:31px;padding:0 8px}.copilot-project-workspace-create textarea,.copilot-project-workspace-file-fields textarea,.copilot-project-workspace-command-fields textarea{min-height:56px;padding:7px 8px;resize:vertical}.copilot-project-workspace-create input:focus,.copilot-project-workspace-file-fields input:focus,.copilot-project-workspace-file-fields textarea:focus,.copilot-project-workspace-command-fields input:focus,.copilot-project-workspace-command-fields textarea:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.12)}.copilot-project-workspace-create button[type=submit],.copilot-project-workspace-run{display:inline-flex;height:32px;align-items:center;justify-content:center;gap:6px;padding:0 10px;border:1px solid #202124;border-radius:5px;background:#202124;color:#fff;font:inherit;font-size:11px;font-weight:700;cursor:pointer}.copilot-project-workspace-create button[type=submit]:disabled,.copilot-project-workspace-run:disabled{opacity:.45;cursor:not-allowed}.copilot-project-workspace-segments{display:grid;grid-template-columns:1fr 1fr;overflow:hidden;border:1px solid #dedee4;border-radius:5px}.copilot-project-workspace-segments button{height:30px;border:0;border-left:1px solid #dedee4;background:#fff;color:#666671;font:inherit;font-size:10px;cursor:pointer}.copilot-project-workspace-segments button:first-child{border-left:0}.copilot-project-workspace-segments button[aria-pressed=true]{background:#edf3ff;color:#1f4fa8;font-weight:700}.copilot-project-workspace-worktree-fields{display:grid;grid-template-columns:1fr 1fr;gap:7px}.mono{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace!important}
  .copilot-project-workspace-runner{display:grid;grid-template-columns:190px minmax(0,1fr);gap:12px;padding:11px 14px 13px;border-top:1px solid #e2e2e7;background:#f8f8f9}.copilot-project-workspace-runner-heading{display:flex;min-width:0;align-items:flex-start;gap:7px}.copilot-project-workspace-runner-heading>span{display:grid;width:27px;height:27px;flex:0 0 auto;place-items:center;border:1px solid #dddde2;border-radius:5px;background:#fff;color:#52525d}.copilot-project-workspace-runner-heading>div{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}.copilot-project-workspace-runner-heading strong{font-size:11px}.copilot-project-workspace-runner-heading small{overflow:hidden;color:#777781;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.copilot-project-workspace-runner-heading>button{width:27px;height:27px;flex:0 0 auto}.copilot-project-workspace-runner form{display:grid;min-width:0;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:end}.copilot-project-workspace-tool-tabs{display:flex;height:31px;align-items:stretch;overflow:hidden;border:1px solid #dadade;border-radius:5px;background:#fff}.copilot-project-workspace-tool-tabs button{display:inline-flex;min-width:0;align-items:center;gap:4px;padding:0 7px;border:0;border-left:1px solid #e5e5e8;background:#fff;color:#666671;font:inherit;font-size:10px;cursor:pointer}.copilot-project-workspace-tool-tabs button:first-child{border-left:0}.copilot-project-workspace-tool-tabs button[aria-selected=true]{background:#edf3ff;color:#1f4fa8;font-weight:700}.copilot-project-workspace-tool-tabs button:disabled{opacity:.45;cursor:not-allowed}.copilot-project-workspace-file-fields,.copilot-project-workspace-command-fields{display:grid;min-width:0;grid-template-columns:minmax(150px,1fr) minmax(200px,1.45fr);gap:7px}.copilot-project-workspace-command-fields{grid-template-columns:minmax(130px,.7fr) minmax(170px,1.1fr) minmax(100px,.55fr) 82px}.copilot-project-workspace-file-fields .wide{grid-column:1/-1}.copilot-project-workspace-denied{display:flex;align-items:center;min-height:31px;color:#9a6700;font-size:10px}.copilot-project-workspace-git{grid-column:1/-1;display:grid;grid-template-columns:190px minmax(0,1fr);gap:12px;padding-top:10px;border-top:1px solid #e4e4e8}.copilot-project-workspace-git-heading{display:flex;min-width:0;align-items:flex-start;gap:7px}.copilot-project-workspace-git-heading>span{display:grid;width:27px;height:27px;flex:0 0 auto;place-items:center;border:1px solid #dddde2;border-radius:5px;background:#fff;color:#52525d}.copilot-project-workspace-git-heading>div{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}.copilot-project-workspace-git-heading strong{font-size:11px}.copilot-project-workspace-git-heading small{overflow:hidden;color:#777781;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.copilot-project-workspace-git-heading>button{display:grid;width:27px;height:27px;flex:0 0 auto;place-items:center;padding:0;border:1px solid #e0e0e5;border-radius:5px;background:#fff;color:#5e5e68;cursor:pointer}.copilot-project-workspace-git-heading>button:hover:not(:disabled){border-color:#c9cad1;background:#f6f6f8;color:#202026}.copilot-project-workspace-git-heading>button:disabled{opacity:.5;cursor:not-allowed}.copilot-project-workspace-git-controls{display:grid;grid-template-columns:minmax(145px,1fr) auto minmax(145px,1fr) auto;gap:7px;align-items:end}.copilot-project-workspace-git-controls label{display:flex;min-width:0;flex-direction:column;gap:4px}.copilot-project-workspace-git-controls label>span{color:#70707a;font-size:10px}.copilot-project-workspace-git-controls input,.copilot-project-workspace-git-controls select{width:100%;min-width:0;height:31px;box-sizing:border-box;padding:0 8px;border:1px solid #dedee4;border-radius:5px;background:#fff;color:#292930;font:inherit;outline:0}.copilot-project-workspace-git-controls input:focus,.copilot-project-workspace-git-controls select:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.12)}.copilot-project-workspace-git-action,.copilot-project-workspace-git-secondary{display:inline-flex;height:31px;align-items:center;justify-content:center;gap:5px;padding:0 9px;border:1px solid #202124;border-radius:5px;background:#202124;color:#fff;font:inherit;font-size:10px;font-weight:700;white-space:nowrap;cursor:pointer}.copilot-project-workspace-git-secondary{border-color:#d7d7dd;background:#fff;color:#3f3f48}.copilot-project-workspace-git-action:disabled,.copilot-project-workspace-git-secondary:disabled{opacity:.45;cursor:not-allowed}.copilot-project-workspace-receipt{grid-column:2;max-height:144px;overflow:auto;margin-top:7px;border:1px solid #dedee4;border-radius:5px;background:#fff}.copilot-project-workspace-receipt>div{display:flex;align-items:center;gap:6px;min-height:28px;padding:0 8px;border-bottom:1px solid #ededf0;color:#575761}.copilot-project-workspace-receipt[data-status=completed]>div>span{color:#17734d}.copilot-project-workspace-receipt[data-status=failed]>div>span{color:#b43f3f}.copilot-project-workspace-receipt small{overflow:hidden;margin-left:auto;color:#84848e;font-family:"SFMono-Regular",Consolas,monospace;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.copilot-project-workspace-receipt pre{margin:0;padding:8px;overflow:auto;background:#191a1f;color:#e8e8ec;font:10px/1.45 "SFMono-Regular",Consolas,monospace;white-space:pre-wrap}.copilot-project-workspace-receipt pre.stderr{border-top:1px solid #3a2022;color:#ffb4b4}.copilot-project-workspace-receipt p{margin:0;padding:7px 8px;color:#a43535;font-size:10px}.copilot-project-workspace-spin{animation:copilot-project-workspace-spin 1s linear infinite}@keyframes copilot-project-workspace-spin{to{transform:rotate(360deg)}}
  .copilot-project-workspace-receipt[data-status=queued]>div>span,.copilot-project-workspace-receipt[data-status=running]>div>span{color:#1f5fbf}.copilot-project-workspace-receipt[data-status=cancelled]>div>span,.copilot-project-workspace-receipt[data-status=reconcile_required]>div>span{color:#9a6700}.copilot-project-workspace-receipt>div>button{display:grid;width:24px;height:24px;place-items:center;margin-left:4px;padding:0;border:0;border-radius:4px;background:transparent;color:#62626d;cursor:pointer}.copilot-project-workspace-receipt>div>button:hover:not(:disabled){background:#f0f0f3;color:#202026}.copilot-project-workspace-receipt>div>button:disabled{opacity:.55;cursor:not-allowed}
  .copilot-project-workspace-execution-events{display:grid;gap:0;margin:0;padding:0;list-style:none;border-top:1px solid #ededf0}.copilot-project-workspace-execution-events li{display:flex;align-items:center;gap:7px;min-height:24px;padding:0 8px;color:#666671;font-size:10px}.copilot-project-workspace-execution-events li::before{width:5px;height:5px;flex:0 0 auto;border-radius:50%;background:#9a9aa4;content:""}.copilot-project-workspace-execution-events li[data-event="tool.execution.started"]::before,.copilot-project-workspace-execution-events li[data-event="tool.execution.progress"]::before{background:#2563eb}.copilot-project-workspace-execution-events li[data-event="tool.execution.completed"]::before,.copilot-project-workspace-execution-events li[data-event="tool.execution.reconciled"]::before{background:#16865a}.copilot-project-workspace-execution-events li[data-event="tool.execution.failed"]::before{background:#c23f3f}.copilot-project-workspace-execution-events li[data-event="tool.execution.cancel_requested"]::before,.copilot-project-workspace-execution-events li[data-event="tool.execution.cancelled"]::before,.copilot-project-workspace-execution-events li[data-event="tool.execution.reconcile_required"]::before{background:#b57800}.copilot-project-workspace-execution-events time{margin-left:auto;color:#8a8a94;font-family:"SFMono-Regular",Consolas,monospace;font-size:9px}
  @media(max-width:900px){.copilot-project-workspace-backdrop{padding:0}.copilot-project-workspace-panel{width:100vw;height:100vh;border:0;border-radius:0}.copilot-project-workspace-grid{grid-template-columns:minmax(220px,.7fr) minmax(0,1.3fr)}.copilot-project-workspace-runner,.copilot-project-workspace-git{grid-template-columns:1fr}.copilot-project-workspace-receipt{grid-column:1}.copilot-project-workspace-runner form{grid-template-columns:minmax(0,1fr) auto}.copilot-project-workspace-tool-tabs{grid-column:1/-1}.copilot-project-workspace-command-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.copilot-project-workspace-git-controls{grid-template-columns:minmax(0,1fr) auto}}
  @media(max-width:600px){.copilot-project-workspace-grid{grid-template-columns:minmax(0,1fr);overflow:auto}.copilot-project-workspace-projects{border-right:0;border-bottom:1px solid #e4e4e8}.copilot-project-workspace-list,.copilot-project-workspace-workspace-list{max-height:170px}.copilot-project-workspace-panel{display:flex;overflow:auto;flex-direction:column}.copilot-project-workspace-grid{flex:1;min-height:auto}.copilot-project-workspace-runner{flex:0 0 auto}.copilot-project-workspace-command-fields,.copilot-project-workspace-file-fields,.copilot-project-workspace-git-controls{grid-template-columns:1fr}.copilot-project-workspace-runner form{grid-template-columns:1fr}.copilot-project-workspace-run,.copilot-project-workspace-git-action,.copilot-project-workspace-git-secondary{width:100%}.copilot-project-workspace-heading small{max-width:210px}}
`
