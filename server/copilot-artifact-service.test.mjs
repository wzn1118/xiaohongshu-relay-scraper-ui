import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { DataCopilotStore } from "./data-copilot-store.mjs";
import {
  CopilotArtifactError,
  CopilotArtifactService,
  readCopilotAttachmentUpload,
} from "./copilot-artifact-service.mjs";

const REFERENCE = Object.freeze({
  conversationId: "conversation-artifacts-001",
  jobId: "job-artifacts-001",
  snapshotId: "snapshot-artifacts-001",
  mode: "research",
  scope: ["content:read", "artifact:write"],
});

const DOCX_FIXTURE = Buffer.from(
  "UEsDBBQAAAAIADI2Al0G8pnQggAAAKEAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbCWOSQ7CMAxFrxJlTx1YsEBJuqDcgAtYkTuITEoMKrcnoUv7/e9nPe7Biw+VuqVo5HlQcrT6+c1URSOxGrky5xtAdSsFrEPKFBuZUwnIbSwLZHQvXAguSl3BpcgU+cT9hrR6ohnfnsVjb+vD0upS3I9cVxmJOfvNITcMnYLV8H/C/gBQSwMEFAAAAAgAMjYCXeeXN42rAAAAAAEAABEAAAB3b3JkL2RvY3VtZW50LnhtbG2PQQrCMBBFrxKyt6kuREpbF4oXUA8wJrEpNJkwGa3e3kQQQdy8Yfjz/2fa7cNP4m4pjRg6uaxqKWzQaMYwdPJ8Oiw2ctu3c2NQ37wNLPJ9SM3cScccG6WSdtZDqjDakLUrkgfOKw1qRjKRUNuUcpyf1Kqu18rDGGSJvKB5lhkLqID7PTCIHcZxQhbADNqV1lYVsZDejL++o9UYjIhAMBBE98egPo3q+03/AlBLAQIUABQAAAAIADI2Al0G8pnQggAAAKEAAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAgAMjYCXeeXN42rAAAAAAEAABEAAAAAAAAAAAAAAIABswAAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAACAAIAgAAAAI0BAAAAAA==",
  "base64",
);
const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGNkaGBgYGBgAhFwCgAJ1ACGLEmEsAAAAABJRU5ErkJggg==",
  "base64",
);
const PDF_FIXTURE = Buffer.from(
  "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgKHB5cGRmKQo+PgplbmRvYmoKMiAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWyA0IDAgUiBdCj4+CmVuZG9iagozIDAgb2JqCjw8Ci9UeXBlIC9DYXRhbG9nCi9QYWdlcyAyIDAgUgo+PgplbmRvYmoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUmVzb3VyY2VzIDw8Cj4+Ci9NZWRpYUJveCBbIDAuMCAwLjAgNzIgNzIgXQovUGFyZW50IDIgMCBSCj4+CmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTEzIDAwMDAwIG4gCjAwMDAwMDAxNjIgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA1Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCj4+CnN0YXJ0eHJlZgoyNTQKJSVFT0YK",
  "base64",
);

async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "xhs-copilot-files-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new DataCopilotStore({ rootDir });
  await store.createConversation({
    ...REFERENCE,
    title: "Artifact fixture",
    idempotencyKey: "conversation-create-001",
  });
  const service = new CopilotArtifactService({ rootDir, ...options });
  return { rootDir, store, service };
}

function upload(name, mediaType, content) {
  return {
    file: {
      originalName: name,
      clientMediaType: mediaType,
      buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
    },
  };
}

function multipartRequest(filename, mediaType, buffer, fields = {}) {
  const boundary = `----copilot-${randomUUID()}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`,
      "utf8",
    ),
  );
  chunks.push(buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  const request = Readable.from(Buffer.concat(chunks));
  request.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
  return request;
}

test("multipart upload persists a validated CSV and exposes parsed rows without storage paths", async (t) => {
  const { service } = await fixture(t);
  const csv = Buffer.from(
    '\ufeffname,city\r\n"Lin, Mei",Shanghai\r\nKai,Beijing\r\n',
    "utf8",
  );
  const request = multipartRequest("audience.csv", "text/csv", csv, {
    idempotencyKey: "upload-request-001",
  });

  const created = await service.uploadAttachment(REFERENCE, request);
  assert.equal(created.duplicate, false);
  assert.equal(created.attachment.format, "csv");
  assert.equal(created.attachment.sha256.length, 64);
  assert.equal(Object.hasOwn(created.attachment, "relativePath"), false);

  const parsed = await service.parseAttachment(
    REFERENCE,
    created.attachment.attachmentId,
  );
  assert.deepEqual(parsed.columns, ["name", "city"]);
  assert.deepEqual(parsed.rows, [
    { name: "Lin, Mei", city: "Shanghai" },
    { name: "Kai", city: "Beijing" },
  ]);
  assert.equal(parsed.rowCount, 2);
  assert.equal(parsed.truncated, false);

  const listed = await service.listAttachments(REFERENCE);
  assert.equal(listed.revision, 1);
  assert.equal(listed.attachments.length, 1);
  assert.equal(Object.hasOwn(listed.attachments[0], "relativePath"), false);
});

test("attachment validation rejects traversal, MIME mismatch, malformed JSON, binary text, and oversize data", async (t) => {
  const { service } = await fixture(t, {
    attachmentLimits: { maxFileBytes: 1024, maxFiles: 5, maxTotalBytes: 4096 },
  });
  const cases = [
    [
      upload("../data.csv", "text/csv", "a\n1\n"),
      "COPILOT_ATTACHMENT_PATH_INVALID",
    ],
    [
      upload("data.csv", "application/json", "a\n1\n"),
      "COPILOT_ATTACHMENT_MIME_MISMATCH",
    ],
    [
      upload("data.json", "application/json", "{bad"),
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
    ],
    [
      upload("data.txt", "text/plain", Buffer.from([65, 0, 66])),
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
    ],
    [
      upload("data.txt", "text/plain", Buffer.alloc(1025, 65)),
      "COPILOT_ATTACHMENT_TOO_LARGE",
    ],
    [
      upload("data.pdf", "application/pdf", "not a pdf"),
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
    ],
    [
      upload(
        "data.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "not a docx",
      ),
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
    ],
    [
      upload("data.png", "image/png", "not an image"),
      "COPILOT_ATTACHMENT_SIGNATURE_MISMATCH",
    ],
    [
      upload("data.exe", "application/octet-stream", "test"),
      "COPILOT_ATTACHMENT_TYPE_NOT_ALLOWED",
    ],
  ];
  for (const [value, code] of cases) {
    await assert.rejects(
      service.createAttachment(REFERENCE, value),
      (error) => {
        assert.ok(error instanceof CopilotArtifactError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

test("DOCX and image attachments are signature-checked and parsed in the isolated helper", async (t) => {
  const { service } = await fixture(t);
  const document = await service.createAttachment(REFERENCE, {
    ...upload(
      "brief.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      DOCX_FIXTURE,
    ),
    idempotencyKey: "upload-docx-001",
  });
  const parsedDocument = await service.parseAttachment(
    REFERENCE,
    document.attachment.attachmentId,
  );
  assert.equal(parsedDocument.parser, "python-stdlib-docx");
  assert.equal(
    parsedDocument.text,
    "Data Copilot attachment\nSecond paragraph",
  );
  assert.equal(parsedDocument.paragraphCount, 2);

  const image = await service.createAttachment(REFERENCE, {
    ...upload("evidence.png", "image/png", PNG_FIXTURE),
    idempotencyKey: "upload-image-001",
  });
  const parsedImage = await service.parseAttachment(
    REFERENCE,
    image.attachment.attachmentId,
  );
  assert.equal(parsedImage.kind, "image");
  if (parsedImage.parser === "pillow") {
    assert.equal(parsedImage.width, 2);
    assert.equal(parsedImage.height, 3);
  } else {
    assert.equal(parsedImage.parser, "metadata_only");
    assert.match(parsedImage.unavailableReason, /Pillow/u);
  }

  const pdf = await service.createAttachment(REFERENCE, {
    ...upload("evidence.pdf", "application/pdf", PDF_FIXTURE),
    idempotencyKey: "upload-pdf-001",
  });
  const parsedPdf = await service.parseAttachment(
    REFERENCE,
    pdf.attachment.attachmentId,
  );
  assert.equal(parsedPdf.kind, "pdf");
  if (parsedPdf.parser === "pypdf") assert.equal(parsedPdf.pageCount, 1);
  else assert.equal(parsedPdf.parser, "metadata_only");
});

test("multipart reader enforces content type, one-file semantics, and the byte limit", async () => {
  const csv = Buffer.from("name\nMei\n", "utf8");
  const request = multipartRequest("data.csv", "text/csv", csv, {
    source: "fixture",
  });
  const parsed = await readCopilotAttachmentUpload(request, {
    maxFileBytes: 1024,
    maxFiles: 3,
    maxTotalBytes: 4096,
  });
  assert.equal(parsed.fields.source, "fixture");
  assert.equal(parsed.file.originalName, "data.csv");
  assert.deepEqual(parsed.file.buffer, csv);

  const plain = Readable.from("not multipart");
  plain.headers = { "content-type": "text/plain" };
  await assert.rejects(
    readCopilotAttachmentUpload(plain),
    (error) => error.code === "COPILOT_ATTACHMENT_MULTIPART_REQUIRED",
  );

  const tooLarge = multipartRequest(
    "data.txt",
    "text/plain",
    Buffer.alloc(1025, 65),
  );
  await assert.rejects(
    readCopilotAttachmentUpload(tooLarge, {
      maxFileBytes: 1024,
      maxFiles: 3,
      maxTotalBytes: 4096,
    }),
    (error) => error.code === "COPILOT_ATTACHMENT_TOO_LARGE",
  );
});

test("JSON, CSV, and Markdown artifacts are contained, checksummed, and idempotent", async (t) => {
  const { service } = await fixture(t);
  const table = {
    columns: ["name", "formula"],
    rows: [
      { name: "Mei", formula: "=1+1" },
      { name: "Kai", formula: "plain" },
    ],
  };
  const csv = await service.createArtifact(REFERENCE, {
    format: "csv",
    name: "candidates.csv",
    data: table,
    source: "xhs-data://jobs/job-artifacts-001/content",
    sourceRecordIds: ["note-001", "note-002"],
    sourceRecordCount: 2,
    query: {
      dataset: "content",
      query: "Shanghai",
      sortBy: "publishedAt",
      direction: "desc",
    },
    idempotencyKey: "artifact-create-csv-001",
  });
  const duplicate = await service.createArtifact(REFERENCE, {
    format: "csv",
    name: "candidates.csv",
    data: table,
    source: "xhs-data://jobs/job-artifacts-001/content",
    sourceRecordIds: ["note-001", "note-002"],
    sourceRecordCount: 2,
    query: {
      dataset: "content",
      query: "Shanghai",
      sortBy: "publishedAt",
      direction: "desc",
    },
    idempotencyKey: "artifact-create-csv-001",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.artifact.artifactId, csv.artifact.artifactId);

  const csvResolved = await service.resolveArtifact(
    REFERENCE,
    csv.artifact.artifactId,
  );
  const csvText = await readFile(csvResolved.absolutePath, "utf8");
  assert.match(csvText, /Mei,'=1\+1/u);
  assert.equal(Object.hasOwn(csv.artifact, "relativePath"), false);
  assert.equal(csv.artifact.rowCount, 2);
  assert.equal(csv.artifact.columnCount, 2);
  assert.deepEqual(csv.artifact.source, [
    "xhs-data://jobs/job-artifacts-001/content",
  ]);
  assert.deepEqual(csv.artifact.sourceRecordIds, ["note-001", "note-002"]);
  assert.equal(csv.artifact.sourceRecordCount, 2);
  assert.deepEqual(csv.artifact.query, {
    dataset: "content",
    query: "Shanghai",
    sortBy: "publishedAt",
    direction: "desc",
  });

  const json = await service.createArtifact(REFERENCE, {
    format: "json",
    name: "summary",
    data: { count: 2 },
    idempotencyKey: "artifact-create-json-001",
  });
  const markdown = await service.createArtifact(REFERENCE, {
    format: "markdown",
    name: "report.md",
    data: table,
    idempotencyKey: "artifact-create-markdown-001",
  });
  assert.equal(json.artifact.displayName, "summary.json");
  assert.equal(markdown.artifact.mediaType, "text/markdown");

  const inventory = await service.listArtifacts(REFERENCE);
  assert.equal(inventory.artifacts.length, 3);
  assert.equal(inventory.revision, 3);
  assert.equal(
    inventory.artifacts.every((item) => !Object.hasOwn(item, "relativePath")),
    true,
  );

  await assert.rejects(
    service.createArtifact(REFERENCE, {
      format: "csv",
      name: "candidates.csv",
      data: { columns: ["name"], rows: [["Different"]] },
      idempotencyKey: "artifact-create-csv-001",
    }),
    (error) => error.code === "COPILOT_ARTIFACT_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    service.resolveArtifact(REFERENCE, "../escape"),
    (error) => /INVALID/u.test(error.code),
  );
});

test("tampering is detected and another conversation cannot resolve the file", async (t) => {
  const { service, store } = await fixture(t);
  const created = await service.createAttachment(REFERENCE, {
    ...upload("notes.txt", "text/plain", "original"),
    idempotencyKey: "upload-tamper-001",
  });
  const resolved = await service.resolveAttachment(
    REFERENCE,
    created.attachment.attachmentId,
  );
  await writeFile(resolved.absolutePath, "modified", "utf8");
  await assert.rejects(
    service.resolveAttachment(REFERENCE, created.attachment.attachmentId),
    (error) => error.code === "COPILOT_FILE_INTEGRITY_FAILED",
  );

  const other = { ...REFERENCE, conversationId: "conversation-artifacts-002" };
  await store.createConversation({
    ...other,
    title: "Other",
    idempotencyKey: "conversation-create-002",
  });
  await assert.rejects(
    service.resolveAttachment(other, created.attachment.attachmentId),
    (error) => error.code === "COPILOT_ATTACHMENT_NOT_FOUND",
  );
});

test("XLSX export uses openpyxl and can be uploaded and inspected again", async (t) => {
  const { service } = await fixture(t);
  const support = await service.probeXlsxSupport();
  if (!support.available) {
    t.skip(`openpyxl unavailable: ${support.reason}`);
    return;
  }
  const exported = await service.createArtifact(REFERENCE, {
    format: "xlsx",
    name: "audience.xlsx",
    data: {
      sheetName: "Audience",
      columns: ["name", "city"],
      rows: [
        ["Mei", "Shanghai"],
        ["Kai", "Beijing"],
      ],
    },
    idempotencyKey: "artifact-create-xlsx-001",
  });
  const resolved = await service.resolveArtifact(
    REFERENCE,
    exported.artifact.artifactId,
  );
  const workbook = await readFile(resolved.absolutePath);
  assert.equal(workbook.subarray(0, 4).toString("hex"), "504b0304");

  const imported = await service.createAttachment(REFERENCE, {
    ...upload(
      "imported.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      workbook,
    ),
    idempotencyKey: "upload-xlsx-001",
  });
  const parsed = await service.parseAttachment(
    REFERENCE,
    imported.attachment.attachmentId,
  );
  assert.equal(parsed.parser, "openpyxl");
  assert.deepEqual(parsed.sheetNames, ["Audience"]);
  assert.deepEqual(parsed.sheets[0].preview.slice(0, 3), [
    ["name", "city"],
    ["Mei", "Shanghai"],
    ["Kai", "Beijing"],
  ]);
});
