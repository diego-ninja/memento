# Memento v1.0 — LCM Integration Design

## Vision

Fusionar la arquitectura de Lossless Context Management (LCM) con Memento para crear un sistema de memoria **engine-lite**: no un MCP pasivo, sino un gestor de contexto activo que aprovecha el sistema de hooks de Claude Code como superficie de control.

El sistema opera en **dos capas**:

- **Capa 1 — Transcript Layer (LCM)**: historial inmutable de sesiones con DAG jerárquico de resúmenes, búsqueda regex, drill-down lossless, e ingesta continua en tiempo real.
- **Capa 2 — Knowledge Layer (Memento v0.3)**: conocimiento destilado (decisions, learnings, preferences) con grafo semántico, dedup, y auto-mantenimiento.

La Capa 1 responde "¿qué pasó?" — la Capa 2 responde "¿qué sé?". Juntas, cubren el espectro completo de memoria.

```
                    ┌─────────────────────────────────┐
                    │        Active Context            │
                    │    (lo que Claude ve ahora)       │
                    └──────────┬──────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
┌────────▼────────┐   ┌───────▼───────┐   ┌─────────▼────────┐
│  Core Memories  │   │    Recall     │   │  Transcript      │
│  (auto-inject)  │   │   (search)    │   │  Search (grep)   │
└─────────────────┘   └───────────────┘   └──────────────────┘
         │                     │                     │
┌────────▼─────────────────────▼─────────────────────▼────────┐
│                  Knowledge Layer (v0.3)                      │
│        memories + edges + dedup + merge + diversify          │
├─────────────────────────────────────────────────────────────┤
│                  Transcript Layer (NEW)                      │
│  sessions + messages + summary DAG + grep + artifacts        │
├─────────────────────────────────────────────────────────────┤
│                  Engine-Lite Layer (NEW)                     │
│  real-time ingest + compaction awareness + context recovery  │
└─────────────────────────────────────────────────────────────┘
         │                              │
    ┌────▼────┐                   ┌─────▼─────┐
    │ SQLite  │                   │   Redis   │
    │ (truth) │                   │  (search) │
    └─────────┘                   └───────────┘
```

---

## Architecture: Engine-Lite via Hooks

LCM corre como **engine** — controla el active context directamente. Memento no puede reemplazar a Claude Code, pero los hooks de Claude Code exponen suficiente superficie de control para construir un **engine-lite** que se comporta de forma similar.

### Hook Surface disponible

| Hook | Datos recibidos | Lo que podemos hacer |
|------|----------------|---------------------|
| `UserPromptSubmit` | `prompt`, `transcript_path` | Capturar cada mensaje del usuario en tiempo real |
| `Stop` | `last_assistant_message`, `transcript_path` | Capturar cada respuesta de Claude |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `transcript_path` | Capturar tool calls y resultados |
| `PreCompact` | `trigger`, `transcript_path` | Leer transcript completo, generar summary, inyectarlo |
| `PostCompact` | `compact_summary`, `transcript_path` | Capturar el resumen que Claude Code generó |
| `SessionStart` | `source` (startup\|resume\|clear\|compact), `transcript_path` | Detectar reboot post-compact e inyectar contexto rico |
| `SessionEnd` | `transcript_path` | Ingesta final + build DAG completo |

### Flujo Engine-Lite completo

```
┌──────────────────────────────────────────────────────────────────────┐
│                         SESSION LIFECYCLE                            │
│                                                                      │
│  SessionStart ──────────────────────────────────────────────────┐    │
│  │ source=startup → inject core + session summaries + recall    │    │
│  │ source=compact → inject compaction recovery context          │    │
│  ▼                                                              │    │
│  ┌─────────────────────────────────────────────────────────┐    │    │
│  │                 TURN LOOP (repeats)                      │    │    │
│  │                                                          │    │    │
│  │  UserPromptSubmit ──→ persist to immutable store          │    │    │
│  │         │                                                 │    │    │
│  │         ▼                                                 │    │    │
│  │  [Claude thinks + uses tools]                             │    │    │
│  │         │                                                 │    │    │
│  │  PostToolUse ──→ persist tool_input + tool_response       │    │    │
│  │         │        detect file reads → track artifacts      │    │    │
│  │         ▼                                                 │    │    │
│  │  Stop ──→ persist last_assistant_message                  │    │    │
│  │         └→ update session token estimate                  │    │    │
│  │                                                           │    │    │
│  └───────────────────────────┬──────────────────────────────┘    │    │
│                              │                                   │    │
│                    [context fills up]                             │    │
│                              │                                   │    │
│  PreCompact ──→ read transcript_path                             │    │
│  │              build incremental summary DAG                    │    │
│  │              inject summary as additionalContext               │    │
│  │              (THIS SURVIVES compaction)                        │    │
│  ▼                                                               │    │
│  PostCompact ──→ receive compact_summary                         │    │
│  │               store as DAG node (Claude's perspective)        │    │
│  ▼                                                               │    │
│  SessionStart(source=compact) ──→ inject rich recovery context   │    │
│  │  - Our DAG summary (richer than Claude's compact_summary)     │    │
│  │  - Lost context indicators                                    │    │
│  │  - Reminder of available tools (transcript_grep, expand)      │    │
│  └──→ back to TURN LOOP                                         │    │
│                                                                  │    │
│  SessionEnd ──→ final ingest + build complete DAG (async)        │    │
│                 extract knowledge memories (existing pipeline)    │    │
└──────────────────────────────────────────────────────────────────┘
```

### Diferencia vs. LCM puro

| Capacidad | LCM Engine | Memento Engine-Lite | Gap |
|-----------|-----------|-------------------|-----|
| Persist all messages | Engine intercepts | Hooks capture each turn | Minimal — hooks fire on every turn |
| Swap summaries into context | Direct replacement | Inject via additionalContext in hooks | Summary is additive, not replacement |
| Control compaction timing (τ_soft/τ_hard) | Engine decides | Claude Code decides, we react | We can't prevent compaction, but we make it lossless |
| Lossless retrievability | lcm_expand in sub-agents | transcript_expand as MCP tool | Equivalent |
| Zero-cost continuity | No overhead below threshold | Hooks fire but are fast (<50ms) | Negligible overhead |
| Regex over history | lcm_grep | transcript_grep | Equivalent |
| Large file handling | Exploration summaries | PostToolUse artifact detection | Equivalent |
| Post-compaction recovery | Built-in | SessionStart(source=compact) | Equivalent — we inject richer context |

**Ratio de integración estimado: ~85%**. La única pieza que no podemos replicar es el swap directo de mensajes (reemplazar viejos por summaries en el array de messages). Todo lo demás es alcanzable.

---

## Pareto Tier 1 — Máximo impacto, esfuerzo razonable

### 1.1 Real-Time Ingestion via Hooks

**Concepto LCM**: Todo mensaje se persiste verbatim y nunca se modifica.

**Concepto Engine-Lite**: No esperamos a session-end. Capturamos cada turn en tiempo real.

#### Hooks de ingesta continua

```bash
# hooks/user-prompt.sh — fires on UserPromptSubmit
#!/bin/bash
set -euo pipefail
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$PROMPT" ] || [ -z "$SESSION_ID" ]; then exit 0; fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# Fire-and-forget: persist user message
$CLI ingest-message \
  --session "$SESSION_ID" \
  --role user \
  --content "$PROMPT" \
  2>/dev/null &

exit 0
```

```bash
# hooks/stop.sh — fires on Stop
#!/bin/bash
set -euo pipefail
INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$MESSAGE" ] || [ -z "$SESSION_ID" ]; then exit 0; fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

$CLI ingest-message \
  --session "$SESSION_ID" \
  --role assistant \
  --content "$MESSAGE" \
  2>/dev/null &

exit 0
```

```bash
# hooks/post-tool.sh — fires on PostToolUse
#!/bin/bash
set -euo pipefail
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
TOOL_RESPONSE=$(echo "$INPUT" | jq -c '.tool_response // {}')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$SESSION_ID" ]; then exit 0; fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# Persist tool call + result as two messages
$CLI ingest-message \
  --session "$SESSION_ID" \
  --role tool_call \
  --content "{\"tool\":\"$TOOL_NAME\",\"input\":$TOOL_INPUT}" \
  2>/dev/null &

$CLI ingest-message \
  --session "$SESSION_ID" \
  --role tool_result \
  --content "{\"tool\":\"$TOOL_NAME\",\"result\":$TOOL_RESPONSE}" \
  2>/dev/null &

exit 0
```

#### CLI command: `ingest-message`

```typescript
// src/cli.ts — new command
// memento ingest-message --session <id> --role <role> --content <text>
// Appends a single message to the immutable store with auto-incrementing ordinal
```

**Diseño de ingesta**:

```typescript
// src/transcript/ingest.ts
export function ingestMessage(
  db: TranscriptDb,
  sessionId: string,
  projectId: string,
  role: MessageRole,
  content: string,
): void {
  // Ensure session exists
  db.ensureSession(sessionId, projectId);

  // Get next ordinal for this session
  const ordinal = db.getNextOrdinal(sessionId);

  db.insertMessage({
    id: nanoid(),
    sessionId,
    ordinal,
    role,
    content,
    tokenCount: estimateTokens(content),
    timestamp: Date.now(),
  });
}
```

**Valor**: El immutable store se construye en tiempo real, no solo al final de sesión. Esto permite que pre-compact tenga acceso al historial completo para generar summaries.

#### Consideration: Tool result size

PostToolUse puede incluir tool_responses enormes (file reads de miles de líneas). Para no saturar SQLite:

```typescript
const MAX_TOOL_RESULT_SIZE = 50_000; // chars

function truncateForStorage(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_SIZE) return content;
  return content.slice(0, MAX_TOOL_RESULT_SIZE) +
    `\n[... truncated ${content.length - MAX_TOOL_RESULT_SIZE} chars ...]`;
}
```

Los file reads completos se referencian via artifacts (ver 2.3), no se duplican en messages.

---

### 1.2 Immutable Transcript Store — Data Model

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,             -- session_id from Claude Code
  project TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  total_messages INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  root_summary_id TEXT,            -- FK to summaries (top-level DAG node)
  metadata TEXT                    -- JSON: branch, cwd, model, etc.
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,               -- user | assistant | tool_call | tool_result
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, ordinal)
);

CREATE INDEX idx_messages_session ON messages(session_id, ordinal);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
```

**Storage**: Separate SQLite database per project, alongside memories.db:
`~/.memento/projects/{hash}/transcripts.db`

Separar transcripts de memories evita que la DB de memories (compacta, ~1MB) se infle con transcripts (potencialmente ~500MB).

**Coste**: ~1-5MB por sesión. 100 sesiones = 500MB. Retention policy: auto-delete messages >90 días, mantener summaries.

---

### 1.3 Summary DAG

**Concepto LCM**: DAG jerárquico donde summary nodes comprimen bloques de mensajes, manteniendo punteros lossless a los originales.

```sql
-- Same transcripts.db
CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'leaf' | 'condensed' | 'compact_capture'
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  level INTEGER NOT NULL,          -- 0=leaf, 1+=condensed
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE summary_sources (
  summary_id TEXT NOT NULL,
  source_type TEXT NOT NULL,       -- 'message' | 'summary'
  source_id TEXT NOT NULL,
  PRIMARY KEY (summary_id, source_id),
  FOREIGN KEY (summary_id) REFERENCES summaries(id)
);

CREATE INDEX idx_summary_sources_source ON summary_sources(source_id);
CREATE INDEX idx_summaries_session ON summaries(session_id);
CREATE INDEX idx_summaries_level ON summaries(session_id, level);
```

**Note**: `kind='compact_capture'` es un tipo especial para almacenar el `compact_summary` que Claude Code genera durante compactación (capturado via PostCompact hook). Esto preserva la perspectiva de Claude sobre qué fue importante en lo compactado.

**Construcción del DAG**:

```
Sesión con 200 mensajes:

Nivel 0 (leaf):      Bloques de ~20 mensajes → 10 leaf summaries
Nivel 1 (condensed): Grupos de 3-4 leaves → 3 condensed summaries
Nivel 2 (root):      Condensar los 3 → 1 session summary

Resultado: DAG con 14 nodos, raíz = resumen de toda la sesión
```

```typescript
// src/transcript/summarize.ts
export async function buildSummaryDAG(
  sessionId: string,
  db: TranscriptDb,
  llm: OllamaEmbeddings,
  config: SummaryConfig,
): Promise<void> {
  const messages = db.getMessagesBySession(sessionId);
  if (messages.length === 0) return;

  // Level 0: chunk messages into blocks, summarize each
  const chunks = chunkMessages(messages, config.chunkSize);
  const leafSummaries: Summary[] = [];

  for (const chunk of chunks) {
    const text = chunk.map(m => `[${m.role}] ${m.content}`).join('\n');
    const summary = await escalatedSummarize(text, config.targetTokens, llm);
    const node = db.insertSummary({
      id: nanoid(),
      sessionId,
      kind: 'leaf',
      content: summary,
      tokenCount: estimateTokens(summary),
      level: 0,
    });
    for (const msg of chunk) {
      db.insertSummarySource(node.id, 'message', msg.id);
    }
    leafSummaries.push(node);
  }

  // Level 1+: recursively condense until 1 root
  let currentLevel = leafSummaries;
  let level = 1;
  while (currentLevel.length > 1) {
    const groups = chunkArray(currentLevel, 4);
    const nextLevel: Summary[] = [];
    for (const group of groups) {
      const combined = group.map(s => s.content).join('\n---\n');
      const summary = await escalatedSummarize(combined, config.targetTokens, llm);
      const node = db.insertSummary({
        id: nanoid(),
        sessionId,
        kind: 'condensed',
        content: summary,
        tokenCount: estimateTokens(summary),
        level,
      });
      for (const child of group) {
        db.insertSummarySource(node.id, 'summary', child.id);
      }
      nextLevel.push(node);
    }
    currentLevel = nextLevel;
    level++;
  }

  // Set root summary on session
  if (currentLevel.length === 1) {
    db.setSessionRootSummary(sessionId, currentLevel[0].id);
  }
}
```

**Deterministic Retrievability**: Cada summary incluye inline los IDs de sus fuentes.

```
Session checkpoint: Discussed Redis migration strategy. Decided to keep
RediSearch for vector search and add SQLite FTS5 for transcript search.
Implemented pipeline refactor. [sources: msg_a1b2, msg_c3d4, msg_e5f6]
```

Esto permite que Claude use `transcript_expand` con esos IDs para recuperar el contexto original.

---

### 1.4 Three-Level Escalation

**Concepto LCM**: Garantizar convergencia de summarización con fallback determinista.

```typescript
// src/transcript/escalate.ts
export async function escalatedSummarize(
  content: string,
  targetTokens: number,
  llm: OllamaEmbeddings,
): Promise<string> {
  const inputTokens = estimateTokens(content);

  // Level 1: Normal summary — preserve details
  try {
    const summary = await llm.summarize(content, {
      mode: 'preserve_details',
      maxTokens: targetTokens,
    });
    if (estimateTokens(summary) < inputTokens) return summary;
  } catch { /* fall through */ }

  // Level 2: Aggressive bullet points
  try {
    const summary = await llm.summarize(content, {
      mode: 'bullet_points',
      maxTokens: Math.floor(targetTokens / 2),
    });
    if (estimateTokens(summary) < inputTokens) return summary;
  } catch { /* fall through */ }

  // Level 3: Deterministic truncation (no LLM)
  return deterministicTruncate(content, 512);
}

function deterministicTruncate(content: string, maxTokens: number): string {
  const lines = content.split('\n');
  const keepFirst = Math.ceil(lines.length * 0.3);
  const keepLast = Math.ceil(lines.length * 0.2);
  const truncated = lines.length - keepFirst - keepLast;

  return [
    ...lines.slice(0, keepFirst),
    `[... ${truncated} lines truncated ...]`,
    ...lines.slice(-keepLast),
  ].join('\n').slice(0, maxTokens * 4);
}
```

**Valor**: Nunca falla. Si Ollama está caído o el modelo genera basura, siempre obtenemos un resumen usable. Garantía de convergencia.

---

### 1.5 Compaction Awareness — El corazón del Engine-Lite

**Concepto LCM**: El engine controla compactación con τ_soft/τ_hard.

**Adaptación**: No controlamos cuándo compacta Claude Code, pero dominamos el ciclo completo pre/post con 3 hooks coordinados.

#### Hook 1: PreCompact — Generar y salvar contexto

```bash
# hooks/pre-compact.sh
#!/bin/bash
set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "auto"')

if [ -z "$SESSION_ID" ] || [ -z "$CWD" ]; then exit 0; fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# 1. Build incremental summary from messages ingested so far
SUMMARY=$($CLI checkpoint --session "$SESSION_ID" --trigger "$TRIGGER" 2>/dev/null || true)

if [ -n "$SUMMARY" ] && [ "$SUMMARY" != "No messages to summarize." ]; then
  jq -n --arg ctx "$SUMMARY" '{
    hookSpecificOutput: {
      hookEventName: "PreCompact",
      additionalContext: $ctx
    }
  }'
else
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreCompact",
      additionalContext: "MEMENTO: persist key memories via remember() before compaction."
    }
  }'
fi
```

**CLI `checkpoint`** — La pieza central:

```typescript
// memento checkpoint --session <id> --trigger <manual|auto>
//
// 1. Read all messages for this session from immutable store
// 2. Build leaf summaries for un-summarized messages
// 3. Generate a session-level summary using escalated summarize
// 4. Store the summary DAG nodes (persistent)
// 5. Return formatted context for injection

export async function checkpoint(
  sessionId: string,
  db: TranscriptDb,
  llm: OllamaEmbeddings,
  config: SummaryConfig,
): Promise<string> {
  const messages = db.getMessagesBySession(sessionId);
  if (messages.length === 0) return 'No messages to summarize.';

  // Build summary of un-summarized messages
  const unsummarized = db.getUnsummarizedMessages(sessionId);
  if (unsummarized.length > 0) {
    await buildIncrementalSummaries(sessionId, unsummarized, db, llm, config);
  }

  // Get all leaf summaries for session
  const leaves = db.getSummariesBySession(sessionId, 0);

  // Build session-level summary
  const combined = leaves.map(s => s.content).join('\n---\n');
  const sessionSummary = await escalatedSummarize(combined, 800, llm);

  // Format for injection
  const sourceIds = leaves.map(l => l.id.slice(0, 6)).join(', ');
  return [
    'SESSION CHECKPOINT (Memento — what happened so far):',
    sessionSummary,
    '',
    `[${messages.length} messages, sources: ${sourceIds}]`,
    '',
    'Tools available: transcript_grep(pattern), transcript_expand(id)',
    'Use remember() to persist key decisions/learnings before they are compacted.',
  ].join('\n');
}
```

**Timeout**: El hook tiene 15s (ya configurado). El checkpoint debe completar en <10s:
- Ingesta de mensajes pendientes: ~100ms
- Leaf summaries (Level 2 escalation — bullet points): ~3-5s via Ollama
- Session summary (Level 2): ~2-3s
- Fallback a Level 3 (deterministic truncate) si Ollama es lento: instantáneo

#### Hook 2: PostCompact — Capturar la perspectiva de Claude

```bash
# hooks/post-compact.sh (NEW)
#!/bin/bash
set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
COMPACT_SUMMARY=$(echo "$INPUT" | jq -r '.compact_summary // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$SESSION_ID" ] || [ -z "$COMPACT_SUMMARY" ]; then exit 0; fi

export CLAUDE_PROJECT_DIR="$CWD"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# Store Claude's own compact summary as a special DAG node
$CLI store-compact-summary \
  --session "$SESSION_ID" \
  --summary "$COMPACT_SUMMARY" \
  2>/dev/null || true

exit 0
```

**Valor**: Almacenamos la perspectiva de Claude sobre qué era importante. Cuando Claude vuelve post-compact, podemos combinar nuestra summary (comprensiva) con la suya (lo que Claude consideró relevante).

#### Hook 3: SessionStart(source=compact) — Recuperación post-compactación

```bash
# hooks/session-start.sh (enhanced)
#!/bin/bash
set -euo pipefail

INPUT=$(cat)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty')
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$PROJECT_DIR" ]; then exit 0; fi

export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $SCRIPT_DIR/dist/cli.js"

# 0. Maintain: degrade stale core memories
$CLI maintain 2>/dev/null || true

if [ "$SOURCE" = "compact" ]; then
  # ===== POST-COMPACTION RECOVERY =====
  # Inject rich context to compensate for lost context

  # 1. Our DAG summary (richer than Claude Code's compact)
  DAG_SUMMARY=$($CLI session-summary --session "$SESSION_ID" 2>/dev/null || true)

  # 2. Core memories (always)
  CORE=$($CLI core 2>/dev/null || true)

  OUTPUT=""
  if [ -n "$DAG_SUMMARY" ] && [ "$DAG_SUMMARY" != "No summary available." ]; then
    OUTPUT="== session context (recovered from compaction) ==\n${DAG_SUMMARY}"
  fi
  if [ -n "$CORE" ] && [ "$CORE" != "No core memories." ]; then
    OUTPUT="${OUTPUT}\n\n== core ==\n${CORE}"
  fi
  OUTPUT="${OUTPUT}\n\n== tools ==\nUse transcript_grep(pattern) to search full session history.\nUse transcript_expand(id) to recover original messages from any summary."

  jq -n --arg ctx "$(echo -e "$OUTPUT")" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ("Memento — post-compaction context recovery:\n" + $ctx)
    }
  }'

else
  # ===== NORMAL STARTUP =====

  # 1. Core memories
  CORE=$($CLI core 2>/dev/null || true)

  # 2. Recent session summaries (NEW — from DAG roots)
  SESSIONS=$($CLI sessions --recent 3 --format summary 2>/dev/null || true)

  # 3. Contextual archival recall
  CONTEXT=""
  if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
    CONTEXT=$(head -20 "$PROJECT_DIR/CLAUDE.md" 2>/dev/null | tr '\n' ' ' | cut -c1-200)
  fi
  QUERY="key decisions, preferences and learnings for: ${CONTEXT:-this project}"
  ARCHIVAL=$($CLI recall "$QUERY" 2>/dev/null || true)

  OUTPUT=""
  if [ -n "$CORE" ] && [ "$CORE" != "No core memories." ]; then
    OUTPUT="== core ==\n${CORE}"
  fi
  if [ -n "$SESSIONS" ] && [ "$SESSIONS" != "No recent sessions." ]; then
    OUTPUT="${OUTPUT}\n\n== recent sessions ==\n${SESSIONS}"
  fi
  if [ -n "$ARCHIVAL" ] && [ "$ARCHIVAL" != "No relevant memories found." ]; then
    OUTPUT="${OUTPUT}\n\n== relevant ==\n${ARCHIVAL}"
  fi

  if [ -z "$OUTPUT" ]; then exit 0; fi

  RECALLED=$(echo -e "$OUTPUT" | grep -c '|' || echo "0")
  STATS=$($CLI stats 2>/dev/null || true)
  TOTAL=$(echo "$STATS" | jq -r '.memories // 0' 2>/dev/null || echo "0")
  echo "{\"total\":$TOTAL,\"recalled\":$RECALLED,\"updated\":$(date +%s)}" > "$HOME/.memento-stats"

  jq -n --arg ctx "$(echo -e "$OUTPUT")" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ("Memento — relevant memories from previous sessions:\n" + $ctx)
    }
  }'
fi
```

**Valor**: Post-compactación, Claude recibe un contexto mucho más rico que lo que Claude Code le da nativamente. En vez de solo el `compact_summary`, recibe nuestro DAG summary + core memories + instrucciones de recovery tools.

---

### 1.6 transcript_grep — Regex Search sobre historial completo

**Concepto LCM**: `lcm_grep(pattern, summary_id?)`.

```typescript
server.tool(
  'transcript_grep',
  'Regex search across all past session transcripts. Returns matches grouped by session with summary context.',
  {
    pattern: z.string().describe('Search pattern (substring or regex)'),
    session_id: z.string().optional().describe('Limit to specific session'),
    role: z.enum(['user', 'assistant', 'tool_call', 'tool_result']).optional(),
    limit: z.number().optional().describe('Max results (default: 20)'),
  },
  async ({ pattern, session_id, role, limit }) => {
    const results = db.grepMessages(pattern, {
      sessionId: session_id,
      role,
      limit: limit ?? 20,
    });

    const grouped = groupBySession(results, db);
    return { content: [{ type: 'text', text: formatGrepResults(grouped) }] };
  },
);
```

**Output format**:

```
[session abc123 — 2026-03-14 — "LCM integration design"]
  #42 [user] ...matched line with >>>context<<<...
  #67 [assistant] ...another >>>match<<<...
  (covered by summary sum_x8k2)

[session def456 — 2026-03-10 — "Redis migration"]
  #12 [tool_result] ...>>>match<<<...
```

---

### 1.7 transcript_expand — Drill-down lossless

**Concepto LCM**: `lcm_expand(summary_id)`.

```typescript
server.tool(
  'transcript_expand',
  'Expand a summary into its original messages, or view messages around a position. Lossless recovery.',
  {
    id: z.string().describe('Summary ID, message ID, or session ID'),
    around: z.number().optional().describe('If session ID: message ordinal to center on (+-10 messages)'),
  },
  async ({ id, around }) => {
    // Try as summary first
    const summary = db.getSummary(id);
    if (summary) {
      const messages = db.resolveSummaryToMessages(id);
      return { content: [{ type: 'text', text: formatMessages(messages) }] };
    }

    // Try as session
    const session = db.getSession(id);
    if (session) {
      const messages = db.getMessagesAround(id, around ?? 0, 20);
      return { content: [{ type: 'text', text: formatMessages(messages) }] };
    }

    // Try as message — return surrounding context
    const msg = db.getMessage(id);
    if (msg) {
      const context = db.getMessagesAround(msg.sessionId, msg.ordinal, 20);
      return { content: [{ type: 'text', text: formatMessages(context) }] };
    }

    return { content: [{ type: 'text', text: `ID ${id} not found.` }] };
  },
);
```

---

## Pareto Tier 2 — Alto impacto, esfuerzo moderado

### 2.1 transcript_describe — Metadata inspection

**Concepto LCM**: `lcm_describe(id)`.

```typescript
server.tool(
  'transcript_describe',
  'Get metadata for a session, summary, or artifact without expanding full content.',
  {
    id: z.string().describe('Session ID, summary ID, or artifact ID'),
  },
  async ({ id }) => {
    // Try session
    const session = db.getSession(id);
    if (session) {
      return { content: [{ type: 'text', text: formatSessionMeta(session) }] };
    }
    // Try summary
    const summary = db.getSummary(id);
    if (summary) {
      const children = db.getSummarySources(id);
      return { content: [{ type: 'text', text: formatSummaryMeta(summary, children) }] };
    }
    // Try artifact
    const artifact = db.getArtifact(id);
    if (artifact) {
      return { content: [{ type: 'text', text: formatArtifactMeta(artifact) }] };
    }
    return { content: [{ type: 'text', text: `ID ${id} not found.` }] };
  },
);
```

---

### 2.2 Large Artifact Tracking

**Concepto LCM**: Files grandes se almacenan externamente con exploration summaries.

**Ingesta**: Via PostToolUse hook, cuando `tool_name === 'Read'`:

```typescript
// Detected in post-tool hook or during transcript processing
if (toolName === 'Read' && toolResponse.content) {
  const tokens = estimateTokens(toolResponse.content);
  if (tokens > 1000) { // Only track substantial files
    db.upsertArtifact({
      id: nanoid(),
      sessionId,
      filePath: toolInput.file_path,
      fileType: inferFileType(toolInput.file_path),
      tokenCount: tokens,
      explorationSummary: null, // generated async
      firstSeen: Date.now(),
      lastAccessed: Date.now(),
    });
  }
}
```

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT,
  token_count INTEGER,
  exploration_summary TEXT,
  first_seen INTEGER NOT NULL,
  last_accessed INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_artifacts_path ON artifacts(file_path);
CREATE INDEX idx_artifacts_session ON artifacts(session_id);
```

**Exploration summaries** generadas async post-sesión, type-aware:

| File Type | Strategy |
|-----------|----------|
| Code (.ts, .py, .php) | Function signatures, class hierarchy, imports |
| Data (.json, .csv) | Schema, shape, sample values |
| Config (.yml, .toml) | Key structure, notable values |
| Text (.md, .txt) | LLM-generated summary |

---

### 2.3 Full-Text Search sobre Transcripts (FTS5)

Complemento a grep regex para consultas semánticas.

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

Integrado en `transcript_grep` como fallback cuando el patrón no es regex válido.

---

## Pareto Tier 3 — Impacto medio, esfuerzo significativo

### 3.1 LLM-Map como MCP Tool

**Concepto LCM**: Procesar N items en paralelo, con schema validation y reintentos.

```typescript
server.tool(
  'llm_map',
  'Process items in parallel with a prompt. Engine handles iteration, concurrency, validation.',
  {
    items: z.array(z.string()).describe('Items to process'),
    prompt: z.string().describe('Prompt template. {{item}} is replaced per item.'),
    output_schema: z.record(z.any()).optional(),
    concurrency: z.number().optional().describe('Parallel workers (default: 4)'),
  },
  async ({ items, prompt, output_schema, concurrency }) => {
    const results = await llmMap({
      items, prompt,
      outputSchema: output_schema,
      concurrency: concurrency ?? 4,
      llm,
      maxRetries: 2,
    });
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);
```

### 3.2 Session DAG — Cross-Session Navigation

Edges entre sessions basados en proximidad temporal y overlap semántico.

```sql
CREATE TABLE session_edges (
  source_session TEXT NOT NULL,
  target_session TEXT NOT NULL,
  relationship TEXT NOT NULL,    -- 'continuation' | 'related' | 'references'
  strength REAL NOT NULL,
  PRIMARY KEY (source_session, target_session)
);
```

Detección automática:
- Sesión B inicia <2h después de sesión A (mismo proyecto) → `continuation`
- Memories de sesión B similares a memories de A → `related`

### 3.3 Embedding Index sobre Summary Nodes

Generar embeddings para cada summary node, almacenarlos en Redis.

```
FT.CREATE idx:summaries ON HASH PREFIX 1 summary:
  SCHEMA
    content TEXT
    embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 768 DISTANCE_METRIC COSINE
    session_id TAG
    level NUMERIC
```

Permite búsqueda semántica multi-resolución sobre el historial.

---

## Resumen de Tools MCP (post-integración)

| Tool | Capa | Descripción |
|------|------|-------------|
| `recall` | Knowledge | Búsqueda semántica sobre memories destilados (existente) |
| `remember` | Knowledge | Persistir memories con dedup/merge (existente) |
| `transcript_grep` | Transcript | Regex/FTS search sobre historial completo |
| `transcript_expand` | Transcript | Drill-down lossless: summary → mensajes originales |
| `transcript_describe` | Transcript | Metadata de session, summary, o artifact |
| `llm_map` | Operator | Procesar N items en paralelo con prompt + schema |

## Resumen de Hooks (post-integración)

| Hook | Event | Acción |
|------|-------|--------|
| `session-start.sh` | SessionStart | Inyectar core + session summaries + recovery (si post-compact) |
| `user-prompt.sh` | UserPromptSubmit | Capturar prompt del usuario → immutable store |
| `post-tool.sh` | PostToolUse | Capturar tool calls/results → immutable store + artifact detection |
| `stop.sh` | Stop | Capturar respuesta de Claude → immutable store |
| `pre-compact.sh` | PreCompact | Generar checkpoint summary → inyectar como additionalContext |
| `post-compact.sh` | PostCompact | Capturar compact_summary de Claude → almacenar en DAG |
| `session-end.sh` | SessionEnd | Finalizar sesión + build complete DAG async + extract memories |

---

## Data Model Completo

```
SQLite — memories.db (knowledge layer, compacto):
├── memories          (knowledge layer — existente)
└── memory_edges      (knowledge graph — existente)

SQLite — transcripts.db (transcript layer, puede crecer):
├── sessions          (NEW — metadata de sesiones)
├── messages          (NEW — transcript inmutable)
├── messages_fts      (NEW — FTS5 virtual table)
├── summaries         (NEW — DAG nodes)
├── summary_sources   (NEW — DAG edges, provenance)
└── artifacts         (NEW — large file references)

Redis (search acceleration):
├── idx:memories      (existente — knowledge search)
└── idx:summaries     (NEW — summary embedding search)
```

---

## Hooks Configuration (settings.json)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{ "type": "command", "command": ".../hooks/session-start.sh", "timeout": 10 }]
      },
      {
        "matcher": "compact",
        "hooks": [{ "type": "command", "command": ".../hooks/session-start.sh", "timeout": 10 }]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": ".../hooks/user-prompt.sh", "timeout": 2 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": ".../hooks/post-tool.sh", "timeout": 2 }]
      }
    ],
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": ".../hooks/stop.sh", "timeout": 2 }]
      }
    ],
    "PreCompact": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": ".../hooks/pre-compact.sh", "timeout": 15 }]
      }
    ],
    "PostCompact": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": ".../hooks/post-compact.sh", "timeout": 5 }]
      }
    ],
    "SessionEnd": [
      {
        "matcher": ".*",
        "hooks": [{ "type": "command", "command": ".../hooks/session-end.sh", "timeout": 30 }]
      }
    ]
  }
}
```

---

## Plan de Implementación por Fases

### Fase 1: Immutable Store + Real-Time Ingest
- Crear `transcripts.db` schema (sessions, messages)
- CLI `ingest-message` command
- Hooks: `user-prompt.sh`, `stop.sh`, `post-tool.sh`
- Transcript parser (para ingesta batch desde session-end como fallback)
- Tests: ingest, retrieve, ordinal auto-increment

### Fase 2: Grep + Expand (Killer Features)
- MCP tools: `transcript_grep`, `transcript_expand`
- FTS5 virtual table
- Output formatting (grouped by session, with context)
- Tests: grep patterns, expand resolution, FTS queries

### Fase 3: Summary DAG + Escalation
- `escalatedSummarize` con 3 niveles
- `buildSummaryDAG` — leaf + condensed + root
- `summary_sources` provenance tracking
- CLI `sessions --recent N` command
- Tests: DAG construction, escalation convergence, source resolution

### Fase 4: Compaction Awareness (Engine-Lite Core)
- Enhanced `pre-compact.sh` con checkpoint
- New `post-compact.sh` para capturar compact_summary
- Enhanced `session-start.sh` con source=compact branch
- CLI: `checkpoint`, `session-summary`, `store-compact-summary`
- Tests: checkpoint generation, recovery context, round-trip

### Fase 5: Artifacts + Describe
- Tabla `artifacts` + ingesta desde post-tool hook
- Exploration summaries async (type-aware)
- MCP tool: `transcript_describe`
- Tests: artifact detection, exploration summary generation

### Fase 6: Advanced (Session DAG, LLM-Map, Summary Embeddings)
- Session edges (cross-session navigation)
- LLM-Map operator as MCP tool
- Embedding index sobre summaries en Redis
- Tests: session graph, parallel processing, multi-resolution search

---

## Riesgos y Mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Hooks add latency per turn | Ingesta hooks fire-and-forget (<50ms), no block user |
| PostToolUse fires A LOT | Filter: only persist Read, Write, Bash results; skip internal tools |
| Pre-compact timeout (15s) | Escalation Level 3 (deterministic) if Ollama slow — always completes |
| SQLite contention (multiple hooks writing) | WAL mode + single writer per session (ordinal locking) |
| Transcript DB grows large | Separate DB from memories; retention policy: delete messages >90d, keep summaries |
| Claude Code hook schema changes | Defensive parsing with fallbacks; hooks exit 0 on parse failure |
| Tool result content too large | Truncate at 50K chars for messages; full content tracked via artifacts |

---

## LCM Concept Mapping — Final

| LCM Concept | Memento Implementation | Status |
|-------------|----------------------|--------|
| Immutable Store | messages table + real-time hook ingest | Tier 1 |
| Summary DAG | summaries + summary_sources tables | Tier 1 |
| Three-Level Escalation | escalatedSummarize() | Tier 1 |
| lcm_grep | transcript_grep MCP tool | Tier 1 |
| lcm_expand | transcript_expand MCP tool | Tier 1 |
| lcm_describe | transcript_describe MCP tool | Tier 2 |
| Context Control Loop (τ_soft/τ_hard) | PreCompact + PostCompact + SessionStart(compact) | Tier 1 (adapted) |
| Zero-Cost Continuity | Hooks are fast (<50ms); no overhead on short sessions | Inherent |
| Deterministic Retrievability | Source IDs inline in summaries | Tier 1 |
| Large File Handling | artifacts table + PostToolUse detection | Tier 2 |
| LLM-Map | llm_map MCP tool | Tier 3 |
| Agentic-Map | Not implemented — LLM-Map covers 90% | Excluded |
| Scope-Reduction Invariant | Not needed — Memento doesn't spawn sub-agents | Excluded |
| Atomic context swap | Cannot do — Claude Code controls context | Excluded (mitigated by additionalContext injection) |

**Ratio de integración: ~85%** (11 de 13 conceptos implementados o adaptados, 2 excluidos).
