# 批量投递工作台 V2 全量升级方案

## 1. 目标与边界

把当前的“逐条确认后再冻结”的批量投递页，升级为一个可筛选、可核对、可追溯的投递工作台。用户在同一张表中应能确认：

1. 这条岗位是否应该被纳入本批。
2. 邮件会发送到哪个邮箱，以及该邮箱来自哪里。
3. 邮件标题、邮件正文、Cover Letter 正文和附件最终会是什么。
4. 岗位原文中的标题/附件命名要求是否已满足。
5. Dry Run 是否只是预演，冻结和发送时是否仍使用同一份投递清单。

本次不改变现有“人工触发发送、单岗位单收件人、幂等发送、附件哈希校验”的原则；不把批量工作台变成自动群发功能。

## 2. 当前问题与保留能力

### 已存在、应复用的能力

- `application-contact-resolver` 已解析岗位正文和评论中的邮箱，并保存来源与证据。
- `application-email-draft` 已提取岗位中的邮件标题规则并生成实际标题。
- `application-attachment-rule` 已生成附件命名规则、检测缺字段和重名。
- 批次发送链路已把收件人、预览版本、附件 bundle hash 与幂等键绑定，发送只使用该岗位已允许的收件人。

### 必须修复的摩擦点

1. 页面只有全文搜索，没有投递状态、邮箱、文案、标题规则、附件规则等组合筛选；“只选就绪”也缺少可解释的条件。
2. 当前表格中的“查看正文”是岗位原文，不是 `outreach.cover_letter`；冻结后的 payload 只保存邮件正文，无法复核 Cover Letter。
3. Dry Run 能计算新附件名，但凡需要改名就返回 `filename_pending`。前端会丢掉这些选择项，用户必须重新操作，预演无法代表最终投递结果。
4. 标题规则、附件规则、实际渲染值、规则来源和缺失字段没有作为同一份投递契约展示。
5. 服务端已经返回 `copy_quality_failed`，前端状态类型和标签还未覆盖它，筛选与统计前必须先补齐。

## 3. 目标工作流

```text
筛选候选岗位
  -> 表格中核对收件人 / 标题 / 附件 / 邮件正文 / Cover Letter
  -> 选择最多 N 条并执行 Dry Run
  -> 查看“原名 -> 计划发送名”和完整投递清单
  -> 一次确认冻结投递清单
  -> 冻结时事务性应用附件显示名并重新校验清单哈希
  -> 人工发送
  -> 保存 SMTP 回执、最终收件人、标题、正文和附件快照
```

Dry Run 必须是只读预演；冻结只写入不可变发送 bundle 与批次快照，不改动源附件元数据。发送只能使用冻结后的快照。

## 4. 信息架构与交互设计

### 4.1 顶部筛选区

保留全文搜索，但改为可组合筛选。筛选在服务端生效，并在 URL query 或本地持久化中保留，刷新页面后不丢失。

| 筛选维度 | 选项 |
| --- | --- |
| 投递状态 | 全部、可预演、待人工确认、已冻结、已发送、发送失败、已跳过 |
| 收件邮箱 | 已确定、多个候选、无邮箱、人工确认、正文、评论、OCR、手工录入 |
| 文案质量 | 合格、缺邮件正文、缺 Cover Letter、质量未通过、待生成 |
| 标题规则 | 有岗位要求且满足、有要求待补字段、无岗位要求、人工覆写 |
| 附件规则 | 无需改名、计划改名、缺命名字段、重名/不合法、已冻结 |
| 内容 | 有邮件正文、有 Cover Letter、正文长度区间、包含关键词 |
| 批次与时间 | 当前 Dry Run、当前冻结批次、未投递、已投递、岗位发布时间 |

默认保存三个常用视图：`可投递`、`待我处理`、`已发送`。筛选结果应同时显示总数、可投递数、阻塞原因分布，避免“当前页 20 项”被误认为全部结果。

### 4.2 选择行为

- 选择使用稳定的 `noteId` 集合，不因翻页、排序或筛选刷新丢失。
- Dry Run 时保存 `SelectionSnapshot`（筛选条件、候选 `noteId`、每条记录 revision、snapshot hash）；冻结时校验快照，防止翻页或刷新后集合漂移。
- 提供“选择当前页”“选择前 N 条可投递”和“仅保留可投递已选项”；N 受服务端批次上限约束。
- “全选筛选结果”不能悄悄选中超过上限的记录；应明确显示命中的总数和本次将加入的前 N 条，并可调整排序。
- 筛选变更后保留已选条目，显示其中不再匹配或已失效的数量，并支持一键清理。

### 4.3 表格列

桌面端默认列如下；移动端使用同一数据但改为可展开行，不隐藏关键结论。

| 列 | 展示内容 |
| --- | --- |
| 岗位 | 标题、公司/作者、岗位原文入口、优先级 |
| 收件人 | 最终邮箱、标准化前后值、来源、证据摘要、置信状态 |
| 投递内容 | 邮件正文摘要和 **Cover Letter 正文前 5 行**、字符数、行内“展开全文” |
| 邮件标题 | 实际发送标题、岗位要求原文、规则来源、字段缺失/覆写状态 |
| 附件 | 原文件名 -> 计划发送名/冻结后发送名、规则原文、扩展名、哈希短码 |
| 预检状态 | 可投递、需确认、被阻塞，以及明确原因 |
| 操作 | 选择、查看完整投递清单、单条修订、移出批次 |

“投递内容”必须是独立列，不使用岗位原文替代 Cover Letter。默认限制高度防止表格失控；点击“展开全文”在当前行下方展开完整邮件正文与完整 Cover Letter，并提供复制按钮和版本/哈希。冻结批次详情也必须展示同一份 Cover Letter 快照。

### 4.4 批量设置与逐行覆写

将现有“默认附件命名模板 + 发送间隔”扩展为：

- 批次默认标题模板，仅在岗位没有明确标题要求时使用。
- 批次默认附件模板，仅在岗位没有明确附件命名要求时使用。
- 候选人姓名、岗位名称、公司、日期等命名字段预览与缺失提示。
- 单行覆写入口；覆写必须显示“岗位要求 / 默认值 / 实际发送值”，不能静默覆盖岗位要求。
- 标题与附件都显示规则优先级：岗位明确要求 > 明确人工覆写 > 批次默认 > 原文件名保底。

岗位明确要求不允许被默认模板覆盖；人工覆写需要可见理由和确认标记。附件扩展名必须继承原附件，生成后要同时通过文件名、重复名和 MIME 校验。

## 5. 投递契约（Delivery Manifest）

新增服务端统一对象 `DeliveryManifest`。它是 Dry Run、冻结、发送和审计的唯一共同数据模型，避免 UI 分别拼收件人、标题、附件和正文。

```ts
type DeliveryManifest = {
  schemaVersion: 2;
  noteId: string;
  sourceSnapshotHash: string;
  recipient: {
    address: string;
    normalizedAddress: string;
    recipientHash: string;
    source: 'body' | 'comment' | 'ocr' | 'manual';
    evidenceHash: string;
    verification: 'resolved' | 'manual_confirmed';
  };
  subject: {
    requirementText?: string;
    ruleSource: 'job_requirement' | 'manual_override' | 'batch_default';
    rendered: string;
    missingFields: string[];
    hash: string;
  };
  content: {
    emailBody: string;
    emailBodyHash: string;
    coverLetter: string;
    coverLetterHash: string;
    draftId: string;
    draftVersion: number;
    quality: Record<string, boolean | number | string>;
  };
  attachments: Array<{
    attachmentId: string;
    originalName: string;
    plannedSendName: string;
    appliedSendName?: string;
    namingRequirement?: string;
    ruleSource: 'job_requirement' | 'manual_override' | 'batch_default';
    sha256: string;
    mimeType: string;
  }>;
  manifestHash: string;
  readiness: 'ready_to_freeze' | 'needs_input' | 'blocked' | 'stale';
  blockers: Array<{ code: string; field: string; message: string }>;
  warnings: Array<{ code: string; field: string; message: string }>;
};
```

`ApplicationBatchPayload` 需要保存 `coverLetter`、`coverLetterHash`、完整的标题/附件规则来源、`recipientHash`、`evidenceHash`、`manifestHash` 和 `sourceSnapshotHash`。历史批次保持旧 schema 可读，不能被新版本自动改写。

## 6. Dry Run、冻结与发送状态机

### 6.1 Dry Run

`POST /application-batches/dry-run` 只生成 `DeliveryManifest`，不得调用 `renameAttachment`，不得修改 `displayName`、审批、批次或发送状态。

- 附件改名项不再返回阻塞性的 `filename_pending`；应返回 `ready_to_freeze + warning: WILL_RENAME`。
- 预览邮件要接收虚拟附件清单，使用 `plannedSendName` 生成 MIME/预览，而不是要求先改存储中的附件名。
- 结果清楚显示 `原名 -> 计划发送名`、最终收件人、完整邮件标题、邮件正文和 Cover Letter。
- Dry Run 返回 `preflightId`、过期时间和 `manifestHash`；前端保留当前选择集，不因“会改名”而清空。

### 6.2 冻结

`POST /application-batches` 接收 `preflightId + manifestHash + confirmedNoteIds`，而不是重新根据前端零散字段推导一遍。

1. 服务端读取未过期的预演清单。
2. 重新比对岗位快照、邮箱证据、草稿版本、正文哈希和附件哈希。
3. 任一不一致时返回 `stale`，指出变动字段，要求重新 Dry Run。
4. 对仍一致的条目把 `plannedSendName` 写入不可变 payload 和发送 bundle；源附件仍保留 `originalName`，不做批量改名。
5. 用冻结后的 bundle 清单重建预览并校验 `manifestHash`，再把批次标记为 `frozen`。

### 6.3 发送

发送只接受冻结 payload：

- SMTP envelope 的唯一 `RCPT TO` 必须等于 `payload.recipient.normalizedAddress`。
- 直接 preview/send 也必须显式传入 `to`、`evidenceHash` 和 source record revision；缺少 `to` 时拒绝请求，取消“取第一个邮箱”的回退。
- 发送前再次检查 `recipientHash`、`evidenceHash`、预览修订、草稿版本、正文哈希、附件 SHA 和 `manifestHash`。
- 不允许客户端提供临时收件人、标题或附件名覆盖冻结结果。
- SMTP 拒收、超时和未知结果分别记录；未知结果不自动重投，避免重复投递。
- 审计记录保存最终收件人、标题、附件发送名、Cover Letter 哈希和 provider message id。

## 7. 接口与数据改造

### 7.1 候选列表

扩展结果列表接口的 query 参数或增加投递候选接口：

```text
GET /api/jobs/:jobId/application-delivery-candidates
  ?q=&deliveryStatus=&recipientStatus=&recipientSource=
  &copyStatus=&subjectRuleStatus=&attachmentStatus=
  &hasCoverLetter=&batchId=&sort=&cursor=
```

返回服务端计算的 facet counts、分页 cursor、轻量 `DeliveryManifestSummary`。不要仅在当前 20 条数据上前端过滤，否则统计、跨页选择和“选择前 N 条”会失真。

Dry Run 请求同时提交 `selectionSnapshotId`；服务端返回快照中的候选集合和 `selectionSnapshotHash`，冻结时必须逐项比对岗位记录 revision。

### 7.2 Dry Run 与批次

- Dry Run 响应替换为 `items: DeliveryManifest[]`，同时保留旧响应适配层到历史调用迁移完成。
- 冻结接口接收 `preflightId` 与 `manifestHash`，写入 V2 payload。
- 批次详情接口返回冻结的 Cover Letter 和字段哈希，前端不能从当前岗位草稿回填历史批次内容。
- 增加 `copy_quality_failed` 到前端 union、状态映射、筛选枚举和统计中。

### 7.3 复用模块的职责

| 模块 | V2 职责 |
| --- | --- |
| `application-contact-resolver` | 产出标准化邮箱、来源、证据和 `evidenceHash` |
| `application-email-draft` | 产出标题规则、渲染标题、字段缺失和规则来源 |
| `application-attachment-rule` | 产出虚拟发送名、冲突、字段缺失和扩展名校验 |
| `application-batch-service` | 组合 Manifest，驱动 Dry Run/冻结/回滚状态机 |
| `BatchApplicationPanel` | 显示、筛选、选择和确认 Manifest，不自行推导发送值 |

## 8. 实施顺序

### P0：契约与兼容层

1. 增加 V2 类型、`DeliveryManifest`、状态枚举和序列化版本。
2. 把 Cover Letter 及其哈希写入 payload 和批次详情。
3. 补齐 `copy_quality_failed` 类型/标签/测试。
4. 用 fixture 覆盖历史 V1 批次读取，确保旧批次仍可查看和审计。

### P1：Dry Run 与冻结重构

1. 将附件改名变为虚拟命名计划；Dry Run 零写入。
2. 引入 `preflightId`、`manifestHash`、失效检测和事务性冻结。
3. 让邮件预览和 MIME 发送 bundle 支持指定虚拟发送名，并将预览/发送绑定同一清单。
4. 把“命名将变更”从阻塞项改为可确认 warning。

### P2：筛选与表格

1. 服务端实现结构化筛选、排序、facet counts 和稳定分页。
2. 前端增加筛选 chips、展开筛选、保存视图和跨页选择。
3. 增加“投递内容”列，行内展示 Cover Letter 摘要/全文；冻结详情展示快照。
4. 增加标题/附件规则、实际值、来源、缺失字段和逐行覆写界面。

### P3：发送前核对与审计

1. 增加“发送前清单”视图：每行列出收件人、标题、正文、Cover Letter、原名->发送名及阻塞项。
2. 在发送 API 与 SMTP adapter 增加 manifest、收件人和附件一致性复核。
3. 保存 provider 回执与最终不可变审计字段。

### P4：迁移与上线

1. 旧草稿缺 Cover Letter 时标为“待补内容”，不伪造内容。
2. 旧批次保留 V1 阅读路径；新建批次一律使用 V2。
3. 先以 Dry Run only 灰度，核对预览与实际 MIME 结果一致后再开放发送。
4. 对已有附件先只生成计划命名，冻结后写入发送 bundle；迁移不批量重命名历史附件。

## 9. 验收与测试矩阵

### 单元与集成测试

- 标题规则优先级、缺字段、人工覆写、字符/编码边界。
- 附件命名中的中文、空格、重复名、扩展名保留、规则冲突和回滚。
- Dry Run 前后附件元数据完全不变；预演能显示计划发送名。
- 冻结时岗位正文、邮箱证据、草稿、附件任一变动均得到 `stale`，不可发送。
- `copy_quality_failed` 可被正确筛选、显示和阻断。
- 批次 payload 包含 Cover Letter 原文与哈希；历史 V1 payload 可读取。
- 收件人不在岗位允许集合、收件人哈希不符、附件 hash 不符时发送 API 必须拒绝。

### 端到端测试

- 可组合筛选、跨页选择、筛选后统计和“选择前 N 条”一致。
- 表格和移动端都能看到 Cover Letter 摘要，并在行内展开全文。
- Dry Run 一次展示同一条目的收件人、标题、邮件正文、Cover Letter、原名->计划发送名。
- 确认冻结后仍使用同一标题、同一收件人、同一附件名；发生变动时要求重新 Dry Run。
- SMTP/Mailpit 集成测试校验 envelope recipient、Subject、MIME 附件文件名和实际邮件正文。

### 上线验收标准

1. 任一“可发送”条目可在表格内直接看见最终收件人、最终标题、完整 Cover Letter 和最终附件名。
2. Dry Run 不产生写入，且包含所有将发送的值；改名条目不会被无故踢出选择集。
3. 冻结与发送不允许使用与 Dry Run 不一致的收件人、正文、标题或附件。
4. 所有筛选均服务端生效，统计和批次上限在跨页时一致。
5. 批次详情可追溯到实际发出的收件人、标题、邮件正文、Cover Letter、附件名和哈希。

## 10. 建议的交付切分

第一交付只上线 P0 + P1，使用户立即得到“可读的完整 Dry Run、原名到发送名预览、一次确认冻结”，先消除重复操作和名称不一致。第二交付上线 P2，让 119 条候选岗位可以按状态和风险快速收敛。第三交付上线 P3 + P4，完成发送前核对、历史兼容和审计闭环。
