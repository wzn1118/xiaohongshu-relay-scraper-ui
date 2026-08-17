import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applicationRoleTitle,
  resolveApplicationEmailSubject,
} from '../server/lib/application-email-draft.mjs';
import { buildApplicationAttachmentRule } from '../server/lib/application-attachment-rule.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const jobId = process.env.APPLICATION_JOB_ID || '20260804081657-caf8f451';
const outputId = process.env.APPLICATION_OUTPUT_ID || '019fd23f-5213-7503-906f-a68757a199d7';
const sourcePath = path.join(repoRoot, 'data', 'jobs', jobId, 'artifacts', 'application_intelligence.json');
const outputDir = path.join(repoRoot, 'outputs', outputId);
const tailoredPath = path.join(outputDir, '715岗位逐岗定制邮件数据.json');
const resumeSourcePath = process.env.APPLICATION_RESUME_PATH
  || 'E:\\xwechat_files\\wxid_rjnr8utczy2811_22da\\msg\\file\\2026-08\\曼彻斯特大学王梓楠AI产品经理13811817014可实习6个月2周内到岗(1).pdf';
const packagedResumePath = path.join(outputDir, '附件', '曼彻斯特大学王梓楠AI产品经理13811817014可实习6个月随时到岗.pdf');

const candidate = Object.freeze({
  candidateName: '王梓楠',
  school: '曼彻斯特大学',
  major: '全球发展',
  undergraduateEducation: '首都经济贸易大学电子商务本科',
  graduateEducation: '曼彻斯特大学全球发展硕士',
  degreeYear: '研一',
  availabilityDays: '',
  internshipDuration: '六个月',
  arrivalDate: '随时到岗',
  phone: '13811817014',
  email: 'zinan.wang-3@student.manchester.ac.uk',
  aiProductExperience: '有，主导 Asteria Analyst、小红书招聘信息采集与投递准备工作台等 AI 产品项目',
  relevantExperience: '产品策划、用户研究、增长运营、数据分析与 AI 产品落地经验',
});

const evidenceCards = Object.freeze([
  {
    id: 'resume_foundation_growth_pm',
    title: '中国基金会发展论坛增长产品经理',
    keywords: ['增长', '内容', '用户', '社群', '活动', '运营', '调研', '需求', '访谈', '转化', '私域', '生态', '公益', '商务', '资源'],
    proof: '在中国基金会发展论坛担任增长产品经理期间，我访谈了 520 位秘书长，搭建三级内容体系并推动自动化采集，使日均流量提升 230%、内容完成率由 25% 提升至 40%；同时新增 210 位秘书长用户，并推动 50 笔捐赠、累计 410 万元。',
  },
  {
    id: 'resume_perfect_world_product',
    title: '完美世界 All History 产品经理实习',
    keywords: ['产品', '用户研究', '用户体验', '搜索', '推荐', '知识图谱', '需求', '功能', '数据', '指标', '留存', '交互', '内容', '策略'],
    proof: '在完美世界 All History 产品经理实习中，我整理 300 余条用户反馈并分析 5,000 余次搜索，参与搜索、知识图谱和推荐优化，推动停留时长提升 24%、知识节点点击率提升 17%、关联内容点击率提升 21%，并使搜索无结果率下降 9%。',
  },
  {
    id: 'resume_tiger_brokers_product',
    title: '老虎证券产品经理实习',
    keywords: ['金融', '证券', '交易', '商业', '策略', '数据', '漏斗', '转化', '增长', '产品', '市场', '竞品', 'ab', '实验', '指标'],
    proof: '在老虎证券产品经理实习中，我围绕 10 万余次访问和 200 余条反馈识别 8 项需求，需求覆盖率达到 85%；通过漏斗分析和 6 组以上 A/B 测试，推动详情到订阅转化提升 16%、决策点击率提升 22%、流程完成率提升 13%。',
  },
  {
    id: 'resume_youdao_strategy_ops',
    title: '网易有道战略运营实习',
    keywords: ['战略', '运营', '教育', '课程', '直播', '报告', '画像', '分析', 'sop', '流程', '转化', '质量', '审核'],
    proof: '在网易有道战略运营实习中，我完成 20 份业务报告并沉淀 4 类用户画像，参与直播与转化策略迭代，使转化率提升 3.2%；同时优化质检流程，将单次质检耗时由 30 分钟降至 10 分钟。',
  },
  {
    id: 'resume_xiaohe_content_ops',
    title: '字节跳动小荷产品运营实习',
    keywords: ['内容', '运营', '创作者', '社区', '短视频', '图文', '新媒体', '选题', '编辑', '增长', '活动', '审核', '用户', '平台'],
    proof: '在字节跳动小荷产品运营实习中，我通过用户访谈归纳 4 类需求并迭代内容策略，推动内容停留时长提升 30%、完成率提升 77%；运营期间新增 4,000 余名注册用户、维护 100 余位创作者，并推动每周稳定产出 30 余篇内容。',
  },
  {
    id: 'resume_asteria_ai_product',
    title: 'Asteria Analyst AI 产品项目',
    keywords: ['ai', '人工智能', 'agent', '智能体', '大模型', '数据', '分析', '报告', '企业', 'b端', '质量', '评测', '自动化', '工作流', '产品经理'],
    proof: '我主导 Asteria Analyst 多 Agent 数据分析产品，围绕数据上传、分析、校验到报告交付设计完整流程；项目沉淀 362 个分析方法、4,028 张知识卡片和 81 个可运行能力，并建立 551 项测试保障结果质量。',
  },
  {
    id: 'resume_xhs_ai_workbench',
    title: '小红书招聘信息 AI 工作台',
    keywords: ['小红书', '招聘', '采集', '爬取', 'ai', '人工智能', '产品', '工作台', '自动化', '流程', '数据', '内容', '质量', '用户', '邮件', '交付'],
    proof: '我主导小红书招聘信息采集与 AI 内容洞察工作台，从信息采集、岗位结构化、AI 文案生成到投递准备设计端到端流程；项目覆盖 34 个 UI 模块、14 个服务，并对 999 篇内容、4,092 条评论、1,503 个用户和 5,792 条数据记录完成可追溯处理。',
  },
  {
    id: 'resume_hegel_ai_platform',
    title: 'Hegel Salon AI 阅读与研究平台',
    keywords: ['研究', '知识', '阅读', '协作', '平台', 'web', '部署', '多用户', 'ai', '人工智能', '文档', '开源', '产品'],
    proof: '我主导 Hegel Salon AI 阅读与研究平台，设计六步研究流程和 5 项 AI 能力，并完成 Windows、Docker、Render 与 Cloudflare 的产品化部署；项目在 GitHub 获得 98 个 Star。',
  },
]);

// Each card is intentionally concise: one concrete action/result, so a job duty can be
// matched to a real resume fact without pasting a generic project introduction.
const evidenceProfiles = Object.freeze([
  {
    id: 'resume_foundation_growth_pm',
    title: '中国基金会发展论坛增长产品经理',
    tags: ['growth', 'research', 'operation'],
    proof: '我在中国基金会发展论坛访谈 520 位秘书长，定位信息、学习与连接三类高频场景并重构内容链路，使日均流量提升 230%、课程完播率从 25% 提升至 40%。',
  },
  {
    id: 'resume_perfect_world_product',
    title: '完美世界 All History 产品经理实习',
    tags: ['product', 'research', 'data'],
    proof: '我在完美世界整理 300 余条用户反馈、分析 5,000 余次搜索，推动搜索、知识图谱和推荐相关的 6 项功能迭代，使搜索无结果率下降 9%。',
  },
  {
    id: 'resume_tiger_brokers_product',
    title: '老虎证券产品经理实习',
    tags: ['product', 'data', 'growth'],
    proof: '我在老虎国际结合 10 万余次访问和 200 余条反馈识别 8 项需求，并通过 6 组以上复盘和 A/B 测试，将详情页至申购页转化提升 16%。',
  },
  {
    id: 'resume_youdao_strategy_ops',
    title: '网易有道战略运营实习',
    tags: ['operation', 'data', 'quality'],
    proof: '我在网易有道完成 20 份业务报告并沉淀 4 类用户画像，随后优化质检流程，将单次质检耗时从 30 分钟缩短至 10 分钟。',
  },
  {
    id: 'resume_xiaohe_content_ops',
    title: '字节跳动小荷产品运营实习',
    tags: ['content', 'operation', 'research'],
    proof: '我在字节跳动小荷通过 1 对 1 访谈沉淀 4 类用户需求并调整内容策略，使单篇内容停留时长提升 30%、完读率提升 77%。',
  },
  {
    id: 'resume_asteria_ai_product',
    title: 'Asteria Analyst AI 产品项目',
    tags: ['ai', 'product', 'data', 'quality'],
    proof: '我在 Asteria Analyst 设计“数据接入—分析—证据校验—报告交付”流程，并用 Schema、AI Trace 与质量门控制 AI 输出的可追溯性和错误风险。',
  },
  {
    id: 'resume_xhs_ai_workbench',
    title: '小红书招聘信息 AI 工作台',
    tags: ['ai', 'content', 'operation', 'quality'],
    proof: '我在小红书招聘信息 AI 工作台将采集、正文补全、结构化、AI 生成、质量复核和人工审核串成 8 步闭环，完成 34 个界面模块和 14 个服务模块。',
  },
  {
    id: 'resume_hegel_ai_platform',
    title: 'Hegel Salon AI 阅读与研究平台',
    tags: ['ai', 'product', 'research'],
    proof: '我在 Hegel Salon 从 0 到 1完成多用户 Web 产品、证据校验与多环境部署，建立了可追溯的 AI 研究工作流。',
  },
]);

const responsibilityOverrides = Object.freeze({
  '6a703a9f000000002500ee25': [
    '负责视频号全流程运营，包括内容策划、发布与数据复盘',
    '完成短视频后期制作，并使用 PR、剪映及 AI 视频工具进行生成与剪辑',
    '完成海报、封面和物料等平面设计',
    '协助直播推流、场控与基础调试',
  ],
  '6a68660b0000000011016e23': [
    '参与 AI 产品真实业务，与研发协作，将方案从问题发现、设计和验证推进到上线',
  ],
  '6a701a9e000000002702016c': [
    '参与品牌形象升级',
    '参与海内外运营与社媒视觉设计',
    '参与线下周边设计和部分产品视觉设计',
  ],
  '6a6c1ae60000000006007b17': [
    '参与核心项目，在导师指导下完成数据建模与数据分析相关实操',
  ],
});

const responsibilityNoise = /(?:投递|简历|邮箱|邮件|联系方式|欢迎私信|继任|急招|招聘中|岗位描述|任职要求|工作地点|薪资|待遇|到岗|每周|实习期)/iu;

function cleanText(value) {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\u00a0]+/gu, ' ')
    .replace(/[ ]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function noteIdOf(record) {
  return String(record?.note_id ?? record?.noteId ?? '');
}

function companyOf(record) {
  return cleanText(
    record?.application_info?.company
    ?? record?.job_card?.company
    ?? record?.company
    ?? '',
  ).slice(0, 80);
}

function sourceUrlOf(record) {
  return cleanText(record?.note_url ?? record?.job_card?.source_url ?? '');
}

function listItems(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item?.text ?? item?.evidence ?? item))
    .filter(Boolean);
}

function usefulResponsibilities(record) {
  const seen = new Set();
  const structured = listItems(record?.application_info?.responsibilities);
  const source = structured.length ? structured : (responsibilityOverrides[noteIdOf(record)] ?? []);
  return source
    .filter((item) => item.length >= 8 && item.length <= 180)
    .filter((item) => !responsibilityNoise.test(item))
    .filter((item) => {
      const key = item.replace(/\s+/gu, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function usefulRequirements(record) {
  return listItems(record?.application_info?.requirements)
    .filter((item) => item.length >= 6 && item.length <= 180)
    .filter((item) => !/(?:邮箱|简历|投递|联系方式)/u.test(item));
}

function occurrenceScore(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return (text.match(new RegExp(escaped, 'giu')) ?? []).length;
}

function workCategory(role, responsibilities, requirements) {
  const text = cleanText([role, ...responsibilities, ...requirements].join('\n'));
  if (/(?:AI|人工智能|大模型|模型|Agent|智能体|Prompt|算法|机器学习|AIGC)/iu.test(text)) return 'ai';
  if (/(?:用户研究|用研|访谈|体验研究|可用性|洞察)/iu.test(text)) return 'research';
  if (/(?:内容|短视频|图文|社区|创作者|新媒体|直播|社媒)/iu.test(text)) return 'content';
  if (/(?:增长|市场|品牌|营销|转化|拉新)/iu.test(text)) return 'growth';
  if (/(?:数据|分析|指标|商业分析|BI|策略|咨询)/iu.test(text)) return 'data';
  if (/(?:产品|需求|PRD|POC|功能|交互|体验|项目管理)/iu.test(text)) return 'product';
  if (/(?:运营|流程|活动|客户成功|商务)/iu.test(text)) return 'operation';
  return 'product';
}

function categoryFallbacks(category) {
  const fallbacks = {
    ai: ['ai', 'quality', 'product'],
    research: ['research', 'product', 'data'],
    content: ['content', 'operation', 'research'],
    growth: ['growth', 'research', 'operation'],
    data: ['data', 'product', 'quality'],
    product: ['product', 'research', 'data'],
    operation: ['operation', 'quality', 'research'],
  };
  return fallbacks[category] ?? fallbacks.product;
}

function evidenceById(id) {
  return evidenceProfiles.find((item) => item.id === id);
}

function dutyEvidencePreferences(duty, category) {
  const text = cleanText(duty);
  if (/(?:模型|算法|API|接口|Prompt|大模型|AI 输出|智能)/iu.test(text)) {
    return ['resume_asteria_ai_product', 'resume_xhs_ai_workbench', 'resume_hegel_ai_platform'];
  }
  if (/(?:用户反馈|用户洞察|访谈|需求挖掘|问题排查|体验)/iu.test(text)) {
    return ['resume_perfect_world_product', 'resume_foundation_growth_pm', 'resume_xiaohe_content_ops'];
  }
  if (/(?:内容|选题|创作者|图文|短视频|社媒|直播)/iu.test(text)) {
    return ['resume_xiaohe_content_ops', 'resume_xhs_ai_workbench', 'resume_youdao_strategy_ops'];
  }
  if (/(?:POC|PRD|上线|产品设计|功能|项目管理|迭代)/iu.test(text)) {
    return ['resume_perfect_world_product', 'resume_tiger_brokers_product', 'resume_asteria_ai_product'];
  }
  if (/(?:数据|指标|分析|评测|质量|复盘|报告)/iu.test(text)) {
    return ['resume_tiger_brokers_product', 'resume_asteria_ai_product', 'resume_youdao_strategy_ops'];
  }
  if (/(?:增长|转化|拉新|市场|品牌)/iu.test(text)) {
    return ['resume_foundation_growth_pm', 'resume_tiger_brokers_product', 'resume_xiaohe_content_ops'];
  }
  return categoryFallbacks(category).flatMap((tag) => evidenceProfiles
    .filter((profile) => profile.tags.includes(tag))
    .map((profile) => profile.id));
}

function selectEvidence(record, role, responsibilities, requirements) {
  const haystack = cleanText([
    role,
    record?.title,
    ...responsibilities,
    ...requirements,
  ].join('\n')).toLowerCase();
  const category = workCategory(role, responsibilities, requirements);
  const preferredTags = categoryFallbacks(category);
  const scored = evidenceProfiles.map((card, index) => {
    const keywordScore = evidenceCards.find((item) => item.id === card.id)?.keywords
      .reduce((total, keyword) => total + occurrenceScore(haystack, keyword), 0) ?? 0;
    const tagScore = card.tags.reduce((total, tag, tagIndex) => (
      total + (preferredTags.indexOf(tag) === -1 ? 0 : 20 - tagIndex)
    ), 0);
    return { ...card, score: keywordScore + tagScore, index };
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = [];
  for (const duty of responsibilities.slice(0, 2)) {
    const preferred = dutyEvidencePreferences(duty, category)
      .map(evidenceById)
      .find((profile) => profile && !selected.some((item) => item.id === profile.id));
    selected.push(preferred ?? scored.find((item) => !selected.some((entry) => entry.id === item.id)) ?? scored[0]);
  }
  while (selected.length < 2) {
    selected.push(scored.find((item) => !selected.some((entry) => entry.id === item.id)) ?? scored[0]);
  }
  return selected.map(({ index: _index, ...item }) => item);
}

function shortQuote(value, maxLength = 72) {
  const text = cleanText(value).replace(/[。；;]+$/u, '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function dutyLabel(duty) {
  const text = cleanText(duty);
  if (/(?:AI转型|智能化|转型工具)/iu.test(text)) return 'AI 转型工具搭建';
  if (/(?:模型|算法|文本|视觉|语音).*(?:评估|评测|性能|质量|用例|迭代)/iu.test(text)) return '基于真实用例的模型效果评估与迭代';
  if (/(?:用户反馈|用户洞察|需求挖掘|技术咨询|问题排查)/iu.test(text)) return '从用户反馈中发现并验证需求';
  if (/(?:API|接口).*(?:调用|评测|性能)/iu.test(text)) return '接口调用、效果评测和性能测试';
  if (/(?:独立).*(?:产品|own).*(?:上线|跟进)|(?:产品设计).*(?:上线)/iu.test(text)) return '从产品设计到上线的全流程跟进';
  if (/(?:POC|PRD|方案设计)/iu.test(text)) return 'POC 方案设计和 PRD 输出';
  if (/(?:内容|短视频|图文).*(?:策划|发布|复盘|运营)/iu.test(text)) return '内容策划、发布和数据复盘';
  if (/(?:数据|指标|报告).*(?:分析|建模|复盘)/iu.test(text)) return '数据分析与结果复盘';
  return shortQuote(text.replace(/^[^：:]{2,18}[：:]/u, ''), 32);
}

function roleSummary(responsibilities) {
  const labels = responsibilities.slice(0, 2).map(dutyLabel);
  if (labels.includes('AI 转型工具搭建') && labels.includes('基于真实用例的模型效果评估与迭代')) {
    return { labels, text: '岗位同时强调 AI 转型工具搭建与真实用例评估，核心是把评测结论回流为可推进的产品迭代。' };
  }
  if (labels.includes('从用户反馈中发现并验证需求') && labels.includes('基于真实用例的模型效果评估与迭代')) {
    return { labels, text: '岗位需要从开发者反馈中定位真实问题，再通过接口调用和测试验证模型效果，形成“问题发现—验证—迭代”的闭环。' };
  }
  if (labels.includes('从产品设计到上线的全流程跟进') && labels.includes('POC 方案设计和 PRD 输出')) {
    return { labels, text: '岗位需要把需求判断落实为 POC、PRD 和上线后的验证动作，而非只停留在方案表达。' };
  }
  if (labels.length === 2) return { labels, text: `岗位当前最关键的两项工作是${labels[0]}和${labels[1]}，两者都需要结合真实用户与数据结果持续复盘。` };
  if (labels.length === 1) return { labels, text: `岗位当前最关键的工作是${labels[0]}，我已用最贴近的项目经历说明对应能力。` };
  return { labels, text: '岗位职责明细尚未完整，正文需要在补全职责后再进入发送。' };
}

function dutyEvidenceSentence(label, evidence, index) {
  const prefix = index === 0 ? '在' : '此外，在';
  return `${prefix}${label}方面，${evidence.proof}`;
}

function hasWeeklyScheduleRequirement(requirements) {
  const text = requirements.join('\n');
  return /(?:每周|一周|周).{0,16}(?:[4-7](?:天|日)|四天|五天|六天|七天)/u.test(text);
}

function auditBodyQuality({ role, responsibilityLabels, evidence, body, blockers }) {
  const fillerPattern = /如果有机会加入|先对齐业务目标|形成可执行、可复盘|端到端流程/u;
  const responsibilityMappingCount = responsibilityLabels.filter((label) => body.includes(label)).length;
  const wordCount = body.replace(/\s/gu, '').length;
  const passed = Boolean(role)
    && responsibilityLabels.length > 0
    && evidence.length >= 2
    && responsibilityMappingCount >= responsibilityLabels.length
    && wordCount >= 260
    && wordCount <= 720
    && !fillerPattern.test(body)
    && blockers.length === 0;
  return {
    version: 'responsibility_evidence_email_v2',
    wordCount,
    evidenceCount: evidence.length,
    responsibilityMappingCount,
    fillerDetected: fillerPattern.test(body),
    status: passed ? 'passed' : 'needs_review',
  };
}

function tailoredDraft(record) {
  const role = applicationRoleTitle(record, {}) || '';
  const company = companyOf(record);
  const responsibilities = usefulResponsibilities(record);
  const requirements = usefulRequirements(record);
  const evidence = selectEvidence(record, role, responsibilities, requirements);
  const dutyQuotes = responsibilities.slice(0, 2);
  const roleLabel = role || '该岗位';
  const companyLabel = company || '贵团队';
  const candidateValues = {
    ...candidate,
    company,
    jobTitle: role,
  };
  const subjectResolution = resolveApplicationEmailSubject(record, '', candidateValues);
  const attachmentRule = buildApplicationAttachmentRule(record, {
    ...candidateValues,
    originalName: path.basename(packagedResumePath),
  });
  const dutySummary = roleSummary(dutyQuotes);
  const body = [
    '尊敬的招聘负责人：',
    '',
    `您好！我是王梓楠，曼彻斯特大学全球发展硕士在读（研一），申请${companyLabel}的「${roleLabel}」。我可随时到岗，并连续实习六个月。`,
    '',
    dutySummary.text,
    '',
    dutySummary.labels[0]
      ? dutyEvidenceSentence(dutySummary.labels[0], evidence[0], 0)
      : '由于岗位职责尚未补全，我暂不将该邮件标记为可发送。',
    '',
    dutySummary.labels[1]
      ? dutyEvidenceSentence(dutySummary.labels[1], evidence[1], 1)
      : '我的相关经历包括用户研究、需求梳理、数据复盘与产品迭代，可在沟通中进一步展开。',
    '',
    '随信附上按岗位要求命名的简历。我的经历与上述职责的对应细节均可在面试中进一步说明，期待与您沟通。',
    '',
    '此致',
    '敬礼！',
    '王梓楠',
    '电话：13811817014',
    '邮箱：zinan.wang-3@student.manchester.ac.uk',
  ].join('\n');
  const coverLetter = [
    `求职信｜${roleLabel}`,
    '',
    body,
  ].join('\n');
  const blockers = [];
  if (!role) blockers.push('role_title_missing');
  if (!responsibilities.length) blockers.push('responsibility_missing');
  if (subjectResolution.missingFields.length) {
    blockers.push(`subject_fields_missing:${subjectResolution.missingFields.join(',')}`);
  }
  if (attachmentRule.status !== 'ready') {
    blockers.push(`attachment_${attachmentRule.status}:${attachmentRule.missingFields.join(',')}`);
  }
  if (hasWeeklyScheduleRequirement(requirements) && !candidate.availabilityDays) {
    blockers.push('weekly_schedule_confirmation_required');
  }
  const contentQuality = auditBodyQuality({
    role,
    responsibilityLabels: dutySummary.labels,
    evidence,
    body,
    blockers,
  });
  if (contentQuality.status !== 'passed') blockers.push('email_body_quality_review_required');
  return {
    noteId: noteIdOf(record),
    role,
    company,
    sourceTitle: cleanText(record?.title),
    sourceUrl: sourceUrlOf(record),
    responsibilities,
    requirements,
    responsibilityQuotes: dutyQuotes,
    subject: subjectResolution.subject,
    subjectRule: subjectResolution.rule,
    subjectGuard: subjectResolution.subjectGuard,
    subjectMissingFields: subjectResolution.missingFields,
    emailBody: body,
    coverLetter,
    evidence: evidence.map(({ id, title, proof, score }) => ({ id, title, proof, score })),
    attachment: {
      sourcePath: packagedResumePath,
      displayName: attachmentRule.displayName,
      status: attachmentRule.status,
      detectedRule: attachmentRule.detected,
      template: attachmentRule.template,
      evidence: attachmentRule.evidence,
      missingFields: attachmentRule.missingFields,
      mediaType: 'application/pdf',
    },
    candidateAvailability: '研一-随时到岗-可实习六个月',
    generationMode: 'deterministic_responsibility_evidence_email_v2',
    contentQuality,
    blockers,
    status: blockers.length ? 'needs_review' : 'ready_for_recipient_review',
  };
}

async function sha256(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

async function main() {
  const [payload, resumeStats, resumeHash] = await Promise.all([
    fs.readFile(sourcePath, 'utf8').then(JSON.parse),
    fs.stat(resumeSourcePath),
    sha256(resumeSourcePath),
  ]);
  const records = Array.isArray(payload.records)
    ? payload.records
    : Object.values(payload.records ?? payload);
  await fs.mkdir(path.dirname(packagedResumePath), { recursive: true });
  let existingHash = '';
  try {
    existingHash = await sha256(packagedResumePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existingHash !== resumeHash) {
    const temporaryResumePath = `${packagedResumePath}.${process.pid}.tmp`;
    await fs.copyFile(resumeSourcePath, temporaryResumePath);
    await fs.rename(temporaryResumePath, packagedResumePath);
  }
  const packagedHash = await sha256(packagedResumePath);
  if (packagedHash !== resumeHash) throw new Error('Packaged resume hash mismatch.');

  const tailored = Object.fromEntries(records.map((record) => {
    const result = tailoredDraft(record);
    result.attachment.sha256 = packagedHash;
    result.attachment.sizeBytes = resumeStats.size;
    return [result.noteId, result];
  }));
  const values = Object.values(tailored);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    jobId,
    outputId,
    candidate,
    availability: '研一-随时到岗-可实习六个月',
    resumeAttachment: {
      originalPath: resumeSourcePath,
      packagedPath: packagedResumePath,
      sha256: packagedHash,
      sizeBytes: resumeStats.size,
      mediaType: 'application/pdf',
    },
    counts: {
      total: values.length,
      readyForRecipientReview: values.filter((item) => item.status === 'ready_for_recipient_review').length,
      needsReview: values.filter((item) => item.status === 'needs_review').length,
      cleanRole: values.filter((item) => item.role).length,
      withResponsibilities: values.filter((item) => item.responsibilities.length).length,
      subjectReady: values.filter((item) => item.subject && item.subjectMissingFields.length === 0).length,
      attachmentReady: values.filter((item) => item.attachment.status === 'ready').length,
    },
    evidenceCatalog: evidenceCards,
    records: tailored,
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(tailoredPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ tailoredPath, packagedResumePath, resumeHash: packagedHash, counts: result.counts }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

export { candidate, evidenceCards, tailoredDraft };
