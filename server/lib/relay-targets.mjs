const XHS_HOST = /(^|\.)xiaohongshu\.com$/i;

export function isXiaohongshuTarget(target) {
  try {
    return XHS_HOST.test(new URL(String(target?.url || '')).hostname);
  } catch {
    return false;
  }
}

export function relayTargetSummary(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const pages = list.filter((target) => String(target?.type || 'page') === 'page');
  const xiaohongshuPages = pages.filter(isXiaohongshuTarget);
  const nonTargetPages = pages.filter((target) => !isXiaohongshuTarget(target));
  const iframes = list.filter((target) => target?.type === 'iframe');
  const workers = list.filter((target) => /worker$/i.test(String(target?.type || '')));
  const securityPages = pages.filter(isSecurityRestrictionTarget);
  const pressureReasons = [];

  if (list.length >= 9) pressureReasons.push('target_count');
  if (pages.length >= 3) pressureReasons.push('page_count');
  if (nonTargetPages.length && pages.length >= 3) pressureReasons.push('unrelated_pages');
  if (xiaohongshuPages.length >= 3) pressureReasons.push('duplicate_target_pages');
  if (securityPages.length) pressureReasons.push('security_restriction');

  return {
    targetCount: list.length,
    pageCount: pages.length,
    xiaohongshuPages: xiaohongshuPages.length,
    unrelatedPages: nonTargetPages.length,
    iframeCount: iframes.length,
    workerCount: workers.length,
    securityPages: securityPages.length,
    pressure: pressureReasons.length ? 'high' : 'normal',
    pressureReasons,
    recoveryRecommended: pressureReasons.length > 0,
  };
}

export function planRelayRecovery(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const summary = relayTargetSummary(list);
  const pages = list.filter((target) => String(target?.type || 'page') === 'page');
  const xiaohongshuPages = pages.filter(isXiaohongshuTarget);
  const keeper = [...xiaohongshuPages].sort((left, right) => targetPriority(left) - targetPriority(right))[0] || null;
  const replaceWithFreshPage = summary.recoveryRecommended || !keeper;
  const closeTargets = replaceWithFreshPage
    ? pages
    : pages.filter((target) => String(target?.id || '') !== String(keeper?.id || ''));

  return {
    summary,
    replaceWithFreshPage,
    keeper,
    closeTargets: closeTargets.filter((target) => String(target?.id || '').trim()),
  };
}

function targetPriority(target) {
  const url = String(target?.url || '');
  if (/xiaohongshu\.com\/search_result/i.test(url)) return 0;
  if (/xiaohongshu\.com\/(?:explore)?(?:[?#]|$)/i.test(url)) return 1;
  if (/xiaohongshu\.com\/user\/profile/i.test(url)) return 2;
  if (/xiaohongshu\.com\/explore\//i.test(url)) return 3;
  return 4;
}

function isSecurityRestrictionTarget(target) {
  const text = `${target?.title || ''} ${target?.url || ''}`.toLowerCase();
  return text.includes('/website-login/error')
    || text.includes('error_code=300013')
    || text.includes('access_denied');
}
