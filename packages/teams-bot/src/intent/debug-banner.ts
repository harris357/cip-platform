// Slice 39B: dev-only classifier debug banner.
// When BOT_DEBUG_CLASSIFICATION=true, the bot posts an additional Teams
// message after every reply showing classifier output, Stage 2 alias
// (if any), and per-stage timing. Off by default.

import type { TurnContext } from '@microsoft/agents-hosting';
import type { Classification } from './classifier.js';

interface DebugInput {
  classification: Classification | null;   // null when classifier failed
  alias:          string | null;           // Stage 2 alias used; null if inline or no-tool
  tool:           string | null;           // tool selected; null if inline or no-tool
  timings:        {
    classify: number;
    route?:   number;
    exec?:    number;
    total:    number;
  };
}

function debugEnabled(): boolean {
  return (process.env['BOT_DEBUG_CLASSIFICATION'] ?? '').toLowerCase() === 'true';
}

export async function maybeSendDebugBanner(
  context: TurnContext,
  input:   DebugInput,
): Promise<void> {
  if (!debugEnabled()) return;

  const { classification, alias, tool, timings } = input;
  const lines: string[] = ['🔍 **classifier debug**'];

  if (classification === null) {
    lines.push('• category: _classifier failed — fell back to legacy single-stage routing_');
  } else {
    lines.push(`• category: \`${classification.category}\` (complexity: \`${classification.complexity}\`)`);
    if (classification.inline_reply) {
      lines.push('• inline_reply: yes — Stage 2 skipped');
    }
  }

  if (alias) lines.push(`• stage 2 alias: \`${alias}\``);
  if (tool)  lines.push(`• tool: \`${tool}\``);

  const t = `classify=${timings.classify}ms` +
            (timings.route !== undefined ? ` route=${timings.route}ms` : '') +
            (timings.exec  !== undefined ? ` exec=${timings.exec}ms`   : '') +
            ` total=${timings.total}ms`;
  lines.push(`• timings: ${t}`);

  await context.sendActivity(lines.join('\n'));
}
