import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRememberExtractTool(server: McpServer): void {
  server.tool(
    'remember_extract',
    'Trigger memory extraction from the current conversation. Returns instructions for what to extract. After calling this, analyze the conversation and call "remember" with the extracted memories.',
    {
      scope: z.enum(['full', 'partial']).describe('full = entire conversation, partial = recent block only'),
      context: z.string().optional().describe('For partial scope: describe the block to extract from'),
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
