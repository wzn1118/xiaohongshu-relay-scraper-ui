import { createHash } from 'node:crypto';
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';

const DEFAULT_PRODUCT_NAME = 'Xiaohongshu Relay Scraper';
const MAX_SOURCE_FILES = 5_000;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const SOURCE_EXCLUDED_DIRECTORIES = new Set([
  '.codex-ppt-rework-20260813',
  '.codex-tmp',
  '.playwright-cli',
  '.pytest_cache',
  '.git',
  '.runtime',
  'artifacts',
  'data',
  'deliverables',
  'deploy',
  'dist',
  'node_modules',
  'output',
  'outputs',
  'profiles',
  'playwright-report',
  'runtime',
  'test-results',
  'tmp',
  'vendor',
]);

export class CodexProductWorkspaceServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'CodexProductWorkspaceServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createCodexProductWorkspaceService(options = {}) {
  return new CodexProductWorkspaceService(options);
}

/**
 * Projects that appear in the Codex sidebar are backed by real local roots.
 * The source project is the writable product repository; historical job
 * projects point at their immutable/generated artifact directories.
 */
export class CodexProductWorkspaceService {
  constructor({ manager, workspaceRoot, productName = DEFAULT_PRODUCT_NAME, now = () => new Date() } = {}) {
    if (!manager?.list || !manager?.getInternal) {
      throw new TypeError('Codex product workspace service requires a job manager.');
    }
    this.manager = manager;
    this.workspaceRoot = path.resolve(String(workspaceRoot || process.cwd()));
    this.productName = String(productName || DEFAULT_PRODUCT_NAME).trim() || DEFAULT_PRODUCT_NAME;
    this.now = now;
    this.sourceProjectId = `product-source-${shortHash(this.workspaceRoot)}`;
  }

  status() {
    const snapshot = this.snapshot();
    return {
      schemaVersion: 1,
      sourceProjectId: snapshot.source.id,
      sourceProjectName: snapshot.source.name,
      historyProjects: snapshot.history.length,
      activeJobId: snapshot.activeJobId,
      generatedAt: snapshot.generatedAt,
    };
  }

  snapshot() {
    const source = this.sourceProject();
    const history = this.historyProjects();
    return {
      schemaVersion: 1,
      source,
      history,
      activeJobId: this.manager.active?.id || null,
      generatedAt: this.#nowIso(),
    };
  }

  publicSnapshot() {
    const snapshot = this.snapshot();
    return {
      schemaVersion: snapshot.schemaVersion,
      source: publicProject(snapshot.source),
      history: snapshot.history.map(publicProject),
      activeJobId: snapshot.activeJobId,
      generatedAt: snapshot.generatedAt,
    };
  }

  sourceProject() {
    return {
      id: this.sourceProjectId,
      kind: 'source',
      name: this.productName,
      rootPaths: [this.workspaceRoot],
      description: 'Product source workspace. Codex can inspect, run, test, and modify this repository.',
      createdAt: 0,
      updatedAt: Date.now(),
      metadata: {
        product: 'xiaohongshu-relay-scraper-ui',
        writable: true,
        sourceManifestResource: 'codex-product://workspace/source',
      },
    };
  }

  historyProjects() {
    return this.manager.list().map((job) => this.jobProject(job)).filter(Boolean);
  }

  jobProject(job) {
    if (!job?.id) return null;
    const internal = this.manager.getInternal(job.id);
    const outputDir = String(internal?.outputDir || '').trim();
    if (!outputDir) return null;
    const root = path.resolve(outputDir);
    const label = taskLabel(job);
    return {
      id: `product-job-${job.id}`,
      kind: 'job-history',
      name: label,
      rootPaths: [root],
      description: `Historical product task ${job.id}. This workspace contains task artifacts, workflow state, and result files.`,
      createdAt: toMilliseconds(job.createdAt),
      updatedAt: toMilliseconds(job.updatedAt || job.finishedAt || job.createdAt),
      metadata: {
        jobId: job.id,
        status: String(job.status || 'unknown'),
        keyword: String(job.keyword || ''),
        artifactCount: Number(job.artifactCount || 0),
        resultResource: `codex-product://jobs/${encodeURIComponent(job.id)}`,
        artifactsResource: `codex-product://jobs/${encodeURIComponent(job.id)}/artifacts`,
        writable: false,
      },
    };
  }

  project(projectId) {
    const id = String(projectId || '').trim();
    if (!id || id === this.sourceProjectId) return this.sourceProject();
    const jobId = id.startsWith('product-job-') ? id.slice('product-job-'.length) : '';
    if (!jobId) return null;
    const job = this.manager.get(jobId);
    return job ? this.jobProject(job) : null;
  }

  hostState(selectedProjectId = '') {
    const source = this.sourceProject();
    const history = this.historyProjects();
    const projects = [source, ...history];
    const byId = Object.fromEntries(projects.map((project) => [project.id, project]));
    const selected = byId[String(selectedProjectId || '')] || source;
    const labels = Object.fromEntries(projects.flatMap((project) => project.rootPaths.map((root) => [root, project.name])));
    return {
      source,
      history,
      projects: byId,
      projectOrder: projects.map((project) => project.id),
      selectedProject: { type: 'local', projectId: selected.id },
      activeWorkspaceRoots: [...selected.rootPaths],
      workspaceRoots: projects.flatMap((project) => project.rootPaths),
      workspaceRootLabels: labels,
      selectedProjectRoot: selected.rootPaths[0] || this.workspaceRoot,
    };
  }

  async sourceManifest({ maxFiles = MAX_SOURCE_FILES, maxBytes = MAX_SOURCE_BYTES } = {}) {
    const boundedFiles = Math.min(MAX_SOURCE_FILES, Math.max(1, Number(maxFiles) || MAX_SOURCE_FILES));
    const boundedBytes = Math.min(MAX_SOURCE_BYTES, Math.max(1, Number(maxBytes) || MAX_SOURCE_BYTES));
    const files = [];
    const stack = [''];
    let totalBytes = 0;
    let truncated = false;

    while (stack.length && files.length < boundedFiles && totalBytes < boundedBytes) {
      const relativeDirectory = stack.pop();
      const absoluteDirectory = path.join(this.workspaceRoot, relativeDirectory);
      let entries;
      try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error) {
        if (relativeDirectory === '') throw error;
        continue;
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
        if (entry.isDirectory()) {
          if (!SOURCE_EXCLUDED_DIRECTORIES.has(entry.name)) stack.push(relativePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const absolutePath = path.join(this.workspaceRoot, relativePath);
        let info;
        try {
          info = await stat(absolutePath);
        } catch {
          continue;
        }
        if (files.length >= boundedFiles || totalBytes + info.size > boundedBytes) {
          truncated = true;
          break;
        }
        totalBytes += info.size;
        files.push({ path: relativePath.replaceAll('\\', '/'), size: Number(info.size), modifiedAt: info.mtime.toISOString() });
      }
      if (files.length >= boundedFiles || totalBytes >= boundedBytes) truncated = true;
    }
    return {
      schemaVersion: 1,
      project: publicProject(this.sourceProject()),
      files,
      fileCount: files.length,
      totalBytes,
      truncated,
      excludedDirectories: [...SOURCE_EXCLUDED_DIRECTORIES].sort(),
      generatedAt: this.#nowIso(),
    };
  }

  developerInstructions() {
    const source = this.sourceProject();
    return [
      `You are operating ${source.name}.`,
      `The default writable source workspace is ${source.rootPaths[0]}.`,
      'Use the codex-product MCP for product task state, historical results, context bundles, and task controls.',
      'Historical task projects are artifact workspaces. Treat them as result evidence; modify product source only in the source workspace unless the user explicitly requests generated-artifact changes.',
    ].join('\n');
  }

  #nowIso() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new CodexProductWorkspaceServiceError('CODEX_PRODUCT_WORKSPACE_CLOCK_INVALID', 'The product workspace clock is invalid.', 500);
    }
    return date.toISOString();
  }
}

function publicProject(project) {
  return {
    id: project.id,
    kind: project.kind,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    metadata: { ...(project.metadata || {}) },
  };
}

function taskLabel(job) {
  const keyword = String(job?.keyword || '').trim();
  const suffix = keyword || String(job?.id || '').slice(-8) || 'untitled';
  // Keep generated labels stable when a Windows client uses a legacy code page.
  return `Task - ${suffix}`;
}

function shortHash(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function toMilliseconds(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}
