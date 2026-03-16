import { describe, it, expect } from 'vitest';
import { parseTranscriptLine, parseTranscript } from '../parse.js';

describe('parseTranscriptLine', () => {
  it('parses a user message', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Hello Claude' },
      timestamp: '2026-03-14T10:00:00.000Z',
    });
    const result = parseTranscriptLine(line);
    expect(result).toBeDefined();
    expect(result!.role).toBe('user');
    expect(result!.content).toBe('Hello Claude');
  });

  it('parses an assistant text message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello! How can I help?' }],
      },
      timestamp: '2026-03-14T10:00:01.000Z',
    });
    const result = parseTranscriptLine(line);
    expect(result).toBeDefined();
    expect(result!.role).toBe('assistant');
    expect(result!.content).toBe('Hello! How can I help?');
  });

  it('parses a thinking block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me consider...' }],
      },
      timestamp: '2026-03-14T10:00:01.000Z',
    });
    const result = parseTranscriptLine(line);
    expect(result).toBeDefined();
    expect(result!.role).toBe('thinking');
  });

  it('parses a tool_use block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/foo/bar.ts' } }],
      },
      timestamp: '2026-03-14T10:00:02.000Z',
    });
    const result = parseTranscriptLine(line);
    expect(result).toBeDefined();
    expect(result!.role).toBe('tool_call');
    expect(result!.content).toContain('Read');
    expect(result!.content).toContain('/foo/bar.ts');
  });

  it('parses a tool_result block', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'file content here' }],
      },
      timestamp: '2026-03-14T10:00:03.000Z',
    });
    const result = parseTranscriptLine(line);
    expect(result).toBeDefined();
    expect(result!.role).toBe('tool_result');
    expect(result!.content).toBe('file content here');
  });

  it('returns null for progress lines', () => {
    const line = JSON.stringify({
      type: 'progress',
      data: { type: 'hook_progress' },
      timestamp: '2026-03-14T10:00:00.000Z',
    });
    expect(parseTranscriptLine(line)).toBeNull();
  });

  it('returns null for file-history-snapshot', () => {
    const line = JSON.stringify({
      type: 'file-history-snapshot',
      snapshot: {},
    });
    expect(parseTranscriptLine(line)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseTranscriptLine('not json at all')).toBeNull();
  });

  it('truncates very long content', () => {
    const longContent = 'x'.repeat(60000);
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: longContent },
      timestamp: '2026-03-14T10:00:00.000Z',
    });
    const result = parseTranscriptLine(line);
    expect(result).toBeDefined();
    expect(result!.content.length).toBeLessThan(longContent.length);
    expect(result!.content).toContain('truncated');
  });
});

describe('parseTranscript', () => {
  it('parses multiple lines and deduplicates streaming', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: '2026-03-14T10:00:00.000Z',
      }),
      // Streaming: partial assistant message
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
        timestamp: '2026-03-14T10:00:01.000Z',
      }),
      // Streaming: final assistant message (longer)
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there, how can I help you today?' }] },
        timestamp: '2026-03-14T10:00:02.000Z',
      }),
    ].join('\n');

    const messages = parseTranscript(lines);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toContain('how can I help'); // kept the longer one
  });

  it('handles empty input', () => {
    expect(parseTranscript('')).toHaveLength(0);
  });

  it('skips non-message lines in mixed input', () => {
    const lines = [
      JSON.stringify({ type: 'progress', data: {} }),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        timestamp: '2026-03-14T10:00:00.000Z',
      }),
    ].join('\n');

    const messages = parseTranscript(lines);
    expect(messages).toHaveLength(1);
  });
});
