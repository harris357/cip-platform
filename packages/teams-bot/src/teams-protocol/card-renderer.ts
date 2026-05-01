import type { TurnContext } from '@microsoft/agents-hosting';
import { Activity } from '@microsoft/agents-activity';
import type { McpModuleResponse } from '@cip/shared';

/**
 * Render an MCP tool's response into a Teams activity. Three paths:
 *   1. Adaptive card present → send as a card attachment.
 *   2. `message` present → send as plain text (the tool already composed
 *      a user-facing string).
 *   3. Fallback to `data` — most tools that don't set `message` still
 *      return a useful object. Render it as a markdown code block so
 *      the user sees the actual content rather than "[object Object]"
 *      (which is what String(obj) produces).
 */
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
    return;
  }
  if (result.message) {
    await context.sendActivity(result.message);
    return;
  }
  if (result.data === undefined || result.data === null) {
    await context.sendActivity('_(no result)_');
    return;
  }
  if (typeof result.data === 'string') {
    await context.sendActivity(result.data);
    return;
  }
  // Render objects/arrays as a fenced code block so the user sees the
  // actual structure instead of "[object Object]". For very large
  // payloads, truncate to keep the Teams message under its limit.
  const json = JSON.stringify(result.data, null, 2);
  const TRUNCATE_AT = 7000;  // Teams hard limit is ~28k; leave headroom.
  const body = json.length > TRUNCATE_AT
    ? `${json.slice(0, TRUNCATE_AT)}\n\n_... truncated (${json.length - TRUNCATE_AT} more chars)_`
    : json;
  await context.sendActivity('```json\n' + body + '\n```');
}
