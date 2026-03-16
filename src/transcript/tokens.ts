// Simple token estimator: ~4 chars per token (GPT/Claude average)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
