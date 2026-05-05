// Slice 58C-FIX — pure ocrText truncation helper.
//
// Truncation happens at the extractor layer (kickoff hard rule #3) so
// downstream consumers (classifier, embedding, sensitivity, per-module
// strategies) all see the same bounded text. Without this, a 5MB
// extracted xlsx could blow up the LLM call site.
//
// We append a `\n…[truncated]` marker so debug logs make it obvious
// when the budget kicked in. The marker is stripped at sensitivity-
// scoring's L1 keyword scan boundaries (it's pure ASCII so it doesn't
// trip the keyword lists).

export const DEFAULT_TOKEN_BUDGET_CHARS = 30_000

export function truncateToBudget(text: string, budgetChars: number = DEFAULT_TOKEN_BUDGET_CHARS): string {
  if (!text) return ''
  if (budgetChars <= 0) return ''
  if (text.length <= budgetChars) return text
  return text.slice(0, budgetChars) + '\n…[truncated]'
}
