// Types — platform primitives only
export * from './types/tenant.js';
export * from './types/mcp.js';
export * from './types/workflow.js';
export * from './types/events.js';
// Cross-service contracts (hr-service ↔ teams-bot)
export type { ExtractionResult, IntentResult } from './types/agent.js';
export { ExtractionResultSchema, IntentResultSchema } from './types/agent.js';

// Slice 58A — module-side contract for document consumers
export * from './types/document-module-contract.js';

// Slice 58B — bot-progress NATS channel (publisher: doc-service, subscriber: teams-bot)
export * from './types/bot-progress-event.js';
export * from './nats/progress-subjects.js';

// Clients
export * from './clients/litellm.js';
export * from './clients/langfuse.js';
export * from './clients/temporal.js';
export * from './clients/nats.js';
export * from './clients/postgres.js';

// Utils
export * from './utils/subject-builder.js';
export * from './utils/tenant-context.js';
export * from './utils/lookup-registry.js';
