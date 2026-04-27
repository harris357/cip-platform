import { TeamsActivityHandler, TurnContext } from 'botbuilder';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { resolveAuthContext } from './auth/resolve-context.js';
import { updateChannelRegistry } from './teams-protocol/channel-registry.js';
import { detectFileAttachments, downloadToObjectStore } from './teams-protocol/file-handler.js';
import { renderResponse } from './teams-protocol/card-renderer.js';
import { discoverTools } from './mcp/tool-discovery.js';
import { routeIntent } from './intent/router.js';
import { executeTool } from './mcp/tool-executor.js';

export function buildWelcomeMessage(): string {
  return (
    'Hello! I can help you manage certifications and HR tasks. ' +
    'Send me a message or upload a certificate document to get started.'
  );
}

function buildNoToolMessage(tools: McpTool[]): string {
  return tools.length > 0
    ? "I'm not sure how to help with that. Try asking about your certifications or HR tasks."
    : "I don't have any tools available for your account. Please contact your administrator.";
}

export class CIPTeamsBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded ?? []) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(buildWelcomeMessage());
        }
      }
      await next();
    });

    this.onMessage(async (context: TurnContext, next) => {
      const ctx = await resolveAuthContext(context);
      await updateChannelRegistry(context, ctx.tenantId, ctx.bearerToken);

      const fileAttachments = detectFileAttachments(context);

      if (fileAttachments.length > 0) {
        for (const file of fileAttachments) {
          const key = await downloadToObjectStore(file, ctx);
          const result = await executeTool('process_document', { objectStoreKey: key }, ctx);
          await renderResponse(context, result);
        }
      } else {
        const text = context.activity.text?.trim() ?? '';
        if (!text) {
          await next();
          return;
        }

        const tools = await discoverTools(ctx);
        const selected = await routeIntent(text, tools, ctx);

        if (selected) {
          const result = await executeTool(selected.name, selected.args, ctx);
          await renderResponse(context, result);
        } else {
          await context.sendActivity(buildNoToolMessage(tools));
        }
      }
      await next();
    });
  }
}
