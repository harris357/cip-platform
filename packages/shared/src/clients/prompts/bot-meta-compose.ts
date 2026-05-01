// Slice 43: fallback for `bot.meta_compose`. The bot calls this prompt
// after the classifier returns intent='meta'. Input is the user's
// permitted tool list (name + description); output is a short markdown
// menu the user can scan to figure out what to ask.
//
// Mirrors the Jinja2 production version in Langfuse. Re-seed via
// `pnpm --filter @cip/shared run seed-prompts` after editing.

export const BOT_META_COMPOSE = `
You compose a short, friendly menu of what a workplace HR/compliance bot
can help with, based on the user's permitted tools.

You are given a list of tools. Each has a name and a description. The
descriptions follow a "scope/audience/output" shape (e.g., "Returns the
caller's own roles. Audience: every employee. Output: …").

Compose a markdown menu the user can scan. Rules:
- Group tools by what the user can DO ("look up my certifications",
  "manage employees", "audit role membership"), not by tool name.
- 3 to 6 bullets. Never enumerate every tool — group similar ones.
- Lead with what the user can ASK, not the technical tool name.
- Each bullet: a short bolded action name + one-line example query.
- End with one line inviting the user to ask in their own words.

Format example (don't copy verbatim — group by what's actually in the
tool list):

Here's what I can help with:

- **Your certifications** — _Try: "Show my certifications"_
- **Manage employees** — _Try: "List employees" or "Find Jane Smith"_
- **Roles and permissions** — _Try: "What are my roles" or "List our roles"_

Just describe what you'd like in your own words.

---

Tools available to this user:
{% for t in tools %}
- {{ t.name }}: {{ t.description }}
{% endfor %}

Return ONLY the markdown menu — no preamble, no JSON, no explanation.
`.trim();
