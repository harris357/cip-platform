// Slice 47: /about handler. Surfaces current bot state to the user —
// build SHA, runtime engine, tenant + user identity, permission count.
// Useful for: "what version am I talking to?", "is the new feature
// deployed yet?", debugging deploy/permission issues.

import type { SlashCommandHandlerArgs, SlashCommandResult } from '../registry.js';

export async function aboutHandler(
  args: SlashCommandHandlerArgs,
): Promise<SlashCommandResult> {
  const { ctx } = args;
  const buildSha = process.env['BOT_BUILD_SHA'] ?? '_(unknown)_';
  const permCount = Object.keys(ctx.permissions).filter(k => ctx.permissions[k]).length;
  const roleList = (ctx.roles ?? []).length > 0
    ? (ctx.roles ?? []).map(r => `\`${r}\``).join(', ')
    : '_(none)_';

  const lines = [
    '**CIP Bot — about**',
    '',
    `- Build: \`${buildSha}\``,
    `- Runtime: LangGraph`,
    `- Tenant: \`${ctx.tenantId}\``,
    `- Roles: ${roleList}`,
    `- Permissions: ${permCount} granted`,
  ];

  return { reply: lines.join('\n') };
}
