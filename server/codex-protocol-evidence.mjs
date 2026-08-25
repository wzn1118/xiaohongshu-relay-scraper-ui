import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_FILE = 'codex_app_server_protocol.schemas.json';
const ENVELOPES = Object.freeze([
  ['clientRequests', 'ClientRequest'],
  ['serverRequests', 'ServerRequest'],
  ['clientNotifications', 'ClientNotification'],
  ['serverNotifications', 'ServerNotification'],
]);

export async function loadCodexProtocolEvidence({ root }) {
  const resolvedRoot = path.resolve(root);
  const candidates = await discoverCandidates(resolvedRoot);
  const evidence = [];

  for (const candidateRoot of candidates) {
    const schemaPath = path.join(candidateRoot, 'json-schema', SCHEMA_FILE);
    try {
      const schemaSource = await readFile(schemaPath, 'utf8');
      const schema = JSON.parse(schemaSource);
      const methods = extractEnvelopeMethods(schema);
      if (!methods.clientRequests.includes('initialize')) continue;

      const probePath = path.join(candidateRoot, 'live-probe.json');
      const probe = await readOptionalJson(probePath);
      const protocolVersion = String(probe?.protocolVersion || path.basename(candidateRoot)).trim() || 'unknown';
      const passedProbes = (probe?.probes || [])
        .filter((entry) => entry?.status === 'pass' && entry?.method)
        .map((entry) => String(entry.method));
      const failedProbes = (probe?.probes || [])
        .filter((entry) => entry?.status === 'fail' && entry?.method)
        .map((entry) => String(entry.method));
      const all = [...new Set(Object.values(methods).flat())].sort();

      evidence.push({
        schemaVersion: 1,
        state: 'ready',
        source: probe ? 'generated-schema+live-probe' : 'generated-schema',
        root: candidateRoot,
        protocolVersion,
        generatedAt: String(probe?.generatedAt || ''),
        schemaPath,
        probePath: probe ? probePath : null,
        schemaSha256: createHash('sha256').update(schemaSource).digest('hex'),
        methods: { ...methods, all },
        probes: {
          initialization: probe?.initialization?.ok === true ? 'pass' : 'unknown',
          passed: [...new Set(passedProbes)].sort(),
          failed: [...new Set(failedProbes)].sort(),
        },
      });
    } catch {
      // A partial probe directory is ignored in favor of the latest complete candidate.
    }
  }

  if (!evidence.length) {
    return Object.freeze({
      schemaVersion: 1,
      state: 'unavailable',
      source: 'none',
      root: resolvedRoot,
      protocolVersion: 'unknown',
      methods: emptyMethods(),
      probes: { initialization: 'unknown', passed: [], failed: [] },
    });
  }

  evidence.sort((left, right) => {
    const byDate = Date.parse(right.generatedAt || '') - Date.parse(left.generatedAt || '');
    if (Number.isFinite(byDate) && byDate !== 0) return byDate;
    return right.protocolVersion.localeCompare(left.protocolVersion, undefined, { numeric: true });
  });
  return deepFreeze(evidence[0]);
}

export function extractEnvelopeMethods(schema) {
  const definitions = schema?.definitions || schema?.$defs || {};
  const result = {};
  for (const [outputName, definitionName] of ENVELOPES) {
    result[outputName] = [...new Set((definitions[definitionName]?.oneOf || [])
      .flatMap((entry) => entry?.properties?.method?.enum || [])
      .map(String))]
      .sort();
  }
  return result;
}

async function discoverCandidates(root) {
  const candidates = [root];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(root, entry.name));
    }
  } catch {
    return candidates;
  }
  return candidates;
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function emptyMethods() {
  return { clientRequests: [], serverRequests: [], clientNotifications: [], serverNotifications: [], all: [] };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
