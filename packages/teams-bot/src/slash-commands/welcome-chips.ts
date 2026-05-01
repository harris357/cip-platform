// Slice 47: suggestedActions chips for the welcome message.
//
// onMembersAdded fires BEFORE auth context exists — there's no
// ctx.permissions or ctx.roles to filter against. So welcome chips are
// universal helpful prompts. Role-aware filtering happens in /help
// (which fires post-auth). Once a user runs /help they see their
// personalized command list.
//
// The chips mix natural-language prompts (which flow through the
// engine like any user message) and slash commands (which short-circuit
// via dispatchSlashCommand).

import { type CardAction } from '@microsoft/agents-activity';

/**
 * Build the suggestedActions for the welcome message. Up to 6 chips.
 * Universal — same for every caller until they're authenticated.
 *
 * Returns the actions[] array; caller wraps in `{ actions }` and sets
 * Activity.suggestedActions.
 */
export function buildWelcomeChips(): CardAction[] {
  return [
    {
      type:  'imBack',
      title: 'Show my certifications',
      value: 'Show my certifications',
    },
    {
      type:  'imBack',
      title: 'What can I do',
      value: 'What can I do',
    },
    {
      type:  'imBack',
      title: '/help',
      value: '/help',
    },
    {
      type:  'imBack',
      title: 'Try LangGraph (/lg on)',
      value: '/lg on',
    },
  ];
}
