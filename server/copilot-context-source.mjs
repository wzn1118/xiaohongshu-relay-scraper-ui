const PREFIX = 'xhs-context://jobs/';
const RECORD_KINDS = new Set(['posts', 'comments', 'users', 'artifacts']);
const LEGACY_DATASETS = new Set(['dataset:content', 'dataset:audience', 'dataset:artifacts']);

export class CopilotContextSourceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CopilotContextSourceError';
    this.code = code;
    this.status = status;
  }
}

export function createCopilotContextSourceId(jobId, kind, recordId, section = 'record') {
  const normalizedKind = String(kind || '').trim();
  if (!RECORD_KINDS.has(normalizedKind)) {
    throw contextError('COPILOT_CONTEXT_KIND_INVALID', `Unsupported context kind: ${normalizedKind || '(empty)'}.`);
  }
  const job = requiredSegment(jobId, 'job ID');
  const record = requiredSegment(recordId, 'record ID');
  const part = requiredSegment(section, 'section');
  return `${PREFIX}${encodeURIComponent(job)}/${normalizedKind}/${encodeURIComponent(record)}?section=${encodeURIComponent(part)}`;
}

export function parseCopilotContextSourceId(value) {
  const text = String(value || '').trim();
  if (!text.startsWith(PREFIX)) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'xhs-context:' || parsed.hostname !== 'jobs') return null;
  const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length !== 3 || !RECORD_KINDS.has(parts[1])) return null;
  const [jobId, kind, recordId] = parts;
  if (!jobId || !recordId) return null;
  return {
    sourceId: text,
    jobId,
    kind,
    recordId,
    section: String(parsed.searchParams.get('section') || 'record').trim() || 'record',
  };
}

export function normalizeCopilotContextSourceIds(value, { jobId = null, maximum = 100 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw contextError('COPILOT_CONTEXT_SOURCES_INVALID', 'Context source IDs must be an array.');
  }
  const normalized = [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
  if (normalized.length > maximum) {
    throw contextError('COPILOT_CONTEXT_SOURCES_EXCEEDED', `At most ${maximum} context sources can be selected.`, 413);
  }
  for (const sourceId of normalized) {
    if (LEGACY_DATASETS.has(sourceId)) continue;
    if (sourceId.startsWith('job:')) {
      if (jobId && sourceId !== `job:${jobId}`) {
        throw contextError('COPILOT_CONTEXT_JOB_MISMATCH', 'A selected context source belongs to another task.', 409);
      }
      continue;
    }
    if (isLegacyOpaqueSourceId(sourceId)) continue;
    const parsed = parseCopilotContextSourceId(sourceId);
    if (!parsed) {
      throw contextError('COPILOT_CONTEXT_SOURCE_INVALID', `Invalid context source ID: ${sourceId.slice(0, 160)}.`);
    }
    if (jobId && parsed.jobId !== String(jobId)) {
      throw contextError('COPILOT_CONTEXT_JOB_MISMATCH', 'A selected context source belongs to another task.', 409);
    }
  }
  return normalized;
}

export function filterRowsByContextSelection(rows, dataset, sourceIds, jobId) {
  const values = Array.isArray(rows) ? rows : [];
  const selected = Array.isArray(sourceIds) ? sourceIds : [];
  if (selected.length === 0) return values;
  const hasLegacyOpaqueSelection = selected.some(isLegacyOpaqueSourceId);
  const taskSelected = selected.includes(`job:${jobId}`);
  const aggregateSelected = aggregateForDataset(dataset).some((id) => selected.includes(id));
  const records = selected
    .map(parseCopilotContextSourceId)
    .filter((item) => item && item.jobId === String(jobId) && sourceAppliesToDataset(item, dataset));
  if (records.length === 0) return taskSelected || aggregateSelected || hasLegacyOpaqueSelection ? values : [];

  const directRecords = records.filter((item) => directKindForDataset(dataset) === item.kind);
  const directIds = new Set(directRecords.map((item) => item.recordId));
  const sectionsById = new Map();
  for (const item of directRecords) {
    const sections = sectionsById.get(item.recordId) || new Set();
    sections.add(item.section);
    sectionsById.set(item.recordId, sections);
  }
  const audiencePostIds = new Set(records
    .filter((item) => item.kind === 'posts' && item.section === 'audience')
    .map((item) => item.recordId));
  return values.flatMap((row) => {
    const id = recordId(row);
    if (directIds.has(id)) return [projectRowForSections(row, dataset, sectionsById.get(id))];
    if (audiencePostIds.size === 0) return [];
    if (audiencePostIds.has(firstString(row?.post_id, row?.postId, row?.note_id, row?.noteId))) return [row];
    const postIds = Array.isArray(row?.post_ids) ? row.post_ids : Array.isArray(row?.postIds) ? row.postIds : [];
    return postIds.some((postId) => audiencePostIds.has(String(postId))) ? [row] : [];
  });
}

function projectRowForSections(row, dataset, sections) {
  if (!sections || sections.has('record')) return row;
  const name = String(dataset || '');
  if (name === 'applications' || name === 'content') {
    return pickRowFields(row, sections, {
      body: ['note_id', 'noteId', 'post_id', 'postId', 'id', 'title', 'note_title', 'body', 'content', 'note_text', 'desc', 'note_url', 'noteUrl', 'source_url', 'url'],
      images: ['note_id', 'noteId', 'post_id', 'postId', 'id', 'title', 'note_title', 'media', 'images', 'cover_url', 'card_cover_url', 'image_analysis', 'ocr'],
      analysis: ['note_id', 'noteId', 'post_id', 'postId', 'id', 'title', 'note_title', 'content_analysis', 'analysis', 'job_card', 'quality'],
      audience: ['note_id', 'noteId', 'post_id', 'postId', 'id', 'title', 'note_title'],
    });
  }
  if (name === 'users') {
    return pickRowFields(row, sections, {
      profile: ['user_id', 'userId', 'id', 'display_name', 'nickname', 'name', 'avatar_url', 'avatarUrl', 'bio', 'description', 'signature', 'profile_url', 'profileUrl', 'profileStatus', 'enrichment_status', 'status', 'profile_analysis'],
      activity: ['user_id', 'userId', 'id', 'display_name', 'nickname', 'roles', 'comment_count', 'commentCount', 'post_ids', 'postIds', 'comments'],
    });
  }
  return row;
}

function pickRowFields(row, sections, fieldsBySection) {
  const fields = new Set();
  for (const section of sections) {
    for (const field of fieldsBySection[section] || []) fields.add(field);
  }
  if (fields.size === 0) return row;
  return Object.fromEntries([...fields].filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
}

function aggregateForDataset(dataset) {
  const name = String(dataset || '');
  if (name === 'applications' || name === 'content') return ['dataset:content'];
  if (name === 'comments' || name === 'users' || name === 'audience.posts') return ['dataset:audience'];
  return [];
}

function directKindForDataset(dataset) {
  const name = String(dataset || '');
  if (name === 'applications' || name === 'content' || name === 'audience.posts') return 'posts';
  if (name === 'comments') return 'comments';
  if (name === 'users') return 'users';
  return '';
}

function sourceAppliesToDataset(source, dataset) {
  const directKind = directKindForDataset(dataset);
  if (source.kind === directKind) return true;
  return source.kind === 'posts'
    && source.section === 'audience'
    && ['comments', 'users', 'audience.posts'].includes(String(dataset));
}

function recordId(row) {
  return firstString(
    row?.note_id,
    row?.noteId,
    row?.post_id,
    row?.postId,
    row?.comment_id,
    row?.commentId,
    row?.user_id,
    row?.userId,
    row?.id,
  );
}

function firstString(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function requiredSegment(value, label) {
  const text = String(value || '').trim();
  if (!text || text.length > 500) throw contextError('COPILOT_CONTEXT_SOURCE_INVALID', `${label} is invalid.`);
  return text;
}

function isLegacyOpaqueSourceId(value) {
  const text = String(value || '').trim();
  return !text.includes(':') && /^[A-Za-z][A-Za-z0-9_.-]{0,200}$/u.test(text);
}

function contextError(code, message, status) {
  return new CopilotContextSourceError(code, message, status);
}
