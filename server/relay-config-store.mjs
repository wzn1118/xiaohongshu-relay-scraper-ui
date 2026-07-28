import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export const DEFAULT_RELAY_CONFIG = Object.freeze({
  port: 18792,
  profile: 'chrome',
  autoConnect: true,
});

export class RelayConfigStore {
  constructor({ filePath, defaults = DEFAULT_RELAY_CONFIG }) {
    this.filePath = filePath;
    this.defaults = { ...defaults };
    this.value = { ...this.defaults };
  }

  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.value = normalizeRelayConfig({ ...this.defaults, ...saved });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
    return this.get();
  }

  get() {
    return { ...this.value };
  }

  async update(value = {}) {
    this.value = normalizeRelayConfig({ ...this.value, ...value });
    await this.persist();
    return this.get();
  }

  async persist() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8');
    await rename(temporary, this.filePath);
  }
}

export function normalizeRelayConfig(value = {}) {
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw validation('Relay port must be an integer between 1024 and 65535.');
  }
  const profile = String(value.profile || '').trim();
  if (!/^[\p{L}\p{N}_.-]+$/u.test(profile)) {
    throw validation('Relay profile may contain only letters, numbers, dot, underscore, and hyphen.');
  }
  if (typeof value.autoConnect !== 'boolean') {
    throw validation('Relay auto-connect must be boolean.');
  }
  return { port, profile, autoConnect: value.autoConnect };
}

function validation(message) {
  const error = new Error(message);
  error.code = 'RELAY_CONFIG_VALIDATION';
  return error;
}
