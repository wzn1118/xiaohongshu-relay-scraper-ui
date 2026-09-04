#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptsDir, '..');
const unpackedRoot = path.resolve(
  process.env.XHS_CODEX_UNPACKED_DIR
    || path.join(workspaceRoot, 'output', 'app-unpacked-55d9fb967596'),
);
const runtimeRoot = path.resolve(
  process.env.XHS_CODEX_DESKTOP_RUNTIME_DIR
    || path.join(workspaceRoot, 'output', 'codex-desktop-runtime-55d9fb967596'),
);
const protocolVersion = process.env.XHS_CODEX_PROTOCOL_VERSION || '0.147.0-alpha.6.6';
const probeRoot = path.resolve(
  process.env.XHS_CODEX_PROBE_DIR
    || path.join(workspaceRoot, 'output', 'codex-web-runtime-probe', protocolVersion),
);
const schemaRoot = path.join(probeRoot, 'json-schema');
const reportPath = path.join(probeRoot, 'runtime-report.json');

const packageJson = JSON.parse(await readFile(path.join(unpackedRoot, 'package.json'), 'utf8'));
const integrationManifest = JSON.parse(await readFile(path.join(runtimeRoot, 'integration-manifest.json'), 'utf8'));
const webviewRoot = path.join(unpackedRoot, 'webview');
const assetsRoot = path.join(webviewRoot, 'assets');
const preloadPath = path.join(unpackedRoot, '.vite', 'build', 'preload.js');
const electronMainPath = path.join(unpackedRoot, '.vite', 'build', 'main-DwaBWJ3A.js');
const appServerPath = path.join(runtimeRoot, 'app', 'resources', 'codex.exe');
const serverAppPath = path.join(workspaceRoot, 'server', 'app.mjs');

const indexSource = await readFile(path.join(webviewRoot, 'index.html'), 'utf8');
const entryAssets = [...indexSource.matchAll(/(?:src|href)="\.\/([^"?#]+)"/gu)].map((match) => match[1]);
const rendererCandidates = await findRendererBridgeCandidates(assetsRoot);
const serverAppSource = await readFile(serverAppPath, 'utf8');

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  workspaceRoot,
  desktop: {
    version: String(packageJson.version || integrationManifest.version || ''),
    buildNumber: String(packageJson.codexBuildNumber || integrationManifest.buildNumber || ''),
    packageIdentity: String(packageJson.codexWindowsPackageIdentity || ''),
    electronVersion: String(packageJson.devDependencies?.electron || ''),
    sourceAsarSha256: String(integrationManifest.sourceAsarSha256 || ''),
  },
  protocol: await analyzeProtocol(schemaRoot),
  fingerprints: {
    rendererTreeSha256: await hashTree(webviewRoot),
    schemaTreeSha256: await hashTree(schemaRoot),
    indexSha256: await hashFile(path.join(webviewRoot, 'index.html')),
    preloadSha256: await hashFile(preloadPath),
    electronMainSha256: await hashFile(electronMainPath),
    appServerSha256: await hashFile(appServerPath),
  },
  renderer: {
    root: webviewRoot,
    entryAssets,
    bridgeCandidates: rendererCandidates.map((candidate) => path.relative(webviewRoot, candidate.path).replaceAll('\\', '/')),
    apiSurface: analyzeRendererSurface(rendererCandidates),
  },
  preload: analyzePreload(await readFile(preloadPath, 'utf8'), preloadPath),
  currentPatches: await analyzeCurrentPatches(serverAppSource, assetsRoot),
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  reportPath,
  desktop: report.desktop,
  protocol: {
    clientRequests: report.protocol.clientRequests.length,
    serverRequests: report.protocol.serverRequests.length,
    serverNotifications: report.protocol.serverNotifications.length,
    clientNotifications: report.protocol.clientNotifications.length,
    capabilityMatrix: report.protocol.capabilityMatrix,
  },
  preload: report.preload,
  renderer: report.renderer,
  currentPatches: report.currentPatches,
  fingerprints: report.fingerprints,
}, null, 2)}\n`);

async function analyzeProtocol(root) {
  const envelopes = {};
  for (const name of ['ClientRequest', 'ServerRequest', 'ServerNotification', 'ClientNotification']) {
    envelopes[name] = JSON.parse(await readFile(path.join(root, `${name}.json`), 'utf8'));
  }
  const methods = Object.fromEntries(Object.entries(envelopes).map(([name, schema]) => [name, extractMethods(schema)]));
  const clientRequests = methods.ClientRequest;
  const supports = (method) => clientRequests.includes(method);
  const groups = {};
  for (const method of clientRequests) {
    const prefix = method.includes('/') ? method.split('/')[0] : 'legacy';
    groups[prefix] = (groups[prefix] || 0) + 1;
  }
  return {
    version: protocolVersion,
    schemaRoot: root,
    generatedWithExperimental: true,
    clientRequests,
    serverRequests: methods.ServerRequest,
    serverNotifications: methods.ServerNotification,
    clientNotifications: methods.ClientNotification,
    methodGroups: Object.fromEntries(Object.entries(groups).sort(([left], [right]) => left.localeCompare(right))),
    capabilityMatrix: {
      initialize: supports('initialize'),
      threadStart: supports('thread/start'),
      threadResume: supports('thread/resume'),
      threadList: supports('thread/list'),
      threadRead: supports('thread/read'),
      turnStart: supports('turn/start'),
      turnSteer: supports('turn/steer'),
      approvals: methods.ServerRequest.some((method) => method.includes('requestApproval')),
      models: supports('model/list'),
      mcp: supports('mcpServerStatus/list') && supports('mcpServer/tool/call'),
      skills: supports('skills/list'),
      plugins: supports('plugin/list'),
      filesystem: supports('fs/readFile') && supports('fs/writeFile'),
      git: supports('gitDiffToRemote'),
      terminal: supports('process/spawn') && supports('process/writeStdin'),
      settings: supports('config/read') && supports('config/value/write'),
      account: supports('account/read'),
      remoteControl: supports('remoteControl/enable'),
    },
  };
}

function extractMethods(schema) {
  return [...new Set((schema.oneOf || [])
    .flatMap((entry) => entry?.properties?.method?.enum || [])
    .map((method) => String(method)))]
    .sort();
}

async function findRendererBridgeCandidates(root) {
  const candidates = [];
  for (const filePath of await listFiles(root)) {
    if (!filePath.endsWith('.js')) continue;
    const source = await readFile(filePath, 'utf8');
    if (!source.includes('electronBridge') && !source.includes('codexWindowType')) continue;
    candidates.push({ path: filePath, source });
  }
  return candidates;
}

function analyzeRendererSurface(candidates) {
  const methods = new Set();
  const globals = new Set();
  const files = [];
  for (const candidate of candidates) {
    const sourceFile = ts.createSourceFile(candidate.path, candidate.source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const checker = createChecker(candidate.path, sourceFile);
    const aliases = new Set();
    walkAst(sourceFile, (node) => {
      if (ts.isIdentifier(node) && node.text === 'codexWindowType') globals.add('codexWindowType');
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (bridgeChain(node.initializer, checker, new Set()) !== null) aliases.add(node.name.text);
      }
      if (!ts.isCallExpression(node)) return;
      const chain = bridgeChain(node.expression, checker, new Set());
      if (chain?.length) methods.add(chain[0]);
    });
    files.push({
      path: path.relative(webviewRoot, candidate.path).replaceAll('\\', '/'),
      bytes: Buffer.byteLength(candidate.source),
      aliases: [...aliases].sort(),
    });
  }
  return { globals: [...globals].sort(), methods: [...methods].sort(), files };
}

function analyzePreload(source, filePath) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const constants = new Map();
  const objects = new Map();
  const electronAliases = new Set();
  walkAst(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const stringValue = staticString(node.initializer, constants);
    if (stringValue !== null) constants.set(node.name.text, stringValue);
    if (ts.isObjectLiteralExpression(node.initializer)) objects.set(node.name.text, node.initializer);
    if (isElectronRequire(node.initializer)) electronAliases.add(node.name.text);
  });

  const calls = new Map();
  const exposedGlobals = new Set();
  const bridgeMethods = new Set();
  const processFields = new Set();
  walkAst(sourceFile, (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process') {
      processFields.add(node.name.text);
    }
    if (!ts.isCallExpression(node)) return;
    const chain = electronChain(node.expression, electronAliases);
    if (!chain?.length) return;
    const operation = chain.join('.');
    const channels = calls.get(operation) || new Set();
    channels.add(staticString(node.arguments[0], constants) ?? expressionLabel(node.arguments[0]));
    calls.set(operation, channels);
    if (operation === 'contextBridge.exposeInMainWorld') {
      const globalName = staticString(node.arguments[0], constants);
      if (globalName) exposedGlobals.add(globalName);
      const value = node.arguments[1];
      if (ts.isIdentifier(value) && objects.has(value.text)) {
        for (const property of objects.get(value.text).properties) {
          const name = propertyName(property.name);
          if (name) bridgeMethods.add(name);
        }
      }
    }
  });
  return {
    file: filePath,
    electronAliases: [...electronAliases].sort(),
    exposedGlobals: [...exposedGlobals].sort(),
    bridgeMethods: [...bridgeMethods].sort(),
    processFields: [...processFields].sort(),
    electronCalls: Object.fromEntries([...calls.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([operation, channels]) => [operation, [...channels].filter(Boolean).sort()])),
  };
}

async function analyzeCurrentPatches(source, root) {
  const hardcodedAssetNames = [...source.matchAll(/path\.basename\(file\.absolute\) === '([^']+)'/gu)]
    .map((match) => match[1])
    .filter((name) => name.startsWith('app-'));
  const desktopConnect = /const desktopConnect = '([^']+)'/u.exec(source)?.[1] || '';
  const initialPath = path.join(root, 'app-initial-KpqQCW_k.js');
  const mainPath = path.join(root, 'app-main-CCNMdQcy.js');
  const initial = await readFile(initialPath, 'utf8');
  const main = await readFile(mainPath, 'utf8');
  const mainAnchors = [
    'await V(),await ne(),u(),',
    'let e=G||K||l.startup==null?void 0:Promise.resolve(l.startup.whenReady());',
    'l.startup',
  ];
  return {
    htmlBootstrapInjection: source.includes('<script src="/codex/browser-host.js"></script>'),
    hardcodedAssetNames,
    minifiedStringReplacements: [
      { asset: path.basename(initialPath), anchor: 'desktopConnect', found: Boolean(desktopConnect && initial.includes(desktopConnect)) },
      ...mainAnchors.map((anchor) => ({ asset: path.basename(mainPath), anchor, found: main.includes(anchor) })),
    ],
  };
}

function isElectronRequire(node) {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
    && staticString(node.arguments[0], new Map()) === 'electron';
}

function electronChain(node, aliases) {
  if (ts.isIdentifier(node) && aliases.has(node.text)) return [];
  if (ts.isPropertyAccessExpression(node)) {
    const parent = electronChain(node.expression, aliases);
    return parent ? [...parent, node.name.text] : null;
  }
  if (ts.isElementAccessExpression(node)) {
    const parent = electronChain(node.expression, aliases);
    const key = staticString(node.argumentExpression, new Map());
    return parent && key ? [...parent, key] : null;
  }
  return null;
}

function bridgeChain(node, checker, seenSymbols) {
  if (ts.isIdentifier(node)) {
    if (node.text === 'electronBridge') return [];
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || seenSymbols.has(symbol)) return null;
    const declarations = symbol.declarations || [];
    for (const declaration of declarations) {
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
      const nextSeen = new Set(seenSymbols).add(symbol);
      const resolved = bridgeChain(declaration.initializer, checker, nextSeen);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === 'electronBridge'
      && ts.isIdentifier(node.expression)
      && ['window', 'globalThis'].includes(node.expression.text)) return [];
    const parent = bridgeChain(node.expression, checker, seenSymbols);
    return parent ? [...parent, node.name.text] : null;
  }
  if (ts.isElementAccessExpression(node)) {
    const parent = bridgeChain(node.expression, checker, seenSymbols);
    const key = staticString(node.argumentExpression, new Map());
    return parent && key ? [...parent, key] : null;
  }
  return null;
}

function createChecker(filePath, sourceFile) {
  const options = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options, true);
  const canonicalPath = path.resolve(filePath).toLowerCase();
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreateNewSourceFile) => (
    path.resolve(requested).toLowerCase() === canonicalPath
      ? sourceFile
      : originalGetSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile)
  );
  return ts.createProgram([filePath], options, host).getTypeChecker();
}

function staticString(node, constants) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node) && constants.has(node.text)) return constants.get(node.text);
  return null;
}

function expressionLabel(node) {
  if (!node) return '';
  if (ts.isIdentifier(node)) return `{${node.text}}`;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) return `{${node.expression.text}(...)}`;
  return `{${node.getText().slice(0, 80)}}`;
}

function propertyName(node) {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return '';
}

function walkAst(root, visitor) {
  const visit = (node) => {
    visitor(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
}

async function hashTree(root) {
  const hash = createHash('sha256');
  for (const filePath of await listFiles(root)) {
    const relative = path.relative(root, filePath).replaceAll('\\', '/');
    const metadata = await stat(filePath);
    hash.update(relative).update('\0').update(String(metadata.size)).update('\0').update(await hashFile(filePath)).update('\n');
  }
  return hash.digest('hex');
}

async function hashFile(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function listFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}
