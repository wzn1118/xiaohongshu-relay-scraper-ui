const DEFAULT_SKILLS = Object.freeze([
  { id: 'explore', modes: ['ask', 'analyze'], tools: ['dataset.profile', 'semantic.search'], description: 'Inspect sources and surface relevant records.' },
  { id: 'analyze', modes: ['analyze'], tools: ['dataset.profile', 'sql.query', 'python.analyze', 'chart.create'], description: 'Run deterministic analysis and produce visual specifications.' },
  { id: 'build', modes: ['build'], tools: ['sql.query', 'python.analyze', 'chart.create', 'report.compose'], description: 'Create reusable analysis artifacts and reports.' },
  { id: 'verify', modes: ['ask', 'analyze', 'build'], tools: [], description: 'Check claims, sources and artifact references before completion.' },
]);

export class SkillRegistry {
  constructor(skills = DEFAULT_SKILLS) {
    this.skills = new Map();
    for (const skill of skills) this.register(skill);
  }

  register(value = {}) {
    const id = String(value.id || '').trim();
    if (!id) throw new TypeError('Skill ID is required.');
    const skill = { id, modes: unique(value.modes), tools: unique(value.tools), description: String(value.description || '') };
    this.skills.set(id, skill);
    return structuredClone(skill);
  }

  get(id) { return structuredClone(this.skills.get(String(id)) || null); }
  list({ mode } = {}) { return [...this.skills.values()].filter((skill) => !mode || skill.modes.includes(String(mode))).map((skill) => structuredClone(skill)); }
  resolve(mode = 'ask') { return this.list({ mode }); }
}

export function createSkillRegistry(skills) { return new SkillRegistry(skills); }
function unique(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))]; }
