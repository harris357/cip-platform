import { CloudAdapter, getAuthConfigWithDefaults, authorizeJWT } from '@microsoft/agents-hosting';
import { Activity, ConversationReference } from '@microsoft/agents-activity';
import express, { type Express } from 'express';
import { CIPTeamsBot } from './bot.js';
import { getChannelRef } from './teams-protocol/channel-registry.js';

const authConfig = getAuthConfigWithDefaults({
  ...(process.env['BOT_APP_ID'] ? { clientId: process.env['BOT_APP_ID'] } : {}),
  ...(process.env['BOT_APP_PASSWORD'] ? { clientSecret: process.env['BOT_APP_PASSWORD'] } : {}),
  ...(process.env['MICROSOFT_APP_TENANT_ID'] ? { tenantId: process.env['MICROSOFT_APP_TENANT_ID'] } : {}),
});

export const adapter = new CloudAdapter(authConfig);

adapter.onTurnError = async (context, error) => {
  console.error('Bot turn error:', error);
  await context.sendActivity('An error occurred. Please try again.');
};

export const bot = new CIPTeamsBot();
export const app: Express = express();
app.use(express.json());
app.use(authorizeJWT(authConfig));

app.post('/api/messages', async (req, res) => {
  const body = req.body as { type?: string; name?: string };
  console.log(`[activity] type=${body.type ?? '?'} name=${body.name ?? '-'}`);
  if (body.type === 'invoke') {
    // Log the full raw activity so we can see exactly what Teams sends on signin/failure,
    // signin/tokenExchange, etc. — including channelData and entities.
    console.log(`[activity:invoke] RAW: ${JSON.stringify(req.body, null, 2)}`);
  }
  await adapter.process(req, res, context => bot.run(context));
});

// POST /proactive — only mechanism for unsolicited messages
// Body: { tenantId: string, channelType: string, card: object }
app.post('/proactive', async (req, res) => {
  const { tenantId, channelType, card } = req.body as {
    tenantId: string;
    channelType: string;
    card: object;
  };
  const ref = await getChannelRef(tenantId, channelType);
  if (!ref) {
    res.status(404).json({ error: 'channel not registered' });
    return;
  }

  await adapter.continueConversation(
    process.env['BOT_APP_ID'] ?? '',
    ref as ConversationReference,
    async ctx => {
      await ctx.sendActivity(Activity.fromObject({
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
      }));
    },
  );
  res.status(204).end();
});
