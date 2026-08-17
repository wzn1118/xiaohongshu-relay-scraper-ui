import { applicationRoleTitle } from './application-email-draft.mjs';

const EMAIL_SIGNAL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const APPLICATION_ROUTE_SIGNAL = /(?:投递|邮箱|邮件|私信|官网申请|申请链接|简历(?:发送|投递)|内推码|联系我)/iu;
const JOB_POST_SIGNAL = /(?:招聘|招募|内推|岗位|职位|实习生|intern|job)/iu;
const EXPLICIT_JOB_SIGNAL = /(?:招聘|急招|招募|内推|继任|岗位职责|职位描述|日常实习生|投递)/iu;
const NON_JOB_TITLE_SIGNAL = /(?:面经|面试复盘|求职复盘|找实习.*(?:记录|日记|完结)|上岸经历|文书长什么样|经验分享)/iu;

const NON_JOB_CONTEXT_SIGNAL = /(?:\u6c42\u804c\u771f\u76f8|\u6c42\u804c(?:\u653b\u7565|\u5fc3\u5f97|\u5efa\u8bae)|\u884c\u4e1a(?:\u5206\u6790|\u6d1e\u5bdf|\u8d8b\u52bf)|\u5c31\u4e1a(?:\u5f62\u52bf|\u89e3\u8bfb))/iu;

function titleHeadline(value) {
  return String(value || '')
    .replace(/#[^#\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 180);
}

function sourceText(record) {
  return [record?.title, record?.body, record?.body_excerpt, record?.source_card_text]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
}

function hasStructuredApplicationRoute(record) {
  const application = record?.application_info;
  if (!application || typeof application !== 'object') return false;
  return (Array.isArray(application.contacts) && application.contacts.length > 0)
    || (Array.isArray(application.application_routes) && application.application_routes.length > 0);
}

function hasInsufficientJobDetail(record) {
  const card = record?.job_card;
  if (!card || typeof card !== 'object' || String(card.parse_basis || '').toLowerCase() !== 'full_body') return false;
  const responsibilityCount = Number(card.responsibility_count) || 0;
  const requirementCount = Number(card.requirement_count) || 0;
  const routeCount = Number(card.route_count) || 0;
  const responsibilities = Array.isArray(record?.application_info?.responsibilities)
    ? record.application_info.responsibilities.filter(Boolean)
    : [];
  return responsibilityCount === 0
    && responsibilities.length === 0
    && requirementCount <= 1
    && routeCount <= 1;
}

export function hasVerifiedApplicationSignal(record) {
  if (hasStructuredApplicationRoute(record)) return true;
  const text = sourceText(record);
  return EMAIL_SIGNAL.test(text)
    || (APPLICATION_ROUTE_SIGNAL.test(text) && JOB_POST_SIGNAL.test(text));
}

export function classifyApplicationSource(record) {
  const title = String(record?.title || '').trim();
  const text = sourceText(record);
  const applicationSignal = hasVerifiedApplicationSignal(record);
  const explicitJobSignal = EXPLICIT_JOB_SIGNAL.test(text);
  const roleName = applicationRoleTitle(record);

  const nonJobContext = NON_JOB_CONTEXT_SIGNAL.test(titleHeadline(title));
  if (NON_JOB_TITLE_SIGNAL.test(titleHeadline(title)) || nonJobContext) {
    return {
      status: 'not_job',
      reasonCode: nonJobContext ? 'NON_JOB_SOURCE_CONTEXT' : 'NON_JOB_SOURCE_TITLE',
      reason: '原始内容是面经、复盘或经验分享，不是可投递岗位。',
      roleName,
      applicationSignal,
      explicitJobSignal,
    };
  }
  if (!applicationSignal && !explicitJobSignal) {
    return {
      status: 'not_job',
      reasonCode: 'APPLICATION_SIGNAL_MISSING',
      reason: '原始内容缺少可验证的招聘或投递信号。',
      roleName,
      applicationSignal,
      explicitJobSignal,
    };
  }
  if (!roleName) {
    return {
      status: 'needs_role_review',
      reasonCode: 'ROLE_NAME_MISSING',
      reason: '招聘信息存在，但正文没有可确认的岗位名称，需要人工补全后再生成。',
      roleName: '',
      applicationSignal,
      explicitJobSignal,
    };
  }
  if (hasInsufficientJobDetail(record)) {
    return {
      status: 'source_blocked',
      reasonCode: 'JOB_DETAIL_MISSING',
      reason: '原始正文未提供可验证的岗位职责或完整要求，当前数据不足以生成可投递内容。',
      roleName,
      applicationSignal,
      explicitJobSignal,
    };
  }
  return {
    status: 'sendable',
    reasonCode: 'SOURCE_VERIFIED',
    reason: '招聘信号与岗位名称均已确认。',
    roleName,
    applicationSignal,
    explicitJobSignal,
  };
}

export function prepareApplicationRecord(record, disposition = classifyApplicationSource(record)) {
  if (disposition.status !== 'sendable' || !disposition.roleName) return record;
  return {
    ...record,
    job_card: {
      ...(record?.job_card && typeof record.job_card === 'object' ? record.job_card : {}),
      role_name: disposition.roleName,
    },
  };
}
