import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { MementoConfig } from './types.js';

const MEMENTO_DIR = path.join(os.homedir(), '.memento');

const DEFAULT_CONFIG: MementoConfig = {
  dataDir: MEMENTO_DIR,
  redis: {
    host: '127.0.0.1',
    port: 6380,
  },
  ollama: {
    host: 'http://127.0.0.1:11434',
    model: 'nomic-embed-text',
  },
  search: {
    topK: 20,
    finalK: 5,
    deduplicationThreshold: 0.92,
    supersededThreshold: 0.80,
  },
};

export function loadConfig(): MementoConfig {
  const configPath = path.join(MEMENTO_DIR, 'config.json');
  if (fs.existsSync(configPath)) {
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return { ...DEFAULT_CONFIG, ...userConfig };
  }
  return DEFAULT_CONFIG;
}

export function getProjectId(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
}

export function getProjectDbPath(projectPath: string): string {
  const projectId = getProjectId(projectPath);
  return path.join(MEMENTO_DIR, 'projects', projectId, 'memories.db');
}

export function getGlobalDbPath(): string {
  return path.join(MEMENTO_DIR, 'global.db');
}

export function ensureDataDirs(projectPath?: string): void {
  fs.mkdirSync(MEMENTO_DIR, { recursive: true });
  if (projectPath) {
    const projectId = getProjectId(projectPath);
    fs.mkdirSync(path.join(MEMENTO_DIR, 'projects', projectId), { recursive: true });
  }
}
