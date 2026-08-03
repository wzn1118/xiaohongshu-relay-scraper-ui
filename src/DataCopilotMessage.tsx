import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  AlertCircle,
  Bot,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clipboard,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Mail,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Send,
  TerminalSquare,
  UserRound,
  WandSparkles,
  Wrench,
} from "lucide-react";
import type {
  DataCopilotAttachment,
  DataCopilotCitation,
  DataCopilotMessageData,
  DataCopilotToolCall,
} from "./DataCopilotContext";

export type DataCopilotMessageProps = {
  message: DataCopilotMessageData;
  busy?: boolean;
  approvalBusy?: boolean;
  onRetry?: (message: DataCopilotMessageData) => void;
  onOpenAttachment?: (attachment: DataCopilotAttachment) => void;
  onOpenCitation?: (citation: DataCopilotCitation) => void;
  onApproval?: (message: DataCopilotMessageData, approved: boolean) => void;
  onAction?: (prompt: string) => void;
  jobId?: string;
};

function formatTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function prettyValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatBytes(value: unknown) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function listText(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join("、");
  return String(value ?? "");
}

function ToolStatusIcon({ status }: { status: DataCopilotToolCall["status"] }) {
  if (status === "running" || status === "pending") {
    return (
      <LoaderCircle
        size={14}
        aria-hidden="true"
        style={messageStyles.spinningIcon}
      />
    );
  }
  if (status === "failed") return <AlertCircle size={14} aria-hidden="true" />;
  if (status === "cancelled")
    return <CircleStop size={14} aria-hidden="true" />;
  return <Check size={14} aria-hidden="true" />;
}

function toolDisplayName(name: string) {
  return (
    {
      "applications.compose_email": "撰写岗位投递邮件",
      "applications.get_delivery": "读取岗位投递信息",
      "email.prepare": "准备邮件",
      "email.preview": "预览邮件",
      "email.send": "发送邮件",
    }[name] ?? name
  );
}

function toolStatusLabel(status: DataCopilotToolCall["status"]) {
  return (
    {
      pending: "等待中",
      running: "执行中",
      complete: "已完成",
      failed: "失败",
      cancelled: "已取消",
    }[status] ?? status
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeLink(value: string) {
  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/$/u, "");
    const noteId = pathname.match(/\/explore\/([^/?#]+)/u)?.[1] ?? "";
    return {
      href: value,
      label:
        url.hostname.includes("xiaohongshu.com") && noteId
          ? `打开原帖 · ${noteId.slice(0, 8)}…`
          : `${url.hostname}${pathname === "/" ? "" : pathname}`,
      title: `${url.origin}${pathname}`,
    };
  } catch {
    return { href: "", label: value, title: value };
  }
}

function InlineSafeText({ text }: { text: string }) {
  const clean = text.replaceAll("`", "");
  const parts = clean.split(/(https?:\/\/[^\s|]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/giu);
  return (
    <>
      {parts.map((part, index) => {
        if (/^https?:\/\//iu.test(part)) {
          const link = safeLink(part);
          return link.href ? (
            <a
              key={`${part}-${index}`}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              title={link.title}
              style={messageStyles.inlineLink}
            >
              {link.label}
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          ) : (
            part
          );
        }
        if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(part)) {
          return (
            <a key={`${part}-${index}`} href={`mailto:${part}`} style={messageStyles.emailLink}>
              <Mail size={11} aria-hidden="true" />
              {part}
            </a>
          );
        }
        return part;
      })}
    </>
  );
}

function StructuredAssistantContent({
  content,
  busy = false,
  onAction,
}: {
  content: string;
  busy?: boolean;
  onAction?: (prompt: string) => void;
}) {
  const lines = content
    .replace(/```(?:text|markdown)?/giu, "")
    .replaceAll("```", "")
    .split(/\r?\n/u);
  const blocks: ReactElement[] = [];
  let paragraph: string[] = [];
  let emails: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) {
      blocks.push(
        <p key={`paragraph-${blocks.length}`} style={messageStyles.richParagraph}>
          <InlineSafeText text={text} />
        </p>,
      );
    }
    paragraph = [];
  };
  const flushEmails = () => {
    if (!emails.length) return;
    const unique = [...new Set(emails.map((item) => item.toLowerCase()))];
    blocks.push(
      <section key={`emails-${blocks.length}`} style={messageStyles.contactList}>
        <div style={messageStyles.sectionLabel}>
          <Mail size={13} aria-hidden="true" />
          招聘邮箱
          <span>{unique.length}</span>
        </div>
        <div style={messageStyles.contactGrid}>
          {unique.map((email) => (
            <a key={email} href={`mailto:${email}`} style={messageStyles.contactItem}>
              {email}
            </a>
          ))}
        </div>
      </section>,
    );
    emails = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const emailOnly = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/iu.exec(line)?.[0];
    if (emailOnly) {
      flushParagraph();
      emails.push(emailOnly);
      continue;
    }
    flushEmails();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push(
        <h4 key={`heading-${blocks.length}`} style={messageStyles.richHeading}>
          {heading[1]}
        </h4>,
      );
      continue;
    }
    const listItem = /^(?:[-*•]|\d+[.)、])\s*(.+)$/u.exec(line);
    if (listItem) {
      flushParagraph();
      blocks.push(
        <div key={`item-${blocks.length}`} style={messageStyles.richListItem}>
          <span aria-hidden="true" style={{ width: 4, height: 4, marginTop: 8, borderRadius: "50%", background: "#6f9f8f" }} />
          <div><InlineSafeText text={listItem[1]} /></div>
        </div>,
      );
      continue;
    }
    if (line.includes("|") && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(line)) {
      flushParagraph();
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      const email = cells.find((cell) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(cell));
      const source = cells.find((cell) => /^https?:\/\//iu.test(cell));
      const detail = cells.filter((cell) => cell !== email && cell !== source).join(" · ");
      blocks.push(
        <div key={`lead-${blocks.length}`} style={messageStyles.deliveryLead}>
          <BriefcaseBusiness size={14} aria-hidden="true" />
          <div style={messageStyles.deliveryLeadBody}>
            {email ? <a href={`mailto:${email}`} style={messageStyles.contactItem}>{email}</a> : null}
            {detail ? <span>{detail.replaceAll("`", "")}</span> : null}
          </div>
          {source ? (
            <a href={source} target="_blank" rel="noreferrer" title={safeLink(source).title} style={messageStyles.sourceButton}>
              <ExternalLink size={13} aria-hidden="true" />
              <span>原帖</span>
            </a>
          ) : null}
        </div>,
      );
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushEmails();
  const hasRecruitmentContact = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(content);
  return (
    <div style={messageStyles.richContent}>
      {blocks}
      {hasRecruitmentContact && onAction ? (
        <div style={messageStyles.inlineDeliveryActions} aria-label="投递操作">
          <button
            type="button"
            onClick={() =>
              onAction(
                "基于刚才返回的可投递岗位，选择当前上下文中最相关的一条，调用 applications.compose_email 生成结构化岗位投递草稿。必须带回原帖图片、完整正文、招聘要求、收件人和标题规则，本次不要发送。",
              )
            }
            disabled={busy}
            style={messageStyles.inlineDraftButton}
          >
            <BriefcaseBusiness size={13} aria-hidden="true" />
            生成投递草稿
          </button>
          <button
            type="button"
            onClick={() =>
              onAction(
                "基于刚才的岗位结果生成可发送邮件：先调用 applications.compose_email 按原帖要求拟定标题并生成正文，再调用 email.preview 展示精确收件人、标题、正文和附件。真正发送必须等待我的审批确认。",
              )
            }
            disabled={busy}
            style={messageStyles.inlinePreviewButton}
          >
            <Mail size={13} aria-hidden="true" />
            生成并预览邮件
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CopyFieldButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
      title={`复制${label}`}
      aria-label={`复制${label}`}
      style={messageStyles.copyFieldButton}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
    </button>
  );
}

function proxiedPostImage(url: string, jobId?: string) {
  if (!url || url.startsWith("/api/")) return url;
  if (!jobId || !/^https?:\/\//iu.test(url)) return url;
  return `/api/jobs/${encodeURIComponent(jobId)}/media?url=${encodeURIComponent(url)}`;
}

function PostImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) {
    return (
      <div style={messageStyles.postImageFallback} role="img" aria-label={`${alt}加载失败`}>
        <ImageIcon size={20} aria-hidden="true" />
        <span>图片暂不可用</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={messageStyles.postImage}
    />
  );
}

function OriginalPostPreview({ post, jobId }: { post: Record<string, unknown>; jobId?: string }) {
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [activeImage, setActiveImage] = useState(0);
  const title = String(post.title ?? "原帖内容");
  const body = String(post.body ?? "");
  const images = Array.isArray(post.images)
    ? [...new Set(post.images.map(String).filter(Boolean))]
    : [];
  const requirements = Array.isArray(post.requirements)
    ? post.requirements.map(String).filter(Boolean).slice(0, 5)
    : [];
  const selectedImage = images[activeImage] ?? images[0] ?? "";
  if (!body && !images.length && !requirements.length) return null;
  return (
    <section style={messageStyles.postPreview} aria-label="原帖预览">
      {selectedImage ? (
        <div style={messageStyles.postMedia}>
          <PostImage src={proxiedPostImage(selectedImage, jobId)} alt={`${title}原帖图片`} />
          {images.length > 1 ? (
            <div style={messageStyles.postThumbnails} aria-label="原帖图片列表">
              {images.slice(0, 6).map((image, index) => (
                <button
                  type="button"
                  key={image}
                  onClick={() => setActiveImage(index)}
                  aria-label={`查看原帖图片 ${index + 1}`}
                  aria-pressed={index === activeImage}
                  style={{
                    ...messageStyles.postThumbnailButton,
                    ...(index === activeImage ? messageStyles.postThumbnailButtonActive : undefined),
                  }}
                >
                  <PostImage src={proxiedPostImage(image, jobId)} alt="" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={messageStyles.postContent}>
        <span style={messageStyles.postEyebrow}>原帖依据</span>
        <strong style={messageStyles.postTitle}>{title}</strong>
        {body ? (
          <div
            style={{
              ...messageStyles.postBody,
              ...(bodyExpanded ? messageStyles.postBodyExpanded : undefined),
            }}
          >
            {body}
          </div>
        ) : null}
        {requirements.length ? (
          <div style={messageStyles.requirementList} aria-label="招聘要求">
            {requirements.map((requirement, index) => (
              <span key={`${index}-${requirement.slice(0, 20)}`} style={messageStyles.requirementItem}>
                {requirement}
              </span>
            ))}
          </div>
        ) : null}
        {body.length > 180 ? (
          <button
            type="button"
            onClick={() => setBodyExpanded((current) => !current)}
            aria-expanded={bodyExpanded}
            style={messageStyles.postExpandButton}
          >
            {bodyExpanded ? "收起正文" : "查看完整正文"}
            {bodyExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ApplicationEmailEditor({
  preview,
  subjectRule,
  subject,
  body,
  ruleLabel,
  ruleStatus,
  noteId,
  sent,
  applicationEmail,
  busy,
  onAction,
  link,
}: {
  preview: Record<string, unknown>;
  subjectRule: Record<string, unknown>;
  subject: string;
  body: string;
  ruleLabel: string;
  ruleStatus: string;
  noteId: string;
  sent: boolean;
  applicationEmail: boolean;
  busy: boolean;
  onAction?: (prompt: string) => void;
  link: ReturnType<typeof safeLink> | null;
}) {
  const [draftSubject, setDraftSubject] = useState(subject);
  const [draftBody, setDraftBody] = useState(body);
  useEffect(() => {
    setDraftSubject(subject);
    setDraftBody(body);
  }, [body, noteId, subject]);

  const attachmentIds = Array.isArray(preview.attachmentIds)
    ? preview.attachmentIds.map(String).filter(Boolean)
    : [];
  const attachments = Array.isArray(preview.attachments)
    ? preview.attachments.map(objectValue)
    : [];
  const recipient = listText(preview.to);
  const isDirty = draftSubject !== subject || draftBody !== body;
  const canPreview = Boolean(recipient && draftSubject.trim() && draftBody.trim());
  const exactDraft = {
    applicationNoteId: noteId,
    to: preview.to,
    cc: Array.isArray(preview.cc) ? preview.cc : [],
    bcc: Array.isArray(preview.bcc) ? preview.bcc : [],
    replyTo: String(preview.replyTo ?? ""),
    subject: draftSubject.trim(),
    text: draftBody.trim(),
    attachmentIds,
  };
  const composeInput = {
    noteId,
    to: recipient,
    subject: draftSubject.trim(),
    text: draftBody.trim(),
    attachmentIds,
  };
  const polishPrompt = [
    `润色下面这封岗位投递邮件（applicationNoteId: ${noteId}）。调用 applications.compose_email，并以给定字段作为当前真实草稿；结合该 noteId 对应的原帖正文和招聘要求，改得自然、具体、像真人撰写。`,
    "不得虚构经历，不得更改招聘收件人、标题格式或附件，本次只返回更新后的结构化草稿，不发送邮件。",
    `当前草稿参数：${JSON.stringify(composeInput)}`,
  ].join("\n");
  const sendPrompt = [
    "处理下面这封已经在卡片中确认过的岗位投递邮件。先调用 email.preview，参数必须逐字段采用下方精确草稿；随后进入 email.send 流程。",
    "真正投递前必须展示审批确认，完整列出收件人、主题、正文和附件，并等待我的明确确认；不得跳过确认，也不得擅自改写草稿。",
    `精确草稿参数：${JSON.stringify(exactDraft)}`,
  ].join("\n");

  return (
    <>
      <div style={messageStyles.emailContent}>
        <div style={messageStyles.emailMetaGrid}>
          <div style={messageStyles.emailField}>
            <strong>收件人</strong>
            <span>{recipient || "待选择招聘邮箱"}</span>
            {recipient ? <CopyFieldButton value={recipient} label="收件人" /> : null}
          </div>
          {listText(preview.cc) ? (
            <div style={messageStyles.emailField}>
              <strong>抄送</strong>
              <span>{listText(preview.cc)}</span>
            </div>
          ) : null}
          {listText(preview.bcc) ? (
            <div style={messageStyles.emailField}>
              <strong>密送</strong>
              <span>{listText(preview.bcc)}</span>
            </div>
          ) : null}
          {preview.replyTo ? (
            <div style={messageStyles.emailField}>
              <strong>Reply-To</strong>
              <span>{String(preview.replyTo)}</span>
            </div>
          ) : null}
          <label style={messageStyles.emailField}>
            <strong>主题</strong>
            <input
              type="text"
              aria-label="邮件主题"
              value={draftSubject}
              onChange={(event) => setDraftSubject(event.target.value)}
              readOnly={sent}
              placeholder="按招聘要求填写邮件标题"
              style={messageStyles.emailSubjectInput}
            />
            {draftSubject ? <CopyFieldButton value={draftSubject} label="邮件主题" /> : null}
          </label>
          <div style={messageStyles.emailField}>
            <strong>附件</strong>
            <span>
              {attachments.length
                ? attachments
                    .map((attachment) => {
                      const name = String(attachment.displayName ?? attachment.artifactId ?? "附件");
                      return [name, formatBytes(attachment.size)].filter(Boolean).join(" · ");
                    })
                    .join("、")
                : attachmentIds.length
                  ? attachmentIds.join("、")
                  : "无"}
            </span>
          </div>
        </div>
        {ruleLabel ? (
          <div style={messageStyles.subjectRule} data-status={ruleStatus}>
            <ShieldCheck size={13} aria-hidden="true" />
            <span>
              <strong>{ruleLabel}</strong>
              {subjectRule.evidence ? ` · ${String(subjectRule.evidence)}` : ""}
              {Array.isArray(subjectRule.missingFields) && subjectRule.missingFields.length
                ? ` · 缺少 ${subjectRule.missingFields.join("、")}`
                : ""}
              {isDirty ? " · 已修改，将在预览时重新校验" : ""}
            </span>
          </div>
        ) : null}
        <div style={messageStyles.emailBodyHeader}>
          <strong>邮件正文</strong>
          <span style={messageStyles.emailBodyTools}>
            {isDirty && !sent ? (
              <button
                type="button"
                onClick={() => {
                  setDraftSubject(subject);
                  setDraftBody(body);
                }}
                style={messageStyles.resetDraftButton}
              >
                <RotateCcw size={12} aria-hidden="true" />
                撤销修改
              </button>
            ) : null}
            {draftBody ? <CopyFieldButton value={draftBody} label="邮件正文" /> : null}
          </span>
        </div>
        <textarea
          aria-label="邮件正文"
          value={draftBody}
          onChange={(event) => setDraftBody(event.target.value)}
          readOnly={sent}
          placeholder="在这里撰写投递邮件正文"
          style={messageStyles.emailBodyEditor}
        />
        {preview.deliveryMethod ? (
          <div style={messageStyles.emailField}>
            <strong>投递</strong>
            <span>{String(preview.deliveryMethod)} · {String(preview.deliverySource ?? "configured_smtp")}</span>
          </div>
        ) : null}
        {preview.jobRecordSource ? (
          <div style={messageStyles.emailField}>
            <strong>岗位来源</strong>
            <span>{String(preview.jobRecordSource)}</span>
          </div>
        ) : null}
        {preview.qualityScore !== null && preview.qualityScore !== undefined ? (
          <div style={messageStyles.emailField}>
            <strong>质量分</strong>
            <span>{String(preview.qualityScore)}</span>
          </div>
        ) : null}
      </div>
      <div style={messageStyles.emailActions}>
        {link?.href ? (
          <a href={link.href} target="_blank" rel="noreferrer" title={link.title} style={messageStyles.jobSourceLink}>
            <ExternalLink size={13} aria-hidden="true" />
            打开原帖
          </a>
        ) : <span />}
        {!sent ? (
          <span style={messageStyles.emailActionButtons}>
            {applicationEmail ? (
              <button
                type="button"
                onClick={() => onAction?.(polishPrompt)}
                disabled={busy || !onAction || !noteId || !draftBody.trim()}
                style={messageStyles.polishButton}
              >
                <WandSparkles size={14} aria-hidden="true" />
                润色邮件
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onAction?.(sendPrompt)}
              disabled={busy || !onAction || !canPreview}
              style={messageStyles.sendEmailButton}
              title={canPreview ? "进入邮件预览与发送确认" : "请先补齐收件人、标题或正文"}
            >
              <Send size={14} aria-hidden="true" />
              预览并发送
            </button>
          </span>
        ) : null}
      </div>
    </>
  );
}

function SemanticToolResult({
  result,
  sessionId,
  busy = false,
  onAction,
  jobId,
}: {
  result: unknown;
  sessionId: string;
  busy?: boolean;
  onAction?: (prompt: string) => void;
  jobId?: string;
}) {
  const value = objectValue(result);
  if (value.type === "table.result" && Array.isArray(value.rows)) {
    const rows = value.rows
      .filter((row) => row && typeof row === "object")
      .slice(0, 8) as Record<string, unknown>[];
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(
      0,
      8,
    );
    return (
      <div style={messageStyles.tableResult}>
        <div style={messageStyles.resultSummary}>
          共 {Number(value.total ?? value.rows.length).toLocaleString("zh-CN")}{" "}
          条{value.truncated ? " · 当前仅展示部分结果" : ""}
        </div>
        {rows.length ? (
          <div style={messageStyles.tableScroll}>
            <table style={messageStyles.table}>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column} style={messageStyles.tableHeadCell}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {columns.map((column) => (
                      <td
                        key={column}
                        title={prettyValue(row[column])}
                        style={messageStyles.tableCell}
                      >
                        {prettyValue(row[column]).slice(0, 120) || "-"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={messageStyles.resultEmpty}>没有匹配记录</div>
        )}
      </div>
    );
  }
  if (value.type === "artifact.ready") {
    const artifact = objectValue(value.artifact ?? value);
    const artifactId = String(artifact.artifactId ?? "");
    const displayName = String(
      artifact.displayName ?? artifact.name ?? "数据产物",
    );
    const sources = listText(artifact.source);
    const recordIds = Array.isArray(artifact.sourceRecordIds)
      ? artifact.sourceRecordIds.map(String)
      : [];
    const artifactMeta = [
      Number.isFinite(Number(artifact.rowCount))
        ? `${Number(artifact.rowCount).toLocaleString("zh-CN")} 行`
        : "",
      formatBytes(artifact.size),
      artifact.sha256 ? `SHA-256 ${String(artifact.sha256).slice(0, 12)}…` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div style={messageStyles.artifactResult}>
        <FileText size={16} aria-hidden="true" />
        <span style={messageStyles.artifactDetails}>
          <span style={messageStyles.artifactName}>{displayName}</span>
          {artifactMeta ? (
            <span style={messageStyles.artifactMeta}>{artifactMeta}</span>
          ) : null}
          {sources ? (
            <span style={messageStyles.artifactMeta}>来源：{sources}</span>
          ) : null}
          {recordIds.length ? (
            <span
              style={messageStyles.artifactMeta}
              title={recordIds.join("、")}
            >
              来源记录：{recordIds.slice(0, 5).join("、")}
              {recordIds.length > 5
                ? ` 等 ${Number(artifact.sourceRecordCount || recordIds.length)} 条`
                : ""}
            </span>
          ) : null}
          {artifact.query ? (
            <span style={messageStyles.artifactMeta}>
              查询：{prettyValue(artifact.query).replaceAll("\n", " ")}
            </span>
          ) : null}
        </span>
        {artifactId ? (
          <a
            href={`/api/copilot/conversations/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`}
            download={displayName}
            title="下载产物"
            aria-label={`下载${displayName}`}
            style={messageStyles.artifactDownload}
          >
            <Download size={14} aria-hidden="true" />
          </a>
        ) : null}
      </div>
    );
  }
  if (
    value.type === "email.draft" ||
    value.type === "email.sent" ||
    value.type === "application.email_draft"
  ) {
    const preview = objectValue(value.preview ?? value);
    const application = objectValue(preview.application ?? value.application ?? value);
    const subjectRule = objectValue(application.subjectRule ?? preview.subjectRule);
    const subject = String(preview.subject ?? "");
    const body = String(preview.text ?? preview.body ?? "");
    const sourceUrl = String(application.sourceUrl ?? "");
    const post = objectValue(application.post ?? preview.post);
    const noteId = String(application.noteId ?? preview.applicationNoteId ?? "");
    const isApplicationEmail =
      value.type === "application.email_draft" || Boolean(noteId);
    const link = sourceUrl ? safeLink(sourceUrl) : null;
    const ruleStatus = String(subjectRule.status ?? "");
    const ruleLabel = {
      compliant: "符合招聘标题要求",
      missing_fields: "标题字段待补充",
      non_compliant: "标题不符合招聘要求",
      not_applicable: "原帖未指定标题格式",
    }[ruleStatus] ?? "";
    return (
      <div style={messageStyles.emailResult} data-testid="application-email-result">
        <div style={messageStyles.deliveryHeader}>
          <div style={messageStyles.deliveryHeading}>
            <span style={messageStyles.deliveryIdentity}>
              {value.type === "email.sent" ? <Send size={16} aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}
              <strong>{value.type === "email.sent" ? "邮件已发送" : "岗位投递邮件"}</strong>
            </span>
            {application.jobTitle || application.company ? (
              <span style={messageStyles.deliverySubtitle}>
                {[application.jobTitle, application.company].filter(Boolean).map(String).join(" · ")}
              </span>
            ) : null}
          </div>
          <span style={value.type === "email.sent" ? messageStyles.sentBadge : messageStyles.draftBadge}>
            {value.type === "email.sent" ? "已发送" : preview.sendReady === false ? "待补充" : "草稿"}
          </span>
        </div>
        <OriginalPostPreview post={post} jobId={jobId} />
        <ApplicationEmailEditor
          preview={preview}
          subjectRule={subjectRule}
          subject={subject}
          body={body}
          ruleLabel={ruleLabel}
          ruleStatus={ruleStatus}
          noteId={noteId}
          sent={value.type === "email.sent"}
          applicationEmail={isApplicationEmail}
          busy={busy}
          onAction={onAction}
          link={link}
        />
      </div>
    );
  }
  return null;
}

function ToolCallCard({
  toolCall,
  sessionId,
  busy = false,
  onAction,
  jobId,
}: {
  toolCall: DataCopilotToolCall;
  sessionId: string;
  busy?: boolean;
  onAction?: (prompt: string) => void;
  jobId?: string;
}) {
  const semanticType = String(objectValue(toolCall.result).type ?? "");
  const hasSemanticResult = [
    "table.result",
    "artifact.ready",
    "email.draft",
    "email.sent",
    "application.email_draft",
  ].includes(semanticType);
  const [expanded, setExpanded] = useState(
    toolCall.status === "running" ||
      toolCall.status === "failed" ||
      ["email.draft", "email.sent", "application.email_draft"].includes(
        semanticType,
      ),
  );
  const argumentsText = prettyValue(toolCall.arguments);
  const resultText = prettyValue(toolCall.result);
  const semanticResult = (
    <SemanticToolResult
      result={toolCall.result}
      sessionId={sessionId}
      busy={busy}
      onAction={onAction}
      jobId={jobId}
    />
  );

  if (
    toolCall.status === "complete" &&
    ["email.draft", "email.sent", "application.email_draft"].includes(semanticType)
  ) {
    return <>{semanticResult}</>;
  }

  return (
    <section
      style={{
        ...messageStyles.toolCard,
        ...(toolCall.status === "failed"
          ? messageStyles.toolCardFailed
          : undefined),
      }}
      aria-label={`工具调用 ${toolCall.name}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        style={messageStyles.toolHeader}
      >
        <span style={messageStyles.toolIdentity}>
          <ToolStatusIcon status={toolCall.status} />
          <Wrench size={14} aria-hidden="true" />
          <strong style={messageStyles.toolName} title={toolCall.name}>
            {toolDisplayName(toolCall.name)}
          </strong>
        </span>
        <span style={messageStyles.toolStatus}>
          {toolStatusLabel(toolCall.status)}
          {expanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
        </span>
      </button>
      {expanded ? (
        <div style={messageStyles.toolDetails}>
          {!hasSemanticResult && argumentsText ? (
            <div>
              <div style={messageStyles.detailLabel}>输入</div>
              <pre style={messageStyles.codeBlock}>{argumentsText}</pre>
            </div>
          ) : null}
          {resultText ? (
            <div>
              {!hasSemanticResult ? (
                <div style={messageStyles.detailLabel}>结果</div>
              ) : null}
              {semanticResult}
              {!hasSemanticResult ? (
                <pre style={messageStyles.codeBlock}>{resultText}</pre>
              ) : null}
            </div>
          ) : null}
          {toolCall.error ? (
            <div style={messageStyles.toolError}>{toolCall.error}</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ApprovalCard({
  message,
  busy,
  onApproval,
}: {
  message: DataCopilotMessageData;
  busy: boolean;
  onApproval?: (message: DataCopilotMessageData, approved: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const approval = message.approval;
  if (!approval) return null;
  const pending = approval.status === "pending";
  const detail = prettyValue(approval.arguments);
  const statusLabel = {
    pending: "等待确认",
    approved: "已确认",
    rejected: "已取消",
    cancelled: "已取消",
    expired: "已过期",
    consumed: "已执行",
  }[approval.status];

  return (
    <section style={messageStyles.approvalCard} aria-label="操作确认">
      <div style={messageStyles.approvalHeader}>
        <span style={messageStyles.approvalIdentity}>
          <ShieldCheck size={15} aria-hidden="true" />
          <strong>执行确认</strong>
        </span>
        <span style={messageStyles.approvalStatus}>{statusLabel}</span>
      </div>
      <div style={messageStyles.approvalSummary}>{approval.summary}</div>
      {approval.toolName ? (
        <div style={messageStyles.approvalMeta}>工具：{approval.toolName}</div>
      ) : null}
      {detail ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            style={messageStyles.approvalDetailButton}
          >
            {expanded ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} aria-hidden="true" />
            )}
            {expanded ? "收起执行参数" : "核对执行参数"}
          </button>
          {expanded ? (
            <pre style={messageStyles.codeBlock}>{detail}</pre>
          ) : null}
        </>
      ) : null}
      {pending && onApproval ? (
        <div style={messageStyles.approvalActions}>
          <button
            type="button"
            onClick={() => onApproval(message, false)}
            disabled={busy}
            style={messageStyles.approvalRejectButton}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onApproval(message, true)}
            disabled={busy}
            style={messageStyles.approvalConfirmButton}
          >
            <Check size={13} aria-hidden="true" />
            确认执行
          </button>
        </div>
      ) : null}
    </section>
  );
}

function MessageIdentity({ message }: { message: DataCopilotMessageData }) {
  if (message.role === "user")
    return <UserRound size={15} aria-hidden="true" />;
  if (message.role === "tool")
    return <TerminalSquare size={15} aria-hidden="true" />;
  if (message.kind === "error")
    return <AlertCircle size={15} aria-hidden="true" />;
  return <Bot size={15} aria-hidden="true" />;
}

export function DataCopilotMessage({
  message,
  busy = false,
  approvalBusy = busy,
  onRetry,
  onOpenAttachment,
  onOpenCitation,
  onApproval,
  onAction,
  jobId,
}: DataCopilotMessageProps) {
  const [copied, setCopied] = useState(false);
  const [analysisExpanded, setAnalysisExpanded] = useState(false);
  const [expandedCitationId, setExpandedCitationId] = useState<string | null>(
    null,
  );
  const isUser = message.role === "user";
  const isCompact = message.role === "system" || message.kind === "status";
  const isError = message.kind === "error" || message.status === "failed";

  const copyContent = async () => {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const openAttachment = (attachment: DataCopilotAttachment) => {
    if (onOpenAttachment) onOpenAttachment(attachment);
    else if (attachment.url)
      window.open(attachment.url, "_blank", "noopener,noreferrer");
  };

  const openCitation = (citation: DataCopilotCitation) => {
    if (onOpenCitation) onOpenCitation(citation);
    else if (citation.url)
      window.open(citation.url, "_blank", "noopener,noreferrer");
    else
      setExpandedCitationId((current) =>
        current === citation.id ? null : citation.id,
      );
  };

  if (isCompact) {
    return (
      <div style={messageStyles.compactRow} role="status">
        <span style={messageStyles.compactRule} />
        <span style={messageStyles.compactContent}>
          <span>{message.content}</span>
          <time dateTime={message.createdAt}>
            {formatTime(message.createdAt)}
          </time>
          {message.retryable && onRetry ? (
            <button
              type="button"
              onClick={() => onRetry(message)}
              disabled={busy}
              style={messageStyles.textAction}
              title="继续执行"
            >
              <RefreshCw size={13} aria-hidden="true" />
              继续
            </button>
          ) : null}
        </span>
        <span style={messageStyles.compactRule} />
      </div>
    );
  }

  return (
    <article
      style={{
        ...messageStyles.row,
        ...(isUser ? messageStyles.userRow : undefined),
      }}
      aria-label={
        isUser ? "你的消息" : isError ? "错误消息" : "Data Copilot 消息"
      }
    >
      <div
        style={{
          ...messageStyles.avatar,
          ...(isUser ? messageStyles.userAvatar : undefined),
          ...(isError ? messageStyles.errorAvatar : undefined),
        }}
      >
        <MessageIdentity message={message} />
      </div>

      <div style={messageStyles.body}>
        <header style={messageStyles.messageHeader}>
          <span style={messageStyles.author}>
            {isUser ? "你" : message.role === "tool" ? "工具" : "Data Copilot"}
          </span>
          <time style={messageStyles.timestamp} dateTime={message.createdAt}>
            {formatTime(message.createdAt)}
          </time>
          {message.status === "streaming" || message.status === "pending" ? (
            <LoaderCircle
              size={13}
              aria-label="生成中"
              style={messageStyles.spinningIcon}
            />
          ) : null}
        </header>

        {message.kind === "analysis" ? (
          <section style={messageStyles.analysisBlock}>
            <button
              type="button"
              onClick={() => setAnalysisExpanded((value) => !value)}
              aria-expanded={analysisExpanded}
              style={messageStyles.analysisHeader}
            >
              <span>分析过程</span>
              {analysisExpanded ? (
                <ChevronDown size={14} aria-hidden="true" />
              ) : (
                <ChevronRight size={14} aria-hidden="true" />
              )}
            </button>
            {analysisExpanded ? (
              <div style={messageStyles.analysisText}>{message.content}</div>
            ) : null}
          </section>
        ) : message.content ? (
          <div
            style={{
              ...messageStyles.content,
              ...(isError ? messageStyles.errorContent : undefined),
            }}
          >
            {isUser || isError ? (
              message.content
            ) : (
              <StructuredAssistantContent content={message.content} busy={busy} onAction={onAction} />
            )}
          </div>
        ) : null}

        {message.approval ? (
          <ApprovalCard
            message={message}
            busy={approvalBusy}
            onApproval={onApproval}
          />
        ) : null}

        {message.toolCalls?.length ? (
          <div style={messageStyles.toolStack}>
            {message.toolCalls.map((toolCall) => (
              <ToolCallCard
                key={toolCall.id}
                toolCall={toolCall}
                sessionId={message.sessionId}
                busy={busy}
                onAction={onAction}
                jobId={jobId}
              />
            ))}
          </div>
        ) : null}

        {message.attachments?.length ? (
          <div style={messageStyles.attachmentList} aria-label="消息附件">
            {message.attachments.map((attachment) => (
              <button
                type="button"
                key={attachment.id}
                onClick={() => openAttachment(attachment)}
                disabled={!onOpenAttachment && !attachment.url}
                style={messageStyles.attachmentButton}
                title={attachment.name}
              >
                <FileText size={14} aria-hidden="true" />
                <span style={messageStyles.attachmentName}>
                  {attachment.name}
                </span>
                <span style={messageStyles.attachmentState}>
                  {attachment.status}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {message.citations?.length ? (
          <div style={messageStyles.citationList} aria-label="数据引用">
            {message.citations.map((citation, index) => (
              <div key={citation.id} style={messageStyles.citationItem}>
                <button
                  type="button"
                  onClick={() => openCitation(citation)}
                  title={citation.excerpt ?? citation.label}
                  aria-expanded={
                    !onOpenCitation && !citation.url
                      ? expandedCitationId === citation.id
                      : undefined
                  }
                  style={messageStyles.citationButton}
                >
                  [{index + 1}] {citation.label}
                </button>
                {expandedCitationId === citation.id &&
                !onOpenCitation &&
                !citation.url ? (
                  <span style={messageStyles.citationDetail}>
                    {citation.excerpt || citation.sourceId}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <footer style={messageStyles.actions}>
          {message.content ? (
            <button
              type="button"
              onClick={() => void copyContent()}
              style={messageStyles.iconAction}
              title="复制消息"
              aria-label="复制消息"
            >
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Clipboard size={14} aria-hidden="true" />
              )}
            </button>
          ) : null}
          {message.retryable && onRetry ? (
            <button
              type="button"
              onClick={() => onRetry(message)}
              disabled={busy}
              style={messageStyles.textAction}
              title="重试这条消息"
            >
              <RefreshCw size={13} aria-hidden="true" />
              重试
            </button>
          ) : null}
        </footer>
      </div>
    </article>
  );
}

const messageStyles: Record<string, CSSProperties> = {
  row: {
    display: "grid",
    gridTemplateColumns: "28px minmax(0, 1fr)",
    gap: 10,
    width: "100%",
    padding: "13px 16px",
    borderBottom: "1px solid #eceeec",
    color: "#202522",
  },
  userRow: { background: "#fafbf9" },
  avatar: {
    display: "grid",
    width: 28,
    height: 28,
    placeItems: "center",
    border: "1px solid #bfd8cf",
    borderRadius: 5,
    background: "#edf7f3",
    color: "#0b705b",
  },
  userAvatar: { borderColor: "#d7dad7", background: "#fff", color: "#4e5752" },
  errorAvatar: {
    borderColor: "#efc4bd",
    background: "#fff3f1",
    color: "#b23b2d",
  },
  body: { minWidth: 0 },
  messageHeader: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    minHeight: 22,
  },
  author: { color: "#303832", fontSize: 12, fontWeight: 650 },
  timestamp: { color: "#858c88", fontSize: 10 },
  content: {
    marginTop: 5,
    color: "#29312c",
    fontSize: 13,
    lineHeight: 1.65,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  richContent: { display: "grid", gap: 8, whiteSpace: "normal" },
  richParagraph: { margin: 0, lineHeight: 1.68 },
  richHeading: {
    margin: "4px 0 0",
    color: "#1f2b25",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0,
  },
  richListItem: {
    display: "grid",
    gridTemplateColumns: "6px minmax(0, 1fr)",
    gap: 8,
    alignItems: "start",
  },
  inlineLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    margin: "0 2px",
    color: "#0b705b",
    fontWeight: 600,
    textDecoration: "none",
  },
  emailLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    color: "#176e59",
    textDecoration: "none",
  },
  contactList: {
    display: "grid",
    gap: 7,
    padding: "9px 0",
    borderTop: "1px solid #e1e6e2",
    borderBottom: "1px solid #e1e6e2",
  },
  sectionLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "#415048",
    fontSize: 10,
    fontWeight: 700,
  },
  contactGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: 5,
  },
  contactItem: {
    overflow: "hidden",
    color: "#176e59",
    fontSize: 11,
    fontWeight: 600,
    textDecoration: "none",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  deliveryLead: {
    display: "grid",
    gridTemplateColumns: "18px minmax(0, 1fr) auto",
    gap: 7,
    alignItems: "start",
    padding: "8px 0",
    borderBottom: "1px solid #e7ebe8",
    color: "#4d5a53",
  },
  deliveryLeadBody: { display: "grid", minWidth: 0, gap: 2, fontSize: 10 },
  sourceButton: {
    display: "inline-flex",
    height: 25,
    alignItems: "center",
    gap: 4,
    padding: "0 7px",
    border: "1px solid #cdded7",
    borderRadius: 4,
    color: "#176e59",
    fontSize: 9,
    fontWeight: 600,
    textDecoration: "none",
  },
  errorContent: {
    padding: "8px 10px",
    border: "1px solid #efcac4",
    borderRadius: 5,
    background: "#fff6f4",
    color: "#96372b",
  },
  compactRow: {
    display: "grid",
    gridTemplateColumns: "minmax(16px, 1fr) auto minmax(16px, 1fr)",
    gap: 9,
    alignItems: "center",
    padding: "10px 16px",
    color: "#7a827d",
    fontSize: 10,
  },
  compactContent: { display: "inline-flex", alignItems: "center", gap: 8 },
  compactRule: { height: 1, background: "#e2e5e2" },
  analysisBlock: {
    overflow: "hidden",
    marginTop: 6,
    border: "1px solid #d9dedb",
    borderRadius: 5,
    background: "#f7f8f6",
  },
  analysisHeader: {
    display: "flex",
    width: "100%",
    minHeight: 32,
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 10px",
    border: 0,
    background: "transparent",
    color: "#555f59",
    fontSize: 11,
    cursor: "pointer",
  },
  analysisText: {
    padding: "0 10px 10px",
    color: "#59625d",
    fontSize: 11,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
  },
  approvalCard: {
    display: "grid",
    gap: 8,
    marginTop: 9,
    padding: 10,
    border: "1px solid #d7c99f",
    borderRadius: 6,
    background: "#fffdf5",
  },
  approvalHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  approvalIdentity: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "#66531b",
    fontSize: 11,
  },
  approvalStatus: { color: "#806b2b", fontSize: 10 },
  approvalSummary: {
    color: "#3f3a2b",
    fontSize: 11,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
  },
  approvalMeta: { color: "#746b51", fontSize: 10 },
  approvalDetailButton: {
    display: "inline-flex",
    width: "fit-content",
    alignItems: "center",
    gap: 3,
    padding: 0,
    border: 0,
    background: "transparent",
    color: "#665b3c",
    fontSize: 10,
    cursor: "pointer",
  },
  approvalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 6,
    paddingTop: 2,
  },
  approvalRejectButton: {
    height: 29,
    padding: "0 10px",
    border: "1px solid #d3d8d4",
    borderRadius: 5,
    background: "#fff",
    color: "#4f5953",
    fontSize: 11,
    cursor: "pointer",
  },
  approvalConfirmButton: {
    display: "inline-flex",
    height: 29,
    alignItems: "center",
    gap: 5,
    padding: "0 10px",
    border: "1px solid #08705a",
    borderRadius: 5,
    background: "#0b7a62",
    color: "#fff",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  },
  toolStack: { display: "grid", gap: 6, marginTop: 8 },
  toolCard: {
    overflow: "hidden",
    border: "1px solid #d8ded9",
    borderRadius: 5,
    background: "#fbfcfa",
  },
  toolCardFailed: { borderColor: "#e9bbb3" },
  toolHeader: {
    display: "flex",
    width: "100%",
    minHeight: 34,
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "0 9px",
    border: 0,
    background: "transparent",
    color: "#4d5751",
    cursor: "pointer",
  },
  toolIdentity: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  toolName: {
    overflow: "hidden",
    fontSize: 11,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  toolStatus: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    color: "#757e79",
    fontSize: 10,
  },
  toolDetails: {
    display: "grid",
    gap: 8,
    padding: "8px 9px",
    borderTop: "1px solid #e5e8e5",
  },
  detailLabel: {
    marginBottom: 4,
    color: "#727a75",
    fontSize: 10,
    fontWeight: 600,
  },
  codeBlock: {
    maxHeight: 220,
    overflow: "auto",
    margin: 0,
    padding: 8,
    borderRadius: 4,
    background: "#202622",
    color: "#e8ede9",
    fontFamily: "Consolas, ui-monospace, monospace",
    fontSize: 10,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  toolError: { color: "#a33d30", fontSize: 11, lineHeight: 1.5 },
  tableResult: { display: "grid", gap: 6, minWidth: 0 },
  resultSummary: { color: "#5d6761", fontSize: 10 },
  resultEmpty: { padding: "12px 0", color: "#7b837f", fontSize: 11 },
  tableScroll: {
    maxWidth: "100%",
    overflowX: "auto",
    borderTop: "1px solid #e1e5e2",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    color: "#323a35",
    fontSize: 10,
  },
  tableHeadCell: {
    padding: "6px 8px",
    borderBottom: "1px solid #dce1dd",
    background: "#f2f5f2",
    textAlign: "left",
    whiteSpace: "nowrap",
  },
  tableCell: {
    maxWidth: 220,
    padding: "6px 8px",
    borderBottom: "1px solid #e7eae7",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  artifactResult: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    gap: 7,
    alignItems: "center",
    minHeight: 34,
    color: "#3d4942",
  },
  artifactDetails: { display: "grid", minWidth: 0, gap: 2 },
  artifactName: {
    overflow: "hidden",
    fontSize: 11,
    fontWeight: 600,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  artifactMeta: {
    overflow: "hidden",
    color: "#707a74",
    fontSize: 9,
    lineHeight: 1.4,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  artifactDownload: {
    display: "grid",
    width: 28,
    height: 28,
    placeItems: "center",
    color: "#0b705b",
  },
  emailResult: {
    display: "grid",
    overflow: "hidden",
    border: "1px solid #ced9d3",
    borderRadius: 6,
    background: "#fff",
    color: "#404943",
    fontSize: 11,
    boxShadow: "0 2px 8px rgba(36, 54, 45, 0.06)",
  },
  deliveryHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    minHeight: 54,
    padding: "9px 12px",
    borderBottom: "1px solid #dfe5e1",
    background: "#f5f9f7",
  },
  deliveryHeading: { display: "grid", minWidth: 0, gap: 2 },
  deliveryIdentity: { display: "inline-flex", alignItems: "center", gap: 6, color: "#1d5f4e" },
  deliverySubtitle: {
    overflow: "hidden",
    color: "#65716b",
    fontSize: 10,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  draftBadge: {
    padding: "2px 6px",
    border: "1px solid #c7ddd5",
    borderRadius: 4,
    background: "#eef7f3",
    color: "#176e59",
    fontSize: 9,
    fontWeight: 700,
  },
  sentBadge: {
    padding: "2px 6px",
    border: "1px solid #a9d3c4",
    borderRadius: 4,
    background: "#def2ea",
    color: "#0a6b55",
    fontSize: 9,
    fontWeight: 700,
  },
  jobLine: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: 6,
    padding: "2px 0 5px",
    color: "#33413a",
    fontWeight: 650,
  },
  postPreview: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(190px, 100%), 1fr))",
    gap: 12,
    padding: 12,
    borderBottom: "1px solid #e2e7e4",
    background: "#fbfcfb",
  },
  postMedia: { display: "grid", minWidth: 0, gap: 6, alignContent: "start" },
  postImage: {
    display: "block",
    width: "100%",
    height: "100%",
    aspectRatio: "4 / 3",
    borderRadius: 4,
    objectFit: "cover",
    background: "#eef1ef",
  },
  postImageFallback: {
    display: "grid",
    width: "100%",
    aspectRatio: "4 / 3",
    placeItems: "center",
    alignContent: "center",
    gap: 5,
    borderRadius: 4,
    background: "#eef1ef",
    color: "#77817b",
    fontSize: 9,
  },
  postThumbnails: {
    display: "grid",
    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
    gap: 4,
  },
  postThumbnailButton: {
    overflow: "hidden",
    minWidth: 0,
    padding: 0,
    border: "2px solid transparent",
    borderRadius: 4,
    background: "transparent",
    cursor: "pointer",
    opacity: 0.72,
  },
  postThumbnailButtonActive: { borderColor: "#16806a", opacity: 1 },
  postContent: { display: "grid", minWidth: 0, alignContent: "start", gap: 7 },
  postEyebrow: { color: "#0b705b", fontSize: 9, fontWeight: 700 },
  postTitle: { color: "#27332d", fontSize: 13, lineHeight: 1.45 },
  postBody: {
    display: "-webkit-box",
    overflow: "hidden",
    color: "#505c55",
    fontSize: 10,
    lineHeight: 1.65,
    whiteSpace: "pre-wrap",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 6,
  },
  postBodyExpanded: { display: "block", maxHeight: 260, overflow: "auto" },
  requirementList: { display: "grid", gap: 4, paddingTop: 2 },
  requirementItem: {
    paddingLeft: 7,
    borderLeft: "2px solid #a9c8bd",
    color: "#5b6760",
    fontSize: 9,
    lineHeight: 1.5,
  },
  postExpandButton: {
    display: "inline-flex",
    width: "fit-content",
    height: 25,
    alignItems: "center",
    gap: 3,
    padding: 0,
    border: 0,
    background: "transparent",
    color: "#176e59",
    fontSize: 10,
    fontWeight: 600,
    cursor: "pointer",
  },
  inlineDeliveryActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: 7,
    marginTop: 8,
    paddingTop: 10,
    borderTop: "1px solid #e2e7e4",
  },
  inlineDraftButton: {
    display: "inline-flex",
    minHeight: 31,
    alignItems: "center",
    gap: 5,
    padding: "0 10px",
    border: "1px solid #b8cbc3",
    borderRadius: 5,
    background: "#fff",
    color: "#315f52",
    fontSize: 11,
    fontWeight: 650,
    cursor: "pointer",
  },
  inlinePreviewButton: {
    display: "inline-flex",
    minHeight: 31,
    alignItems: "center",
    gap: 5,
    padding: "0 10px",
    border: "1px solid #2f755f",
    borderRadius: 5,
    background: "#eef6f2",
    color: "#185d4b",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
  },
  emailContent: { display: "grid", gap: 8, padding: 12 },
  emailMetaGrid: { display: "grid", gap: 3 },
  emailField: {
    display: "grid",
    minWidth: 0,
    gridTemplateColumns: "52px minmax(0, 1fr) auto",
    gap: 7,
    alignItems: "start",
    padding: "3px 0",
  },
  emailSubjectInput: {
    width: "100%",
    minWidth: 0,
    minHeight: 28,
    padding: "4px 7px",
    border: "1px solid #d3dcd7",
    borderRadius: 4,
    outline: "none",
    background: "#fff",
    color: "#27332d",
    font: "inherit",
    lineHeight: 1.45,
  },
  copyFieldButton: {
    display: "grid",
    width: 24,
    height: 24,
    placeItems: "center",
    padding: 0,
    border: 0,
    borderRadius: 4,
    background: "transparent",
    color: "#65726b",
    cursor: "pointer",
  },
  subjectRule: {
    display: "grid",
    gridTemplateColumns: "15px minmax(0, 1fr)",
    gap: 6,
    padding: "6px 8px",
    borderLeft: "3px solid #74ad99",
    background: "#f3f8f6",
    color: "#54625b",
    fontSize: 10,
    lineHeight: 1.5,
  },
  jobSourceLink: {
    display: "inline-flex",
    width: "fit-content",
    alignItems: "center",
    gap: 4,
    color: "#176e59",
    minHeight: 30,
    fontSize: 10,
    fontWeight: 600,
    textDecoration: "none",
  },
  emailBodyHeader: {
    display: "flex",
    minHeight: 25,
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
    paddingTop: 7,
    borderTop: "1px solid #dfe5e1",
  },
  emailBodyTools: { display: "inline-flex", alignItems: "center", gap: 4 },
  resetDraftButton: {
    display: "inline-flex",
    minHeight: 24,
    alignItems: "center",
    gap: 4,
    padding: "0 6px",
    border: 0,
    borderRadius: 4,
    background: "transparent",
    color: "#5a6961",
    fontSize: 10,
    cursor: "pointer",
  },
  emailBodyEditor: {
    width: "100%",
    minHeight: 170,
    maxHeight: 360,
    resize: "vertical",
    padding: "10px 11px",
    border: "1px solid #d5ddd8",
    borderLeft: "3px solid #a9c8bd",
    borderRadius: 4,
    outline: "none",
    background: "#fbfcfb",
    color: "#333b36",
    font: "inherit",
    fontSize: 11,
    lineHeight: 1.65,
    whiteSpace: "pre-wrap",
  },
  emailActions: {
    display: "flex",
    minHeight: 52,
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "9px 12px",
    borderTop: "1px solid #dfe5e1",
    background: "#fafcfb",
  },
  emailActionButtons: { display: "flex", flexWrap: "wrap", gap: 6 },
  polishButton: {
    display: "inline-flex",
    height: 32,
    alignItems: "center",
    gap: 5,
    padding: "0 10px",
    border: "1px solid #b9ccc4",
    borderRadius: 5,
    background: "#fff",
    color: "#315f52",
    fontSize: 10,
    fontWeight: 650,
    cursor: "pointer",
  },
  sendEmailButton: {
    display: "inline-flex",
    height: 32,
    alignItems: "center",
    gap: 5,
    padding: "0 11px",
    border: "1px solid #0b705b",
    borderRadius: 5,
    background: "#0b7a62",
    color: "#fff",
    fontSize: 10,
    fontWeight: 700,
    cursor: "pointer",
  },
  attachmentList: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9 },
  attachmentButton: {
    display: "flex",
    maxWidth: 280,
    height: 32,
    alignItems: "center",
    gap: 6,
    padding: "0 8px",
    border: "1px solid #d8dcd9",
    borderRadius: 5,
    background: "#fff",
    color: "#47514b",
    cursor: "pointer",
  },
  attachmentName: {
    overflow: "hidden",
    fontSize: 11,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  attachmentState: { color: "#818985", fontSize: 9 },
  citationList: { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 },
  citationItem: {
    display: "flex",
    maxWidth: "100%",
    flexDirection: "column",
    gap: 3,
  },
  citationButton: {
    minHeight: 25,
    padding: "0 7px",
    border: "1px solid #cddfd8",
    borderRadius: 4,
    background: "#f1f8f5",
    color: "#176e59",
    fontSize: 10,
    cursor: "pointer",
  },
  citationDetail: {
    maxWidth: 320,
    padding: "5px 7px",
    border: "1px solid #d9e5e0",
    borderRadius: 4,
    background: "#f8fbfa",
    color: "#55625e",
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    fontSize: 9,
    overflowWrap: "anywhere",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    minHeight: 25,
    marginTop: 5,
  },
  iconAction: {
    display: "grid",
    width: 25,
    height: 25,
    placeItems: "center",
    padding: 0,
    border: 0,
    borderRadius: 4,
    background: "transparent",
    color: "#747d78",
    cursor: "pointer",
  },
  textAction: {
    display: "inline-flex",
    height: 25,
    alignItems: "center",
    gap: 4,
    padding: "0 6px",
    border: 0,
    borderRadius: 4,
    background: "transparent",
    color: "#65706a",
    fontSize: 10,
    cursor: "pointer",
  },
  spinningIcon: { animation: "data-copilot-spin 1s linear infinite" },
};
