import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCodexRuntimeCompatibility,
  writeCodexRuntimeBaseline,
} from './codex-runtime-compatibility.mjs';

const INITIAL_ANCHOR = 'async function J8e(){Y8e=q8e(),Am=await Y8e.services,Am.clientCoordination!=null&&h8e(Am.clientCoordination),Am.terminal!=null&&G3e(Am.terminal),Am.devboxService}';
const MAIN_ANCHORS = 'await V(),await ne(),u(), let e=G||K||l.startup==null?void 0:Promise.resolve(l.startup.whenReady()); l.startup';

test('discovers renamed assets, fingerprints the runtime, and transforms known-good startup anchors', async () => {
  const fixture = await createRuntimeFixture();
  try {
    const baselinePath = path.join(fixture, 'baseline.json');
    const compatibility = createCodexRuntimeCompatibility({ runtimeRoot: fixture, baselinePath });
    const inspected = await compatibility.inspect();
    assert.equal(inspected.ready, true);
    assert.equal(inspected.baseline.state, 'missing');
    assert.deepEqual(inspected.patchAssets.map((entry) => entry.kind).sort(), ['app-initial', 'app-main']);
    assert.deepEqual(inspected.patchAssets.map((entry) => path.basename(entry.file)).sort(), ['app-main-renamed.js', 'app-initial-renamed.js'].sort());

    const initialPath = inspected.patchAssets.find((entry) => entry.kind === 'app-initial').file;
    const initialSource = await (await import('node:fs/promises')).readFile(initialPath, 'utf8');
    const initialTransform = compatibility.transform(initialPath, initialSource);
    assert.equal(initialTransform.ok, true);
    assert.match(initialTransform.source, /appVersion:"26\.803\.81509"/u);
    assert.doesNotMatch(initialTransform.source, /Y8e=q8e\(\)/u);

    const mainPath = inspected.patchAssets.find((entry) => entry.kind === 'app-main').file;
    const mainSource = await (await import('node:fs/promises')).readFile(mainPath, 'utf8');
    const mainTransform = compatibility.transform(mainPath, mainSource);
    assert.equal(mainTransform.ok, true);
    assert.doesNotMatch(mainTransform.source, /await V\(\),await ne\(\),u\(\),/u);
    assert.match(mainTransform.source, /l\?\.startup/u);

    const baseline = await writeCodexRuntimeBaseline({ compatibility, baselinePath });
    assert.equal(baseline.fingerprint.rendererEntrySha256, inspected.fingerprint.rendererEntrySha256);
    const reloaded = createCodexRuntimeCompatibility({ runtimeRoot: fixture, baselinePath });
    const matched = await reloaded.inspect();
    assert.equal(matched.ready, true);
    assert.equal(matched.baseline.state, 'match');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('fails closed when a known-good baseline no longer matches', async () => {
  const fixture = await createRuntimeFixture();
  try {
    const baselinePath = path.join(fixture, 'baseline.json');
    const first = createCodexRuntimeCompatibility({ runtimeRoot: fixture, baselinePath });
    await first.inspect();
    await writeCodexRuntimeBaseline({ compatibility: first, baselinePath });
    const initialPath = path.join(fixture, 'app', 'resources', 'app-unpacked', 'webview', 'assets', 'app-initial-renamed.js');
    await writeFile(initialPath, `${INITIAL_ANCHOR}\nchanged`, 'utf8');
    const second = createCodexRuntimeCompatibility({ runtimeRoot: fixture, baselinePath });
    const inspected = await second.inspect();
    assert.equal(inspected.ready, false);
    assert.equal(inspected.state, 'incompatible');
    assert.equal(inspected.baseline.state, 'mismatch');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('fails closed when a patch anchor disappears after inspection', async () => {
  const fixture = await createRuntimeFixture();
  try {
    const compatibility = createCodexRuntimeCompatibility({ runtimeRoot: fixture, baselinePath: path.join(fixture, 'baseline.json') });
    const inspected = await compatibility.inspect();
    const initialPath = inspected.patchAssets.find((entry) => entry.kind === 'app-initial').file;
    const result = compatibility.transform(initialPath, 'async function J8e(){changed}');
    assert.equal(result.matched, true);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'CODEX_RUNTIME_PATCH_ANCHOR_CHANGED');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function createRuntimeFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'codex-runtime-'));
  const root = path.join(fixture, 'app', 'resources', 'app-unpacked');
  const assets = path.join(root, 'webview', 'assets');
  await mkdir(assets, { recursive: true });
  await mkdir(path.join(root, '.vite', 'build'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    version: '26.803.81509',
    codexBuildNumber: '6415',
    codexBuildFlavor: 'prod',
    codexWindowsPackageIdentity: 'OpenAI.Codex',
  }), 'utf8');
  await writeFile(path.join(root, 'webview', 'index.html'), '<script type="module" src="./assets/index.js"></script>', 'utf8');
  await writeFile(path.join(assets, 'app-initial-renamed.js'), INITIAL_ANCHOR, 'utf8');
  await writeFile(path.join(assets, 'app-main-renamed.js'), MAIN_ANCHORS, 'utf8');
  await writeFile(path.join(root, '.vite', 'build', 'preload.js'), 'require("electron")', 'utf8');
  await mkdir(path.join(fixture, 'app', 'resources'), { recursive: true });
  await writeFile(path.join(fixture, 'app', 'resources', 'codex.exe'), 'fixture app server', 'utf8');
  return fixture;
}
