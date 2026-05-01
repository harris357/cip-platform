// Slice 48 follow-up: OTEL/Langfuse must initialize FIRST, before any
// other import that might construct LangChain/LangGraph runnables.
// Without this, @langfuse/langchain's CallbackHandler is silently inert.
import './instrumentation.js';

import { app } from './server.js';
import { ensureCheckpointerReady } from './langgraph/checkpointer.js';

const port = parseInt(process.env['PORT'] ?? '3978', 10);

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
