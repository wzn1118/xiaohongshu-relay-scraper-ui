import { expect, test, type Page, type Route } from "@playwright/test";

const now = "2026-08-01T08:00:00.000Z";
const expiresAt = "2026-08-02T08:00:00.000Z";
const jobId = "audience-task-1";
const postId = "post-1";
const oldRunId = "audience-ai-old-version";
const currentRunId = "audience-ai-current-run";

type Runtime = "completed" | "running" | "partial";

const coverage = {
  expectedComments: 3,
  sourceCommentsForPost: 3,
  collectedComments: 3,
  topLevelComments: 2,
  replies: 1,
  commentsAnalyzed: 3,
  commentsSkipped: 0,
  uniqueUsers: 2,
  usersAnalyzed: 2,
  profilesAvailable: 1,
  profilesComplete: 1,
  profilesPartial: 0,
  profilesMissing: 1,
  profilesUsed: 1,
  originalBodyAvailable: true,
  mediaAnalysisAvailable: true,
  sourceCheckpointIds: ["audience-checkpoint-1"],
  snapshotAt: now,
  coverageStatus: "complete",
  limitations: ["一位评论用户未公开主页简介"],
};

const task = {
  id: jobId,
  keyword: "亚比女",
  status: "completed",
  createdAt: now,
  updatedAt: now,
  finishedAt: now,
  progress: 100,
  progressPhase: "done",
  progressLabel: "内容与受众采集完成",
  progressCurrent: 2,
  progressTotal: 2,
  applicationCount: 2,
  artifactCount: 0,
  artifacts: [],
  resumeAvailable: false,
  config: {
    analysisMode: "general",
    limit: 0,
    maxScrolls: 60,
    searchSort: "latest",
    maxAgeDays: 0,
    collectAudience: true,
  },
  workflowSummary: {
    analysisMode: "general",
    audience: {
      status: "complete",
      commentsCollected: 3,
      usersDiscovered: 2,
      profilesComplete: 1,
    },
  },
};

const posts = [
  {
    post_id: postId,
    title: "亚比穿搭与圈层表达",
    note_url: "https://example.test/post-1",
    author: { user_id: "author-1", display_name: "原帖作者" },
    expected_comment_count: 3,
    collected_comment_count: 3,
    status: "complete",
    collectionStatus: "complete",
  },
  {
    post_id: "post-2",
    title: "尚未采集评论的原帖",
    note_url: "https://example.test/post-2",
    author: { user_id: "author-2", display_name: "另一作者" },
    expected_comment_count: null,
    collected_comment_count: 0,
    status: "uncollected",
    collectionStatus: "uncollected",
  },
];

const publicUser = {
  user_id: "user-1",
  display_name: "公开用户甲",
  profile_url: "https://example.test/user-1",
  avatar_url: "",
  xhs_id: "public-user-1",
  bio: "喜欢亚文化穿搭与线下活动",
  location: "上海",
  ip_location: "上海",
  following_count: 120,
  follower_count: 860,
  liked_and_collected_count: 3200,
  roles: ["commenter"],
  comment_count: 2,
  post_ids: [postId],
  enrichment_status: "complete",
  access_status: "complete",
  last_enriched_at: now,
};

const comments = [
  {
    comment_id: "comment-1",
    post_id: postId,
    post_title: "亚比穿搭与圈层表达",
    parent_comment_id: "",
    level: "comment",
    text: "原始评论在 AI 分析运行时仍然可见",
    likes: 18,
    publish_time: now,
    location: "上海",
    source_url: "https://example.test/post-1",
    user: publicUser,
    collected_at: now,
  },
  {
    comment_id: "comment-2",
    post_id: postId,
    post_title: "亚比穿搭与圈层表达",
    parent_comment_id: "comment-1",
    level: "reply",
    text: "回复也继续保留，不因重新分析消失",
    likes: 4,
    publish_time: now,
    location: "北京",
    source_url: "https://example.test/post-1",
    user: {
      ...publicUser,
      user_id: "user-2",
      display_name: "公开用户乙",
      xhs_id: "public-user-2",
      profile_url: "",
    },
    collected_at: now,
  },
];

const contentResults = {
  available: true,
  analysisMode: "general",
  keyword: "亚比女",
  research: null,
  presentation: null,
  insights: null,
  total: 1,
  offset: 0,
  limit: 20,
  items: [
    {
      note_id: postId,
      title: "亚比穿搭与圈层表达",
      note_url: "https://example.test/post-1",
      body: "这是一篇讨论亚比穿搭、圈层认同与线下活动的完整原帖正文。",
      access_status: "complete",
      collected_at: now,
      publish_time: {
        raw: "2026-08-01",
        value: "2026-08-01",
        precision: "day",
        is_estimated: false,
      },
      application_info: {
        contacts: [],
        application_routes: [],
        responsibilities: [],
        requirements: [],
      },
      outreach: {
        greeting: "",
        email_subject: "",
        email_body: "",
        cover_letter: "",
        generation_mode: "",
        runtime_status: "",
        status: "",
      },
      content_analysis: {
        status: "completed",
        overview: "原帖内容完整",
        content_type: "圈层讨论",
        relevance_score: 96,
        relevance_reason: "正文与评论均已采集",
        topics: ["亚比穿搭"],
        entities: [],
        image_insights: [],
        modules: [],
        grounded_evidence_count: 2,
      },
      quality: { body_complete: true },
    },
  ],
  filters: {
    sort: "newest",
    timeRange: "all",
    stats: { all: 1, dated: 1, unknown: 0, incomplete: 0, withImages: 0 },
  },
  codexRuntime: { status: "completed" },
  qualityGate: { passed: true },
};

function run(runId: string, status: Runtime) {
  const active = status === "running";
  return {
    runId,
    jobId,
    postId,
    status: active
      ? "analyzing_comments"
      : status === "partial"
        ? "partial"
        : "completed",
    profileMode: "available_header",
    modules: [
      "comment_insights",
      "thread_insights",
      "user_insights",
      "audience_segments",
      "content_fit",
      "content_opportunities",
    ],
    outputLanguage: "zh-CN",
    model: { provider: "codex", model: "e2e-model", wireApi: "responses" },
    promptVersion: "audience-ai-v1",
    schemaVersion: 1,
    inputRevision: "revision-20260801",
    coverage,
    progress: {
      runId,
      postId,
      stage: active ? "analyzing_comments" : status,
      completedUnits: active ? 2 : 8,
      totalUnits: 8,
      commentsAnalyzed: active ? 1 : 3,
      usersAnalyzed: active ? 0 : 2,
      profilesUsed: 1,
      tokenUsage: { total: active ? 420 : 1800 },
      updatedAt: now,
      message: active
        ? "正在分析评论线程，旧版本与原始数据保持可见"
        : "结果已持久化",
    },
    tokenUsage: { total: active ? 420 : 1800 },
    cost: null,
    estimatedUsage: false,
    resumable: status === "partial",
    stale: false,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    completedAt: status === "completed" ? now : null,
    cancelledAt: status === "partial" ? now : null,
  };
}

function audienceResults(kind: "comments" | "users", search: URLSearchParams) {
  const filteredComments = search.get("postId")
    ? comments.filter((comment) => comment.post_id === search.get("postId"))
    : comments;
  const userItems = [
    publicUser,
    {
      ...publicUser,
      user_id: "user-2",
      display_name: "公开用户乙",
      xhs_id: "public-user-2",
      profile_url: "",
      bio: "",
    },
  ];
  return {
    available: true,
    kind,
    summary: {
      schemaVersion: 1,
      status: "complete",
      postsTotal: 2,
      postsComplete: 1,
      postsPending: 1,
      postsPartial: 0,
      postsFailed: 0,
      postsAttempted: 1,
      postsWithComments: 1,
      commentsCollected: 3,
      topLevelComments: 2,
      repliesCollected: 1,
      usersDiscovered: 2,
      profilesComplete: 1,
      postCoveragePercent: 50,
      postAttemptPercent: 50,
      profileCoveragePercent: 50,
      stopReason: "",
      generatedAt: now,
    },
    posts,
    total: kind === "comments" ? filteredComments.length : userItems.length,
    offset: Number(search.get("offset") || 0),
    limit: Number(search.get("limit") || 40),
    totals: { posts: 2, comments: 3, users: 2 },
    filters: {
      postId: search.get("postId") || "",
      query: search.get("query") || "",
    },
    items: kind === "comments" ? filteredComments : userItems,
  };
}

function overview(runtime: Runtime) {
  const oldRun = run(oldRunId, "completed");
  const currentRun =
    runtime === "completed" ? null : run(currentRunId, runtime);
  return {
    available: true,
    featureEnabled: true,
    jobId,
    postId,
    status: currentRun?.status || "completed",
    currentRun,
    activeVersion: oldRun,
    versions: [oldRun],
    coverage,
    actions: {
      canStart: !currentRun,
      canCancel: runtime === "running",
      canResume: runtime === "partial",
      canReanalyze: true,
    },
    latestResult: {
      runId: oldRunId,
      status: "completed",
      inputRevision: oldRun.inputRevision,
      resultsUrl: "results",
      manifestArtifact: "manifest.json",
    },
  };
}

function aiResults(module: string) {
  const analysis = {
    summary: "旧版综合结论仍保持可见",
    themes: ["圈层认同", "穿搭表达"],
    audienceSegments: [
      { name: "风格探索者", evidenceRefs: ["evidence-comment-1"] },
    ],
    contentFit: "原帖的穿搭细节与评论区需求高度匹配",
    contentOpportunities: ["补充单品清单", "整理线下活动指南"],
    risks: ["样本来自单帖，不外推私密属性"],
    dataQuality: "3 条评论全部纳入，1 个主页字段缺失",
    limitations: coverage.limitations,
  };
  const moduleItems: Record<string, Array<Record<string, unknown>>> = {
    comments: [
      {
        commentId: "comment-1",
        sentiment: "积极",
        stance: "认同",
        intent: "交流穿搭经验",
        confidence: 0.94,
        evidenceRefs: ["evidence-comment-1"],
      },
    ],
    threads: [
      {
        rootThreadId: "comment-1",
        label: "单品与活动讨论",
        commentIds: ["comment-1", "comment-2"],
        confidence: 0.91,
        evidenceRefs: ["evidence-comment-1"],
      },
    ],
    users: [
      {
        userId: "user-1",
        displayName: "公开用户甲",
        observableInterests: ["亚文化穿搭"],
        profileCoverage: "complete",
        confidence: 0.88,
        evidenceRefs: ["evidence-comment-1"],
      },
    ],
    evidence: [
      {
        evidenceId: "evidence-comment-1",
        entityType: "comment",
        entityId: "comment-1",
        postId,
        field: "text",
        excerpt: "原始评论在 AI 分析运行时仍然可见",
        label: "评论原文",
        validated: true,
      },
    ],
  };
  return {
    run: run(oldRunId, "completed"),
    runId: oldRunId,
    module,
    total: module === "analysis" ? 1 : moduleItems[module]?.length || 0,
    offset: 0,
    limit: 50,
    items: module === "analysis" ? [] : moduleItems[module] || [],
    analysis: module === "analysis" ? analysis : undefined,
    coverage,
    artifacts: [
      {
        id: "audience-ai-manifest",
        name: "manifest.json",
        path: `audience-ai/${oldRunId}/manifest.json`,
        size: 512,
      },
    ],
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installQuietEventSource(page: Page) {
  await page.addInitScript(() => {
    class QuietEventSource {
      onmessage = null;
      onerror = null;
      addEventListener() {}
      close() {}
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: QuietEventSource,
    });
  });
}

async function openAudience(
  page: Page,
  options: { enabled?: boolean; runtime?: Runtime } = {},
) {
  let runtime: Runtime = options.runtime || "completed";
  let newJobPosts = 0;
  let starts = 0;
  let cancels = 0;
  let resumes = 0;
  let aiRequests = 0;
  const resumedRunIds: string[] = [];
  await installQuietEventSource(page);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (/\/audience\/posts\/[^/]+\/ai(?:\/|$)/.test(path)) aiRequests += 1;
    if (path === "/api/health")
      return json(route, {
        ok: true,
        runnerAvailable: true,
        audienceAi: {
          enabled: options.enabled !== false,
          runnerAvailable: true,
        },
        emailDelivery: { configured: false },
      });
    if (path === "/api/jobs" && method === "GET") return json(route, [task]);
    if (path === "/api/jobs" && method === "POST") {
      newJobPosts += 1;
      return json(route, task, 202);
    }
    if (path === "/api/relay/config")
      return json(route, {
        port: 18800,
        profile: "openclaw",
        autoConnect: true,
      });
    if (path === "/api/relay/status")
      return json(route, {
        running: true,
        cdpReady: true,
        ready: true,
        authenticated: true,
        tabs: 1,
        xiaohongshuTabs: 1,
        port: 18800,
      });
    if (path === "/api/email/config")
      return json(route, {
        provider: "custom",
        host: "",
        port: 465,
        secure: true,
        requireTls: false,
        auth: "login",
        user: "",
        from: "",
        configured: false,
        verified: false,
        oauth: {},
      });
    if (path === "/api/ai/providers")
      return json(route, [
        {
          id: "codex",
          label: "Codex",
          baseUrl: "http://127.0.0.1:9999",
          model: "e2e-model",
          models: ["e2e-model"],
          requiresKey: false,
          configured: true,
          hasApiKey: true,
          wireApi: "responses",
        },
      ]);
    if (path === "/api/ai/local-models")
      return json(route, {
        runtime: { ready: false },
        catalog: [],
        installedModels: [],
        install: null,
      });
    if (path === "/api/ai/sessions" && method === "POST")
      return json(route, {
        id: "session-e2e",
        provider: "codex",
        model: "e2e-model",
        baseUrl: "http://127.0.0.1:9999",
        wireApi: "responses",
        configured: true,
        expiresAt,
      });
    if (path === "/api/profiles") return json(route, []);
    if (path === `/api/jobs/${jobId}/results`)
      return json(route, contentResults);
    if (path === `/api/jobs/${jobId}/artifacts`)
      return json(route, [
        {
          id: "audience-ai-manifest",
          name: "manifest.json",
          path: `audience-ai/${oldRunId}/manifest.json`,
          size: 512,
        },
      ]);
    if (path === `/api/jobs/${jobId}/audience`)
      return json(
        route,
        audienceResults(
          url.searchParams.get("kind") === "users" ? "users" : "comments",
          url.searchParams,
        ),
      );
    const aiBase = `/api/jobs/${jobId}/audience/posts/${postId}/ai`;
    if (path === aiBase && method === "GET")
      return json(route, overview(runtime));
    if (path === `${aiBase}/preview` && method === "POST")
      return json(route, {
        jobId,
        postId,
        inputRevision: "revision-20260801",
        coverage,
        estimatedChunks: 4,
        estimatedCalls: 8,
        estimatedTokens: 2400,
        estimatedCost: null,
        estimatedNetworkRequests: 0,
        estimated: true,
        canStart: true,
        blockers: [],
        warnings: ["估算值仅用于运行前预览"],
      });
    if (path === `${aiBase}/runs` && method === "POST") {
      starts += 1;
      runtime = "running";
      return json(
        route,
        {
          action: "started",
          run: run(currentRunId, runtime),
          activeVersion: run(oldRunId, "completed"),
          message:
            "分析已在原任务内启动。原始评论、用户和上一版结果会继续显示。",
        },
        202,
      );
    }
    if (path === `${aiBase}/runs/${currentRunId}/cancel` && method === "POST") {
      cancels += 1;
      runtime = "partial";
      return json(
        route,
        {
          action: "cancelled",
          run: run(currentRunId, runtime),
          activeVersion: run(oldRunId, "completed"),
          message: "已请求取消。完成的分块和上一版结果仍会保留。",
        },
        202,
      );
    }
    if (path === `${aiBase}/runs/${currentRunId}/resume` && method === "POST") {
      resumes += 1;
      resumedRunIds.push(currentRunId);
      runtime = "running";
      return json(
        route,
        {
          action: "resumed",
          run: run(currentRunId, runtime),
          activeVersion: run(oldRunId, "completed"),
          message: `已沿用分析运行 ${currentRunId} 继续未完成分块。`,
        },
        202,
      );
    }
    if (path === `${aiBase}/runs/${oldRunId}/results`)
      return json(
        route,
        aiResults(url.searchParams.get("module") || "analysis"),
      );
    if (
      path ===
      `/api/jobs/${jobId}/audience/posts/${postId}/comments/comment-1/anchor`
    )
      return json(route, {
        jobId,
        postId,
        entityType: "comment",
        entityId: "comment-1",
        commentId: "comment-1",
        parentCommentId: null,
        rootThreadId: "comment-1",
        offset: 0,
        index: 0,
        pageSize: 40,
        page: 1,
        limit: 40,
      });
    if (path.endsWith("/expansion"))
      return json(route, {
        available: true,
        status: "idle",
        runtimeStatus: "idle",
        businessStatus: "idle",
        resumable: false,
        hasResults: false,
        actionState: "ready",
        summary: {},
        seeds: [],
        config: null,
        metrics: {},
        rounds: [],
        results: {
          kind: "users",
          total: 0,
          offset: 0,
          limit: 50,
          items: [],
          filters: {},
        },
        artifacts: [],
      });
    return json(route, {});
  });
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`/content?module=audience&job=${jobId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".audience-workspace")).toBeVisible();
  return {
    counts: () => ({
      newJobPosts,
      starts,
      cancels,
      resumes,
      aiRequests,
      resumedRunIds: [...resumedRunIds],
    }),
    setRuntime: (next: Runtime) => {
      runtime = next;
    },
  };
}

test("feature flag 关闭时不显示逐帖 AI 按钮，也不请求 Audience AI API", async ({
  page,
}) => {
  const harness = await openAudience(page, { enabled: false });
  await expect(
    page.locator('button[aria-label*="结合原帖分析该帖评论与用户"]'),
  ).toHaveCount(0);
  await expect(
    page.getByText("原始评论在 AI 分析运行时仍然可见", { exact: true }),
  ).toBeVisible();
  expect(harness.counts()).toEqual({
    newJobPosts: 0,
    starts: 0,
    cancels: 0,
    resumes: 0,
    aiRequests: 0,
    resumedRunIds: [],
  });
});

test("逐帖 AI 在同一 jobId 内启动、取消、续跑和刷新，且旧结果与原数据持续可见", async ({
  page,
}) => {
  const harness = await openAudience(page);
  const aiButton = page.getByRole("button", {
    name: "亚比穿搭与圈层表达：结合原帖分析该帖评论与用户",
  });
  await expect(aiButton).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "尚未采集评论的原帖：结合原帖分析该帖评论与用户",
    }),
  ).toBeDisabled();
  await aiButton.click();

  const panel = page.locator(".audience-ai-panel");
  await expect(panel).toContainText("逐帖受众 AI 深度分析");
  await expect(panel).toContainText(`绑定任务 ${jobId}`);
  await expect(panel).toContainText("旧版综合结论仍保持可见");
  await expect(panel.getByRole("button", { name: "重新分析" })).toBeEnabled();
  await panel.getByRole("button", { name: "重新分析" }).click();

  await expect(panel).toContainText("分析评论与线程");
  await expect(panel).toContainText(
    "新版本正在更新；下方继续展示已验证的上一版",
  );
  await expect(panel).toContainText("旧版综合结论仍保持可见");
  await expect(
    page.getByText("原始评论在 AI 分析运行时仍然可见", { exact: true }),
  ).toBeVisible();

  await page
    .locator(".audience-view-switch")
    .getByRole("tab", { name: /用户卡/ })
    .click();
  await expect(
    page.getByText("公开用户甲", { exact: true }).last(),
  ).toBeVisible();
  await expect(panel).toContainText("旧版综合结论仍保持可见");
  await page
    .locator(".audience-view-switch")
    .getByRole("tab", { name: /评论流/ })
    .click();
  await expect(
    page.getByText("原始评论在 AI 分析运行时仍然可见", { exact: true }),
  ).toBeVisible();

  await panel.getByRole("button", { name: "取消" }).click();
  await expect(panel).toContainText("部分完成");
  await expect(panel.getByRole("button", { name: "继续原运行" })).toBeVisible();
  await panel.getByRole("button", { name: "继续原运行" }).click();
  await expect(panel).toContainText("分析评论与线程");

  await page.reload();
  await expect(page.locator(".audience-workspace")).toBeVisible();
  await page
    .getByRole("button", {
      name: "亚比穿搭与圈层表达：结合原帖分析该帖评论与用户",
    })
    .click();
  await expect(page.locator(".audience-ai-panel")).toContainText(
    "分析评论与线程",
  );
  await expect(page.locator(".audience-ai-panel")).toContainText(
    "旧版综合结论仍保持可见",
  );

  await page
    .locator(".audience-ai-panel")
    .getByRole("tab", { name: "证据", exact: true })
    .click();
  await expect(
    page.getByText("原始评论在 AI 分析运行时仍然可见", { exact: true }).first(),
  ).toBeVisible();
  await page
    .locator(".audience-ai-panel")
    .getByRole("button", { name: "定位" })
    .click();
  await expect(page.locator("#audience-comments-comment-1")).toHaveClass(
    /evidence-target/,
  );
  await expect(page.locator("#audience-comments-comment-1")).toBeFocused();

  const counts = harness.counts();
  expect(counts.newJobPosts).toBe(0);
  expect(counts.starts).toBe(1);
  expect(counts.cancels).toBe(1);
  expect(counts.resumes).toBe(1);
  expect(counts.resumedRunIds).toEqual([currentRunId]);
});

for (const viewport of [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "desktop-1024x900", width: 1024, height: 900 },
  { name: "desktop-1024x768", width: 1024, height: 768 },
  { name: "tablet-768x1024", width: 768, height: 1024 },
  { name: "mobile-390x844", width: 390, height: 844 },
]) {
  test(`逐帖受众 AI 面板在 ${viewport.name} 无横向溢出`, async ({ page }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await openAudience(page);
    await page
      .getByRole("button", {
        name: "亚比穿搭与圈层表达：结合原帖分析该帖评论与用户",
      })
      .click();
    const panel = page.locator(".audience-ai-panel");
    await expect(panel).toContainText("旧版综合结论仍保持可见");
    expect(
      await page.evaluate(() => {
        const target =
          document.querySelector<HTMLElement>(".audience-ai-panel");
        return {
          documentFits:
            document.documentElement.scrollWidth <= window.innerWidth,
          panelFits: Boolean(
            target && target.scrollWidth <= target.clientWidth,
          ),
        };
      }),
    ).toEqual({ documentFits: true, panelFits: true });
    await page.locator(".topbar, .side-rail").evaluateAll((elements) => {
      for (const element of elements) {
        (element as HTMLElement).style.setProperty(
          "visibility",
          "hidden",
          "important",
        );
      }
    });
    await page.evaluate(async () => { await document.fonts.ready });
    await expect(panel).toHaveScreenshot(
      `${viewport.name}-audience-ai-panel.png`,
      { maxDiffPixelRatio: 0.001 },
    );
  });
}
