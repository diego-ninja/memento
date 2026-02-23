# Memento — Memoria persistente para LLMs

## Problema

Los LLMs no tienen memoria entre sesiones. Cada conversación arranca desde cero. `CLAUDE.md` mitiga parcialmente el problema con instrucciones estáticas, pero no captura decisiones, aprendizajes ni contexto evolutivo del proyecto.

## Vision

Un sistema de memoria transparente para Claude (via Claude Code) que:

- Persiste decisiones, aprendizajes, preferencias y contexto entre sesiones
- Comparte conocimiento entre agentes en tiempo real
- Indexa semánticamente el codebase para retrieval inteligente
- Funciona de forma invisible para el usuario — Claude decide cuándo guardar y consultar

## Modelo conceptual

Memento es una **timeline append-only** de memorias. Dos operaciones fundamentales:

- **Remember** (write): Claude extrae memorias estructuradas y las persiste.
- **Recall** (read): Claude consulta la memoria para recuperar contexto relevante.

El usuario nunca interactúa directamente con memento. Claude lo usa por iniciativa propia.

### Tipos de memoria

| Tipo | Ejemplo |
|------|---------|
| `decision` | "Elegimos CQRS porque..." |
| `learning` | "El hook post-session de Claude Code se configura en..." |
| `preference` | "Diego prefiere heurísticas simples sobre clasificación por IA" |
| `context` | "Sesión 2026-02-23: implementamos el MCP server base" |
| `fact` | "El módulo de Recruitment tiene 47 entidades" |

### Estructura de una memoria

```
id, timestamp, project, scope, type, content, tags[], embedding[], session_id
```

La timeline es inmutable. Si una decisión cambia, se añade una nueva memoria. El retrieval prioriza por recencia.

## Arquitectura de integracion

```
+---------------------------------------------+
|              Claude Code Session             |
|                                              |
|  +---------+    +----------------------+     |
|  |  Hooks  |    |  MCP Server Memento  |     |
|  |         |    |                      |     |
|  | pre-init+---->  recall_context()    |     |
|  | post-compact->  remember_extract()  |     |
|  | post-session->  remember_extract()  |     |
|  +---------+    |                      |     |
|                 |  recall() <--Claude  |     |
|                 |  remember_extract()  |     |
|                 |  (intra-session)     |     |
|                 +----------+-----------+     |
|                            |                 |
+----------------------------+-----------------+
                             |
                 +-----------+-----------+
                 |       Redis           |
                 | (RediSearch + vectors) |
                 +-----------+-----------+
                             |
                 +-----------+-----------+
                 |       SQLite          |
                 |  (persistent store)   |
                 +-----------+-----------+

                 +-----------------------+
                 |  Ollama (embeddings)  |
                 +-----------------------+
```

### Tres canales de write

| Canal | Trigger | Scope |
|-------|---------|-------|
| Hook `post-compact` | Automatico (sistema) | Conversacion completa |
| Hook `post-session` | Automatico (sistema) | Conversacion completa |
| Tool `remember_extract` | Claude (instrucciones CLAUDE.md) | Bloque de trabajo reciente |

### Puntos de integracion

1. **Hook `pre-init`** — Al arrancar sesion, carga las N memorias mas relevantes al proyecto y las inyecta como contexto inicial.

2. **Hook `post-compact` / `post-session`** — Cuando la sesion se compacta o termina, el hook pide a Claude que extraiga memorias y las persista.

3. **Tool `recall` (implicito)** — Claude consulta memento por iniciativa propia cuando necesita contexto. Guiado por instrucciones en `CLAUDE.md`.

4. **Tool `remember_extract` (intra-sesion)** — Claude ejecuta extraccion despues de momentos de alto valor semantico (brainstorming, plan aprobado, code review, etc.).

## Motor de busqueda y retrieval

Objetivo: latencia total <100ms para no interrumpir el flujo de conversacion.

### Busqueda en dos fases

**Fase 1 — Redis (hot path, <10ms):**

- RediSearch con indice full-text sobre `content` y `tags`
- Indice vectorial (HNSW) sobre embeddings para busqueda semantica
- Query hibrida: score textual + score vectorial + boost por recencia
- Redis tiene TODAS las memorias cargadas — es el motor principal, no cache

**Fase 2 — Reranking local:**

- Top-K resultados de Redis (20) se reranquean
- Criterios: relevancia semantica x recencia x tipo de memoria
- `decision` recientes pesan mas que `context` antiguos
- Contradicciones: solo sube la memoria mas reciente

### Esquema del indice en Redis

```
MEMORY:{id}
  content:    "Elegimos Redis + SQLite porque..."
  type:       "decision"
  project:    "memento"
  scope:      "project" | "global"
  tags:       ["storage", "architecture"]
  embedding:  [0.23, -0.11, ...]  (float32[])
  timestamp:  1708700000
  session_id: "abc-123"
```

```
FT.CREATE idx:memories ON HASH PREFIX 1 MEMORY:
  SCHEMA
    content   TEXT WEIGHT 1.0
    type      TAG
    project   TAG
    scope     TAG
    tags      TAG
    embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 768 DISTANCE_METRIC COSINE
    timestamp NUMERIC SORTABLE
```

### Flujo de un recall automatico

```
1. Claude necesita contexto -> genera query natural
2. MCP genera embedding con Ollama (~50ms)
3. Hybrid search en Redis: FT.SEARCH con vector + text (~5ms)
4. Rerank top-20 -> devuelve top-5 memorias
5. Claude incorpora el contexto y continua
```

Latencia total estimada: ~60ms.

## Write path — Extraccion de memorias

### Triggers automaticos (hooks)

Los hooks `post-compact` y `post-session` llaman a `remember_extract({ scope: "full" })`. El MCP pasa a Claude un prompt de extraccion:

```
Analiza esta conversacion y extrae memorias relevantes.
Para cada memoria devuelve:
- type: decision | learning | preference | context | fact
- content: descripcion concisa (1-3 frases)
- tags: palabras clave relevantes

Prioriza:
- Decisiones tomadas y su razonamiento
- Errores encontrados y como se resolvieron
- Preferencias del usuario expresadas o inferidas
- Hechos descubiertos sobre el codebase

NO extraigas:
- Detalles de implementacion que estan en el codigo
- Conversacion trivial o saludos
- Informacion que ya existe en CLAUDE.md
```

### Triggers intra-sesion (Claude)

Claude ejecuta `remember_extract({ scope: "partial", context: "..." })` despues de:

- Completar un brainstorming o sesion de diseno
- Escribir o validar un documento de diseno
- Escribir o validar un plan de implementacion
- Que el usuario apruebe un plan mode (ExitPlanMode aceptado)
- Completar una code review con feedback relevante
- Resolver un bug complejo con aprendizajes reutilizables

### Formato de salida

```json
{
  "memories": [
    {
      "type": "decision",
      "content": "Para memento, elegimos Redis como motor de busqueda principal con SQLite como persistencia.",
      "tags": ["memento", "redis", "sqlite", "architecture"]
    }
  ]
}
```

### Deduplicacion

Antes de persistir, busqueda semantica rapida contra memorias existentes:

- Similitud >0.92: duplicado, no se crea nueva memoria
- Similitud 0.80-0.92: se guarda con `supersedes: {id_anterior}` para reranking
- Similitud <0.80: memoria nueva

## Scope de la memoria

Dos niveles:

- **Global** (`~/.memento/global.db`): Preferencias del usuario, patrones generales. Compartido entre proyectos.
- **Proyecto** (`~/.memento/projects/{hash}/memories.db`): Decisiones arquitectonicas, contexto de sesion, facts del codebase. Aislado por proyecto.

Redis carga ambos niveles. Las queries filtran por `scope` y `project` segun el contexto.

## Stack tecnico

| Componente | Tecnologia |
|------------|------------|
| MCP Server | TypeScript + `@modelcontextprotocol/sdk` |
| Cliente Redis | `ioredis` |
| SQLite | `better-sqlite3` |
| Embeddings | Ollama + `nomic-embed-text` |
| IDs | `nanoid` |
| Runtime | Node.js 20+ |

### Requisitos del sistema

- Node.js 20+
- Redis 7+ con modulo RediSearch
- Ollama con modelo `nomic-embed-text`

## Estructura del proyecto

```
memento/
├── src/
│   ├── server.ts              # MCP server entry point
│   ├── tools/
│   │   ├── recall.ts          # Busqueda semantica en memorias
│   │   ├── remember.ts        # Persistir memorias nuevas
│   │   └── remember-extract.ts # Extraccion LLM de conversacion
│   ├── storage/
│   │   ├── redis.ts           # Indice RediSearch + vectorial
│   │   ├── sqlite.ts          # Persistencia durable
│   │   └── sync.ts            # Dual-write Redis<->SQLite
│   ├── embeddings/
│   │   └── ollama.ts          # Generacion de embeddings
│   ├── search/
│   │   ├── hybrid.ts          # Query hibrida text+vector
│   │   └── reranker.ts        # Reranking por recencia/tipo
│   ├── config.ts              # Configuracion por proyecto/global
│   └── types.ts               # Tipos compartidos
├── hooks/
│   ├── pre-init.sh            # Carga contexto al arrancar sesion
│   ├── post-compact.sh        # Extrae memorias al compactar
│   └── post-session.sh        # Extrae memorias al cerrar
├── scripts/
│   └── setup.sh               # Instala dependencias (Redis, Ollama)
├── package.json
├── tsconfig.json
└── .claude/
    └── settings.json          # Config MCP para Claude Code
```

### Ficheros de datos (fuera del repo)

```
~/.memento/
├── config.json                # Configuracion global
├── global.db                  # SQLite — memorias globales
└── projects/
    └── {project-hash}/
        └── memories.db        # SQLite — memorias del proyecto
```

## Instrucciones CLAUDE.md

Estas instrucciones guian el comportamiento automatico de Claude:

```markdown
# Memento — Memoria persistente

Tienes acceso a un sistema de memoria persistente via MCP (memento).
Usalo de forma transparente — el usuario NO debe notar que consultas
o guardas memorias. No menciones "memento" ni "he consultado mi memoria"
salvo que te pregunten directamente.

## Cuando hacer recall (automatico)

Consulta memento SIEMPRE que:
- Arranques una sesion nueva (el hook pre-init carga contexto,
  pero haz un recall adicional si el usuario plantea un tema especifico)
- Vayas a tomar una decision arquitectonica o de diseno
- El usuario mencione algo que "ya discutimos" o "como la otra vez"
- No estes seguro de una preferencia del usuario
- Trabajes en un modulo/area que no has tocado en esta sesion

NO consultes memento para:
- Preguntas triviales o saludos
- Tareas mecanicas donde el contexto es evidente
- Informacion que ya tienes en la conversacion actual

## Cuando hacer remember-extract (intra-sesion)

Ejecuta remember_extract() inmediatamente despues de:
- Completar un brainstorming o sesion de diseno
- Escribir o validar un documento de diseno (docs/plans/*.md)
- Escribir o validar un plan de implementacion
- Que el usuario apruebe un plan mode (ExitPlanMode aceptado)
- Completar una code review con feedback relevante
- Resolver un bug complejo con aprendizajes reutilizables

## Formato de recall

Cuando hagas recall, formula la query como lenguaje natural
describiendo lo que necesitas saber. Ejemplos:
- "Que decisiones de arquitectura se tomaron para el modulo X?"
- "Que preferencias tiene Diego sobre testing?"
- "Que problemas se encontraron con Redis en este proyecto?"
```
