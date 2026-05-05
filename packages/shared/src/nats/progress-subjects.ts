// Slice 58B — bot-progress NATS subject builder.
//
// Document-service activities publish per-step progress to a per-conversation
// subject; the bot subscribes (per-tenant wildcard) and renders fresh
// follow-up cards as the workflow advances. NATS publish is best-effort:
// activities NEVER fail because progress couldn't reach the bot.
//
// Pattern lives outside `buildSubject`/`Subjects.*` because the bot-progress
// channel is not a domain event stream — it's a transient UI hint, ephemeral,
// not consumed by hr-service or any module workflow. Domain events still go
// through `buildSubject()` per the Non-Negotiables.

const TENANT_RE       = /^[a-zA-Z0-9-]+$/;       // UUIDs + safe IDs only
const CONVERSATION_RE = /^[a-zA-Z0-9._:-]+$/;    // Teams conversation IDs include `.` `:` `_` `-`

/**
 * Build the per-conversation progress subject. The bot subscribes wildcard
 * by tenant: `cip.bot.progress.${tenantId}.>` so a single subscription
 * receives every active upload's progress for that tenant.
 */
export function progressSubject(tenantId: string, conversationId: string): string {
  if (!TENANT_RE.test(tenantId)) {
    throw new Error(`progressSubject: invalid tenantId ${JSON.stringify(tenantId)}`);
  }
  if (!CONVERSATION_RE.test(conversationId)) {
    throw new Error(`progressSubject: invalid conversationId ${JSON.stringify(conversationId)}`);
  }
  return `cip.bot.progress.${tenantId}.${conversationId}`;
}

/** Tenant-wide wildcard the bot subscribes to. */
export function progressSubjectTenantWildcard(tenantId: string): string {
  if (!TENANT_RE.test(tenantId)) {
    throw new Error(`progressSubjectTenantWildcard: invalid tenantId ${JSON.stringify(tenantId)}`);
  }
  return `cip.bot.progress.${tenantId}.>`;
}
