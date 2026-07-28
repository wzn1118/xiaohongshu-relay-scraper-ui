#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_ARTIFACTS = [
  "xiaohongshu_cards_latest.json",
  "xiaohongshu_notes_latest.json",
  "xiaohongshu_notes_latest.csv",
  "xiaohongshu_notes_latest_dedup.json",
  "xiaohongshu_notes_latest_dedup.csv",
  "xiaohongshu_notes_latest_dedup.xlsx",
  "xiaohongshu_notes_structured.xlsx",
];

const PROJECT_REQUIRED_ARTIFACTS = [
  "application_intelligence.json",
  "application_intelligence.csv",
  "application_intelligence.xlsx",
  "application_intelligence_summary.json",
  "application_intelligence_report.md",
  "coverage_report.json",
  "workflow-summary.json",
];

function usage() {
  const command = path.basename(fileURLToPath(import.meta.url));
  return [
    `Usage: node scripts/${command} --output-dir DIR [options]`,
    "",
    "Options:",
    "  --allowed-root DIR   Root that must contain the output (default: cwd)",
    "  --expect-count N     Require exactly N note records",
    "  --json               Print a machine-readable result",
    "  --help               Show this message",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    allowedRoot: process.cwd(),
    expectCount: undefined,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--output-dir" || argument === "--allowed-root" || argument === "--expect-count") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--output-dir") options.outputDir = value;
      if (argument === "--allowed-root") options.allowedRoot = value;
      if (argument === "--expect-count") {
        options.expectCount = Number(value);
        if (!Number.isInteger(options.expectCount) || options.expectCount < 1) {
          throw new Error("--expect-count must be a positive integer");
        }
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.help && !options.outputDir) {
    throw new Error("--output-dir is required");
  }
  return options;
}

function canonicalForComparison(candidate) {
  const normalized = path.resolve(candidate).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(parent, child) {
  const canonicalParent = canonicalForComparison(parent);
  const canonicalChild = canonicalForComparison(child);
  const relative = path.relative(canonicalParent, canonicalChild);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function requireRegularContainedFile(outputReal, allowedReal, candidate, label) {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${candidate}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} is not a regular file: ${candidate}`);
  }
  const candidateReal = await realpath(candidate);
  if (!isInside(outputReal, candidateReal) || !isInside(allowedReal, candidateReal)) {
    throw new Error(`${label} escapes the approved output root: ${candidate}`);
  }
  return candidateReal;
}

async function readJson(pathname, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(pathname, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return parsed;
}

function countCsvRows(text) {
  const content = text.replace(/^\uFEFF/, "");
  let inQuotes = false;
  let rows = 0;
  let hasData = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (inQuotes && content[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === "\n" && !inQuotes) {
      if (hasData) rows += 1;
      hasData = false;
    } else if (character !== "\r") {
      hasData = true;
    }
  }
  if (inQuotes) throw new Error("CSV has an unterminated quoted field");
  if (hasData) rows += 1;
  return Math.max(0, rows - 1);
}

function uniqueNoteIds(records, label) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${label} must contain a non-empty JSON array`);
  }
  const ids = records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    if (typeof record.note_id !== "string" || record.note_id.trim() === "") {
      throw new Error(`${label}[${index}].note_id must be a non-empty string`);
    }
    return record.note_id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate note_id values`);
  }
  return ids;
}

async function hashFile(pathname) {
  const digest = createHash("sha256");
  digest.update(await readFile(pathname));
  return digest.digest("hex");
}

async function verifyXlsx(pathname, label) {
  const data = await readFile(pathname);
  if (data.length < 500 || data[0] !== 0x50 || data[1] !== 0x4b || data[2] !== 0x03 || data[3] !== 0x04) {
    throw new Error(`${label} is not a non-empty XLSX/ZIP container`);
  }
  const raw = data.toString("latin1");
  for (const entry of ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]) {
    if (!raw.includes(entry)) {
      throw new Error(`${label} is missing XLSX entry ${entry}`);
    }
  }
}

function validateManifestPath(manifestPath) {
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") {
    throw new Error("manifest artifact path must be a non-empty string");
  }
  const segments = manifestPath.split(/[\\/]+/);
  if (path.isAbsolute(manifestPath) || segments.includes("..") || segments.includes(".")) {
    throw new Error(`unsafe artifact path in manifest: ${manifestPath}`);
  }
}

async function verify(options) {
  const allowedLexical = path.resolve(options.allowedRoot);
  const outputLexical = path.resolve(options.outputDir);
  if (!isInside(allowedLexical, outputLexical)) {
    throw new Error(`output directory is outside allowed root: ${outputLexical}`);
  }

  const [allowedReal, outputReal] = await Promise.all([realpath(allowedLexical), realpath(outputLexical)]);
  if (!isInside(allowedReal, outputReal)) {
    throw new Error(`resolved output directory escapes allowed root: ${outputReal}`);
  }
  const outputMetadata = await lstat(outputLexical);
  if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) {
    throw new Error("output directory must be a real directory, not a symbolic link");
  }

  const manifestPath = path.join(outputLexical, "artifact-manifest.json");
  await requireRegularContainedFile(outputReal, allowedReal, manifestPath, "artifact manifest");
  const manifest = await readJson(manifestPath, "artifact manifest");
  const supportedRunners = new Set(["mock-xiaohongshu-relay", "xiaohongshu-project-workflow"]);
  if (manifest.schemaVersion !== 1 || !supportedRunners.has(manifest.runner)) {
    throw new Error("artifact manifest schema or runner identity is invalid");
  }
  if (manifest.status !== "succeeded") {
    throw new Error(`artifact manifest status is not succeeded: ${manifest.status ?? "missing"}`);
  }
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error("artifact manifest artifacts must be an array");
  }

  const entries = new Map();
  for (const entry of manifest.artifacts) {
    validateManifestPath(entry?.path);
    if (entries.has(entry.path)) throw new Error(`duplicate manifest artifact: ${entry.path}`);
    entries.set(entry.path, entry);
  }
  for (const required of REQUIRED_ARTIFACTS) {
    if (!entries.has(required)) throw new Error(`manifest is missing required artifact: ${required}`);
  }
  if (manifest.runner === "xiaohongshu-project-workflow") {
    for (const required of PROJECT_REQUIRED_ARTIFACTS) {
      if (!entries.has(required)) throw new Error(`manifest is missing project artifact: ${required}`);
    }
  }

  const verifiedFiles = [];
  for (const [relativePath, entry] of entries) {
    const candidate = path.resolve(outputLexical, relativePath);
    if (!isInside(outputLexical, candidate)) {
      throw new Error(`manifest artifact escapes output directory: ${relativePath}`);
    }
    await requireRegularContainedFile(outputReal, allowedReal, candidate, `artifact ${relativePath}`);
    const metadata = await stat(candidate);
    if (metadata.size <= 0 || entry.bytes !== metadata.size) {
      throw new Error(`artifact size mismatch: ${relativePath}`);
    }
    const digest = await hashFile(candidate);
    if (typeof entry.sha256 !== "string" || entry.sha256.toLowerCase() !== digest) {
      throw new Error(`artifact SHA-256 mismatch: ${relativePath}`);
    }
    verifiedFiles.push(relativePath);
  }

  const latest = await readJson(path.join(outputLexical, "xiaohongshu_notes_latest.json"), "latest notes JSON");
  const deduplicated = await readJson(
    path.join(outputLexical, "xiaohongshu_notes_latest_dedup.json"),
    "deduplicated notes JSON",
  );
  const latestIds = uniqueNoteIds(latest, "latest notes JSON");
  const deduplicatedIds = uniqueNoteIds(deduplicated, "deduplicated notes JSON");
  if (latestIds.join("\u0000") !== deduplicatedIds.join("\u0000")) {
    throw new Error("latest and deduplicated JSON contain different note IDs");
  }
  const expectedCount = options.expectCount ?? manifest.recordCount;
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || latest.length !== expectedCount) {
    throw new Error(`record count mismatch: expected ${expectedCount}, found ${latest.length}`);
  }
  if (manifest.recordCount !== latest.length) {
    throw new Error(`manifest recordCount mismatch: ${manifest.recordCount} vs ${latest.length}`);
  }

  for (const csvName of ["xiaohongshu_notes_latest.csv", "xiaohongshu_notes_latest_dedup.csv"]) {
    const csvRows = countCsvRows(await readFile(path.join(outputLexical, csvName), "utf8"));
    if (csvRows !== latest.length) {
      throw new Error(`${csvName} row count mismatch: expected ${latest.length}, found ${csvRows}`);
    }
  }
  await verifyXlsx(path.join(outputLexical, "xiaohongshu_notes_latest_dedup.xlsx"), "deduplicated workbook");
  await verifyXlsx(path.join(outputLexical, "xiaohongshu_notes_structured.xlsx"), "structured workbook");

  let workflowSummary;
  if (manifest.runner === "xiaohongshu-project-workflow") {
    workflowSummary = await readJson(path.join(outputLexical, "workflow-summary.json"), "workflow summary");
    const intelligence = await readJson(
      path.join(outputLexical, "application_intelligence.json"),
      "application intelligence",
    );
    if (workflowSummary.schemaVersion !== 1 || workflowSummary.status !== "succeeded") {
      throw new Error("workflow summary does not describe a successful project run");
    }
    if (
      workflowSummary.cardsDiscovered !== latest.length ||
      workflowSummary.notesCollected !== latest.length ||
      workflowSummary.bodiesCaptured !== latest.length ||
      workflowSummary.bodyCoveragePercent !== 100
    ) {
      throw new Error("workflow summary does not prove complete discovered-note and body coverage");
    }
    if (!Array.isArray(intelligence.records) || intelligence.records.length !== latest.length) {
      throw new Error("application intelligence record count does not match scraped notes");
    }
    for (const [index, record] of intelligence.records.entries()) {
      if (typeof record.body !== "string" || record.body.trim() === "") {
        throw new Error(`application intelligence record ${index} has no full body`);
      }
      if (!record.outreach?.greeting || !record.outreach?.email_body || record.outreach.status !== "ready") {
        throw new Error(`application intelligence record ${index} has no ready outreach draft`);
      }
      if (record.publish_time?.raw && !record.publish_time?.value) {
        throw new Error(`application intelligence record ${index} has an unnormalized source time`);
      }
    }
    const applicationCsvRows = countCsvRows(
      await readFile(path.join(outputLexical, "application_intelligence.csv"), "utf8"),
    );
    if (applicationCsvRows !== latest.length) {
      throw new Error(`application_intelligence.csv row count mismatch: expected ${latest.length}, found ${applicationCsvRows}`);
    }
    await verifyXlsx(path.join(outputLexical, "application_intelligence.xlsx"), "application intelligence workbook");
  }

  return {
    ok: true,
    outputDir: outputReal,
    runId: manifest.runId,
    recordCount: latest.length,
    artifactCount: verifiedFiles.length,
    artifacts: verifiedFiles.sort(),
    ...(workflowSummary ? { workflowSummary } : {}),
  };
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  const result = await verify(options);
  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`PASS ${result.runId}: ${result.recordCount} records, ${result.artifactCount} artifacts`);
    console.log(`Output: ${result.outputDir}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (options?.json) {
    console.error(JSON.stringify({ ok: false, error: message }));
  } else {
    console.error(`FAIL: ${message}`);
  }
  process.exit(1);
}
