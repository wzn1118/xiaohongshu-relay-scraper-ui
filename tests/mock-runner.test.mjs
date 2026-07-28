import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsDirectory, "..");
const runner = path.join(testsDirectory, "fixtures", "mock_xiaohongshu_runner.py");
const verifier = path.join(repositoryRoot, "scripts", "verify-artifacts.mjs");

function resolvePython() {
  const configured = process.env.PYTHON_BIN;
  const candidates = configured
    ? [{ command: configured, prefix: [] }]
    : process.platform === "win32"
      ? [
          { command: "python", prefix: [] },
          { command: "py", prefix: ["-3"] },
        ]
      : [
          { command: "python3", prefix: [] },
          { command: "python", prefix: [] },
        ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, "--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("Python 3 was not found; set PYTHON_BIN to its executable path");
}

function runPython(python, args, options = {}) {
  return spawnSync(python.command, [...python.prefix, runner, ...args], {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    windowsHide: true,
    ...options,
  });
}

function runVerifier(outputDir, allowedRoot, extra = []) {
  return spawnSync(
    process.execPath,
    [verifier, "--output-dir", outputDir, "--allowed-root", allowedRoot, "--json", ...extra],
    { encoding: "utf8", windowsHide: true },
  );
}

async function runLongAndCancel(python, outputDir, cancelFile) {
  const child = spawn(
    python.command,
    [
      ...python.prefix,
      runner,
      "--mock-scenario",
      "long",
      "--mock-delay-seconds",
      "0.05",
      "--mock-long-seconds",
      "30",
      "--mock-cancel-file",
      cancelFile,
      "--output-dir",
      outputDir,
    ],
    {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let markerWritten = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!markerWritten && stdout.includes("[long] heartbeat 1")) {
      markerWritten = true;
      void writeFile(cancelFile, "cancel\n", "utf8");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`long scenario did not cancel in time\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return result;
}

test("mock runner and artifact verifier cover success, failure, cancellation, and path safety", async () => {
  const python = resolvePython();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "xhs-runner-fixture-"));
  assert.ok(path.basename(temporaryRoot).startsWith("xhs-runner-fixture-"));

  try {
    const successDir = path.join(temporaryRoot, "success");
    const success = runPython(python, [
      "--mock-scenario",
      "success",
      "--mock-delay-seconds",
      "0.001",
      "--mock-records",
      "3",
      "--keyword",
      "intern succession",
      "--output-dir",
      successDir,
    ]);
    assert.equal(success.status, 0, success.stderr || success.stdout);
    assert.match(success.stdout, /Attached relay tabs: 1/);
    assert.match(success.stdout, /Running post-process exports/);
    assert.match(success.stdout, /Done\./);

    const verified = runVerifier(successDir, temporaryRoot, ["--expect-count", "3"]);
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    const verification = JSON.parse(verified.stdout);
    assert.equal(verification.ok, true);
    assert.equal(verification.recordCount, 3);
    assert.equal(verification.artifactCount, 7);

    const failureDir = path.join(temporaryRoot, "failure");
    const failure = runPython(python, [
      "--mock-scenario",
      "failure",
      "--mock-delay-seconds",
      "0",
      "--output-dir",
      failureDir,
    ]);
    assert.equal(failure.status, 1, failure.stderr || failure.stdout);
    assert.match(failure.stdout, /Scrape run failed before normal delivery/);
    const failureManifest = JSON.parse(await readFile(path.join(failureDir, "artifact-manifest.json"), "utf8"));
    assert.equal(failureManifest.status, "failed");
    const rejectedFailure = runVerifier(failureDir, temporaryRoot);
    assert.notEqual(rejectedFailure.status, 0);
    assert.match(rejectedFailure.stderr, /status is not succeeded/);

    const longDir = path.join(temporaryRoot, "long");
    const cancelFile = path.join(temporaryRoot, "cancel.requested");
    const cancelled = await runLongAndCancel(python, longDir, cancelFile);
    assert.equal(cancelled.code, 130, cancelled.stderr || cancelled.stdout);
    assert.match(cancelled.stdout, /\[cancelled\]/);
    const cancelManifest = JSON.parse(await readFile(path.join(longDir, "artifact-manifest.json"), "utf8"));
    assert.equal(cancelManifest.status, "cancelled");

    const otherRoot = path.join(temporaryRoot, "other-root");
    await mkdir(otherRoot);
    const rejectedPath = runVerifier(successDir, otherRoot);
    assert.notEqual(rejectedPath.status, 0);
    assert.match(rejectedPath.stderr, /outside allowed root/);

    await writeFile(path.join(successDir, "xiaohongshu_notes_latest.csv"), "tampered\n", "utf8");
    const rejectedHash = runVerifier(successDir, temporaryRoot);
    assert.notEqual(rejectedHash.status, 0);
    assert.match(rejectedHash.stderr, /(size mismatch|SHA-256 mismatch)/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
