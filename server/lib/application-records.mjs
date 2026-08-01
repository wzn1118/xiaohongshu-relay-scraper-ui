export function isIncompleteApplicationRecord(record) {
  if (!String(record?.body || '').trim()) return true;

  const analysis = record?.media?.analysis;
  const application = record?.application_info;
  const runtimeStatus = String(record?.outreach?.runtime_status || '');
  if (new Set([
    'fallback_missing_job_body',
    'image_enriched_missing_job_body',
    'fallback_model_error',
    'quality_threshold_not_met',
    'fact_validation_failed',
    'fact_validation_needs_human_review',
  ]).has(runtimeStatus)) return true;
  const verifiedImageEnrichment = analysis?.status === 'analyzed'
    && analysis?.source === 'vision_model'
    && record?.job_card?.enrichment_status === 'image_enriched'
    && ['responsibilities', 'requirements', 'application_routes'].some(
      (field) => Array.isArray(application?.[field]) && application[field].length > 0,
    );
  if (verifiedImageEnrichment) return false;

  const hasUnmergedVerifiedImageText = analysis?.status === 'analyzed'
    && analysis?.source === 'vision_model'
    && String(analysis?.visible_text || '').trim().length >= 4;
  return hasUnmergedVerifiedImageText
    || record?.job_card?.parse_basis === 'search_card';
}

export function isIncompleteGeneralRecord(record) {
  const analysis = record?.content_analysis;
  const modules = Array.isArray(analysis?.modules) ? analysis.modules : [];
  const hasAnalysis = String(analysis?.status || '') === 'completed'
    && Number(analysis?.grounded_evidence_count || 0) > 0
    && Boolean(String(analysis?.overview || '').trim())
    && modules.some((module) => String(module?.summary || '').trim() || module?.items?.length);
  const media = record?.media;
  const images = Array.isArray(media?.images) ? media.images : [];
  const imageUnderstood = images.length === 0
    || String(media?.analysis?.source || '') === 'vision_model';
  return !hasAnalysis || !imageUnderstood;
}
