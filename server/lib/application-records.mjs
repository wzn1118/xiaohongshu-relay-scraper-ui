export function isIncompleteApplicationRecord(record) {
  const analysis = record?.media?.analysis;
  const application = record?.application_info;
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
    || !String(record?.body || '').trim()
    || record?.job_card?.parse_basis === 'search_card'
    || String(record?.outreach?.runtime_status || '') === 'fallback_missing_job_body';
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
