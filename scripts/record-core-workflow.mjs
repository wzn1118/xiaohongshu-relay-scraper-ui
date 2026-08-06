import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "@playwright/test";

const baseUrl = process.env.APP_URL || "http://127.0.0.1:4317";
const outputDir = path.resolve("output/playwright/core-workflow");
const rawVideoDir = path.join(outputDir, "raw");
const verificationPath = path.join(outputDir, "verification.json");
const viewport = { width: 1440, height: 900 };

await mkdir(rawVideoDir, { recursive: true });

const checks = [];
const browserErrors = [];
let browser;
let context;
let page;
let video;

function recordCheck(name, detail) {
  checks.push({ name, status: "passed", detail });
}

async function pause(milliseconds) {
  await page.waitForTimeout(milliseconds);
}

async function installRecordingLayer() {
  await page.addStyleTag({
    content: `
      #codex-video-caption,
      #codex-video-pointer,
      #codex-video-title {
        font-family: "Microsoft YaHei UI", "Microsoft YaHei", sans-serif !important;
        letter-spacing: 0 !important;
      }
      #codex-video-caption {
        position: fixed;
        left: 94px;
        bottom: 34px;
        z-index: 2147483646;
        width: min(690px, calc(100vw - 160px));
        padding: 17px 22px 18px;
        color: #fff;
        background: rgba(24, 24, 27, 0.94);
        border-left: 5px solid #ff2442;
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.28);
        opacity: 0;
        transform: translateY(16px);
        transition: opacity 220ms ease, transform 220ms ease;
        pointer-events: none;
      }
      #codex-video-caption.visible {
        opacity: 1;
        transform: translateY(0);
      }
      #codex-video-caption strong {
        display: block;
        margin-bottom: 5px;
        font-size: 22px;
        line-height: 1.25;
        font-weight: 700;
      }
      #codex-video-caption span {
        display: block;
        color: #e4e4e7;
        font-size: 15px;
        line-height: 1.55;
      }
      #codex-video-pointer {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 2147483647;
        width: 24px;
        height: 24px;
        border: 3px solid #ff2442;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.88);
        box-shadow: 0 2px 9px rgba(0, 0, 0, 0.34);
        transform: translate(-50%, -50%);
        transition: left 520ms ease, top 520ms ease, width 140ms ease, height 140ms ease;
        pointer-events: none;
      }
      #codex-video-pointer.clicking {
        width: 38px;
        height: 38px;
        background: rgba(255, 36, 66, 0.28);
      }
      #codex-video-title {
        position: fixed;
        inset: 0;
        z-index: 2147483645;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 0 150px;
        color: #fff;
        background: rgba(17, 17, 19, 0.96);
        opacity: 0;
        transition: opacity 280ms ease;
        pointer-events: none;
      }
      #codex-video-title.visible { opacity: 1; }
      #codex-video-title .eyebrow {
        margin-bottom: 18px;
        color: #ff5a70;
        font-size: 17px;
        font-weight: 700;
        text-transform: uppercase;
      }
      #codex-video-title h1 {
        max-width: 1040px;
        margin: 0 0 22px;
        font-size: 54px;
        line-height: 1.14;
        font-weight: 800;
      }
      #codex-video-title p {
        max-width: 930px;
        margin: 0;
        color: #d4d4d8;
        font-size: 22px;
        line-height: 1.65;
      }
      .codex-video-focus {
        position: relative;
        z-index: 1;
        outline: 4px solid rgba(255, 36, 66, 0.9) !important;
        outline-offset: 5px !important;
        box-shadow: 0 0 0 10px rgba(255, 36, 66, 0.14) !important;
      }
      input[type="email"], input[type="tel"] {
        filter: blur(7px) !important;
      }
    `,
  });

  await page.evaluate(() => {
    const caption = document.createElement("div");
    caption.id = "codex-video-caption";
    caption.innerHTML = "<strong></strong><span></span>";

    const pointer = document.createElement("div");
    pointer.id = "codex-video-pointer";
    pointer.style.left = "112px";
    pointer.style.top = "116px";

    const title = document.createElement("div");
    title.id = "codex-video-title";
    title.innerHTML = '<div class="eyebrow"></div><h1></h1><p></p>';

    document.body.append(caption, pointer, title);

    const redact = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const parent = node.parentElement;
        if (!parent || parent.closest("#codex-video-caption, #codex-video-title, script, style")) continue;
        const next = node.nodeValue
          ?.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "demo@example.com")
          .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "138****0000");
        if (next && next !== node.nodeValue) node.nodeValue = next;
      }
    };

    redact();
    const observer = new MutationObserver(redact);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__codexVideoObserver = observer;
  });
}

async function showCaption(title, detail) {
  await page.evaluate(
    ({ title, detail }) => {
      const caption = document.querySelector("#codex-video-caption");
      caption.querySelector("strong").textContent = title;
      caption.querySelector("span").textContent = detail;
      caption.classList.add("visible");
    },
    { title, detail },
  );
}

async function hideCaption() {
  await page.evaluate(() => document.querySelector("#codex-video-caption")?.classList.remove("visible"));
  await pause(260);
}

async function showTitle(eyebrow, title, detail, milliseconds = 3800) {
  await page.evaluate(
    ({ eyebrow, title, detail }) => {
      const layer = document.querySelector("#codex-video-title");
      layer.querySelector(".eyebrow").textContent = eyebrow;
      layer.querySelector("h1").textContent = title;
      layer.querySelector("p").textContent = detail;
      layer.classList.add("visible");
    },
    { eyebrow, title, detail },
  );
  await pause(milliseconds);
  await page.evaluate(() => document.querySelector("#codex-video-title")?.classList.remove("visible"));
  await pause(450);
}

async function movePointer(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Cannot move pointer to an element outside the viewport.");
  const x = Math.round(box.x + Math.min(box.width * 0.72, box.width - 12));
  const y = Math.round(box.y + box.height / 2);
  await page.evaluate(
    ({ x, y }) => {
      const pointer = document.querySelector("#codex-video-pointer");
      pointer.style.left = `${x}px`;
      pointer.style.top = `${y}px`;
    },
    { x, y },
  );
  await pause(650);
}

async function focus(locator, milliseconds = 1500) {
  await locator.evaluate((element) => element.classList.add("codex-video-focus"));
  await movePointer(locator);
  await pause(milliseconds);
  await locator.evaluate((element) => element.classList.remove("codex-video-focus"));
}

async function clickWithPointer(locator) {
  await movePointer(locator);
  await page.evaluate(() => document.querySelector("#codex-video-pointer")?.classList.add("clicking"));
  await pause(180);
  await locator.click();
  await pause(260);
  await page.evaluate(() => document.querySelector("#codex-video-pointer")?.classList.remove("clicking"));
}

async function scrollTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  await pause(950);
}

try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport,
    recordVideo: { dir: rawVideoDir, size: viewport },
  });
  page = await context.newPage();
  video = page.video();

  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });

  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (!response?.ok()) throw new Error(`App returned HTTP ${response?.status() ?? "unknown"}.`);
  recordCheck("application", `HTTP ${response.status()} from ${baseUrl}`);

  const relayStatus = page.getByText("Relay \u5df2\u8fde\u63a5", { exact: true });
  await relayStatus.waitFor({ state: "visible", timeout: 60_000 });
  await installRecordingLayer();
  recordCheck("relay", "Relay connected status is visible in the live UI.");

  await showTitle(
    "CORE WORKFLOW / VERIFIED RECORDING",
    "\u4eca\u5929\u4f60\u6295\u4e86\u5417\uff1f\u5c97\u4f4d\u53d1\u73b0\u5230\u6295\u9012\u6750\u6599",
    "\u7528\u4e00\u6761\u53ef\u7eed\u8dd1\u7684\u94fe\u8def\uff0c\u5b8c\u6210\u53d1\u73b0\u3001\u6b63\u6587\u3001\u7ed3\u6784\u5316\u3001\u6587\u6848\u4e0e\u5bfc\u51fa\u3002",
  );

  await showCaption("1  /  \u8fd0\u884c\u72b6\u6001", "\u672c\u5730\u670d\u52a1\u3001Runner \u4e0e Relay \u5b9e\u65f6\u5728\u7ebf\uff0c\u5df2\u5b8c\u6210\u542f\u52a8\u524d\u68c0\u67e5\u3002");
  await focus(relayStatus, 1900);
  await pause(1200);

  const jobDeskButton = page.getByRole("button", { name: "\u5c97\u4f4d\u53f0", exact: true });
  await clickWithPointer(jobDeskButton);
  const configPanel = page.locator("section.config-panel");
  await scrollTo(configPanel);
  await showCaption("2  /  \u914d\u7f6e\u4efb\u52a1", "\u8bbe\u7f6e\u5173\u952e\u8bcd\u3001\u65f6\u95f4\u8303\u56f4\u548c\u91c7\u96c6\u8282\u594f\uff1b\u652f\u6301\u5168\u6d41\u7a0b\u3001\u94fe\u8def\u68c0\u67e5\u4e0e\u65ad\u70b9\u6062\u590d\u3002");
  const fullRunButton = page.getByRole("button", { name: "\u542f\u52a8\u5168\u6d41\u7a0b", exact: true });
  await fullRunButton.waitFor({ state: "visible" });
  await focus(fullRunButton, 2000);
  recordCheck("task-configuration", "Configuration panel and full-workflow action are visible.");
  await pause(1200);

  const historyButton = page.getByRole("button", { name: "\u5386\u53f2", exact: true });
  await clickWithPointer(historyButton);
  const demoButton = page.getByRole("button", { name: "\u6253\u5f00\u6f14\u793a\u4efb\u52a1", exact: true });
  await demoButton.waitFor({ state: "visible" });
  await scrollTo(demoButton);
  await showCaption("3  /  \u590d\u7528\u5df2\u4fdd\u5b58\u4efb\u52a1", "\u4ece\u5386\u53f2\u8bb0\u5f55\u6253\u5f00\u7ade\u8d5b\u6f14\u793a\u4efb\u52a1\uff0c\u4e0d\u91cd\u590d\u91c7\u96c6\uff0c\u76f4\u63a5\u7ee7\u7eed\u5904\u7406\u4e0e\u5ba1\u9605\u3002");
  await focus(demoButton, 1200);
  await clickWithPointer(demoButton);

  const missionPanel = page.locator("section.mission-panel");
  await missionPanel.waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document.querySelector("section.mission-panel")?.innerText.includes("715") &&
      document.querySelector("section.results-panel .result-heading-meta")?.innerText.includes("715") &&
      Boolean(document.querySelector(".result-row.selected")),
    null,
    { timeout: 30_000 },
  );
  const pageText = await page.locator("body").innerText();
  if (!pageText.includes("715")) throw new Error("Demo task metric 715 is missing.");
  recordCheck("demo-task", "Persisted demo opened with 715 discovered items, 715 full bodies, and 715 result cards.");

  await scrollTo(missionPanel);
  await showCaption("4  /  \u53ef\u6062\u590d\u5904\u7406\u94fe\u8def", "715 \u6761\u53d1\u73b0\u4e0e 715 \u6761\u6b63\u6587\u5df2\u4fdd\u5b58\uff1b\u5206\u7c7b\u3001\u63d0\u53d6\u3001\u5339\u914d\u3001\u6587\u6848\u4e0e\u8d28\u68c0\u90fd\u4fdd\u7559\u9010\u9879\u72b6\u6001\u3002");
  await focus(missionPanel, 2600);
  await pause(1300);

  const resultsPanel = page.locator("section.results-panel");
  await scrollTo(resultsPanel);
  await showCaption("5  /  \u9010\u94fe\u63a5\u4e1a\u52a1\u7ed3\u679c", "\u6bcf\u5f20\u5361\u7247\u4fdd\u7559\u539f\u59cb\u6b63\u6587\u3001\u5c97\u4f4d\u4e8b\u5b9e\u3001\u6295\u9012\u8def\u5f84\u548c\u53ef\u7f16\u8f91\u6750\u6599\uff0c\u5931\u8d25\u539f\u56e0\u4e5f\u4f1a\u7559\u75d5\u3002");
  const selectedResult = page.locator(".result-row.selected").first();
  const resultDetail = page.locator(".result-detail");
  await selectedResult.waitFor({ state: "visible" });
  await resultDetail.waitFor({ state: "visible" });
  await focus(selectedResult, 1800);
  await focus(resultDetail, 2500);
  recordCheck("result-workspace", "A saved result card and its structured detail are visible.");
  await pause(1100);

  const artifactsButton = page.getByRole("button", { name: "\u4ea7\u7269", exact: true });
  await clickWithPointer(artifactsButton);
  const deliverablesHeading = page.getByText("\u4ea4\u4ed8\u4ea7\u7269", { exact: true }).first();
  await deliverablesHeading.waitFor({ state: "visible" });
  await scrollTo(deliverablesHeading);
  const deliverablesPanel = page.locator("section.artifacts-panel");
  const deliverablesText = await deliverablesPanel.innerText();
  if (!deliverablesText.includes("321")) throw new Error("Expected 321 demo artifacts in deliverables panel.");

  const firstArtifact = deliverablesPanel.getByRole("link").first();
  const artifactHref = await firstArtifact.getAttribute("href");
  if (!artifactHref) throw new Error("The first artifact has no download URL.");
  const artifactResponse = await context.request.get(new URL(artifactHref, baseUrl).toString());
  if (!artifactResponse.ok()) throw new Error(`Artifact download returned HTTP ${artifactResponse.status()}.`);
  recordCheck("artifact-download", `First of 321 artifacts returned HTTP ${artifactResponse.status()}.`);

  await showCaption("6  /  \u4ea4\u4ed8\u4e0e\u590d\u7528", "321 \u4e2a\u4ea7\u7269\u53ef\u76f4\u63a5\u4e0b\u8f7d\uff0c\u5305\u542b JSON\u3001CSV\u3001XLSX\u3001Markdown \u4e0e\u8fd0\u884c\u6e05\u5355\u3002");
  await focus(deliverablesPanel, 3000);
  await pause(1100);

  if (browserErrors.length) {
    throw new Error(`Browser errors detected: ${browserErrors.join(" | ")}`);
  }
  recordCheck("browser-runtime", "No page errors or console errors occurred during the recorded flow.");

  await hideCaption();
  await showTitle(
    "VERIFIED CORE WORKFLOW",
    "\u5df2\u4fdd\u5b58\u4efb\u52a1\u7684\u6838\u5fc3\u4f7f\u7528\u94fe\u8def\u5df2\u9a8c\u8bc1",
    "\u8fd0\u884c\u72b6\u6001 \u2192 \u4efb\u52a1\u914d\u7f6e \u2192 \u5386\u53f2\u590d\u7528 \u2192 \u5904\u7406\u8ffd\u8e2a \u2192 \u7ed3\u679c\u5ba1\u9605 \u2192 \u4ea7\u7269\u4e0b\u8f7d",
    4200,
  );
} catch (error) {
  checks.push({ name: "recording", status: "failed", detail: error.stack || error.message });
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  const videoPath = video ? await video.path().catch(() => null) : null;
  await browser?.close().catch(() => {});
  await writeFile(
    verificationPath,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        baseUrl,
        viewport,
        rawVideoPath: videoPath,
        checks,
        browserErrors,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ verificationPath, rawVideoPath: videoPath, checks }, null, 2));
}
