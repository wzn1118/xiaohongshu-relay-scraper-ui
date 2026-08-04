const SPECIALISTS = Object.freeze([
  { id: 'researcher', skills: ['explore'], accepts: ['ask', 'analyze'] },
  { id: 'analyst', skills: ['analyze'], accepts: ['analyze', 'build'] },
  { id: 'builder', skills: ['build'], accepts: ['build'] },
  { id: 'verifier', skills: ['verify'], accepts: ['ask', 'analyze', 'build'] },
]);

export class SpecialistRouter {
  constructor({ specialists = SPECIALISTS } = {}) { this.specialists = specialists.map((item) => structuredClone(item)); }
  list() { return structuredClone(this.specialists); }
  route({ mode = 'ask', taskKind = '' } = {}) {
    const accepted = this.specialists.filter((item) => item.accepts.includes(String(mode)));
    const preferred = accepted.find((item) => item.id === String(taskKind)) || accepted[0] || this.specialists[0];
    const verifier = this.specialists.find((item) => item.id === 'verifier');
    return [...new Map([preferred, verifier].filter(Boolean).map((item) => [item.id, item])).values()].map((item) => structuredClone(item));
  }
}

export function createSpecialistRouter(options) { return new SpecialistRouter(options); }
