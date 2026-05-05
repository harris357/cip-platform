// Slice 48 follow-up: OTEL/Langfuse must initialize FIRST, before any
// other import that might construct LangChain/LangGraph runnables.
// Without this, @langfuse/langchain's CallbackHandler is silently inert.
import './instrumentation.js';

import { app } from './server.js';
import { ensureCheckpointerReady } from './langgraph/checkpointer.js';
import { registerInvokeHandler } from './teams-protocol/invoke-router.js';
import { confirmWriteHandler } from './teams-protocol/invoke-handlers/confirm-write.js';
import { hrPersonPickHandler } from './teams-protocol/invoke-handlers/hr-person-pick.js';

const port = parseInt(process.env['PORT'] ?? '3978', 10);

// Slice 53: register card-invoke handlers at module boot. Verb
// collisions throw — registrations are boot-time so a duplicate is
// a programming error worth surfacing loudly. Future slices (58D,
// 58F, 58I) add their own handlers via the same call.
registerInvokeHandler(confirmWriteHandler);
registerInvokeHandler(hrPersonPickHandler);

async function main(): Promise<void> {
  await ensureCheckpointerReady();
  app.listen(port, () => {
    console.log(`Teams Bot listening on port ${port}`);
  });
}

main().catch(err => {
  console.error('Boot failure:', err);
  process.exit(1);
});
