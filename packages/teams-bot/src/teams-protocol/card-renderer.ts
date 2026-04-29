import type { TurnContext } from '@microsoft/agents-hosting';
import { Activity } from '@microsoft/agents-activity';
import type { McpModuleResponse } from '@cip/shared';

export async function renderResponse(
  context: TurnContext,
  result: McpModuleResponse,
): Promise<void> {
  if (result.card) {
    await context.sendActivity(Activity.fromObject({
      type: 'message',
      attachments: [
        { contentType: 'application/vnd.microsoft.card.adaptive', content: result.card },
      ],
    }));
  } else {
    await context.sendActivity(result.message ?? String(result.data ?? ''));
  }
}
