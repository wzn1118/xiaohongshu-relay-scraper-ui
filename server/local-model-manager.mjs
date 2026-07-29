import { randomUUID } from 'node:crypto';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

export const LOCAL_MODEL_CATALOG = Object.freeze([
  Object.freeze({
    id: 'qwen3.5:0.8b',
    label: 'Qwen3.5 0.8B',
    description: '极速轻量，适合低配电脑做基础文本清洗',
    downloadBytes: 1036046583,
    family: 'Qwen3.5',
    tier: '超轻量',
    recommended: false,
  }),
  Object.freeze({
    id: 'qwen3.5:2b',
    label: 'Qwen3.5 2B',
    description: '轻量均衡，适合日常字段提取与摘要',
    downloadBytes: 2741192820,
    family: 'Qwen3.5',
    tier: '轻量',
    recommended: false,
  }),
  Object.freeze({
    id: 'qwen3.5:4b',
    label: 'Qwen3.5 4B',
    description: '默认推荐，兼顾中文整理质量与本地速度',
    downloadBytes: 3389983735,
    family: 'Qwen3.5',
    tier: '均衡',
    recommended: true,
  }),
  Object.freeze({
    id: 'qwen3.5:9b',
    label: 'Qwen3.5 9B',
    description: '质量优先，需要更大的内存与显存空间',
    downloadBytes: 6594474711,
    family: 'Qwen3.5',
    tier: '质量',
    recommended: false,
  }),
  Object.freeze({
    id: 'qwen3:0.6b',
    label: 'Qwen3 0.6B',
    description: '占用极低，适合快速分类、清洗和短文本提取',
    downloadBytes: 523000000,
    family: 'Qwen3',
    tier: '超轻量',
    recommended: false,
  }),
  Object.freeze({
    id: 'qwen3:1.7b',
    label: 'Qwen3 1.7B',
    description: '低内存中文模型，适合批量处理岗位卡片',
    downloadBytes: 1400000000,
    family: 'Qwen3',
    tier: '轻量',
    recommended: false,
  }),
  Object.freeze({
    id: 'qwen3:4b',
    label: 'Qwen3 4B',
    description: '中文能力均衡，适合结构化提取和求职文案整理',
    downloadBytes: 2500000000,
    family: 'Qwen3',
    tier: '均衡',
    recommended: false,
  }),
  Object.freeze({
    id: 'qwen3:8b',
    label: 'Qwen3 8B',
    description: '更强的指令理解与长文本归纳，适合高质量文案',
    downloadBytes: 5200000000,
    family: 'Qwen3',
    tier: '质量',
    recommended: false,
  }),
  Object.freeze({
    id: 'gemma3:1b',
    label: 'Gemma 3 1B',
    description: '轻量多语言模型，适合基础摘要与分类',
    downloadBytes: 815000000,
    family: 'Gemma 3',
    tier: '超轻量',
    recommended: false,
  }),
  Object.freeze({
    id: 'gemma3:4b',
    label: 'Gemma 3 4B',
    description: '多语言任务均衡，适合中英文岗位信息整理',
    downloadBytes: 3300000000,
    family: 'Gemma 3',
    tier: '均衡',
    recommended: false,
  }),
  Object.freeze({
    id: 'llama3.2:1b',
    label: 'Llama 3.2 1B',
    description: '轻量通用模型，适合英文摘要和简单字段提取',
    downloadBytes: 1300000000,
    family: 'Llama 3.2',
    tier: '轻量',
    recommended: false,
  }),
  Object.freeze({
    id: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    description: '通用英文能力更完整，适合双语材料整理',
    downloadBytes: 2000000000,
    family: 'Llama 3.2',
    tier: '均衡',
    recommended: false,
  }),
  Object.freeze({
    id: 'deepseek-r1:1.5b',
    label: 'DeepSeek-R1 1.5B',
    description: '轻量推理模型，适合需要步骤判断的短文本任务',
    downloadBytes: 1100000000,
    family: 'DeepSeek-R1',
    tier: '轻量推理',
    recommended: false,
  }),
  Object.freeze({
    id: 'deepseek-r1:7b',
    label: 'DeepSeek-R1 7B',
    description: '推理质量优先，适合复杂岗位匹配与文案检查',
    downloadBytes: 4700000000,
    family: 'DeepSeek-R1',
    tier: '质量推理',
    recommended: false,
  }),
]);

export class LocalModelManager {
  constructor({ fetchImpl = globalThis.fetch, endpoint = DEFAULT_ENDPOINT, statusTimeoutMs = 3000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.endpoint = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.statusTimeoutMs = statusTimeoutMs;
    this.installJob = null;
  }

  async status() {
    const runtime = await this.runtimeStatus();
    const installedModels = runtime.models || [];
    const installedByName = new Map(installedModels.map((item) => [item.name.toLowerCase(), item]));
    const curatedNames = new Set(LOCAL_MODEL_CATALOG.map((item) => item.id.toLowerCase()));
    const catalog = LOCAL_MODEL_CATALOG.map((item) => ({
      ...item,
      custom: false,
      installed: installedByName.has(item.id.toLowerCase()),
    }));
    for (const installed of installedModels) {
      if (curatedNames.has(installed.name.toLowerCase())) continue;
      catalog.push({
        id: installed.name,
        label: installed.name,
        description: '本机 Ollama 中已安装的扩展模型',
        downloadBytes: installed.size,
        family: '本机扩展',
        tier: '自定义',
        recommended: false,
        custom: true,
        installed: true,
      });
    }
    return {
      runtime: {
        ready: runtime.ready,
        endpoint: this.endpoint,
        version: runtime.version || '',
        message: runtime.message,
      },
      catalog,
      installedModels,
      install: this.publicJob(),
      fetchedAt: new Date().toISOString(),
    };
  }

  async startInstall(modelId) {
    const requestedId = normalizeLocalModelId(modelId);
    const curatedModel = LOCAL_MODEL_CATALOG.find((item) => item.id.toLowerCase() === requestedId.toLowerCase());
    const model = curatedModel || {
      id: requestedId,
      label: requestedId,
      description: '用户添加的 Ollama 扩展模型',
      downloadBytes: 0,
      family: '本地扩展',
      tier: '自定义',
      recommended: false,
      custom: true,
    };
    if (this.installJob && ['queued', 'running'].includes(this.installJob.status)) {
      const error = localModelError('LOCAL_MODEL_BUSY', `正在安装 ${this.installJob.modelId}，请等待当前下载完成。`);
      error.install = this.publicJob();
      throw error;
    }
    const runtime = await this.runtimeStatus();
    if (!runtime.ready) {
      throw localModelError('LOCAL_MODEL_RUNTIME_UNAVAILABLE', '未检测到本地模型运行器，请先安装并启动 Ollama。');
    }
    if (runtime.models.some((item) => item.name.toLowerCase() === model.id.toLowerCase())) {
      this.installJob = {
        id: randomUUID(),
        modelId: model.id,
        status: 'completed',
        progress: 100,
        message: `${model.label} 已安装。`,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      return this.publicJob();
    }

    this.installJob = {
      id: randomUUID(),
      modelId: model.id,
      status: 'queued',
      progress: 0,
      completedBytes: 0,
      totalBytes: model.downloadBytes,
      largestLayerBytes: 0,
      message: `准备下载 ${model.label}…`,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const job = this.installJob;
    queueMicrotask(() => void this.runInstall(job, model));
    return this.publicJob();
  }

  async runtimeStatus() {
    if (typeof this.fetchImpl !== 'function') {
      return { ready: false, models: [], message: '当前服务无法访问本地模型运行器。' };
    }
    try {
      const [tagsResponse, versionResponse] = await Promise.all([
        this.fetchImpl(`${this.endpoint}/api/tags`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.statusTimeoutMs),
        }),
        this.fetchImpl(`${this.endpoint}/api/version`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.statusTimeoutMs),
        }).catch(() => null),
      ]);
      if (!tagsResponse.ok) throw new Error(`HTTP ${tagsResponse.status}`);
      const payload = await tagsResponse.json();
      const versionPayload = versionResponse?.ok ? await versionResponse.json().catch(() => ({})) : {};
      const models = (Array.isArray(payload?.models) ? payload.models : [])
        .map((item) => ({
          name: String(item?.name || item?.model || '').trim(),
          size: Number(item?.size || 0),
          modifiedAt: String(item?.modified_at || item?.modifiedAt || ''),
        }))
        .filter((item) => item.name);
      return {
        ready: true,
        models,
        version: String(versionPayload?.version || ''),
        message: models.length ? `已检测到 ${models.length} 个本地模型。` : '本地运行器已启动，尚未安装模型。',
      };
    } catch {
      return {
        ready: false,
        models: [],
        message: '未检测到本地模型运行器。',
      };
    }
  }

  async runInstall(job, model) {
    if (this.installJob !== job) return;
    Object.assign(job, {
      status: 'running',
      startedAt: new Date().toISOString(),
      message: `正在下载 ${model.label}…`,
    });
    try {
      const response = await this.fetchImpl(`${this.endpoint}/api/pull`, {
        method: 'POST',
        headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.id, stream: true }),
      });
      if (!response.ok || !response.body) throw new Error(`本地运行器返回 HTTP ${response.status}。`);
      await consumeNdjson(response.body, (event) => this.applyProgress(job, event));
      if (job.status === 'failed') return;
      Object.assign(job, {
        status: 'completed',
        progress: 100,
        completedBytes: job.totalBytes,
        message: `${model.label} 安装完成，可以立即启用。`,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      Object.assign(job, {
        status: 'failed',
        message: cleanInstallError(error),
        finishedAt: new Date().toISOString(),
      });
    }
  }

  applyProgress(job, event) {
    if (event?.error) throw new Error(String(event.error));
    const total = Number(event?.total || 0);
    const completed = Number(event?.completed || 0);
    if (total > 0 && completed >= 0) {
      const progress = Math.max(job.progress, Math.min(99, Math.round((completed / total) * 100)));
      job.progress = progress;
      if (total >= (job.largestLayerBytes || 0)) {
        Object.assign(job, {
          largestLayerBytes: total,
          completedBytes: completed,
          totalBytes: Math.max(job.totalBytes || 0, total),
        });
      }
    }
    const status = String(event?.status || '').trim();
    if (status && status !== 'success') job.message = humanizePullStatus(status, modelLabel(job.modelId));
  }

  publicJob() {
    if (!this.installJob) return null;
    const { id, modelId, status, progress, completedBytes, totalBytes, message, createdAt, startedAt, finishedAt } = this.installJob;
    return { id, modelId, status, progress, completedBytes, totalBytes, message, createdAt, startedAt, finishedAt };
  }
}

async function consumeNdjson(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

function modelLabel(modelId) {
  return LOCAL_MODEL_CATALOG.find((item) => item.id === modelId)?.label || modelId;
}

function humanizePullStatus(status, label) {
  if (/manifest/i.test(status)) return `正在读取 ${label} 下载清单…`;
  if (/verifying/i.test(status)) return `正在校验 ${label} 文件…`;
  if (/writing/i.test(status)) return `正在写入 ${label}…`;
  if (/pulling/i.test(status)) return `正在下载 ${label}…`;
  return status;
}

function cleanInstallError(error) {
  const message = String(error?.message || '本地模型安装失败。').replace(/[\r\n]+/g, ' ').slice(0, 300);
  return `安装失败：${message}`;
}

function normalizeLocalModelId(value) {
  const modelId = String(value || '').trim();
  const segments = modelId.split(':');
  const name = segments[0] || '';
  const tag = segments[1] || '';
  const nameParts = name.split('/');
  const validName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
    && !name.endsWith('/')
    && !name.includes('//')
    && nameParts.every((part) => part !== '.' && part !== '..');
  const validTag = segments.length === 1 || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag);
  if (!modelId || modelId.length > 200 || segments.length > 2 || !validName || !validTag) {
    throw localModelError(
      'LOCAL_MODEL_VALIDATION',
      '请输入有效的 Ollama 模型 ID，例如 qwen3:4b 或 hf.co/org/model:Q4_K_M。',
    );
  }
  return modelId;
}

function localModelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
