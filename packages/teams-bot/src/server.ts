import { CloudAdapter, ConfigurationBotFrameworkAuthentication, ConversationReference } from 'botbuilder';
import express, { type Express } from 'express';
import { CIPTeamsBot } from './bot.js';
import { getChannelRef } from './teams-protocol/channel-registry.js';

const auth = new ConfigurationBotFrameworkAuthentication({
  ...(process.env['BOT_APP_ID'] ? { MicrosoftAppId: process.env['BOT_APP_ID'] } : {}),
  ...(process.env['BOT_APP_PASSWORD'] ? { MicrosoftAppPassword: process.env['BOT_APP_PASSWORD'] } : {}),
  MicrosoftAppType: 'MultiTenant',
});

export const adapter = new CloudAdapter(auth);

adapter.onTurnError = async (context, error) => {
  console.error('Bot turn error:', error);
  await context.sendActivity('An error occurred. Please try again.');
};

export const bot = new CIPTeamsBot();
export const app: Express = express();
app.use(express.json());

app.post('/api/messages', async (req, res) => {
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

  await adapter.continueConversationAsync(process.env['BOT_APP_ID']!, ref as ConversationReference, async ctx => {
    await ctx.sendActivity({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
    });
  });
  res.status(204).end();
});
