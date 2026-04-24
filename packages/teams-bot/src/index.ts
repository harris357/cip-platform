import { CloudAdapter, ConfigurationBotFrameworkAuthentication } from 'botbuilder';
import express from 'express';
import { CIPTeamsBot } from './bot.js';

const app = express();
app.use(express.json());

// exactOptionalPropertyTypes: only include credentials when set
const auth = new ConfigurationBotFrameworkAuthentication({
  ...(process.env['MICROSOFT_APP_ID'] ? { MicrosoftAppId: process.env['MICROSOFT_APP_ID'] } : {}),
  ...(process.env['MICROSOFT_APP_PASSWORD'] ? { MicrosoftAppPassword: process.env['MICROSOFT_APP_PASSWORD'] } : {}),
  MicrosoftAppType: 'MultiTenant',
});

const adapter = new CloudAdapter(auth);

adapter.onTurnError = async (context, error) => {
  console.error('Bot turn error:', error);
  await context.sendActivity('An error occurred. Please try again.');
};

const bot = new CIPTeamsBot();

app.post('/api/messages', async (req, res) => {
  await adapter.process(req, res, (context) => bot.run(context));
});

const port = parseInt(process.env['PORT'] ?? '3978', 10);
app.listen(port, () => {
  console.log(`Teams Bot listening on port ${port}`);
});
