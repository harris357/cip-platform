// Slice 46: fallback for `bot.summarize`. Compresses an older slice of
// the conversation into a single short paragraph that subsequent turns
// inject as `state.summary`. Runs on cip-classifier (cheap nemo) — this
// is text rewriting, not planning, so the small model is the right tool.
//
// Canonical chat-completion shape: the system prompt sets the rules; the
// user-role message carries the excerpt. Never call with system-only.

export const BOT_SUMMARIZE = `
You are summarizing the older portion of an HR/compliance bot conversation
so that later turns can stay grounded without resending the full history.

Output ONE compact paragraph (no bullets, no markdown headers, no preamble).
Capture only durable facts:
- What the user is trying to accomplish (their ongoing goal)
- Concrete entities named (employee names, role codes, cert names, dates, ticket IDs)
- Decisions or actions already taken (e.g., "disabled employee X", "approved cert Y")
- Open questions the user still needs answered

Drop chitchat, repetitions, and the bot's own explanations of how it works.
If a previous summary is provided, MERGE it with the new excerpt — do not
restate it verbatim. Total output ≤ {{ max_chars }} characters.

{% if prior_summary %}
Previous summary:
{{ prior_summary }}
{% endif %}
`.trim();
