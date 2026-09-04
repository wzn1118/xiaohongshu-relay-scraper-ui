import {
  addPendingUserMessage,
  applyCodexBrowserEvent,
  createConversationProjection,
  eventCheckpoint,
  projectionFromThreadRead,
  reconcileEventCursor,
} from './conversation-state.js';

const ACTIVE_THREAD_KEY = 'xhs.codex.activeThread.v1';
const EVENT_CURSOR_KEY = 'xhs.codex.eventCursor.v1';

const elements = {
  runtimeState: document.querySelector('#runtime-state'),
  runtimeVersion: document.querySelector('#runtime-version'),
  threadTitle: document.querySelector('#thread-title'),
  threadList: document.querySelector('#thread-list'),
  newThread: document.querySelector('#new-thread'),
  refresh: document.querySelector('#refresh'),
  messages: document.querySelector('#messages'),
  composer: document.querySelector('#composer'),
  prompt: document.querySelector('#prompt'),
  send: document.querySelector('#send'),
  sendState: document.querySelector('#send-state'),
  workflowRefresh: document.querySelector('#workflow-refresh'),
  workflowState: document.querySelector('#workflow-state'),
  workflowCount: document.querySelector('#workflow-count'),
  workflowFiles: document.querySelector('#workflow-files'),
  workflowOutput: document.querySelector('#workflow-output'),
  workflowCommandState: document.querySelector('#workflow-command-state'),
  workflowApply: document.querySelector('#workflow-apply'),
  workflowRollback: document.querySelector('#workflow-rollback'),
  workflowError: document.querySelector('#workflow-error'),
};

let runtimeStatus = null;
let threads = [];
let activeThreadId = '';
let projection = createConversationProjection();
let eventCursor = 0;
let polling = false;
let disconnected = false;
let threadReadGeneration = 0;
let threadReadPending = 0;
let workflowSnapshot = null;
const selectedFiles = new Set();

async function request(method, params = {}) {
  const response = await fetch('/api/codex-browser/request', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Codex request returned HTTP ${response.status}.`);
  return payload;
}

async function workflowRequest(action, extra = {}) {
  const response = await fetch('/api/codex-browser/workflow', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      cwd: runtimeStatus?.workspaceRoot || undefined,
      source: 'uncommitted',
      threadId: activeThreadId || undefined,
      ...extra,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Workflow request returned HTTP ${response.status}.`);
  return payload;
}

function threadLabel(thread) {
  return String(thread?.name || thread?.title || thread?.preview || thread?.id || '未命名任务');
}

function renderThreads() {
  elements.threadList.replaceChildren();
  for (const thread of threads) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = threadLabel(thread);
    button.title = button.textContent;
    button.className = thread.id === activeThreadId ? 'active' : '';
    button.addEventListener('click', () => void selectThread(thread).then(() => refreshWorkflow()));
    elements.threadList.append(button);
  }
}

function renderMessages() {
  elements.messages.replaceChildren();
  if (!projection.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = activeThreadId ? '此任务还没有消息' : '输入任务开始使用 Codex';
    elements.messages.append(empty);
  } else {
    for (const message of projection.messages) {
      const item = document.createElement('div');
      item.dataset.messageId = message.id;
      item.className = `message ${message.role === 'user' ? 'user' : message.kind === 'error' ? 'error' : message.kind === 'event' ? 'event' : 'assistant'}`;
      item.textContent = message.text;
      if (message.status === 'streaming') item.classList.add('streaming');
      elements.messages.append(item);
    }
  }
  elements.messages.scrollTop = elements.messages.scrollHeight;
  renderRunState();
}

function renderRunState() {
  const labels = {
    idle: '',
    running: '运行中',
    completed: '已完成',
    failed: '运行失败',
    interrupted: '已中断',
  };
  elements.sendState.textContent = disconnected ? '正在重连' : labels[projection.status] || '';
}

async function refreshThreadList(preferredThread = null) {
  const list = await request('thread/list', { limit: 30, useStateDbOnly: true });
  threads = Array.isArray(list?.data) ? list.data : [];
  if (preferredThread?.id && !threads.some((thread) => thread.id === preferredThread.id)) {
    threads.unshift(preferredThread);
  }
  renderThreads();
}

async function selectThread(thread, { cursor = eventCursor } = {}) {
  const threadId = String(thread?.id || '');
  if (!threadId) return;
  eventCursor = Math.max(eventCursor, Number(cursor) || 0);
  const generation = ++threadReadGeneration;
  threadReadPending = generation;
  activeThreadId = threadId;
  localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
  elements.threadTitle.textContent = threadLabel(thread);
  elements.messages.replaceChildren(loadingElement('正在读取对话历史'));
  renderThreads();
  try {
    const result = await request('thread/read', { threadId, includeTurns: true });
    if (generation !== threadReadGeneration || activeThreadId !== threadId) return false;
    projection = projectionFromThreadRead(result, { cursor: eventCursor });
    renderMessages();
    return true;
  } catch (error) {
    if (generation !== threadReadGeneration) return false;
    projection = createConversationProjection(threadId, eventCursor);
    projection.messages.push({ id: `read-error:${threadId}`, role: 'system', kind: 'error', text: error.message, status: 'complete' });
    renderMessages();
    return false;
  } finally {
    if (threadReadPending === generation) threadReadPending = 0;
  }
}

async function refresh() {
  const response = await fetch('/api/codex-browser/status', { credentials: 'include', cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ready !== true || payload.backend?.initialized !== true) {
    throw new Error(payload?.error?.message || 'Codex app-server 尚未就绪。');
  }
  runtimeStatus = payload;
  document.documentElement.dataset.codexReady = 'true';
  elements.runtimeState.textContent = '已连接';
  elements.runtimeVersion.textContent = payload.backend.appServerVersion || 'app-server';
  eventCursor = reconcileEventCursor(readStoredJson(EVENT_CURSOR_KEY), payload.backend);
  await refreshThreadList();
  const savedThreadId = localStorage.getItem(ACTIVE_THREAD_KEY) || '';
  const selected = threads.find((thread) => thread.id === (activeThreadId || savedThreadId));
  if (selected) await selectThread(selected, { cursor: eventCursor });
  await refreshWorkflow();
  persistCursor();
}

async function createThread() {
  const result = await request('thread/start', {
    cwd: runtimeStatus?.workspaceRoot || null,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  });
  const thread = result?.thread;
  if (!thread?.id) throw new Error('Codex 未返回任务 ID。');
  await refreshThreadList(thread);
  await selectThread(threads.find((candidate) => candidate.id === thread.id) || thread);
  await refreshWorkflow();
  return thread.id;
}

async function pollEvents() {
  if (polling || threadReadPending) return;
  polling = true;
  const generation = threadReadGeneration;
  try {
    const response = await fetch(`/api/codex-browser/events?after=${eventCursor}`, { credentials: 'include', cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `事件请求失败 (${response.status})`);
    if (generation !== threadReadGeneration || threadReadPending) return;
    if (payload.resetRequired) {
      eventCursor = Number(payload.throughCursor) || 0;
      if (activeThreadId) {
        const thread = threads.find((candidate) => candidate.id === activeThreadId) || { id: activeThreadId };
        await selectThread(thread, { cursor: eventCursor });
      }
      await refreshWorkflow();
    } else {
      let workflowNeedsRefresh = false;
      for (const event of Array.isArray(payload.events) ? payload.events : []) {
        const message = event?.message && typeof event.message === 'object' ? event.message : event;
        const method = String(message?.method || '');
        const eventThreadId = String(message?.params?.threadId || message?.params?.thread?.id || '');
        const belongsToThread = !activeThreadId || !eventThreadId || eventThreadId === activeThreadId;
        const text = eventText(message);
        if (belongsToThread && text) {
          const failed = /failed|error|exit code [1-9]/iu.test(`${method} ${text}`);
          appendWorkflowOutput(text);
          if (elements.workflowCommandState) elements.workflowCommandState.textContent = failed ? '失败' : '有新输出';
        }
        if (belongsToThread && (method === 'turn/completed' || method === 'turn/failed' || method === 'turn/error')) workflowNeedsRefresh = true;
        projection = applyCodexBrowserEvent(projection, event);
      }
      eventCursor = Number(payload.cursor) || eventCursor;
      if (projection.messages.length || payload.events?.length) renderMessages();
      if (workflowNeedsRefresh) {
        if (elements.workflowCommandState) elements.workflowCommandState.textContent = projection.status === 'failed' ? '失败' : '已完成';
        await refreshWorkflow();
      }
    }
    if (disconnected || projection.connection === 'reconnecting') {
      disconnected = true;
      elements.runtimeState.textContent = '重连中';
      let recovered = true;
      if (activeThreadId) {
        const thread = threads.find((candidate) => candidate.id === activeThreadId) || { id: activeThreadId };
        recovered = await selectThread(thread, { cursor: eventCursor });
      } else {
        try { await refreshThreadList(); } catch { recovered = false; }
      }
      disconnected = !recovered;
      if (recovered) {
        projection.connection = 'connected';
        elements.runtimeState.textContent = '已连接';
      }
    }
    persistCursor();
  } catch {
    disconnected = true;
    elements.runtimeState.textContent = '重连中';
    renderRunState();
  } finally {
    polling = false;
  }
}

function persistCursor() {
  if (!runtimeStatus?.backend) return;
  localStorage.setItem(EVENT_CURSOR_KEY, JSON.stringify(eventCheckpoint(eventCursor, runtimeStatus.backend)));
}

function readStoredJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function loadingElement(text) {
  const item = document.createElement('div');
  item.className = 'empty';
  item.textContent = text;
  return item;
}

function showWorkflowError(error) {
  if (!elements.workflowError) return;
  elements.workflowError.hidden = !error;
  elements.workflowError.textContent = error ? String(error.message || error) : '';
}

function selectedReviewFiles() {
  return (workflowSnapshot?.files || []).filter((file) => selectedFiles.has(file.path));
}

function appendWorkflowOutput(text, state = '有新输出') {
  if (!elements.workflowOutput || !text) return;
  const previous = elements.workflowOutput.textContent === '尚未收到命令输出。' ? '' : elements.workflowOutput.textContent.trim();
  elements.workflowOutput.textContent = previous ? `${previous}\n${text}` : String(text);
  if (elements.workflowCommandState) elements.workflowCommandState.textContent = state;
  elements.workflowOutput.scrollTop = elements.workflowOutput.scrollHeight;
}

function renderWorkflow(snapshot = null) {
  if (!elements.workflowFiles) return;
  workflowSnapshot = snapshot;
  const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
  const paths = new Set(files.map((file) => file.path));
  for (const path of selectedFiles) if (!paths.has(path)) selectedFiles.delete(path);
  if (elements.workflowCount) elements.workflowCount.textContent = String(files.length);
  if (elements.workflowState) elements.workflowState.textContent = snapshot ? `${files.length} 个文件 · 快照 #${snapshot.snapshotGeneration ?? '-'}` : '暂无工作区快照';
  elements.workflowFiles.replaceChildren();
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '暂无工作区变更';
    elements.workflowFiles.append(empty);
  }
  for (const file of files) {
    const row = document.createElement('article');
    row.className = `workflow-file ${selectedFiles.has(file.path) ? 'selected' : ''}`;
    const head = document.createElement('div');
    head.className = 'workflow-file-head';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedFiles.has(file.path);
    checkbox.setAttribute('aria-label', `选择 ${file.path}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedFiles.add(file.path);
      else selectedFiles.delete(file.path);
      renderWorkflow(workflowSnapshot);
    });
    const name = document.createElement('code');
    name.textContent = file.path;
    name.title = file.path;
    const stats = document.createElement('span');
    stats.className = 'file-stats';
    stats.textContent = file.changeKind === 'untracked' ? '未跟踪' : `+${file.additions || 0}  -${file.deletions || 0}`;
    const diffButton = document.createElement('button');
    diffButton.type = 'button';
    diffButton.className = 'file-diff-button';
    diffButton.textContent = '查看 diff';
    const diff = document.createElement('pre');
    diff.className = 'file-diff';
    diff.hidden = true;
    diff.textContent = '正在读取 diff...';
    diffButton.addEventListener('click', async () => {
      diff.hidden = !diff.hidden;
      if (!diff.hidden && diff.textContent === '正在读取 diff...') {
        try {
          const result = await workflowRequest('diff', { files: [file], snapshotGeneration: snapshot?.snapshotGeneration });
          diff.textContent = result?.diffs?.[file.path] || '(无文本 diff)';
        } catch (error) {
          diff.textContent = `读取失败：${error.message}`;
        }
      }
    });
    head.append(checkbox, name, stats, diffButton);
    row.append(head, diff);
    elements.workflowFiles.append(row);
  }
  const canMutate = Boolean(snapshot) && selectedReviewFiles().length > 0;
  if (elements.workflowApply) elements.workflowApply.disabled = !canMutate;
  if (elements.workflowRollback) elements.workflowRollback.disabled = !canMutate;
}

async function refreshWorkflow() {
  if (!elements.workflowFiles) return;
  showWorkflowError(null);
  if (elements.workflowState) elements.workflowState.textContent = '正在读取工作区...';
  try {
    renderWorkflow(await workflowRequest('snapshot'));
  } catch (error) {
    renderWorkflow(null);
    showWorkflowError(error);
  }
}

async function mutateWorkflow(action) {
  const files = selectedReviewFiles();
  if (!files.length || !workflowSnapshot) return;
  const verb = action === 'apply' ? '暂存选中的变更' : '回滚选中的变更';
  if (!window.confirm(`确定要${verb}吗？此操作会修改当前工作区。`)) return;
  if (elements.workflowApply) elements.workflowApply.disabled = true;
  if (elements.workflowRollback) elements.workflowRollback.disabled = true;
  showWorkflowError(null);
  try {
    await workflowRequest(action, {
      files,
      snapshotGeneration: workflowSnapshot.snapshotGeneration,
      confirm: true,
      commandId: `workflow-${action}-${Date.now()}`,
    });
    selectedFiles.clear();
    await refreshWorkflow();
  } catch (error) {
    showWorkflowError(error);
    renderWorkflow(workflowSnapshot);
  }
}

function eventText(message) {
  const params = message?.params || {};
  return params.delta || params.text || params.output || params.item?.text || params.item?.command || params.item?.output || message?.error?.message || '';
}

elements.newThread.addEventListener('click', async () => {
  elements.newThread.disabled = true;
  try { await createThread(); } catch (error) {
    projection.messages.push({ id: `create-error:${Date.now()}`, role: 'system', kind: 'error', text: error.message, status: 'complete' });
    renderMessages();
  } finally { elements.newThread.disabled = false; }
});
elements.refresh.addEventListener('click', () => void refresh().catch(showFatalError));
elements.workflowRefresh?.addEventListener('click', () => void refreshWorkflow());
elements.workflowApply?.addEventListener('click', () => void mutateWorkflow('apply'));
elements.workflowRollback?.addEventListener('click', () => void mutateWorkflow('rollback'));
elements.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = elements.prompt.value.trim();
  if (!prompt) return;
  elements.send.disabled = true;
  elements.sendState.textContent = '发送中';
  try {
    const threadId = activeThreadId || await createThread();
    projection = addPendingUserMessage(projection, prompt);
    projection.status = 'running';
    renderMessages();
    elements.prompt.value = '';
    await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
  } catch (error) {
    projection.messages.push({ id: `send-error:${Date.now()}`, role: 'system', kind: 'error', text: error.message, status: 'complete' });
    projection.status = 'failed';
    renderMessages();
  } finally {
    elements.send.disabled = false;
  }
});

function showFatalError(error) {
  elements.runtimeState.textContent = '连接失败';
  projection.messages.push({ id: `fatal:${Date.now()}`, role: 'system', kind: 'error', text: error.message, status: 'complete' });
  renderMessages();
}

void refresh().catch(showFatalError);
setInterval(() => void pollEvents(), 800);
