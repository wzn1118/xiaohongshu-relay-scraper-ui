import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import Busboy from "busboy";

import {
  copilotHash,
  normalizeCopilotIdempotencyKey,
  normalizeCopilotReference,
  readCopilotJson,
  requiredCopilotId,
  resolveCopilotConversationDirectory,
  withCopilotFileLock,
  writeCopilotJsonAtomically,
} from "./data-copilot-store.mjs";

export const COPILOT_FILE_SCHEMA_VERSION = 1;
export const DEFAULT_COPILOT_ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxFiles: 40,
  maxTotalBytes: 100 * 1024 * 1024,
});
export const DEFAULT_COPILOT_ARTIFACT_LIMITS = Object.freeze({
  maxFileBytes: 50 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 256,
});

const XLSX_HELPER_PATH = fileURLToPath(
  new URL("../scripts/copilot_xlsx_helper.py", import.meta.url),
);
const ATTACHMENT_HELPER_PATH = fileURLToPath(
  new URL("../scripts/copilot_attachment_helper.py", import.meta.url),
);
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MANIFEST_FILE = "index.json";
const MAX_MULTIPART_FIELDS = 16;
const MAX_FIELD_BYTES = 8_192;
const MAX_HELPER_OUTPUT_BYTES = 2 * 1024 * 1024;

const ATTACHMENT_TYPES = Object.freeze({
  ".csv": {
    format: "csv",
    mediaType: "text/csv",
    acceptedMediaTypes: new Set([
      "text/csv",
      "application/csv",
      "application/vnd.ms-excel",
      "text/plain",
    ]),
  },
  ".json": {
    format: "json",
    mediaType: "application/json",
    acceptedMediaTypes: new Set(["application/json", "text/json"]),
  },
  ".txt": {
    format: "text",
    mediaType: "text/plain",
    acceptedMediaTypes: new Set(["text/plain"]),
  },
  ".md": {
    format: "markdown",
    mediaType: "text/markdown",
    acceptedMediaTypes: new Set(["text/markdown", "text/plain"]),
  },
  ".xlsx": {
    format: "xlsx",
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    acceptedMediaTypes: new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ]),
  },
  ".docx": {
    format: "docx",
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    acceptedMediaTypes: new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
    ]),
  },
  ".pdf": {
    format: "pdf",
    mediaType: "application/pdf",
    acceptedMediaTypes: new Set([
      "application/pdf",
      "application/octet-stream",
    ]),
  },
  ".png": {
    format: "image",
    mediaType: "image/png",
    acceptedMediaTypes: new Set(["image/png", "application/octet-stream"]),
  },
  ".jpg": {
    format: "image",
    mediaType: "image/jpeg",
    acceptedMediaTypes: new Set(["image/jpeg", "application/octet-stream"]),
  },
  ".jpeg": {
    format: "image",
    mediaType: "image/jpeg",
    acceptedMediaTypes: new Set(["image/jpeg", "application/octet-stream"]),
  },
  ".gif": {
    format: "image",
    mediaType: "image/gif",
    acceptedMediaTypes: new Set(["image/gif", "application/octet-stream"]),
  },
  ".webp": {
    format: "image",
    mediaType: "image/webp",
    acceptedMediaTypes: new Set(["image/webp", "application/octet-stream"]),
  },
});

const ARTIFACT_TYPES = Object.freeze({
  json: { extension: ".json", mediaType: "application/json" },
  csv: { extension: ".csv", mediaType: "text/csv" },
  markdown: { extension: ".md", mediaType: "text/markdown" },
  xlsx: {
    extension: ".xlsx",
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
});

export class CopilotArtifactError extends Error {
  constructor(code, message, status = 400, cause = undefined) {
    super(message);
    this.name = "CopilotArtifactError";
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/**
 * Owns files inside a persisted Data Copilot conversation. Public inventory
 * objects never disclose storage paths; resolve methods are server-internal.
 */
export class CopilotArtifactService {
  constructor({
    rootDir,
    attachmentLimits = {},
    artifactLimits = {},
    now = () => new Date(),
    idFactory = () => randomUUID(),
    pythonCommands = defaultPythonCommands(),
    xlsxHelperPath = XLSX_HELPER_PATH,
    attachmentHelperPath = ATTACHMENT_HELPER_PATH,
    helperTimeoutMs = 15_000,
  } = {}) {
    if (!String(rootDir || "").trim()) {
      throw artifactError(
        "COPILOT_FILE_ROOT_REQUIRED",
        "Data Copilot file root is required.",
      );
    }
    this.rootDir = path.resolve(rootDir);
    this.attachmentLimits = normalizeAttachmentLimits(attachmentLimits);
    this.artifactLimits = normalizeArtifactLimits(artifactLimits);
    this.now = now;
    this.idFactory = idFactory;
    this.pythonCommands = [
      ...new Set(pythonCommands.map(String).filter(Boolean)),
    ];
    this.xlsxHelperPath = path.resolve(xlsxHelperPath);
    this.attachmentHelperPath = path.resolve(attachmentHelperPath);
    this.helperTimeoutMs = boundedInteger(
      helperTimeoutMs,
      15_000,
      1_000,
      120_000,
    );
    this.xlsxProbe = null;
  }

  async uploadAttachment(reference, request, options = {}) {
    const upload = await readCopilotAttachmentUpload(
      request,
      this.attachmentLimits,
    );
    return this.createAttachment(reference, {
      ...options,
      ...upload.fields,
      file: upload.file,
    });
  }

  async createAttachment(reference, value = {}) {
    const context = await this.#conversation(reference);
    const file = normalizeUploadedFile(value.file, this.attachmentLimits);
    const detected = validateAttachment(file);
    const sha256 = hashBuffer(file.buffer);
    const idempotencyKey = normalizeCopilotIdempotencyKey(
      value.idempotencyKey || `upload:${sha256}`,
      "attachment idempotency key",
    );
    const requestHash = copilotHash({
      originalName: file.originalName,
      clientMediaType: file.clientMediaType,
      size: file.buffer.length,
      sha256,
    });
    const root = await ensureStorageRoot(context.directory, "attachments");

    return withCopilotFileLock(path.join(root, ".lock"), async () => {
      const manifest = await readFileManifest(root, "attachments");
      const byKey = manifest.items.find(
        (item) => item.idempotencyKey === idempotencyKey,
      );
      if (byKey) {
        if (byKey.requestHash !== requestHash) {
          throw artifactError(
            "COPILOT_ATTACHMENT_IDEMPOTENCY_CONFLICT",
            "Attachment idempotency key was already used for different content.",
            409,
          );
        }
        await verifyStoredRecord(root, byKey, "attachment");
        return {
          attachment: publicFileRecord(byKey),
          duplicate: true,
          revision: manifest.revision,
        };
      }

      const byHash = manifest.items.find(
        (item) => item.sha256 === sha256 && item.status === "ready",
      );
      if (byHash) {
        await verifyStoredRecord(root, byHash, "attachment");
        return {
          attachment: publicFileRecord(byHash),
          duplicate: true,
          revision: manifest.revision,
        };
      }
      if (manifest.items.length >= this.attachmentLimits.maxFiles) {
        throw artifactError(
          "COPILOT_ATTACHMENT_LIMIT_EXCEEDED",
          "Conversation attachment limit was reached.",
          413,
        );
      }
      const totalBytes = manifest.items.reduce(
        (sum, item) => sum + Number(item.size || 0),
        0,
      );
      if (
        totalBytes + file.buffer.length >
        this.attachmentLimits.maxTotalBytes
      ) {
        throw artifactError(
          "COPILOT_ATTACHMENT_TOTAL_TOO_LARGE",
          "Conversation attachments exceed the total size limit.",
          413,
        );
      }

      const attachmentId = requiredCopilotId(
        value.attachmentId || this.idFactory(),
        "attachment ID",
      );
      if (manifest.items.some((item) => item.attachmentId === attachmentId)) {
        throw artifactError(
          "COPILOT_ATTACHMENT_CONFLICT",
          "Attachment ID is already in use.",
          409,
        );
      }
      const relativePath = path.posix.join(
        "files",
        `${attachmentId}${detected.extension}`,
      );
      const absolutePath = resolveInside(root, relativePath);
      await writeBufferAtomically(absolutePath, file.buffer);
      const now = isoNow(this.now);
      const record = {
        schemaVersion: COPILOT_FILE_SCHEMA_VERSION,
        attachmentId,
        originalName: file.originalName,
        displayName: normalizeDownloadName(
          value.displayName || file.originalName,
          detected.extension,
        ),
        format: detected.format,
        extension: detected.extension.slice(1),
        mediaType: detected.mediaType,
        clientMediaType: file.clientMediaType,
        size: file.buffer.length,
        sha256,
        relativePath,
        status: "ready",
        idempotencyKey,
        requestHash,
        createdAt: now,
        updatedAt: now,
      };
      manifest.items.push(record);
      try {
        await persistManifest(root, manifest, this.now);
      } catch (error) {
        await rm(absolutePath, { force: true }).catch(() => {});
        throw error;
      }
      return {
        attachment: publicFileRecord(record),
        duplicate: false,
        revision: manifest.revision,
      };
    });
  }

  async listAttachments(reference) {
    const context = await this.#conversation(reference);
    const root = await ensureStorageRoot(context.directory, "attachments");
    const manifest = await readFileManifest(root, "attachments");
    return {
      schemaVersion: manifest.schemaVersion,
      revision: manifest.revision,
      attachments: manifest.items.map(publicFileRecord),
      limits: { ...this.attachmentLimits },
    };
  }

  async resolveAttachment(reference, attachmentId) {
    const context = await this.#conversation(reference);
    const id = requiredCopilotId(attachmentId, "attachment ID");
    const root = await ensureStorageRoot(context.directory, "attachments");
    const manifest = await readFileManifest(root, "attachments");
    const record = manifest.items.find(
      (item) => item.attachmentId === id && item.status === "ready",
    );
    if (!record)
      throw artifactError(
        "COPILOT_ATTACHMENT_NOT_FOUND",
        "Attachment was not found.",
        404,
      );
    const resolved = await verifyStoredRecord(root, record, "attachment");
    return {
      attachment: publicFileRecord(record),
      absolutePath: resolved.absolutePath,
    };
  }

  async parseAttachment(reference, attachmentId, options = {}) {
    const resolved = await this.resolveAttachment(reference, attachmentId);
    const buffer = await readFile(resolved.absolutePath);
    const maxRows = boundedInteger(options.maxRows, 500, 1, 10_000);
    const maxCharacters = boundedInteger(
      options.maxCharacters,
      200_000,
      1_000,
      2_000_000,
    );
    const { attachment } = resolved;

    if (attachment.format === "csv") {
      const parsed = parseCsv(decodeUtf8(buffer), {
        maxRows,
        maxColumns: this.artifactLimits.maxColumns,
      });
      return { attachment, parser: "native", ...parsed };
    }
    if (attachment.format === "json") {
      return {
        attachment,
        parser: "native",
        ...parseJsonAttachment(decodeUtf8(buffer), maxRows),
      };
    }
    if (attachment.format === "text" || attachment.format === "markdown") {
      const text = decodeUtf8(buffer);
      return {
        attachment,
        parser: "native",
        kind: attachment.format,
        text: text.slice(0, maxCharacters),
        characterCount: text.length,
        lineCount: text === "" ? 0 : text.split(/\r?\n/u).length,
        truncated: text.length > maxCharacters,
      };
    }
    if (attachment.format === "xlsx") {
      const probe = await this.probeXlsxSupport();
      if (!probe.available) {
        return {
          attachment,
          parser: "metadata_only",
          kind: "workbook",
          sheetNames: [],
          size: attachment.size,
          truncated: true,
          unavailableReason: probe.reason,
        };
      }
      const inspected = await this.#runXlsx("inspect", [
        resolved.absolutePath,
        String(maxRows),
      ]);
      return { attachment, parser: "openpyxl", ...inspected.value };
    }
    if (
      attachment.format === "docx" ||
      attachment.format === "pdf" ||
      attachment.format === "image"
    ) {
      const parsed = await this.#runAttachment([
        resolved.absolutePath,
        attachment.format,
        String(maxCharacters),
      ]);
      return { attachment, ...parsed.value };
    }
    throw artifactError(
      "COPILOT_ATTACHMENT_TYPE_NOT_ALLOWED",
      "Attachment format cannot be parsed.",
    );
  }

  async createArtifact(reference, value = {}) {
    const context = await this.#conversation(reference);
    const prepared = await this.#prepareArtifact(value);
    const idempotencyKey = normalizeCopilotIdempotencyKey(
      value.idempotencyKey || `artifact:${prepared.requestHash}`,
      "artifact idempotency key",
    );
    const root = await ensureStorageRoot(context.directory, "artifacts");

    return withCopilotFileLock(path.join(root, ".lock"), async () => {
      const manifest = await readFileManifest(root, "artifacts");
      const existing = manifest.items.find(
        (item) => item.idempotencyKey === idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== prepared.requestHash) {
          throw artifactError(
            "COPILOT_ARTIFACT_IDEMPOTENCY_CONFLICT",
            "Artifact idempotency key was already used for different output.",
            409,
          );
        }
        await verifyStoredRecord(root, existing, "artifact");
        return {
          artifact: publicFileRecord(existing),
          duplicate: true,
          revision: manifest.revision,
        };
      }

      const artifactId = requiredCopilotId(
        value.artifactId || this.idFactory(),
        "artifact ID",
      );
      if (manifest.items.some((item) => item.artifactId === artifactId)) {
        throw artifactError(
          "COPILOT_ARTIFACT_CONFLICT",
          "Artifact ID is already in use.",
          409,
        );
      }
      const relativePath = path.posix.join(
        "files",
        `${artifactId}${prepared.extension}`,
      );
      const absolutePath = resolveInside(root, relativePath);
      let buffer;
      if (prepared.format === "xlsx") {
        const probe = await this.probeXlsxSupport();
        if (!probe.available) {
          throw artifactError(
            "COPILOT_XLSX_UNAVAILABLE",
            "XLSX export requires Python with openpyxl.",
            503,
          );
        }
        await mkdir(path.dirname(absolutePath), { recursive: true });
        const temporary = `${absolutePath}.${process.pid}-${randomUUID()}.tmp`;
        try {
          await this.#runXlsx(
            "create",
            [temporary],
            JSON.stringify(prepared.table),
          );
          buffer = await readFile(temporary);
          validateXlsxSignature(buffer);
          if (buffer.length > this.artifactLimits.maxFileBytes) {
            throw artifactError(
              "COPILOT_ARTIFACT_TOO_LARGE",
              "Generated artifact exceeds the size limit.",
              413,
            );
          }
          await rename(temporary, absolutePath);
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
      } else {
        buffer = prepared.buffer;
        if (buffer.length > this.artifactLimits.maxFileBytes) {
          throw artifactError(
            "COPILOT_ARTIFACT_TOO_LARGE",
            "Generated artifact exceeds the size limit.",
            413,
          );
        }
        await writeBufferAtomically(absolutePath, buffer);
      }

      const now = isoNow(this.now);
      const record = {
        schemaVersion: COPILOT_FILE_SCHEMA_VERSION,
        artifactId,
        displayName: prepared.displayName,
        format: prepared.format,
        extension: prepared.extension.slice(1),
        mediaType: prepared.mediaType,
        size: buffer.length,
        sha256: hashBuffer(buffer),
        relativePath,
        status: "ready",
        idempotencyKey,
        requestHash: prepared.requestHash,
        rowCount: prepared.rowCount,
        columnCount: prepared.columnCount,
        source: prepared.source,
        sourceRecordIds: prepared.sourceRecordIds,
        sourceRecordCount: prepared.sourceRecordCount,
        query: prepared.query,
        sourceRunId: optionalFileId(value.sourceRunId),
        sourceToolRunId: optionalFileId(value.sourceToolRunId),
        createdAt: now,
        updatedAt: now,
      };
      manifest.items.push(record);
      try {
        await persistManifest(root, manifest, this.now);
      } catch (error) {
        await rm(absolutePath, { force: true }).catch(() => {});
        throw error;
      }
      return {
        artifact: publicFileRecord(record),
        duplicate: false,
        revision: manifest.revision,
      };
    });
  }

  async listArtifacts(reference) {
    const context = await this.#conversation(reference);
    const root = await ensureStorageRoot(context.directory, "artifacts");
    const manifest = await readFileManifest(root, "artifacts");
    return {
      schemaVersion: manifest.schemaVersion,
      revision: manifest.revision,
      artifacts: manifest.items.map(publicFileRecord),
    };
  }

  async resolveArtifact(reference, artifactId) {
    const context = await this.#conversation(reference);
    const id = requiredCopilotId(artifactId, "artifact ID");
    const root = await ensureStorageRoot(context.directory, "artifacts");
    const manifest = await readFileManifest(root, "artifacts");
    const record = manifest.items.find(
      (item) => item.artifactId === id && item.status === "ready",
    );
    if (!record)
      throw artifactError(
        "COPILOT_ARTIFACT_NOT_FOUND",
        "Artifact was not found.",
        404,
      );
    const resolved = await verifyStoredRecord(root, record, "artifact");
    return {
      artifact: publicFileRecord(record),
      absolutePath: resolved.absolutePath,
    };
  }

  async probeXlsxSupport({ refresh = false } = {}) {
    if (!refresh && this.xlsxProbe) return { ...this.xlsxProbe };
    try {
      const result = await this.#runXlsx("probe");
      this.xlsxProbe = {
        available: result.value?.available === true,
        version: String(result.value?.version || ""),
        command: result.command,
        reason: "",
      };
    } catch (error) {
      this.xlsxProbe = {
        available: false,
        version: "",
        command: "",
        reason:
          error.code === "COPILOT_XLSX_UNAVAILABLE"
            ? error.message
            : "XLSX helper could not start.",
      };
    }
    return { ...this.xlsxProbe };
  }

  async #conversation(reference) {
    const normalized = normalizeCopilotReference(reference);
    const directory = resolveCopilotConversationDirectory(
      this.rootDir,
      normalized,
    );
    const conversation = await readCopilotJson(
      path.join(directory, "conversation.json"),
      { allowMissing: true },
    );
    if (!conversation)
      throw artifactError(
        "COPILOT_CONVERSATION_NOT_FOUND",
        "Conversation was not found.",
        404,
      );
    if (
      conversation.conversationId !== normalized.conversationId ||
      conversation.jobId !== normalized.jobId ||
      conversation.snapshotId !== normalized.snapshotId ||
      conversation.mode !== normalized.mode ||
      conversation.scopeHash !== normalized.scopeHash
    ) {
      throw artifactError(
        "COPILOT_CONTEXT_MISMATCH",
        "Conversation context does not match the requested data scope.",
        409,
      );
    }
    return { normalized, directory };
  }

  async #prepareArtifact(value) {
    const format = normalizeArtifactFormat(value.format);
    const type = ARTIFACT_TYPES[format];
    const displayName = normalizeDownloadName(
      value.name || `data-copilot${type.extension}`,
      type.extension,
    );
    const provenance = normalizeArtifactProvenance(value);
    if (format === "json") {
      const content = value.content === undefined ? value.data : value.content;
      let encoded;
      try {
        encoded = `${JSON.stringify(content ?? null, null, 2)}\n`;
      } catch (error) {
        throw artifactError(
          "COPILOT_ARTIFACT_DATA_INVALID",
          "JSON artifact data is not serializable.",
          400,
          error,
        );
      }
      const buffer = Buffer.from(encoded, "utf8");
      return {
        format,
        ...type,
        displayName,
        buffer,
        ...provenance,
        rowCount: Array.isArray(content)
          ? content.length
          : content === undefined || content === null
            ? 0
            : 1,
        columnCount: null,
        requestHash: copilotHash({
          format,
          displayName,
          sha256: hashBuffer(buffer),
          provenance,
        }),
      };
    }
    if (
      format === "markdown" &&
      typeof (value.content ?? value.data) === "string"
    ) {
      const normalizedText = normalizeTextArtifact(value.content ?? value.data);
      const buffer = Buffer.from(normalizedText, "utf8");
      return {
        format,
        ...type,
        displayName,
        buffer,
        ...provenance,
        rowCount: normalizedText ? normalizedText.split("\n").length : 0,
        columnCount: null,
        requestHash: copilotHash({
          format,
          displayName,
          sha256: hashBuffer(buffer),
          provenance,
        }),
      };
    }
    const table = normalizeTable(
      value.data ?? value.content ?? value.rows,
      value.columns,
      this.artifactLimits,
    );
    if (format === "csv") {
      const buffer = Buffer.from(serializeCsv(table), "utf8");
      return {
        format,
        ...type,
        displayName,
        buffer,
        ...provenance,
        rowCount: table.rows.length,
        columnCount: table.columns.length,
        requestHash: copilotHash({ format, displayName, table, provenance }),
      };
    }
    if (format === "markdown") {
      const buffer = Buffer.from(serializeMarkdownTable(table), "utf8");
      return {
        format,
        ...type,
        displayName,
        buffer,
        ...provenance,
        rowCount: table.rows.length,
        columnCount: table.columns.length,
        requestHash: copilotHash({ format, displayName, table, provenance }),
      };
    }
    return {
      format,
      ...type,
      displayName,
      table,
      ...provenance,
      rowCount: table.rows.length,
      columnCount: table.columns.length,
      requestHash: copilotHash({ format, displayName, table, provenance }),
    };
  }

  async #runXlsx(command, args = [], stdin = "") {
    let lastError = null;
    for (const pythonCommand of this.pythonCommands) {
      try {
        const value = await runHelperProcess(
          pythonCommand,
          this.xlsxHelperPath,
          command,
          args,
          stdin,
          this.helperTimeoutMs,
        );
        return { value, command: pythonCommand };
      } catch (error) {
        lastError = error;
        if (
          error?.code !== "ENOENT" &&
          error?.code !== "COPILOT_XLSX_UNAVAILABLE"
        )
          throw error;
      }
    }
    throw artifactError(
      "COPILOT_XLSX_UNAVAILABLE",
      "Python with openpyxl is unavailable for XLSX processing.",
      503,
      lastError,
    );
  }

  async #runAttachment(args = []) {
    let lastError = null;
    for (const pythonCommand of this.pythonCommands) {
      try {
        const value = await runHelperProcess(
          pythonCommand,
          this.attachmentHelperPath,
          "parse",
          args,
          "",
          this.helperTimeoutMs,
          "ATTACHMENT",
        );
        return { value, command: pythonCommand };
      } catch (error) {
        lastError = error;
        if (
          error?.code !== "ENOENT" &&
          error?.code !== "COPILOT_ATTACHMENT_UNAVAILABLE"
        )
          throw error;
      }
    }
    throw artifactError(
      "COPILOT_ATTACHMENT_UNAVAILABLE",
      "Python is unavailable for document and image attachment processing.",
      503,
      lastError,
    );
  }
}

export async function readCopilotAttachmentUpload(
  request,
  limits = DEFAULT_COPILOT_ATTACHMENT_LIMITS,
) {
  const normalizedLimits = normalizeAttachmentLimits(limits);
  const contentType = String(request?.headers?.["content-type"] || "");
  if (!/^multipart\/form-data\s*;/iu.test(contentType)) {
    throw artifactError(
      "COPILOT_ATTACHMENT_MULTIPART_REQUIRED",
      "Upload must use multipart/form-data.",
    );
  }
  return new Promise((resolve, reject) => {
    let parser;
    let settled = false;
    let fileSeen = false;
    let fileValue = null;
    const fields = {};
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    try {
      parser = Busboy({
        headers: request.headers,
        defParamCharset: "utf8",
        limits: {
          files: 1,
          fields: MAX_MULTIPART_FIELDS,
          fieldSize: MAX_FIELD_BYTES,
          fileSize: normalizedLimits.maxFileBytes + 1,
          parts: MAX_MULTIPART_FIELDS + 2,
        },
      });
    } catch (error) {
      finish(
        artifactError(
          "COPILOT_ATTACHMENT_MULTIPART_INVALID",
          "Multipart upload is invalid.",
          400,
          error,
        ),
      );
      return;
    }
    parser.on("field", (name, value, info) => {
      if (info?.valueTruncated) {
        finish(
          artifactError(
            "COPILOT_ATTACHMENT_FIELD_TOO_LARGE",
            "Upload metadata is too large.",
            413,
          ),
        );
        return;
      }
      if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) fields[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      if (name !== "file" || fileSeen) {
        stream.resume();
        finish(
          artifactError(
            "COPILOT_ATTACHMENT_LIMIT_EXCEEDED",
            "Exactly one attachment is allowed per upload.",
          ),
        );
        return;
      }
      fileSeen = true;
      const chunks = [];
      let size = 0;
      let exceeded = false;
      stream.on("limit", () => {
        exceeded = true;
      });
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size <= normalizedLimits.maxFileBytes) chunks.push(chunk);
      });
      stream.on("error", (error) => {
        finish(
          artifactError(
            "COPILOT_ATTACHMENT_MULTIPART_INVALID",
            "Attachment stream failed.",
            400,
            error,
          ),
        );
      });
      stream.on("end", () => {
        if (exceeded || size > normalizedLimits.maxFileBytes) {
          finish(
            artifactError(
              "COPILOT_ATTACHMENT_TOO_LARGE",
              "Attachment exceeds the file size limit.",
              413,
            ),
          );
          return;
        }
        fileValue = {
          originalName: info.filename,
          clientMediaType: info.mimeType,
          buffer: Buffer.concat(chunks),
        };
      });
    });
    parser.on("filesLimit", () =>
      finish(
        artifactError(
          "COPILOT_ATTACHMENT_LIMIT_EXCEEDED",
          "Only one attachment is allowed per upload.",
        ),
      ),
    );
    parser.on("fieldsLimit", () =>
      finish(
        artifactError(
          "COPILOT_ATTACHMENT_MULTIPART_INVALID",
          "Upload contains too many fields.",
        ),
      ),
    );
    parser.on("partsLimit", () =>
      finish(
        artifactError(
          "COPILOT_ATTACHMENT_MULTIPART_INVALID",
          "Upload contains too many parts.",
        ),
      ),
    );
    parser.on("error", (error) =>
      finish(
        artifactError(
          "COPILOT_ATTACHMENT_MULTIPART_INVALID",
          "Multipart upload is invalid.",
          400,
          error,
        ),
      ),
    );
    parser.on("close", () => {
      if (!fileValue) {
        finish(
          artifactError(
            "COPILOT_ATTACHMENT_EMPTY",
            "Attachment file is required.",
          ),
        );
        return;
      }
      finish(null, { fields, file: fileValue });
    });
    request.pipe(parser);
  });
}

function normalizeUploadedFile(file, limits) {
  const originalName = normalizeOriginalName(file?.originalName);
  const clientMediaType = String(file?.clientMediaType || "")
    .toLowerCase()
    .split(";", 1)[0]
    .trim();
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw artifactError("COPILOT_ATTACHMENT_EMPTY", "Attachment is empty.");
  }
  if (buffer.length > limits.maxFileBytes) {
    throw artifactError(
      "COPILOT_ATTACHMENT_TOO_LARGE",
      "Attachment exceeds the file size limit.",
      413,
    );
  }
  return { originalName, clientMediaType, buffer };
}

function validateAttachment(file) {
  const extension = path.extname(file.originalName).toLowerCase();
  const type = ATTACHMENT_TYPES[extension];
  if (!type)
    throw artifactError(
      "COPILOT_ATTACHMENT_TYPE_NOT_ALLOWED",
      "Attachment type is not allowed.",
    );
  if (!type.acceptedMediaTypes.has(file.clientMediaType)) {
    throw artifactError(
      "COPILOT_ATTACHMENT_MIME_MISMATCH",
      "Attachment MIME type does not match its extension.",
    );
  }
  if (extension === ".xlsx") validateXlsxSignature(file.buffer);
  else if (extension === ".docx") validateDocxSignature(file.buffer);
  else if (extension === ".pdf") validatePdfSignature(file.buffer);
  else if (type.format === "image")
    validateImageSignature(file.buffer, extension);
  else {
    const text = decodeUtf8(file.buffer);
    if (extension === ".json") {
      try {
        JSON.parse(stripBom(text));
      } catch (error) {
        throw artifactError(
          "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
          "JSON attachment is malformed.",
          400,
          error,
        );
      }
    }
  }
  return { ...type, extension };
}

function validateDocxSignature(buffer) {
  const zip =
    buffer.length >= 22 &&
    buffer.subarray(0, 4).equals(Buffer.from("504b0304", "hex")) &&
    buffer.includes(Buffer.from("[Content_Types].xml")) &&
    buffer.includes(Buffer.from("word/"));
  if (!zip) {
    throw artifactError(
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
      "DOCX attachment signature is invalid.",
    );
  }
}

function validatePdfSignature(buffer) {
  if (
    buffer.length < 8 ||
    !buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))
  ) {
    throw artifactError(
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
      "PDF attachment signature is invalid.",
    );
  }
}

function validateImageSignature(buffer, extension) {
  const signatures = {
    ".png":
      buffer.length >= 24 &&
      buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    ".jpg":
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[buffer.length - 2] === 0xff &&
      buffer[buffer.length - 1] === 0xd9,
    ".jpeg":
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[buffer.length - 2] === 0xff &&
      buffer[buffer.length - 1] === 0xd9,
    ".gif":
      buffer.length >= 10 &&
      ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii")),
    ".webp":
      buffer.length >= 16 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP",
  };
  if (!signatures[extension]) {
    throw artifactError(
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
      "Image attachment signature is invalid.",
    );
  }
}

function validateXlsxSignature(buffer) {
  const zip =
    buffer.length >= 22 &&
    buffer.subarray(0, 4).equals(Buffer.from("504b0304", "hex")) &&
    buffer.includes(Buffer.from("[Content_Types].xml")) &&
    buffer.includes(Buffer.from("xl/"));
  if (!zip) {
    throw artifactError(
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
      "XLSX attachment signature is invalid.",
    );
  }
}

function decodeUtf8(buffer) {
  if (buffer.includes(0)) {
    throw artifactError(
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
      "Text attachment contains binary data.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw artifactError(
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
      "Text attachment must be valid UTF-8.",
      400,
      error,
    );
  }
}

function parseCsv(text, { maxRows, maxColumns }) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const input = stripBom(text);
  while (index < input.length) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') {
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (quoted)
    throw artifactError(
      "COPILOT_ATTACHMENT_PARSE_FAILED",
      "CSV attachment contains an unterminated quoted field.",
    );
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const columns = (rows.shift() || [])
    .slice(0, maxColumns)
    .map((value, columnIndex) => value || `column_${columnIndex + 1}`);
  const dataRows = rows
    .slice(0, maxRows)
    .map((values) =>
      Object.fromEntries(
        columns.map((column, columnIndex) => [
          column,
          values[columnIndex] ?? "",
        ]),
      ),
    );
  return {
    kind: "table",
    columns,
    rows: dataRows,
    rowCount: rows.length,
    columnCount: columns.length,
    truncated: rows.length > maxRows || (rows[0]?.length || 0) > maxColumns,
  };
}

function parseJsonAttachment(text, maxRows) {
  let value;
  try {
    value = JSON.parse(stripBom(text));
  } catch (error) {
    throw artifactError(
      "COPILOT_ATTACHMENT_PARSE_FAILED",
      "JSON attachment is malformed.",
      400,
      error,
    );
  }
  if (Array.isArray(value)) {
    return {
      kind: "json_array",
      value: value.slice(0, maxRows),
      itemCount: value.length,
      truncated: value.length > maxRows,
    };
  }
  if (value && typeof value === "object") {
    return {
      kind: "json_object",
      value,
      keys: Object.keys(value),
      truncated: false,
    };
  }
  return { kind: "json_scalar", value, truncated: false };
}

function normalizeArtifactProvenance(value) {
  const rawSources = Array.isArray(value.source)
    ? value.source
    : [value.source];
  const source = [
    ...new Set(
      rawSources
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .map((item) => {
          let parsed;
          try {
            parsed = new URL(item);
          } catch (error) {
            throw artifactError(
              "COPILOT_ARTIFACT_SOURCE_INVALID",
              "Artifact source must be an xhs-data resource URI.",
              400,
              error,
            );
          }
          if (parsed.protocol !== "xhs-data:") {
            throw artifactError(
              "COPILOT_ARTIFACT_SOURCE_INVALID",
              "Artifact source must be an xhs-data resource URI.",
            );
          }
          return parsed.toString();
        }),
    ),
  ].slice(0, 20);
  const sourceRecordIds = [
    ...new Set(
      (Array.isArray(value.sourceRecordIds) ? value.sourceRecordIds : [])
        .map((item) =>
          String(item || "")
            .trim()
            .slice(0, 240),
        )
        .filter(Boolean),
    ),
  ].slice(0, 500);
  const requestedRecordCount = Number(value.sourceRecordCount);
  const sourceRecordCount =
    Number.isSafeInteger(requestedRecordCount) &&
    requestedRecordCount >= sourceRecordIds.length
      ? requestedRecordCount
      : sourceRecordIds.length;
  let query = null;
  if (value.query !== undefined && value.query !== null) {
    let encoded;
    try {
      encoded = JSON.stringify(value.query);
    } catch (error) {
      throw artifactError(
        "COPILOT_ARTIFACT_QUERY_INVALID",
        "Artifact query provenance is not serializable.",
        400,
        error,
      );
    }
    if (Buffer.byteLength(encoded, "utf8") > 16_384) {
      throw artifactError(
        "COPILOT_ARTIFACT_QUERY_INVALID",
        "Artifact query provenance exceeds the size limit.",
        413,
      );
    }
    query = JSON.parse(encoded);
  }
  return { source, sourceRecordIds, sourceRecordCount, query };
}

function normalizeTable(value, suppliedColumns, limits) {
  let rows = value;
  let columns = suppliedColumns;
  let sheetName = "Data";
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(value.rows)
  ) {
    rows = value.rows;
    columns = columns ?? value.columns;
    sheetName = normalizeSheetName(value.sheetName || sheetName);
  }
  if (!Array.isArray(rows))
    throw artifactError(
      "COPILOT_ARTIFACT_DATA_INVALID",
      "Tabular artifact data must contain an array of rows.",
    );
  if (rows.length > limits.maxRows)
    throw artifactError(
      "COPILOT_ARTIFACT_ROWS_EXCEEDED",
      "Artifact contains too many rows.",
      413,
    );

  if (!Array.isArray(columns)) {
    if (
      rows.every((row) => row && typeof row === "object" && !Array.isArray(row))
    ) {
      const seen = new Set();
      columns = [];
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          if (!seen.has(key)) {
            seen.add(key);
            columns.push(key);
          }
        }
      }
    } else {
      const width = rows.reduce(
        (maximum, row) =>
          Math.max(maximum, Array.isArray(row) ? row.length : 1),
        0,
      );
      columns = Array.from(
        { length: width },
        (_, index) => `column_${index + 1}`,
      );
    }
  }
  columns = columns.map((column, index) =>
    normalizeCell(column || `column_${index + 1}`),
  );
  if (columns.length > limits.maxColumns)
    throw artifactError(
      "COPILOT_ARTIFACT_COLUMNS_EXCEEDED",
      "Artifact contains too many columns.",
      413,
    );
  if (new Set(columns).size !== columns.length)
    throw artifactError(
      "COPILOT_ARTIFACT_DATA_INVALID",
      "Artifact column names must be unique.",
    );

  const normalizedRows = rows.map((row) => {
    if (Array.isArray(row))
      return columns.map((_, index) => normalizeCell(row[index]));
    if (row && typeof row === "object")
      return columns.map((column) => normalizeCell(row[column]));
    return [normalizeCell(row), ...columns.slice(1).map(() => "")];
  });
  return { sheetName, columns, rows: normalizedRows };
}

function serializeCsv(table) {
  const records = [table.columns, ...table.rows];
  return `\ufeff${records.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function csvCell(value) {
  const safe = guardSpreadsheetFormula(value);
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function serializeMarkdownTable(table) {
  const header = `| ${table.columns.map(markdownCell).join(" | ")} |`;
  const separator = `| ${table.columns.map(() => "---").join(" | ")} |`;
  const body = table.rows.map(
    (row) => `| ${row.map(markdownCell).join(" | ")} |`,
  );
  return `${[header, separator, ...body].join("\n")}\n`;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\r?\n/gu, "<br>");
}

function normalizeCell(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function guardSpreadsheetFormula(value) {
  const text = String(value);
  return /^[\t\r ]*[=+@-]/u.test(text) ? `'${text}` : text;
}

async function readFileManifest(root, kind) {
  const filePath = path.join(root, MANIFEST_FILE);
  const manifest = await readCopilotJson(filePath, { allowMissing: true });
  if (!manifest)
    return {
      schemaVersion: COPILOT_FILE_SCHEMA_VERSION,
      kind,
      revision: 0,
      updatedAt: null,
      items: [],
    };
  if (
    manifest.schemaVersion !== COPILOT_FILE_SCHEMA_VERSION ||
    manifest.kind !== kind ||
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 0 ||
    !Array.isArray(manifest.items)
  ) {
    throw artifactError(
      "COPILOT_FILE_MANIFEST_INVALID",
      `${kind} manifest is invalid.`,
      500,
    );
  }
  for (const item of manifest.items) validateStoredRecord(item, kind);
  return manifest;
}

async function persistManifest(root, manifest, now) {
  manifest.revision += 1;
  manifest.updatedAt = isoNow(now);
  await writeCopilotJsonAtomically(path.join(root, MANIFEST_FILE), manifest);
}

async function verifyStoredRecord(root, record, kind) {
  validateStoredRecord(record, kind);
  const absolutePath = resolveInside(root, record.relativePath);
  let details;
  try {
    details = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT")
      throw artifactError(
        `COPILOT_${kind.toUpperCase()}_NOT_FOUND`,
        `${capitalize(kind)} file is missing.`,
        404,
      );
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw artifactError(
      "COPILOT_FILE_INTEGRITY_FAILED",
      `${capitalize(kind)} storage entry is invalid.`,
      409,
    );
  }
  const realRoot = await ensureRealDirectory(root);
  const realTarget = await realpath(absolutePath);
  assertInside(realRoot, realTarget);
  const buffer = await readFile(realTarget);
  if (buffer.length !== record.size || hashBuffer(buffer) !== record.sha256) {
    throw artifactError(
      "COPILOT_FILE_INTEGRITY_FAILED",
      `${capitalize(kind)} failed integrity validation.`,
      409,
    );
  }
  return { absolutePath: realTarget, size: buffer.length };
}

function validateStoredRecord(record, kind) {
  const singularKind =
    kind === "attachments"
      ? "attachment"
      : kind === "artifacts"
        ? "artifact"
        : kind;
  const idKey = singularKind === "attachment" ? "attachmentId" : "artifactId";
  if (
    !record ||
    typeof record !== "object" ||
    !FILE_ID.test(String(record[idKey] || "")) ||
    !SHA256.test(String(record.sha256 || "")) ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    typeof record.relativePath !== "string" ||
    record.status !== "ready"
  ) {
    throw artifactError(
      "COPILOT_FILE_MANIFEST_INVALID",
      `${capitalize(singularKind)} manifest record is invalid.`,
      500,
    );
  }
  resolveInside(".", record.relativePath);
}

function publicFileRecord(record) {
  const {
    relativePath: _relativePath,
    idempotencyKey: _idempotencyKey,
    requestHash: _requestHash,
    ...publicRecord
  } = record;
  return { ...publicRecord };
}

async function writeBufferAtomically(target, buffer) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function resolveInside(root, relativePath) {
  const portable = String(relativePath || "").replaceAll("\\", "/");
  if (
    !portable ||
    portable.includes("\0") ||
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/u.test(portable)
  ) {
    throw artifactError(
      "COPILOT_FILE_PATH_INVALID",
      "Stored file path is invalid.",
      409,
    );
  }
  const normalized = path.posix.normalize(portable);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw artifactError(
      "COPILOT_FILE_PATH_INVALID",
      "Stored file path escapes the conversation.",
      409,
    );
  }
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...normalized.split("/"));
  assertInside(absoluteRoot, target);
  return target;
}

function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (
    relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  )
    return;
  throw artifactError(
    "COPILOT_FILE_PATH_INVALID",
    "Stored file path escapes the conversation.",
    409,
  );
}

async function ensureRealDirectory(directory) {
  await mkdir(directory, { recursive: true });
  return realpath(directory);
}

async function ensureStorageRoot(conversationDirectory, name) {
  const root = path.join(conversationDirectory, name);
  await mkdir(root, { recursive: true });
  const details = await lstat(root);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw artifactError(
      "COPILOT_FILE_PATH_INVALID",
      "Conversation file storage root is invalid.",
      409,
    );
  }
  const [realConversation, realRoot] = await Promise.all([
    realpath(conversationDirectory),
    realpath(root),
  ]);
  assertInside(realConversation, realRoot);
  return realRoot;
}

async function runHelperProcess(
  pythonCommand,
  helperPath,
  command,
  args,
  stdin,
  timeoutMs,
  helperKind = "XLSX",
) {
  const prefix =
    helperKind === "ATTACHMENT" ? "COPILOT_ATTACHMENT" : "COPILOT_XLSX";
  const label = helperKind === "ATTACHMENT" ? "Attachment" : "XLSX";
  let child;
  try {
    child = spawn(pythonCommand, ["-B", helperPath, command, ...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw error;
  }
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputExceeded = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        artifactError(`${prefix}_TIMEOUT`, `${label} helper timed out.`, 504),
      );
    }, timeoutMs);
    child.once("error", (error) => finish(error));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.once("close", (code) => {
      if (outputExceeded) {
        finish(
          artifactError(
            `${prefix}_HELPER_FAILED`,
            `${label} helper returned too much output.`,
            500,
          ),
        );
        return;
      }
      if (code !== 0) {
        const unavailable = code === 3;
        finish(
          artifactError(
            unavailable ? `${prefix}_UNAVAILABLE` : `${prefix}_HELPER_FAILED`,
            unavailable
              ? `${label} helper dependencies are unavailable.`
              : `${label} helper failed${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : "."}`,
            unavailable ? 503 : 500,
          ),
        );
        return;
      }
      try {
        finish(null, stdout.trim() ? JSON.parse(stdout) : {});
      } catch (error) {
        finish(
          artifactError(
            `${prefix}_HELPER_FAILED`,
            `${label} helper returned invalid output.`,
            500,
            error,
          ),
        );
      }
    });
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") finish(error);
    });
    child.stdin.end(stdin, "utf8");
  });
}

function normalizeOriginalName(value) {
  const name = String(value || "")
    .normalize("NFC")
    .trim();
  if (
    !name ||
    name !== path.basename(name) ||
    name !== path.win32.basename(name) ||
    /[\p{Cc}<>:"/\\|?*]/u.test(name)
  ) {
    throw artifactError(
      "COPILOT_ATTACHMENT_PATH_INVALID",
      "Attachment filename is invalid.",
    );
  }
  const normalized = name.replace(/[. ]+$/u, "").slice(0, 180);
  if (!normalized || !path.extname(normalized)) {
    throw artifactError(
      "COPILOT_ATTACHMENT_TYPE_NOT_ALLOWED",
      "Attachment type is not allowed.",
    );
  }
  return normalized;
}

function normalizeDownloadName(value, extension) {
  const name = String(value || "")
    .normalize("NFC")
    .trim();
  if (
    !name ||
    name !== path.basename(name) ||
    name !== path.win32.basename(name) ||
    /[\p{Cc}<>:"/\\|?*]/u.test(name)
  ) {
    throw artifactError(
      "COPILOT_FILE_PATH_INVALID",
      "Download filename is invalid.",
    );
  }
  const trimmed = name.replace(/[. ]+$/u, "").slice(0, 180);
  return path.extname(trimmed).toLowerCase() === extension
    ? trimmed
    : `${trimmed}${extension}`;
}

function normalizeTextArtifact(value) {
  const text = String(value).replaceAll("\0", "");
  return text.endsWith("\n") ? text : `${text}\n`;
}

function normalizeArtifactFormat(value) {
  const format = String(value || "").toLowerCase();
  if (!ARTIFACT_TYPES[format]) {
    throw artifactError(
      "COPILOT_ARTIFACT_FORMAT_NOT_ALLOWED",
      "Artifact format must be json, csv, markdown, or xlsx.",
    );
  }
  return format;
}

function normalizeAttachmentLimits(value = {}) {
  return {
    maxFileBytes: boundedInteger(
      value.maxFileBytes,
      DEFAULT_COPILOT_ATTACHMENT_LIMITS.maxFileBytes,
      1_024,
      128 * 1024 * 1024,
    ),
    maxFiles: boundedInteger(
      value.maxFiles,
      DEFAULT_COPILOT_ATTACHMENT_LIMITS.maxFiles,
      1,
      1_000,
    ),
    maxTotalBytes: boundedInteger(
      value.maxTotalBytes,
      DEFAULT_COPILOT_ATTACHMENT_LIMITS.maxTotalBytes,
      1_024,
      1024 * 1024 * 1024,
    ),
  };
}

function normalizeArtifactLimits(value = {}) {
  return {
    maxFileBytes: boundedInteger(
      value.maxFileBytes,
      DEFAULT_COPILOT_ARTIFACT_LIMITS.maxFileBytes,
      1_024,
      512 * 1024 * 1024,
    ),
    maxRows: boundedInteger(
      value.maxRows,
      DEFAULT_COPILOT_ARTIFACT_LIMITS.maxRows,
      1,
      1_000_000,
    ),
    maxColumns: boundedInteger(
      value.maxColumns,
      DEFAULT_COPILOT_ARTIFACT_LIMITS.maxColumns,
      1,
      16_384,
    ),
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function normalizeSheetName(value) {
  const normalized = String(value || "Data")
    .replace(/[\\/*?:[\]]/gu, "")
    .trim()
    .slice(0, 31);
  return normalized || "Data";
}

function optionalFileId(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (!FILE_ID.test(text))
    throw artifactError("COPILOT_FILE_ID_INVALID", "Source ID is invalid.");
  return text;
}

function defaultPythonCommands() {
  return [
    process.env.PYTHON,
    process.platform === "win32" ? "python" : "python3",
    "python",
  ].filter(Boolean);
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isoNow(now) {
  const date = now();
  const timestamp = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(timestamp.getTime()))
    throw artifactError(
      "COPILOT_FILE_CLOCK_INVALID",
      "Data Copilot file clock is invalid.",
      500,
    );
  return timestamp.toISOString();
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function artifactError(code, message, status = 400, cause = undefined) {
  return new CopilotArtifactError(code, message, status, cause);
}
