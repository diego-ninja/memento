import type { TranscriptDb, Session } from './db.js';

export interface SessionEdge {
  sourceSession: string;
  targetSession: string;
  relationship: 'continuation' | 'related';
  strength: number;
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function detectSessionEdges(db: TranscriptDb, project: string): SessionEdge[] {
  const sessions = db.getRecentSessions(project, 50);
  if (sessions.length < 2) return [];

  const edges: SessionEdge[] = [];

  // Sort by start time ascending
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    // Continuation: sessions within 2 hours of each other
    const gap = curr.startedAt - (prev.endedAt ?? prev.startedAt);
    if (gap < TWO_HOURS_MS && gap >= 0) {
      edges.push({
        sourceSession: prev.id,
        targetSession: curr.id,
        relationship: 'continuation',
        strength: Math.max(0.5, 1 - gap / TWO_HOURS_MS),
      });
    }
  }

  return edges;
}

export function storeSessionEdges(db: TranscriptDb, edges: SessionEdge[]): number {
  let stored = 0;
  for (const edge of edges) {
    db.insertSessionEdge(edge);
    stored++;
  }
  return stored;
}
