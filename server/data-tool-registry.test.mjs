import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DataToolRegistry } from "./data-tool-registry.mjs";

const REFERENCE = Object.freeze({
  conversationId: "conversation-email-001",
  jobId: "job-email-001",
  snapshotId: "job-r7",
  mode: "application",
});

function fixture({ outputDir = "C:\\copilot-test" } = {}) {
  const sent = [];
  const createdArtifacts = [];
  const artifact = {
    artifactId: "artifact-email-001",
    displayName: "selected-jobs.xlsx",
    size: 4_096,
    sha256: "a".repeat(64),
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    source: "xhs-data://jobs/job-email-001/applications",
    sourceRunId: "run-email-001",
    sourceToolRunId: "tool-email-001",
  };
  const policy = {
    authorizeTool() {
      return { job: { id: REFERENCE.jobId, outputDir } };
    },
    resourceUri(reference, resource) {
      return `xhs-data://jobs/${reference.jobId}/${resource}`;
    },
  };
  const registry = new DataToolRegistry({
    policy,
    artifactService: {
      async createArtifact(_reference, value) {
        createdArtifacts.push(structuredClone(value));
        return {
          artifact: {
            artifactId: "artifact-created-001",
            displayName: value.name,
            rowCount: value.data.length,
            sha256: "b".repeat(64),
            source: value.source,
            sourceRecordIds: value.sourceRecordIds,
            query: value.query,
          },
          duplicate: false,
        };
      },
      async resolveArtifact(_reference, artifactId) {
        assert.equal(artifactId, artifact.artifactId);
        return {
          artifact,
          absolutePath: "C:\\copilot-test\\selected-jobs.xlsx",
        };
      },
    },
    mailSender: {
      async send(message) {
        sent.push(structuredClone(message));
        return {
          messageId: "smtp-email-001",
          accepted: [message.to],
          rejected: [],
        };
      },
    },
  });
  return { registry, sent, artifact, createdArtifacts };
}

function emailInput() {
  return {
    to: "talent@example.test",
    cc: ["manager@example.test"],
    bcc: ["archive@example.test"],
    replyTo: "candidate@example.test",
    subject: "Selected data roles",
    text: "Attached are the selected roles.",
    attachmentIds: ["artifact-email-001", "artifact-email-001"],
    deliveryMethod: "smtp",
    deliverySource: "primary_outlook",
    jobRecordSource:
      "xhs-data://jobs/job-email-001/applications?selection=shortlist",
    qualityScore: 94,
  };
}

test("email preview contains the exact envelope, attachment provenance, delivery source, and quality score", async () => {
  const { registry, artifact } = fixture();
  const state = {};
  const result = await registry.execute("email.preview", emailInput(), {
    reference: REFERENCE,
    state,
  });

  assert.equal(result.type, "email.draft");
  assert.deepEqual(result.preview.cc, ["manager@example.test"]);
  assert.deepEqual(result.preview.bcc, ["archive@example.test"]);
  assert.equal(result.preview.replyTo, "candidate@example.test");
  assert.deepEqual(result.preview.attachmentIds, ["artifact-email-001"]);
  assert.deepEqual(result.preview.attachments, [
    {
      artifactId: artifact.artifactId,
      displayName: artifact.displayName,
      size: artifact.size,
      sha256: artifact.sha256,
      mediaType: artifact.mediaType,
      source: artifact.source,
      sourceRunId: artifact.sourceRunId,
      sourceToolRunId: artifact.sourceToolRunId,
    },
  ]);
  assert.equal(result.preview.deliveryMethod, "smtp");
  assert.equal(result.preview.deliverySource, "primary_outlook");
  assert.equal(result.preview.jobRecordSource, emailInput().jobRecordSource);
  assert.equal(result.preview.qualityScore, 94);
  assert.deepEqual(state.emailPreview, result.preview);
});

test("approved email delivery uses the same exact preview envelope and attachments", async () => {
  const { registry, sent } = fixture();
  const result = await registry.execute("email.send", emailInput(), {
    reference: REFERENCE,
    state: {},
    approved: true,
    idempotencyKey: "email-send-contract-001",
    deliveryAttemptId: "delivery-attempt-001",
  });

  assert.equal(result.type, "email.sent");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].cc, ["manager@example.test"]);
  assert.deepEqual(sent[0].bcc, ["archive@example.test"]);
  assert.equal(sent[0].replyTo, "candidate@example.test");
  assert.equal(sent[0].attachments[0].filename, "selected-jobs.xlsx");
  assert.equal(sent[0].idempotencyKey, "email-send-contract-001");
  assert.equal(result.preview.attachments[0].sha256, "a".repeat(64));
});

test("email delivery remains approval-gated and rejects invalid envelope metadata", async () => {
  const { registry } = fixture();
  await assert.rejects(
    registry.execute("email.send", emailInput(), {
      reference: REFERENCE,
      state: {},
    }),
    (error) => error.code === "COPILOT_APPROVAL_REQUIRED",
  );
  await assert.rejects(
    registry.execute(
      "email.preview",
      { ...emailInput(), cc: ["invalid-address"] },
      { reference: REFERENCE, state: {} },
    ),
    (error) => error.code === "COPILOT_EMAIL_INVALID",
  );
  await assert.rejects(
    registry.execute(
      "email.preview",
      { ...emailInput(), qualityScore: 101 },
      { reference: REFERENCE, state: {} },
    ),
    (error) => error.code === "COPILOT_EMAIL_QUALITY_INVALID",
  );
});

test("artifact export persists task, record, query, run, and row provenance", async () => {
  const { registry, createdArtifacts } = fixture();
  const result = await registry.execute(
    "artifact.create",
    {
      format: "xlsx",
      name: "shortlist.xlsx",
      rows: [
        { noteId: "note-001", title: "Data analyst" },
        { note_id: "note-002", title: "BI analyst" },
      ],
      query: "Shanghai",
      filters: [{ field: "city", op: "eq", value: "Shanghai" }],
      sortBy: "publishedAt",
      direction: "desc",
    },
    {
      reference: REFERENCE,
      state: {},
      runId: "run-export-001",
      toolRunId: "tool-export-001",
      idempotencyKey: "artifact-export-contract-001",
    },
  );

  assert.equal(result.type, "artifact.ready");
  assert.equal(createdArtifacts.length, 1);
  assert.equal(
    createdArtifacts[0].source,
    "xhs-data://jobs/job-email-001/applications",
  );
  assert.deepEqual(createdArtifacts[0].sourceRecordIds, [
    "note-001",
    "note-002",
  ]);
  assert.equal(createdArtifacts[0].sourceRecordCount, 2);
  assert.deepEqual(createdArtifacts[0].query, {
    dataset: "applications",
    query: "Shanghai",
    filters: [{ field: "city", op: "eq", value: "Shanghai" }],
    sortBy: "publishedAt",
    direction: "desc",
  });
  assert.equal(createdArtifacts[0].sourceRunId, "run-export-001");
  assert.equal(createdArtifacts[0].sourceToolRunId, "tool-export-001");
});

test("tool catalog exposes manifests and activates dynamically discovered capabilities", async () => {
  const { registry } = fixture();
  const manifest = registry.list();
  const audience = registry.search("评论用户与主页覆盖情况", { limit: 8 });
  const deepAudience = registry.search("深度受众策略", { limit: 8 });
  const state = {};
  const discovered = await registry.execute("tool.search", {
    query: "评论用户与主页覆盖情况",
    limit: 8,
  }, {
    reference: REFERENCE,
    state,
  });

  assert.ok(manifest.length >= 25);
  assert.ok(manifest.every((tool) => tool.version && tool.category && tool.inputSchema));
  assert.ok(audience.some((tool) => tool.name === "comments.query"));
  assert.ok(deepAudience.some((tool) => tool.name === "audience.research_brief"));
  assert.ok(manifest.some((tool) => tool.name === "audience.research_brief"));
  assert.ok(manifest.some((tool) => tool.name === "applications.compose_email"));
  assert.ok(manifest.some((tool) => tool.name === "applications.extract_email_requirements"));
  assert.equal(discovered.type, "tool.catalog");
  assert.ok(state.activeToolNames.includes("comments.query"));
  assert.ok(registry.describe(["comments.query"])[0].scopes.includes("audience:read"));
});

test("audience research brief separates records, unique text, signals, and evidence", async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "copilot-audience-research-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await Promise.all([
    writeFile(path.join(outputDir, "audience-posts.json"), JSON.stringify([
      { post_id: "post-style-001", title: "轻亚日常穿搭" },
    ]), "utf8"),
    writeFile(path.join(outputDir, "audience-comments.json"), JSON.stringify([
      {
        comment_id: "comment-001",
        post_id: "post-style-001",
        text: "上班能穿吗？求同款链接",
        likes: 20,
        location: "IP属地：上海",
        source_url: "https://example.test/comments/001",
        user: { user_id: "user-001" },
      },
      {
        comment_id: "comment-002",
        post_id: "post-style-001",
        parent_comment_id: "comment-001",
        text: "胳膊粗也能穿吗？",
        likes: 10,
        location: "广州",
        user: { user_id: "user-002" },
      },
      {
        comment_id: "comment-003",
        post_id: "post-style-001",
        text: "轻亚算不算亚文化，感觉被商业化了",
        likes: 30,
        user: { user_id: "user-003" },
      },
      {
        comment_id: "comment-004",
        post_id: "post-style-001",
        text: "轻亚算不算亚文化，感觉被商业化了",
        likes: 5,
        user: { user_id: "user-004" },
      },
    ]), "utf8"),
    writeFile(path.join(outputDir, "audience-users.json"), JSON.stringify([
      { user_id: "user-001", roles: ["commenter"], enrichment_status: "complete" },
      { user_id: "user-002", roles: ["commenter"], enrichment_status: "partial" },
      { user_id: "user-003", roles: ["author"], enrichment_status: "pending" },
      { user_id: "user-004", roles: ["commenter"], enrichment_status: "pending" },
    ]), "utf8"),
  ]);
  const { registry } = fixture({ outputDir });
  const result = await registry.execute("audience.research_brief", { exampleLimit: 2 }, {
    reference: REFERENCE,
    state: {},
  });

  assert.equal(result.type, "audience.research_brief");
  assert.equal(result.coverage.commentRecords, 4);
  assert.equal(result.coverage.uniqueCommentTexts, 3);
  assert.equal(result.coverage.repeatedTextRecords, 1);
  assert.equal(result.coverage.replyCommentRecords, 1);
  assert.equal(result.dataQuality.geography.recordsWithLocation, 2);
  assert.equal(result.dataQuality.geography.recordsWithoutLocation, 2);
  assert.deepEqual(result.dataQuality.profileCompletion, [
    { value: "pending", count: 2 },
    { value: "complete", count: 1 },
    { value: "partial", count: 1 },
  ]);
  assert.equal(result.participation.questionOrInformationSeekingRecords, 2);
  assert.equal(result.engagement.topComments[0].commentId, "comment-003");
  const identity = result.demandAndRiskSignals.find((signal) => signal.id === "identity_and_meaning");
  assert.equal(identity.evidence.commentRecords, 2);
  assert.equal(identity.evidence.uniqueCommentTexts, 1);
  assert.equal(identity.evidence.repeatedTextRecords, 1);
  assert.equal(identity.examples[0].commentId, "comment-003");
  assert.deepEqual(result.sources, ["xhs-data://jobs/job-email-001/audience"]);
});

test("batch email requirement extraction returns every application with auditable coverage", async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "copilot-email-requirements-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await writeFile(
    path.join(outputDir, "application_intelligence.json"),
    JSON.stringify({
      records: [
        {
          note_id: "note-format-001",
          title: "AI 产品实习生",
          body: "投递邮箱 first@example.test\n邮件标题：姓名-学校-应聘岗位",
          application_info: {
            contacts: [{ type: "email", value: "first@example.test" }],
          },
          job_card: { role_name: "AI 产品实习生", company_name: "甲公司" },
        },
        {
          note_id: "note-format-002",
          title: "数据分析实习生",
          body: "投递邮箱 second@example.test\n投递主题：应聘岗位｜姓名｜每周实习天数\n简历命名为：姓名-岗位-简历",
          application_info: {
            contacts: [{ type: "email", value: "second@example.test" }],
          },
          job_card: { role_name: "数据分析实习生", company_name: "乙公司" },
        },
        {
          note_id: "note-format-003",
          title: "商业分析实习生",
          body: "请通过招聘平台私信沟通。",
          job_card: { role_name: "商业分析实习生", company_name: "丙公司" },
        },
      ],
    }),
    "utf8",
  );
  const { registry } = fixture({ outputDir });
  const firstPage = await registry.execute(
    "applications.extract_email_requirements",
    { offset: 0, limit: 2 },
    { reference: REFERENCE, state: {} },
  );

  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.rows.length, 2);
  assert.equal(firstPage.coverage.scannedRecords, 3);
  assert.equal(firstPage.coverage.withRecipient, 2);
  assert.equal(firstPage.coverage.withSubjectRule, 2);
  assert.equal(firstPage.coverage.withAttachmentRule, 1);
  assert.equal(firstPage.coverage.missingAnyEmailRequirement, 1);
  assert.equal(firstPage.coverage.complete, false);
  assert.equal(firstPage.coverage.nextOffset, 2);
  assert.equal(firstPage.rows[0].subjectFormat, "姓名-学校-应聘岗位");
  assert.equal(firstPage.rows[1].subjectFormat, "应聘岗位｜姓名｜每周实习天数");

  const secondPage = await registry.execute(
    "applications.extract_email_requirements",
    { offset: firstPage.coverage.nextOffset, limit: 2 },
    { reference: REFERENCE, state: {} },
  );
  assert.deepEqual(secondPage.rows.map((row) => row.noteId), ["note-format-003"]);
  assert.equal(secondPage.rows[0].extractionStatus, "not_found");
  assert.deepEqual(secondPage.rows[0].missing, ["recipientEmail", "subjectFormat"]);
  assert.equal(secondPage.coverage.complete, true);
  assert.equal(secondPage.coverage.nextOffset, null);
  assert.equal(secondPage.truncated, false);
});

test("job email composition and delivery preview preserve the recruitment subject rule", async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "copilot-application-email-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  await writeFile(
    path.join(outputDir, "application_intelligence.json"),
    JSON.stringify({
      records: [
        {
          note_id: "note-application-001",
          title: "AI 产品经理实习生",
          body: "投递邮箱 talent@example.test\n邮件标题：姓名-学校-应聘岗位",
          application_info: {
            contacts: [{ type: "email", value: "talent@example.test" }],
          },
          job_card: {
            role_name: "AI 产品经理实习生",
            company_name: "示例科技",
          },
          media: {
            cover_url: "https://img.example.test/application-cover.webp",
          },
          outreach: { email_body: "您好，我希望应聘该岗位。" },
        },
      ],
    }),
    "utf8",
  );
  const { registry, sent } = fixture({ outputDir });
  const state = {};
  const draft = await registry.execute(
    "applications.compose_email",
    {
      noteId: "note-application-001",
      candidateName: "王梓楠",
      school: "示例大学",
    },
    { reference: REFERENCE, state },
  );

  assert.equal(draft.subject, "王梓楠-示例大学-AI 产品经理实习生");
  assert.equal(draft.subjectRule.status, "compliant");
  assert.deepEqual(draft.post.images, ["https://img.example.test/application-cover.webp"]);
  const preview = await registry.execute(
    "email.preview",
    {
      applicationNoteId: draft.noteId,
      to: draft.to,
      subject: draft.subject,
      text: draft.text,
      candidateName: "王梓楠",
      school: "示例大学",
    },
    { reference: REFERENCE, state },
  );
  assert.equal(preview.preview.application.subjectRule.status, "compliant");
  assert.deepEqual(preview.preview.application.post.images, draft.post.images);

  await registry.execute(
    "email.send",
    {
      applicationNoteId: draft.noteId,
      to: draft.to,
      subject: "随意标题",
      text: draft.text,
      candidateName: "王梓楠",
      school: "示例大学",
    },
    { reference: REFERENCE, state, approved: true },
  );
  assert.equal(sent.at(-1).subject, draft.subject);
});

test("job email delivery blocks a recruitment slogan until a precise role is recovered", async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "copilot-application-title-guard-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const noisyTitle = "急急急！有8月能来实习的吗？聘继任";
  await writeFile(
    path.join(outputDir, "application_intelligence.json"),
    JSON.stringify({
      records: [
        {
          note_id: "note-noisy-title-001",
          title: noisyTitle,
          body: "投递邮箱 talent@example.test",
          application_info: {
            contacts: [{ type: "email", value: "talent@example.test" }],
          },
          outreach: {
            email_subject: noisyTitle,
            email_body: "您好，我希望应聘贵公司的实习岗位。",
          },
        },
      ],
    }),
    "utf8",
  );
  const { registry, sent } = fixture({ outputDir });

  await assert.rejects(
    registry.execute(
      "email.send",
      {
        applicationNoteId: "note-noisy-title-001",
        to: "talent@example.test",
        subject: noisyTitle,
        text: "您好，我希望应聘贵公司的实习岗位。",
        candidateName: "王梓楠",
      },
      { reference: REFERENCE, state: {}, approved: true },
    ),
    (error) => error.code === "COPILOT_APPLICATION_SUBJECT_TITLE_REVIEW_REQUIRED",
  );
  assert.equal(sent.length, 0);
});
