import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { MementoConfig } from './types.js';

const MEMENTO_DIR = process.env.MEMENTO_DATA_DIR ?? path.join(os.homedir(), '.memento');

const DEFAULT_CONFIG: MementoConfig = {
  dataDir: MEMENTO_DIR,
  ollama: {
    host: process.env.MEMENTO_OLLAMA_HOST ?? 'http://127.0.0.1:11435',
    embeddingModel: 'nomic-embed-text',
    generativeModel: 'qwen2.5:3b',
  },
  search: {
    topK: 20,
    finalK: 3,
    deduplicationThreshold: 0.92,
    mergeThreshold: 0.80,
    rrfK: 60,
  },
  core: {
    promoteAfterRecalls: 3,
    degradeAfterSessions: 30,
  },
  extraction: {
    provider: 'ollama',
    ollama: { model: 'qwen2.5:3b' },
    anthropic: { model: 'claude-haiku-4-5-20251001' },
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

export function getTranscriptDbPath(projectPath: string): string {
  const projectId = getProjectId(projectPath);
  return path.join(MEMENTO_DIR, 'projects', projectId, 'transcripts.db');
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
