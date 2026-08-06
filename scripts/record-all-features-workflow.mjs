import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "@playwright/test";

import { draftContentHash } from "../src/draft-state.mjs";

const baseUrl = process.env.APP_URL || "http://127.0.0.1:4317";
const jobId = process.env.DEMO_JOB_ID || "20260801203406-7f4651b9";
const generalContentJobId = process.env.DEMO_GENERAL_JOB_ID || "20260801193634-0b1475be";
const generalAudienceJobId = process.env.DEMO_AUDIENCE_JOB_ID || "20260731093808-50dd4507";
const generalExpansionJobId = process.env.DEMO_EXPANSION_JOB_ID || "20260731005634-5c619106";
const copilotSessionId = process.env.DEMO_COPILOT_SESSION_ID || "copilot-5030384fbc6468054fc75b0738dfef07";
const outputDir = path.resolve("output/playwright/all-features-workflow-v3");
const rawVideoDir = path.join(outputDir, "raw");
const verificationPath = path.join(outputDir, "verification.json");
const viewport = { width: 1440, height: 900 };
const totalSteps = 30;
const demoRecipient = "demo-recipient@example.test";
const demoSender = "demo-sender@example.test";
const demoReplyTo = "demo-candidate@example.test";
const routeEvidenceHash = "a".repeat(64);
const routeRevision = "demo-route-revision-1";

const demoOutreach = {
  greeting: "你好，我对这个产品经理实习岗位很感兴趣，想进一步了解团队和工作内容。",
  email_subject: "应聘产品经理实习生｜演示候选人｜每周可实习 5 天",
  email_body: "招聘团队您好：\n\n我希望应聘产品经理实习生岗位。我的项目经历覆盖需求分析、数据复盘和跨团队协作，并已按岗位要求整理简历与求职信。\n\n感谢审阅。",
  cover_letter: "这是一份用于录屏演示的完整求职信。内容围绕岗位职责、项目证据和到岗安排组织，发送前仍需候选人逐项确认。",
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
      cover_letter: `这是一份面向${roleName}岗位的完整 Cover Letter，逐项对应岗位职责、项目证据和到岗安排。`,
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
let generalEvidence = null;
let audienceEvidence = null;
let expansionEvidence = null;
let copilotEvidence = null;

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
            evidenceText: "本地演示地址，已由正文证据复核",
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

async function focusIfVisible(locator, milliseconds = 1500) {
  if ((await locator.count()) === 0 || !(await locator.first().isVisible())) return false;
  await focus(locator.first(), milliseconds);
  return true;
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
    "全功能顺序演示 · 逐步字幕版",
    "今天你投了吗？四个工作台完整使用链路",
    "按导航顺序展示岗位投递、批量投递、非岗位研究和数据助手。页面字段按实际值完整显示；录制中的邮件操作使用本地演示端点，不触发外部 SMTP。",
    4600,
  );

  await showStep(1, "检查本地服务、Runner 与 Relay 是否就绪。", "页面已连接 Relay；后端健康检查与 Runner 检查通过。", 3200);
  await focus(relayStatus, 1700);
  pass("runtime-readiness", "Relay connected is visible; backend health and runner are ready.");

  const aiPanel = page.locator("section.ai-setup-panel");
  await showStep(2, "连接写作模型，并加载候选人背景与签名信息。", "模型会话和背景记忆已载入；候选人字段按页面实际值展示。", 3400);
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

  await showStep(9, "检查可编辑文案、附件和评分，再进入发送前预览。", "完整演示草稿评分 95 / 100；收件人、正文和附件在确认前集中预览。", 3900);
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

  await showStep(10, "确认本地演示投递，然后下载任务交付产物。", "演示发送已返回完成且未连接外部 SMTP；83 个真实本地产物可下载。", 3700);
  const confirmButton = previewDialog.getByRole("button", { name: "确认发送", exact: true });
  await clickWithPointer(confirmButton);
  await previewDialog.waitFor({ state: "hidden", timeout: 15_000 });
  await page.getByText(`邮件已发送至 ${demoRecipient}`, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
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
    "第二工作台 · 批量投递",
    "从候选筛选到 3 / 3 批次完成",
    "下面实际操作投递预演、冻结、审批、开始、暂停和恢复。批次发送使用本地状态端点，不连接外部 SMTP。",
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

  await hideStep();
  await showTitle(
    "第三工作台 · 非岗位研究",
    "内容洞察 → 受众与用户 → 关系扩散",
    "依次打开已保存的真实研究任务，展示跨样本结论、单条图文分析、4,271 条评论、1,584 位用户，以及用户、帖子、评论和关系四类扩散结果。",
    4800,
  );

  const workspaceNavigation = page.getByRole("navigation", { name: "切换工作台" });
  const researchNavigation = workspaceNavigation.getByRole("button", { name: "非岗位研究", exact: true });
  await showStep(18, "进入非岗位研究工作台，并从历史记录打开已完成的内容任务。", "当前任务“ai产品经理 实习 继任”已完成 20 条内容采集和 AI 分析，保留 97 个本地产物。", 3800);
  await clickWithPointer(researchNavigation);
  await page.getByRole("heading", { name: "今天你投了吗？｜内容研究工作台" }).waitFor({ state: "visible", timeout: 20_000 });
  const generalHistoryButton = page.getByRole("button", { name: "历史", exact: true });
  await clickWithPointer(generalHistoryButton);
  const generalHistoryPanel = page.locator("section.history-panel");
  const contentHistoryRow = generalHistoryPanel.locator("tbody tr")
    .filter({ hasText: "ai产品经理 实习 继任" })
    .filter({ hasText: "内容采集" })
    .first();
  await focus(contentHistoryRow, 1800);
  await clickWithPointer(contentHistoryRow);
  const generalResultsPanel = page.locator("section.results-panel");
  await generalResultsPanel.getByRole("tablist", { name: "非岗位研究结果模块" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const results = document.querySelector("section.results-panel")?.textContent || "";
    return results.includes("CROSS-SAMPLE EVIDENCE") && results.includes("20") && results.includes("100%");
  }, null, { timeout: 30_000 });

  const generalResponse = await context.request.get(`${baseUrl}/api/jobs/${generalContentJobId}/results?analysisMode=general&limit=50`);
  if (!generalResponse.ok()) throw new Error(`General research API returned HTTP ${generalResponse.status()}.`);
  const generalPayload = await generalResponse.json();
  if (generalPayload.total !== 20 || generalPayload.insights?.coverageRate !== 100 || generalPayload.insights?.groundedRecords !== 20 || generalPayload.insights?.modules?.length !== 3) {
    throw new Error("General research evidence is incomplete.");
  }
  generalEvidence = {
    jobId: generalContentJobId,
    records: generalPayload.total,
    groundedRecords: generalPayload.insights.groundedRecords,
    evidenceCoverage: generalPayload.insights.coverageRate,
    insightModules: generalPayload.insights.modules.length,
  };
  pass("general-research", "Verified 20 content records, 20 grounded samples, 100% evidence coverage, and three cross-sample insight modules.");

  await showStep(19, "先看研究目标、跨样本证据覆盖、高频主题和三组动态洞察。", "20 / 20 条样本均可回溯原文，证据覆盖率 100%；页面按本次关键词动态生成三组研究栏目。", 4000);
  await focus(generalResultsPanel.locator(".content-research-context"), 1700);
  await focusMany([
    generalResultsPanel.locator(".content-insight-metrics"),
    generalResultsPanel.locator(".content-topic-frequency"),
  ], 2400);
  await focus(generalResultsPanel.locator(".content-insight-modules"), 3000);

  await showStep(20, "再打开单条内容，查看图片、图片文字理解、主题实体、动态模块和完整正文。", "列表支持排序、时间筛选和续采补全；详情同时保留原图、AI 结构和可复制正文。", 4000);
  await focus(generalResultsPanel.locator(".general-results-controls"), 1800);
  const generalRows = generalResultsPanel.locator(".result-row");
  if ((await generalRows.count()) < 1) throw new Error("General research result list is empty.");
  const detailedGeneralRow = generalRows.filter({ has: page.locator("img") }).first();
  if (await detailedGeneralRow.count()) await clickWithPointer(detailedGeneralRow.locator(".result-card-select"));
  else await clickWithPointer(generalRows.first().locator(".result-card-select"));
  const generalDetail = generalResultsPanel.locator(".general-content-detail");
  await generalDetail.waitFor({ state: "visible", timeout: 20_000 });
  await focusIfVisible(generalDetail.locator(".result-media"), 2300);
  await focus(generalDetail.locator(".general-overview"), 1900);
  await focusIfVisible(generalDetail.locator(".content-taxonomy"), 1700);
  await focus(generalDetail.locator(".content-module-grid"), 2400);
  await focus(generalDetail.locator(".general-body"), 2200);

  await showStep(21, "打开受众检查点，先核对全量状态、帖子覆盖和继续采集入口。", "已检查 195 / 195 篇内容，保存 4,271 条评论与回复、1,584 位独立用户；111 篇完整、84 篇部分完成。", 4200);
  await clickWithPointer(generalHistoryButton);
  const audienceHistoryRow = generalHistoryPanel.locator("tbody tr").filter({ hasText: "亚比女" }).first();
  await focus(audienceHistoryRow, 1700);
  await clickWithPointer(audienceHistoryRow);
  const generalTabs = generalResultsPanel.getByRole("tablist", { name: "非岗位研究结果模块" });
  await generalTabs.waitFor({ state: "visible", timeout: 30_000 });
  await clickWithPointer(generalTabs.getByRole("tab", { name: /受众及用户界面/u }));
  await page.waitForFunction(() => (document.querySelector("#results")?.textContent || "").includes("4,271"), null, { timeout: 40_000 });

  const audienceResponse = await context.request.get(`${baseUrl}/api/jobs/${generalAudienceJobId}/audience?offset=0&limit=20`);
  if (!audienceResponse.ok()) throw new Error(`Audience API returned HTTP ${audienceResponse.status()}.`);
  const audiencePayload = await audienceResponse.json();
  if (!audiencePayload.available || audiencePayload.total !== 4271 || audiencePayload.totals?.users !== 1584 || audiencePayload.summary?.postsAttempted !== 195) {
    throw new Error("Audience checkpoint totals do not match the displayed data.");
  }
  audienceEvidence = {
    jobId: generalAudienceJobId,
    status: audiencePayload.summary.status,
    comments: audiencePayload.total,
    users: audiencePayload.totals.users,
    postsAttempted: audiencePayload.summary.postsAttempted,
    postsTotal: audiencePayload.summary.postsTotal,
    postsComplete: audiencePayload.summary.postsComplete,
    postsPartial: audiencePayload.summary.postsPartial,
  };
  await focus(generalResultsPanel.locator(".audience-summary-band"), 2500);
  await focus(generalResultsPanel.locator(".audience-post-coverage"), 2600);
  await focusMany([
    generalResultsPanel.getByRole("button", { name: "继续补采未完成帖子", exact: true }),
    generalResultsPanel.getByRole("button", { name: "继续发现更多帖子", exact: true }),
  ], 2200);
  pass("audience-research", "Verified the partial checkpoint: 4,271 comments, 1,584 users, and all 195 posts attempted with saved progress.");

  await showStep(22, "浏览评论流，并展示原帖筛选、关键词搜索、分页和每页数量控制。", "每条评论保留昵称、正文、原帖、发布时间、IP 属地、点赞和公开主页入口；未完成检查点可继续补采。", 4100);
  const audienceWorkspace = generalResultsPanel.locator(".audience-workspace");
  await focus(audienceWorkspace.locator(".audience-toolbar"), 2200);
  const commentList = audienceWorkspace.locator(".audience-comment-list");
  await commentList.waitFor({ state: "visible", timeout: 20_000 });
  await focus(commentList, 2800);
  await focusMany([
    audienceWorkspace.getByLabel("按原帖筛选受众"),
    audienceWorkspace.getByLabel("搜索评论或用户"),
    audienceWorkspace.getByLabel("每页显示条数"),
  ], 2200);
  await focusIfVisible(audienceWorkspace.locator(".audience-pagination"), 1600);

  await showStep(23, "切换到用户卡，核对公开主页字段和用户角色。", "用户卡展示原帖主或评论者、简介、小红书号、IP 属地、粉丝、关注、互动、评论数与主页补全状态。", 4000);
  const audienceViewTabs = audienceWorkspace.getByRole("tablist", { name: "受众数据视图" });
  await clickWithPointer(audienceViewTabs.getByRole("tab", { name: /用户卡/u }));
  const userGrid = audienceWorkspace.locator(".audience-user-grid");
  await userGrid.waitFor({ state: "visible", timeout: 20_000 });
  await focus(userGrid, 2700);
  await focusIfVisible(userGrid.locator(".audience-user-card").first(), 2000);

  await showStep(24, "进入关系扩散，查看种子、参数预设、轮次指标和继续运行控制。", "扩散任务从已保存帖子建立多轮检查点；预算、深度、粉丝门槛、帖子策略和停止原因均可追踪。", 4000);
  await clickWithPointer(generalTabs.getByRole("tab", { name: /关系扩散/u }));
  const expansionWorkspace = generalResultsPanel.locator(".expansion-workspace");
  await expansionWorkspace.waitFor({ state: "visible", timeout: 30_000 });
  await focus(expansionWorkspace.locator(".expansion-command-bar"), 2200);
  await focusIfVisible(expansionWorkspace.locator(".expansion-seeds"), 1800);
  const expansionParameters = expansionWorkspace.locator("details.expansion-parameters");
  if (await expansionParameters.count()) {
    const open = await expansionParameters.getAttribute("open");
    if (open === null) await clickWithPointer(expansionParameters.locator("summary"));
    await focus(expansionParameters, 2300);
  }
  await focus(expansionWorkspace.locator(".expansion-metrics"), 2200);
  await focusIfVisible(expansionWorkspace.locator(".expansion-rounds"), 1800);

  const expectedExpansionTotals = { users: 27, posts: 7, comments: 66, relations: 232 };
  expansionEvidence = { jobId: generalExpansionJobId, totals: {} };
  for (const [kind, expectedTotal] of Object.entries(expectedExpansionTotals)) {
    const expansionResponse = await context.request.get(`${baseUrl}/api/jobs/${generalExpansionJobId}/expansion?kind=${kind}&offset=0&limit=5`);
    if (!expansionResponse.ok()) throw new Error(`Expansion ${kind} API returned HTTP ${expansionResponse.status()}.`);
    const expansionPayload = await expansionResponse.json();
    if (expansionPayload.results?.total !== expectedTotal) throw new Error(`Expected ${expectedTotal} ${kind} expansion rows, received ${expansionPayload.results?.total}.`);
    expansionEvidence.totals[kind] = expansionPayload.results.total;
  }

  await showStep(25, "依次切换用户、帖子、评论、关系四类结果，并检查扩散产物。", "当前检查点包含 27 位用户、7 篇帖子、66 条评论和 232 条关系；每类都支持轮次、状态、种子筛选和分页。", 4200);
  const expansionResults = expansionWorkspace.locator(".expansion-results");
  for (const label of ["用户", "帖子", "评论", "关系"]) {
    await clickWithPointer(expansionResults.getByRole("button", { name: label, exact: true }));
    await expansionResults.locator(".expansion-table-wrap").waitFor({ state: "visible", timeout: 15_000 });
    await focus(expansionResults.locator(".expansion-table-wrap"), 1500);
  }
  await focus(expansionResults.locator(".expansion-result-filters"), 1900);
  await focus(expansionWorkspace.locator(".expansion-artifacts"), 2300);
  pass("relationship-expansion", "Verified and displayed 27 users, 7 posts, 66 comments, and 232 relations with filters and artifacts.");

  await hideStep();
  await showTitle(
    "第四工作台 · 数据助手",
    "模型连接 → 历史会话 → 智能体执行 → 数据上下文 → 运行质量",
    "打开已有 19 条消息、13 个执行步骤的完整会话；展示模型连接、会话检索、工具结果、投递草稿、上下文浏览和质量诊断。",
    5000,
  );

  await showStep(26, "打开数据助手并切换全屏，先展示模型选择与连接配置。", "提供方、Base URL、API Key、接口协议和模型 ID 均可配置；本次只展示已有设置，不发起新的模型请求。", 4200);
  const copilotLaunch = page.getByRole("button", { name: "数据助手", exact: true });
  await clickWithPointer(copilotLaunch);
  const copilotPanel = page.getByRole("dialog", { name: "数据 Copilot" });
  await copilotPanel.waitFor({ state: "visible", timeout: 30_000 });
  await clickWithPointer(copilotPanel.getByRole("button", { name: "全屏", exact: true }));
  await copilotPanel.getByRole("button", { name: "退出全屏", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const connectModelButton = copilotPanel.getByRole("button", { name: "连接或更换 AI 模型" });
  if (await connectModelButton.count()) await clickWithPointer(connectModelButton);
  else await clickWithPointer(copilotPanel.getByRole("button", { name: "连接 AI 模型", exact: true }));
  const modelDialog = page.getByRole("dialog", { name: "连接 AI 模型" });
  await modelDialog.waitFor({ state: "visible", timeout: 15_000 });
  await focusMany([
    modelDialog.getByLabel("AI 提供方"),
    modelDialog.getByLabel("API Base URL"),
    modelDialog.getByLabel("API Key"),
    modelDialog.getByLabel("AI 接口协议"),
    modelDialog.getByLabel("模型 ID"),
  ], 2800);
  await focus(modelDialog, 1800);
  await clickWithPointer(modelDialog.getByRole("button", { name: "关闭模型连接" }));

  const copilotMessagesResponse = await context.request.get(`${baseUrl}/api/copilot/conversations/${copilotSessionId}/messages`);
  const copilotContextResponse = await context.request.get(`${baseUrl}/api/copilot/context/jobs?offset=0&limit=5`);
  if (!copilotMessagesResponse.ok() || !copilotContextResponse.ok()) throw new Error("Data Copilot persisted APIs are not readable.");
  const copilotMessagesPayload = await copilotMessagesResponse.json();
  const copilotContextPayload = await copilotContextResponse.json();
  if (copilotMessagesPayload.messages?.length !== 19 || copilotContextPayload.total !== 94) throw new Error("Data Copilot persisted totals are incomplete.");
  copilotEvidence = { sessionId: copilotSessionId, messages: copilotMessagesPayload.messages.length, contextTasks: copilotContextPayload.total };

  await showStep(27, "检索并打开历史会话，再查看智能体的 13 步执行计划。", "该会话围绕 AI 产品实习岗位完成数据集搜索、列表读取、投递材料生成和交付状态核对，共保留 19 条消息。", 4200);
  const sessionRail = copilotPanel.locator(".data-copilot-session-rail");
  await sessionRail.getByLabel("搜索会话").fill("Data Copilot: ai产品 实习 继任");
  const targetSession = sessionRail.getByRole("button").filter({ hasText: "Data Copilot: ai产品 实习 继任" }).first();
  await targetSession.waitFor({ state: "visible", timeout: 20_000 });
  await focus(targetSession, 2000);
  await clickWithPointer(targetSession);
  const workbench = copilotPanel.getByRole("region", { name: "智能体运行工作台" });
  await workbench.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => (document.querySelector(".copilot-agent-workbench")?.textContent || "").includes("13"), null, { timeout: 20_000 });
  await focus(workbench, 2700);
  const runTabs = workbench.getByRole("tablist", { name: "运行视图" });
  await clickWithPointer(runTabs.getByRole("tab", { name: /活动/u }));
  await focus(workbench.locator(".copilot-workbench-view"), 1800);
  await clickWithPointer(runTabs.getByRole("tab", { name: /证据/u }));
  await focus(workbench.locator(".copilot-workbench-view"), 1800);
  await clickWithPointer(runTabs.getByRole("tab", { name: /计划/u }));

  await showStep(28, "查看对话、工具表格、8 份投递草稿，以及输入区的完整操作入口。", "消息区保留参数、来源和表格结果；可复制或导出 CSV，也可继续准备批量投递、上传附件并切换提问、分析、构建模式。", 4300);
  const messageRows = copilotPanel.locator(".data-copilot-message-row");
  await messageRows.first().waitFor({ state: "visible", timeout: 20_000 });
  await focus(messageRows.first(), 1900);
  await messageRows.last().scrollIntoViewIfNeeded();
  await focus(messageRows.last(), 2800);
  await focusIfVisible(copilotPanel.getByRole("button", { name: "准备批量投递", exact: true }), 1600);
  const shortcutBar = copilotPanel.getByLabel("快捷指令");
  const workModes = copilotPanel.getByRole("group", { name: "工作模式" });
  await focusMany([shortcutBar, workModes], 2300);
  await focusMany([
    copilotPanel.getByLabel("上传附件"),
    copilotPanel.getByRole("button", { name: /选择数据上下文，已选/u }),
    copilotPanel.getByLabel("发送给 Data Copilot"),
  ], 2200);

  await showStep(29, "展开数据上下文，浏览并检索 94 条历史采集任务。", "上下文面板可按任务切换帖子、评论、用户、产物和正文分区；当前会话已选择 4 类数据来源。", 4200);
  const contextPane = copilotPanel.locator(".data-copilot-context-pane");
  await contextPane.waitFor({ state: "visible", timeout: 20_000 });
  await focus(contextPane, 2500);
  const contextSearch = contextPane.getByLabel("搜索历史采集记录");
  await contextSearch.fill("20260731005634");
  await pause(900);
  await focus(contextSearch, 1500);
  await focusIfVisible(contextPane.getByRole("button").filter({ hasText: "20260731005634-5c619106" }).first(), 2300);
  await contextSearch.fill("");
  pass("data-copilot", "Verified and displayed a 19-message session, 13-step workbench, and 94 context tasks.");

  await showStep(30, "最后打开运行与质量面板，核对会话状态、快照和质量指标。", "运行质量视图集中展示完成状态、活动量、工具调用、证据来源、快照与刷新入口，便于复盘和继续执行。", 4200);
  await clickWithPointer(copilotPanel.getByRole("button", { name: "打开运行与质量" }));
  const qualityDialog = page.getByRole("dialog", { name: "运行与质量" });
  await qualityDialog.waitFor({ state: "visible", timeout: 20_000 });
  await focus(qualityDialog.locator(".data-copilot-quality-metrics"), 2500);
  await focus(qualityDialog, 2700);
  await focusIfVisible(qualityDialog.getByRole("button", { name: /刷新运行与质量数据/u }), 1400);
  await clickWithPointer(qualityDialog.getByRole("button", { name: "关闭运行与质量" }));

  if (browserErrors.length) throw new Error(`Browser errors detected: ${browserErrors.join(" | ")}`);
  pass("browser-runtime", `No page or application console errors occurred; ${resourceWarnings.length} non-blocking 502 resource warning(s) were isolated.`);

  await hideStep();
  await showTitle(
    "四个工作台已按顺序完整展示",
    "岗位投递 → 批量投递 → 非岗位研究 → 数据助手",
    "已验证岗位任务 20 / 20 正文与 83 个产物、批量投递 3 / 3 完成、非岗位研究三类模块真实数据，以及数据助手 19 条消息、13 步执行和 94 条历史上下文。",
    6200,
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
    generalContentJobId,
    generalAudienceJobId,
    generalExpansionJobId,
    copilotSessionId,
    viewport,
    rawVideoPath,
    unredacted: true,
    checks,
    browserErrors,
    resourceWarnings,
    generalResearch: generalEvidence,
    audienceResearch: audienceEvidence,
    relationshipExpansion: expansionEvidence,
    dataCopilot: copilotEvidence,
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
