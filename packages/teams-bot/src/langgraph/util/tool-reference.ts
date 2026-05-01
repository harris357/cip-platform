// Slice 45: format the candidate tool list as a markdown "Tool reference"
// block, injected into the planner's system prompt as the {{ tool_reference }}
// Jinja2 variable.
//
// This is Channel 2 of the capability-metadata exposure: function-calling
// validation goes via the OpenAI `tools` parameter (Channel 1, in plan.ts);
// operational guidance — whenToUse / whenNotToUse / commonNextTools / output
// shape — lives here. The planner sees BOTH.

import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

interface CapabilityCard {
  whenToUse:       string[] | undefined;
  whenNotToUse:    string[] | undefined;
  commonNextTools: string[] | undefined;
  outputSchema:    unknown;
  sideEffectLevel: string | undefined;
}

export function formatToolReference(tools: McpTool[]): string {
  if (tools.length === 0) {
    return '_(No tools currently available to this user.)_';
  }
  const sections = tools.map(formatOne);
  return sections.join('\n\n');
}

function formatOne(tool: McpTool): string {
  const ann = (tool.annotations as Record<string, unknown> | undefined) ?? {};
  const card: CapabilityCard = {
    whenToUse:       arrayOfStrings(ann['whenToUse']),
    whenNotToUse:    arrayOfStrings(ann['whenNotToUse']),
    commonNextTools: arrayOfStrings(ann['commonNextTools']),
    outputSchema:    ann['outputSchema'],
    sideEffectLevel: typeof ann['sideEffectLevel'] === 'string' ? (ann['sideEffectLevel'] as string) : undefined,
  };

  const lines: string[] = [];
  lines.push(`### ${tool.name}`);
  if (tool.description) {
    // First sentence only, to keep the section compact. Description prose
    // already has the full scope/audience/output detail; we just need the
    // headline here.
    const headline = firstSentence(tool.description);
    lines.push(headline);
  }
  if (card.whenToUse && card.whenToUse.length > 0) {
    lines.push(`- Use when: ${card.whenToUse.map(s => stripPeriod(s)).join('; ')}`);
  }
  if (card.whenNotToUse && card.whenNotToUse.length > 0) {
    lines.push(`- Don't use when: ${card.whenNotToUse.map(s => stripPeriod(s)).join('; ')}`);
  }
  if (card.outputSchema) {
    lines.push(`- Returns: ${describeSchema(card.outputSchema)}`);
  }
  if (card.commonNextTools && card.commonNextTools.length > 0) {
    lines.push(`- Often followed by: ${card.commonNextTools.join(', ')}`);
  }
  if (card.sideEffectLevel === 'write' || card.sideEffectLevel === 'external') {
    lines.push(`- ⚠ ${card.sideEffectLevel.toUpperCase()} action — requires explicit user authorization.`);
  }
  return lines.join('\n');
}

function arrayOfStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

function firstSentence(s: string): string {
  const trimmed = s.trim();
  const dot = trimmed.indexOf('. ');
  if (dot === -1 || dot > 200) return trimmed.slice(0, 200);
  return trimmed.slice(0, dot + 1);
}

function stripPeriod(s: string): string {
  return s.trim().replace(/\.$/, '');
}

/**
 * Render a JSON Schema as a compact one-line description of the return
 * shape. Just enough for the planner to know what fields to forward;
 * not full schema validation — that's the runtime's job.
 */
function describeSchema(schema: unknown): string {
  if (!isObj(schema)) return '<unknown>';
  if (schema['type'] === 'object' && isObj(schema['properties'])) {
    const fields = Object.entries(schema['properties'])
      .slice(0, 6)
      .map(([k, v]) => `${k}${shapeShort(v)}`)
      .join(', ');
    const more = Object.keys(schema['properties']).length > 6 ? ', ...' : '';
    return `{ ${fields}${more} }`;
  }
  if (schema['type'] === 'array') {
    return `[ ${describeSchema(schema['items'])}, ... ]`;
  }
  if (schema['type']) return String(schema['type']);
  return '<unknown>';
}

function shapeShort(v: unknown): string {
  if (!isObj(v)) return '';
  const t = v['type'];
  if (t === 'object') return ': {...}';
  if (t === 'array')  return ': [...]';
  if (Array.isArray(t)) return `: ${t.join('|')}`;
  if (typeof t === 'string') return `: ${t}`;
  return '';
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
