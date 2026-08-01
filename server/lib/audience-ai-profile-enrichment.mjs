const COLLECTING_PROFILE_MODES = new Set(['collect_missing_header', 'recent_public_posts']);

export function buildAudienceProfileEnrichmentPlan(snapshot, scope) {
  if (!COLLECTING_PROFILE_MODES.has(scope.profileMode)) return null;

  const candidates = (Array.isArray(snapshot.users) ? snapshot.users : [])
    .filter((user) => user && !user.syntheticIdentity && user.userId)
    .slice(0, scope.profileUserLimit > 0 ? scope.profileUserLimit : undefined);
  const users = candidates.filter((user) => {
    if (scope.profileMode === 'collect_missing_header') {
      return !user.profile?.available || (Array.isArray(user.profile?.missingFields) && user.profile.missingFields.length > 0);
    }
    return true;
  });

  return Object.freeze({
    mode: scope.profileMode,
    postId: snapshot.postId,
    userIds: users.map((user) => user.userId),
    users: users.map((user) => ({
      userId: user.userId,
      xhsId: user.xhsId || null,
      profileUrl: user.profile?.profileUrl || null,
      headerAvailable: Boolean(user.profile?.available),
      missingHeaderFields: Array.isArray(user.profile?.missingFields) ? [...user.profile.missingFields] : [],
      recentPublicPostsAvailable: Array.isArray(user.recentPublicPosts) ? user.recentPublicPosts.length : 0,
    })),
    limits: {
      userLimit: scope.profileUserLimit,
      postsPerUser: scope.profileMode === 'recent_public_posts' ? scope.profilePostLimitPerUser : 0,
      totalPosts: scope.profileMode === 'recent_public_posts' ? scope.profilePostTotalLimit : 0,
    },
    estimatedNetworkRequests: scope.profileMode === 'recent_public_posts'
      ? users.length + Math.min(scope.profilePostTotalLimit, users.length * scope.profilePostLimitPerUser)
      : users.length,
  });
}

export function normalizeProfileEnrichmentEvent(value, mode) {
  const event = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawStage = String(event.stage || event.status || '').trim();
  const stage = rawStage === 'waiting_relay' || rawStage === 'relay_busy'
    ? 'waiting_relay'
    : rawStage === 'security_verification' || rawStage === 'waiting_security_verification'
      ? 'security_verification'
      : rawStage === 'collecting_profile_posts' || mode === 'recent_public_posts'
        ? 'collecting_profile_posts'
        : 'collecting_profile_headers';
  return {
    type: stage === 'security_verification' ? 'audience_ai_blocked' : 'audience_ai_profile_progress',
    status: stage === 'waiting_relay' || stage === 'security_verification'
      ? 'waiting_profile_enrichment'
      : stage,
    stage,
    completedUnits: nonNegative(event.completedUnits ?? event.completedUsers),
    totalUnits: nonNegative(event.totalUnits ?? event.totalUsers),
    profilesUsed: nonNegative(event.profilesUsed ?? event.completedUsers),
    message: String(event.message || ''),
    retryAfter: positiveIntegerOrNull(event.retryAfter),
    checkpoint: publicCheckpoint(event.checkpoint),
  };
}

export function normalizeProfileEnrichmentResult(value) {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const status = ['completed', 'partial', 'blocked', 'cancelled', 'failed'].includes(result.status)
    ? result.status
    : 'completed';
  return {
    status,
    message: String(result.message || ''),
    errorCode: typeof result.errorCode === 'string' ? result.errorCode : null,
    retryAfter: positiveIntegerOrNull(result.retryAfter),
    checkpoint: publicCheckpoint(result.checkpoint),
    coverage: result.coverage && typeof result.coverage === 'object' && !Array.isArray(result.coverage)
      ? result.coverage
      : {},
  };
}

function publicCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|token|cookie|authorization|api.?key/iu.test(key)));
}

function nonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export const AUDIENCE_AI_COLLECTING_PROFILE_MODES = Object.freeze([...COLLECTING_PROFILE_MODES]);
