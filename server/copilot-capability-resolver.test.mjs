import test from 'node:test';
import assert from 'node:assert/strict';

import { CopilotCapabilityResolver, searchToolCatalog } from './copilot-capability-resolver.mjs';

const CATALOG = [
  tool('tool.search', 'Search tools'),
  tool('tool.describe', 'Describe tools'),
  tool('dataset.list', 'List datasets'),
  tool('records.query', 'Query records'),
  tool('audience.comments', 'Read audience comments'),
  tool('audience.users', 'Read commenting users'),
  tool('audience.coverage', 'Inspect audience collection coverage'),
  tool('expansion.summary', 'Inspect relationship expansion'),
  tool('attachment.parse', 'Parse an uploaded attachment'),
  tool('artifact.create', 'Create an export artifact'),
  tool('email.prepare', 'Prepare an email'),
  tool('email.send', 'Send an approved email'),
];

test('resolver selects audience capabilities while retaining discovery tools', () => {
  const resolver = new CopilotCapabilityResolver({ maximumTools: 8, minimumTools: 6 });
  const selected = resolver.resolve(CATALOG, { query: '分析每个帖子下面的评论和评论用户' });
  const names = selected.map((item) => item.name);

  assert.ok(names.includes('tool.search'));
  assert.ok(names.includes('tool.describe'));
  assert.ok(names.includes('dataset.list'));
  assert.ok(names.includes('audience.comments'));
  assert.ok(names.includes('audience.users'));
  assert.ok(names.includes('audience.coverage'));
  assert.ok(selected.length <= 8);
});

test('resolver retains tools activated by catalog discovery', () => {
  const resolver = new CopilotCapabilityResolver({ maximumTools: 7, minimumTools: 4 });
  const selected = resolver.resolve(CATALOG, {
    query: 'inspect the current data',
    activeToolNames: ['attachment.parse'],
  });
  assert.ok(selected.some((item) => item.name === 'attachment.parse'));
});

test('catalog search ranks export and email capabilities for delivery requests', () => {
  const selected = searchToolCatalog(CATALOG, '导出表格并作为邮件附件发送', { limit: 6 });
  const names = selected.map((item) => item.name);
  assert.ok(names.includes('artifact.create'));
  assert.ok(names.includes('email.prepare'));
  assert.ok(names.includes('email.send'));
});

function tool(name, description) {
  return {
    name,
    description,
    category: name.split('.')[0],
    tags: name.split('.'),
    risk: name === 'email.send' ? 'approval_required' : 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}
