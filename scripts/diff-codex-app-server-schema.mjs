#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [oldRootArg, newRootArg, outputArg] = process.argv.slice(2);
if (!oldRootArg || !newRootArg) {
  process.stderr.write('Usage: node scripts/diff-codex-app-server-schema.mjs OLD_SCHEMA_DIR NEW_SCHEMA_DIR [OUTPUT_JSON]\n');
  process.exit(2);
}

const oldRoot = path.resolve(oldRootArg);
const newRoot = path.resolve(newRootArg);
const outputPath = outputArg ? path.resolve(outputArg) : null;
const oldSchemas = await readSchemas(oldRoot);
const newSchemas = await readSchemas(newRoot);
const changes = [];

for (const file of [...new Set([...oldSchemas.keys(), ...newSchemas.keys()])].sort()) {
  const before = oldSchemas.get(file);
  const after = newSchemas.get(file);
  if (!before) {
    changes.push(change('schema-added', 'non-breaking', file, '#', null, 'schema'));
    continue;
  }
  if (!after) {
    changes.push(change('schema-removed', 'breaking', file, '#', 'schema', null));
    continue;
  }
  compareNode(before, after, file, '#', changes);
}

for (const envelope of ['ClientRequest.json', 'ServerRequest.json', 'ServerNotification.json', 'ClientNotification.json']) {
  const before = oldSchemas.get(envelope);
  const after = newSchemas.get(envelope);
  if (!before || !after) continue;
  const oldMethods = new Set(extractMethods(before));
  const newMethods = new Set(extractMethods(after));
  for (const method of [...newMethods].filter((value) => !oldMethods.has(value)).sort()) {
    changes.push(change('method-added', 'non-breaking', envelope, '#/oneOf', null, method));
  }
  for (const method of [...oldMethods].filter((value) => !newMethods.has(value)).sort()) {
    changes.push(change('method-removed', 'breaking', envelope, '#/oneOf', method, null));
  }
}

const deduplicated = [...new Map(changes.map((entry) => [JSON.stringify(entry), entry])).values()];
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  oldRoot,
  newRoot,
  summary: {
    oldFiles: oldSchemas.size,
    newFiles: newSchemas.size,
    totalChanges: deduplicated.length,
    breaking: deduplicated.filter((entry) => entry.compatibility === 'breaking').length,
    nonBreaking: deduplicated.filter((entry) => entry.compatibility === 'non-breaking').length,
    review: deduplicated.filter((entry) => entry.compatibility === 'review').length,
  },
  changes: deduplicated,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, 'utf8');
process.stdout.write(serialized);

function compareNode(before, after, file, pointer, output) {
  const oldTypes = normalizeType(before?.type);
  const newTypes = normalizeType(after?.type);
  if (oldTypes.join('|') !== newTypes.join('|')) {
    output.push(change('type-changed', 'breaking', file, pointer, oldTypes, newTypes));
  }

  compareEnum(before?.enum, after?.enum, file, pointer, output);

  const oldProperties = before?.properties && typeof before.properties === 'object' ? before.properties : {};
  const newProperties = after?.properties && typeof after.properties === 'object' ? after.properties : {};
  const oldRequired = new Set(Array.isArray(before?.required) ? before.required : []);
  const newRequired = new Set(Array.isArray(after?.required) ? after.required : []);

  for (const name of Object.keys(newProperties).filter((key) => !(key in oldProperties)).sort()) {
    output.push(change(
      newRequired.has(name) ? 'required-field-added' : 'optional-field-added',
      newRequired.has(name) ? 'breaking' : 'non-breaking',
      file,
      `${pointer}/properties/${escapePointer(name)}`,
      null,
      summarizeSchema(newProperties[name]),
    ));
  }
  for (const name of Object.keys(oldProperties).filter((key) => !(key in newProperties)).sort()) {
    output.push(change(
      'field-removed',
      'breaking',
      file,
      `${pointer}/properties/${escapePointer(name)}`,
      summarizeSchema(oldProperties[name]),
      null,
    ));
  }
  for (const name of Object.keys(oldProperties).filter((key) => key in newProperties).sort()) {
    const childPointer = `${pointer}/properties/${escapePointer(name)}`;
    if (!oldRequired.has(name) && newRequired.has(name)) {
      output.push(change('field-became-required', 'breaking', file, childPointer, false, true));
    }
    if (oldRequired.has(name) && !newRequired.has(name)) {
      output.push(change('field-became-optional', 'non-breaking', file, childPointer, true, false));
    }
    compareNode(oldProperties[name], newProperties[name], file, childPointer, output);
  }

  compareDefinitions(before?.definitions, after?.definitions, file, `${pointer}/definitions`, output);
  compareDefinitions(before?.$defs, after?.$defs, file, `${pointer}/$defs`, output);

  for (const keyword of ['items', 'additionalProperties']) {
    if (isSchema(before?.[keyword]) && isSchema(after?.[keyword])) {
      compareNode(before[keyword], after[keyword], file, `${pointer}/${keyword}`, output);
    }
  }
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    const oldVariants = Array.isArray(before?.[keyword]) ? before[keyword] : [];
    const newVariants = Array.isArray(after?.[keyword]) ? after[keyword] : [];
    if (oldVariants.length !== newVariants.length) {
      output.push(change(
        `${keyword}-variant-count-changed`,
        oldVariants.length > newVariants.length ? 'breaking' : 'review',
        file,
        `${pointer}/${keyword}`,
        oldVariants.length,
        newVariants.length,
      ));
    }
    for (let index = 0; index < Math.min(oldVariants.length, newVariants.length); index += 1) {
      compareNode(oldVariants[index], newVariants[index], file, `${pointer}/${keyword}/${index}`, output);
    }
  }
}

function compareDefinitions(before, after, file, pointer, output) {
  const oldDefinitions = before && typeof before === 'object' ? before : {};
  const newDefinitions = after && typeof after === 'object' ? after : {};
  for (const name of Object.keys(newDefinitions).filter((key) => !(key in oldDefinitions)).sort()) {
    output.push(change('definition-added', 'non-breaking', file, `${pointer}/${escapePointer(name)}`, null, 'definition'));
  }
  for (const name of Object.keys(oldDefinitions).filter((key) => !(key in newDefinitions)).sort()) {
    output.push(change('definition-removed', 'breaking', file, `${pointer}/${escapePointer(name)}`, 'definition', null));
  }
  for (const name of Object.keys(oldDefinitions).filter((key) => key in newDefinitions).sort()) {
    compareNode(oldDefinitions[name], newDefinitions[name], file, `${pointer}/${escapePointer(name)}`, output);
  }
}

function compareEnum(before, after, file, pointer, output) {
  const oldValues = Array.isArray(before) ? before.map(stableValue) : [];
  const newValues = Array.isArray(after) ? after.map(stableValue) : [];
  const oldSet = new Set(oldValues);
  const newSet = new Set(newValues);
  for (const value of newValues.filter((entry) => !oldSet.has(entry)).sort()) {
    output.push(change('enum-value-added', 'non-breaking', file, `${pointer}/enum`, null, JSON.parse(value)));
  }
  for (const value of oldValues.filter((entry) => !newSet.has(entry)).sort()) {
    output.push(change('enum-value-removed', 'breaking', file, `${pointer}/enum`, JSON.parse(value), null));
  }
}

async function readSchemas(root) {
  const schemas = new Map();
  for (const filePath of await listFiles(root)) {
    if (!filePath.endsWith('.json')) continue;
    const relative = path.relative(root, filePath).replaceAll('\\', '/');
    schemas.set(relative, JSON.parse(await readFile(filePath, 'utf8')));
  }
  return schemas;
}

async function listFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function extractMethods(schema) {
  return [...new Set((schema?.oneOf || [])
    .flatMap((entry) => entry?.properties?.method?.enum || [])
    .map(String))]
    .sort();
}

function change(kind, compatibility, file, pointer, before, after) {
  return { kind, compatibility, file, pointer, before, after };
}

function normalizeType(value) {
  if (Array.isArray(value)) return [...value].map(String).sort();
  return value == null ? [] : [String(value)];
}

function summarizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  return {
    type: schema.type ?? null,
    ref: schema.$ref ?? null,
    enum: schema.enum ?? null,
  };
}

function isSchema(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  return JSON.stringify(value);
}

function escapePointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}
