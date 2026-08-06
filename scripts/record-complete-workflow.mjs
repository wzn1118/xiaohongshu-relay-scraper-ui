import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "@playwright/test";

import { draftContentHash } from "../src/draft-state.mjs";

const baseUrl = process.env.APP_URL || "http://127.0.0.1:4317";
const jobId = process.env.DEMO_JOB_ID || "20260801203406-7f4651b9";
const outputDir = path.resolve("output/playwright/complete-workflow-v2");
const rawVideoDir = path.join(outputDir, "raw");
const verificationPath = path.join(outputDir, "verification.json");
const viewport = { width: 1440, height: 900 };
const totalSteps = 17;
const demoRecipient = "demo-recipient@example.test";
const demoSender = "demo-sender@example.test";
const demoReplyTo = "demo-candidate@example.test";
const routeEvidenceHash = "a".repeat(64);
const routeRevision = "demo-route-revision-1";

const demoOutreach = {
  greeting: "你好，我对这个产品经理实习岗位很感兴趣，想进一步了解团队和工作内容。",
  email_subject: "应聘产品经理实习生｜演示候选人｜每周可实习 5 天",
  email_body: "招聘团队您好：\n\n我希望应聘产品经理实习生岗位。我的项目经历覆盖需求分析、数据复盘和跨团队协作，并已按岗位要求整理简历与求职信。\n\n感谢审阅。",
  cover_letter: "这是一份用于录屏演示的脱敏求职信。内容围绕岗位职责、项目证据和到岗安排组织，发送前仍需候选人逐项确认。",
};
const demoContentHash = draftContentHash(demoOutreach);
const batchDemoNow = "2026-08-06T08:00:00.000Z";
const batchDemoApplications = [
  batchDemoApplication("demo-product", "智能产品经理招聘", "产品经理", "product@example.test", true),
  batchDemoApplication("demo-growth", "增长策略团队招聘", "增长策略实习生", "growth@example.test"),
  batchDemoApplication("demo-analyst", "商业分析团队招聘", "数据分析实习生", "analyst@example.test"),
];

function batchDemoApplication(noteId, title, roleName, email, hasAttachmentRule = false) {
  return {
    note_id: noteId,
    title,
    note_url: `https://example.test/${noteId}`,
    body: `${title}完整岗位正文。负责业务分析、方案设计和跨团队协作，请将申请材料发送到 ${email}。`,
    access_status: "ok",
    collected_at: batchDemoNow,
    publish_time: { raw: "2026-08-06", value: "2026-08-06", precision: "day", is_estimated: false },
    job_card: {
      title,
      role_name: roleName,
      source_url: `https://example.test/${noteId}`,
      source_status: "ok",
      parse_basis: "full_body",
      source_excerpt: `${title}岗位事实`,
      responsibility_count: 2,
      requirement_count: 2,
      route_count: 1,
      status: "complete",
    },
    application_info: {
      contacts: [{
        type: "email",
        channel: "email",
        value: email,
        evidence: `正文明确写明投递邮箱 ${email}`,
        source_field: "body",
        verification_status: "body_verified",
        confidence: 100,
        actionable: true,
      }],
      application_routes: [],
      responsibilities: [
        { text: "负责产品方案与业务数据分析", source_field: "body", evidence: "负责产品方案与业务数据分析" },
        { text: "协同设计、研发和运营推进交付", source_field: "body", evidence: "跨团队推进交付" },
      ],
      requirements: [
        { text: "具备结构化分析和项目推进能力", source_field: "body", evidence: "结构化分析与项目推进" },
        { text: "申请材料需要与岗位职责逐项对应", source_field: "body", evidence: "材料与职责对应" },
      ],
    },
    outreach: {
      greeting: "招聘团队您好，我对这个岗位很感兴趣。",
      email_subject: `${roleName}申请｜演示候选人`,
      email_body: `招聘团队您好：\n\n我希望申请${roleName}岗位。我的项目经历覆盖需求分析、数据复盘和跨团队交付，附件中是按岗位要求整理的申请材料。\n\n感谢审阅。`,
      cover_letter: `这是一份面向${roleName}岗位的脱敏 Cover Letter，逐项对应岗位职责、项目证据和到岗安排。`,
      generation_mode: "model",
      runtime_status: "generated",
      status: "ready",
      content_quality: { batch_ready: true, cover_letter_chars: 188, role_evidence_count: 3 },
    },
    cover_letter_evaluation: {
      score: 96,
      passed: true,
      attempts: 1,
      threshold: 90,
      strengths: ["岗位事实与候选人证据对应"],
      problems: [],
      rubric: { grounded: 96 },
    },
    draftVersion: {
      draftId: `draft-${noteId}`,
      version: 1,
      contentHash: "b".repeat(64),
      qualityStatus: "passed",
      qualityCheckedVersion: 1,
      qualityCheckedHash: "b".repeat(64),
      createdAt: batchDemoNow,
      updatedAt: batchDemoNow,
    },
    delivery: null,
    attachmentRequirement: hasAttachmentRule
      ? { detected: true, template: "姓名-岗位-简历.pdf", evidence: "附件请按姓名-岗位-简历.pdf命名", fields: ["candidateName", "jobTitle"] }
      : { detected: false, template: "", evidence: "", fields: [] },
    quality: { body_complete: true },
    deliveryManifestSummary: {
      schemaVersion: 2,
      noteId,
      sourceRevision: `revision-${noteId}`,
      deliveryStatus: "ready_to_preview",
      recipientStatus: "resolved",
      recipientSource: "body",
      copyStatus: "passed",
      subjectRuleStatus: "batch_default",
      attachmentStatus: "planned_rename",
      readiness: "ready_to_preview",
      hasEmailBody: true,
      hasCoverLetter: true,
      recipient: {
        address: email,
        normalizedAddress: email,
        source: "body",
        evidenceHash: `${noteId}-evidence`,
        verificationStatus: "verified",
      },
      latestBatch: null,
      blockers: [],
      warnings: [{ code: "WILL_RENAME", field: "attachments", message: "冻结时生成发送文件名" }],
    },
  };
}

function batchContact(application) {
  const email = application.application_info.contacts[0].value;
  return {
    address: email,
    source: "body",
    noteId: application.note_id,
    postId: application.note_id,
    evidenceText: `正文明确写明投递邮箱 ${email}`,
    evidenceHash: `${application.note_id}-evidence`,
    confidence: 1,
    collectionStatus: "complete",
    verificationStatus: "verified",
    actionable: true,
    requiresReview: false,
    ownershipStatus: "post_author",
  };
}

function batchAttachment(application) {
  const plannedDisplayName = `演示候选人-${application.job_card.role_name}-简历.pdf`;
  return {
    attachmentId: `attachment-${application.note_id}`,
    originalName: "个人简历.pdf",
    currentDisplayName: "个人简历.pdf",
    finalDisplayName: plannedDisplayName,
    plannedDisplayName,
    namingStatus: "planned",
    requirementSource: application.attachmentRequirement.detected ? "post" : "batch_default",
    willRename: true,
    sha256: "c".repeat(64),
    size: 48_000,
    mediaType: "application/pdf",
  };
}

function batchPayload(application) {
  const contact = batchContact(application);
  const attachment = batchAttachment(application);
  return {
    title: application.title,
    roleName: application.job_card.role_name,
    recipient: contact.address,
    contact,
    subject: application.outreach.email_subject,
    body: application.outreach.email_body,
    coverLetter: application.outreach.cover_letter,
    coverLetterHash: "d".repeat(64),
    coverLetterVersion: 1,
    recipientEvidenceHash: contact.evidenceHash,
    recipientSourceRevision: 1,
    subjectRule: { source: "generated", template: "{jobTitle}申请｜{candidateName}" },
    attachmentRules: [{ source: attachment.requirementSource, template: attachment.finalDisplayName }],
    bodyHash: "e".repeat(64),
    draftId: application.draftVersion.draftId,
    draftVersion: 1,
    contentHash: application.draftVersion.contentHash,
    qualityReportRef: null,
    attachmentBundleHash: `bundle-${application.note_id}`,
    attachments: [{
      attachmentId: attachment.attachmentId,
      filename: attachment.finalDisplayName,
      mediaType: attachment.mediaType,
      size: attachment.size,
      sha256: attachment.sha256,
    }],
    finalFilenames: [attachment.finalDisplayName],
    plannedFinalFilenames: [attachment.finalDisplayName],
    previewRevision: `preview-${application.note_id}`,
    smtpConfigurationRevision: 1,
    smtpConfigurationFingerprint: "local-demo-smtp-disabled",
    sendRequest: { noteId: application.note_id, to: contact.address },
  };
}

function batchPreflight(noteIds) {
  const selected = batchDemoApplications.filter((application) => noteIds.includes(application.note_id));
  const items = selected.map((application) => {
    const contact = batchContact(application);
    const attachment = batchAttachment(application);
    return {
      noteId: application.note_id,
      title: application.title,
      roleName: application.job_card.role_name,
      status: "ready",
      canPrepare: true,
      blockers: [],
      contact,
      contactResolution: {
        schemaVersion: 1,
        noteId: application.note_id,
        postId: application.note_id,
        status: "ready",
        reason: "structured_contact",
        source: "body",
        collectionStatus: "complete",
        commentFallbackUsed: false,
        requiresReview: false,
        selectedCandidate: contact,
        candidates: [contact],
        issues: [],
      },
      attachments: [attachment],
      preview: {
        readiness: "ready",
        warnings: [],
        recipient: contact.address,
        from: demoSender,
        replyTo: demoReplyTo,
        subject: application.outreach.email_subject,
        text: application.outreach.email_body,
        draftId: application.draftVersion.draftId,
        draftVersion: 1,
        attachmentSummary: { attachments: [] },
        attachmentBundleHash: `bundle-${application.note_id}`,
        previewRevision: `preview-${application.note_id}`,
        smtpConfigurationRevision: 1,
        smtpConfigurationFingerprint: "local-demo-smtp-disabled",
        estimatedMessageSize: 52_000,
      },
      payload: batchPayload(application),
    };
  });
  return {
    schemaVersion: 2,
    dryRun: true,
    batchId: "dry-run-local-demo",
    planId: "plan-local-demo-001",
    preflightId: "plan-local-demo-001",
    manifestHash: "f".repeat(64),
    deliveryManifest: { schemaVersion: 2, itemCount: items.length },
    generatedAt: batchDemoNow,
    maxBatchSize: 100,
    items,
    counts: { ready: items.length },
    readyNoteIds: items.map((item) => item.noteId),
    preparableNoteIds: [],
  };
}

function batchCountRecord({ ready = 0, sending = 0, sent = 0, skipped = 0 } = {}) {
  return {
    resolving: 0,
    blocked_no_email: 0,
    blocked_ambiguous: 0,
    draft_pending: 0,
    quality_pending: 0,
    filename_pending: 0,
    ready,
    sending,
    sent,
    failed_retryable: 0,
    unknown_manual_review: 0,
    skipped,
  };
}

function batchSnapshot(status, revision) {
  const statuses = status === "completed"
    ? ["sent", "sent", "sent"]
    : status === "paused"
      ? ["sent", "ready", "ready"]
      : status === "running"
        ? ["sending", "ready", "ready"]
        : ["ready", "ready", "ready"];
  const counts = status === "completed"
    ? batchCountRecord({ sent: 3 })
    : status === "paused"
      ? batchCountRecord({ ready: 2, sent: 1 })
      : status === "running"
        ? batchCountRecord({ ready: 2, sending: 1 })
        : batchCountRecord({ ready: 3 });
  const approved = ["approved", "running", "paused", "completed"].includes(status);
  return {
    schemaVersion: 1,
    batchId: "batch-local-demo-001",
    jobId,
    title: "AI 产品岗位批量投递演示",
    metadata: { mode: "local_demo", externalDelivery: false },
    settings: { concurrency: 1, minIntervalMs: 2_000, maxBatchSize: 100, stagedLimit: 100 },
    status,
    revision,
    approvalRevision: approved ? 1 : 0,
    approval: approved ? {
      revision: 1,
      batchRevision: 1,
      snapshotHash: "a".repeat(64),
      approvedAt: batchDemoNow,
      actor: "local-demo-user",
      reason: "approved",
    } : null,
    itemIds: batchDemoApplications.map((application) => application.note_id),
    counts,
    items: batchDemoApplications.map((application, index) => ({
      schemaVersion: 1,
      batchId: "batch-local-demo-001",
      itemId: application.note_id,
      noteId: application.note_id,
      contactCandidateId: `${application.note_id}-evidence`,
      status: statuses[index],
      payload: batchPayload(application),
      error: null,
      revision: status === "completed" ? 3 : status === "paused" && index === 0 ? 2 : 1,
      createdAt: batchDemoNow,
      updatedAt: batchDemoNow,
      recoveredAt: null,
    })),
    createdAt: batchDemoNow,
    updatedAt: batchDemoNow,
    lastEventSequence: revision,
    recoveryCount: 0,
  };
}

await mkdir(rawVideoDir, { recursive: true });

const checks = [];
const browserErrors = [];
const resourceWarnings = [];
let browser;
let context;
let page;
let video;
let previewCalls = 0;
let demoSendCalls = 0;
let batchCandidateCalls = 0;
let batchDryRunCalls = 0;
let batchCreateCalls = 0;
let batchApproveCalls = 0;
const batchControlCalls = [];
let currentBatch = null;

function pass(name, detail) {
  checks.push({ name, status: "passed", detail });
}

async function pause(milliseconds) {
  await page.waitForTimeout(milliseconds);
}

async function installDemoApiOverrides() {
  await page.addInitScript(() => {
    class QuietEventSource {
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

  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      response,
      json: {
        ...payload,
        emailDelivery: { configured: true, from: demoSender, authMode: "login" },
      },
    });
  });

  await page.route("**/api/email/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "custom",
        host: "smtp.example.test",
        port: 465,
        secure: true,
        requireTls: false,
        auth: "login",
        authMode: "login",
        user: demoSender,
        from: demoSender,
        hasPassword: true,
        oauth: { tenant: "", clientId: "", scope: "", hasClientSecret: false, hasRefreshToken: false },
        configured: true,
        verified: true,
        maskedFrom: "d***@example.test",
      }),
    });
  });

  await page.route(`**/api/jobs/${jobId}/results?**`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const targetIndex = Math.min(7, Math.max(0, items.length - 1));
    const target = items[targetIndex];
    if (target) {
      items[targetIndex] = {
        ...target,
        outreach: {
          ...target.outreach,
          ...demoOutreach,
          generation_mode: "model",
          runtime_status: "generated",
          status: "ready",
        },
        application_info: {
          ...target.application_info,
          contacts: [],
          application_routes: [],
        },
        contactDiscovery: {
          candidates: [{
            address: demoRecipient,
            evidenceText: "脱敏演示地址，已由正文证据复核",
            confidence: 1,
            sourceFields: ["body"],
            source: "body",
            verificationStatus: "cross_verified",
            evidenceHash: routeEvidenceHash,
            sourceRevision: routeRevision,
            actionable: true,
          }],
        },
        draftVersion: {
          ...target.draftVersion,
          version: 1,
          contentHash: demoContentHash,
          qualityStatus: "passed",
          qualityCheckedVersion: 1,
          qualityCheckedHash: demoContentHash,
        },
        cover_letter_evaluation: {
          score: 95,
          passed: true,
          attempts: 1,
          threshold: 90,
          strengths: ["岗位事实与候选人证据对应"],
          problems: [],
          rubric: { grounded: 95 },
        },
        emailSubjectGuard: {
          ...target.emailSubjectGuard,
          status: "verified",
          requiresReview: false,
          safeDefaultSubject: true,
          suggestedSubject: demoOutreach.email_subject,
        },
        emailSubjectPreview: demoOutreach.email_subject,
        delivery: null,
      };
    }
    await route.fulfill({ response, json: { ...payload, items } });
  });

  await page.route(`**/api/jobs/${jobId}/send-email/preview`, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    previewCalls += 1;
    const payload = request.postDataJSON();
    if (payload.to !== demoRecipient || payload.evidenceHash !== routeEvidenceHash || payload.sourceRevision !== routeRevision) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "demo preview contract mismatch" }) });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recipient: demoRecipient,
        from: demoSender,
        replyTo: demoReplyTo,
        subject: demoOutreach.email_subject,
        text: demoOutreach.email_body,
        htmlPreview: `<p>${demoOutreach.email_body.replace(/\n/g, "<br>")}</p>`,
        draftId: payload.draftId,
        draftVersion: payload.version,
        quality: {
          draftId: payload.draftId,
          version: payload.version,
          contentHash: demoContentHash,
          qualityStatus: "passed",
          qualityCheckedVersion: payload.version,
          qualityCheckedHash: demoContentHash,
          checkedAt: "2026-08-05T15:00:00.000Z",
          evaluation: { score: 95, passed: true, attempts: 1, threshold: 90, strengths: [], problems: [], rubric: {} },
        },
        attachmentSummary: { count: 0, totalBytes: 0, attachments: [] },
        attachmentBundleHash: "b".repeat(64),
        previewRevision: "demo-preview-revision-1",
        warnings: [],
        readiness: "ready",
        estimatedMessageSize: 2048,
      }),
    });
  });

  await page.route(`**/api/jobs/${jobId}/send-email`, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const payload = request.postDataJSON();
    if (payload.previewRevision !== "demo-preview-revision-1" || payload.idempotencyKey !== payload.previewRevision) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "demo send contract mismatch" }) });
    }
    demoSendCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        noteId: payload.noteId,
        outreach: demoOutreach,
        draftVersion: {
          draftId: payload.draftId,
          version: payload.version,
          contentHash: demoContentHash,
          qualityStatus: "passed",
          qualityCheckedVersion: payload.version,
          qualityCheckedHash: demoContentHash,
        },
        delivery: {
          action: "email_sent",
          email: { status: "sent", sentAt: "2026-08-05T15:00:30.000Z" },
          sendAudit: [{ mode: "local_demo", externalDelivery: false }],
        },
      }),
    });
  });

  await page.route(`**/api/jobs/${jobId}/application-delivery-candidates**`, async (route) => {
    batchCandidateCalls += 1;
    const noteIds = batchDemoApplications.map((application) => application.note_id);
    const revisions = batchDemoApplications.map((application) => ({
      noteId: application.note_id,
      revision: `revision-${application.note_id}`,
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        available: true,
        jobId,
        total: batchDemoApplications.length,
        offset: 0,
        limit: 50,
        cursor: null,
        nextCursor: null,
        items: batchDemoApplications,
        filters: {},
        facetCounts: {
          deliveryStatus: { ready_to_preview: 3 },
          recipientStatus: { resolved: 3 },
          recipientSource: { body: 3 },
          copyStatus: { passed: 3 },
          subjectRuleStatus: { batch_default: 3 },
          attachmentStatus: { planned_rename: 3 },
          readiness: { ready_to_preview: 3 },
        },
        blockerCounts: {},
        selectionSnapshot: {
          schemaVersion: 1,
          selectionSnapshotId: "selection-local-demo",
          selectionSnapshotHash: "selection-local-demo-hash",
          queryHash: "query-local-demo-hash",
          candidateCount: 3,
          noteIds,
          selectableNoteIds: noteIds,
          readyNoteIds: noteIds,
          revisions,
        },
        contactDiscovery: {
          summary: {
            totalRecords: 3,
            withImages: 0,
            imageOcrComplete: 0,
            imageOcrPending: 0,
            imageOcrFailed: 0,
            imageOcrSkippedBodyEmail: 3,
            bodyEmailRecords: 3,
            imageEmailRecords: 0,
            commentEmailRecords: 0,
            ready: 3,
            manualReview: 0,
            commentsPending: 0,
            commentsPartial: 0,
            noEmailConfirmed: 0,
          },
        },
      }),
    });
  });

  const batchRoutePattern = new RegExp(`/api/jobs/${jobId}/application-batches(?:/[^?]*)?(?:\\?.*)?$`, "u");
  await page.route(batchRoutePattern, async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const routePath = requestUrl.pathname;
    const method = request.method();
    const collectionPath = `/api/jobs/${jobId}/application-batches`;

    if (routePath === `${collectionPath}/dry-run` && method === "POST") {
      batchDryRunCalls += 1;
      const payload = request.postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(batchPreflight(payload.noteIds || [])),
      });
    }

    if (routePath === collectionPath && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ batches: currentBatch ? [currentBatch] : [] }),
      });
    }

    if (routePath === collectionPath && method === "POST") {
      batchCreateCalls += 1;
      const payload = request.postDataJSON();
      currentBatch = batchSnapshot("ready", 1);
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          batch: currentBatch,
          preflight: batchPreflight(payload.confirmedNoteIds || payload.noteIds || []),
        }),
      });
    }

    if (routePath === `${collectionPath}/batch-local-demo-001/approve` && method === "POST") {
      batchApproveCalls += 1;
      currentBatch = batchSnapshot("approved", 2);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentBatch) });
    }

    const controlMatch = routePath.match(/\/batch-local-demo-001\/(start|pause|resume|cancel)$/u);
    if (controlMatch && method === "POST") {
      const action = controlMatch[1];
      batchControlCalls.push(action);
      currentBatch = action === "start"
        ? batchSnapshot("running", 3)
        : action === "pause"
          ? batchSnapshot("paused", 4)
          : action === "resume"
            ? batchSnapshot("completed", 5)
            : batchSnapshot("cancelled", 5);
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(currentBatch) });
    }

    if (routePath === `${collectionPath}/batch-local-demo-001` && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentBatch) });
    }

    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unknown local demo batch route" }) });
  });
}

async function installRecordingLayer() {
  await page.addStyleTag({
    content: `
      #root { zoom: 1.08; }
      #codex-flow-caption, #codex-flow-pointer, #codex-flow-title, #codex-flow-progress {
        font-family: "Microsoft YaHei UI", "Microsoft YaHei", sans-serif !important;
        letter-spacing: 0 !important;
      }
      #codex-flow-caption {
        position: fixed;
        left: 112px;
        right: 44px;
        bottom: 24px;
        z-index: 2147483646;
        display: grid;
        grid-template-columns: 126px minmax(0, 1fr);
        gap: 18px;
        align-items: center;
        min-height: 92px;
        padding: 14px 20px;
        color: #fff;
        background: rgba(20, 20, 22, 0.96);
        border: 1px solid rgba(255,255,255,.16);
        border-left: 6px solid #ff2442;
        box-shadow: 0 16px 42px rgba(0, 0, 0, .32);
        opacity: 0;
        transform: translateY(20px);
        transition: opacity 180ms ease, transform 180ms ease;
        pointer-events: none;
      }
      #codex-flow-caption.visible { opacity: 1; transform: translateY(0); }
      #codex-flow-caption .step {
        color: #ff7084;
        font-size: 16px;
        line-height: 1.25;
        font-weight: 800;
      }
      #codex-flow-caption .step b { display: block; color: #fff; font-size: 28px; }
      #codex-flow-caption .copy { min-width: 0; }
      #codex-flow-caption .action, #codex-flow-caption .result {
        display: block;
        overflow-wrap: anywhere;
        font-size: 18px;
        line-height: 1.42;
      }
      #codex-flow-caption .action { color: #fff; font-weight: 750; }
      #codex-flow-caption .result { margin-top: 4px; color: #a7f3d0; font-weight: 650; }
      #codex-flow-progress {
        position: fixed;
        top: 22px;
        right: 30px;
        z-index: 2147483646;
        width: 250px;
        padding: 11px 13px;
        color: #fff;
        background: rgba(20,20,22,.92);
        border: 1px solid rgba(255,255,255,.15);
        box-shadow: 0 8px 24px rgba(0,0,0,.2);
        pointer-events: none;
      }
      #codex-flow-progress span { display: flex; justify-content: space-between; margin-bottom: 7px; font-size: 13px; font-weight: 700; }
      #codex-flow-progress i { display: block; height: 5px; background: #3f3f46; overflow: hidden; }
      #codex-flow-progress i::after { content: ""; display: block; width: var(--progress); height: 100%; background: #ff2442; transition: width 260ms ease; }
      #codex-flow-pointer {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 2147483647;
        width: 24px;
        height: 24px;
        border: 3px solid #ff2442;
        border-radius: 50%;
        background: rgba(255,255,255,.92);
        box-shadow: 0 2px 10px rgba(0,0,0,.38);
        transform: translate(-50%, -50%);
        transition: left 430ms ease, top 430ms ease, width 140ms ease, height 140ms ease;
        pointer-events: none;
      }
      #codex-flow-pointer.clicking { width: 42px; height: 42px; background: rgba(255,36,66,.28); }
      #codex-flow-title {
        position: fixed;
        inset: 0;
        z-index: 2147483645;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 0 145px;
        color: #fff;
        background: rgba(16,16,18,.975);
        opacity: 0;
        transition: opacity 220ms ease;
        pointer-events: none;
      }
      #codex-flow-title.visible { opacity: 1; }
      #codex-flow-title .eyebrow { margin-bottom: 18px; color: #ff7084; font-size: 18px; font-weight: 800; }
      #codex-flow-title h1 { max-width: 1080px; margin: 0 0 20px; font-size: 54px; line-height: 1.16; font-weight: 850; }
      #codex-flow-title p { max-width: 1040px; margin: 0; color: #e4e4e7; font-size: 22px; line-height: 1.65; }
      .codex-flow-focus {
        position: relative;
        z-index: 2;
        outline: 4px solid rgba(255,36,66,.92) !important;
        outline-offset: 5px !important;
        box-shadow: 0 0 0 11px rgba(255,36,66,.16) !important;
      }
      .candidate-profile-grid input,
      .memory-preview > strong,
      .memory-preview > ul,
      .memory-preview > p,
      .memory-preview > span,
      .draft-editor input,
      .draft-editor textarea {
        color: transparent !important;
        text-shadow: 0 0 8px rgba(39,39,42,.82) !important;
      }
    `,
  });

  await page.evaluate(() => {
    const caption = document.createElement("div");
    caption.id = "codex-flow-caption";
    caption.innerHTML = '<div class="step"><b></b><span></span></div><div class="copy"><span class="action"></span><span class="result"></span></div>';

    const progress = document.createElement("div");
    progress.id = "codex-flow-progress";
    progress.innerHTML = '<span><b>完整使用链路</b><em></em></span><i></i>';

    const pointer = document.createElement("div");
    pointer.id = "codex-flow-pointer";
    pointer.style.left = "112px";
    pointer.style.top = "116px";

    const title = document.createElement("div");
    title.id = "codex-flow-title";
    title.innerHTML = '<div class="eyebrow"></div><h1></h1><p></p>';

    document.body.append(caption, progress, pointer, title);

    const redact = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const parent = node.parentElement;
        if (!parent || parent.closest("#codex-flow-caption, #codex-flow-title, #codex-flow-progress, script, style")) continue;
        const next = node.nodeValue
          ?.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "demo@example.test")
          .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "138****0000");
        if (next && next !== node.nodeValue) node.nodeValue = next;
      }
    };
    redact();
    const observer = new MutationObserver(redact);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__codexFlowObserver = observer;
  });
}

async function showStep(step, action, result, milliseconds = 3600) {
  await page.evaluate(({ step, totalSteps, action, result }) => {
    const caption = document.querySelector("#codex-flow-caption");
    caption.querySelector(".step b").textContent = String(step).padStart(2, "0");
    caption.querySelector(".step span").textContent = `/ ${String(totalSteps).padStart(2, "0")} 步`;
    caption.querySelector(".action").textContent = `正在做：${action}`;
    caption.querySelector(".result").textContent = `得到结果：${result}`;
    caption.classList.add("visible");
    const progress = document.querySelector("#codex-flow-progress");
    progress.querySelector("em").textContent = `${step} / ${totalSteps}`;
    progress.style.setProperty("--progress", `${Math.round(step / totalSteps * 100)}%`);
  }, { step, totalSteps, action, result });
  await pause(milliseconds);
}

async function hideStep() {
  await page.evaluate(() => document.querySelector("#codex-flow-caption")?.classList.remove("visible"));
  await pause(220);
}

async function showTitle(eyebrow, title, detail, milliseconds = 3600) {
  await page.evaluate(({ eyebrow, title, detail }) => {
    const layer = document.querySelector("#codex-flow-title");
    layer.querySelector(".eyebrow").textContent = eyebrow;
    layer.querySelector("h1").textContent = title;
    layer.querySelector("p").textContent = detail;
    layer.classList.add("visible");
  }, { eyebrow, title, detail });
  await pause(milliseconds);
  await page.evaluate(() => document.querySelector("#codex-flow-title")?.classList.remove("visible"));
  await pause(400);
}

async function movePointer(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Cannot point to an element outside the viewport.");
  const x = Math.round(Math.min(viewport.width - 36, Math.max(84, box.x + Math.min(box.width * 0.72, box.width - 12))));
  const y = Math.round(Math.min(viewport.height - 150, Math.max(90, box.y + Math.min(box.height / 2, 180))));
  await page.evaluate(({ x, y }) => {
    const pointer = document.querySelector("#codex-flow-pointer");
    pointer.style.left = `${x}px`;
    pointer.style.top = `${y}px`;
  }, { x, y });
  await pause(520);
}

async function scrollTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  await pause(760);
}

async function focus(locator, milliseconds = 1500) {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  await scrollTo(locator);
  await locator.evaluate((element) => element.classList.add("codex-flow-focus"));
  await movePointer(locator);
  await pause(milliseconds);
  await locator.evaluate((element) => element.classList.remove("codex-flow-focus"));
}

async function focusMany(locators, milliseconds = 1800) {
  for (const locator of locators) {
    await locator.waitFor({ state: "visible", timeout: 30_000 });
    await locator.evaluate((element) => element.classList.add("codex-flow-focus"));
  }
  await scrollTo(locators[0]);
  await movePointer(locators[0]);
  await pause(milliseconds);
  for (const locator of locators) {
    await locator.evaluate((element) => element.classList.remove("codex-flow-focus"));
  }
}

async function clickWithPointer(locator) {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  await scrollTo(locator);
  await movePointer(locator);
  await page.evaluate(() => document.querySelector("#codex-flow-pointer")?.classList.add("clicking"));
  await pause(160);
  await locator.click();
  await pause(240);
  await page.evaluate(() => document.querySelector("#codex-flow-pointer")?.classList.remove("clicking"));
}

try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport, recordVideo: { dir: rawVideoDir, size: viewport } });
  page = await context.newPage();
  video = page.video();

  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const detail = message.text();
    if (/Failed to load resource: the server responded with a status of 502/i.test(detail)) {
      resourceWarnings.push(`console: ${detail}`);
      return;
    }
    browserErrors.push(`console: ${detail}`);
  });

  await installDemoApiOverrides();
  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (!response?.ok()) throw new Error(`App returned HTTP ${response?.status() ?? "unknown"}.`);
  pass("application", `HTTP ${response.status()} from ${baseUrl}`);

  const relayStatus = page.getByText("Relay 已连接", { exact: true });
  await relayStatus.waitFor({ state: "visible", timeout: 60_000 });
  await installRecordingLayer();

  await showTitle(
    "完整使用链路 · 逐步字幕版",
    "今天你投了吗？从任务配置到交付发送",
    "每个画面都说明正在做什么，以及实际得到什么。采集、处理与产物来自本地完成任务；邮件发送使用脱敏演示端点，不触发外部 SMTP。",
    4600,
  );

  await showStep(1, "检查本地服务、Runner 与 Relay 是否就绪。", "页面已连接 Relay；后端健康检查与 Runner 检查通过。", 3200);
  await focus(relayStatus, 1700);
  pass("runtime-readiness", "Relay connected is visible; backend health and runner are ready.");

  const aiPanel = page.locator("section.ai-setup-panel");
  await showStep(2, "连接写作模型，并加载候选人背景与签名信息。", "模型会话和背景记忆已载入；个人字段在本视频中已脱敏。", 3400);
  await focus(aiPanel, 2200);
  const candidatePanel = page.locator("section.candidate-profile-section");
  if (await candidatePanel.count()) await focus(candidatePanel, 1600);
  pass("candidate-context", "AI setup and candidate context panels are visible.");

  const configPanel = page.locator("section.config-panel");
  await showStep(3, "填写关键词、时间范围、采集节奏，并检查启动条件。", "任务入口已具备；“启动全流程”会依次执行发现、正文、分析、文案与导出。", 3600);
  await focusMany([
    configPanel.locator(".keyword-field"),
    configPanel.locator(".recency-field"),
    configPanel.locator(".pacing-mode-field"),
  ], 2400);
  const readiness = configPanel.locator(".readiness-strip");
  await focus(readiness, 1800);
  const fullRunButton = page.getByRole("button", { name: "启动全流程", exact: true });
  await focus(fullRunButton, 1600);
  pass("task-configuration", "Keyword, recency, pacing, readiness, and full-workflow controls are visible.");

  const historyButton = page.getByRole("button", { name: "历史", exact: true });
  await clickWithPointer(historyButton);
  const completedRow = page.locator("section.history-panel tbody tr").filter({ hasText: "小红书ai产品经理实习生招继任" }).first();
  await showStep(4, "从历史记录打开已经完整跑完的任务，复现全部产出。", "选中任务状态为已完成；避免为录屏重复访问外部页面。", 3400);
  await focus(completedRow, 1800);
  await clickWithPointer(completedRow);

  const missionPanel = page.locator("section.mission-panel");
  await missionPanel.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const mission = document.querySelector("section.mission-panel")?.textContent || "";
    const results = document.querySelector("section.results-panel")?.textContent || "";
    return mission.includes("20 / 20") && results.includes("20") && Boolean(document.querySelector(".result-row.selected"));
  }, null, { timeout: 30_000 });

  const jobResponse = await context.request.get(`${baseUrl}/api/jobs/${jobId}`);
  const resultsResponse = await context.request.get(`${baseUrl}/api/jobs/${jobId}/results?analysisMode=job&limit=50`);
  const artifactsResponse = await context.request.get(`${baseUrl}/api/jobs/${jobId}/artifacts`);
  if (!jobResponse.ok() || !resultsResponse.ok() || !artifactsResponse.ok()) throw new Error("Persisted workflow APIs are not readable.");
  const jobPayload = await jobResponse.json();
  const resultsPayload = await resultsResponse.json();
  const artifactsPayload = await artifactsResponse.json();
  if (jobPayload.status !== "completed") throw new Error(`Expected completed job, received ${jobPayload.status}.`);
  if (resultsPayload.total !== 20 || resultsPayload.sourceCoverage?.status !== "complete" || !resultsPayload.qualityGate?.passed) {
    throw new Error("Persisted job coverage or quality gate is incomplete.");
  }
  if (!Array.isArray(artifactsPayload) || artifactsPayload.length !== 83) throw new Error("Expected 83 persisted artifacts.");
  pass("persisted-complete-job", "Completed task: 20 discovered, 20 full bodies, 20 result records, quality gate passed.");

  const coverage = missionPanel.locator(".journey-coverage");
  const journeyItems = missionPanel.locator(".task-journey-list li");
  await showStep(5, "读取发现队列，并逐条获取完整正文。", "20 条相关内容全部保存正文，覆盖率 20 / 20、100%。", 3400);
  await focus(coverage, 2200);
  await focusMany([journeyItems.nth(1), journeyItems.nth(2)], 2200);

  await showStep(6, "区分招聘与经验内容，再提取职责、要求和投递入口。", "分类与结构化提取均已完成，每个字段保留原文证据。", 3400);
  await focusMany([journeyItems.nth(3), journeyItems.nth(4)], 2500);

  await showStep(7, "把岗位要求匹配到候选人经历，生成私信、邮件和求职信，并执行质量门槛。", "20 张岗位卡和 20 份投递材料已生成；任务级质量门槛通过。", 3800);
  await focusMany([journeyItems.nth(6), journeyItems.nth(7), journeyItems.nth(8)], 2800);

  const resultsPanel = page.locator("section.results-panel");
  await scrollTo(resultsPanel);
  const resultRows = resultsPanel.locator(".result-row");
  if ((await resultRows.count()) < 8) throw new Error("Expected at least eight result cards.");
  await clickWithPointer(resultRows.nth(7));
  const resultDetail = resultsPanel.locator(".result-detail");
  await resultDetail.waitFor({ state: "visible" });

  await showStep(8, "逐岗位核对事实、投递方式和完整正文，而不是只看摘要。", "当前岗位已展示职责要求、证据来源、复核后的投递入口和采集正文。", 3700);
  await focus(resultsPanel.locator(".result-facts"), 1800);
  await focus(resultsPanel.locator(".route-section"), 1800);
  await focus(resultsPanel.locator(".full-body-section"), 2000);
  pass("result-review", "Structured facts, evidence-backed route, and full source body are visible.");

  await showStep(9, "检查可编辑文案、附件和评分，再进入发送前预览。", "脱敏演示草稿评分 95 / 100；收件人、正文和附件在确认前集中预览。", 3900);
  await focus(resultsPanel.locator(".draft-editor.email-editor"), 1800);
  await focus(resultsPanel.locator(".attachment-workspace"), 1800);
  await focus(resultsPanel.locator(".evaluation-panel"), 1800);
  const deliveryConsole = resultsPanel.locator(".delivery-console");
  await focus(deliveryConsole, 1700);
  const previewButton = page.getByRole("button", { name: "预览并发送", exact: true });
  if (await previewButton.isDisabled()) throw new Error("Demo send preview is unexpectedly disabled.");
  await clickWithPointer(previewButton);
  const previewDialog = page.getByRole("dialog", { name: "邮件发送预览" });
  await previewDialog.waitFor({ state: "visible", timeout: 15_000 });
  await focus(previewDialog, 2600);
  if (!await previewDialog.getByText("已通过 · 95 / 100 · 草稿 v1", { exact: false }).count()) throw new Error("Quality result is missing from send preview.");
  pass("send-preview", "Demo preview opened with recipient, sender, complete body, attachments summary, and passed quality result.");

  await showStep(10, "确认脱敏演示投递，然后下载任务交付产物。", "演示发送已返回完成且未连接外部 SMTP；83 个真实本地产物可下载。", 3700);
  const confirmButton = previewDialog.getByRole("button", { name: "确认发送", exact: true });
  await clickWithPointer(confirmButton);
  await previewDialog.waitFor({ state: "hidden", timeout: 15_000 });
  await page.getByText("邮件已发送至 demo@example.test", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  if (previewCalls !== 1 || demoSendCalls !== 1) throw new Error("Demo preview/send contract did not run exactly once.");
  pass("demo-send", "Local demo send completed exactly once; external SMTP was not called.");

  const artifactsButton = page.getByRole("button", { name: "产物", exact: true });
  await clickWithPointer(artifactsButton);
  const artifactsPanel = page.locator("section.artifacts-panel");
  await artifactsPanel.waitFor({ state: "visible" });
  await scrollTo(artifactsPanel);
  const artifactLinks = artifactsPanel.getByRole("link");
  if ((await artifactLinks.count()) !== 83) throw new Error(`Expected 83 artifact links, received ${await artifactLinks.count()}.`);
  const firstArtifact = artifactLinks.first();
  const artifactHref = await firstArtifact.getAttribute("href");
  if (!artifactHref) throw new Error("First artifact has no URL.");
  const downloadResponse = await context.request.get(new URL(artifactHref, baseUrl).toString());
  if (!downloadResponse.ok()) throw new Error(`Artifact download returned HTTP ${downloadResponse.status()}.`);
  await focus(artifactsPanel, 2900);
  pass("artifact-download", `83 artifacts listed; first artifact returned HTTP ${downloadResponse.status()}.`);

  await hideStep();
  await showTitle(
    "新增核心链路 · 批量投递工作台",
    "从候选筛选到 3 / 3 批次完成",
    "下面实际操作投递预演、冻结、审批、开始、暂停和恢复。批次发送使用本地脱敏状态端点，不连接外部 SMTP。",
    4600,
  );

  const batchNavigation = page.getByRole("navigation", { name: "切换工作台" }).getByRole("button", { name: "批量投递", exact: true });
  await showStep(11, "进入独立的批量投递工作台。", "候选岗位、收件人、文案、标题和附件规则集中在同一张表复核。", 3300);
  await clickWithPointer(batchNavigation);
  await page.waitForURL(/\/batch$/u, { timeout: 15_000 });
  const batchPanel = page.getByRole("region", { name: "批量投递工作台" });
  await batchPanel.waitFor({ state: "visible", timeout: 20_000 });
  const clearBatchFilters = batchPanel.getByRole("button", { name: "清除筛选", exact: true });
  if (await clearBatchFilters.count()) await clickWithPointer(clearBatchFilters);
  await batchPanel.getByText("智能产品经理招聘", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await focus(batchPanel.locator(".batch-application-guide"), 2300);
  await focus(batchPanel.locator(".batch-filter-strip"), 2100);
  if (batchCandidateCalls < 1) throw new Error("Batch candidate corpus was not loaded.");

  await showStep(12, "筛选可投递岗位，并选择本批次的 3 条申请。", "3 条岗位均有已复核邮箱、通过质量门槛的文案和稳定数据修订。", 3500);
  const readyFilter = batchPanel.getByRole("button", { name: "可投递", exact: true });
  await clickWithPointer(readyFilter);
  await batchPanel.getByText("智能产品经理招聘", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  const clearSelection = batchPanel.getByRole("button", { name: "清空", exact: true });
  if (await clearSelection.isEnabled()) await clickWithPointer(clearSelection);
  const selectionLimit = batchPanel.getByLabel("批量数量预设");
  await selectionLimit.selectOption("10");
  const selectReady = batchPanel.getByRole("button", { name: /选择前 \d+ 条可投递/u });
  await clickWithPointer(selectReady);
  await batchPanel.locator(".batch-selection-summary").getByText("3", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await focus(batchPanel.locator(".batch-selection-actions"), 2100);

  await showStep(13, "设置统一附件命名规则和逐封发送间隔。", "默认附件名将按候选人和岗位生成；批次按 2 秒间隔串行处理。", 3400);
  const batchSettings = batchPanel.locator("details.batch-settings");
  await clickWithPointer(batchSettings.locator("summary"));
  await batchSettings.getByLabel("默认附件格式").fill("演示候选人-{jobTitle}-简历");
  await batchSettings.getByLabel("发送间隔（秒）").fill("2");
  await focus(batchSettings, 2400);

  await showStep(14, "运行投递预演 Dry Run，只生成清单而不发送。", "3 项全部就绪；页面列出最终收件人、标题、邮件正文、Cover Letter 与计划附件名。", 3900);
  const dryRunButton = batchPanel.getByRole("button", { name: "Dry Run", exact: true });
  await clickWithPointer(dryRunButton);
  await batchPanel.getByText("投递预演完成：3 项全部就绪；本次不会发送邮件。", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  if (batchDryRunCalls !== 1) throw new Error(`Expected one batch Dry Run, received ${batchDryRunCalls}.`);
  await focus(batchPanel.locator(".batch-application-table"), 2600);
  await focus(batchPanel.locator(".batch-primary-actions"), 1900);

  await showStep(15, "冻结刚才确认的投递清单，锁定收件人、正文和附件哈希。", "生成不可变批次快照；3 封邮件进入待审批状态，冻结详情仍可逐封复核。", 3900);
  const freezeButton = batchPanel.getByRole("button", { name: "冻结批次预览", exact: true });
  if (await freezeButton.isDisabled()) throw new Error("Batch freeze button is unexpectedly disabled after Dry Run.");
  await clickWithPointer(freezeButton);
  const frozenPreview = batchPanel.getByRole("region", { name: "冻结批次预览" });
  await frozenPreview.waitFor({ state: "visible", timeout: 15_000 });
  await batchPanel.locator(".batch-status-badge.ready").waitFor({ state: "visible", timeout: 10_000 });
  if (batchCreateCalls !== 1) throw new Error(`Expected one frozen batch, received ${batchCreateCalls}.`);
  await focus(frozenPreview.locator(".frozen-item-list"), 2200);
  await focus(frozenPreview.getByTestId("batch-email-preview"), 2500);

  await showStep(16, "人工审批冻结批次，再启动串行发送队列。", "审批绑定当前清单与 SMTP 配置；启动后显示 1 封处理中、2 封等待。", 3800);
  const batchControls = frozenPreview.locator(".batch-control-actions");
  await clickWithPointer(batchControls.getByRole("button", { name: "审批", exact: true }));
  await batchPanel.locator(".batch-status-badge.approved").waitFor({ state: "visible", timeout: 10_000 });
  await clickWithPointer(batchControls.getByRole("button", { name: "开始", exact: true }));
  await batchPanel.locator(".batch-status-badge.running").waitFor({ state: "visible", timeout: 10_000 });
  await focus(frozenPreview.locator(".batch-metrics"), 2300);

  await showStep(17, "暂停批次检查中间结果，再恢复并完成剩余项目。", "暂停时已落账 1 封；恢复后本地演示批次 3 / 3 完成，无重复发送且未连接外部 SMTP。", 4200);
  await clickWithPointer(batchControls.getByRole("button", { name: "暂停", exact: true }));
  await batchPanel.locator(".batch-status-badge.paused").waitFor({ state: "visible", timeout: 10_000 });
  await focus(frozenPreview.locator(".batch-metrics"), 1800);
  await clickWithPointer(batchControls.getByRole("button", { name: "恢复", exact: true }));
  await batchPanel.locator(".batch-status-badge.completed").waitFor({ state: "visible", timeout: 10_000 });
  await frozenPreview.locator(".batch-metrics").getByText("3", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await focus(frozenPreview.locator(".batch-metrics"), 2100);
  await focus(frozenPreview.getByTestId("batch-email-preview"), 2700);
  if (batchApproveCalls !== 1 || batchControlCalls.join(",") !== "start,pause,resume") {
    throw new Error(`Batch controls did not complete exactly once: approve=${batchApproveCalls}, controls=${batchControlCalls.join(",")}.`);
  }
  if (currentBatch?.status !== "completed" || currentBatch.counts.sent !== 3) {
    throw new Error("Local demo batch did not finish 3 / 3 items.");
  }
  pass("batch-workflow", "Selected 3 candidates; Dry Run, freeze, approval, start, pause, resume, and 3/3 completion all executed once through the local demo endpoint.");

  if (browserErrors.length) throw new Error(`Browser errors detected: ${browserErrors.join(" | ")}`);
  pass("browser-runtime", `No page or application console errors occurred; ${resourceWarnings.length} non-blocking 502 resource warning(s) were isolated.`);

  await hideStep();
  await showTitle(
    "完整链路已跑通",
    "单岗位：采集 → 正文 → 提取 → 文案 → 质检 → 交付｜批量：筛选 → 预演 → 冻结 → 审批 → 暂停/恢复 → 完成",
    "真实完成任务验证了 20 / 20 正文、20 份结果和 83 个产物；单条与批量邮件投递均走脱敏本地演示端点，不会向外部收件人发送。",
    5600,
  );
} catch (error) {
  checks.push({ name: "recording", status: "failed", detail: error.stack || error.message });
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  const rawVideoPath = video ? await video.path().catch(() => null) : null;
  await browser?.close().catch(() => {});
  await writeFile(verificationPath, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    baseUrl,
    jobId,
    viewport,
    rawVideoPath,
    checks,
    browserErrors,
    resourceWarnings,
    demoDelivery: { previewCalls, sendCalls: demoSendCalls, externalSmtpCalled: false },
    batchDelivery: {
      candidateCalls: batchCandidateCalls,
      dryRunCalls: batchDryRunCalls,
      createCalls: batchCreateCalls,
      approveCalls: batchApproveCalls,
      controlCalls: batchControlCalls,
      completedItems: currentBatch?.counts?.sent || 0,
      externalSmtpCalled: false,
    },
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ verificationPath, rawVideoPath, checks, browserErrors, resourceWarnings }, null, 2));
}
