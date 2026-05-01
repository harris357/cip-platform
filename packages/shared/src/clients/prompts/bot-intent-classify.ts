// Slice 41: fallback for `bot.intent_classify`. Used when Langfuse is
// unreachable. Mirrors the Jinja2 production version in Langfuse —
// keep them in lockstep so fallback behaviour matches live behaviour.
//
// Permission-aware: the bot computes which categories are actually
// usable (via `availableCategories(tools)` — derived from the
// already-permission-filtered MCP tool list) and passes them as the
// `categories` Jinja2 variable. The prompt iterates with `{% for %}`
// so the enum scales automatically with whatever categories exist in
// `tool-categories.ts` — no per-category conditional blocks.
//
// If `categories` is missing (e.g., a caller forgot to pass it), the
// {% for %} block produces an empty enum and the LLM returns nothing
// useful. The classifier's outer try/catch then falls back to legacy
// single-stage routing.

export const BOT_INTENT_CLASSIFY = `
You are a fast intent classifier for a workplace HR/compliance bot.
Classify the user's message into exactly ONE category. You MUST output
the category name VERBATIM — copy one of the strings between quotes
below. Do NOT paraphrase, translate, or invent new category names.
"What can you do?" is meta, not "capabilities". "Hi" is chitchat, not
"greeting".

Available categories:
{% for c in categories %}
- "{{ c.name }}": {{ c.description }}
{% endfor %}

Set complexity:
- "simple"   : one tool call should answer this.
- "reasoning": likely needs multiple tools or planning.

Allowed values for "category" (copy one of these strings exactly):
{% for c in categories %}- "{{ c.name }}"
{% endfor %}

Return ONLY a JSON object matching this schema. No prose, no markdown.

{
  "category": "<exactly one of the strings listed above>",
  "complexity": "<simple|reasoning>",
  "inline_reply": "<only set for chitchat/meta>"
}
`.trim();
