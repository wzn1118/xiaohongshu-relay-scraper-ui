const elements = {
  runtimeState: document.querySelector('#runtime-state'), runtimeVersion: document.querySelector('#runtime-version'),
  threadTitle: document.querySelector('#thread-title'), threadList: document.querySelector('#thread-list'), newThread: document.querySelector('#new-thread'),
  refresh: document.querySelector('#refresh'), messages: document.querySelector('#messages'), composer: document.querySelector('#composer'), prompt: document.querySelector('#prompt'),
  send: document.querySelector('#send'), sendState: document.querySelector('#send-state'), workflowRefresh: document.querySelector('#workflow-refresh'), workflowState: document.querySelector('#workflow-state'),
  workflowCount: document.querySelector('#workflow-count'), workflowFiles: document.querySelector('#workflow-files'), workflowOutput: document.querySelector('#workflow-output'), workflowCommandState: document.querySelector('#workflow-command-state'),
  workflowApply: document.querySelector('#workflow-apply'), workflowRollback: document.querySelector('#workflow-rollback'), workflowError: document.querySelector('#workflow-error'),
};
let status = null; let activeThreadId = ''; let eventCursor = 0; let workflowSnapshot = null; const selectedFiles = new Set();

async function request(method, params = {}) {
  const response = await fetch('/api/codex-browser/request', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Codex request returned HTTP ${response.status}.`); return payload;
}
async function workflowRequest(action, extra = {}) {
  const response = await fetch('/api/codex-browser/workflow', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, cwd: status?.workspaceRoot || undefined, source: 'uncommitted', threadId: activeThreadId || undefined, ...extra }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Workflow request returned HTTP ${response.status}.`); return payload;
}
function addMessage(text, kind = 'event') { elements.messages.querySelector('.empty')?.remove(); const item = document.createElement('div'); item.className = `message ${kind}`; item.textContent = String(text || ''); elements.messages.append(item); elements.messages.scrollTop = elements.messages.scrollHeight; }
function threadLabel(thread) { return String(thread?.name || thread?.title || thread?.preview || thread?.id || '未命名任务'); }
function renderThreads(threads = []) { elements.threadList.replaceChildren(); for (const thread of threads) { const button = document.createElement('button'); button.type = 'button'; button.textContent = threadLabel(thread); button.title = button.textContent; button.className = thread.id === activeThreadId ? 'active' : ''; button.addEventListener('click', () => { activeThreadId = String(thread.id || ''); elements.threadTitle.textContent = threadLabel(thread); renderThreads(threads); refreshWorkflow(); }); elements.threadList.append(button); } }
function showWorkflowError(error) { elements.workflowError.hidden = !error; elements.workflowError.textContent = error ? String(error.message || error) : ''; }
function selectedReviewFiles() { return (workflowSnapshot?.files || []).filter((file) => selectedFiles.has(file.path)); }

function renderWorkflow(snapshot = null) {
  workflowSnapshot = snapshot; const files = Array.isArray(snapshot?.files) ? snapshot.files : []; elements.workflowCount.textContent = String(files.length); elements.workflowState.textContent = snapshot ? `${files.length} 个文件 · 快照 #${snapshot.snapshotGeneration ?? '-'}` : '暂无工作区快照'; elements.workflowFiles.replaceChildren();
  if (!files.length) { const empty = document.createElement('div'); empty.className = 'muted'; empty.textContent = '暂无工作区变更'; elements.workflowFiles.append(empty); }
  for (const file of files) {
    const row = document.createElement('article'); row.className = `workflow-file ${selectedFiles.has(file.path) ? 'selected' : ''}`; const head = document.createElement('div'); head.className = 'workflow-file-head';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedFiles.has(file.path); checkbox.setAttribute('aria-label', `选择 ${file.path}`); checkbox.addEventListener('change', () => { if (checkbox.checked) selectedFiles.add(file.path); else selectedFiles.delete(file.path); renderWorkflow(workflowSnapshot); });
    const name = document.createElement('code'); name.textContent = file.path; name.title = file.path; const stats = document.createElement('span'); stats.className = 'file-stats'; stats.textContent = file.changeKind === 'untracked' ? '未跟踪' : `+${file.additions || 0}  -${file.deletions || 0}`;
    const diffButton = document.createElement('button'); diffButton.type = 'button'; diffButton.className = 'file-diff-button'; diffButton.textContent = '查看 diff'; const diff = document.createElement('pre'); diff.className = 'file-diff'; diff.hidden = true; diff.textContent = '正在读取 diff...';
    diffButton.addEventListener('click', async () => { diff.hidden = !diff.hidden; if (!diff.hidden && diff.textContent === '正在读取 diff...') { try { const result = await workflowRequest('diff', { files: [file], snapshotGeneration: snapshot.snapshotGeneration }); diff.textContent = result?.diffs?.[file.path] || '(无文本 diff)'; } catch (error) { diff.textContent = `读取失败：${error.message}`; } } });
    head.append(checkbox, name, stats, diffButton); row.append(head, diff); elements.workflowFiles.append(row);
  }
  const canMutate = files.length > 0 && selectedFiles.size > 0; elements.workflowApply.disabled = !canMutate; elements.workflowRollback.disabled = !canMutate;
}
async function refreshWorkflow() { showWorkflowError(null); elements.workflowState.textContent = '正在读取工作区...'; try { renderWorkflow(await workflowRequest('snapshot')); } catch (error) { renderWorkflow(null); showWorkflowError(error); } }
async function mutateWorkflow(action) {
  const files = selectedReviewFiles(); if (!files.length || !workflowSnapshot) return; const verb = action === 'apply' ? '暂存选中的变更' : '回滚选中的变更'; if (!window.confirm(`确定要${verb}吗？此操作会修改当前工作区。`)) return;
  elements.workflowApply.disabled = true; elements.workflowRollback.disabled = true; showWorkflowError(null); try { await workflowRequest(action, { files, snapshotGeneration: workflowSnapshot.snapshotGeneration, confirm: true, commandId: `workflow-${action}-${Date.now()}` }); selectedFiles.clear(); await refreshWorkflow(); } catch (error) { showWorkflowError(error); renderWorkflow(workflowSnapshot); }
}
function eventText(message) { const params = message?.params || {}; return params.delta || params.text || params.output || params.item?.text || params.item?.command || params.item?.output || message?.error?.message || ''; }
async function refresh() {
  const response = await fetch('/api/codex-browser/status', { credentials: 'include', cache: 'no-store' }); const payload = await response.json().catch(() => ({})); if (!response.ok || payload.ready !== true || payload.backend?.initialized !== true) throw new Error(payload?.error?.message || 'Codex app-server 尚未就绪.');
  status = payload; document.documentElement.dataset.codexReady = 'true'; elements.runtimeState.textContent = '已连接'; elements.runtimeVersion.textContent = payload.backend.appServerVersion || 'app-server'; const list = await request('thread/list', { limit: 30, useStateDbOnly: true }); renderThreads(list?.data || []); await refreshWorkflow();
}
async function createThread() { const result = await request('thread/start', { cwd: status?.workspaceRoot || null, approvalPolicy: 'on-request', sandbox: 'workspace-write' }); activeThreadId = String(result?.thread?.id || ''); if (!activeThreadId) throw new Error('Codex 未返回任务 ID。'); elements.threadTitle.textContent = threadLabel(result.thread); addMessage(`任务已创建：${activeThreadId}`); await refreshWorkflow(); return activeThreadId; }
async function pollEvents() {
  try { const response = await fetch(`/api/codex-browser/events?after=${eventCursor}`, { credentials: 'include', cache: 'no-store' }); if (!response.ok) return; const payload = await response.json(); for (const event of payload.events || []) { const message = event.message || {}; const threadId = String(message.params?.threadId || message.params?.thread?.id || ''); if (activeThreadId && threadId && threadId !== activeThreadId) continue; const text = eventText(message); if (text) { const failed = /failed|error|exit code [1-9]/iu.test(`${message.method || ''} ${text}`); addMessage(text, failed ? 'error' : 'event'); elements.workflowCommandState.textContent = failed ? '失败' : '有新输出'; elements.workflowOutput.textContent = `${elements.workflowOutput.textContent === '尚未收到命令输出。' ? '' : `${elements.workflowOutput.textContent}\n`}${text}`.trim(); } if (message.method === 'turn/completed') { addMessage('任务已完成'); elements.workflowCommandState.textContent = '已完成'; await refreshWorkflow(); } if (message.method === 'turn/failed') elements.workflowCommandState.textContent = '失败'; } eventCursor = Number(payload.cursor) || eventCursor; } catch { /* retry on next poll */ }
}
elements.newThread.addEventListener('click', async () => { elements.newThread.disabled = true; try { await createThread(); } catch (error) { addMessage(error.message, 'error'); } finally { elements.newThread.disabled = false; } }); elements.refresh.addEventListener('click', () => refresh().catch((error) => addMessage(error.message, 'error'))); elements.workflowRefresh.addEventListener('click', () => void refreshWorkflow()); elements.workflowApply.addEventListener('click', () => void mutateWorkflow('apply')); elements.workflowRollback.addEventListener('click', () => void mutateWorkflow('rollback'));
elements.composer.addEventListener('submit', async (event) => { event.preventDefault(); const prompt = elements.prompt.value.trim(); if (!prompt) return; elements.send.disabled = true; elements.sendState.textContent = '发送中'; addMessage(prompt, 'user'); elements.prompt.value = ''; try { const threadId = activeThreadId || await createThread(); await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] }); elements.sendState.textContent = '运行中'; } catch (error) { addMessage(error.message, 'error'); elements.sendState.textContent = '发送失败'; } finally { elements.send.disabled = false; } });
refresh().catch((error) => { elements.runtimeState.textContent = '连接失败'; addMessage(error.message, 'error'); }); setInterval(() => void pollEvents(), 800);
