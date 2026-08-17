const SHOWCASE_MODE = 'anonymous-read-only-showcase';
const RESOURCE_ROOT = 'showcase://today-you-applied';

const CAPABILITIES = Object.freeze([
  {
    id: 'collect',
    name: 'Resumable job discovery',
    description: 'Collects keyword and audience-driven leads while preserving checkpoints and prior results.',
  },
  {
    id: 'analyze',
    name: 'Evidence-grounded analysis',
    description: 'Turns persisted job and content records into traceable comparisons, summaries, and decisions.',
  },
  {
    id: 'apply',
    name: 'Application workbench',
    description: 'Prepares role-specific drafts and keeps review, delivery, and status changes under user control.',
  },
  {
    id: 'copilot',
    name: 'Data Copilot',
    description: 'Provides a multi-turn workspace with scoped tools, artifacts, approvals, and recoverable sessions.',
  },
  {
    id: 'mcp',
    name: 'MCP integration',
    description: 'Offers an anonymous showcase plus Grant-bound access to private conversation snapshots.',
  },
]);

const SAMPLE_JOBS = Object.freeze([
  {
    id: 'demo-job-001',
    company: 'Example Technology A',
    role: 'AI Product Manager',
    city: 'Shanghai',
    fitScore: 92,
    tags: ['AI product', 'agent workflow', 'data analysis'],
  },
  {
    id: 'demo-job-002',
    company: 'Example Data B',
    role: 'Data Product Manager',
    city: 'Hangzhou',
    fitScore: 86,
    tags: ['data product', 'analytics', 'B2B'],
  },
  {
    id: 'demo-job-003',
    company: 'Example Growth C',
    role: 'Growth Product Manager',
    city: 'Shenzhen',
    fitScore: 79,
    tags: ['growth', 'experimentation', 'consumer product'],
  },
  {
    id: 'demo-job-004',
    company: 'Example Platform D',
    role: 'Platform Product Manager',
    city: 'Beijing',
    fitScore: 75,
    tags: ['platform', 'workflow', 'enterprise'],
  },
]);

export function createPublicShowcaseService({ version = '', appUrl = '', endpoint = '' } = {}) {
  const overview = Object.freeze({
    product: 'Today, Have You Applied?',
    service: 'xiaohongshu-relay-scraper-mcp',
    version: String(version || ''),
    mode: SHOWCASE_MODE,
    dataClassification: 'synthetic-demo-only',
    appUrl: String(appUrl || ''),
    mcpEndpoint: String(endpoint || ''),
    summary: 'A personal job-search agent for discovery, evidence analysis, application preparation, and controlled execution.',
    privacyBoundary: 'Anonymous access never reads production jobs, conversations, attachments, profiles, credentials, or artifacts.',
    fullAccess: 'A scoped Bearer Grant upgrades the same endpoint to the private, snapshot-bound data plane.',
  });

  const resources = Object.freeze([
    resource('overview', 'Product overview', 'Public product identity, endpoint mode, and privacy boundary.'),
    resource('capabilities', 'Capability catalog', 'Public catalog of the product capabilities exposed for evaluation.'),
    resource('sample-jobs', 'Synthetic job sample', 'Synthetic records used by the public read-only demonstration tools.'),
  ]);

  const tools = Object.freeze([
    {
      name: 'showcase.get_overview',
      description: 'Return the public product overview and privacy boundary.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnlyAnnotations('Get showcase overview'),
    },
    {
      name: 'showcase.search_sample_jobs',
      description: 'Search a small synthetic job dataset by role keyword and city.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 80, description: 'Optional role or skill keyword.' },
          city: { type: 'string', maxLength: 40, description: 'Optional exact city filter.' },
          limit: { type: 'integer', minimum: 1, maximum: 4, default: 4 },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations('Search synthetic jobs'),
    },
    {
      name: 'showcase.build_application_plan',
      description: 'Build a deterministic example application plan without reading private data or calling external services.',
      inputSchema: {
        type: 'object',
        properties: {
          targetRole: { type: 'string', minLength: 1, maxLength: 80, description: 'Target role for the example plan.' },
          city: { type: 'string', maxLength: 40, description: 'Optional target city.' },
          dailyGoal: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        },
        required: ['targetRole'],
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations('Build example application plan'),
    },
  ]);

  return Object.freeze({
    mode: SHOWCASE_MODE,
    instructions: 'Anonymous mode contains synthetic showcase data and read-only deterministic tools. Supply a scoped Bearer Grant for private snapshot access.',
    describe() {
      return {
        ok: true,
        ...clone(overview),
        protocol: 'streamable-http',
        usage: {
          browser: 'This JSON response confirms the public endpoint is ready.',
          mcpClient: 'Connect to this same URL with Streamable HTTP; no token is required for showcase resources and tools.',
          privateData: 'Send Authorization: Bearer <Grant Token> to use Grant-bound private capabilities.',
        },
        resources: resources.map(({ name, uri, description }) => ({ name, uri, description })),
        tools: tools.map(({ name, description }) => ({ name, description })),
      };
    },
    status() {
      return {
        enabled: true,
        mode: SHOWCASE_MODE,
        dataClassification: overview.dataClassification,
        resourceCount: resources.length,
        toolCount: tools.length,
      };
    },
    registerSession() {},
    touchSession() {},
    closeSession() {},
    listResources() {
      return clone(resources);
    },
    async readResource(_context, uri) {
      const value = String(uri || '');
      if (value === `${RESOURCE_ROOT}/overview`) return resourceContents(value, overview);
      if (value === `${RESOURCE_ROOT}/capabilities`) {
        return resourceContents(value, { dataClassification: 'public-product-metadata', capabilities: CAPABILITIES });
      }
      if (value === `${RESOURCE_ROOT}/sample-jobs`) {
        return resourceContents(value, { dataClassification: 'synthetic-demo-only', jobs: SAMPLE_JOBS });
      }
      throw showcaseError('MCP_SHOWCASE_RESOURCE_NOT_FOUND', 'The public showcase resource was not found.');
    },
    listTools() {
      return clone(tools);
    },
    async executeTool(_context, name, args = {}) {
      if (name === 'showcase.get_overview') return clone(overview);
      if (name === 'showcase.search_sample_jobs') return searchSampleJobs(args);
      if (name === 'showcase.build_application_plan') return buildApplicationPlan(args);
      throw showcaseError('MCP_SHOWCASE_TOOL_NOT_FOUND', 'The public showcase tool was not found.');
    },
  });
}

function resource(slug, name, description) {
  return {
    uri: `${RESOURCE_ROOT}/${slug}`,
    name,
    description,
    mimeType: 'application/json',
    annotations: { audience: ['assistant'], priority: 0.8 },
  };
}

function resourceContents(uri, value) {
  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(clone(value), null, 2),
    }],
  };
}

function readOnlyAnnotations(title) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function searchSampleJobs(args) {
  const input = objectInput(args);
  const query = boundedString(input.query, 'query', 80).toLowerCase();
  const city = boundedString(input.city, 'city', 40).toLowerCase();
  const limit = boundedInteger(input.limit, 'limit', 1, 4, 4);
  const matches = SAMPLE_JOBS
    .filter((job) => !city || job.city.toLowerCase() === city)
    .filter((job) => {
      if (!query) return true;
      return [job.role, ...job.tags].some((value) => value.toLowerCase().includes(query));
    })
    .slice(0, limit);
  return {
    dataClassification: 'synthetic-demo-only',
    query: { query, city, limit },
    total: matches.length,
    matches: clone(matches),
    note: 'Results come from an embedded synthetic dataset and do not expose production records.',
  };
}

function buildApplicationPlan(args) {
  const input = objectInput(args);
  const targetRole = boundedString(input.targetRole, 'targetRole', 80, true);
  const city = boundedString(input.city, 'city', 40);
  const dailyGoal = boundedInteger(input.dailyGoal, 'dailyGoal', 1, 20, 5);
  return {
    dataClassification: 'synthetic-demo-only',
    target: { role: targetRole, city: city || 'Any', dailyGoal },
    steps: [
      { order: 1, action: 'Collect and deduplicate role leads', completionSignal: 'Saved leads have source URLs and timestamps.' },
      { order: 2, action: 'Rank evidence against the target role', completionSignal: 'Each shortlisted role has traceable fit evidence.' },
      { order: 3, action: 'Prepare role-specific application drafts', completionSignal: 'Drafts are reviewed before any delivery action.' },
      { order: 4, action: `Review up to ${dailyGoal} applications`, completionSignal: 'Every status change is persisted and recoverable.' },
    ],
    note: 'This deterministic example does not read user profiles, production jobs, or external systems.',
  };
}

function objectInput(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw showcaseError('MCP_SHOWCASE_INPUT_INVALID', 'Tool arguments must be an object.');
  }
  return value;
}

function boundedString(value, field, maximum, required = false) {
  const text = String(value ?? '').trim();
  if (required && !text) throw showcaseError('MCP_SHOWCASE_INPUT_REQUIRED', `${field} is required.`);
  if (text.length > maximum) throw showcaseError('MCP_SHOWCASE_INPUT_INVALID', `${field} must contain at most ${maximum} characters.`);
  return text;
}

function boundedInteger(value, field, minimum, maximum, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw showcaseError('MCP_SHOWCASE_INPUT_INVALID', `${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function showcaseError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}
