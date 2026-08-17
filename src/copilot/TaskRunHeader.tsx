import {
  Brain,
  Database,
  FolderGit2,
  ListTree,
  Square,
  Terminal,
  Wrench,
  Workflow,
} from 'lucide-react'

import type {
  DataCopilotReasoningEffort,
  DataCopilotRunStatus,
  DataCopilotWorkspaceBinding,
} from '../DataCopilotContext'
import type { WorkbenchProjection } from './workbench-types'

export type TaskRunHeaderTab = 'execution' | 'changes' | 'terminal' | 'context'

export function TaskRunHeader({
  status,
  projection,
  modelLabel,
  reasoningEffort,
  sourceCount,
  workspaceBinding,
  onOpenInspector,
  onOpenWorkspace,
  onStop,
}: {
  status: DataCopilotRunStatus
  projection: WorkbenchProjection
  modelLabel?: string
  reasoningEffort?: DataCopilotReasoningEffort
  sourceCount: number
  workspaceBinding?: DataCopilotWorkspaceBinding | null
  onOpenInspector: (tab: TaskRunHeaderTab) => void
  onOpenWorkspace: () => void
  onStop?: () => void
}) {
  const active = ['planning', 'executing', 'waiting_input', 'waiting_approval', 'stopping'].includes(status)
  const workspaceLabel = workspaceBinding
    ? workspaceBinding.worktreeId
      ? `工作树 ${workspaceBinding.worktreeId}`
      : `工作区 ${workspaceBinding.workspaceId}`
    : '未绑定工作区'

  return (
    <section className="copilot-task-run-header" aria-label="任务运行概览">
      <div className="copilot-task-run-primary">
        <span className={`copilot-task-run-status is-${status}`} aria-live="polite">
          <span aria-hidden="true" />
          {statusLabel(status)}
        </span>
        <span className="copilot-task-run-progress">
          <Workflow size={13} aria-hidden="true" />
          {projection.totalNodes ? `${projection.completedNodes}/${projection.totalNodes} 步` : active ? '准备执行' : '等待任务'}
        </span>
        <span className="copilot-task-run-progress">
          <Wrench size={13} aria-hidden="true" />
          {projection.toolCount} 次操作
        </span>
        {projection.subagentRunCount ? (
          <span className="copilot-task-run-progress">{projection.subagentRunCount} 个 Agent</span>
        ) : null}
        <span className="copilot-task-run-progress is-elapsed">{formatElapsed(projection.elapsedMs)}</span>
      </div>

      <div className="copilot-task-run-environment" aria-label="运行环境">
        <span title={modelLabel || '未选择模型'}><Brain size={13} aria-hidden="true" />{modelLabel || '未选择模型'}</span>
        {reasoningEffort ? <span title={`推理强度：${reasoningLabel(reasoningEffort)}`}>推理 · {reasoningLabel(reasoningEffort)}</span> : null}
        <span title={workspaceLabel}><FolderGit2 size={13} aria-hidden="true" />{workspaceLabel}</span>
        <span title={`${sourceCount} 个已选数据源`}><Database size={13} aria-hidden="true" />{sourceCount} 个数据源</span>
      </div>

      <div className="copilot-task-run-actions" aria-label="任务视图">
        <button type="button" onClick={() => onOpenInspector('execution')} title="打开执行计划" aria-label="打开执行计划">
          <ListTree size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onOpenInspector('changes')} title="查看文件变更" aria-label="查看文件变更">
          <FolderGit2 size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onOpenInspector('terminal')} title="查看终端输出" aria-label="查看终端输出">
          <Terminal size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onOpenInspector('context')} title="查看数据上下文" aria-label="查看数据上下文">
          <Database size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={onOpenWorkspace} title="打开当前任务工作区" aria-label="打开当前任务工作区">
          <FolderGit2 size={15} aria-hidden="true" />
        </button>
        {active && onStop ? (
          <button className="is-stop" type="button" onClick={onStop} title="停止任务" aria-label="停止任务">
            <Square size={12} fill="currentColor" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </section>
  )
}

function statusLabel(status: DataCopilotRunStatus) {
  const labels: Record<DataCopilotRunStatus, string> = {
    idle: '就绪',
    planning: '规划中',
    executing: '执行中',
    waiting_input: '等待输入',
    waiting_approval: '等待确认',
    stopping: '正在停止',
    paused: '已暂停',
    completed: '已完成',
    partial: '部分完成',
    failed: '执行失败',
    cancelled: '已取消',
    resumable: '可恢复',
  }
  return labels[status]
}

function reasoningLabel(value: DataCopilotReasoningEffort) {
  const labels: Record<DataCopilotReasoningEffort, string> = {
    none: '关闭',
    low: '轻量',
    medium: '标准',
    high: '深度',
    xhigh: '极深',
    max: '最大',
  }
  return labels[value]
}

function formatElapsed(value: number) {
  if (!value) return '0s'
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))}s`
  return `${Math.floor(value / 60_000)}m ${Math.round(value % 60_000 / 1000)}s`
}
