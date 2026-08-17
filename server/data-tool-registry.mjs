import path from "node:path";
import { readFile } from "node:fs/promises";
import { materializeAudienceResults } from "./lib/audience-results.mjs";
import { readExpansionSnapshot } from "./lib/expansion-results.mjs";
import { searchToolCatalog } from "./copilot-capability-resolver.mjs";
import { filterRowsByContextSelection } from "./copilot-context-source.mjs";
import {
  applicationContactEmails,
  normalizeApplicationRoleTitle,
  applicationSubjectGuard,
  applicationSubjectRule,
  buildApplicationEmailDraft,
  resolveApplicationEmailSubject,
  validateApplicationEmailSubject,
} from "./lib/application-email-draft.mjs";
import { detectApplicationAttachmentRule } from "./lib/application-attachment-rule.mjs";

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
const MAX_TOOL_ROWS = 200;

export class DataToolError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "DataToolError";
    this.code = code;
    this.status = status;
  }
}

export class DataToolRegistry {
  constructor({
    manager,
    policy,
    artifactService = null,
    mailSender = null,
  } = {}) {
    this.manager = manager;
    this.policy = policy;
    this.artifactService = artifactService;
    this.mailSender = mailSender;
    this.tools = new Map();
    this.#registerBuiltins();
  }

  register(definition) {
    if (!definition?.name || typeof definition.handler !== "function") {
      throw new TypeError("A tool name and handler are required.");
    }
    const name = String(definition.name).trim();
    const category = String(definition.category || name.split(".")[0] || "general");
    this.tools.set(
      name,
      Object.freeze({
        version: "1.0.0",
        category,
        tags: [category, ...name.split(".")],
        risk: "read",
        scopes: [],
        idempotent: true,
        parallelSafe: true,
        inputSchema: objectSchema(),
        ...definition,
        name,
        category,
      }),
    );
    return this;
  }

  list({ names = null } = {}) {
    const selected = names ? new Set(arrayOfStrings(names)) : null;
    return [...this.tools.values()]
      .filter((definition) => !selected || selected.has(definition.name))
      .map(({ handler, ...definition }) => structuredClone(definition));
  }

  search(query = "", { limit = 20 } = {}) {
    return searchToolCatalog(this.list(), query, { limit }).map(toolSummary);
  }

  describe(names = []) {
    const selected = new Set(arrayOfStrings(names));
    return this.list().filter((definition) => selected.has(definition.name)).slice(0, 20);
  }

  get(name) {
    return this.tools.get(String(name || "")) || null;
  }

  async execute(name, input = {}, context = {}) {
    const tool = this.get(name);
    if (!tool)
      throw toolError(
        "COPILOT_TOOL_UNKNOWN",
        `Unknown data tool: ${name}.`,
        404,
      );
    const authorization = this.policy.authorizeTool(
      context.reference,
      tool.name,
      context.conversation,
      tool.scopes,
    );
    if (context.signal?.aborted) throw cancelled();
    const runtimeContext = {
      ...context,
      toolName: tool.name,
      job: authorization.job,
      outputDir: authorization.job.outputDir,
      state: context.state || {},
    };
    const result = await tool.handler(normalizeObject(input), runtimeContext);
    if (context.signal?.aborted) throw cancelled();
    return jsonValue(result);
  }

  #registerBuiltins() {
    this.register({
      name: "tool.search",
      description:
        "Search the complete Copilot capability catalog and activate relevant tools for the next model round.",
      scopes: ["dataset:read"],
      inputSchema: objectSchema({
        query: stringSchema("Capability or action to find."),
        limit: integerSchema(1, 20),
      }, ["query"]),
      handler: async (input, context) => {
        const tools = this.search(input.query, { limit: bounded(input.limit, 10, 1, 20) });
        context.state.activeToolNames = [...new Set([
          ...(context.state.activeToolNames || []),
          ...tools.map((tool) => tool.name),
        ])].slice(0, 40);
        return { type: "tool.catalog", query: input.query, tools, total: this.tools.size };
      },
    });
    this.register({
      name: "tool.describe",
      description:
        "Describe exact schemas, scopes, risk, and execution properties for selected Copilot tools.",
      scopes: ["dataset:read"],
      inputSchema: objectSchema({ names: arraySchema(stringSchema()) }, ["names"]),
      handler: async (input, context) => {
        const tools = this.describe(input.names);
        context.state.activeToolNames = [...new Set([
          ...(context.state.activeToolNames || []),
          ...tools.map((tool) => tool.name),
        ])].slice(0, 40);
        return { type: "tool.catalog", tools };
      },
    });
    this.register({
      name: "task.status",
      description:
        "Read the bound logical task status, revision, attempts, stages, and workflow summary without changing it.",
      scopes: ["dataset:read"],
      inputSchema: objectSchema(),
      handler: async (_input, context) => ({
        type: "task.status",
        task: taskStatus(context.job),
        source: this.policy.resourceUri(context.reference, "content"),
      }),
    });
    this.register({
      name: "task.workflow",
      description:
        "Inspect discovery, body completion, analysis, audience, expansion, and artifact workflow state for the bound task.",
      scopes: ["dataset:read"],
      inputSchema: objectSchema(),
      handler: async (_input, context) => ({
        type: "task.workflow",
        stages: context.job?.stages || {},
        workflowSummary: context.job?.workflowSummary || {},
        currentAttemptId: context.job?.currentAttemptId || null,
        attempts: Array.isArray(context.job?.attempts) ? context.job.attempts : [],
        source: this.policy.resourceUri(context.reference, "content"),
      }),
    });
    this.register({
      name: "dataset.list",
      description:
        "List the task datasets available in the bound immutable task snapshot.",
      scopes: ["dataset:read"],
      inputSchema: objectSchema(),
      handler: async (_input, context) => this.#listDatasets(context),
    });
    this.register({
      name: "dataset.describe",
      description:
        "Describe a dataset, its fields, row count, source, and representative values.",
      scopes: ["dataset:read"],
      inputSchema: objectSchema(
        { dataset: stringSchema("Dataset identifier.") },
        ["dataset"],
      ),
      handler: async ({ dataset }, context) => {
        const loaded = await this.#dataset(dataset, context);
        return {
          dataset: loaded.name,
          count: loaded.rows.length,
          fields: describeFields(loaded.rows),
          source: loaded.source,
        };
      },
    });

    for (const operation of [
      "search",
      "query",
      "filter",
      "sort",
      "aggregate",
      "group",
      "join",
      "get",
    ]) {
      this.register({
        name: `records.${operation}`,
        description: recordDescription(operation),
        scopes: ["dataset:read"],
        inputSchema: recordSchema(operation),
        handler: (input, context) => this.#records(operation, input, context),
      });
    }

    this.register({
      name: "content.inspect",
      description:
        "Inspect full post text, normalized publish time, image metadata, and existing AI analysis.",
      scopes: ["content:read"],
      inputSchema: objectSchema({
        noteId: stringSchema(),
        dataset: stringSchema(),
        includeImages: booleanSchema(),
      }),
      handler: async (input, context) => {
        const loaded = await this.#dataset(input.dataset || "content", context);
        const row = findRecord(loaded.rows, input.noteId || input.id);
        if (!row)
          throw toolError(
            "COPILOT_RECORD_NOT_FOUND",
            "The requested post was not found.",
            404,
          );
        return {
          record: row,
          images: input.includeImages === false ? [] : imageValues(row),
          source: loaded.source,
        };
      },
    });
    this.register({
      name: "content.image_understanding",
      description:
        "Return persisted image captions, OCR, vision analysis, and source image URLs for selected posts.",
      scopes: ["content:read"],
      inputSchema: objectSchema({
        noteIds: arraySchema(stringSchema()),
        dataset: stringSchema(),
      }),
      handler: async (input, context) => {
        const loaded = await this.#dataset(input.dataset || "content", context);
        const ids = new Set(arrayOfStrings(input.noteIds));
        const selected = ids.size
          ? loaded.rows.filter((row) => ids.has(recordId(row)))
          : loaded.rows.slice(0, 20);
        return tableResult(
          selected.map((row) => ({
            noteId: recordId(row),
            title: row.title || "",
            images: imageValues(row),
          })),
          loaded.source,
        );
      },
    });
    this.register({
      name: "jobs.extract_links",
      description:
        "Extract canonical source links and identifiers from job records.",
      scopes: ["applications:read"],
      inputSchema: objectSchema({
        query: stringSchema(),
        limit: integerSchema(1, 500),
      }),
      handler: async (input, context) => {
        const loaded = await this.#dataset("applications", context);
        let rows = loaded.rows;
        if (input.query) rows = searchRows(rows, input.query);
        return tableResult(
          rows.slice(0, bounded(input.limit, 100, 1, 500)).map((row) => ({
            noteId: recordId(row),
            title: row.title || "",
            url: firstString(
              row.note_url,
              row.source_url,
              row.job_card?.source_url,
            ),
          })),
          loaded.source,
        );
      },
    });
    this.register({
      name: "jobs.compare",
      description: "Compare selected job records across stable fields.",
      scopes: ["applications:read"],
      inputSchema: objectSchema(
        {
          noteIds: arraySchema(stringSchema()),
          fields: arraySchema(stringSchema()),
        },
        ["noteIds"],
      ),
      handler: async (input, context) => {
        const loaded = await this.#dataset("applications", context);
        const wanted = new Set(arrayOfStrings(input.noteIds));
        const fields = arrayOfStrings(input.fields);
        const rows = loaded.rows
          .filter((row) => wanted.has(recordId(row)))
          .map((row) =>
            fields.length
              ? Object.fromEntries(
                  ["noteId", ...fields].map((field) => [
                    field,
                    field === "noteId" ? recordId(row) : fieldValue(row, field),
                  ]),
                )
              : row,
          );
        return tableResult(rows, loaded.source);
      },
    });
    this.register({
      name: "applications.get_delivery",
      description:
        "Read delivery, draft, quality-check, and email state for application records.",
      scopes: ["applications:read"],
      inputSchema: objectSchema({ noteIds: arraySchema(stringSchema()) }),
      handler: async (input, context) => {
        const loaded = await this.#dataset("applications", context);
        const ids = new Set(arrayOfStrings(input.noteIds));
        const rows = (
          ids.size
            ? loaded.rows.filter((row) => ids.has(recordId(row)))
            : loaded.rows
        ).map((row) => ({
          noteId: recordId(row),
          title: row.title || "",
          delivery: row.delivery || null,
          outreach: row.outreach || null,
        }));
        return tableResult(rows, loaded.source);
      },
    });
    this.register({
      name: "applications.extract_email_requirements",
      description:
        "Extract recruitment recipients, email subject formats, and attachment naming rules for every matched application record. Use this for all, batch, multiple, or per-job email-format requests; it returns explicit coverage and pagination metadata instead of stopping after one record.",
      tags: [
        "applications",
        "email",
        "batch",
        "all",
        "requirements",
        "subject format",
        "邮件格式",
        "邮件标题",
        "全部岗位",
        "批量提取",
      ],
      scopes: ["applications:read"],
      inputSchema: objectSchema({
        noteIds: arraySchema(stringSchema()),
        query: stringSchema(),
        offset: integerSchema(0, 1_000_000),
        limit: integerSchema(1, MAX_TOOL_ROWS),
      }),
      handler: async (input, context) => {
        const loaded = await this.#dataset("applications", context);
        const noteIds = new Set(arrayOfStrings(input.noteIds));
        let matched = noteIds.size
          ? loaded.rows.filter((row) => noteIds.has(recordId(row)))
          : loaded.rows;
        if (input.query) matched = searchRows(matched, input.query);
        const total = matched.length;
        const offset = bounded(input.offset, 0, 0, 1_000_000);
        const limit = bounded(input.limit, MAX_TOOL_ROWS, 1, MAX_TOOL_ROWS);
        const extracted = matched.map(applicationEmailRequirement);
        const rows = extracted.slice(offset, offset + limit);
        const nextOffset = offset + rows.length;
        const complete = nextOffset >= total;
        const matchedIds = new Set(matched.map(recordId));
        return tableResult(rows, loaded.source, total, {
          offset,
          limit,
          truncated: !complete,
          coverage: {
            requestedRecords: noteIds.size || null,
            matchedRecords: total,
            scannedRecords: total,
            returnedRecords: rows.length,
            withRecipient: extracted.filter((row) => row.recipientEmails.length > 0).length,
            withSubjectRule: extracted.filter((row) => row.subjectRuleDetected).length,
            withAttachmentRule: extracted.filter((row) => row.attachmentRuleDetected).length,
            missingAnyEmailRequirement: extracted.filter((row) => row.extractionStatus === "not_found").length,
            unmatchedNoteIds: noteIds.size
              ? [...noteIds].filter((noteId) => !matchedIds.has(noteId))
              : [],
            complete,
            nextOffset: complete ? null : nextOffset,
          },
        });
      },
    });
    this.register({
      name: "applications.compose_email",
      description:
        "Create a structured job-application email draft from one application record, using the recruitment post's recipient and subject-format requirements when present.",
      scopes: ["applications:read", "email:draft"],
      risk: "write",
      inputSchema: objectSchema(
        {
          noteId: stringSchema(),
          to: stringSchema(),
          subject: stringSchema(),
          text: stringSchema(),
          body: stringSchema(),
          candidateName: stringSchema(),
          school: stringSchema(),
          major: stringSchema(),
          degreeYear: stringSchema(),
          availabilityDays: stringSchema(),
          internshipDuration: stringSchema(),
          arrivalDate: stringSchema(),
          aiProductExperience: stringSchema(),
          attachmentIds: arraySchema(stringSchema()),
        },
        ["noteId"],
      ),
      handler: async (input, context) => {
        const loaded = await this.#dataset("applications", context);
        const noteId = String(input.noteId || "").trim();
        const record = loaded.rows.find((row) => recordId(row) === noteId);
        if (!record) {
          throw toolError(
            "COPILOT_APPLICATION_NOT_FOUND",
            `Application record ${noteId} was not found in the current task snapshot.`,
            404,
          );
        }
        const draft = buildApplicationEmailDraft(record, input);
        context.state.applicationEmailDraft = draft;
        return { ...draft, source: loaded.source };
      },
    });
    this.register({
      name: "audience.segment",
      description:
        "Segment audience users or comments by a selected field and report counts.",
      scopes: ["audience:read"],
      inputSchema: objectSchema(
        {
          dataset: stringSchema(),
          by: stringSchema(),
          limit: integerSchema(1, 100),
        },
        ["by"],
      ),
      handler: async (input, context) => {
        const loaded = await this.#dataset(input.dataset || "users", context);
        return groupRows(
          loaded.rows,
          input.by,
          bounded(input.limit, 30, 1, 100),
          loaded.source,
        );
      },
    });
    this.register({
      name: "audience.coverage",
      description:
        "Report current post, comment, and user coverage from the persisted audience snapshot.",
      scopes: ["audience:read"],
      inputSchema: objectSchema(),
      handler: async (_input, context) => {
        const [posts, comments, users] = await Promise.all([
          this.#dataset("audience.posts", context, { allowUnavailable: true }),
          this.#dataset("comments", context, { allowUnavailable: true }),
          this.#dataset("users", context, { allowUnavailable: true }),
        ]);
        return {
          type: "audience.coverage",
          posts: posts?.rows.length || 0,
          comments: comments?.rows.length || 0,
          users: users?.rows.length || 0,
          sources: [posts?.source, comments?.source, users?.source].filter(Boolean),
        };
      },
    });
    this.register({
      name: "audience.research_brief",
      description:
        "Build an evidence-backed audience research brief from bound posts, comments, and users. Use this first for deep audience, community, demand, sentiment, positioning, or content-strategy analysis. It keeps comment-record and unique-text denominators separate, reports profile and geography coverage, and returns source-addressable evidence samples. Signal buckets can overlap and are triage signals, not demographic estimates.",
      tags: [
        "audience",
        "research",
        "deep analysis",
        "community",
        "demand",
        "sentiment",
        "content strategy",
        "用户洞察",
        "深度分析",
        "受众研究",
        "内容策略",
        "需求",
        "情绪",
        "争议",
      ],
      scopes: ["audience:read"],
      inputSchema: objectSchema({
        exampleLimit: integerSchema(1, 12),
      }),
      handler: async (input, context) => {
        const [posts, comments, users] = await Promise.all([
          this.#dataset("audience.posts", context, { allowUnavailable: true }),
          this.#dataset("comments", context, { allowUnavailable: true }),
          this.#dataset("users", context, { allowUnavailable: true }),
        ]);
        return audienceResearchBrief({
          posts: posts?.rows || [],
          comments: comments?.rows || [],
          users: users?.rows || [],
          sources: [posts?.source, comments?.source, users?.source].filter(Boolean),
          exampleLimit: bounded(input.exampleLimit, 5, 1, 12),
        });
      },
    });
    for (const [name, dataset] of [
      ["users.query", "users"],
      ["comments.query", "comments"],
    ]) {
      this.register({
        name,
        description: `Query ${dataset} in the bound audience dataset.`,
        scopes: ["audience:read"],
        inputSchema: recordSchema("query", dataset),
        handler: (input, context) =>
          this.#records("query", { ...input, dataset }, context),
      });
    }
    this.register({
      name: "expansion.trace",
      description:
        "Trace relationship-expansion nodes and edges for users, posts, comments, or relations.",
      scopes: ["expansion:read"],
      inputSchema: objectSchema({
        kind: enumSchema(["users", "posts", "comments", "relations"]),
        query: stringSchema(),
        limit: integerSchema(1, 500),
      }),
      handler: async (input, context) => {
        const loaded = await this.#dataset(
          `expansion.${input.kind || "relations"}`,
          context,
        );
        const rows = input.query
          ? searchRows(loaded.rows, input.query)
          : loaded.rows;
        return tableResult(
          rows.slice(0, bounded(input.limit, 100, 1, 500)),
          loaded.source,
        );
      },
    });
    this.register({
      name: "expansion.summary",
      description:
        "Summarize persisted relationship-expansion users, posts, comments, and relations.",
      scopes: ["expansion:read"],
      inputSchema: objectSchema(),
      handler: async (_input, context) => {
        const names = ["users", "posts", "comments", "relations"];
        const loaded = await Promise.all(names.map((name) => this.#dataset(`expansion.${name}`, context, { allowUnavailable: true })));
        return {
          type: "expansion.summary",
          counts: Object.fromEntries(names.map((name, index) => [name, loaded[index]?.rows.length || 0])),
          sources: loaded.map((item) => item?.source).filter(Boolean),
        };
      },
    });
    this.register({
      name: "artifact.create",
      description:
        "Create a durable CSV, XLSX, JSON, or Markdown artifact from a query result.",
      scopes: ["artifact:write"],
      risk: "write",
      inputSchema: objectSchema(
        {
          dataset: stringSchema(),
          format: enumSchema(["csv", "xlsx", "json", "markdown", "md"]),
          name: stringSchema(),
          rows: arraySchema({ type: "object", additionalProperties: true }),
          query: stringSchema(),
          filters: arraySchema(
            objectSchema(
              {
                field: stringSchema(),
                op: enumSchema([
                  "eq",
                  "neq",
                  "contains",
                  "not_contains",
                  "in",
                  "gt",
                  "gte",
                  "lt",
                  "lte",
                  "exists",
                  "missing",
                ]),
                value: {},
              },
              ["field"],
            ),
          ),
          sortBy: stringSchema(),
          direction: enumSchema(["asc", "desc"]),
        },
        ["format"],
      ),
      handler: (input, context) => this.#createArtifact(input, context),
    });
    this.register({
      name: "artifact.preview",
      description:
        "Preview metadata and a bounded sample from a conversation artifact.",
      scopes: ["artifact:read"],
      inputSchema: objectSchema({ artifactId: stringSchema() }, ["artifactId"]),
      handler: async (input, context) => {
        if (!this.artifactService?.listArtifacts)
          throw unavailable("Artifact preview");
        const inventory = await this.artifactService.listArtifacts(
          context.reference,
        );
        const artifact = inventory.artifacts.find(
          (item) => item.artifactId === String(input.artifactId),
        );
        if (!artifact)
          throw toolError(
            "COPILOT_ARTIFACT_NOT_FOUND",
            "Artifact was not found.",
            404,
          );
        return { type: "artifact.ready", artifact };
      },
    });
    this.register({
      name: "artifact.list",
      description: "List durable artifacts already created in this conversation.",
      scopes: ["artifact:read"],
      inputSchema: objectSchema(),
      handler: async (_input, context) => {
        if (!this.artifactService?.listArtifacts) throw unavailable("Artifact listing");
        const result = await this.artifactService.listArtifacts(context.reference);
        return { type: "artifact.list", artifacts: result.artifacts || [], source: this.policy.resourceUri(context.reference, "artifacts") };
      },
    });
    this.register({
      name: "attachment.parse",
      description:
        "Parse an uploaded CSV, XLSX, JSON, TXT, DOCX, PDF, or image attachment into bounded structured content.",
      scopes: ["attachment:read"],
      inputSchema: objectSchema({ attachmentId: stringSchema() }, [
        "attachmentId",
      ]),
      handler: async (input, context) => {
        if (!this.artifactService?.parseAttachment)
          throw unavailable("Attachment parsing");
        return this.artifactService.parseAttachment(
          context.reference,
          input.attachmentId,
        );
      },
    });
    this.register({
      name: "attachment.join_dataset",
      description:
        "Join parsed attachment rows to a task dataset on explicit keys.",
      scopes: ["attachment:read"],
      inputSchema: objectSchema(
        {
          attachmentId: stringSchema(),
          dataset: stringSchema(),
          attachmentKey: stringSchema(),
          datasetKey: stringSchema(),
          limit: integerSchema(1, 1000),
        },
        ["attachmentId", "dataset", "attachmentKey", "datasetKey"],
      ),
      handler: async (input, context) => {
        if (!this.artifactService?.parseAttachment)
          throw unavailable("Attachment parsing");
        const [attachment, loaded] = await Promise.all([
          this.artifactService.parseAttachment(
            context.reference,
            input.attachmentId,
          ),
          this.#dataset(input.dataset, context),
        ]);
        const rows = Array.isArray(attachment.rows) ? attachment.rows : [];
        return tableResult(
          joinRows(
            rows,
            loaded.rows,
            input.attachmentKey,
            input.datasetKey,
          ).slice(0, bounded(input.limit, 500, 1, 1000)),
          [attachment.source, loaded.source],
        );
      },
    });
    this.register({
      name: "attachment.list",
      description: "List uploaded attachments available to the current conversation.",
      scopes: ["attachment:read"],
      inputSchema: objectSchema(),
      handler: async (_input, context) => {
        if (!this.artifactService?.listAttachments) throw unavailable("Attachment listing");
        const result = await this.artifactService.listAttachments(context.reference);
        return { type: "attachment.list", attachments: result.attachments || [], source: this.policy.resourceUri(context.reference, "attachments") };
      },
    });
    this.register({
      name: "email.prepare",
      description:
        "Prepare a recipient, subject, body, and artifact attachment list without sending.",
      scopes: ["email:draft"],
      risk: "write",
      inputSchema: emailSchema(),
      handler: async (input, context) => ({
        type: "email.draft",
        preview: await this.#prepareEmail(input, context),
      }),
    });
    this.register({
      name: "email.preview",
      description:
        "Preview the exact email envelope, body, and attachments before approval.",
      scopes: ["email:draft"],
      risk: "write",
      inputSchema: emailSchema(),
      handler: async (input, context) => ({
        type: "email.draft",
        preview: await this.#prepareEmail(input, context),
      }),
    });
    this.register({
      name: "email.send",
      description:
        "Send the exact previewed email. This always requires explicit user approval.",
      scopes: ["email:send"],
      risk: "approval_required",
      inputSchema: emailSchema(),
      handler: (input, context) => this.#sendEmail(input, context),
    });
  }

  async #listDatasets(context) {
    const candidates =
      context.reference.mode === "application"
        ? [
            "applications",
            "content",
            "comments",
            "users",
            "audience.posts",
            "expansion.users",
            "expansion.posts",
            "expansion.comments",
            "expansion.relations",
          ]
        : [
            "content",
            "comments",
            "users",
            "audience.posts",
            "expansion.users",
            "expansion.posts",
            "expansion.comments",
            "expansion.relations",
          ];
    const datasets = [];
    for (const name of candidates) {
      const loaded = await this.#dataset(name, context, {
        allowUnavailable: true,
      });
      if (loaded)
        datasets.push({
          name,
          count: loaded.rows.length,
          source: loaded.source,
        });
    }
    return { datasets };
  }

  async #dataset(rawName, context, { allowUnavailable = false } = {}) {
    const name = normalizeDatasetName(rawName, context.reference.mode);
    context.state.datasets ||= new Map();
    if (context.state.datasets.has(name))
      return context.state.datasets.get(name);
    let loaded;
    if (name === "applications" || name === "content") {
      const rows = await readApplicationRows(context.outputDir);
      loaded = {
        name,
        rows,
        source: this.policy.resourceUri(
          context.reference,
          name === "applications" ? "applications" : "content",
        ),
      };
    } else if (["comments", "users", "audience.posts"].includes(name)) {
      const audience = await materializeAudienceResults(context.outputDir);
      const rows =
        name === "comments"
          ? audience.comments
          : name === "users"
            ? audience.users
            : audience.posts;
      loaded = {
        name,
        rows,
        source: this.policy.resourceUri(context.reference, "audience"),
      };
    } else if (name.startsWith("expansion.")) {
      const kind = name.slice("expansion.".length);
      const snapshot = await readExpansionSnapshot(
        context.outputDir,
        new URLSearchParams({ kind, limit: "100" }),
      );
      const rows = await readExpansionRows(context.outputDir, kind, snapshot);
      loaded = {
        name,
        rows,
        source: this.policy.resourceUri(context.reference, "expansion"),
      };
    } else {
      throw toolError(
        "COPILOT_DATASET_UNKNOWN",
        `Unknown dataset: ${name}.`,
        404,
      );
    }
    loaded = {
      ...loaded,
      rows: filterRowsByContextSelection(
        loaded.rows,
        name,
        context.contextSourceIds,
        context.reference.jobId,
      ),
    };
    if (allowUnavailable && loaded.rows.length === 0) return null;
    context.state.datasets.set(name, loaded);
    return loaded;
  }

  async #records(operation, input, context) {
    const loaded = await this.#dataset(input.dataset, context);
    let rows = loaded.rows;
    if (operation === "get") {
      const row = findRecord(rows, input.id || input.recordId);
      if (!row)
        throw toolError(
          "COPILOT_RECORD_NOT_FOUND",
          "The requested record was not found.",
          404,
        );
      return { record: row, source: loaded.source };
    }
    if (operation === "search")
      rows = searchRows(rows, input.query, input.fields);
    if (operation === "filter") rows = filterRows(rows, input.filters);
    if (operation === "sort") rows = sortRows(rows, input.by, input.direction);
    if (operation === "query") {
      if (input.query) rows = searchRows(rows, input.query, input.fields);
      if (input.filters) rows = filterRows(rows, input.filters);
      if (input.sortBy) rows = sortRows(rows, input.sortBy, input.direction);
    }
    if (operation === "aggregate")
      return aggregateRows(rows, input, loaded.source);
    if (operation === "group")
      return groupRows(
        rows,
        input.by,
        bounded(input.limit, 50, 1, 200),
        loaded.source,
      );
    if (operation === "join") {
      const right = await this.#dataset(input.rightDataset, context);
      rows = joinRows(rows, right.rows, input.leftKey, input.rightKey);
      return tableResult(
        rows.slice(0, bounded(input.limit, MAX_TOOL_ROWS, 1, 1000)),
        [loaded.source, right.source],
        rows.length,
      );
    }
    const total = rows.length;
    const offset = bounded(input.offset, 0, 0, 1_000_000);
    const limit = bounded(input.limit, 100, 1, 1000);
    return tableResult(
      rows.slice(offset, offset + limit),
      loaded.source,
      total,
      { offset, limit },
    );
  }

  async #createArtifact(input, context) {
    if (!this.artifactService?.createArtifact)
      throw unavailable("Artifact creation");
    const dataset =
      input.dataset ||
      (context.reference.mode === "application" ? "applications" : "content");
    let rows = Array.isArray(input.rows) ? input.rows : null;
    let source = this.policy.resourceUri(
      context.reference,
      context.reference.mode === "application" ? "applications" : "content",
    );
    if (!rows || input.dataset) {
      const loaded = await this.#dataset(dataset, context);
      if (!rows) rows = loaded.rows;
      source = loaded.source;
    }
    const sourceRecordIds = rows.map((row) => recordId(row)).filter(Boolean);
    const query = {
      dataset: String(dataset),
      ...(input.query ? { query: String(input.query) } : {}),
      ...(Array.isArray(input.filters) && input.filters.length
        ? { filters: input.filters }
        : {}),
      ...(input.sortBy
        ? {
            sortBy: String(input.sortBy),
            direction: input.direction === "desc" ? "desc" : "asc",
          }
        : {}),
    };
    const created = await this.artifactService.createArtifact(
      context.reference,
      {
        name: input.name,
        format: input.format === "md" ? "markdown" : input.format,
        data: rows,
        source,
        sourceRecordIds,
        sourceRecordCount: rows.length,
        query,
        sourceRunId: context.runId,
        sourceToolRunId: context.toolRunId,
        idempotencyKey: context.idempotencyKey,
      },
    );
    return { type: "artifact.ready", ...created };
  }

  async #sendEmail(input, context) {
    if (!context.approved)
      throw toolError(
        "COPILOT_APPROVAL_REQUIRED",
        "Email delivery requires explicit approval.",
        409,
      );
    if (!this.mailSender?.send) throw unavailable("Email delivery");
    const preview = await this.#prepareEmail(input, context);
    const attachments = preview.attachmentIds.length
      ? await Promise.all(
          preview.attachmentIds.map(async (artifactId) => {
            const resolved = await this.artifactService.resolveArtifact(
              context.reference,
              artifactId,
            );
            return {
              filename: resolved.artifact.displayName,
              path: resolved.absolutePath,
              contentType: resolved.artifact.mediaType,
            };
          }),
        )
      : [];
    const result = await this.mailSender.send({
      to: preview.to,
      cc: preview.cc,
      bcc: preview.bcc,
      replyTo: preview.replyTo || undefined,
      subject: preview.subject,
      text: preview.text,
      attachments,
      idempotencyKey: context.idempotencyKey,
      deliveryAttemptId: context.deliveryAttemptId,
      headers: {
        "X-Copilot-Delivery-Attempt": String(context.deliveryAttemptId || ""),
        "X-Copilot-Idempotency-Key": String(context.idempotencyKey || ""),
      },
    });
    return {
      type: "email.sent",
      ...result,
      deliveryAttemptId: String(context.deliveryAttemptId || ""),
      idempotencyKey: String(context.idempotencyKey || ""),
      sentAt: new Date().toISOString(),
      preview,
    };
  }

  async #prepareEmail(input, context) {
    const to = validEmail(String(input.to || "").trim(), "recipient");
    const cc = validEmailList(input.cc, "CC recipient");
    const bcc = validEmailList(input.bcc, "BCC recipient");
    const replyTo = input.replyTo
      ? validEmail(String(input.replyTo).trim(), "Reply-To address")
      : "";
    let subject = String(input.subject || "")
      .trim()
      .slice(0, 300);
    const text = String(input.text || input.body || "")
      .trim()
      .slice(0, 200_000);
    if (!subject || !text)
      throw toolError(
        "COPILOT_EMAIL_INVALID",
        "Email subject and body are required.",
      );

    let application = null;
    let applicationDraft = null;
    const applicationNoteId = String(input.applicationNoteId || "").trim();
    if (applicationNoteId) {
      const loaded = await this.#dataset("applications", context);
      const record = loaded.rows.find((row) => recordId(row) === applicationNoteId);
      if (!record) {
        throw toolError(
          "COPILOT_APPLICATION_NOT_FOUND",
          `Application record ${applicationNoteId} was not found in the current task snapshot.`,
          404,
        );
      }
      const recipients = applicationContactEmails(record);
      if (!recipients.length) {
        throw toolError(
          "COPILOT_APPLICATION_RECIPIENT_MISSING",
          "This application record does not contain a verified recruitment email address.",
        );
      }
      if (!recipients.includes(to.toLowerCase())) {
        throw toolError(
          "COPILOT_APPLICATION_RECIPIENT_MISMATCH",
          "The recipient must be a recruitment email extracted from this application record.",
        );
      }
      applicationDraft = buildApplicationEmailDraft(record, input);
      const resolvedSubject = resolveApplicationEmailSubject(record, subject, input);
      subject = resolvedSubject.subject;
      const subjectGuard = applicationSubjectGuard(record, subject, input);
      if (context.toolName === "email.send" && subjectGuard.requiresReview) {
        throw toolError(
          "COPILOT_APPLICATION_SUBJECT_TITLE_REVIEW_REQUIRED",
          "The recruitment post title was excluded from the email subject. Add the precise role name before sending.",
        );
      }
      const subjectValidation = validateApplicationEmailSubject(record, subject, input);
      if (
        context.toolName === "email.send" &&
        ["missing_fields", "non_compliant"].includes(subjectValidation.status)
      ) {
        throw toolError(
          "COPILOT_APPLICATION_SUBJECT_MISMATCH",
          "The email subject does not satisfy the recruitment post's subject-format requirement.",
        );
      }
      application = {
        noteId: applicationNoteId,
        jobTitle: normalizeApplicationRoleTitle(firstString(
          record.job_card?.role_name,
          record.job_card?.title,
          record.role_name,
          record.title,
        )),
        company: firstString(record.job_card?.company_name, record.company_name, record.company),
        sourceUrl: firstString(record.note_url, record.source_url, record.job_card?.source_url),
        post: applicationDraft.post,
        subjectRule: {
          ...applicationDraft.subjectRule,
          status: subjectValidation.status,
          missingFields: subjectValidation.missingFields,
          missingValues: subjectValidation.missingValues,
        },
        subjectGuard,
      };
    }

    const attachmentIds = [...new Set(arrayOfStrings(input.attachmentIds))];
    if (attachmentIds.length && !this.artifactService?.resolveArtifact)
      throw unavailable("Email attachments");
    const attachments = await Promise.all(
      attachmentIds.map(async (artifactId) => {
        const { artifact } = await this.artifactService.resolveArtifact(
          context.reference,
          artifactId,
        );
        return {
          artifactId,
          displayName: artifact.displayName,
          size: Number(artifact.size || 0),
          sha256: String(artifact.sha256 || ""),
          mediaType: String(artifact.mediaType || "application/octet-stream"),
          source: artifact.source || null,
          sourceRunId: String(artifact.sourceRunId || ""),
          sourceToolRunId: String(artifact.sourceToolRunId || ""),
        };
      }),
    );
    const deliveryMethod = String(input.deliveryMethod || "smtp")
      .trim()
      .toLowerCase();
    if (deliveryMethod !== "smtp")
      throw toolError(
        "COPILOT_EMAIL_DELIVERY_UNSUPPORTED",
        "Only the configured SMTP delivery method is available.",
      );
    const deliverySource = String(input.deliverySource || "configured_smtp")
      .trim()
      .slice(0, 160);
    const defaultJobSource = this.policy.resourceUri(
      context.reference,
      context.reference.mode === "application" ? "applications" : "content",
    );
    const qualityScore =
      input.qualityScore === undefined || input.qualityScore === null
        ? null
        : Number(input.qualityScore);
    if (
      qualityScore !== null &&
      (!Number.isFinite(qualityScore) || qualityScore < 0 || qualityScore > 100)
    ) {
      throw toolError(
        "COPILOT_EMAIL_QUALITY_INVALID",
        "Email quality score must be between 0 and 100.",
      );
    }
    const preview = {
      to,
      cc,
      bcc,
      replyTo,
      subject,
      text,
      attachmentIds,
      attachments,
      deliveryMethod,
      deliverySource,
      jobRecordSource: String(input.jobRecordSource || defaultJobSource)
        .trim()
        .slice(0, 1_000),
      qualityScore,
      ...(application ? { application } : {}),
      requiresApproval: true,
      conversationId: context.reference.conversationId,
      jobId: context.reference.jobId,
    };
    context.state.emailPreview = preview;
    return preview;
  }
}

async function readApplicationRows(outputDir) {
  const candidates = [
    "application_intelligence.checkpoint.json",
    "application_intelligence.json",
  ];
  let payload = null;
  for (const filename of candidates) {
    try {
      const value = JSON.parse(
        await readFile(path.join(outputDir, filename), "utf8"),
      );
      if (Array.isArray(value?.records)) {
        payload = value;
        break;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }
  if (!payload) return [];
  let delivery = {};
  try {
    delivery = JSON.parse(
      await readFile(path.join(outputDir, "delivery-state.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError))
      throw error;
  }
  const states =
    delivery?.records && typeof delivery.records === "object"
      ? delivery.records
      : delivery;
  return payload.records.map((row) => ({
    ...row,
    ...(states?.[recordId(row)] ? { delivery: states[recordId(row)] } : {}),
  }));
}

async function readExpansionRows(outputDir, kind, snapshot) {
  try {
    const graph = JSON.parse(
      await readFile(path.join(outputDir, "graph.json"), "utf8"),
    );
    if (kind === "relations")
      return Array.isArray(graph.edges) ? graph.edges : [];
    return (Array.isArray(graph.nodes) ? graph.nodes : []).filter(
      (row) => String(row?.type || "").toLowerCase() === kind.slice(0, -1),
    );
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError))
      throw error;
    return snapshot?.results?.items || [];
  }
}

function filterRows(rows, filters) {
  const conditions = Array.isArray(filters) ? filters.slice(0, 50) : [];
  return rows.filter((row) =>
    conditions.every((condition) =>
      matchesCondition(fieldValue(row, condition.field), condition),
    ),
  );
}

function matchesCondition(actual, condition = {}) {
  const operator = String(condition.op || "eq").toLowerCase();
  const expected = condition.value;
  if (operator === "exists")
    return actual !== undefined && actual !== null && actual !== "";
  if (operator === "missing")
    return actual === undefined || actual === null || actual === "";
  if (operator === "contains")
    return normalizedText(actual).includes(normalizedText(expected));
  if (operator === "not_contains")
    return !normalizedText(actual).includes(normalizedText(expected));
  if (operator === "in")
    return (
      Array.isArray(expected) &&
      expected.map(normalizedScalar).includes(normalizedScalar(actual))
    );
  if (operator === "gt") return comparable(actual) > comparable(expected);
  if (operator === "gte") return comparable(actual) >= comparable(expected);
  if (operator === "lt") return comparable(actual) < comparable(expected);
  if (operator === "lte") return comparable(actual) <= comparable(expected);
  if (operator === "neq")
    return normalizedScalar(actual) !== normalizedScalar(expected);
  return normalizedScalar(actual) === normalizedScalar(expected);
}

function searchRows(rows, query, fields = []) {
  const needle = normalizedText(query);
  if (!needle) return rows;
  const selected = arrayOfStrings(fields);
  return rows.filter((row) => {
    const value = selected.length
      ? selected.map((field) => fieldValue(row, field))
      : row;
    return normalizedText(value).includes(needle);
  });
}

function sortRows(rows, by, direction = "desc") {
  const field = String(by || "publish_time");
  const factor = String(direction).toLowerCase() === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({
      row,
      index,
      value: comparable(fieldValue(row, field)),
    }))
    .sort((left, right) =>
      left.value === right.value
        ? left.index - right.index
        : left.value > right.value
          ? factor
          : -factor,
    )
    .map((item) => item.row);
}

function aggregateRows(rows, input, source) {
  const operation = String(input.operation || "count");
  const values = rows
    .map((row) => Number(fieldValue(row, input.field)))
    .filter(Number.isFinite);
  let value = rows.length;
  if (operation === "sum") value = values.reduce((sum, item) => sum + item, 0);
  if (operation === "avg")
    value = values.length
      ? values.reduce((sum, item) => sum + item, 0) / values.length
      : null;
  if (operation === "min") value = values.length ? Math.min(...values) : null;
  if (operation === "max") value = values.length ? Math.max(...values) : null;
  if (operation === "distinct")
    value = new Set(
      rows.map((row) => normalizedScalar(fieldValue(row, input.field))),
    ).size;
  return {
    operation,
    field: input.field || null,
    value,
    rowCount: rows.length,
    source,
  };
}

function groupRows(rows, by, limit, source) {
  const counts = new Map();
  for (const row of rows) {
    const raw = fieldValue(row, by);
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      const key =
        value === undefined || value === null || value === ""
          ? "(missing)"
          : String(value);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const grouped = [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
  return tableResult(grouped, source, counts.size);
}

const AUDIENCE_SIGNAL_RULES = Object.freeze([
  {
    id: "replication_and_purchase",
    label: "复刻、购买与来源获取",
    interpretation: "用户希望获得可执行的单品、方法、价格或来源信息。",
    terms: ["怎么", "如何", "教程", "求同款", "同款", "链接", "哪里买", "怎么买", "购买", "店铺", "品牌", "价格", "推荐"],
  },
  {
    id: "contextual_fit",
    label: "日常场景与适配约束",
    interpretation: "用户在工作、学校、预算、身体或暴露度等现实约束下评估是否可采用。",
    terms: ["上班", "上学", "通勤", "日常", "身材", "胖", "瘦", "胳膊", "遮住", "适合", "不适合", "预算"],
  },
  {
    id: "identity_and_meaning",
    label: "身份归属与文化理解",
    interpretation: "用户在讨论定义、文化内核、圈层边界或新手进入门槛。",
    terms: ["算不算", "定义", "内核", "文化", "亚文化", "商业化", "符号", "圈子", "新手", "入门"],
  },
  {
    id: "service_and_collaboration",
    label: "服务与协作线索",
    interpretation: "用户可能从内容消费转向拍摄、妆造、合作或联系人等服务需求。",
    terms: ["摄影师", "拍摄", "约拍", "妆造", "联系方式", "合作", "老师"],
  },
  {
    id: "boundary_and_conflict",
    label: "边界、冲突与排斥风险",
    interpretation: "讨论包含争议、攻击、身份判断、身体评价或被排斥的风险信号。",
    terms: ["争议", "攻击", "歧视", "冒犯", "性别", "恶心", "刻板", "排斥", "焦虑", "规训"],
  },
  {
    id: "aesthetic_affirmation",
    label: "审美认同与正向反馈",
    interpretation: "用户在表达喜欢、认同或对视觉效果的正向评价。",
    terms: ["好看", "漂亮", "喜欢", "爱了", "绝了", "氛围", "高级", "美"],
  },
]);

function audienceResearchBrief({ posts = [], comments = [], users = [], sources = [], exampleLimit = 5 } = {}) {
  const postTitles = new Map(
    posts.map((post) => [
      firstString(post?.post_id, post?.postId, post?.note_id, post?.noteId, post?.id),
      firstString(post?.title, post?.name),
    ]).filter(([postId]) => postId),
  );
  const commentFacts = comments.map((comment, index) => audienceCommentFact(comment, index, postTitles));
  const commentsWithText = commentFacts.filter((comment) => comment.text);
  const uniqueTextCounts = new Map();
  for (const comment of commentsWithText) {
    uniqueTextCounts.set(comment.normalizedText, (uniqueTextCounts.get(comment.normalizedText) || 0) + 1);
  }
  const profileCompletion = countAudienceValues(
    users,
    (user) => firstString(user?.enrichment_status, user?.profile_status, user?.status).toLowerCase() || "unknown",
  );
  const roleCounts = countAudienceValues(users, (user) => {
    const roles = Array.isArray(user?.roles) ? user.roles : [];
    return roles.length ? roles : ["unclassified"];
  });
  const locationFacts = commentFacts.filter((comment) => comment.location);
  const locationCounts = countAudienceValues(locationFacts, (comment) => comment.location);
  const knownLikes = commentFacts.filter((comment) => comment.likes !== null);
  const topLevelCommentRecords = commentFacts.filter((comment) => !comment.parentCommentId).length;
  const replyCommentRecords = commentFacts.length - topLevelCommentRecords;
  const repeatedTextRecords = [...uniqueTextCounts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  const questionComments = commentsWithText.filter((comment) => audienceQuestion(comment.text));

  return {
    type: "audience.research_brief",
    methodology: {
      analysisUnit: "comment record",
      signalMethod: "Rule-based lexical triage over comment text. Signal buckets overlap; use them to prioritize evidence review and validation, not as mutually exclusive audience segments.",
      populationGuardrail: "Do not infer demographic composition, independent-user share, or majority opinion from keyword mentions, repeated text, incomplete profiles, or engagement alone.",
    },
    coverage: {
      postRecords: posts.length,
      commentRecords: commentFacts.length,
      commentsWithText: commentsWithText.length,
      uniqueCommentTexts: uniqueTextCounts.size,
      repeatedTextRecords,
      topLevelCommentRecords,
      replyCommentRecords,
      uniqueCommentUsers: new Set(commentFacts.map((comment) => comment.userId).filter(Boolean)).size,
      userRecords: users.length,
    },
    dataQuality: {
      repeatedTextRate: audienceRatio(repeatedTextRecords, commentFacts.length),
      profileCompletion: audienceCountRows(profileCompletion, 12),
      geography: {
        recordsWithLocation: locationFacts.length,
        recordsWithoutLocation: commentFacts.length - locationFacts.length,
        topLocations: audienceCountRows(locationCounts, 10),
      },
      warning: repeatedTextRecords
        ? "Repeated comment text is present. Compare both comment-record and unique-text counts before estimating issue prevalence."
        : "No repeated non-empty comment text was detected in the materialized snapshot.",
    },
    participation: {
      questionOrInformationSeekingRecords: questionComments.length,
      questionOrInformationSeekingUniqueTexts: new Set(questionComments.map((comment) => comment.normalizedText)).size,
      commentTopology: {
        topLevelCommentRecords,
        replyCommentRecords,
        replyShare: audienceRatio(replyCommentRecords, commentFacts.length),
      },
      userRoles: audienceCountRows(roleCounts, 12),
    },
    demandAndRiskSignals: AUDIENCE_SIGNAL_RULES.map((rule) =>
      audienceSignalSummary(rule, commentsWithText, uniqueTextCounts, exampleLimit)),
    engagement: {
      likes: {
        recordsWithLikeCount: knownLikes.length,
        recordsWithoutLikeCount: commentFacts.length - knownLikes.length,
        total: knownLikes.reduce((total, comment) => total + comment.likes, 0),
        averagePerKnownRecord: knownLikes.length
          ? audienceRound(knownLikes.reduce((total, comment) => total + comment.likes, 0) / knownLikes.length)
          : null,
      },
      topComments: [...commentFacts]
        .filter((comment) => comment.text)
        .sort(compareAudienceAttention)
        .slice(0, exampleLimit)
        .map(audienceEvidence),
      topPosts: audiencePostAttention(commentFacts, postTitles, exampleLimit),
    },
    sources: [...new Set(sources.map(String).filter(Boolean))],
  };
}

function audienceCommentFact(comment, index, postTitles) {
  const text = firstString(comment?.text, comment?.comment, comment?.content, comment?.body);
  const postId = firstString(comment?.post_id, comment?.postId, comment?.note_id, comment?.noteId);
  return {
    commentId:
      firstString(comment?.comment_id, comment?.commentId, comment?.id) ||
      `comment-${index + 1}`,
    postId,
    postTitle: firstString(comment?.post_title, postTitles.get(postId)),
    parentCommentId: firstString(comment?.parent_comment_id, comment?.parentCommentId, comment?.reply_to_comment_id),
    userId: firstString(comment?.user?.user_id, comment?.user_id, comment?.user?.id),
    text,
    normalizedText: normalizeAudienceText(text),
    likes: audienceNumber(comment?.likes, comment?.like_count, comment?.likeCount, comment?.liked_count),
    location: normalizeAudienceLocation(firstString(
      comment?.location,
      comment?.ip_location,
      comment?.ipLocation,
      comment?.user?.location,
      comment?.user?.ip_location,
    )),
    sourceUrl: firstString(comment?.source_url, comment?.note_url, comment?.url),
  };
}

function audienceSignalSummary(rule, comments, uniqueTextCounts, exampleLimit) {
  const matched = comments.filter((comment) => rule.terms.some((term) => comment.normalizedText.includes(term)));
  const uniqueTexts = new Set(matched.map((comment) => comment.normalizedText));
  const knownLikes = matched.filter((comment) => comment.likes !== null);
  return {
    id: rule.id,
    label: rule.label,
    interpretation: rule.interpretation,
    matchedTerms: rule.terms,
    evidence: {
      commentRecords: matched.length,
      uniqueCommentTexts: uniqueTexts.size,
      repeatedTextRecords: [...uniqueTexts]
        .reduce((total, text) => total + Math.max(0, (uniqueTextCounts.get(text) || 0) - 1), 0),
      recordShare: audienceRatio(matched.length, comments.length),
      likesOnKnownRecords: knownLikes.reduce((total, comment) => total + comment.likes, 0),
      averageLikesOnKnownRecords: knownLikes.length
        ? audienceRound(knownLikes.reduce((total, comment) => total + comment.likes, 0) / knownLikes.length)
        : null,
    },
    examples: [...matched]
      .sort(compareAudienceAttention)
      .slice(0, exampleLimit)
      .map(audienceEvidence),
  };
}

function audiencePostAttention(comments, postTitles, limit) {
  const byPost = new Map();
  for (const comment of comments) {
    const postId = comment.postId || "(unknown post)";
    if (!byPost.has(postId)) {
      byPost.set(postId, {
        postId,
        postTitle: comment.postTitle || postTitles.get(postId) || "",
        commentRecords: 0,
        likesOnKnownRecords: 0,
        knownLikeRecords: 0,
        users: new Set(),
      });
    }
    const current = byPost.get(postId);
    current.commentRecords += 1;
    if (comment.userId) current.users.add(comment.userId);
    if (comment.likes !== null) {
      current.knownLikeRecords += 1;
      current.likesOnKnownRecords += comment.likes;
    }
  }
  return [...byPost.values()]
    .map((post) => ({
      postId: post.postId,
      postTitle: post.postTitle,
      commentRecords: post.commentRecords,
      uniqueCommentUsers: post.users.size,
      likesOnKnownRecords: post.likesOnKnownRecords,
      knownLikeRecords: post.knownLikeRecords,
    }))
    .sort((left, right) => right.likesOnKnownRecords - left.likesOnKnownRecords
      || right.commentRecords - left.commentRecords
      || left.postId.localeCompare(right.postId))
    .slice(0, limit);
}

function audienceEvidence(comment) {
  return {
    commentId: comment.commentId,
    postId: comment.postId || null,
    postTitle: comment.postTitle || null,
    likes: comment.likes,
    text: comment.text.length > 240 ? `${comment.text.slice(0, 237)}...` : comment.text,
    sourceUrl: comment.sourceUrl || null,
  };
}

function countAudienceValues(rows, valuesFor) {
  const counts = new Map();
  for (const row of rows) {
    const values = valuesFor(row);
    for (const value of Array.isArray(values) ? values : [values]) {
      const key = String(value || "unknown").trim() || "unknown";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function audienceCountRows(counts, limit) {
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, limit);
}

function audienceQuestion(text) {
  return /[?？]/u.test(text) || /(?:怎么|如何|哪里|能不能|可不可以|求)/u.test(text);
}

function normalizeAudienceText(value) {
  return String(value || "").replace(/\s+/gu, "").toLocaleLowerCase("zh-CN");
}

function normalizeAudienceLocation(value) {
  return String(value || "").replace(/^ip\s*(?:属地)?\s*[:：]?\s*/iu, "").trim().slice(0, 120);
}

function audienceNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(String(value).replaceAll(",", "").trim());
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return null;
}

function compareAudienceAttention(left, right) {
  return (right.likes ?? -1) - (left.likes ?? -1)
    || left.commentId.localeCompare(right.commentId);
}

function audienceRatio(numerator, denominator) {
  if (!denominator) return 0;
  return audienceRound(numerator / denominator);
}

function audienceRound(value) {
  return Math.round(Number(value || 0) * 10_000) / 10_000;
}

function joinRows(left, right, leftKey, rightKey) {
  const index = new Map();
  for (const row of right) {
    const key = normalizedScalar(fieldValue(row, rightKey));
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  return left.flatMap((row) =>
    (index.get(normalizedScalar(fieldValue(row, leftKey))) || []).map(
      (match) => ({ left: row, right: match }),
    ),
  );
}

function findRecord(rows, id) {
  const value = String(id || "");
  return rows.find((row) => recordId(row) === value) || null;
}

function applicationEmailRequirement(row) {
  const recipientEmails = applicationContactEmails(row);
  const subjectRule = applicationSubjectRule(row);
  const attachmentRule = detectApplicationAttachmentRule(row);
  const hasAnyRequirement = recipientEmails.length > 0 || subjectRule.detected || attachmentRule.detected;
  const hasCoreEmailRequirement = recipientEmails.length > 0 && subjectRule.detected;
  return {
    noteId: recordId(row),
    title: firstString(row?.title, row?.job_card?.title, row?.job_card?.role_name),
    company: firstString(row?.job_card?.company_name, row?.company_name, row?.company),
    jobTitle: normalizeApplicationRoleTitle(firstString(row?.job_card?.role_name, row?.job_card?.title, row?.title)),
    recipientEmails,
    subjectRuleDetected: subjectRule.detected,
    subjectFormat: subjectRule.template,
    subjectFields: subjectRule.fields,
    subjectEvidence: subjectRule.evidence,
    attachmentRuleDetected: attachmentRule.detected,
    attachmentFormat: attachmentRule.template,
    attachmentFields: attachmentRule.fields,
    attachmentEvidence: attachmentRule.evidence,
    extractionStatus: hasCoreEmailRequirement
      ? "complete"
      : hasAnyRequirement
        ? "partial"
        : "not_found",
    missing: [
      ...(recipientEmails.length ? [] : ["recipientEmail"]),
      ...(subjectRule.detected ? [] : ["subjectFormat"]),
    ],
    sourceUrl: firstString(row?.note_url, row?.source_url, row?.job_card?.source_url),
  };
}

function recordId(row) {
  return firstString(
    row?.note_id,
    row?.noteId,
    row?.post_id,
    row?.postId,
    row?.comment_id,
    row?.commentId,
    row?.user_id,
    row?.userId,
    row?.id,
  );
}

function fieldValue(value, field) {
  return String(field || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);
}

function imageValues(row) {
  const media = row?.media && typeof row.media === "object" ? row.media : {};
  const values = Array.isArray(media.images) ? media.images : [];
  const legacy = [
    row?.cover_url,
    row?.card_cover_url,
    ...(Array.isArray(row?.image_urls) ? row.image_urls : []),
  ].filter(Boolean);
  return [...values, ...legacy.map((url) => ({ url }))].slice(0, 30);
}

function describeFields(rows) {
  const fields = new Map();
  for (const row of rows.slice(0, 100)) {
    for (const [key, value] of Object.entries(row || {})) {
      if (!fields.has(key))
        fields.set(key, { name: key, types: new Set(), examples: [] });
      const item = fields.get(key);
      item.types.add(
        Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
      );
      if (
        item.examples.length < 3 &&
        value !== undefined &&
        value !== null &&
        value !== ""
      )
        item.examples.push(previewValue(value));
    }
  }
  return [...fields.values()].map((item) => ({
    name: item.name,
    types: [...item.types],
    examples: item.examples,
  }));
}

function tableResult(rows, source, total = rows.length, extra = {}) {
  return {
    type: "table.result",
    total,
    rows: rows.slice(0, MAX_TOOL_ROWS),
    truncated: rows.length > MAX_TOOL_ROWS || total > rows.length,
    source,
    ...extra,
  };
}

function normalizeDatasetName(value, mode) {
  const text = String(
    value || (mode === "application" ? "applications" : "content"),
  )
    .trim()
    .toLowerCase();
  const aliases = {
    posts: "content",
    jobs: "applications",
    audience: "audience.posts",
    expansion: "expansion.relations",
  };
  return aliases[text] || text;
}

function recordDescription(operation) {
  return {
    search: "Search records using natural text over selected fields.",
    query:
      "Apply text, structured filters, sorting, offset, and limit in one deterministic query.",
    filter: "Filter records with explicit field/operator/value conditions.",
    sort: "Sort records deterministically by a field.",
    aggregate:
      "Calculate count, sum, average, minimum, maximum, or distinct count.",
    group: "Group records by a field and count each value.",
    join: "Join two permitted datasets by explicit keys.",
    get: "Get one record by its stable identifier.",
  }[operation];
}

function toolSummary(definition) {
  return {
    name: definition.name,
    title: definition.title || definition.name,
    description: definition.description,
    version: definition.version,
    category: definition.category,
    tags: definition.tags,
    risk: definition.risk,
    scopes: definition.scopes,
    idempotent: definition.idempotent !== false,
    parallelSafe: definition.parallelSafe !== false,
  };
}

function taskStatus(job = {}) {
  return {
    id: String(job.id || ""),
    status: String(job.status || "unknown"),
    revision: Number(job.revision || 0),
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    currentAttemptId: job.currentAttemptId || null,
    resumeCount: Number(job.resumeCount || 0),
    lastResumedAt: job.lastResumedAt || null,
    attemptCount: Array.isArray(job.attempts) ? job.attempts.length : 0,
    outputDir: String(job.outputDir || ""),
  };
}

function recordSchema(operation, defaultDataset = "") {
  const properties = {
    dataset: {
      ...stringSchema(),
      ...(defaultDataset ? { default: defaultDataset } : {}),
    },
    query: stringSchema(),
    fields: arraySchema(stringSchema()),
    filters: arraySchema(
      objectSchema(
        {
          field: stringSchema(),
          op: enumSchema([
            "eq",
            "neq",
            "contains",
            "not_contains",
            "in",
            "gt",
            "gte",
            "lt",
            "lte",
            "exists",
            "missing",
          ]),
          value: {},
        },
        ["field"],
      ),
    ),
    sortBy: stringSchema(),
    by: stringSchema(),
    direction: enumSchema(["asc", "desc"]),
    offset: integerSchema(0, 1_000_000),
    limit: integerSchema(1, 1000),
    operation: enumSchema(["count", "sum", "avg", "min", "max", "distinct"]),
    field: stringSchema(),
    rightDataset: stringSchema(),
    leftKey: stringSchema(),
    rightKey: stringSchema(),
    id: stringSchema(),
    recordId: stringSchema(),
  };
  const required = defaultDataset ? [] : ["dataset"];
  if (operation === "search") required.push("query");
  if (operation === "sort" || operation === "group") required.push("by");
  if (operation === "join")
    required.push("rightDataset", "leftKey", "rightKey");
  if (operation === "get") required.push("id");
  return objectSchema(properties, required);
}

function emailSchema() {
  return objectSchema(
    {
      to: stringSchema(),
      cc: arraySchema(stringSchema()),
      bcc: arraySchema(stringSchema()),
      replyTo: stringSchema(),
      subject: stringSchema(),
      text: stringSchema(),
      body: stringSchema(),
      attachmentIds: arraySchema(stringSchema()),
      deliveryMethod: enumSchema(["smtp"]),
      deliverySource: stringSchema(),
      jobRecordSource: stringSchema(),
      qualityScore: numberSchema(0, 100),
      applicationNoteId: stringSchema(),
      candidateName: stringSchema(),
      school: stringSchema(),
      major: stringSchema(),
      degreeYear: stringSchema(),
      availabilityDays: stringSchema(),
      internshipDuration: stringSchema(),
      arrivalDate: stringSchema(),
      aiProductExperience: stringSchema(),
    },
    ["to", "subject"],
  );
}

function objectSchema(properties = {}, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
function stringSchema(description = "") {
  return { type: "string", ...(description ? { description } : {}) };
}
function booleanSchema() {
  return { type: "boolean" };
}
function integerSchema(minimum, maximum) {
  return { type: "integer", minimum, maximum };
}
function numberSchema(minimum, maximum) {
  return { type: "number", minimum, maximum };
}
function enumSchema(values) {
  return { type: "string", enum: values };
}
function arraySchema(items) {
  return { type: "array", items };
}

function comparable(value) {
  if (value === null || value === undefined || value === "")
    return Number.NEGATIVE_INFINITY;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const timestamp = Date.parse(
    typeof value === "object"
      ? firstString(value.iso, value.normalized, value.value)
      : String(value),
  );
  if (Number.isFinite(timestamp)) return timestamp;
  return normalizedText(value);
}

function normalizedScalar(value) {
  return typeof value === "string"
    ? value.trim().toLocaleLowerCase("zh-CN")
    : JSON.stringify(value);
}
function normalizedText(value) {
  return (
    typeof value === "string" ? value : JSON.stringify(value ?? "")
  ).toLocaleLowerCase("zh-CN");
}
function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
function validEmail(value, label) {
  if (!EMAIL.test(value))
    throw toolError("COPILOT_EMAIL_INVALID", `A valid ${label} is required.`);
  return value;
}
function validEmailList(value, label) {
  const emails = [...new Set(arrayOfStrings(value))];
  for (const email of emails) validEmail(email, label);
  return emails;
}
function firstString(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}
function previewValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : fallback;
}
function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}
function unavailable(name) {
  return toolError(
    "COPILOT_CAPABILITY_UNAVAILABLE",
    `${name} is unavailable.`,
    503,
  );
}
function cancelled() {
  return toolError("COPILOT_RUN_CANCELLED", "The run was cancelled.", 409);
}
function toolError(code, message, status) {
  return new DataToolError(code, message, status);
}
