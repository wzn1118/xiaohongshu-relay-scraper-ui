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
};

let status = null;
let activeThreadId = '';
let eventCursor = 0;

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

function addMessage(text, kind = 'event') {
  elements.messages.querySelector('.empty')?.remove();
  const item = document.createElement('div');
  item.className = `message ${kind}`;
  item.textContent = String(text || '');
  elements.messages.append(item);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function threadLabel(thread) {
  return String(thread?.name || thread?.title || thread?.preview || thread?.id || '未命名任务');
}

function renderThreads(threads = []) {
  elements.threadList.replaceChildren();
  for (const thread of threads) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = threadLabel(thread);
    button.title = button.textContent;
    button.className = thread.id === activeThreadId ? 'active' : '';
    button.addEventListener('click', () => {
      activeThreadId = String(thread.id || '');
      elements.threadTitle.textContent = threadLabel(thread);
      renderThreads(threads);
    });
    elements.threadList.append(button);
  }
}

async function refresh() {
  const response = await fetch('/api/codex-browser/status', { credentials: 'include', cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ready !== true || payload.backend?.initialized !== true) {
    throw new Error(payload?.error?.message || 'Codex app-server 尚未就绪。');
  }
  status = payload;
  document.documentElement.dataset.codexReady = 'true';
  elements.runtimeState.textContent = '已连接';
  elements.runtimeVersion.textContent = payload.backend.appServerVersion || 'app-server';
  const list = await request('thread/list', { limit: 30, useStateDbOnly: true });
  renderThreads(list?.data || []);
}

async function createThread() {
  const result = await request('thread/start', {
    cwd: status?.workspaceRoot || null,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  });
  activeThreadId = String(result?.thread?.id || '');
  if (!activeThreadId) throw new Error('Codex 未返回任务 ID。');
  elements.threadTitle.textContent = threadLabel(result.thread);
  addMessage(`任务已创建：${activeThreadId}`);
  return activeThreadId;
}

async function pollEvents() {
  try {
    const response = await fetch(`/api/codex-browser/events?after=${eventCursor}`, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    for (const event of payload.events || []) {
      const message = event.message || {};
      if (message.type === 'mcp-notification') {
        const delta = message.params?.delta || message.params?.text || message.params?.item?.text || '';
        if (delta) addMessage(delta, 'event');
        else if (message.method === 'turn/completed') addMessage('任务已完成');
      }
    }
    eventCursor = Number(payload.cursor) || eventCursor;
  } catch {
    // The next polling interval retries transient transport failures.
  }
}

elements.newThread.addEventListener('click', async () => {
  elements.newThread.disabled = true;
  try { await createThread(); } catch (error) { addMessage(error.message); }
  finally { elements.newThread.disabled = false; }
});
elements.refresh.addEventListener('click', () => refresh().catch((error) => addMessage(error.message)));
elements.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = elements.prompt.value.trim();
  if (!prompt) return;
  elements.send.disabled = true;
  elements.sendState.textContent = '发送中';
  addMessage(prompt, 'user');
  elements.prompt.value = '';
  try {
    const threadId = activeThreadId || await createThread();
    await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
    elements.sendState.textContent = '运行中';
  } catch (error) {
    addMessage(error.message);
    elements.sendState.textContent = '发送失败';
  } finally {
    elements.send.disabled = false;
  }
});

refresh().catch((error) => {
  elements.runtimeState.textContent = '连接失败';
  addMessage(error.message);
});
setInterval(() => void pollEvents(), 800);
