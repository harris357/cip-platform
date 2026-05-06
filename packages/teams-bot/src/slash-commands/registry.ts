// Slice 47: slash command registry — single source of truth.
//
// Each entry declares:
//   - exact `command` text the user types (with leading slash)
//   - human-readable description (used by /help)
//   - permission requirement (mirrors MCP tool annotations)
//   - handler function
//
// `commandsForCaller(ctx)` filters this list by what the caller can run.
// The Teams manifest commandLists carries only the universal subset
// (entries with `requires: null`); admin commands surface only via the
// role-filtered /help.

import type { TurnContext } from '@microsoft/agents-hosting';
import type { BotAuthContext } from '../auth/resolve-context.js';
import { helpHandler } from './handlers/help.js';
import { aboutHandler } from './handlers/about.js';
import { turnHandler } from './handlers/turn.js';
import { turnFeedbackHandler } from './handlers/turn-feedback.js';

export interface SlashCommandResult {
  /** Plain markdown reply. Sent verbatim if `card` is unset. */
  reply: string;
  /** Slice 56F: optional adaptive card. When set, sent as an attachment;
   *  `reply` is the text fallback for non-card-rendering channels.
   *  Handlers that need to send a card (verdict follow-up, /turn buttons)
   *  use this instead of calling context.sendActivity directly. */
  card?: unknown;
}

export interface SlashCommandHandlerArgs {
  ctx:      BotAuthContext;
  context:  TurnContext;
  threadId: string;
  text:     string;
}

export interface SlashCommand {
  /** Exact text the user types (with leading slash). Lower-cased + trimmed for match. */
  command:     string;
  description: string;
  /**
   * Permission requirement. Same convention as MCP `requiredPermission`:
   *   null         — available to every authenticated user
   *   'role:hr'    — requires the `hr` Keycloak realm role
   *   '<perm>'     — requires that CIP permission code
   */
  requires:    string | 'role:hr' | null;
  handler:     (args: SlashCommandHandlerArgs) => Promise<SlashCommandResult>;
}

/**
 * REGISTRY ordering matters for /help rendering. Universal first, then
 * role-gated by category (admin, etc.).
 */
export const REGISTRY: SlashCommand[] = [
  {
    command:     '/help',
    description: 'List the commands available to you',
    requires:    null,
    handler:     helpHandler,
  },
  {
    command:     '/about',
    description: 'Show bot version, runtime, your tenant + roles + permissions',
    requires:    null,
    handler:     aboutHandler,
  },
  {
    command:     '/turn',
    description: 'Inspect a specific turn — usage: `/turn <8-char-id>`',
    requires:    'bot.metrics.read',
    handler:     turnHandler,
  },
  // Slice 56F: verdict commands fired by the response-footer adaptive card
  // (👍/👎 buttons). Not user-typed in practice but registered for /help
  // discoverability and the dispatch path. Open to all authenticated
  // users.
  // Slice 61: rewritten to write Langfuse trace scores instead of the
  // dropped bot_turn_feedback table. The 👎 follow-up correction card
  // is gone; verdicts are positive/negative only.
  {
    command:     '/turn-feedback',
    description: 'Record verdict on a bot turn — fired by 👍/👎 buttons. Usage: `/turn-feedback <id> positive|negative`',
    requires:    null,
    handler:     turnFeedbackHandler,
  },
];

/**
 * Returns the subset of commands the caller is permitted to run.
 * Used by /help and (future) suggestedActions chips to filter what
 * the user sees from what they CAN see.
 */
export function commandsForCaller(ctx: BotAuthContext): SlashCommand[] {
  return REGISTRY.filter(c => isPermitted(c.requires, ctx));
}

export function isPermitted(
  req: SlashCommand['requires'],
  ctx: BotAuthContext,
): boolean {
  if (req === null) return true;
  if (req === 'role:hr') return ctx.roles?.includes('hr') ?? false;
  return ctx.permissions[req] === true;
}
