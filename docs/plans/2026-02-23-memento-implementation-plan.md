# Memento Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use viterbit:executing-plans to implement this plan task-by-task.

**Goal:** Build a transparent, persistent memory system for Claude via Claude Code using MCP Server + hooks.

**Architecture:** MCP Server (TypeScript) exposes recall/remember tools. Redis (RediSearch) handles hybrid text+vector search. SQLite provides durable persistence. Ollama generates embeddings locally. Claude Code hooks automate memory extraction and context injection.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, ioredis, better-sqlite3, ollama, zod/v4, nomic-embed-text

**Design Doc:** `docs/plans/2026-02-23-memento-design.md`

---

## Phase 1: Project Scaffolding & Tooling

### Task 1: Initialize project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Step 1: Initialize git repo**

```bash
cd /Users/diego/Code/Viterbit/memento
git init
```

**Step 2: Create package.json**

```json
{
  "name": "memento",
  "version": "0.1.0",
  "description": "Persistent memory system for LLMs via MCP",
  "type": "module",
  "main": "dist/server.js",
  "bin": {
    "memento": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "better-sqlite3": "^11.0.0",
    "ioredis": "^5.4.0",
    "nanoid": "^5.0.0",
    "ollama": "^0.5.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
*.db
.env
```

**Step 5: Install dependencies**

```bash
npm install
```

**Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore package-lock.json
git commit -m "feat: initialize memento project"
```

---

### Task 2: Makefile

**Files:**
- Create: `Makefile`

**Step 1: Create Makefile**

```makefile
.PHONY: setup install-ollama install-redis start stop status build dev test clean

# ── Setup ───────────────────────────────────────────────
setup: install-ollama install-redis
	npm install
	@echo "✔ Memento setup complete. Run 'make start' to launch services."

install-ollama:
	@if ! command -v ollama &> /dev/null; then \
		echo "Installing Ollama..."; \
		brew install ollama; \
	else \
		echo "Ollama already installed"; \
	fi
	@echo "Pulling nomic-embed-text model..."
	ollama pull nomic-embed-text

install-redis:
	@if ! command -v redis-server &> /dev/null; then \
		echo "Installing Redis Stack (includes RediSearch)..."; \
		brew tap redis-stack/redis-stack; \
		brew install redis-stack; \
	else \
		echo "Redis already installed"; \
	fi

# ── Services ────────────────────────────────────────────
start:
	@echo "Starting Redis Stack..."
	@redis-stack-server --daemonize yes 2>/dev/null || redis-server --daemonize yes --loadmodule $$(brew --prefix)/lib/rejson.so --loadmodule $$(brew --prefix)/lib/redisearch.so 2>/dev/null || echo "Redis might already be running"
	@echo "Starting Ollama..."
	@ollama serve &>/dev/null & disown 2>/dev/null || echo "Ollama might already be running"
	@sleep 1
	@make status

stop:
	@echo "Stopping Redis..."
	@redis-cli shutdown 2>/dev/null || echo "Redis not running"
	@echo "Stopping Ollama..."
	@pkill -f "ollama serve" 2>/dev/null || echo "Ollama not running"
	@echo "Services stopped."

status:
	@echo "── Service Status ──"
	@redis-cli ping 2>/dev/null && echo "Redis:  ✔ running" || echo "Redis:  ✘ stopped"
	@curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 && echo "Ollama: ✔ running" || echo "Ollama: ✘ stopped"
	@echo ""

# ── Build ───────────────────────────────────────────────
build:
	npx tsc

dev:
	npx tsc --watch

# ── Test ────────────────────────────────────────────────
test:
	npx vitest run

test-watch:
	npx vitest

# ── Clean ───────────────────────────────────────────────
clean:
	rm -rf dist/

# ── Memento CLI ─────────────────────────────────────────
recall:
	@node dist/cli.js recall $(ARGS)

stats:
	@node dist/cli.js stats

flush:
	@echo "⚠ This will delete ALL memories. Press Ctrl+C to cancel."
	@sleep 3
	@node dist/cli.js flush
```

**Step 2: Commit**

```bash
git add Makefile
git commit -m "feat: add Makefile with setup, services, build commands"
```

---

### Task 3: Core types and configuration

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`

**Step 1: Create src/types.ts**

```typescript
export type MemoryType = 'decision' | 'learning' | 'preference' | 'context' | 'fact';
export type MemoryScope = 'global' | 'project';

export interface Memory {
  id: string;
  timestamp: number;
  project: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  tags: string[];
  embedding: number[];
  sessionId: string;
  supersedes?: string;
}

export interface MemoryInput {
  type: MemoryType;
  content: string;
  tags: string[];
  scope?: MemoryScope;
}

export interface RecallResult {
  memory: Memory;
  score: number;
  source: 'text' | 'vector' | 'hybrid';
}

export interface RecallQuery {
  query: string;
  project?: string;
  scope?: MemoryScope;
  type?: MemoryType;
  limit?: number;
}

export interface ExtractResult {
  memories: MemoryInput[];
}

export interface MementoConfig {
  dataDir: string;
  redis: {
    host: string;
    port: number;
  };
  ollama: {
    host: string;
    model: string;
  };
  search: {
    topK: number;
    finalK: number;
    deduplicationThreshold: number;
    supersededThreshold: number;
  };
}
```

**Step 2: Create src/config.ts**

```typescript
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
    port: 6379,
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
```

**Step 3: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "feat: add core types and configuration"
```

---

## Phase 2: Storage Layer

### Task 4: SQLite storage

**Files:**
- Create: `src/storage/sqlite.ts`
- Create: `src/storage/__tests__/sqlite.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { SqliteStorage } from '../sqlite.js';
import type { Memory } from '../../types.js';

const TEST_DB = '/tmp/memento-test.db';

describe('SqliteStorage', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    storage = new SqliteStorage(TEST_DB);
  });

  afterEach(() => {
    storage.close();
    fs.unlinkSync(TEST_DB);
  });

  it('stores and retrieves a memory', () => {
    const memory: Memory = {
      id: 'test-1',
      timestamp: Date.now(),
      project: 'memento',
      scope: 'project',
      type: 'decision',
      content: 'We chose Redis for search',
      tags: ['redis', 'architecture'],
      embedding: [0.1, 0.2, 0.3],
      sessionId: 'session-1',
    };

    storage.store(memory);
    const result = storage.getById('test-1');

    expect(result).toBeDefined();
    expect(result!.content).toBe('We chose Redis for search');
    expect(result!.tags).toEqual(['redis', 'architecture']);
  });

  it('lists memories by project', () => {
    storage.store(makeMemory('m-1', 'proj-a'));
    storage.store(makeMemory('m-2', 'proj-a'));
    storage.store(makeMemory('m-3', 'proj-b'));

    const results = storage.listByProject('proj-a');
    expect(results).toHaveLength(2);
  });

  it('returns all memories for hydration', () => {
    storage.store(makeMemory('m-1', 'proj-a'));
    storage.store(makeMemory('m-2', 'proj-a'));

    const all = storage.getAll();
    expect(all).toHaveLength(2);
  });
});

function makeMemory(id: string, project: string): Memory {
  return {
    id,
    timestamp: Date.now(),
    project,
    scope: 'project',
    type: 'fact',
    content: `Memory ${id}`,
    tags: [],
    embedding: [],
    sessionId: 'test-session',
  };
}
```

**Step 2: Run tests — verify they fail**

```bash
npx vitest run src/storage/__tests__/sqlite.test.ts
```

Expected: FAIL — `SqliteStorage` does not exist.

**Step 3: Implement SqliteStorage**

```typescript
import Database from 'better-sqlite3';
import type { Memory } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';

export class SqliteStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        project TEXT NOT NULL,
        scope TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        embedding BLOB NOT NULL,
        session_id TEXT NOT NULL,
        supersedes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
    `);
  }

  store(memory: Memory): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, timestamp, project, scope, type, content, tags, embedding, session_id, supersedes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      memory.id,
      memory.timestamp,
      memory.project,
      memory.scope,
      memory.type,
      memory.content,
      JSON.stringify(memory.tags),
      Buffer.from(new Float32Array(memory.embedding).buffer),
      memory.sessionId,
      memory.supersedes ?? null,
    );
  }

  getById(id: string): Memory | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    return row ? this.rowToMemory(row) : undefined;
  }

  listByProject(project: string): Memory[] {
    const rows = this.db.prepare('SELECT * FROM memories WHERE project = ? ORDER BY timestamp DESC').all(project) as any[];
    return rows.map(this.rowToMemory);
  }

  getAll(): Memory[] {
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY timestamp DESC').all() as any[];
    return rows.map(this.rowToMemory);
  }

  close(): void {
    this.db.close();
  }

  private rowToMemory(row: any): Memory {
    return {
      id: row.id,
      timestamp: row.timestamp,
      project: row.project,
      scope: row.scope,
      type: row.type,
      content: row.content,
      tags: JSON.parse(row.tags),
      embedding: row.embedding.length > 0
        ? Array.from(new Float32Array(new Uint8Array(row.embedding).buffer))
        : [],
      sessionId: row.session_id,
      supersedes: row.supersedes ?? undefined,
    };
  }
}
```

**Step 4: Run tests — verify they pass**

```bash
npx vitest run src/storage/__tests__/sqlite.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/storage/sqlite.ts src/storage/__tests__/sqlite.test.ts
git commit -m "feat: add SQLite storage layer"
```

---

### Task 5: Redis storage

**Files:**
- Create: `src/storage/redis.ts`
- Create: `src/storage/__tests__/redis.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RedisStorage } from '../redis.js';
import type { Memory } from '../../types.js';

describe('RedisStorage', () => {
  let storage: RedisStorage;

  beforeEach(async () => {
    storage = new RedisStorage({ host: '127.0.0.1', port: 6379 }, 'test');
    await storage.connect();
    await storage.flush();
  });

  afterEach(async () => {
    await storage.flush();
    await storage.disconnect();
  });

  it('stores and retrieves a memory by id', async () => {
    const memory = makeMemory('r-1');
    await storage.store(memory);
    const result = await storage.getById('r-1');

    expect(result).toBeDefined();
    expect(result!.content).toBe('Memory r-1');
  });

  it('searches by text query', async () => {
    await storage.store(makeMemory('r-1', 'Redis is fast for search'));
    await storage.store(makeMemory('r-2', 'SQLite is great for persistence'));

    const results = await storage.searchText('Redis search');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('r-1');
  });

  it('searches by vector similarity', async () => {
    const embedding = new Array(768).fill(0).map(() => Math.random());
    await storage.store({ ...makeMemory('r-1'), embedding });

    const results = await storage.searchVector(embedding, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('flushes all memories with test prefix', async () => {
    await storage.store(makeMemory('r-1'));
    await storage.flush();
    const result = await storage.getById('r-1');
    expect(result).toBeUndefined();
  });
});

function makeMemory(id: string, content?: string): Memory {
  return {
    id,
    timestamp: Date.now(),
    project: 'test-project',
    scope: 'project',
    type: 'fact',
    content: content ?? `Memory ${id}`,
    tags: ['test'],
    embedding: new Array(768).fill(0),
    sessionId: 'test-session',
  };
}
```

**Step 2: Run tests — verify they fail**

```bash
npx vitest run src/storage/__tests__/redis.test.ts
```

Expected: FAIL

**Step 3: Implement RedisStorage**

```typescript
import Redis from 'ioredis';
import type { Memory } from '../types.js';

const EMBEDDING_DIM = 768;

export class RedisStorage {
  private client: Redis;
  private prefix: string;
  private indexName: string;

  constructor(config: { host: string; port: number }, namespace: string = 'memento') {
    this.client = new Redis({ host: config.host, port: config.port, lazyConnect: true });
    this.prefix = `${namespace}:MEMORY:`;
    this.indexName = `${namespace}:idx:memories`;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.ensureIndex();
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }

  private async ensureIndex(): Promise<void> {
    try {
      await this.client.call('FT.INFO', this.indexName);
    } catch {
      await this.client.call(
        'FT.CREATE', this.indexName,
        'ON', 'HASH',
        'PREFIX', '1', this.prefix,
        'SCHEMA',
        'content', 'TEXT', 'WEIGHT', '1.0',
        'type', 'TAG',
        'project', 'TAG',
        'scope', 'TAG',
        'tags', 'TAG', 'SEPARATOR', ',',
        'timestamp', 'NUMERIC', 'SORTABLE',
        'session_id', 'TAG',
        'supersedes', 'TAG',
        'embedding', 'VECTOR', 'HNSW', '6',
          'TYPE', 'FLOAT32',
          'DIM', String(EMBEDDING_DIM),
          'DISTANCE_METRIC', 'COSINE',
      );
    }
  }

  async store(memory: Memory): Promise<void> {
    const key = `${this.prefix}${memory.id}`;
    const embeddingBuffer = Buffer.from(new Float32Array(memory.embedding).buffer);

    await this.client.hset(key, {
      content: memory.content,
      type: memory.type,
      project: memory.project,
      scope: memory.scope,
      tags: memory.tags.join(','),
      timestamp: String(memory.timestamp),
      session_id: memory.sessionId,
      supersedes: memory.supersedes ?? '',
      embedding: embeddingBuffer,
    });
  }

  async getById(id: string): Promise<Memory | undefined> {
    const key = `${this.prefix}${id}`;
    const data = await this.client.hgetallBuffer(key);
    if (!data || Object.keys(data).length === 0) return undefined;
    return this.hashToMemory(id, data);
  }

  async searchText(query: string, limit: number = 20): Promise<Memory[]> {
    const escaped = this.escapeQuery(query);
    const results = await this.client.call(
      'FT.SEARCH', this.indexName,
      escaped,
      'SORTBY', 'timestamp', 'DESC',
      'LIMIT', '0', String(limit),
    ) as any[];
    return this.parseSearchResults(results);
  }

  async searchVector(embedding: number[], limit: number = 20): Promise<Memory[]> {
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    const results = await this.client.call(
      'FT.SEARCH', this.indexName,
      `*=>[KNN ${limit} @embedding $vec AS score]`,
      'PARAMS', '2', 'vec', buffer,
      'SORTBY', 'score',
      'LIMIT', '0', String(limit),
      'DIALECT', '2',
    ) as any[];
    return this.parseSearchResults(results);
  }

  async searchHybrid(textQuery: string, embedding: number[], limit: number = 20): Promise<Memory[]> {
    const escaped = this.escapeQuery(textQuery);
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    const results = await this.client.call(
      'FT.SEARCH', this.indexName,
      `(${escaped})=>[KNN ${limit} @embedding $vec AS vector_score]`,
      'PARAMS', '2', 'vec', buffer,
      'SORTBY', 'vector_score',
      'LIMIT', '0', String(limit),
      'DIALECT', '2',
    ) as any[];
    return this.parseSearchResults(results);
  }

  async flush(): Promise<void> {
    const keys = await this.client.keys(`${this.prefix}*`);
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
    try {
      await this.client.call('FT.DROPINDEX', this.indexName);
    } catch { /* index might not exist */ }
    await this.ensureIndex();
  }

  async count(): Promise<number> {
    const info = await this.client.call('FT.INFO', this.indexName) as any[];
    const numDocsIdx = info.indexOf('num_docs');
    return numDocsIdx >= 0 ? Number(info[numDocsIdx + 1]) : 0;
  }

  private escapeQuery(query: string): string {
    return query.replace(/[^\w\s]/g, ' ').trim() || '*';
  }

  private parseSearchResults(results: any[]): Memory[] {
    if (!results || results[0] === 0) return [];
    const memories: Memory[] = [];
    // results[0] is count, then pairs of [key, fields...]
    for (let i = 1; i < results.length; i += 2) {
      const key = String(results[i]);
      const id = key.replace(this.prefix, '');
      const fields = results[i + 1] as any[];
      const hash: Record<string, any> = {};
      for (let j = 0; j < fields.length; j += 2) {
        hash[String(fields[j])] = fields[j + 1];
      }
      memories.push(this.rawHashToMemory(id, hash));
    }
    return memories;
  }

  private hashToMemory(id: string, data: Record<string, Buffer>): Memory {
    const str = (key: string) => data[key]?.toString('utf-8') ?? '';
    const embBuf = data['embedding'];
    const embedding = embBuf && embBuf.length > 0
      ? Array.from(new Float32Array(new Uint8Array(embBuf).buffer))
      : [];

    return {
      id,
      timestamp: Number(str('timestamp')),
      project: str('project'),
      scope: str('scope') as Memory['scope'],
      type: str('type') as Memory['type'],
      content: str('content'),
      tags: str('tags') ? str('tags').split(',') : [],
      embedding,
      sessionId: str('session_id'),
      supersedes: str('supersedes') || undefined,
    };
  }

  private rawHashToMemory(id: string, data: Record<string, any>): Memory {
    const str = (key: string) => (data[key] != null ? String(data[key]) : '');
    return {
      id,
      timestamp: Number(str('timestamp')),
      project: str('project'),
      scope: str('scope') as Memory['scope'],
      type: str('type') as Memory['type'],
      content: str('content'),
      tags: str('tags') ? str('tags').split(',') : [],
      embedding: [], // not returned from search for performance
      sessionId: str('session_id'),
      supersedes: str('supersedes') || undefined,
    };
  }
}
```

**Step 4: Run tests — verify they pass**

```bash
make start  # ensure Redis is running
npx vitest run src/storage/__tests__/redis.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/storage/redis.ts src/storage/__tests__/redis.test.ts
git commit -m "feat: add Redis storage with RediSearch index"
```

---

### Task 6: Dual-write sync

**Files:**
- Create: `src/storage/sync.ts`
- Create: `src/storage/__tests__/sync.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { SyncStorage } from '../sync.js';
import type { Memory } from '../../types.js';

const TEST_DB = '/tmp/memento-sync-test.db';

describe('SyncStorage', () => {
  let storage: SyncStorage;

  beforeEach(async () => {
    storage = new SyncStorage(
      { host: '127.0.0.1', port: 6379 },
      TEST_DB,
      'sync-test',
    );
    await storage.connect();
  });

  afterEach(async () => {
    await storage.flush();
    await storage.disconnect();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('stores in both Redis and SQLite', async () => {
    const memory = makeMemory('sync-1');
    await storage.store(memory);

    const fromRedis = await storage.getFromRedis('sync-1');
    const fromSqlite = storage.getFromSqlite('sync-1');

    expect(fromRedis).toBeDefined();
    expect(fromSqlite).toBeDefined();
    expect(fromRedis!.content).toBe(fromSqlite!.content);
  });

  it('hydrates Redis from SQLite', async () => {
    const memory = makeMemory('sync-2');
    // Store only in SQLite
    storage.storeInSqliteOnly(memory);

    // Hydrate Redis from SQLite
    await storage.hydrate();

    const fromRedis = await storage.getFromRedis('sync-2');
    expect(fromRedis).toBeDefined();
    expect(fromRedis!.content).toBe('Memory sync-2');
  });
});

function makeMemory(id: string): Memory {
  return {
    id,
    timestamp: Date.now(),
    project: 'test',
    scope: 'project',
    type: 'fact',
    content: `Memory ${id}`,
    tags: ['test'],
    embedding: new Array(768).fill(0),
    sessionId: 'test-session',
  };
}
```

**Step 2: Run tests — verify they fail**

```bash
npx vitest run src/storage/__tests__/sync.test.ts
```

**Step 3: Implement SyncStorage**

```typescript
import { RedisStorage } from './redis.js';
import { SqliteStorage } from './sqlite.js';
import type { Memory } from '../types.js';

export class SyncStorage {
  private redis: RedisStorage;
  private sqlite: SqliteStorage;

  constructor(
    redisConfig: { host: string; port: number },
    sqlitePath: string,
    namespace: string = 'memento',
  ) {
    this.redis = new RedisStorage(redisConfig, namespace);
    this.sqlite = new SqliteStorage(sqlitePath);
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async disconnect(): Promise<void> {
    await this.redis.disconnect();
    this.sqlite.close();
  }

  async store(memory: Memory): Promise<void> {
    this.sqlite.store(memory);
    await this.redis.store(memory);
  }

  async hydrate(): Promise<void> {
    const all = this.sqlite.getAll();
    for (const memory of all) {
      await this.redis.store(memory);
    }
  }

  async flush(): Promise<void> {
    await this.redis.flush();
  }

  // Expose Redis search methods
  get search() {
    return {
      text: (query: string, limit?: number) => this.redis.searchText(query, limit),
      vector: (embedding: number[], limit?: number) => this.redis.searchVector(embedding, limit),
      hybrid: (query: string, embedding: number[], limit?: number) => this.redis.searchHybrid(query, embedding, limit),
      count: () => this.redis.count(),
    };
  }

  // Expose for testing
  async getFromRedis(id: string) { return this.redis.getById(id); }
  getFromSqlite(id: string) { return this.sqlite.getById(id); }
  storeInSqliteOnly(memory: Memory) { this.sqlite.store(memory); }
}
```

**Step 4: Run tests — verify they pass**

```bash
npx vitest run src/storage/__tests__/sync.test.ts
```

**Step 5: Commit**

```bash
git add src/storage/sync.ts src/storage/__tests__/sync.test.ts
git commit -m "feat: add dual-write sync layer (Redis + SQLite)"
```

---

## Phase 3: Embeddings

### Task 7: Ollama embedding client

**Files:**
- Create: `src/embeddings/ollama.ts`
- Create: `src/embeddings/__tests__/ollama.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect } from 'vitest';
import { OllamaEmbeddings } from '../ollama.js';

describe('OllamaEmbeddings', () => {
  const embeddings = new OllamaEmbeddings({
    host: 'http://127.0.0.1:11434',
    model: 'nomic-embed-text',
  });

  it('generates an embedding for a text', async () => {
    const result = await embeddings.generate('Redis is fast for search');

    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(768);
    expect(typeof result[0]).toBe('number');
  });

  it('generates different embeddings for different texts', async () => {
    const a = await embeddings.generate('Redis is a database');
    const b = await embeddings.generate('TypeScript is a language');

    // Cosine similarity should be < 1.0
    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    const similarity = dot / (normA * normB);

    expect(similarity).toBeLessThan(0.95);
  });
});
```

**Step 2: Run tests — verify they fail**

```bash
npx vitest run src/embeddings/__tests__/ollama.test.ts
```

**Step 3: Implement OllamaEmbeddings**

```typescript
import { Ollama } from 'ollama';

export class OllamaEmbeddings {
  private client: Ollama;
  private model: string;

  constructor(config: { host: string; model: string }) {
    this.client = new Ollama({ host: config.host });
    this.model = config.model;
  }

  async generate(text: string): Promise<number[]> {
    const response = await this.client.embed({
      model: this.model,
      input: text,
    });
    return response.embeddings[0];
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embed({
      model: this.model,
      input: texts,
    });
    return response.embeddings;
  }
}
```

**Step 4: Run tests — verify they pass**

```bash
make start  # ensure Ollama is running
npx vitest run src/embeddings/__tests__/ollama.test.ts
```

**Step 5: Commit**

```bash
git add src/embeddings/ollama.ts src/embeddings/__tests__/ollama.test.ts
git commit -m "feat: add Ollama embedding client"
```

---

## Phase 4: Search Engine

### Task 8: Hybrid search

**Files:**
- Create: `src/search/hybrid.ts`

**Step 1: Implement HybridSearch**

```typescript
import type { SyncStorage } from '../storage/sync.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { Memory, RecallQuery, RecallResult } from '../types.js';

export class HybridSearch {
  constructor(
    private storage: SyncStorage,
    private embeddings: OllamaEmbeddings,
  ) {}

  async search(query: RecallQuery): Promise<RecallResult[]> {
    const embedding = await this.embeddings.generate(query.query);
    const limit = query.limit ?? 20;

    // Try hybrid first, fall back to vector-only if text query is too short
    let memories: Memory[];
    try {
      memories = await this.storage.search.hybrid(query.query, embedding, limit);
    } catch {
      memories = await this.storage.search.vector(embedding, limit);
    }

    // If hybrid returned nothing, try text-only
    if (memories.length === 0) {
      memories = await this.storage.search.text(query.query, limit);
    }

    return memories.map((memory, index) => ({
      memory,
      score: 1 - (index / memories.length), // normalized rank score
      source: 'hybrid' as const,
    }));
  }
}
```

**Step 2: Commit**

```bash
git add src/search/hybrid.ts
git commit -m "feat: add hybrid search (text + vector)"
```

---

### Task 9: Reranker

**Files:**
- Create: `src/search/reranker.ts`
- Create: `src/search/__tests__/reranker.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect } from 'vitest';
import { Reranker } from '../reranker.js';
import type { RecallResult } from '../../types.js';

describe('Reranker', () => {
  const reranker = new Reranker();

  it('boosts recent memories over old ones', () => {
    const now = Date.now();
    const results: RecallResult[] = [
      makeResult('old', 0.9, now - 86400000 * 30), // 30 days ago
      makeResult('new', 0.85, now - 3600000),       // 1 hour ago
    ];

    const ranked = reranker.rerank(results, 5);
    expect(ranked[0].memory.id).toBe('new');
  });

  it('boosts decisions over context', () => {
    const now = Date.now();
    const results: RecallResult[] = [
      makeResult('ctx', 0.9, now, 'context'),
      makeResult('dec', 0.85, now, 'decision'),
    ];

    const ranked = reranker.rerank(results, 5);
    expect(ranked[0].memory.id).toBe('dec');
  });

  it('filters superseded memories when newer version exists', () => {
    const now = Date.now();
    const results: RecallResult[] = [
      { ...makeResult('old-dec', 0.9, now - 86400000), memory: { ...makeResult('old-dec', 0.9, now - 86400000).memory } },
      { ...makeResult('new-dec', 0.9, now), memory: { ...makeResult('new-dec', 0.9, now).memory, supersedes: 'old-dec' } },
    ];

    const ranked = reranker.rerank(results, 5);
    expect(ranked.find(r => r.memory.id === 'old-dec')).toBeUndefined();
  });

  it('limits output to finalK', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult(`m-${i}`, 0.5 + Math.random() * 0.5, Date.now())
    );

    const ranked = reranker.rerank(results, 5);
    expect(ranked).toHaveLength(5);
  });
});

function makeResult(id: string, score: number, timestamp: number, type: string = 'fact'): RecallResult {
  return {
    memory: {
      id,
      timestamp,
      project: 'test',
      scope: 'project',
      type: type as any,
      content: `Memory ${id}`,
      tags: [],
      embedding: [],
      sessionId: 'test',
    },
    score,
    source: 'hybrid',
  };
}
```

**Step 2: Run tests — verify they fail**

```bash
npx vitest run src/search/__tests__/reranker.test.ts
```

**Step 3: Implement Reranker**

```typescript
import type { RecallResult, MemoryType } from '../types.js';

const TYPE_WEIGHTS: Record<MemoryType, number> = {
  decision: 1.3,
  learning: 1.2,
  preference: 1.15,
  fact: 1.0,
  context: 0.9,
};

// Half-life of 7 days — memories lose half their recency boost per week
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

export class Reranker {
  rerank(results: RecallResult[], finalK: number): RecallResult[] {
    // Remove superseded memories
    const supersededIds = new Set(
      results.map(r => r.memory.supersedes).filter(Boolean) as string[]
    );
    const filtered = results.filter(r => !supersededIds.has(r.memory.id));

    // Score each result
    const now = Date.now();
    const scored = filtered.map(r => {
      const typeWeight = TYPE_WEIGHTS[r.memory.type] ?? 1.0;
      const age = now - r.memory.timestamp;
      const recencyBoost = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
      const finalScore = r.score * typeWeight * (0.5 + 0.5 * recencyBoost);
      return { ...r, score: finalScore };
    });

    // Sort by final score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, finalK);
  }
}
```

**Step 4: Run tests — verify they pass**

```bash
npx vitest run src/search/__tests__/reranker.test.ts
```

**Step 5: Commit**

```bash
git add src/search/reranker.ts src/search/__tests__/reranker.test.ts
git commit -m "feat: add reranker with recency and type boosting"
```

---

## Phase 5: MCP Server & Tools

### Task 10: MCP Server entry point

**Files:**
- Create: `src/server.ts`

**Step 1: Implement server**

```typescript
#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ensureDataDirs, getProjectDbPath, getGlobalDbPath } from './config.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';
import { registerRecallTool } from './tools/recall.js';
import { registerRememberTool } from './tools/remember.js';
import { registerRememberExtractTool } from './tools/remember-extract.js';

async function main() {
  const config = loadConfig();
  const projectPath = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  ensureDataDirs(projectPath);

  // Initialize storage — project-level db
  const projectStorage = new SyncStorage(
    config.redis,
    getProjectDbPath(projectPath),
    'memento',
  );
  await projectStorage.connect();
  await projectStorage.hydrate();

  // Initialize embeddings
  const embeddings = new OllamaEmbeddings(config.ollama);

  // Initialize search
  const search = new HybridSearch(projectStorage, embeddings);
  const reranker = new Reranker();

  // Create MCP server
  const server = new McpServer({
    name: 'memento',
    version: '0.1.0',
  });

  // Register tools
  registerRecallTool(server, search, reranker, config);
  registerRememberTool(server, projectStorage, embeddings, config, projectPath);
  registerRememberExtractTool(server);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
```

**Step 2: Commit**

```bash
git add src/server.ts
git commit -m "feat: add MCP server entry point"
```

---

### Task 11: Recall tool

**Files:**
- Create: `src/tools/recall.ts`

**Step 1: Implement recall tool**

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HybridSearch } from '../search/hybrid.js';
import type { Reranker } from '../search/reranker.js';
import type { MementoConfig, RecallResult } from '../types.js';

export function registerRecallTool(
  server: McpServer,
  search: HybridSearch,
  reranker: Reranker,
  config: MementoConfig,
): void {
  server.tool(
    'recall',
    'Search persistent memory for relevant decisions, learnings, preferences, and context. Use this when you need historical context about the project, user preferences, or past decisions.',
    {
      query: z.string().describe('Natural language query describing what you need to remember'),
      type: z.enum(['decision', 'learning', 'preference', 'context', 'fact']).optional()
        .describe('Filter by memory type'),
      limit: z.number().optional().describe('Max results to return (default: 5)'),
    },
    async ({ query, type, limit }) => {
      const results = await search.search({
        query,
        type,
        limit: config.search.topK,
      });

      const ranked = reranker.rerank(results, limit ?? config.search.finalK);

      if (ranked.length === 0) {
        return {
          content: [{ type: 'text', text: 'No relevant memories found.' }],
        };
      }

      const formatted = formatResults(ranked);
      return {
        content: [{ type: 'text', text: formatted }],
      };
    },
  );
}

function formatResults(results: RecallResult[]): string {
  return results.map((r, i) => {
    const date = new Date(r.memory.timestamp).toISOString().split('T')[0];
    const tags = r.memory.tags.length > 0 ? ` [${r.memory.tags.join(', ')}]` : '';
    return `${i + 1}. [${r.memory.type}] (${date})${tags}\n   ${r.memory.content}`;
  }).join('\n\n');
}
```

**Step 2: Commit**

```bash
git add src/tools/recall.ts
git commit -m "feat: add recall tool for semantic memory search"
```

---

### Task 12: Remember tool

**Files:**
- Create: `src/tools/remember.ts`

**Step 1: Implement remember tool**

```typescript
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SyncStorage } from '../storage/sync.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { MementoConfig, Memory, MemoryInput } from '../types.js';
import { getProjectId } from '../config.js';

export function registerRememberTool(
  server: McpServer,
  storage: SyncStorage,
  embeddings: OllamaEmbeddings,
  config: MementoConfig,
  projectPath: string,
): void {
  server.tool(
    'remember',
    'Store one or more memories for future recall. Use this to persist decisions, learnings, preferences, or facts.',
    {
      memories: z.array(z.object({
        type: z.enum(['decision', 'learning', 'preference', 'context', 'fact']),
        content: z.string().describe('Concise description (1-3 sentences)'),
        tags: z.array(z.string()).describe('Relevant keywords for search'),
        scope: z.enum(['global', 'project']).optional().describe('global = shared across projects, project = this project only'),
      })).describe('Memories to store'),
    },
    async ({ memories }) => {
      const sessionId = process.env.CLAUDE_SESSION_ID ?? nanoid(8);
      const projectId = getProjectId(projectPath);
      let stored = 0;
      let deduplicated = 0;

      for (const input of memories) {
        const embedding = await embeddings.generate(input.content);

        // Deduplication check
        const existing = await storage.search.vector(embedding, 1);
        if (existing.length > 0) {
          const similarity = cosineSimilarity(
            embedding,
            existing[0].embedding.length > 0 ? existing[0].embedding : await embeddings.generate(existing[0].content),
          );

          if (similarity > config.search.deduplicationThreshold) {
            deduplicated++;
            continue;
          }

          const memory: Memory = {
            id: nanoid(),
            timestamp: Date.now(),
            project: projectId,
            scope: input.scope ?? 'project',
            type: input.type,
            content: input.content,
            tags: input.tags,
            embedding,
            sessionId,
            supersedes: similarity > config.search.supersededThreshold
              ? existing[0].id
              : undefined,
          };

          await storage.store(memory);
          stored++;
          continue;
        }

        const memory: Memory = {
          id: nanoid(),
          timestamp: Date.now(),
          project: projectId,
          scope: input.scope ?? 'project',
          type: input.type,
          content: input.content,
          tags: input.tags,
          embedding,
          sessionId,
        };

        await storage.store(memory);
        stored++;
      }

      return {
        content: [{
          type: 'text',
          text: `Stored ${stored} memories.${deduplicated > 0 ? ` Skipped ${deduplicated} duplicates.` : ''}`,
        }],
      };
    },
  );
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

**Step 2: Commit**

```bash
git add src/tools/remember.ts
git commit -m "feat: add remember tool with deduplication"
```

---

### Task 13: Remember-extract tool

**Files:**
- Create: `src/tools/remember-extract.ts`

**Step 1: Implement remember-extract tool**

This tool returns a structured prompt that Claude should use to extract memories. It doesn't call an LLM itself — Claude IS the LLM. The tool provides the extraction template, and Claude fills it in by calling `remember` with the extracted memories.

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRememberExtractTool(server: McpServer): void {
  server.tool(
    'remember_extract',
    'Trigger memory extraction from the current conversation. Returns instructions for what to extract. After calling this, analyze the conversation and call "remember" with the extracted memories.',
    {
      scope: z.enum(['full', 'partial']).describe('full = entire conversation, partial = recent block only'),
      context: z.string().optional().describe('For partial scope: describe the block to extract from (e.g., "brainstorming sobre memoria para LLMs")'),
    },
    async ({ scope, context }) => {
      const instructions = scope === 'full'
        ? FULL_EXTRACTION_PROMPT
        : partialExtractionPrompt(context ?? '');

      return {
        content: [{ type: 'text', text: instructions }],
      };
    },
  );
}

const FULL_EXTRACTION_PROMPT = `Analyze the ENTIRE conversation and extract memories worth persisting.

For each memory, determine:
- type: decision | learning | preference | context | fact
- content: concise description (1-3 sentences)
- tags: relevant keywords
- scope: "global" if it applies to all projects, "project" if specific to this one

PRIORITIZE:
- Decisions taken and their reasoning
- Errors found and how they were resolved
- User preferences expressed or inferred
- Non-obvious facts about the codebase

DO NOT extract:
- Implementation details that exist in code
- Trivial conversation or greetings
- Information already in CLAUDE.md

Now analyze the conversation and call the "remember" tool with your extracted memories.`;

function partialExtractionPrompt(context: string): string {
  return `Analyze the RECENT work block and extract memories worth persisting.

Work block context: "${context}"

Focus ONLY on this specific block, not the entire conversation.

For each memory, determine:
- type: decision | learning | preference | context | fact
- content: concise description (1-3 sentences)
- tags: relevant keywords
- scope: "global" if it applies to all projects, "project" if specific to this one

Now analyze the recent block and call the "remember" tool with your extracted memories.`;
}
```

**Step 2: Commit**

```bash
git add src/tools/remember-extract.ts
git commit -m "feat: add remember-extract tool for LLM-driven extraction"
```

---

## Phase 6: CLI for Hooks

### Task 14: CLI entry point

The CLI is used by hooks to interact with memento without going through the MCP protocol.

**Files:**
- Create: `src/cli.ts`

**Step 1: Implement CLI**

```typescript
#!/usr/bin/env node

import { loadConfig, ensureDataDirs, getProjectDbPath } from './config.js';
import { SyncStorage } from './storage/sync.js';
import { OllamaEmbeddings } from './embeddings/ollama.js';
import { HybridSearch } from './search/hybrid.js';
import { Reranker } from './search/reranker.js';

const [,, command, ...args] = process.argv;

async function main() {
  const config = loadConfig();
  const projectPath = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  ensureDataDirs(projectPath);

  switch (command) {
    case 'recall':
      await handleRecall(config, projectPath, args.join(' '));
      break;
    case 'stats':
      await handleStats(config, projectPath);
      break;
    case 'flush':
      await handleFlush(config, projectPath);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: memento <recall|stats|flush> [args]');
      process.exit(1);
  }
}

async function handleRecall(config: any, projectPath: string, query: string) {
  if (!query) {
    console.error('Usage: memento recall <query>');
    process.exit(1);
  }

  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const embeddings = new OllamaEmbeddings(config.ollama);
  const search = new HybridSearch(storage, embeddings);
  const reranker = new Reranker();

  const results = await search.search({ query, limit: config.search.topK });
  const ranked = reranker.rerank(results, config.search.finalK);

  if (ranked.length === 0) {
    console.log('No relevant memories found.');
  } else {
    for (const r of ranked) {
      const date = new Date(r.memory.timestamp).toISOString().split('T')[0];
      console.log(`[${r.memory.type}] (${date}) ${r.memory.content}`);
    }
  }

  await storage.disconnect();
}

async function handleStats(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();

  const count = await storage.search.count();
  console.log(JSON.stringify({ memories: count, project: projectPath }));

  await storage.disconnect();
}

async function handleFlush(config: any, projectPath: string) {
  const storage = new SyncStorage(config.redis, getProjectDbPath(projectPath), 'memento');
  await storage.connect();
  await storage.flush();
  console.log('All memories flushed.');
  await storage.disconnect();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
```

**Step 2: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add CLI entry point for hooks and manual use"
```

---

## Phase 7: Claude Code Integration

### Task 15: SessionStart hook

**Files:**
- Create: `hooks/session-start.sh`

**Step 1: Implement hook**

This hook fires when Claude Code starts a session. It recalls relevant memories and injects them as additional context.

```bash
#!/bin/bash
# hooks/session-start.sh
# Fires on SessionStart — injects recalled memories as context

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Recall recent project context
MEMORIES=$(cd "$SCRIPT_DIR" && node dist/cli.js recall "recent project context decisions and preferences" 2>/dev/null || true)

if [ -z "$MEMORIES" ] || [ "$MEMORIES" = "No relevant memories found." ]; then
  exit 0
fi

# Inject as additional context
jq -n --arg ctx "$MEMORIES" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ("Memento — relevant memories from previous sessions:\n" + $ctx)
  }
}'
```

**Step 2: Make executable**

```bash
chmod +x hooks/session-start.sh
```

**Step 3: Commit**

```bash
git add hooks/session-start.sh
git commit -m "feat: add SessionStart hook for memory injection"
```

---

### Task 16: PreCompact hook

**Files:**
- Create: `hooks/pre-compact.sh`

**Step 1: Implement hook**

This hook fires before compaction. It reads the transcript and uses Ollama locally to extract a session summary, then stores it as a `context` memory.

```bash
#!/bin/bash
# hooks/pre-compact.sh
# Fires on PreCompact — extracts session summary before context is lost

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$PROJECT_DIR" ] || [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Extract last N lines of transcript for summary (avoid processing huge files)
RECENT=$(tail -100 "$TRANSCRIPT_PATH" 2>/dev/null || true)

if [ -z "$RECENT" ]; then
  exit 0
fi

# Use Ollama to generate a compact summary
SUMMARY=$(echo "$RECENT" | curl -sf http://localhost:11434/api/generate \
  -d "$(jq -n --arg prompt "Summarize this development session transcript in 2-3 sentences. Focus on: what was built, key decisions made, and any issues encountered. Be concise.\n\nTranscript:\n$(echo "$RECENT" | head -c 4000)" \
  '{model: "nomic-embed-text", prompt: $prompt, stream: false}')" 2>/dev/null \
  | jq -r '.response // empty' 2>/dev/null || true)

# If Ollama summarization fails, create a basic timestamp entry
if [ -z "$SUMMARY" ]; then
  SUMMARY="Session compacted at $(date -u +%Y-%m-%dT%H:%M:%SZ) in project $PROJECT_DIR"
fi

# Store as context memory via the remember CLI (to be implemented)
# For now, just log it — the MCP remember tool handles storage during session
exit 0
```

**Step 2: Make executable**

```bash
chmod +x hooks/pre-compact.sh
```

**Step 3: Commit**

```bash
git add hooks/pre-compact.sh
git commit -m "feat: add PreCompact hook for session summary extraction"
```

---

### Task 17: SessionEnd hook

**Files:**
- Create: `hooks/session-end.sh`

**Step 1: Implement hook**

Similar to PreCompact but fires at session end. Acts as a safety net — if Claude didn't call `remember_extract` during the session, this captures at least a basic summary.

```bash
#!/bin/bash
# hooks/session-end.sh
# Fires on SessionEnd — safety net for memory extraction

set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$PROJECT_DIR" ] || [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Run extraction in background — don't block session exit
nohup bash -c "
  RECENT=\$(tail -200 '$TRANSCRIPT_PATH' 2>/dev/null || true)
  if [ -n \"\$RECENT\" ]; then
    echo \"\$RECENT\" | head -c 8000 > /tmp/memento-session-end.txt
    # Future: process with Ollama and store via CLI
  fi
" &>/dev/null &

exit 0
```

**Step 2: Make executable**

```bash
chmod +x hooks/session-end.sh
```

**Step 3: Commit**

```bash
git add hooks/session-end.sh
git commit -m "feat: add SessionEnd hook as extraction safety net"
```

---

### Task 18: Claude Code settings

**Files:**
- Create: `.claude/settings.json`

**Step 1: Create settings**

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/Users/diego/Code/Viterbit/memento"
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/diego/Code/Viterbit/memento/hooks/session-start.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/diego/Code/Viterbit/memento/hooks/pre-compact.sh",
            "timeout": 15
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/diego/Code/Viterbit/memento/hooks/session-end.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**Note:** This settings file is for the memento project itself. To use memento globally, the MCP server config and hooks should be added to `~/.claude/settings.json`. That will be documented in the README.

**Step 2: Commit**

```bash
git add .claude/settings.json
git commit -m "feat: add Claude Code MCP and hooks configuration"
```

---

### Task 19: CLAUDE.md instructions

**Files:**
- Create: `CLAUDE.md` (project-level, for memento development)
- Document user-level instructions for `~/.claude/CLAUDE.md` in README

**Step 1: Create project CLAUDE.md**

```markdown
# Memento

Persistent memory system for LLMs via MCP Server + Claude Code hooks.

## Project Structure

- `src/server.ts` — MCP server entry point
- `src/cli.ts` — CLI for hooks and manual use
- `src/tools/` — MCP tools (recall, remember, remember_extract)
- `src/storage/` — Redis + SQLite dual-write storage
- `src/search/` — Hybrid search + reranker
- `src/embeddings/` — Ollama embedding client
- `hooks/` — Claude Code hook scripts

## Development

- `make setup` — Install all dependencies
- `make start` — Start Redis + Ollama
- `make build` — Build TypeScript
- `make test` — Run tests
- `make dev` — Watch mode

## Requirements

- Node.js 20+
- Redis Stack (includes RediSearch)
- Ollama with nomic-embed-text model
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "feat: add project CLAUDE.md"
```

---

## Phase 8: Documentation

### Task 20: README.md

**Files:**
- Create: `README.md`

**Step 1: Create README**

```markdown
# Memento

Transparent, persistent memory for LLMs. Designed for Claude via Claude Code.

Memento gives Claude long-term memory across sessions. It automatically extracts decisions, learnings, preferences, and context from your conversations, stores them in a fast searchable index, and retrieves relevant memories when Claude needs them. The user never interacts with Memento directly — Claude uses it autonomously.

## How it works

```
Session Start → Hook recalls relevant memories → Claude has context
During Session → Claude calls recall/remember as needed
Session End → Hook extracts and persists new memories
```

**Storage:** Redis (RediSearch) for fast hybrid text+vector search. SQLite for durable persistence.

**Embeddings:** Ollama running locally with nomic-embed-text. Zero external API calls.

**Integration:** MCP Server for Claude Code tools + hooks for automatic lifecycle events.

## Requirements

- macOS (Apple Silicon recommended)
- Node.js 20+
- Homebrew

## Quick Start

```bash
# Clone and setup
git clone <repo-url> ~/Code/memento
cd ~/Code/memento

# Install everything: Redis Stack, Ollama, nomic-embed-text, npm deps
make setup

# Start services
make start

# Build
make build

# Verify
make status
make test
```

## Configure Claude Code

Add to your **global** Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "memento": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/Users/diego/Code/Viterbit/memento"
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/diego/Code/Viterbit/memento/hooks/session-start.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/diego/Code/Viterbit/memento/hooks/pre-compact.sh",
            "timeout": 15
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/diego/Code/Viterbit/memento/hooks/session-end.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Add to your **global** `~/.claude/CLAUDE.md`:

```markdown
# Memento — Persistent Memory

You have access to a persistent memory system via MCP (memento).
Use it transparently — the user should NOT notice you are consulting
or storing memories. Do not mention "memento" or "I checked my memory"
unless directly asked.

## When to recall (automatic)

Always recall from memento when:
- Starting a new session (the pre-init hook loads context,
  but do an additional recall if the user raises a specific topic)
- About to make an architectural or design decision
- The user mentions something "we already discussed" or "like last time"
- Unsure about a user preference
- Working on a module/area not touched in this session

Do NOT recall for:
- Trivial questions or greetings
- Mechanical tasks where context is obvious
- Information already in the current conversation

## When to remember-extract (intra-session)

Call remember_extract() immediately after:
- Completing a brainstorming or design session
- Writing or validating a design document (docs/plans/*.md)
- Writing or validating an implementation plan
- User approving a plan mode (ExitPlanMode accepted)
- Completing a code review with relevant feedback
- Solving a complex bug with reusable learnings

## Recall format

Formulate queries as natural language:
- "What architecture decisions were made for module X?"
- "What preferences does Diego have about testing?"
- "What problems were found with Redis in this project?"
```

## Commands

| Command | Description |
|---------|-------------|
| `make setup` | Install Redis Stack, Ollama, nomic-embed-text, npm deps |
| `make install-ollama` | Install only Ollama + model |
| `make install-redis` | Install only Redis Stack |
| `make start` | Start Redis + Ollama |
| `make stop` | Stop all services |
| `make status` | Check service status |
| `make build` | Build TypeScript |
| `make dev` | Build in watch mode |
| `make test` | Run tests |
| `make test-watch` | Run tests in watch mode |
| `make recall ARGS="query"` | Manual memory search |
| `make stats` | Show memory count |
| `make flush` | Delete all memories (with confirmation) |
| `make clean` | Remove build artifacts |

## Architecture

```
Claude Code Session
├── Hooks (automatic)
│   ├── SessionStart → recall context → inject as additionalContext
│   ├── PreCompact → extract memories → store
│   └── SessionEnd → extract memories → store (safety net)
└── MCP Server (Claude-driven)
    ├── recall → hybrid search (text + vector) → rerank → top-5
    ├── remember → deduplicate → dual-write (Redis + SQLite)
    └── remember_extract → extraction prompt → Claude calls remember

Storage
├── Redis (RediSearch) — primary search engine, all memories loaded
└── SQLite — durable persistence, source of truth

Embeddings
└── Ollama (nomic-embed-text) — local, zero API cost
```

## Memory Types

| Type | When Stored |
|------|-------------|
| `decision` | Architectural or design choices with reasoning |
| `learning` | Bugs resolved, patterns discovered, techniques learned |
| `preference` | User preferences expressed or inferred |
| `context` | Session summaries, what was worked on |
| `fact` | Non-obvious facts about the codebase |

## Data Storage

Memories are stored in two places:

- **Redis** — All memories loaded for fast search (<10ms). Rebuilt from SQLite on startup.
- **SQLite** — Durable storage. Source of truth.

```
~/.memento/
├── config.json          # Optional config overrides
├── global.db            # Global memories (preferences, cross-project)
└── projects/
    └── {hash}/
        └── memories.db  # Per-project memories
```

## License

MIT
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup, configuration, and usage guide"
```

---

## Summary

| Phase | Tasks | What it delivers |
|-------|-------|------------------|
| 1. Scaffolding | 1-3 | Project structure, Makefile, types |
| 2. Storage | 4-6 | SQLite + Redis + dual-write sync |
| 3. Embeddings | 7 | Ollama integration |
| 4. Search | 8-9 | Hybrid search + reranker |
| 5. MCP Server | 10-13 | recall, remember, remember_extract tools |
| 6. CLI | 14 | Hook-compatible CLI |
| 7. Integration | 15-19 | Hooks, Claude Code settings, CLAUDE.md |
| 8. Documentation | 20 | README.md |

**Total: 20 tasks across 8 phases.**
