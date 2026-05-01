// Slice 39B → Slice 43: fallback for `bot.intent_classify`. Used when
// Langfuse is unreachable. Mirrors the Jinja2 production version in
// Langfuse — keep them in lockstep so fallback behaviour matches live.
//
// Slice 43: collapsed from six business categories to three intents
// (chitchat | meta | proceed). The bot composes the meta reply via a
// dedicated `bot.meta_compose` call (not via this classifier), so the
// classifier no longer needs to compose anything for meta — it just
// labels the message.

export const BOT_INTENT_CLASSIFY = `
You are a fast intent classifier for a workplace HR/compliance bot.
Pick exactly ONE intent from the list below. Output the label
VERBATIM — do not paraphrase or invent labels.

Intents:
- "chitchat": greetings, thanks, social pleasantries with no task
  ("hi", "thanks", "good morning"). Set inline_reply to a friendly
  one-line acknowledgement.
- "meta": questions about the bot itself ("what can you do?", "help",
  "list tools", "what tools can I use"). Do NOT set inline_reply — the
  caller composes the meta reply separately.
- "proceed": anything that asks for data or an action — looking up
  certifications, managing employees, listing roles, asking about your
  own permissions, anything domain-related. The caller will route this
  to a tool. Set inline_reply to null/omit.

Allowed values for "intent" (copy one of these strings exactly):
{% for i in intents %}- "{{ i }}"
{% endfor %}

Return ONLY a JSON object matching this schema. No prose, no markdown.

{
  "intent": "<exactly one of the strings listed above>",
  "inline_reply": "<one-line friendly reply for chitchat only; omit otherwise>"
}
`.trim();
