// Slice 47: slash command dispatcher. Single entry point bot.ts calls
// before any LLM/runtime work happens.
//
// Returns:
//   - SlashCommandResult if the message was a recognized slash command
//     (caller sends the reply and short-circuits the rest of the turn)
//   - null if the message was not a slash command (caller falls through
//     to engine dispatch — legacy or LangGraph)
//
// Recognized-but-not-permitted is a SlashCommandResult, not null —
// returns an explicit "not available" reply instead of silently
// falling through to the LLM (avoids confusing LLM responses to
// typed slashes).

import type { TurnContext } from '@microsoft/agents-hosting';
import { REGISTRY, isPermitted, type SlashCommandResult } from './registry.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

export async function dispatchSlashCommand(args: {
  ctx:      BotAuthContext;
  context:  TurnContext;
  threadId: string;
  text:     string;
}): Promise<SlashCommandResult | null> {
  const normalized = args.text.trim().toLowerCase();
  if (!normalized.startsWith('/')) return null;

  // Find the longest matching prefix — supports multi-word commands like
  // `/lg on`, `/lg status`. The exact-match path is hit first (no extra
  // text after the command) but if a user types `/lg on please`, we still
  // recognize `/lg on` and ignore the trailing.
  const match = REGISTRY.find(c => {
    const cmd = c.command.toLowerCase();
    return normalized === cmd || normalized.startsWith(`${cmd} `);
  });

  if (!match) {
    // Slash-prefixed but unknown — short-circuit with a friendly hint
    // rather than letting the LLM puzzle over a typed `/foo`.
    return {
      reply: `Unknown command \`${args.text.trim()}\`. Type \`/help\` to see what's available.`,
    };
  }

  if (!isPermitted(match.requires, args.ctx)) {
    return {
      reply: `\`${match.command}\` isn't available to your account.`,
    };
  }

  return match.handler(args);
}
