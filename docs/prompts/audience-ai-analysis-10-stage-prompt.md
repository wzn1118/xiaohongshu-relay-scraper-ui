# 逐帖受众 AI 深度分析：十阶段完整实施 Prompt

你现在负责为以下仓库实施一个独立但挂载在原任务内的新功能：

https://github.com/wzn1118/xiaohongshu-relay-scraper-ui

功能名称：

逐帖受众 AI 深度分析（Per-post Audience AI Analysis）

以当前工作分支最新代码为准。必须直接检查、修改、运行和验证真实代码，不得只输出需求分析、建议、伪代码、演示页面或局部补丁。

本功能用于对每一篇已经采集的原帖，结合原帖完整内容，对该帖下的评论、回复、评论用户以及用户公开主页资料进行 AI 分析。

本次任务必须按本文规定的 10 个阶段依次执行。每一阶段完成后都必须运行该阶段专项测试和既有非回归测试；阶段未通过不得进入下一阶段。

本功能必须属于当前原任务，不得创建新的顶层 Job、历史任务卡或无关搜索任务。

# 一、核心产品定义

当前“受众及用户界面”已经能够展示：

1. 当前任务内容洞察中已经采集的原帖；
2. 每篇原帖下已经采集的顶层评论；
3. 每条顶层评论下已经采集的回复；
4. 发表评论和回复的公开用户；
5. 已采集或部分采集的公开主页头部资料；
6. 原帖、评论、回复、用户和主页的采集覆盖状态。

现在需要在这个既有数据基础上增加逐帖 AI 分析能力。

产品语义必须严格定义为：

* 用户针对某一篇原帖启动一次 AI 分析；
* 原帖完整内容始终是分析上下文；
* 评论和回复是主要分析对象；
* 评论用户是主要分析对象；
* 用户公开主页资料是显式可选分析范围；
* 可选主页分析默认只使用已经存在的数据；
* 需要网络补采时必须由用户明确选择；
* 补采仍在原 jobId 内执行；
* AI 分析结果按原帖、输入版本和分析版本独立保存；
* 用户能够查看总体结论，也能查看逐评论和逐用户结果；
* 每一项结论都必须回到真实原帖、评论、用户或主页字段证据；
* AI 运行期间，原始评论流、用户卡和上一版 AI 结果必须保持可见。

功能入口必须是每篇原帖的独立 AI 分析按钮。

不得把整个受众任务混成一个无法定位来源的全局分析。

不得要求用户先创建新任务。

不得重新打开关键词搜索并采集一批新帖子。

不得把“主页头部资料完整”与“主页近期帖子已经采集”混为一谈。

# 二、最高优先级约束

以下约束高于所有实现便利和重构建议。

## 2.1 原任务原地执行

必须保证：

* AI 分析绑定当前 `jobId`；
* 主页补采绑定当前 `jobId`；
* 不调用通用创建任务接口；
* 不增加历史任务列表数量；
* 不生成新的顶层 Job；
* 不改变当前任务的原始创建时间和任务身份；
* 不覆盖当前任务已经完成的内容洞察；
* 不复制原任务数据到伪装成新任务的目录；
* 不通过新任务绕过当前检查点和状态体系。

允许新增的只能是当前任务内的 AI 子运行：

`jobId + postId + analysisRunId`

`analysisRunId` 是当前任务内部的分析版本，不是新 Job。

## 2.2 原始数据持续可见

启动分析、补采、取消、重试、恢复、失败或刷新时：

* 已加载原帖不得消失；
* 已加载评论不得被清空；
* 已加载用户卡不得被清空；
* 已有主页资料不得被清空；
* 已完成的上一版 AI 结果不得被新运行覆盖；
* 当前筛选、分页和滚动位置不得无故重置；
* 切换评论流、用户卡和 AI 结果不得重新创建任务；
* SSE 重连不得把结果暂时重置为 0；
* 后端暂时不可用时应保留最后一次成功快照。

## 2.3 默认不触发网络采集

用户点击“AI 分析”后的默认行为必须是：

* 使用当前任务已经持久化的原帖；
* 使用当前任务已经持久化的评论和回复；
* 使用当前任务已经持久化的评论用户；
* 根据主页选项决定是否使用已有主页字段；
* 不启动 Relay；
* 不打开浏览器页面；
* 不执行关键词搜索；
* 不采集无关帖子；
* 不自动补采缺失主页。

只有用户明确选择“在原任务内补采后分析”时才允许启动补采。

## 2.4 零既有功能回归

必须完整保留当前仓库已经实现的：

* 内容洞察；
* 受众及用户界面；
* 关系扩散；
* 原任务继续采集；
* 评论和用户补采；
* 安全验证等待与恢复；
* Relay 连接；
* AI Provider 配置；
* AI Session；
* 模型发现和选择；
* 正文补全；
* 现有内容分析；
* SSE；
* 日志；
* Artifact；
* 历史任务；
* 旧 Job 和旧检查点读取；
* Windows 与 Linux 启动方式；
* 所有当前可用测试和构建命令。

不得修改既有内容分析的输出语义来迁就新功能。

不得复用现有 `analysis` resume scope 伪装成受众 AI 分析，因为现有内容分析发生在受众采集之前。

## 2.5 不得伪造 AI 完成

不得：

* 用固定文本代替模型结果；
* 用前端 mock 代替真实服务；
* 用关键词计数冒充 AI 分析；
* 在模型失败后仍标记 completed；
* 引用不存在的 commentId 或 userId；
* 根据缺失资料编造用户属性；
* 隐藏未覆盖评论；
* 把部分结果描述为全量；
* 把当前会话可达范围描述为平台绝对全量；
* 把估算 token 或成本描述为精确值。

# 三、开始前必须完成的真实代码审计

开始修改前必须记录：

1. 当前分支；
2. 当前提交哈希；
3. `git status --short`；
4. 已有未提交修改；
5. Node 测试基线；
6. Python 测试基线；
7. TypeScript 和 Vite 构建基线；
8. Playwright 基线；
9. 当前受众页面截图；
10. 当前任务数据计数；
11. 当前 API、SSE 和 Artifact 行为；
12. 当前 AI Provider 和 Session 解析方式。

必须重点阅读并记录真实调用关系：

* `src/App.tsx`；
* `src/types.ts`；
* `src/api.ts`；
* `src/styles.css`；
* `server/app.mjs`；
* `server/job-manager.mjs`；
* `server/ai-session-store.mjs`；
* `server/lib/audience-results.mjs`；
* `server/lib/contracts.mjs`；
* `server/lib/artifacts.mjs`；
* `scripts/audience_collection.py`；
* `scripts/run_project_workflow.py`；
* `scripts/ai_provider_runtime.py`；
* `scripts/ai_application_workflow.py`；
* `scripts/expansion_collection.py`；
* `server/*.test.mjs`；
* `tests/test_audience_collection.py`；
* `tests/e2e/`。

审计必须确认以下事实，不得凭 README 推测：

* 原帖正文实际持久化位置；
* 媒体、OCR 或视觉分析实际持久化位置；
* `note_id`、`post_id` 和 URL 的映射规则；
* 评论与回复的父子关系字段；
* 用户与评论的关联键；
* 主页字段的实际覆盖范围；
* 主页完整度的现有判定规则；
* 受众结果如何合并多个 checkpoint；
* 原任务 read-through 如何工作；
* SSE 订阅是否属于任务层；
* AI Session 密钥如何传入 Python；
* JobManager 是否存在全局采集锁；
* Artifact 如何递归发现子目录；
* 服务重启后运行中状态如何处理。

必须明确记录当前数据缺口：

* 现有 `AudiencePost` 是否包含正文；
* 是否包含媒体和既有内容分析；
* 评论记录是否包含稳定线程根 ID；
* 是否有逐记录内容哈希；
* 主页是否只有头部资料；
* 是否已经采集主页近期帖子；
* 当前分页接口是否只能返回当前页；
* 当前内容分析能否消费受众数据。

基线失败时先判断是既有问题还是本功能引入的问题。

不得删除断言、扩大 mock、更新截图或标记 skip 来掩盖基线失败。

# 四、用户操作和界面语义

## 4.1 每帖独立按钮

每篇原帖必须拥有独立 AI 按钮。

推荐文案：

`AI 分析`

推荐图标：

`Sparkles`

按钮必须带 tooltip：

`结合原帖分析该帖评论与用户`

当前原帖卡片如果整体使用 `<button>`，必须重构为：

* 外层语义容器；
* 独立的原帖选择按钮；
* 独立的 AI 操作按钮；
* 不得产生嵌套 button；
* 不得破坏键盘可达性；
* 不得改变原帖选择行为。

按钮状态必须包含：

* 未分析；
* 准备中；
* 等待主页补采；
* 分析中；
* 正在归并；
* 部分完成；
* 已完成；
* 需更新；
* 已阻断；
* 失败；
* 已取消；
* 可继续。

状态必须来自服务端，不得仅由点击后的前端临时状态伪造。

当原帖筛选器处于“全部原帖”时：

* 页面仍显示每篇原帖自己的 AI 按钮；
* 不得把“AI 分析”误解释为自动分析全部帖子；
* 本期默认不提供隐式批量启动；
* 如保留批量入口，必须使用独立的“批量分析”命令和二次配置；
* 批量运行必须拆成多个 per-post run，并分别持久化、取消、恢复和计费；
* 一个帖子失败不得覆盖其他帖子结果；
* 批量入口不得替代每帖独立按钮；
* 批量分析不属于本功能的最低完成条件，未经完整预算和恢复设计不得顺手增加。

## 4.2 分析配置面板

点击按钮后，在原帖列表与评论/用户工具栏之间展开独立分析面板。

不得替换评论流或用户卡。

不得创建营销式全屏页面。

不得使用卡片套卡片。

面板必须展示：

* 当前原帖标题；
* 原帖作者；
* 原帖正文是否可用；
* 原帖媒体分析是否可用；
* 已采集顶层评论数；
* 已采集回复数；
* 独立评论用户数；
* 已有主页资料数；
* 完整主页数；
* 部分主页数；
* 缺失主页数；
* 当前数据版本；
* 上一版分析时间；
* 上一版分析状态；
* 当前选择的 AI Provider 和模型；
* 预计输入量；
* 预计调用次数；
* 预计 token 和成本，无法精确时必须标记为估算。

## 4.3 分析范围配置

配置项必须包含：

1. 原帖完整内容，固定开启且不可关闭；
2. 顶层评论，默认开启；
3. 评论回复，默认开启；
4. 评论用户，默认开启；
5. 用户主页，默认关闭；
6. 分析模块，多选；
7. AI Session 或模型选择；
8. 输出语言；
9. 证据严格度；
10. 是否只分析新增数据。

原帖完整内容不可关闭，因为产品要求所有受众结论都结合原帖语境。

评论和用户范围必须基于该帖全部已持久化数据，不受前端当前分页、搜索词或当前页签影响。

## 4.4 主页分析模式

主页模式必须严格区分：

### `none`

* 完全不读取主页字段；
* 不启动 Relay；
* 不补采；
* 只分析评论文本与用户在该帖中的行为。

### `available_header`

* 只使用当前已经持久化的公开主页头部字段；
* 允许使用部分主页；
* 缺失字段必须为 unknown；
* 不启动 Relay；
* 不补采。

### `collect_missing_header`

* 仅补齐当前帖子相关评论用户的缺失主页头部；
* 必须在原 jobId 内执行；
* 不得补采其他帖子无关用户；
* 不得新建任务；
* 补采结束后重新冻结 AI 输入快照；
* 补采部分失败时允许使用已有数据生成 partial 分析。

### `recent_public_posts`

* 明确表示要进入用户主页并采集公开近期帖子；
* 这是独立、显式、默认关闭的范围；
* 必须设置每用户帖子上限；
* 必须设置总用户上限；
* 必须设置总帖子上限；
* 必须显示预计网络请求和预算；
* 必须在原 jobId 内保存检查点；
* 不得因为选中主页分析就默认采集所有帖子；
* 不得把已有主页头部完整度冒充近期帖子覆盖率。

## 4.5 操作按钮

面板必须提供：

* 开始分析；
* 取消；
* 继续；
* 重新分析；
* 查看上一版；
* 查看输入覆盖；
* 下载结果。

重复点击开始分析必须通过幂等键返回同一活动运行。

取消后不得删除已经完成的 chunk 和上一版结果。

继续必须恢复原 `analysisRunId`，不得创建新 Job。

## 4.6 结果视图

结果面板内部至少包含：

1. 综合总览；
2. 评论洞察；
3. 用户洞察；
4. 主页洞察；
5. 原帖与受众匹配；
6. 内容机会；
7. 风险与数据质量；
8. 证据。

结果必须同时支持：

* 总体结论；
* 聚类结果；
* 逐评论结果；
* 逐用户结果；
* 筛选；
* 排序；
* 分页或虚拟列表；
* 证据定位；
* 版本切换；
* Artifact 下载。

## 4.7 证据跳转

每个证据引用必须可点击。

点击评论证据时：

* 切换到评论流；
* 清除会阻止定位的临时筛选或显示提示；
* 请求包含目标评论的页或定位接口；
* 滚动到目标评论；
* 短暂高亮；
* 展开其父线程；
* 不得仅在当前页查找然后报告不存在。

点击用户证据时：

* 切换到用户卡；
* 定位目标用户；
* 展示该用户在当前帖子下的相关评论；
* 展示实际参与分析的主页字段；
* 不得混入该用户在其他帖子下的数据，除非结果明确标记为跨帖主页内容。

## 4.8 空状态、阻断状态和旧结果状态

必须分别设计并测试：

* 没有选中原帖；
* 原帖不存在；
* 原帖正文缺失；
* 该帖尚无评论；
* 只有评论但没有稳定用户 ID；
* 没有主页资料；
* 主页资料部分完成；
* AI Session 未配置；
* AI Session 已过期；
* Provider 不可达；
* 模型不支持要求的上下文；
* 主页补采等待 Relay；
* 主页补采等待安全验证；
* 分析部分完成；
* 分析失败但有上一版；
* 输入已更新导致上一版 stale；
* 任务来自旧版本且没有 audience AI 状态。

无 AI Session 时必须：

* 保留当前帖子和受众数据；
* 明确提示需要配置 AI；
* 提供跳转到现有 AI 配置区的操作；
* 不自动创建 Session；
* 不把任务标记失败。

没有评论时 AI 按钮应禁用并说明原因，不能启动空分析。

原帖正文缺失时默认阻断完整分析，并提供“继续原任务补齐正文”的既有路径；如允许降级运行，必须由用户明确选择，结果标记 context_incomplete。

存在上一版时，任何阻断和错误都必须在上一版上方以非破坏性状态条展示，不得把结果区域替换为空白错误页。

## 4.9 逐对象查看与重算边界

逐评论和逐用户列表必须提供“查看分析详情”和“查看证据”。

不得在每条评论卡片上堆叠多个常驻文字按钮。

如实现单对象重算：

* 使用菜单或详情面板中的明确命令；
* 仍绑定当前 postId 和 run lineage；
* 只重算目标实体及受其影响的聚合；
* 不创建新 Job；
* 保留旧实体结果直到新结果校验通过；
* 更新帖子级结果时必须生成新的分析版本；
* 单对象重算不是第一版最低完成条件，不得牺牲整帖正确性提前实现。

# 五、分析模块的完整定义

## 5.1 原帖上下文理解

必须分析：

* 原帖核心主题；
* 原帖事实信息；
* 原帖观点；
* 原帖表达方式；
* 原帖内容结构；
* 原帖核心卖点或主张；
* 原帖隐含目标受众；
* 原帖提出的问题；
* 原帖给出的解决方案；
* 原帖可能引发讨论的观点；
* 现有媒体、OCR 或视觉分析；
* 现有内容分析中可以复用的结构化字段。

不得仅使用标题代替原帖上下文。

原帖正文缺失时必须：

* 明确标记上下文不完整；
* 降低结论置信度；
* 不得根据评论反推并伪造原帖正文；
* 允许用户先执行原任务正文补采，再重新分析。

## 5.2 逐评论分析

每条顶层评论和回复必须产生可选的结构化分析记录。

字段至少包括：

* `commentId`；
* `postId`；
* `parentCommentId`；
* `rootThreadId`；
* `userId`；
* `level`；
* `themeIds`；
* `sentiment`；
* `stance`；
* `intent`；
* `needs`；
* `questions`；
* `objections`；
* `painPoints`；
* `desiredOutcomes`；
* `engagementRole`；
* `actionability`；
* `confidence`；
* `evidenceRefs`；
* `qualityFlags`。

情绪必须允许：

* positive；
* neutral；
* negative；
* mixed；
* unclear。

立场必须相对原帖主张定义：

* support；
* oppose；
* question；
* supplement；
* personal_experience；
* unrelated；
* unclear。

意图至少允许：

* seek_information；
* share_experience；
* evaluate；
* recommend；
* complain；
* request_help；
* express_identity；
* socialize；
* purchase_or_action_interest；
* unclear。

回复必须结合父评论与原帖解释，不能脱离上下文单独判断。

## 5.3 评论线程分析

每个顶层评论及其回复必须作为完整线程分析。

线程结果至少包含：

* 线程主题；
* 讨论演化；
* 主要观点；
* 分歧点；
* 共识；
* 未解决问题；
* 高价值回复；
* 作者是否参与；
* 互动深度；
* 线程情绪变化；
* 证据引用。

分块不得把父评论和直接回复分开。

超长线程允许拆为子块，但必须携带根评论和线程摘要，并在最终阶段重新合并。

## 5.4 逐用户分析

每位当前帖评论用户必须有独立结果。

逐用户输入必须汇总：

* 该用户在当前帖下的全部顶层评论；
* 该用户在当前帖下的全部回复；
* 评论时间和互动位置；
* 其回复对象；
* 当前帖下可观察的互动行为；
* 用户选择允许使用的主页字段；
* 用户选择允许使用的近期公开帖子。

逐用户结果至少包含：

* `userId`；
* `postId`；
* `displayName`；
* `interactionRole`；
* `mainThemes`；
* `expressedNeeds`；
* `expressedConcerns`；
* `questions`；
* `stanceToPost`；
* `engagementDepth`；
* `observableInterests`；
* `possibleContentNeeds`；
* `profileCoverage`；
* `sourceScope`；
* `confidence`；
* `evidenceRefs`；
* `qualityFlags`。

不得生成未经证据支持的心理画像。

不得将一次评论描述成稳定人格。

不得推断敏感人口属性。

## 5.5 用户分群

帖子级用户分群必须基于可观察内容和行为。

允许的分群维度包括：

* 主题兴趣；
* 明确表达的需求；
* 对原帖立场；
* 互动方式；
* 信息阶段；
* 问题类型；
* 内容偏好；
* 明确公开自述的角色。

每个分群必须包含：

* segmentId；
* 名称；
* 定义；
* 用户数；
* 评论数；
* 占比；
* 代表性需求；
* 代表性问题；
* 代表性证据；
* 置信度；
* 覆盖局限。

同一用户可以属于多个主题分群，但必须区分主分群和次分群。

## 5.6 主页洞察

主页头部分析只能使用实际存在的公开字段，例如：

* 公开昵称；
* 公开简介；
* 公开角色标签；
* 公开地区或 IP 展示；
* 公开关注、粉丝、获赞与收藏计数；
* 已采集的公开近期帖子。

主页洞察必须显示：

* 可用字段；
* 缺失字段；
* 被使用字段；
* 数据采集时间；
* access status；
* profile mode；
* 覆盖用户数；
* 主页帖子覆盖数；
* 结论置信度。

不得把缺失简介解释为用户没有兴趣。

不得把低粉丝数解释为低价值用户。

不得根据地区、头像或昵称推断敏感身份。

## 5.7 原帖与受众匹配

必须输出：

* 原帖主张与评论关注点的一致度；
* 原帖预期受众与实际参与者的差异；
* 被理解的内容；
* 被误解的内容；
* 未被回应的问题；
* 引发正向参与的表达；
* 引发异议的表达；
* 缺失信息；
* 内容可信度问题；
* 可执行的内容改进建议。

每条差异和建议必须引用原帖证据及至少一条评论或用户证据。

## 5.8 内容机会

必须基于当前数据生成：

* 后续选题；
* FAQ；
* 评论区回复建议；
* 需要澄清的表达；
* 需要补充的证据；
* 可以展开的案例；
* 适合不同受众分群的内容角度；
* 高价值用户问题；
* 内容风险提醒。

建议不得脱离原帖和评论证据。

不得直接生成骚扰式私信或对个人进行操纵性营销。

## 5.9 数据质量与覆盖

必须输出独立 coverage 对象：

* expectedComments；
* collectedComments；
* topLevelComments；
* replies；
* commentsAnalyzed；
* commentsSkipped；
* skipReasons；
* uniqueUsers；
* usersAnalyzed；
* profilesAvailable；
* profilesUsed；
* profilePostsAvailable；
* profilePostsUsed；
* originalBodyAvailable；
* mediaAnalysisAvailable；
* sourceCheckpointIds；
* snapshotAt；
* coverageStatus；
* limitations。

完成状态不得只由模型返回决定。

必须由确定性校验器根据覆盖和 Schema 计算。

# 六、完整输入快照与关联规则

## 6.1 后端统一构建输入

前端不得提交全部评论文本、主页内容或原帖正文。

前端只提交：

* jobId；
* postId；
* AI Session ID；
* scope；
* modules；
* idempotency key；
* 用户明确配置的预算。

后端必须从当前任务持久层构建完整输入。

## 6.2 原帖关联

原帖关联优先级建议：

1. 规范化 `note_id/post_id` 精确匹配；
2. 持久化的 lineage 映射；
3. 规范化 note URL 匹配；
4. 仅在可证明唯一时使用兼容映射。

不得只用标题模糊匹配。

发生多义匹配时必须阻断并返回稳定错误码。

完整原帖快照至少包括：

* postId；
* noteId；
* title；
* body；
* author；
* publishTime；
* sourceUrl；
* media；
* OCR；
* visual analysis；
* existing content analysis；
* source artifact；
* collectedAt；
* content hash。

## 6.3 评论树标准化

每条评论必须标准化出：

* commentId；
* postId；
* parentCommentId；
* rootThreadId；
* replyToUserId，如果可用；
* level；
* text；
* likes；
* publishTime；
* location；
* sourceUrl；
* userId；
* collectedAt；
* normalizedContentHash。

必须处理：

* 重复评论；
* 缺失父评论；
* 楼中楼回复；
* 空文本；
* 删除用户；
* 无 userId；
* 重复 ID 冲突；
* 时间格式异常；
* 旧检查点字段缺失；
* 同一评论从多个 checkpoint 读到。

不得因为坏记录让整个帖子分析失败。

坏记录必须进入 quality flags 和 skipped records。

## 6.4 用户关联

用户输入必须通过稳定 userId 合并。

同一用户多个展示名或头像时：

* 保留最新公开值；
* 保留来源时间；
* 不影响稳定 userId；
* 不把名称变化当成多个用户。

没有稳定 userId 时可以生成受控匿名实体，但必须：

* 使用任务内稳定键；
* 标记 synthetic identity；
* 不跨任务合并；
* 不与真实 userId 混淆。

## 6.5 输入版本

必须计算 `inputRevision`。

至少覆盖：

* 原帖内容 hash；
* 媒体派生结果 hash；
* 排序后的评论记录 hash；
* 评论线程结构 hash；
* 用户聚合记录 hash；
* 被选中的主页字段 hash；
* 近期主页帖子 hash；
* profile mode；
* include replies；
* module configuration；
* prompt version；
* schema version；
* model configuration hash。

AI Session 的密钥不得进入 hash、日志或 Artifact。

同样输入和同样配置必须命中同一可复用版本。

输入发生变化时上一版必须标记 stale，但不得删除。

# 七、AI 流水线与 Prompt 协议

## 7.1 不得单次塞入全部数据

4,000 条以上评论和 1,500 位以上用户不得一次发送给模型。

必须使用可恢复的 Map-Reduce 流水线。

推荐阶段：

1. 原帖上下文结构化；
2. 评论线程 Map；
3. 逐评论结果规范化；
4. 按用户聚合；
5. 用户批次分析；
6. 主题与分群归并；
7. 帖子级综合；
8. 确定性 Schema 校验；
9. 证据校验；
10. Artifact 生成。

## 7.2 动态 token 预算

不得固定按评论数量粗暴截断。

必须根据模型上下文计算：

* system prompt token；
* schema token；
* 原帖上下文 token；
* 评论线程 token；
* 输出预留 token；
* 安全余量。

输入建议不超过模型上下文的 50%–60%，具体比例必须可配置并有测试。

超限时应拆分线程或压缩已验证摘要，不得静默丢弃尾部评论。

## 7.3 评论线程 Map

每个 Map 请求必须包含：

* 固定系统指令；
* 原帖结构化上下文；
* 当前线程或线程子块；
* 明确 JSON Schema；
* 允许的枚举；
* evidence ID 规则；
* unknown 规则；
* prompt injection 防护规则。

评论中的文本必须被标记为数据。

评论中出现“忽略之前指令”等内容不得改变分析规则。

## 7.4 用户聚合

不得为 1,500 位用户默认发起 1,500 次单独模型调用。

必须：

* 先确定性聚合同一用户的评论；
* 按 token 预算批量分析；
* 每批建议 20–30 位用户，但必须动态调整；
* 每位用户结果必须可独立校验和重试；
* 单个异常用户不得导致整个批次永久失败。

## 7.5 归并阶段

归并输入必须优先使用已经通过校验的结构化结果，而不是再次传输所有原始评论。

归并必须生成：

* 主题字典；
* 主题分布；
* 情绪分布；
* 立场分布；
* 需求和问题；
* 用户分群；
* 原帖与受众差异；
* 内容机会；
* 风险；
* 数据质量；
* 代表性证据。

归并不得重新发明不存在的证据。

## 7.6 JSON Schema

必须为每个阶段定义版本化 Schema。

模型输出必须经过真实 Schema 校验器，不得只要求模型“输出 JSON”。

校验失败时：

1. 保存原始响应的脱敏诊断信息；
2. 使用明确错误列表执行一次修复请求；
3. 再次校验；
4. 仍失败则标记该 chunk failed；
5. 其他成功 chunk 继续；
6. 最终运行状态为 partial 或 failed。

不得因为 JSON 可以解析就视为 Schema 合格。

## 7.7 证据校验

必须建立确定性 evidence resolver。

每个 evidence ref 至少包含：

* entityType；
* postId；
* commentId，可选；
* userId，可选；
* profileField，可选；
* sourceTextHash；
* excerpt；
* collectedAt；
* snapshotId。

校验器必须确认：

* ID 在输入快照中存在；
* 引用实体属于当前帖子；
* excerpt 来自对应字段；
* hash 一致；
* 不引用未选择的主页范围；
* 不引用其他任务数据；
* 不引用模型自己生成的文本作为源证据。

证据校验失败的结论不得进入最终可信结果。

## 7.8 Provider 与 Session

必须复用现有 AI Session 解析和 Provider Runtime。

不得在请求体接受：

* apiKey；
* Authorization；
* provider secret；
* 未经验证的 baseUrl；
* 任意执行命令。

服务端通过 `aiSessionId` 解析密钥并仅注入子进程环境。

密钥不得写入：

* SQLite；
* job state；
* input snapshot；
* prompt 文件；
* 日志；
* SSE；
* Artifact；
* 错误响应。

必须记录可公开的：

* provider ID；
* model ID；
* wire API；
* prompt version；
* schema version；
* token usage；
* estimated flag；
* cost；
* duration。

# 八、状态机、持久化与恢复

## 8.1 独立子运行状态

不得复用主任务顶层 status 表示 AI 运行。

状态至少包括：

* not_started；
* snapshotting；
* waiting_profile_enrichment；
* collecting_profile_headers；
* collecting_profile_posts；
* analyzing_comments；
* analyzing_users；
* synthesizing；
* validating；
* exporting；
* partial；
* completed；
* blocked；
* interrupted；
* failed；
* cancelled；
* stale。

必须定义每个状态允许的操作和合法迁移。

非法状态迁移必须被拒绝并记录稳定错误码。

## 8.2 SQLite 状态库

建议在当前任务目录建立：

`audience-ai-state.sqlite3`

必须使用：

* WAL；
* 外键；
* 事务；
* busy timeout；
* schema version；
* migration；
* 崩溃恢复；
* 原子 active-version 指针。

建议表：

### `analysis_runs`

保存：

* runId；
* jobId；
* postId；
* status；
* profileMode；
* modules；
* model；
* promptVersion；
* schemaVersion；
* inputRevision；
* startedAt；
* updatedAt；
* completedAt；
* errorCode；
* errorMessage；
* resumable；
* tokenUsage；
* cost；
* estimatedUsage。

### `input_snapshots`

保存：

* snapshotId；
* inputRevision；
* source lineage；
* source counts；
* hash manifest；
* createdAt；
* immutable input location。

### `analysis_chunks`

保存：

* chunkId；
* runId；
* kind；
* entity IDs；
* inputHash；
* status；
* attemptCount；
* outputHash；
* error；
* startedAt；
* completedAt。

### `entity_insights`

保存逐评论、逐线程、逐用户结构化结果。

### `evidence_refs`

保存所有已验证证据引用。

### `run_events`

保存可恢复的事件序列。

### `analysis_versions`

保存每帖历史版本及 active pointer。

`workflowSummary.audienceAI` 只能保存供任务列表和 SSE 快照使用的轻量摘要，例如：

* 当前活动 postId；
* 当前 runId；
* 当前 stage；
* 完成帖子数；
* partial 帖子数；
* stale 帖子数；
* 最近更新时间；
* 可恢复标记。

不得把数千条逐评论、逐用户结果写入主任务 JSON 状态。

完整运行状态、chunk 和结果必须留在 audience AI 专用持久层。

建议服务端新增独立 `AudienceAiService` 和进程注册表。

可以参考现有 expansion 子运行的 start/resume/cancel 形态，但不得直接复用其全局 `active` 或按 jobId 单键进程模型。

纯 AI 子进程应按 `jobId + postId + runId` 管理。

主页补采阶段才进入现有 Relay/采集锁。

## 8.3 幂等

必须建立稳定幂等键：

`hash(jobId, postId, inputRevision, scopeHash, moduleHash, modelConfigHash, promptVersion, schemaVersion)`

同一键：

* 已运行时返回现有运行；
* 已完成时返回可复用结果；
* 已取消且可恢复时返回原 runId；
* 不得重复产生模型费用；
* 不得重复生成 Artifact 版本。

## 8.4 并发控制

必须满足：

* 同一帖子最多一个活动分析；
* 不同帖子允许有限并发；
* 默认 AI 并发建议为 2，必须可配置；
* 纯 AI 分析不占用 Relay 全局采集锁；
* 主页补采必须遵守现有 Relay 全局锁；
* Relay 忙时状态为 waiting，不得创建新任务；
* 取消只终止本分析或补采子阶段；
* 不得取消原任务其他已完成数据。

## 8.5 服务重启

服务启动时必须扫描运行中分析：

* 无活动进程的 running 状态改为 interrupted；
* interrupted 必须标记 resumable；
* 已完成 chunk 不得重跑；
* 未完成 chunk 可以续跑；
* 上一版 completed 结果继续可见；
* SSE 事件序号必须可恢复或重新生成一致快照；
* 不得把主 Job 标记失败。

## 8.6 版本切换

新运行完成前：

* 当前 active version 仍指向上一版；
* UI 显示上一版并附加“正在更新”；
* 新运行失败不改变 active version；
* 新运行通过 Schema、证据和覆盖校验后原子切换；
* 旧版本继续可浏览和下载；
* 用户可查看版本差异。

# 九、API、SSE 与错误契约

## 9.1 API

建议新增：

`GET /api/jobs/:jobId/audience/posts/:postId/ai`

返回当前状态、active version、历史版本、coverage 和可用操作。

`POST /api/jobs/:jobId/audience/posts/:postId/ai/preview`

返回输入计数、主页覆盖、预计 chunk、预计 token、预计成本和阻断原因。

`POST /api/jobs/:jobId/audience/posts/:postId/ai/runs`

启动或幂等返回分析运行。

`POST /api/jobs/:jobId/audience/posts/:postId/ai/runs/:runId/cancel`

取消当前分析。

`POST /api/jobs/:jobId/audience/posts/:postId/ai/runs/:runId/resume`

恢复同一 runId。

`GET /api/jobs/:jobId/audience/posts/:postId/ai/runs/:runId`

读取运行详情。

`GET /api/jobs/:jobId/audience/posts/:postId/ai/runs/:runId/results`

按模块分页读取结果。

`GET /api/jobs/:jobId/audience/posts/:postId/ai/events`

提供帖子分析事件流，或复用任务 SSE 中独立事件类型。

`GET /api/jobs/:jobId/audience/posts/:postId/comments/:commentId/anchor`

返回评论定位所需页码或 cursor。

`GET /api/jobs/:jobId/audience/posts/:postId/users/:userId/anchor`

返回用户定位信息。

## 9.2 启动请求

请求必须严格校验未知字段。

示例：

```json
{
  "aiSessionId": "SESSION_ID",
  "includeTopLevelComments": true,
  "includeReplies": true,
  "includeUsers": true,
  "profileMode": "available_header",
  "profileUserLimit": 0,
  "profilePostLimitPerUser": 0,
  "profilePostTotalLimit": 0,
  "modules": [
    "comment_insights",
    "thread_insights",
    "user_insights",
    "audience_segments",
    "content_fit",
    "content_opportunities"
  ],
  "outputLanguage": "zh-CN",
  "incrementalOnly": false,
  "idempotencyKey": "CLIENT_GENERATED_KEY"
}
```

服务端不得信任前端提供的计数和 post ownership。

必须重新验证：

* job 存在；
* post 属于 job authoritative post set；
* AI Session 有效；
* profile mode 有效；
* limit 在范围内；
* 当前状态允许启动；
* 输入数据存在；
* 幂等键与请求配置一致。

## 9.3 稳定错误码

至少定义：

* `AUDIENCE_AI_JOB_NOT_FOUND`；
* `AUDIENCE_AI_POST_NOT_FOUND`；
* `AUDIENCE_AI_POST_NOT_OWNED`；
* `AUDIENCE_AI_INPUT_EMPTY`；
* `AUDIENCE_AI_BODY_MISSING`；
* `AUDIENCE_AI_SESSION_REQUIRED`；
* `AUDIENCE_AI_SESSION_EXPIRED`；
* `AUDIENCE_AI_ALREADY_RUNNING`；
* `AUDIENCE_AI_REVISION_CONFLICT`；
* `AUDIENCE_AI_INVALID_SCOPE`；
* `AUDIENCE_AI_PROFILE_LIMIT_EXCEEDED`；
* `AUDIENCE_AI_RELAY_BUSY`；
* `AUDIENCE_AI_SECURITY_BLOCKED`；
* `AUDIENCE_AI_PROVIDER_RATE_LIMITED`；
* `AUDIENCE_AI_PROVIDER_FAILED`；
* `AUDIENCE_AI_SCHEMA_INVALID`；
* `AUDIENCE_AI_EVIDENCE_INVALID`；
* `AUDIENCE_AI_RUN_NOT_RESUMABLE`；
* `AUDIENCE_AI_CANCELLED`；
* `AUDIENCE_AI_INTERNAL_ERROR`。

错误响应必须包含：

* errorCode；
* message；
* jobId；
* postId；
* runId，如果存在；
* resumable；
* retryAfter，如果适用；
* requestId。

不得返回 API Key、完整 Prompt 或无必要的个人数据。

## 9.4 SSE 事件

至少包括：

* `audience_ai_snapshot`；
* `audience_ai_status`；
* `audience_ai_progress`；
* `audience_ai_profile_progress`；
* `audience_ai_chunk_completed`；
* `audience_ai_partial`；
* `audience_ai_completed`；
* `audience_ai_stale`；
* `audience_ai_blocked`；
* `audience_ai_failed`；
* `audience_ai_cancelled`。

进度事件必须包含：

* runId；
* postId；
* stage；
* completedUnits；
* totalUnits；
* commentsAnalyzed；
* usersAnalyzed；
* profilesUsed；
* tokenUsage；
* estimatedUsage；
* updatedAt。

SSE 断线重连后必须先发服务端快照，再发增量事件。

服务端实现必须优先复用现有真实能力：

* 用 `materializeAudienceResults()` 合并受众 read-through 数据；
* 用 `readLatestApplicationPayload()` 或抽取后的共享读取器获得完整原帖；
* 用 `AiSessionStore.resolve()` 在服务端解析 AI Session；
* 用现有 `AIProvider.generate_json()` 作为 Provider 适配入口；
* 在 Provider 返回后增加真正的 JSON Schema 和 evidence 校验；
* 用现有 Artifact 递归枚举和下载安全校验发布文件；
* 完成产物后刷新原任务 Artifact 计数；
* 复用现有任务 SSE 通道或建立兼容子事件流，不得建立第二套顶层任务系统。

建议新增文件：

* `server/audience-ai-service.mjs`；
* `server/lib/audience-ai-store.mjs`；
* `server/lib/audience-ai-input.mjs`；
* `server/lib/audience-ai-contracts.mjs`；
* `scripts/run_audience_ai.py`；
* `scripts/audience_ai_pipeline.py`；
* `scripts/audience_ai_schemas.py`；
* `src/features/audience-ai/` 下的组件和 Hook；
* 对应 Node、Python 和 E2E 测试文件。

文件名可根据仓库现有约定调整，但职责边界和测试必须保留。

# 十、Artifact 与导出

每个版本至少生成：

```text
artifacts/audience-ai/<postId>/<runId>/manifest.json
artifacts/audience-ai/<postId>/<runId>/analysis.json
artifacts/audience-ai/<postId>/<runId>/analysis.md
artifacts/audience-ai/<postId>/<runId>/comment-insights.jsonl
artifacts/audience-ai/<postId>/<runId>/thread-insights.jsonl
artifacts/audience-ai/<postId>/<runId>/user-insights.jsonl
artifacts/audience-ai/<postId>/<runId>/evidence.jsonl
artifacts/audience-ai/<postId>/<runId>/coverage.json
artifacts/audience-ai/<postId>/<runId>/run-metadata.json
artifacts/audience-ai/<postId>/latest.json
```

`manifest.json` 必须包含：

* schemaVersion；
* jobId；
* postId；
* runId；
* inputRevision；
* promptVersion；
* model；
* profileMode；
* modules；
* coverage；
* file list；
* file sizes；
* SHA-256；
* generatedAt；
* completion status。

`analysis.json` 必须是机器可读完整结果。

`analysis.md` 必须是人类可读报告，并明确：

* 数据范围；
* 覆盖率；
* 分析模块；
* 主要结论；
* 证据；
* 局限；
* 模型和版本；
* 是否使用主页；
* 是否包含主页近期帖子；
* 是否为 partial。

JSONL 每行必须可独立解析。

Artifact 不得包含：

* API Key；
* Authorization header；
* Session secret；
* Relay 凭证；
* 未参与分析的用户数据；
* 模型隐藏推理；
* 不必要的完整原始主页副本。

旧任务没有 audience AI Artifact 时必须正常读取。

删除任务时必须一并删除该任务的 audience AI 状态和产物。

Artifact 下载必须继续使用现有安全路径校验。

# 十一、前端类型和组件边界

必须新增明确类型，不得到处使用 `any`。

建议类型：

* `AudienceAiStatus`；
* `AudienceAiProfileMode`；
* `AudienceAiModule`；
* `AudienceAiCoverage`；
* `AudienceAiRunSummary`；
* `AudienceAiVersion`；
* `AudienceAiStartRequest`；
* `AudienceAiPreviewResponse`；
* `AudienceAiResultResponse`；
* `AudienceAiCommentInsight`；
* `AudienceAiThreadInsight`；
* `AudienceAiUserInsight`；
* `AudienceAiSegment`；
* `AudienceAiEvidenceRef`；
* `AudienceAiQualityFlags`。

建议拆分组件：

* `AudiencePostCard`；
* `AudienceAiButton`；
* `AudienceAiPanel`；
* `AudienceAiScopeForm`；
* `AudienceAiCoveragePreview`；
* `AudienceAiProgress`；
* `AudienceAiResultTabs`；
* `AudienceAiOverview`；
* `AudienceAiCommentInsights`；
* `AudienceAiUserInsights`；
* `AudienceAiProfileInsights`；
* `AudienceAiEvidencePanel`；
* `AudienceAiVersionSelector`。

建议新增 Hook：

`useAudiencePostAnalysis(jobId, postId)`

Hook 必须负责：

* 加载状态；
* preview；
* start；
* cancel；
* resume；
* 版本读取；
* SSE 合并；
* stale 标记；
* 保留上一版；
* 错误恢复。

不得继续无限扩大单体 `AudienceWorkspace`。

组件拆分不得改变现有评论和用户列表的行为。

# 十二、前端交互、视觉与可访问性

## 12.1 视觉约束

新增界面必须沿用当前：

* 字体；
* 字号层级；
* 颜色；
* 边框；
* 圆角；
* 间距；
* 图标库；
* 按钮高度；
* focus 样式；
* 空状态语言；
* 加载状态语言。

不得：

* 引入新 UI 框架；
* 整体重写 CSS；
* 使用大 Hero；
* 使用装饰性渐变；
* 使用卡片套卡片；
* 用超大标题占据工作区；
* 让 AI 面板遮挡原始数据；
* 在每条评论上堆叠多个文字按钮。

## 12.2 响应式

必须验证：

* 390 × 844；
* 768 × 1024；
* 1024 × 768；
* 1440 × 900；
* 宽桌面。

桌面：

* 原帖卡片保持现有密度；
* AI 面板可使用双列配置与结果摘要；
* 评论和用户区域不被挤压到不可读。

移动端：

* 原帖选择和 AI 按钮不重叠；
* 面板使用单列；
* 长模型名和状态文字可换行；
* 操作按钮不溢出；
* 结果 tabs 可稳定滚动或折叠；
* 页面不得横向溢出。

## 12.3 可访问性

必须满足：

* 所有按钮有可访问名称；
* 图标按钮有 tooltip 和 aria-label；
* 状态变化通过 aria-live 适度通知；
* 键盘可打开面板、选择范围、启动和取消；
* focus 不丢失；
* 颜色不是唯一状态信号；
* loading 不锁死整页；
* 证据跳转后 focus 到目标实体；
* reduced-motion 下关闭非必要动画。

# 十三、隐私、安全与分析边界

本功能只处理当前任务已经采集或用户明确选择补采的公开数据。

必须遵守：

* 数据最小化；
* 目的限定；
* 公开来源标记；
* 证据可追溯；
* 缺失即 unknown；
* 用户可删除任务及其 AI 结果；
* 日志脱敏；
* AI 密钥隔离；
* Prompt injection 防护。

不得推断或输出：

* 未公开年龄；
* 性别或性取向；
* 民族；
* 宗教；
* 政治倾向；
* 健康状况；
* 收入；
* 家庭关系；
* 精确住址；
* 私人联系方式；
* 其他敏感或受保护属性。

只有用户在公开文本中明确自述且与分析目标直接相关时，才能以“公开自述”引用，并必须附证据和范围说明。

不得根据头像、昵称、地区或语言风格推断敏感属性。

不得给用户打“高价值”“低价值”等歧视性标签。

不得生成用于骚扰、操纵或规避平台限制的建议。

# 十四、性能、限流与成本控制

必须建立：

* 模型并发上限；
* 每 Provider 限流；
* 429 指数退避；
* 超时；
* chunk 重试上限；
* 总 token 预算；
* 总成本预算；
* 取消检查点；
* 内存上限；
* 大结果分页。

默认建议：

* AI 并发 2；
* 单 chunk 最多重试 2 次；
* Schema 修复额外 1 次；
* 429 遵循 Retry-After；
* 运行预算由 preview 显示；
* 超出用户预算前停止并保留 partial。

这些值必须配置化，不得散落硬编码。

必须记录：

* 快照耗时；
* chunk 数量；
* 每 chunk 耗时；
* 用户聚合耗时；
* synthesis 耗时；
* 校验耗时；
* token；
* cost；
* 重试；
* 429；
* 峰值内存；
* SQLite 大小；
* Artifact 大小；
* SSE 延迟。

Codex CLI 等无法返回精确 usage 时必须标记 `estimated=true`。

# 十五、十阶段执行顺序

以下阶段必须按顺序执行。

## 第一阶段：基线、契约与功能骨架

必须完成：

1. 记录代码和测试基线；
2. 固化原任务不新增 Job 的契约测试；
3. 定义所有 TypeScript、Node 和 Python 类型；
4. 定义 profile mode；
5. 定义状态机；
6. 定义稳定错误码；
7. 定义 API 请求和响应 Schema；
8. 建立 feature flag，默认关闭；
9. 建立空的 audience AI service；
10. 建立旧 Job 兼容行为。

第一阶段验收：

* 未开启 feature flag 时行为完全不变；
* 新接口未知字段被拒绝；
* foreign postId 被拒绝；
* 启动接口不调用 create job；
* 原任务数量不增加；
* 既有测试通过。

## 第二阶段：完整输入快照与数据关联

必须完成：

1. 抽取统一 audience AI input builder；
2. 复用 audience read-through 和 checkpoint merge；
3. 关联完整原帖正文；
4. 关联媒体和既有内容分析；
5. 标准化评论树；
6. 聚合用户；
7. 处理部分主页；
8. 计算 coverage；
9. 计算 inputRevision；
10. 持久化不可变输入快照。

第二阶段验收：

* 输入只包含目标帖子数据；
* 全部评论不受前端分页影响；
* 原帖正文可验证；
* 父回复关系正确；
* 重复 checkpoint 不重复计数；
* 坏记录进入 quality flags；
* 同样输入产生同样 revision。

## 第三阶段：SQLite、子运行与恢复

必须完成：

1. 建立 SQLite Schema；
2. 建立 migration；
3. 建立 run repository；
4. 建立 chunk repository；
5. 建立 evidence repository；
6. 建立事件日志；
7. 建立幂等；
8. 建立同帖锁；
9. 建立取消与恢复；
10. 建立服务重启恢复。

第三阶段验收：

* 双击只产生一个 runId；
* 取消保留 chunk；
* 恢复沿用 runId；
* 服务重启后状态为 interrupted/resumable；
* 已完成 chunk 不重跑；
* 主 Job 状态不被污染；
* 上一版结果不被覆盖。

## 第四阶段：评论与线程 AI 分析

必须完成：

1. 原帖上下文结构化；
2. 动态 token 分块；
3. 线程 Map；
4. 逐评论 Schema；
5. 线程 Schema；
6. Provider 调用；
7. JSON Schema 校验；
8. 修复重试；
9. evidence resolver；
10. partial 行为。

第四阶段验收：

* 父评论和回复不被错误切断；
* 每条结果有真实 commentId；
* prompt injection fixture 不改变指令；
* 无证据结论被过滤；
* 单 chunk 失败不丢失其他结果；
* 4,000 条评论不进入单次请求。

## 第五阶段：逐用户分析与帖子级归并

必须完成：

1. 同一用户评论聚合；
2. 用户批次分析；
3. 逐用户结果；
4. 用户分群；
5. 主题、情绪和立场分布；
6. 原帖与受众匹配；
7. 内容机会；
8. 风险与数据质量；
9. synthesis Schema；
10. 最终证据交叉校验。

第五阶段验收：

* 每位目标用户有可定位结果或明确 skip reason；
* 不为每位用户默认发起一次调用；
* 用户结论只基于允许范围；
* 分群人数和用户去重结果一致；
* 总体结论有原帖与评论双重证据；
* 敏感属性 fixture 不产生推断。

## 第六阶段：可选主页分析与原任务补采

必须完成：

1. none 模式；
2. available_header 模式；
3. collect_missing_header 模式；
4. recent_public_posts 模式；
5. 定向用户队列；
6. Relay 锁等待；
7. 安全验证状态；
8. 补采 checkpoint；
9. 补采后重新冻结快照；
10. 补采失败降级分析。

第六阶段验收：

* 默认模式不打开 Relay；
* available_header 不发网络请求；
* 定向补采只处理当前帖相关用户；
* 补采不创建新 Job；
* Relay 忙时等待而不是新建任务；
* 已有评论和用户持续可见；
* 近期帖子有显式预算；
* 头部覆盖和近期帖子覆盖分开统计。

## 第七阶段：API、SSE 与 Artifact

必须完成：

1. 全部 API；
2. 严格契约；
3. 错误码；
4. SSE 快照和增量；
5. 进度统计；
6. Artifact 生成；
7. manifest 和 SHA-256；
8. latest pointer；
9. 下载；
10. 任务删除联动。

第七阶段验收：

* API 不泄漏 secret；
* SSE 重连不重复启动；
* partial 产物可解析；
* latest 只在通过校验后切换；
* 旧版本可下载；
* 删除任务后 Artifact 不可访问；
* 路径穿越被拒绝。

## 第八阶段：前端逐帖按钮与结果工作台

必须完成：

1. 拆分原帖卡片语义；
2. 独立 AI 按钮；
3. 配置面板；
4. coverage preview；
5. 主页模式；
6. 进度；
7. 结果视图；
8. 证据跳转；
9. 版本切换；
10. 响应式和可访问性。

第八阶段验收：

* 评论流和用户卡不消失；
* 运行时上一版继续显示；
* 无嵌套 button；
* 无 AI Session 时提供明确配置引导；
* 搜索和分页不改变分析输入；
* 证据可定位跨页实体；
* 390、768、1024、1440 视口通过；
* 不发生文字和按钮重叠。

## 第九阶段：完整测试、性能和安全

必须完成：

1. Node 单元测试；
2. Python 单元测试；
3. API 集成测试；
4. SQLite migration 测试；
5. 状态机测试；
6. fake AI Provider；
7. fake Relay；
8. Playwright；
9. 视觉回归；
10. 性能、限流和凭证扫描。

第九阶段验收：

* 全部既有测试通过；
* 4,000+ 评论规模测试通过；
* 1,500+ 用户规模测试通过；
* 内存和延迟有记录；
* 429、超时、坏 JSON、坏证据均被覆盖；
* 日志和 Artifact 无密钥；
* prompt injection fixture 通过；
* Windows 与 Linux CI 通过。

## 第十阶段：真实任务验收、文档和收尾

必须使用当前真实任务或等价真实任务进行验收。

建议任务：

`20260731093808-50dd4507`

必须分别验证：

1. 不使用主页；
2. 使用已有主页头部；
3. 原任务内补齐缺失主页；
4. 限量近期主页帖子；
5. 中途取消和恢复；
6. 服务重启恢复；
7. 新增评论后 stale；
8. 重新分析增量复用；
9. 证据跳转；
10. Artifact 下载和校验。

真实验收必须记录：

* jobId；
* postId；
* runId；
* profileMode；
* 输入计数；
* 输出计数；
* Provider；
* model；
* promptVersion；
* schemaVersion；
* token；
* cost；
* duration；
* coverage；
* partial reason；
* Artifact 路径；
* 截图路径；
* 测试命令；
* 提交哈希。

未经真实 AI Provider 和真实数据验收，不得宣称 release-ready。

# 十六、必须建立的测试矩阵

## 16.1 契约测试

覆盖：

* 未知字段；
* 缺少 aiSessionId；
* 非法 profile mode；
* 非法 module；
* 非法 limit；
* foreign jobId；
* foreign postId；
* post 不属于 job；
* 幂等键复用；
* 幂等键配置冲突；
* secret 字段被拒绝。

## 16.2 快照测试

覆盖：

* 原帖正文 join；
* noteId join；
* URL fallback；
* 多义匹配阻断；
* 媒体和 OCR；
* 评论树；
* 楼中楼；
* 缺父评论；
* 重复评论；
* 删除用户；
* 部分主页；
* 多 checkpoint merge；
* read-through lineage；
* revision 稳定性。

## 16.3 AI 分析测试

覆盖：

* 合法 JSON；
* 非法 JSON；
* JSON 可解析但 Schema 不合法；
* 修复成功；
* 修复失败；
* 评论 prompt injection；
* 不存在证据；
* 跨帖证据；
* excerpt hash 不一致；
* unknown；
* 部分 chunk 失败；
* 429；
* 超时；
* Provider 中断；
* 预算耗尽；
* 取消。

## 16.4 用户和主页测试

覆盖：

* 一个用户一条评论；
* 一个用户多条评论；
* 用户同时发顶层评论和回复；
* display name 变化；
* 无 userId；
* none；
* available_header；
* collect_missing_header；
* recent_public_posts；
* 部分主页；
* 主页访问受限；
* 主页补采安全验证；
* 主页补采取消和恢复；
* 敏感属性禁止推断。

## 16.5 状态和恢复测试

覆盖：

* 双击启动；
* 同帖并发；
* 不同帖有限并发；
* 服务重启；
* 子进程崩溃；
* SQLite busy；
* WAL 恢复；
* cancel；
* resume；
* stale；
* 新版本失败；
* active pointer 保留；
* chunk 增量复用；
* 不创建新 Job。

## 16.6 UI E2E

覆盖：

* 每帖独立按钮；
* 无评论按钮禁用和原因；
* 无原帖正文提示；
* 无 AI Session 引导；
* preview；
* 主页模式；
* 启动；
* 进度；
* 取消；
* 继续；
* 重新分析；
* 上一版持续可见；
* 评论流持续可见；
* 用户卡持续可见；
* 刷新恢复；
* SSE 重连；
* 证据跳转；
* stale；
* 版本切换；
* 下载；
* 键盘；
* 移动端。

测试必须断言整个流程没有发送 `POST /api/jobs`。

## 16.7 Artifact 测试

覆盖：

* 所有文件存在；
* JSON 可解析；
* JSONL 每行可解析；
* manifest 文件列表；
* SHA-256；
* coverage 可复算；
* inputRevision 一致；
* 无 secret；
* partial manifest；
* latest pointer；
* 旧版本读取；
* 删除联动；
* 路径穿越。

# 十七、当前真实任务验收场景

对任务 `20260731093808-50dd4507` 或当前用户明确指定的任务执行时，必须先只读核对数据。

记录：

* 原帖总数；
* complete/partial/uncollected 帖子数；
* 顶层评论数；
* 回复数；
* 独立用户数；
* complete/partial/pending 主页数。

选择至少三篇帖子：

1. 评论量较高且回复较多；
2. 评论量中等且主页覆盖较高；
3. 评论量少或数据部分完成。

场景一：默认现有数据分析

* profileMode=none；
* 不打开 Relay；
* jobId 不变；
* 任务数不变；
* 生成评论、用户和综合结果；
* 证据可定位。

场景二：已有主页头部

* profileMode=available_header；
* 不打开 Relay；
* 显示 profilesAvailable/profilesUsed；
* 缺失字段为 unknown；
* 主页结论有字段证据。

场景三：补齐缺失主页

* profileMode=collect_missing_header；
* 仅补当前帖相关用户；
* 同一 jobId；
* Relay 忙时等待；
* 原始数据持续可见；
* 补采后重新冻结 revision；
* 部分失败产生 partial。

场景四：近期公开帖子

* 使用小规模显式 limit；
* 显示用户数和帖子预算；
* 不超预算；
* 主页帖子和头部覆盖分别统计；
* 不采集无关用户。

场景五：取消和恢复

* 在完成若干 chunk 后取消；
* 已完成 chunk 保留；
* runId 不变；
* 恢复只执行未完成 chunk；
* token 不重复计费。

场景六：服务重启

* 分析中重启 Node；
* 状态变 interrupted；
* 页面刷新后上一版和进度仍可读；
* 继续后沿用 runId；
* 不创建新 Job。

场景七：输入更新

* 原任务补采新增评论；
* 旧版标 stale；
* 旧版继续可见；
* 新 preview 显示新增量；
* 增量重跑复用未变化 chunk；
* 新版通过后原子切换。

# 十八、非回归命令和证据

必须根据仓库实际 scripts 运行，不得编造命令。

至少包括：

* Node 全量测试；
* Python 全量测试；
* audience 专项测试；
* audience AI 专项测试；
* API contract 测试；
* JobManager 测试；
* TypeScript typecheck；
* Vite production build；
* Playwright；
* 视觉回归；
* Artifact 校验；
* credential leak scan；
* Windows CI；
* Linux CI。

不得：

* 删除失败测试；
* 标记 skip；
* 降低覆盖阈值；
* 扩大 mock；
* 更新视觉基准掩盖布局问题；
* 用局部测试冒充全量通过；
* 用 build 通过冒充真实运行完成。

测试报告必须区分：

* 当前运行实际通过；
* 当前运行实际失败；
* 因环境未执行；
* 依赖历史结果但未复验；
* 真实 Relay 已验证；
* 真实 AI Provider 已验证；
* 仅 fake fixture 已验证。

# 十九、提交和迁移要求

必须保护当前脏工作树中用户已有修改。

不得回滚、覆盖或格式化无关文件。

建议提交拆分：

1. `feat(audience-ai): add contracts and immutable input snapshots`；
2. `feat(audience-ai): persist per-post analysis runs and checkpoints`；
3. `feat(audience-ai): add grounded comment and user analysis pipeline`；
4. `feat(audience-ai): add optional profile enrichment in original job`；
5. `feat(ui): add per-post audience AI analysis panel`；
6. `test(audience-ai): cover evidence resume scale and regressions`；
7. `docs(audience-ai): document operation and acceptance`。

每个提交必须：

* 单一职责；
* 可独立测试；
* 不包含无关格式化；
* 不包含生成缓存；
* 不包含真实密钥；
* 不包含用户隐私数据；
* 保持旧数据兼容。

如果需要迁移：

* migration 必须幂等；
* 旧任务打开时懒初始化；
* 不要求用户手工删除旧数据；
* migration 失败不得破坏原任务；
* 迁移前后必须有 fixture；
* rollback 或恢复路径必须明确。

# 二十、最终验收标准

只有全部满足时才能标记功能完成：

1. 每篇原帖有独立 AI 分析按钮；
2. 原帖完整内容固定纳入分析；
3. 该帖全部已持久化评论和回复可分析；
4. 每条评论有结构化结果或明确 skip reason；
5. 每位评论用户有结构化结果或明确 skip reason；
6. 用户主页是显式可选范围；
7. 默认分析不启动 Relay；
8. 主页补采仍在原 jobId；
9. 整个流程不创建新顶层 Job；
10. 不重新执行关键词搜索；
11. 评论流和用户卡始终可见；
12. 上一版结果在新运行期间可见；
13. 4,000+ 评论使用分块而非单请求；
14. 用户分析使用批次而非逐用户固定调用；
15. 每项重要结论有真实证据；
16. Schema 和证据由确定性代码校验；
17. 缺失信息标记 unknown；
18. 不推断敏感属性；
19. 同样输入幂等；
20. 新输入使旧版 stale 但不删除；
21. 取消和服务重启可恢复；
22. 已完成 chunk 不重复运行；
23. 新版本失败不覆盖上一版；
24. API、SSE、Artifact 保持旧任务兼容；
25. AI 密钥不进入持久层、日志或产物；
26. 390、768、1024、1440 视口无重叠；
27. 键盘和屏幕阅读器基本可用；
28. Node、Python、构建和 E2E 通过；
29. Windows 与 Linux CI 通过；
30. 真实任务、真实 Provider 和 Artifact 得到验证。

必须额外建立需求追踪矩阵。本文每一项用户需求都必须对应：

* 用户可见行为；
* 前端组件或状态；
* API；
* 服务端数据来源；
* 持久化字段；
* 状态迁移；
* 错误和恢复语义；
* 单元或集成测试；
* E2E 或真实验收证据；
* 最终报告位置。

任何一项只有 UI、只有后端、只有 Prompt 或只有测试而没有完整闭环，都不得标记为完成。

如果代码功能完成但未进行真实 Provider 或真实 Relay 验收，最终结论必须是：

`Audience AI feature complete, real-environment acceptance pending`

如果存在新建任务、旧数据消失、证据无效、敏感推断、恢复失败或既有功能回归，最终结论必须是：

`Audience AI feature incomplete, release blocked`

只有真实链路、恢复、证据、视觉和全量回归全部通过时，才能使用：

`Audience AI feature completed and release-ready`

# 二十一、最终报告格式

最终报告必须逐项提供：

1. 当前分支和提交；
2. 修改文件列表；
3. 十阶段完成状态；
4. 每帖独立按钮实现；
5. 原任务原地执行证据；
6. 未创建新 Job 的证据；
7. 原帖完整输入证据；
8. 评论线程分块设计；
9. 逐评论结果 Schema；
10. 逐用户结果 Schema；
11. 主页四种模式；
12. 补采检查点和恢复；
13. 状态机；
14. SQLite Schema；
15. 幂等和并发；
16. Provider 和 Session；
17. Prompt 和 Schema 版本；
18. 证据校验；
19. coverage；
20. stale 和版本切换；
21. API；
22. SSE；
23. Artifact；
24. 前端交互；
25. 响应式和可访问性；
26. 隐私和敏感推断限制；
27. 性能、token 和成本；
28. 单元测试；
29. 集成测试；
30. Playwright 和视觉回归；
31. Windows 和 Linux 结果；
32. 真实任务 jobId；
33. 真实分析 postId 和 runId；
34. Artifact 绝对路径；
35. 截图绝对路径；
36. 当前未验证项；
37. 剩余风险；
38. 提交哈希；
39. 最终发布结论。

任何没有实际执行的测试必须明确写“未执行”，不得写成通过。

任何没有真实持久化证据的结果不得写成完成。

# 二十二、开始执行

现在开始：

1. 完整阅读当前仓库和脏工作树；
2. 记录真实基线；
3. 输出十阶段简短执行清单；
4. 从第一阶段开始修改真实代码；
5. 每阶段运行专项和非回归测试；
6. 每阶段未通过时立即修复；
7. 使用真实任务完成最终验收；
8. 生成真实 Artifact 和截图；
9. 按规定格式提交最终报告；
10. 完成本功能后停止，不得顺带实现其他功能。
