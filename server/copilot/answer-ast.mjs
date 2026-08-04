import crypto from 'node:crypto';

export const ANSWER_AST_VERSION = 1;

export const ANSWER_BLOCK_KINDS = Object.freeze([
  'heading', 'paragraph', 'list', 'table', 'code', 'quote', 'callout',
  'chart', 'citation', 'artifact', 'checklist', 'diff', 'tool_summary', 'error',
]);

const BLOCK_KIND_SET = new Set(ANSWER_BLOCK_KINDS);

function text(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function idFor(kind, content, index = 0) {
  const digest = crypto.createHash('sha256').update(`${kind}:${JSON.stringify(content)}:${index}`).digest('hex').slice(0, 16);
  return `block-${digest}`;
}

function normalizeSourceRefs(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';
    return text(item.sourceId || item.id || item.uri || item.label);
  }).filter(Boolean))].slice(0, 100);
}

export function normalizeAnswerBlock(value, index = 0) {
  const kind = BLOCK_KIND_SET.has(value?.kind) ? value.kind : 'paragraph';
  const content = value?.content === undefined ? '' : value.content;
  const normalized = {
    id: text(value?.id) || idFor(kind, content, index),
    kind,
    content,
    claimIds: Array.isArray(value?.claimIds) ? [...new Set(value.claimIds.map(String).filter(Boolean))] : [],
    sourceRefs: normalizeSourceRefs(value?.sourceRefs),
    createdAt: text(value?.createdAt) || new Date().toISOString(),
    provenance: value?.provenance && typeof value.provenance === 'object' ? structuredClone(value.provenance) : null,
  };
  if (kind === 'heading') normalized.level = Math.max(1, Math.min(6, Number(value?.level) || 2));
  if (kind === 'list' || kind === 'checklist') normalized.ordered = value?.ordered === true;
  return normalized;
}

export function normalizeAnswerAst(value, { conversationId = null, runId = null } = {}) {
  const blocks = Array.isArray(value?.blocks)
    ? value.blocks.map((block, index) => normalizeAnswerBlock(block, index))
    : [];
  return {
    schemaVersion: ANSWER_AST_VERSION,
    answerId: text(value?.answerId) || `answer-${crypto.randomUUID()}`,
    conversationId: text(value?.conversationId) || conversationId || null,
    runId: text(value?.runId) || runId || null,
    blocks,
    citations: Array.isArray(value?.citations) ? structuredClone(value.citations).slice(0, 200) : [],
    artifacts: Array.isArray(value?.artifacts) ? structuredClone(value.artifacts).slice(0, 100) : [],
    metadata: value?.metadata && typeof value.metadata === 'object' ? structuredClone(value.metadata) : {},
  };
}

function pushParagraph(blocks, lines) {
  const value = lines.join('\n').trim();
  if (value) blocks.push(normalizeAnswerBlock({ kind: 'paragraph', content: value }, blocks.length));
}

export function answerAstFromText(input, options = {}) {
  const source = String(input ?? '').replace(/\r\n?/gu, '\n');
  const lines = source.split('\n');
  const blocks = [];
  let paragraph = [];
  let index = 0;
  const flush = () => { pushParagraph(blocks, paragraph); paragraph = []; };
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(```+|~~~+)\s*([^\s]*)?\s*$/u.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const codeLines = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`, 'u').test(lines[index])) {
        codeLines.push(lines[index]); index += 1;
      }
      blocks.push(normalizeAnswerBlock({ kind: 'code', content: { language: fence[2] || null, code: codeLines.join('\n') } }, blocks.length));
      index += 1;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flush();
      blocks.push(normalizeAnswerBlock({ kind: 'heading', level: heading[1].length, content: heading[2] }, blocks.length));
      index += 1;
      continue;
    }
    if (/^\s*>/u.test(line)) {
      flush();
      const quote = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/u, '')); index += 1;
      }
      blocks.push(normalizeAnswerBlock({ kind: 'quote', content: quote.join('\n') }, blocks.length));
      continue;
    }
    const tableHeader = /^\s*\|(.+)\|\s*$/u.exec(line);
    const tableDivider = index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(lines[index + 1]);
    if (tableHeader && tableDivider) {
      flush();
      const rows = [];
      const parseRow = (value) => value.replace(/^\s*\||\|\s*$/gu, '').split('|').map((cell) => cell.trim());
      rows.push(parseRow(line)); index += 2;
      while (index < lines.length && /^\s*\|/u.test(lines[index])) { rows.push(parseRow(lines[index])); index += 1; }
      blocks.push(normalizeAnswerBlock({ kind: 'table', content: { headers: rows[0] || [], rows: rows.slice(1) } }, blocks.length));
      continue;
    }
    const listItem = /^\s*([-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)(.+)$/u.exec(line);
    if (listItem) {
      flush();
      const ordered = /^\d/u.test(listItem[1]);
      const checklist = /^\[[ xX]\]/u.test(listItem[1]);
      const items = [];
      while (index < lines.length) {
        const match = /^\s*([-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)(.+)$/u.exec(lines[index]);
        if (!match) break;
        items.push({ text: match[2].trim(), checked: /^\[[xX]\]/u.test(match[1]) }); index += 1;
      }
      blocks.push(normalizeAnswerBlock({ kind: checklist ? 'checklist' : 'list', ordered, content: items }, blocks.length));
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/u.test(line)) { flush(); index += 1; continue; }
    if (!line.trim()) flush(); else paragraph.push(line);
    index += 1;
  }
  flush();
  return normalizeAnswerAst({ ...options, blocks });
}

export function answerAstToText(ast) {
  return normalizeAnswerAst(ast).blocks.map((block) => {
    if (block.kind === 'heading') return `${'#'.repeat(block.level || 2)} ${block.content}`;
    if (block.kind === 'code') return `\`\`\`${block.content?.language || ''}\n${block.content?.code || ''}\n\`\`\``;
    if (block.kind === 'list' || block.kind === 'checklist') return (block.content || []).map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${item.text || item}`).join('\n');
    if (block.kind === 'table') return [block.content.headers, ...(block.content.rows || [])].map((row) => `| ${row.join(' | ')} |`).join('\n');
    return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
  }).filter(Boolean).join('\n\n');
}
