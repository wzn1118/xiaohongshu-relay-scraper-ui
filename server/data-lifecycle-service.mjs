import crypto from 'node:crypto';
import path from 'node:path';
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { artifactPathFromId, assertPathInside } from './lib/artifacts.mjs';

const PROFILE_ID = /^[a-f0-9]{16}$/;
const JOB_ID = /^[a-f0-9-]{8,80}$/i;
const DRAFT_ID = /^draft_[a-f0-9]{64}$/;
const LEGACY_DRAFT_ID = /^legacy_[\p{L}\p{N}_.:-]{1,160}$/u;
const ENTITY_TYPES = new Set(['profile', 'job', 'draft', 'artifact', 'all']);
const ACTIVE_JOB_STATUSES = new Set(['queued', 'resuming', 'running']);
const DEFAULT_RETENTION = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  days: 30,
  pinnedJobIds: [],
  updatedAt: null,
});
const TOKEN_TTL_MS = 5 * 60 * 1000;
const CLEAR_ALL_CONFIRMATION = 'DELETE ALL LOCAL DATA';

export class DataLifecycleService {
  constructor({
    manager,
    profileStore,
    retentionPath,
    auditPath,
    now = () => new Date(),
  }) {
    this.manager = manager;
    this.profileStore = profileStore;
    this.retentionPath = retentionPath;
    this.auditPath = auditPath;
    this.now = now;
    this.retention = { ...DEFAULT_RETENTION };
    this.confirmations = new Map();
    this.operationQueue = Promise.resolve();
  }

  async initialize() {
    await Promise.all([
      mkdir(path.dirname(this.retentionPath), { recursive: true }),
      mkdir(path.dirname(this.auditPath), { recursive: true }),
    ]);
    try {
      this.retention = normalizeRetention(JSON.parse(await readFile(this.retentionPath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw lifecycleError('RETENTION_CONFIG_INVALID', 'The saved retention policy is invalid.');
      await this.#persistRetention();
    }
    return this.getRetention();
  }

  getRetention() {
    return structuredClone(this.retention);
  }

  ownership() {
    return ownershipModel();
  }

  async updateRetention(value = {}) {
    this.retention = normalizeRetention({ ...this.retention, ...value, updatedAt: this.now().toISOString() });
    await this.#persistRetention();
    return this.getRetention();
  }

  async preview(input = {}) {
    const spec = normalizeSpec(input);
    const plan = await this.#buildPlan(spec);
    const confirmationToken = crypto.randomBytes(32).toString('base64url');
    const fingerprint = planFingerprint(plan);
    this.#pruneTokens();
    this.confirmations.set(confirmationToken, {
      fingerprint,
      expiresAt: this.now().getTime() + TOKEN_TTL_MS,
    });
    return {
      ...plan,
      confirmationToken,
      confirmationExpiresAt: new Date(this.now().getTime() + TOKEN_TTL_MS).toISOString(),
      ...(spec.entityType === 'all' ? { confirmationPhrase: CLEAR_ALL_CONFIRMATION } : {}),
    };
  }

  async execute(input = {}) {
    const spec = normalizeSpec(input);
    const token = String(input.confirmationToken || '');
    if (!token) throw lifecycleError('DELETION_CONFIRMATION_REQUIRED', 'A fresh dry-run confirmation token is required.');
    if (spec.entityType === 'all' && input.confirmationPhrase !== CLEAR_ALL_CONFIRMATION) {
      throw lifecycleError('CLEAR_ALL_CONFIRMATION_REQUIRED', `Enter ${CLEAR_ALL_CONFIRMATION} to clear all local data.`);
    }
    return this.#enqueue(async () => {
      this.#pruneTokens();
      const issued = this.confirmations.get(token);
      if (!issued) throw lifecycleError('DELETION_CONFIRMATION_INVALID', 'The dry-run confirmation is missing, expired, or already used.');
      const plan = await this.#buildPlan(spec);
      if (plan.status !== 'ready') {
        throw lifecycleError('DELETION_BLOCKED', plan.blockedReasons.map((item) => item.message).join(' '), { plan });
      }
      if (issued.fingerprint !== planFingerprint(plan)) {
        throw lifecycleError('DELETION_PLAN_CHANGED', 'The data changed after dry-run. Run the preview again.', { plan });
      }
      this.confirmations.delete(token);

      const startedAt = this.now().toISOString();
      try {
        const result = await this.#executePlan(plan, spec);
        await this.#appendAudit({
          operation: plan.operation,
          entityType: spec.entityType,
          entityId: primaryEntityId(spec),
          force: spec.force,
          status: 'succeeded',
          fileCount: plan.fileCount,
          totalBytes: plan.totalBytes,
          startedAt,
        });
        return { ...result, audit: { recorded: true } };
      } catch (error) {
        await this.#appendAudit({
          operation: plan.operation,
          entityType: spec.entityType,
          entityId: primaryEntityId(spec),
          force: spec.force,
          status: 'failed',
          errorCode: error.code || 'DELETION_FAILED',
          fileCount: plan.fileCount,
          totalBytes: plan.totalBytes,
          startedAt,
        });
        throw error;
      }
    });
  }

  async cleanupExpired({ dryRun = true } = {}) {
    if (!dryRun) return this.#enqueue(() => this.#cleanupExpired(false));
    return this.#cleanupExpired(true);
  }

  async #cleanupExpired(dryRun) {
    const policy = this.getRetention();
    const cutoff = this.now().getTime() - (policy.days * 24 * 60 * 60 * 1000);
    const pinned = new Set(policy.pinnedJobIds);
    const eligible = this.manager.jobs.filter((job) => (
      !ACTIVE_JOB_STATUSES.has(job.status)
      && !pinned.has(job.id)
      && Number.isFinite(Date.parse(job.finishedAt || job.updatedAt || job.createdAt || ''))
      && Date.parse(job.finishedAt || job.updatedAt || job.createdAt) < cutoff
    ));
    const skipped = this.manager.jobs.filter((job) => (
      ACTIVE_JOB_STATUSES.has(job.status) || pinned.has(job.id)
    )).map((job) => ({
      type: 'job',
      id: job.id,
      reason: pinned.has(job.id) ? 'pinned' : 'active',
    }));

    if (!policy.enabled) {
      return {
        schemaVersion: 1,
        enabled: false,
        dryRun: true,
        eligible: [],
        skipped,
        message: 'Automatic cleanup is disabled until the user explicitly enables a retention policy.',
      };
    }

    const previews = [];
    for (const job of eligible) previews.push(await this.#buildPlan({ entityType: 'job', jobId: job.id, force: false }));
    if (dryRun) return { schemaVersion: 1, enabled: true, dryRun: true, eligible: previews, skipped };

    const deleted = [];
    for (const plan of previews) {
      if (plan.status !== 'ready') continue;
      const jobId = plan.entities[0].id;
      try {
        deleted.push(await this.#executePlan(
          plan,
          { entityType: 'job', jobId, force: false },
          { rejectActive: true },
        ));
      } catch (error) {
        if (error.code !== 'JOB_ACTIVE_RETENTION') throw error;
        skipped.push({ type: 'job', id: jobId, reason: 'became_active' });
        continue;
      }
      await this.#appendAudit({
        operation: 'retention_cleanup',
        entityType: 'job',
        entityId: plan.entities[0].id,
        force: false,
        status: 'succeeded',
        fileCount: plan.fileCount,
        totalBytes: plan.totalBytes,
        startedAt: this.now().toISOString(),
      });
    }
    return { schemaVersion: 1, enabled: true, dryRun: false, deleted, skipped };
  }

  async #buildPlan(spec) {
    if (spec.entityType === 'profile') return this.#profilePlan(spec);
    if (spec.entityType === 'job') return this.#jobPlan(spec);
    if (spec.entityType === 'draft') return this.#draftPlan(spec);
    if (spec.entityType === 'artifact') return this.#artifactPlan(spec);
    return this.#allPlan(spec);
  }

  async #profilePlan(spec) {
    const profile = await this.profileStore.get(spec.profileId);
    const references = this.manager.jobs.flatMap((job) => jobProfileId(job) === spec.profileId
      ? [{ type: 'job', id: job.id, status: job.status }]
      : []);
    const target = directChild(this.profileStore.root, spec.profileId, PROFILE_ID, 'PROFILE_ID_INVALID');
    const inventory = await inventoryTree(this.profileStore.root, target);
    const blockedReasons = [...inventory.blockedReasons];
    if (references.length && !spec.force) {
      blockedReasons.push({
        code: 'PROFILE_REFERENCED',
        message: `Profile is referenced by ${references.length} task(s). Use force after reviewing the impact.`,
      });
    }
    return finalizePlan({
      operation: 'delete_profile',
      spec,
      entities: [{ type: 'profile', id: spec.profileId, label: profile.name || profile.title || 'Profile' }],
      inventory,
      references,
      blockedReasons,
      requiresForce: references.length > 0,
    });
  }

  async #jobPlan(spec) {
    const job = this.manager.getInternal(spec.jobId);
    if (!job) throw lifecycleError('JOB_NOT_FOUND', 'Task not found.');
    const target = jobDirectory(this.manager.dataDir, job);
    const inventory = await inventoryTree(this.manager.dataDir, target);
    const references = this.manager.jobs.flatMap((candidate) => jobReferences(candidate, job.id)
      ? [{ type: 'job', id: candidate.id, relation: 'historical_lineage', status: candidate.status }]
      : []);
    const owned = classifyJobFiles(inventory.files);
    return finalizePlan({
      operation: 'delete_job',
      spec,
      entities: [
        { type: 'job', id: job.id, status: job.status },
        ...owned,
      ],
      inventory,
      references,
      blockedReasons: inventory.blockedReasons,
      requiresForce: false,
    });
  }

  async #artifactPlan(spec) {
    const job = this.manager.getInternal(spec.jobId);
    if (!job) throw lifecycleError('JOB_NOT_FOUND', 'Task not found.');
    const outputRoot = await verifiedJobOutputRoot(this.manager.dataDir, job);
    let resolved;
    try {
      resolved = artifactPathFromId(outputRoot, spec.artifactId);
    } catch {
      throw lifecycleError('ARTIFACT_NOT_FOUND', 'Artifact not found.');
    }
    const inventory = await inventoryFile(outputRoot, resolved.absolute);
    if (inventory.missing) throw lifecycleError('ARTIFACT_NOT_FOUND', 'Artifact not found.');
    const manifestPath = path.join(outputRoot, 'artifact-manifest.json');
    const includeManifest = resolved.relative !== 'artifact-manifest.json' && await regularFileExists(manifestPath);
    const manifestInventory = includeManifest ? await inventoryFile(outputRoot, manifestPath) : emptyInventory();
    const combined = combineInventories(inventory, manifestInventory);
    return finalizePlan({
      operation: 'delete_artifact',
      spec,
      entities: [
        { type: 'artifact', id: spec.artifactId, jobId: job.id, name: path.basename(resolved.relative) },
        ...(includeManifest ? [{ type: 'artifact_manifest', jobId: job.id, reason: 'manifest_invalidated' }] : []),
      ],
      inventory: combined,
      references: includeManifest ? [{ type: 'manifest', relation: 'indexes_artifact' }] : [],
      blockedReasons: combined.blockedReasons,
      requiresForce: false,
    });
  }

  async #draftPlan(spec) {
    const job = this.manager.getInternal(spec.jobId);
    if (!job) throw lifecycleError('JOB_NOT_FOUND', 'Task not found.');
    const outputRoot = await verifiedJobOutputRoot(this.manager.dataDir, job);
    const match = await findStoredDraft(outputRoot, spec.draftId);
    if (!match) throw lifecycleError('DRAFT_NOT_FOUND', 'Draft not found.');
    const candidateFiles = [
      path.join(outputRoot, 'delivery-state.json'),
      path.join(outputRoot, 'delivery-state.v1.backup.json'),
      path.join(outputRoot, 'delivery-send-audit.jsonl'),
    ];
    const inventories = [];
    for (const candidate of candidateFiles) {
      if (await regularFileExists(candidate)) inventories.push(await inventoryFile(outputRoot, candidate));
    }
    const inventory = inventories.reduce(combineInventories, emptyInventory());
    return finalizePlan({
      operation: 'delete_draft',
      spec,
      entities: [{ type: 'draft', id: spec.draftId, jobId: job.id, noteId: match.noteId }],
      inventory,
      references: [{ type: 'job', id: job.id, relation: 'owns_draft' }],
      blockedReasons: inventory.blockedReasons,
      requiresForce: false,
    });
  }

  async #allPlan(spec) {
    const profiles = await this.profileStore.list();
    const jobPlans = [];
    for (const job of this.manager.jobs) jobPlans.push(await this.#jobPlan({ entityType: 'job', jobId: job.id, force: false }));
    const profilePlans = [];
    for (const profile of profiles) profilePlans.push(await this.#profilePlan({ entityType: 'profile', profileId: profile.id, force: true }));
    const blockedReasons = [...jobPlans, ...profilePlans].flatMap((plan) => plan.blockedReasons);
    return {
      schemaVersion: 1,
      operation: 'clear_all_local_data',
      entityType: spec.entityType,
      status: blockedReasons.length ? 'blocked' : 'ready',
      entities: [
        ...jobPlans.flatMap((plan) => plan.entities),
        ...profilePlans.flatMap((plan) => plan.entities),
      ],
      fileCount: jobPlans.reduce((sum, plan) => sum + plan.fileCount, 0) + profilePlans.reduce((sum, plan) => sum + plan.fileCount, 0),
      totalBytes: jobPlans.reduce((sum, plan) => sum + plan.totalBytes, 0) + profilePlans.reduce((sum, plan) => sum + plan.totalBytes, 0),
      references: profilePlans.flatMap((plan) => plan.references),
      blockedReasons,
      requiresForce: true,
      ownership: ownershipModel(),
      planParts: { jobs: jobPlans, profiles: profilePlans },
    };
  }

  async #executePlan(plan, spec, { rejectActive = false } = {}) {
    if (spec.entityType === 'profile') {
      const target = directChild(this.profileStore.root, spec.profileId, PROFILE_ID, 'PROFILE_ID_INVALID');
      if (spec.force) await this.manager.detachProfile(spec.profileId);
      await safeRemoveDirectory(this.profileStore.root, target);
      return deletionResult(plan);
    }
    if (spec.entityType === 'job') {
      const job = this.manager.getInternal(spec.jobId);
      if (!job) throw lifecycleError('JOB_NOT_FOUND', 'Task not found.');
      let removed = false;
      try {
        await this.manager.quiesceForDeletion(job.id, { rejectActive });
        await this.manager.detachJobReferences(job.id);
        await safeRemoveDirectory(this.manager.dataDir, jobDirectory(this.manager.dataDir, job));
        await this.manager.removeJobRecord(job.id);
        removed = true;
        return deletionResult(plan);
      } finally {
        if (!removed) this.manager.releaseDeletionIntent?.(job.id);
      }
    }
    if (spec.entityType === 'artifact') {
      const job = this.manager.getInternal(spec.jobId);
      if (!job) throw lifecycleError('JOB_NOT_FOUND', 'Task not found.');
      const outputRoot = await verifiedJobOutputRoot(this.manager.dataDir, job);
      const target = artifactPathFromId(outputRoot, spec.artifactId).absolute;
      await safeRemoveFile(outputRoot, target);
      const manifest = path.join(outputRoot, 'artifact-manifest.json');
      if (path.resolve(target) !== path.resolve(manifest) && await regularFileExists(manifest)) {
        await safeRemoveFile(outputRoot, manifest);
      }
      await this.manager.refreshArtifactCount(job.id);
      return deletionResult(plan);
    }
    if (spec.entityType === 'draft') {
      const job = this.manager.getInternal(spec.jobId);
      if (!job) throw lifecycleError('JOB_NOT_FOUND', 'Task not found.');
      const outputRoot = await verifiedJobOutputRoot(this.manager.dataDir, job);
      const deleted = await deleteStoredDraft(outputRoot, spec.draftId);
      if (!deleted) throw lifecycleError('DRAFT_NOT_FOUND', 'Draft not found.');
      return deletionResult(plan);
    }

    const jobs = [...this.manager.jobs];
    let jobsRemoved = false;
    try {
      for (const job of jobs) await this.manager.quiesceForDeletion(job.id);
      for (const job of jobs) await safeRemoveDirectory(this.manager.dataDir, jobDirectory(this.manager.dataDir, job));
      await this.manager.removeJobRecords(jobs.map((job) => job.id));
      jobsRemoved = true;
    } finally {
      if (!jobsRemoved) for (const job of jobs) this.manager.releaseDeletionIntent?.(job.id);
    }
    const profiles = await this.profileStore.list();
    for (const profile of profiles) {
      await safeRemoveDirectory(this.profileStore.root, directChild(this.profileStore.root, profile.id, PROFILE_ID, 'PROFILE_ID_INVALID'));
    }
    return deletionResult(plan);
  }

  #enqueue(operation) {
    const result = this.operationQueue.catch(() => {}).then(operation);
    this.operationQueue = result.catch(() => {});
    return result;
  }

  #pruneTokens() {
    const now = this.now().getTime();
    for (const [token, value] of this.confirmations) {
      if (value.expiresAt <= now) this.confirmations.delete(token);
    }
  }

  async #persistRetention() {
    await writeJsonAtomically(this.retentionPath, this.retention);
  }

  async #appendAudit(value) {
    const record = {
      schemaVersion: 1,
      auditId: crypto.randomUUID(),
      event: 'local_data_deletion',
      recordedAt: this.now().toISOString(),
      operation: value.operation,
      entityType: value.entityType,
      entityIdHash: value.entityId ? hashIdentifier(value.entityId) : null,
      force: value.force === true,
      status: value.status,
      errorCode: value.errorCode || null,
      fileCount: Number(value.fileCount || 0),
      totalBytes: Number(value.totalBytes || 0),
      startedAt: value.startedAt,
    };
    await appendFile(this.auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
  }
}

export function ownershipModel() {
  return {
    schemaVersion: 1,
    relations: [
      { owner: 'profile', dependent: 'job', relation: 'referenced_by', cascade: 'detach_on_force' },
      { owner: 'job', dependent: 'draft', relation: 'owns', cascade: 'delete' },
      { owner: 'job', dependent: 'artifact', relation: 'owns', cascade: 'delete' },
      { owner: 'job', dependent: 'checkpoint', relation: 'owns', cascade: 'delete' },
      { owner: 'job', dependent: 'log', relation: 'owns', cascade: 'delete' },
    ],
  };
}

function normalizeSpec(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const entityType = String(source.entityType || '').trim().toLowerCase();
  if (!ENTITY_TYPES.has(entityType)) throw lifecycleError('DELETION_ENTITY_INVALID', 'Unsupported deletion entity type.');
  const spec = { entityType, force: source.force === true };
  if (entityType === 'profile') {
    spec.profileId = String(source.profileId || '');
    if (!PROFILE_ID.test(spec.profileId)) throw lifecycleError('PROFILE_NOT_FOUND', 'Profile not found.');
  }
  if (['job', 'draft', 'artifact'].includes(entityType)) {
    spec.jobId = String(source.jobId || '');
    if (!JOB_ID.test(spec.jobId)) throw lifecycleError('JOB_NOT_FOUND', 'Task not found.');
  }
  if (entityType === 'draft') {
    spec.draftId = String(source.draftId || '');
    if (!DRAFT_ID.test(spec.draftId) && !LEGACY_DRAFT_ID.test(spec.draftId)) {
      throw lifecycleError('DRAFT_NOT_FOUND', 'Draft not found.');
    }
  }
  if (entityType === 'artifact') {
    spec.artifactId = String(source.artifactId || '');
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(spec.artifactId)) throw lifecycleError('ARTIFACT_NOT_FOUND', 'Artifact not found.');
  }
  return spec;
}

function normalizeRetention(value = {}) {
  if (value.enabled !== true && value.enabled !== false) throw lifecycleError('RETENTION_CONFIG_INVALID', 'enabled must be boolean');
  const days = Number(value.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw lifecycleError('RETENTION_CONFIG_INVALID', 'days must be between 1 and 3650');
  const pinnedJobIds = [...new Set(Array.isArray(value.pinnedJobIds) ? value.pinnedJobIds.map(String) : [])];
  if (pinnedJobIds.some((id) => !JOB_ID.test(id))) throw lifecycleError('RETENTION_CONFIG_INVALID', 'pinnedJobIds contains an invalid task id');
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    days,
    pinnedJobIds,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
}

function finalizePlan({ operation, spec, entities, inventory, references, blockedReasons, requiresForce }) {
  return {
    schemaVersion: 1,
    operation,
    entityType: spec.entityType,
    status: blockedReasons.length ? 'blocked' : 'ready',
    entities,
    fileCount: inventory.fileCount,
    totalBytes: inventory.totalBytes,
    references,
    blockedReasons,
    requiresForce,
    ownership: ownershipModel(),
  };
}

function deletionResult(plan) {
  return {
    schemaVersion: 1,
    deleted: true,
    operation: plan.operation,
    entities: plan.entities,
    fileCount: plan.fileCount,
    totalBytes: plan.totalBytes,
  };
}

function primaryEntityId(spec) {
  return spec.profileId || spec.jobId || spec.draftId || spec.artifactId || null;
}

function planFingerprint(plan) {
  const stable = {
    operation: plan.operation,
    status: plan.status,
    entities: plan.entities,
    fileCount: plan.fileCount,
    totalBytes: plan.totalBytes,
    references: plan.references,
    blockedReasons: plan.blockedReasons,
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function hashIdentifier(value) {
  return crypto.createHash('sha256').update(`local-data-id:v1\n${value}`).digest('hex');
}

function lifecycleError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function jobProfileId(job) {
  return job?.params?.profileId || job?.config?.profileId || null;
}

function jobReferences(job, id) {
  return job.id !== id && (
    job?.params?.resumeFromJobId === id
    || job?.sourceJobId === id
    || job?.legacyResumeLineage?.sourceJobId === id
  );
}

function directChild(root, id, pattern, errorCode) {
  if (!pattern.test(String(id || ''))) throw lifecycleError(errorCode, 'Invalid entity id.');
  const target = path.resolve(root, id);
  assertPathInside(root, target);
  if (path.dirname(target) !== path.resolve(root)) throw lifecycleError('UNSAFE_DELETE_TARGET', 'Deletion target must be a direct child of its storage root.');
  return target;
}

function jobDirectory(root, job) {
  const expected = directChild(root, job.id, JOB_ID, 'JOB_NOT_FOUND');
  const configured = path.resolve(path.dirname(job.outputDir || path.join(expected, 'artifacts')));
  if (configured !== expected) throw lifecycleError('UNSAFE_JOB_DIRECTORY', 'Task storage is outside its owned directory.');
  return expected;
}

async function verifiedJobOutputRoot(root, job) {
  const directory = jobDirectory(root, job);
  const output = path.resolve(job.outputDir || path.join(directory, 'artifacts'));
  assertPathInside(directory, output);
  const [directoryReal, outputReal] = await Promise.all([realpath(directory), realpath(output)]);
  assertPathInside(directoryReal, outputReal);
  return outputReal;
}

async function inventoryTree(root, target) {
  const inventory = emptyInventory();
  assertPathInside(root, target);
  let targetInfo;
  try {
    targetInfo = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return inventory;
    throw error;
  }
  if (targetInfo.isSymbolicLink()) {
    inventory.blockedReasons.push({ code: 'UNSAFE_SYMLINK', message: 'Deletion target is a symbolic link.' });
    return inventory;
  }
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  assertPathInside(rootReal, targetReal);
  await walkInventory(target, '', inventory);
  return inventory;
}

async function walkInventory(directory, relative, inventory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const item = await lstat(absolute);
    const itemRelative = path.join(relative, entry.name).replaceAll('\\', '/');
    if (item.isSymbolicLink()) {
      inventory.blockedReasons.push({ code: 'UNSAFE_SYMLINK', message: `Symbolic link found inside deletion scope: ${itemRelative}` });
      continue;
    }
    if (item.isDirectory()) {
      await walkInventory(absolute, itemRelative, inventory);
      continue;
    }
    if (item.isFile()) {
      inventory.fileCount += 1;
      inventory.totalBytes += item.size;
      inventory.files.push({ relative: itemRelative, size: item.size });
    }
  }
}

async function inventoryFile(root, target) {
  const inventory = emptyInventory();
  assertPathInside(root, target);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { ...inventory, missing: true };
    throw error;
  }
  if (info.isSymbolicLink()) {
    inventory.blockedReasons.push({ code: 'UNSAFE_SYMLINK', message: 'Artifact target is a symbolic link.' });
    return inventory;
  }
  if (!info.isFile()) {
    inventory.blockedReasons.push({ code: 'UNSAFE_FILE_TYPE', message: 'Deletion target is not a regular file.' });
    return inventory;
  }
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  assertPathInside(rootReal, targetReal);
  inventory.fileCount = 1;
  inventory.totalBytes = info.size;
  inventory.files.push({ relative: path.relative(root, target).replaceAll('\\', '/'), size: info.size });
  return inventory;
}

function emptyInventory() {
  return { fileCount: 0, totalBytes: 0, files: [], blockedReasons: [] };
}

function combineInventories(left, right) {
  return {
    fileCount: left.fileCount + right.fileCount,
    totalBytes: left.totalBytes + right.totalBytes,
    files: [...left.files, ...right.files],
    blockedReasons: [...left.blockedReasons, ...right.blockedReasons],
  };
}

function classifyJobFiles(files) {
  const counts = { draft: 0, artifact: 0, checkpoint: 0, log: 0 };
  for (const file of files) {
    if (/delivery-state/i.test(file.relative)) counts.draft += 1;
    if (/\.log$|audit\.jsonl$/i.test(file.relative)) counts.log += 1;
    if (/checkpoint|workflow-state|ledger/i.test(file.relative)) counts.checkpoint += 1;
    if (file.relative.startsWith('artifacts/')) counts.artifact += 1;
  }
  return Object.entries(counts).flatMap(([type, count]) => count ? [{ type, count }] : []);
}

async function safeRemoveDirectory(root, target) {
  const inventory = await inventoryTree(root, target);
  if (inventory.blockedReasons.length) throw lifecycleError('UNSAFE_DELETE_TARGET', inventory.blockedReasons[0].message);
  try {
    await rm(target, { recursive: true, force: false, maxRetries: process.platform === 'win32' ? 4 : 0, retryDelay: 100 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function safeRemoveFile(root, target) {
  const inventory = await inventoryFile(root, target);
  if (inventory.missing) throw lifecycleError('ARTIFACT_NOT_FOUND', 'Artifact not found.');
  if (inventory.blockedReasons.length) throw lifecycleError('UNSAFE_DELETE_TARGET', inventory.blockedReasons[0].message);
  await unlink(target);
}

async function regularFileExists(target) {
  try {
    return (await lstat(target)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function findStoredDraft(outputRoot, draftId) {
  const legacyNoteId = draftId.startsWith('legacy_') ? draftId.slice('legacy_'.length) : null;
  for (const filename of ['delivery-state.json', 'delivery-state.v1.backup.json']) {
    try {
      const state = JSON.parse(await readFile(path.join(outputRoot, filename), 'utf8'));
      for (const [noteId, value] of Object.entries(state || {})) {
        if (noteId.startsWith('_')) continue;
        if (value?.draftStore?.draftId === draftId) return { noteId, filename };
        if (legacyNoteId === noteId && value?.draft && typeof value.draft === 'object') return { noteId, filename };
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

async function deleteStoredDraft(outputRoot, draftId) {
  let deleted = false;
  const legacyNoteId = draftId.startsWith('legacy_') ? draftId.slice('legacy_'.length) : null;
  for (const filename of ['delivery-state.json', 'delivery-state.v1.backup.json']) {
    const target = path.join(outputRoot, filename);
    let state;
    try {
      state = JSON.parse(await readFile(target, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    let changed = false;
    for (const [noteId, value] of Object.entries(state || {})) {
      const matchesVersionedDraft = value?.draftStore?.draftId === draftId;
      const matchesLegacyDraft = legacyNoteId === noteId && value?.draft && typeof value.draft === 'object';
      if (!matchesVersionedDraft && !matchesLegacyDraft) continue;
      delete state[noteId];
      deleted = true;
      changed = true;
    }
    if (changed) await writeJsonAtomically(target, state);
  }
  const auditPath = path.join(outputRoot, 'delivery-send-audit.jsonl');
  try {
    const lines = (await readFile(auditPath, 'utf8')).split(/\r?\n/u).filter(Boolean);
    const kept = lines.filter((line) => {
      try { return JSON.parse(line)?.draftId !== draftId; } catch { return true; }
    });
    if (kept.length !== lines.length) await writeTextAtomically(auditPath, kept.length ? `${kept.join('\n')}\n` : '');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return deleted;
}

async function writeJsonAtomically(target, value) {
  await writeTextAtomically(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(target, value) {
  const temporary = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}
