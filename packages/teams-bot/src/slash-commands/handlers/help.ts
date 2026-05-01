// Slice 47: /help handler. Renders a markdown list of only the slash
// commands the caller is permitted to run.
//
// Implementation note: imports `commandsForCaller` lazily (inside the
// function body) to avoid a circular dependency — registry.ts imports
// helpHandler at module init.

import type { SlashCommandHandlerArgs, SlashCommandResult } from '../registry.js';

export async function helpHandler(
  args: SlashCommandHandlerArgs,
): Promise<SlashCommandResult> {
  const { commandsForCaller } = await import('../registry.js');
  const commands = commandsForCaller(args.ctx);

  if (commands.length === 0) {
    return {
      reply: 'No commands are available to your account. Contact your administrator.',
    };
  }

  const lines = commands.map(c => `- \`${c.command}\` — ${c.description}`);
  return {
    reply:
      'Here are the commands you can use:\n\n' +
      lines.join('\n') +
      '\n\n_Tip: you can also just ask in plain language — slash commands are optional._',
  };
}
