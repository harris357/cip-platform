// Slice 45: deterministic 1-line summaries of tool results.
//
// Goal: ~80-char human-readable line that the planner can carry forward
// across a multi-step turn without re-injecting raw tool output. NO LLM
// CALL — pure string formatting.
//
// Slice 61: per-tool switch cases removed (the bot must not embed
// domain-specific tool knowledge). Distillation is now fully generic
// over the MCP envelope shape: refusal -> reason; array -> count;
// object -> field summary; primitive -> typeof. Tools that want richer
// summaries can include a `summary` field in their response envelope
// (read below); the bot uses it verbatim if present.

interface McpEnvelope {
  data?:    unknown;
  message?: string;
  card?:    unknown;
  /** Optional explicit one-line summary; takes precedence when present. */
  summary?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function distillFact(toolName: string, result: unknown): string {
  // MCP tools return { content: [{ type: 'text', text: <JSON> }] }; the
  // executor unwraps to the inner envelope before calling us. If we got
  // the raw MCP shape, parse first.
  const env: McpEnvelope = isMcpResult(result)
    ? parseMcpResult(result)
    : (isObject(result) ? (result as McpEnvelope) : { data: result });

  // Tool-supplied summary wins. Tools opt in by including `summary` in
  // their response envelope; the LLM gets a clean line without the bot
  // having to know the tool's data shape.
  if (typeof env.summary === 'string' && env.summary.length > 0) {
    return `${toolName}: ${env.summary.slice(0, 240)}`;
  }

  // Refusals.
  if (isObject(env.data) && env.data['refused']) {
    return `${toolName} refused: ${env.data['refused']}`;
  }

  // Generic distillation over MCP envelope shape — no per-tool knowledge.
  if (env.data === null || env.data === undefined) {
    return typeof env.message === 'string' && env.message.length > 0
      ? `${toolName}: ${env.message.slice(0, 200)}`
      : `${toolName} returned no data`;
  }
  if (Array.isArray(env.data)) {
    return `${toolName} returned ${env.data.length} item(s)`;
  }
  if (isObject(env.data)) {
    const d    = env.data;
    const keys = Object.keys(d);
    // Common count fields across MCP tools — a tiny, domain-agnostic
    // convention. Tools that want a tight line set `summary` instead.
    if (typeof d['total'] === 'number') return `${toolName}: ${d['total']} item(s)`;
    if (typeof d['count'] === 'number') return `${toolName}: ${d['count']} item(s)`;
    return `${toolName} returned ${keys.length} field(s): ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}`;
  }
  return `${toolName} returned ${typeof env.data}`;
}

function isMcpResult(v: unknown): v is { content: Array<{ type: string; text?: string }> } {
  return isObject(v) && Array.isArray((v as Record<string, unknown>)['content']);
}

function parseMcpResult(v: { content: Array<{ type: string; text?: string }> }): McpEnvelope {
  const text = v.content.find(c => c.type === 'text')?.text;
  if (!text) return {};
  try {
    return JSON.parse(text) as McpEnvelope;
  } catch {
    return {};
  }
}
