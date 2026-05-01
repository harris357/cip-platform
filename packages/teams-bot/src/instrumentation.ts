// Slice 48 follow-up: explicit OpenTelemetry setup for the Langfuse 5.x
// integration. Without this, `@langfuse/langchain`'s CallbackHandler
// constructs cleanly but **emits no spans** — the SDK is OTEL-based
// and doesn't auto-init from env vars alone.
//
// This file MUST be imported at the very top of `index.ts`, before any
// LangChain / LangGraph / @langfuse/* import, so the OTEL provider is
// registered before the callback handler tries to attach to it.
//
// Configuration is via env (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY /
// LANGFUSE_HOST) — same keys we already have in teams-bot-credentials.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

// Construct + start. The SDK auto-shuts-down on process SIGTERM.
const otelSdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});

otelSdk.start();

// Best-effort flush on shutdown so traces from in-flight turns reach
// Langfuse before the pod terminates.
const shutdown = (): void => {
  otelSdk.shutdown()
    .then(() => console.log('[otel] sdk shutdown complete'))
    .catch((err: unknown) =>
      console.warn(`[otel] sdk shutdown failed: ${err instanceof Error ? err.message : String(err)}`));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT',  shutdown);
