import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import {
  AlertCircle,
  ArrowUpDown,
  Bot,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clipboard,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  Mail,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Search,
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
import { parseAnswerAst, type AnswerBlock } from "./copilot/answer-ast";

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
  if (name === "attachment.parse") return "附件解析";
  if (name === "attachment.list") return "读取附件";
  if (name === "applications.extract_email_requirements") return "批量提取邮件要求";
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

function semanticType(toolCall: DataCopilotToolCall) {
  return String(objectValue(toolCall.result).type ?? "");
}

function isRichToolCall(toolCall: DataCopilotToolCall) {
  return [
    "table.result",
    "artifact.ready",
    "email.draft",
    "email.sent",
    "application.email_draft",
    "application.batch_preflight",
    "application.batch",
  ].includes(semanticType(toolCall));
}

function AnswerAstContent({
  content,
  busy = false,
  onAction,
}: {
  content: string;
  busy?: boolean;
  onAction?: (prompt: string) => void;
}) {
  const ast = parseAnswerAst(content);
  const renderBlock = (block: AnswerBlock, index: number): ReactElement => {
    const key = block.id || `answer-block-${index}`;
    const text = typeof block.content === "string" ? block.content : "";
    if (block.kind === "heading") {
      const level = Math.min(6, Math.max(2, Number(block.level || 2)));
      return <h4 key={key} aria-level={level} style={{ ...messageStyles.richHeading, fontSize: level <= 2 ? 16 : level <= 3 ? 14 : 13 }}>{text}</h4>;
    }
    if (block.kind === "paragraph") {
      return <p key={key} style={messageStyles.richParagraph}><InlineSafeText text={text} /></p>;
    }
    if (block.kind === "quote") {
      return <blockquote key={key} style={{ margin: "8px 0", padding: "8px 12px", borderLeft: "3px solid #a8cfc2", background: "#f5faf8", color: "#53625a", whiteSpace: "pre-wrap" }}><InlineSafeText text={text} /></blockquote>;
    }
    if (block.kind === "code") {
      const code = objectValue(block.content);
      const value = String(code.code ?? text);
      return <div key={key} style={{ margin: "10px 0", border: "1px solid #d8e2dd", borderRadius: 6, overflow: "hidden", background: "#18221e" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 9px", color: "#b8cbc1", fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          <span>{String(code.language || "code")}</span>
          <CopyFieldButton value={value} label="code" />
        </div>
        <pre style={{ margin: 0, padding: "10px 12px", overflowX: "auto", color: "#edf7f1", fontSize: 12, lineHeight: 1.55, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" }}>{value}</pre>
      </div>;
    }
    if (block.kind === "table") {
      const table = objectValue(block.content);
      const headers = Array.isArray(table.headers) ? table.headers.map(String) : [];
      const rows = Array.isArray(table.rows) ? table.rows.map((row) => Array.isArray(row) ? row.map(String) : [String(row)]) : [];
      return <div key={key} style={{ overflowX: "auto", margin: "10px 0" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        {headers.length ? <thead><tr>{headers.map((header, cellIndex) => <th key={`${key}-h-${cellIndex}`} style={{ padding: "7px 9px", textAlign: "left", borderBottom: "1px solid #bdcec6", color: "#34483e", background: "#f3f8f5", fontWeight: 700 }}>{header}</th>)}</tr></thead> : null}
        <tbody>{rows.map((row, rowIndex) => <tr key={`${key}-r-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${key}-${rowIndex}-${cellIndex}`} style={{ padding: "7px 9px", borderBottom: "1px solid #e5ece8", verticalAlign: "top" }}><InlineSafeText text={cell} /></td>)}</tr>)}</tbody>
      </table></div>;
    }
    if (block.kind === "list" || block.kind === "checklist") {
      const items = Array.isArray(block.content) ? block.content : [];
      return <div key={key} style={{ display: "grid", gap: 6, margin: "8px 0" }}>{items.map((item, itemIndex) => {
        const entry = objectValue(item);
        const itemText = String(entry.text ?? item);
        const checked = Boolean(entry.checked);
        return <div key={`${key}-${itemIndex}`} style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: 1.55 }}>
          <span aria-hidden="true" style={{ display: "grid", flex: "0 0 auto", width: 16, height: 16, placeItems: "center", marginTop: 2, border: `1px solid ${checked ? "#2f8b72" : "#aabdb4"}`, borderRadius: 4, background: checked ? "#e4f3ed" : "#fff", color: "#2f8b72" }}>{checked ? <Check size={11} /> : block.kind === "checklist" ? null : <span style={{ width: 4, height: 4, borderRadius: "50%", background: "#5d776b" }} />}</span>
          <span style={{ textDecoration: checked ? "line-through" : undefined, color: checked ? "#78867f" : undefined }}><InlineSafeText text={itemText} /></span>
        </div>;
      })}</div>;
    }
    if (block.kind === "callout" || block.kind === "error" || block.kind === "tool_summary") {
      const value = objectValue(block.content);
      const label = String(value.title ?? (block.kind === "error" ? "Error" : block.kind === "tool_summary" ? "Tool result" : "Note"));
      const body = String(value.body ?? value.message ?? text);
      return <aside key={key} style={{ margin: "10px 0", padding: "9px 11px", border: `1px solid ${block.kind === "error" ? "#e9b8b1" : "#c9ded5"}`, borderRadius: 6, background: block.kind === "error" ? "#fff7f5" : "#f4faf7", color: block.kind === "error" ? "#8a3b31" : "#486257" }}><strong style={{ display: "block", marginBottom: 3, fontSize: 11 }}>{label}</strong><InlineSafeText text={body} /></aside>;
    }
    if (block.kind === "citation" || block.kind === "artifact") {
      const value = objectValue(block.content);
      const label = String((value.title ?? value.name ?? value.id ?? text) || block.kind);
      const href = String(value.url ?? "");
      return <div key={key} style={{ display: "flex", gap: 7, alignItems: "center", margin: "7px 0", color: "#416052", fontSize: 12 }}>{href ? <a href={href} target="_blank" rel="noreferrer" style={messageStyles.inlineLink}>{label}</a> : <span>{label}</span>}</div>;
    }
    if (block.kind === "chart" || block.kind === "diff") {
      return <pre key={key} style={{ margin: "9px 0", padding: "9px 11px", overflowX: "auto", border: "1px solid #d8e2dd", borderRadius: 6, background: "#f7faf8", fontSize: 11, whiteSpace: "pre-wrap" }}>{typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)}</pre>;
    }
    return <p key={key} style={messageStyles.richParagraph}><InlineSafeText text={text || JSON.stringify(block.content)} /></p>;
  };
  const hasRecruitmentContact = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(content);
  return <div style={messageStyles.richContent} data-answer-schema={ast.schemaVersion}>
    {ast.blocks.map(renderBlock)}
    {hasRecruitmentContact && onAction ? <div style={messageStyles.inlineDeliveryActions}>
      <button type="button" onClick={() => onAction("基于当前结果生成结构化投递草稿，不发送邮件。") } disabled={busy} style={messageStyles.inlineDraftButton}><BriefcaseBusiness size={13} aria-hidden="true" />生成投递草稿</button>
      <button type="button" onClick={() => onAction("基于当前草稿生成预览，展示收件人、主题、正文和附件，不发送邮件。") } disabled={busy} style={messageStyles.inlinePreviewButton}><Mail size={13} aria-hidden="true" />预览邮件</button>
    </div> : null}
  </div>;
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
  if (shouldUseAnswerAst(content)) {
    return <AnswerAstContent content={content} busy={busy} onAction={onAction} />;
  }

  /* Legacy email-aware renderer retained below for compatibility with persisted messages. */
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

function shouldUseAnswerAst(_content: string) {
  return true;
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

function AttachmentPreparationCard({ preview }: { preview: Record<string, unknown> }) {
  const summary = objectValue(preview.attachmentSummary ?? preview.attachmentsSummary);
  const rawAttachments = Array.isArray(summary.attachments)
    ? summary.attachments
    : Array.isArray(preview.attachments)
      ? preview.attachments
      : [];
  const attachments = rawAttachments.map(objectValue);
  const totalBytes = Number(summary.totalBytes ?? preview.attachmentBytes);
  const count = Number(summary.count ?? attachments.length);
  if (!count && !attachments.length) {
    return (
      <div style={messageStyles.attachmentPreparation} data-testid="attachment-preparation">
        <div style={messageStyles.attachmentPreparationHeader}>
          <Paperclip size={14} aria-hidden="true" />
          <strong>附件准备</strong>
          <span style={messageStyles.attachmentPreparationBadge}>无附件</span>
        </div>
        <span style={messageStyles.attachmentPreparationHint}>当前草稿不包含附件。</span>
      </div>
    );
  }
  return (
    <div style={messageStyles.attachmentPreparation} data-testid="attachment-preparation">
      <div style={messageStyles.attachmentPreparationHeader}>
        <Paperclip size={14} aria-hidden="true" />
        <strong>附件准备</strong>
        <span style={messageStyles.attachmentPreparationBadge}>{count} 个{formatBytes(totalBytes) ? ` · ${formatBytes(totalBytes)}` : ""}</span>
      </div>
      <span style={messageStyles.attachmentPreparationHint}>发送前会按投递规则核对文件名、大小和校验；批量冻结时应用最终投递名。</span>
      <div style={messageStyles.attachmentPreparationList}>
        {attachments.slice(0, 8).map((attachment, index) => {
          const currentName = String(attachment.displayName ?? attachment.filename ?? attachment.name ?? `附件 ${index + 1}`);
          const originalName = String(attachment.originalName ?? attachment.sourceName ?? "");
          const finalName = String(attachment.finalDisplayName ?? attachment.filename ?? currentName);
          const hash = String(attachment.sha256 ?? "");
          const nameChanged = originalName && finalName && originalName !== finalName;
          return (
            <div key={String(attachment.attachmentId ?? `${finalName}-${index}`)} style={messageStyles.attachmentPreparationRow}>
              <span style={messageStyles.attachmentPreparationName}>
                {nameChanged ? <><s>{originalName}</s><b>{finalName}</b></> : <b>{finalName || currentName}</b>}
              </span>
              <span style={messageStyles.attachmentPreparationMeta}>
                {[formatBytes(attachment.size), hash ? `SHA-256 ${hash.slice(0, 10)}...` : ""].filter(Boolean).join(" · ") || "待校验"}
              </span>
            </div>
          );
        })}
      </div>
      {attachments.length > 8 ? <span style={messageStyles.attachmentPreparationHint}>另有 {attachments.length - 8} 个附件已收起。</span> : null}
    </div>
  );
}

function BatchDeliveryResult({ result }: { result: unknown }) {
  const value = objectValue(result);
  const preflight = objectValue(value.preflight ?? value);
  const counts = objectValue(preflight.counts ?? value.counts);
  const items = Array.isArray(preflight.items) ? preflight.items.map(objectValue) : [];
  const readyNoteIds = Array.isArray(preflight.readyNoteIds) ? preflight.readyNoteIds : [];
  const ready = Number(counts.ready ?? readyNoteIds.length ?? 0);
  const blocked = items.filter((item) => String(item.status ?? "") !== "ready").length;
  return (
    <div style={messageStyles.batchResult} data-testid="batch-delivery-result">
      <div style={messageStyles.batchResultHeader}>
        <Layers3 size={15} aria-hidden="true" />
        <strong>批量投递准备</strong>
        <span style={messageStyles.attachmentPreparationBadge}>{ready} 项可发送{blocked ? ` · ${blocked} 项待处理` : ""}</span>
      </div>
      <span style={messageStyles.attachmentPreparationHint}>流程：附件准备 → 邮件预览 → 冻结批次 → 审批后发送。</span>
      {items.length ? (
        <div style={messageStyles.batchResultList}>
          {items.slice(0, 6).map((item, index) => {
            const attachments = Array.isArray(item.attachments) ? item.attachments.map(objectValue) : [];
            return (
              <div key={String(item.noteId ?? index)} style={messageStyles.batchResultRow}>
                <span><b>{String(item.roleName ?? item.title ?? item.noteId ?? `岗位 ${index + 1}`)}</b><small>{String(objectValue(item.contact).address ?? "收件人待核对")}</small></span>
                <span><b>{String(objectValue(item.preview).subject ?? "主题待生成")}</b><small>{attachments.length ? `${attachments.length} 个附件` : "无附件"}</small></span>
                <span style={messageStyles.batchResultStatus}>{String(item.status ?? "待处理")}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

type InteractiveTableRow = {
  key: string;
  value: Record<string, unknown>;
};

const TABLE_PAGE_SIZE = 8;

const TABLE_COLUMN_LABELS: Record<string, string> = {
  noteId: "记录 ID",
  id: "记录 ID",
  title: "岗位 / 标题",
  jobTitle: "岗位",
  company: "公司",
  delivery: "投递信息",
  outreach: "联系信息",
  recipientEmails: "招聘邮箱",
  recipientEmail: "招聘邮箱",
  email: "邮箱",
  subjectFormat: "邮件标题格式",
  attachmentNamingRule: "附件命名要求",
  extractionStatus: "提取状态",
  missing: "缺失项",
};

function tableCellText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map(tableCellText).filter(Boolean).join("、");
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function tableEmails(value: unknown): string[] {
  const matches = tableCellText(value).match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
  );
  return [...new Set((matches ?? []).map((email) => email.toLowerCase()))];
}

function TableCellContent({ column, value }: { column: string; value: unknown }) {
  const text = tableCellText(value);
  const emails = tableEmails(value);
  const record = objectValue(value);
  const deliveryState = String(record.action ?? record.status ?? "");
  const deliveryStateLabel =
    {
      draft_saved: "草稿已保存",
      drafted: "草稿已生成",
      prepared: "已准备",
      preview_ready: "可预览",
      sent: "已发送",
      failed: "处理失败",
    }[deliveryState] ?? deliveryState;
  if (emails.length) {
    return (
      <span style={messageStyles.tableEmailList}>
        {emails.map((email) => (
          <a key={email} href={`mailto:${email}`} style={messageStyles.emailLink}>
            <Mail size={11} aria-hidden="true" />
            {email}
          </a>
        ))}
        {deliveryStateLabel ? (
          <span style={messageStyles.tableStatusCell}>{deliveryStateLabel}</span>
        ) : null}
      </span>
    );
  }
  if (column === "delivery" && deliveryStateLabel) {
    return <span style={messageStyles.tableStatusCell}>{deliveryStateLabel}</span>;
  }
  if (!text) {
    const canExtract = [
      "delivery",
      "outreach",
      "recipientEmails",
      "recipientEmail",
      "email",
    ].includes(column);
    return (
      <span style={canExtract ? messageStyles.tablePendingCell : messageStyles.tableEmptyCell}>
        {canExtract ? "待提取" : "-"}
      </span>
    );
  }
  return <InlineSafeText text={text.slice(0, 240)} />;
}

function csvCell(value: unknown) {
  return `"${tableCellText(value).replaceAll('"', '""')}"`;
}

function InteractiveResultTable({
  value,
  busy = false,
  onAction,
  jobId,
}: {
  value: Record<string, unknown>;
  busy?: boolean;
  onAction?: (prompt: string) => void;
  jobId?: string;
}) {
  const rows = useMemo<InteractiveTableRow[]>(
    () =>
      (Array.isArray(value.rows) ? value.rows : [])
        .filter((row) => row && typeof row === "object" && !Array.isArray(row))
        .map((row, index) => {
          const record = row as Record<string, unknown>;
          const identity = String(record.noteId ?? record.id ?? "row");
          return { key: `${identity}-${index}`, value: record };
        }),
    [value.rows],
  );
  const columns = useMemo(() => {
    const discovered = [...new Set(rows.flatMap((row) => Object.keys(row.value)))];
    const priority = [
      "noteId",
      "id",
      "title",
      "jobTitle",
      "company",
      "recipientEmails",
      "recipientEmail",
      "email",
      "subjectFormat",
      "attachmentNamingRule",
      "delivery",
      "outreach",
      "extractionStatus",
    ];
    return [
      ...priority.filter((column) => discovered.includes(column)),
      ...discovered.filter((column) => !priority.includes(column)),
    ].slice(0, 12);
  }, [rows]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{
    column: string;
    direction: "asc" | "desc";
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1);
  const [feedback, setFeedback] = useState("");

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const matched = needle
      ? rows.filter((row) =>
          columns.some((column) =>
            tableCellText(row.value[column])
              .toLocaleLowerCase("zh-CN")
              .includes(needle),
          ),
        )
      : rows;
    if (!sort) return matched;
    return [...matched].sort((left, right) => {
      const a = tableCellText(left.value[sort.column]);
      const b = tableCellText(right.value[sort.column]);
      const compared = a.localeCompare(b, "zh-CN", {
        numeric: true,
        sensitivity: "base",
      });
      return sort.direction === "asc" ? compared : -compared;
    });
  }, [columns, query, rows, sort]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / TABLE_PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount);
  const visibleRows = filteredRows.slice(
    (visiblePage - 1) * TABLE_PAGE_SIZE,
    visiblePage * TABLE_PAGE_SIZE,
  );
  const selectedRows = rows.filter((row) => selected.has(row.key));
  const currentRows = selectedRows.length ? selectedRows : filteredRows;
  const detectedEmails = [...new Set(rows.flatMap((row) => tableEmails(row.value)))];
  const allVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.key));
  const coverage = objectValue(value.coverage);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const toggleSort = (column: string) => {
    setSort((current) =>
      current?.column === column
        ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  };

  const toggleRow = (rowKey: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of visibleRows) {
        if (allVisibleSelected) next.delete(row.key);
        else next.add(row.key);
      }
      return next;
    });
  };

  const copyRows = async () => {
    if (!currentRows.length) return;
    const text = [
      columns.map((column) => TABLE_COLUMN_LABELS[column] ?? column).join("\t"),
      ...currentRows.map((row) =>
        columns.map((column) => tableCellText(row.value[column])).join("\t"),
      ),
    ].join("\n");
    await navigator.clipboard.writeText(text);
    setFeedback(`已复制 ${currentRows.length} 行`);
  };

  const exportRows = () => {
    if (!currentRows.length) return;
    const csv = [
      columns.map((column) => csvCell(TABLE_COLUMN_LABELS[column] ?? column)).join(","),
      ...currentRows.map((row) =>
        columns.map((column) => csvCell(row.value[column])).join(","),
      ),
    ].join("\r\n");
    const href = URL.createObjectURL(
      new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `data-copilot-table-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(href);
    setFeedback(`已导出 ${currentRows.length} 行`);
  };

  const extractEmailRequirements = () => {
    if (!onAction) return;
    const noteIds = selectedRows
      .map((row) => String(row.value.noteId ?? row.value.id ?? ""))
      .filter(Boolean);
    const target = noteIds.length
      ? `仅处理这些记录：${noteIds.join("、")}`
      : "处理当前任务中的全部岗位记录";
    onAction(
      `调用 applications.extract_email_requirements，${target}，批量提取招聘邮箱、邮件标题格式和附件命名要求。必须分页直到完整覆盖，报告总数、已扫描数、邮箱命中数和缺失数，每个岗位一行，不要只返回第一条。${jobId ? `任务 ID：${jobId}。` : ""}`,
    );
  };

  return (
    <div style={messageStyles.tableResult} data-testid="interactive-result-table">
      <div style={messageStyles.resultSummaryRow}>
        <span style={messageStyles.resultSummary}>
          共 {Number(value.total ?? rows.length).toLocaleString("zh-CN")} 条
          {rows.length !== Number(value.total ?? rows.length)
            ? ` · 已载入 ${rows.length.toLocaleString("zh-CN")} 条`
            : ""}
          {value.truncated ? " · 结果可继续加载" : ""}
        </span>
        {coverage.scannedRecords !== undefined ? (
          <span style={messageStyles.resultCoverage}>
            已扫描 {Number(coverage.scannedRecords).toLocaleString("zh-CN")} · 邮箱命中{" "}
            {Number(coverage.withRecipient ?? 0).toLocaleString("zh-CN")}
          </span>
        ) : detectedEmails.length ? (
          <span style={messageStyles.resultCoverage}>
            已识别 {detectedEmails.length} 个邮箱
          </span>
        ) : null}
      </div>
      {rows.length ? (
        <>
          <div style={messageStyles.tableToolbar}>
            <label style={messageStyles.tableSearch}>
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="搜索表格结果"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索当前结果"
                style={messageStyles.tableSearchInput}
              />
            </label>
            <div style={messageStyles.tableActions}>
              <button
                type="button"
                style={{
                  ...messageStyles.tableActionButton,
                  ...messageStyles.tablePrimaryAction,
                  opacity: busy || !onAction ? 0.55 : 1,
                }}
                disabled={busy || !onAction}
                onClick={extractEmailRequirements}
                aria-label="提取邮箱"
                title={
                  selectedRows.length
                    ? "提取所选岗位的邮箱要求"
                    : "提取全部岗位的邮箱要求"
                }
              >
                <Mail size={13} aria-hidden="true" />
                提取邮箱{selectedRows.length ? ` (${selectedRows.length})` : ""}
              </button>
              <button
                type="button"
                style={messageStyles.tableActionButton}
                disabled={!currentRows.length}
                onClick={() => void copyRows()}
                aria-label="复制表格"
                title="复制所选行；未选择时复制当前筛选结果"
              >
                <Clipboard size={13} aria-hidden="true" />
                复制
              </button>
              <button
                type="button"
                style={messageStyles.tableActionButton}
                disabled={!currentRows.length}
                onClick={exportRows}
                aria-label="导出 CSV"
                title="导出所选行；未选择时导出当前筛选结果"
              >
                <Download size={13} aria-hidden="true" />
                CSV
              </button>
            </div>
          </div>
          <div style={messageStyles.tableSelectionSummary} aria-live="polite">
            <span>
              {query ? `筛选到 ${filteredRows.length} 条` : `当前 ${rows.length} 条`}
              {selectedRows.length ? ` · 已选择 ${selectedRows.length} 条` : ""}
            </span>
            <span>{feedback}</span>
          </div>
          <div style={messageStyles.tableScroll}>
            <table style={messageStyles.table}>
              <thead>
                <tr>
                  <th style={messageStyles.tableSelectCell}>
                    <input
                      type="checkbox"
                      aria-label="选择当前页"
                      checked={allVisibleSelected}
                      onChange={toggleVisible}
                    />
                  </th>
                  {columns.map((column) => (
                    <th key={column} style={messageStyles.tableHeadCell}>
                      <button
                        type="button"
                        style={messageStyles.tableSortButton}
                        onClick={() => toggleSort(column)}
                        aria-label={`按${TABLE_COLUMN_LABELS[column] ?? column}排序`}
                      >
                        {TABLE_COLUMN_LABELS[column] ?? column}
                        <ArrowUpDown size={11} aria-hidden="true" />
                        {sort?.column === column ? (
                          <span style={messageStyles.tableSortDirection}>
                            {sort.direction === "asc" ? "升序" : "降序"}
                          </span>
                        ) : null}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr
                    key={row.key}
                    style={
                      selected.has(row.key) ? messageStyles.tableRowSelected : undefined
                    }
                  >
                    <td style={messageStyles.tableSelectCell}>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${tableCellText(row.value.title ?? row.value.noteId ?? row.key)}`}
                        checked={selected.has(row.key)}
                        onChange={() => toggleRow(row.key)}
                      />
                    </td>
                    {columns.map((column) => {
                      const text = tableCellText(row.value[column]);
                      return (
                        <td key={column} title={text} style={messageStyles.tableCell}>
                          <TableCellContent column={column} value={row.value[column]} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={messageStyles.tablePagination}>
            <span>
              第 {visiblePage} / {pageCount} 页
            </span>
            <div style={messageStyles.tablePaginationActions}>
              <button
                type="button"
                style={messageStyles.tableIconButton}
                disabled={visiblePage <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                aria-label="上一页"
                title="上一页"
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                style={messageStyles.tableIconButton}
                disabled={visiblePage >= pageCount}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                aria-label="下一页"
                title="下一页"
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      ) : (
        <div style={messageStyles.resultEmpty}>没有匹配记录</div>
      )}
    </div>
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
    return (
      <InteractiveResultTable
        value={value}
        busy={busy}
        onAction={onAction}
        jobId={jobId}
      />
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
  if (value.type === "application.batch_preflight" || value.type === "application.batch") {
    return <BatchDeliveryResult result={value} />;
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
        <AttachmentPreparationCard preview={preview} />
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
    "application.batch_preflight",
    "application.batch",
  ].includes(semanticType);
  const [expanded, setExpanded] = useState(
    toolCall.status === "running" ||
      toolCall.status === "failed" ||
      ["email.draft", "email.sent", "application.email_draft"].includes(
        semanticType,
      ) || ["table.result", "artifact.ready", "application.batch_preflight", "application.batch"].includes(semanticType),
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
    isRichToolCall(toolCall)
  ) {
    return <>{semanticResult}</>;
  }

  return (
    <section
      className="data-copilot-tool-card"
      data-status={toolCall.status}
      style={{
        ...messageStyles.toolCard,
        ...(toolCall.status === "failed"
          ? messageStyles.toolCardFailed
          : undefined),
      }}
      aria-label={`工具调用 ${toolCall.name}`}
    >
      <button
        className="data-copilot-tool-card-header"
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
        <div className="data-copilot-tool-card-details" style={messageStyles.toolDetails}>
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

function ToolCallSummary({
  toolCalls,
  sessionId,
  busy = false,
  onAction,
  jobId,
}: {
  toolCalls: DataCopilotToolCall[];
  sessionId: string;
  busy?: boolean;
  onAction?: (prompt: string) => void;
  jobId?: string;
}) {
  const hasActive = toolCalls.some((tool) => tool.status === "running" || tool.status === "pending");
  const hasFailure = toolCalls.some((tool) => tool.status === "failed");
  const [expanded, setExpanded] = useState(hasActive || hasFailure);
  const completed = toolCalls.filter((tool) => tool.status === "complete").length;
  const label = toolCalls.slice(0, 4).map((tool) => toolDisplayName(tool.name)).join("、");
  return (
    <section className="data-copilot-tool-summary" style={messageStyles.toolSummary} aria-label="执行步骤">
      <button
        className="data-copilot-tool-summary-button"
        type="button"
        style={messageStyles.toolSummaryButton}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span style={messageStyles.toolSummaryIdentity}>
          {hasActive ? <LoaderCircle size={14} style={messageStyles.spinningIcon} aria-hidden="true" /> : hasFailure ? <AlertCircle size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          <strong>{hasActive ? "正在处理" : hasFailure ? "部分步骤需要处理" : `已完成 ${completed || toolCalls.length} 个步骤`}</strong>
          <span style={messageStyles.toolSummaryCount}>{toolCalls.length}</span>
        </span>
        <span style={messageStyles.toolSummaryMeta}>{label}{toolCalls.length > 4 ? " 等" : ""}{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</span>
      </button>
      {expanded ? (
        <div className="data-copilot-tool-summary-details" style={messageStyles.toolSummaryDetails}>
          {toolCalls.map((toolCall) => (
            <ToolCallCard key={toolCall.id} toolCall={toolCall} sessionId={sessionId} busy={busy} onAction={onAction} jobId={jobId} />
          ))}
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
    <section
      className="data-copilot-approval-card"
      data-status={approval.status}
      aria-label="操作确认"
      aria-live={pending ? 'assertive' : 'polite'}
    >
      <div className="data-copilot-approval-header">
        <span className="data-copilot-approval-identity">
          <ShieldCheck size={15} aria-hidden="true" />
          <strong>执行确认</strong>
        </span>
        <span className="data-copilot-approval-status">{statusLabel}</span>
      </div>
      <div className="data-copilot-approval-summary">{approval.summary}</div>
      {approval.toolName ? (
        <div className="data-copilot-approval-meta">执行工具：<code>{approval.toolName}</code></div>
      ) : null}
      {detail ? (
        <>
          <button
            className="data-copilot-approval-detail-button"
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} aria-hidden="true" />
            )}
            {expanded ? "收起执行参数" : "核对执行参数"}
          </button>
          {expanded ? (
            <pre className="data-copilot-approval-code">{detail}</pre>
          ) : null}
        </>
      ) : null}
      {pending && onApproval ? (
        <div className="data-copilot-approval-actions">
          <button
            className="data-copilot-approval-reject"
            type="button"
            onClick={() => onApproval(message, false)}
            disabled={busy}
          >
            <CircleStop size={14} aria-hidden="true" />
            取消操作
          </button>
          <button
            className="data-copilot-approval-confirm"
            type="button"
            onClick={() => onApproval(message, true)}
            disabled={busy}
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
      <div className="data-copilot-message-compact" style={messageStyles.compactRow} role="status">
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
      className="data-copilot-message-row"
      data-role={message.role}
      data-tone={isError ? 'error' : 'default'}
      data-status={message.status}
      style={{
        ...messageStyles.row,
        ...(isUser ? messageStyles.userRow : undefined),
      }}
      aria-label={
        isUser ? "你的消息" : isError ? "错误消息" : "Data Copilot 消息"
      }
    >
      <div
        className="data-copilot-message-avatar"
        style={{
          ...messageStyles.avatar,
          ...(isUser ? messageStyles.userAvatar : undefined),
          ...(isError ? messageStyles.errorAvatar : undefined),
        }}
      >
        <MessageIdentity message={message} />
      </div>

      <div className="data-copilot-message-body" style={messageStyles.body}>
        <header className="data-copilot-message-header" style={messageStyles.messageHeader}>
          <span className="data-copilot-message-author" style={messageStyles.author}>
            {isUser ? "你" : message.role === "tool" ? "工具" : "Data Copilot"}
          </span>
          <time className="data-copilot-message-time" style={messageStyles.timestamp} dateTime={message.createdAt}>
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
          <section className="data-copilot-analysis-block" style={messageStyles.analysisBlock}>
            <button
              className="data-copilot-analysis-toggle"
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
              <div className="data-copilot-analysis-text" style={messageStyles.analysisText}>{message.content}</div>
            ) : null}
          </section>
        ) : message.content ? (
          <div
            className="data-copilot-message-content"
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
          <div className="data-copilot-tool-stack" style={messageStyles.toolStack}>
            {message.toolCalls.filter((toolCall) => isRichToolCall(toolCall)).map((toolCall) => (
              <ToolCallCard key={toolCall.id} toolCall={toolCall} sessionId={message.sessionId} busy={busy} onAction={onAction} jobId={jobId} />
            ))}
            {message.toolCalls.filter((toolCall) => !isRichToolCall(toolCall)).length ? (
              <ToolCallSummary
                toolCalls={message.toolCalls.filter((toolCall) => !isRichToolCall(toolCall))}
                sessionId={message.sessionId}
                busy={busy}
                onAction={onAction}
                jobId={jobId}
              />
            ) : null}
          </div>
        ) : null}

        {message.attachments?.length ? (
          <div className="data-copilot-message-attachments" style={messageStyles.attachmentList} aria-label="消息附件">
            {message.attachments.map((attachment) => (
              <button
                className="data-copilot-message-attachment"
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
          <div className="data-copilot-message-citations" style={messageStyles.citationList} aria-label="数据引用">
            {message.citations.map((citation, index) => (
              <div key={citation.id} style={messageStyles.citationItem}>
                <button
                  className="data-copilot-message-citation"
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

        <footer className="data-copilot-message-actions" style={messageStyles.actions}>
          {message.content ? (
            <button
              className="data-copilot-message-icon-action"
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
              className="data-copilot-message-text-action"
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
  toolSummary: {
    overflow: "hidden",
    border: "1px solid #d8ded9",
    borderRadius: 5,
    background: "#f4f8f5",
  },
  toolSummaryButton: {
    display: "flex",
    width: "100%",
    minHeight: 38,
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "0 10px",
    border: 0,
    background: "transparent",
    color: "#3f4c45",
    cursor: "pointer",
  },
  toolSummaryIdentity: { display: "flex", alignItems: "center", gap: 7, minWidth: 0 },
  toolSummaryCount: {
    display: "inline-grid",
    minWidth: 18,
    height: 18,
    placeItems: "center",
    borderRadius: 9,
    background: "#dbece4",
    color: "#16634f",
    fontSize: 10,
    fontWeight: 700,
  },
  toolSummaryMeta: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: 5,
    overflow: "hidden",
    color: "#78817c",
    fontSize: 10,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  toolSummaryDetails: { display: "grid", gap: 6, padding: "0 7px 7px" },
  attachmentPreparation: {
    display: "grid",
    gap: 6,
    marginTop: 9,
    padding: "9px 10px",
    border: "1px solid #d9e6df",
    borderRadius: 5,
    background: "#f7fbf8",
  },
  attachmentPreparationHeader: { display: "flex", alignItems: "center", gap: 6, color: "#245e4d", fontSize: 11 },
  attachmentPreparationBadge: { marginLeft: "auto", color: "#63736b", fontSize: 10, fontWeight: 600 },
  attachmentPreparationHint: { color: "#6f7d75", fontSize: 10, lineHeight: 1.45 },
  attachmentPreparationList: { display: "grid", gap: 4 },
  attachmentPreparationRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: 8,
    alignItems: "center",
    padding: "5px 0",
    borderTop: "1px solid #e5eee9",
  },
  attachmentPreparationName: { display: "grid", minWidth: 0, gap: 1, color: "#33433a", fontSize: 10 },
  attachmentPreparationMeta: { color: "#7a877f", fontSize: 9, whiteSpace: "nowrap" },
  batchResult: {
    display: "grid",
    gap: 7,
    padding: "9px 10px",
    border: "1px solid #d9e6df",
    borderRadius: 5,
    background: "#f7fbf8",
  },
  batchResultHeader: { display: "flex", alignItems: "center", gap: 6, color: "#245e4d", fontSize: 11 },
  batchResultList: { display: "grid", gap: 4 },
  batchResultRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1.4fr) auto",
    gap: 8,
    alignItems: "center",
    padding: "5px 0",
    borderTop: "1px solid #e5eee9",
    fontSize: 10,
  },
  "batchResultRow span": { display: "grid", minWidth: 0, gap: 2 },
  "batchResultRow small": { color: "#7a877f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  batchResultStatus: { color: "#2c755b", fontWeight: 650, whiteSpace: "nowrap" },
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
  tableResult: { display: "grid", gap: 8, minWidth: 0 },
  resultSummaryRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  resultSummary: { color: "#53615a", fontSize: 10 },
  resultCoverage: {
    color: "#17644f",
    fontSize: 10,
    fontWeight: 650,
  },
  resultEmpty: { padding: "12px 0", color: "#7b837f", fontSize: 11 },
  tableToolbar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 7,
  },
  tableSearch: {
    display: "flex",
    minWidth: 190,
    minHeight: 31,
    flex: "1 1 220px",
    alignItems: "center",
    gap: 6,
    padding: "0 9px",
    border: "1px solid #d5ddd8",
    borderRadius: 5,
    background: "#fff",
    color: "#66736c",
  },
  tableSearchInput: {
    width: "100%",
    minWidth: 0,
    border: 0,
    outline: 0,
    background: "transparent",
    color: "#2f3933",
    font: "inherit",
    fontSize: 11,
  },
  tableActions: {
    display: "flex",
    flex: "0 0 auto",
    alignItems: "center",
    gap: 5,
  },
  tableActionButton: {
    display: "inline-flex",
    minHeight: 31,
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    padding: "0 9px",
    border: "1px solid #d4dcd7",
    borderRadius: 5,
    background: "#fff",
    color: "#44524b",
    fontSize: 10,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  tablePrimaryAction: {
    borderColor: "#0b735c",
    background: "#0b7a62",
    color: "#fff",
  },
  tableSelectionSummary: {
    display: "flex",
    minHeight: 15,
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    color: "#748079",
    fontSize: 9,
  },
  tableScroll: {
    maxWidth: "100%",
    maxHeight: 420,
    overflow: "auto",
    border: "1px solid #dde3df",
    borderRadius: 5,
    background: "#fff",
  },
  table: {
    width: "100%",
    minWidth: 660,
    borderCollapse: "collapse",
    color: "#323a35",
    fontSize: 10,
  },
  tableHeadCell: {
    position: "sticky",
    top: 0,
    zIndex: 1,
    padding: 0,
    borderBottom: "1px solid #dce1dd",
    background: "#f3f6f4",
    textAlign: "left",
    whiteSpace: "nowrap",
  },
  tableSortButton: {
    display: "flex",
    width: "100%",
    minHeight: 34,
    alignItems: "center",
    gap: 5,
    padding: "0 8px",
    border: 0,
    background: "transparent",
    color: "#536059",
    fontSize: 10,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  tableSortDirection: {
    color: "#0b735c",
    fontSize: 8,
    fontWeight: 600,
  },
  tableSelectCell: {
    position: "sticky",
    left: 0,
    zIndex: 2,
    width: 34,
    minWidth: 34,
    padding: "0 8px",
    borderBottom: "1px solid #e7eae7",
    background: "inherit",
    textAlign: "center",
  },
  tableCell: {
    maxWidth: 280,
    padding: "8px",
    borderBottom: "1px solid #e7eae7",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tableEmptyCell: { color: "#a0a9a4" },
  tablePendingCell: { color: "#88713a", fontSize: 9, fontWeight: 600 },
  tableEmailList: {
    display: "inline-flex",
    maxWidth: "100%",
    alignItems: "center",
    gap: 5,
  },
  tableStatusCell: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: 20,
    padding: "0 6px",
    borderRadius: 4,
    background: "#e8f3ed",
    color: "#23654f",
    fontSize: 9,
    fontWeight: 650,
  },
  tableRowSelected: { background: "#edf8f3" },
  tablePagination: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    color: "#6d7872",
    fontSize: 9,
  },
  tablePaginationActions: { display: "flex", alignItems: "center", gap: 4 },
  tableIconButton: {
    display: "inline-grid",
    width: 27,
    height: 27,
    placeItems: "center",
    padding: 0,
    border: "1px solid #d5dcd8",
    borderRadius: 5,
    background: "#fff",
    color: "#4f5c55",
    cursor: "pointer",
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
