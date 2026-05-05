# Slice 59 — messaging coherency (NATS / JetStream)

> **Why this exists:** A 2026-05-05 audit found that the durable-event
> layer is functionally a no-op in production:
>
> 1. `tenant-provisioning.workflow.ts` creates per-tenant streams
>    `cip-{tenantId}-{hr|ops|platform|agents}` with subject filters
>    `cip.{tenantId}.{hr|ops|platform|agents}.>`.
> 2. `subject-builder.ts` produces subjects in
>    `cip.{tenantId}.{cert|worker|compliance|tenant|employee}.{event}.v1`.
> 3. The two domain enums **never overlap** — no event published via
>    `Subjects.*` can ever match a stream filter created by
>    `createNatsStreams`. The streams capture nothing.
> 4. `hr-service/src/nats/watcher.ts` binds durable consumers to
>    streams named `CERTS` and `HR_EVENTS` — names that exist nowhere
>    in code, never created. The watcher's 20-attempt retry loop
>    fails permanently in production OR the watcher is silently dead.
> 5. Of 6 business-event publishes, **3 use `nc.publish`** (fire-and-
>    forget, no delivery confirmation) for events that should be
>    durable: `publish-cert-processed`, `send-welcome-notification`,
>    `provision-complete-notify`. The other 3 (employee.onboarded,
>    employee.identity_changed, bot-progress) use the right method.
> 6. Consumers use only default config (`max_deliver: -1` = unlimited
>    redeliveries; no DLQ; default `ack_wait`).
>
> 59 reconciles the two domain enums to a single one (the subject
> builder's), replaces per-tenant streams with global per-domain
> streams, fixes the watcher to bind to the actual stream names,
> promotes business publishes to `js.publish`, adds explicit consumer
> config + DLQ.
>
> **Out of scope**: implementing the cross-service reactive handlers
> the watcher's consumers feed (cert.processed → reminder workflow,
> employee.onboarded → cert gap analysis). Those are TODO stubs today
> and stay TODO; 59 just makes the substrate they'll need *actually
> work*.

---

## Files in scope

```
packages/shared/src/clients/nats.ts                                  MOD (no API change; doc the durability rules)
packages/shared/src/utils/subject-builder.ts                         MOD (no change to subjects; doc that domain enum is the source of truth)
packages/shared/src/nats/streams.ts                                  NEW (global stream definitions + ensureStream helper)
packages/shared/src/index.ts                                         MOD (re-export StreamConfig + ensureGlobalStreams)

# Bootstrap path — global streams created once at platform install
packages/platform-core/src/activities/create-nats-streams.activity.ts   DELETED (per-tenant streams are wrong; use global)
packages/platform-core/src/activities/index.ts                          MOD (drop the export)
packages/platform-core/src/workflows/tenant-provisioning.workflow.ts    MOD (drop the createNatsStreams call)
packages/platform-core/src/scripts/bootstrap-global-streams.ts          NEW (one-shot script: ensures CIP_* streams exist; idempotent)

# Watcher rebind to actual stream names
packages/hr-service/src/nats/watcher.ts                              MOD (CERTS → CIP_CERT_EVENTS, HR_EVENTS → CIP_EMPLOYEE_EVENTS; explicit consumer config; DLQ wrapping)

# Promote business publishes to js.publish
packages/hr-service/src/modules/certifications/activities/publish-cert-processed.activity.ts   MOD (nc.publish → js.publish)
packages/hr-service/src/modules/employees/activities/send-welcome-notification.activity.ts     MOD (nc.publish → js.publish)
packages/platform-core/src/activities/provision-complete-notify.activity.ts                    MOD (nc.publish → js.publish)

# DLQ helper
packages/shared/src/nats/dlq.ts                                      NEW (wrapMessageHandler util — caps redeliveries, terms + DLQ-publishes on exhaustion)

# Operations script for migrating existing clusters
scripts/migrate-nats-streams.sh                                      NEW (idempotent: deletes legacy per-tenant streams once global streams confirmed)
```

Note: `packages/shared/src/nats/progress-subjects.ts` is **unchanged**.
The bot-progress channel is intentionally outside JetStream (ephemeral
UI hints) and stays that way.

---

## Hard rules

1. **Single domain enum.** The subject builder's
   `NatsDomain = 'cert' | 'worker' | 'compliance' | 'tenant' | 'employee'`
   is the canonical list. Stream definitions, watcher bindings, and
   any future event handlers reference these names exclusively. The
   `hr | ops | platform | agents` set in the deleted activity does
   not return.

2. **Streams are global, not per-tenant.** Five streams cover the
   platform: `CIP_CERT_EVENTS`, `CIP_WORKER_EVENTS`,
   `CIP_COMPLIANCE_EVENTS`, `CIP_TENANT_EVENTS`, `CIP_EMPLOYEE_EVENTS`.
   Each captures `cip.*.{domain}.>`. Tenant isolation is at the
   application layer (subject path + tenantId in payload + DB RLS),
   not at the stream level. Per-tenant retention is **deferred** —
   today's varying max_age values were never honored anyway since
   the streams captured nothing.

3. **Business events use `js.publish`.** Any event that another
   service might react to (or that we might replay later) must go
   through JetStream with publisher ack. `nc.publish` is reserved
   for *transient UI hints that can be dropped without consequence*
   — today only the bot-progress events. Activity-level retry on
   js.publish failure is on by default (Temporal retries the
   activity).

4. **Every consumer specifies `max_deliver`, `ack_wait`,
   `max_ack_pending`.** Defaults are not acceptable in production.
   Slice 59 settings: `max_deliver: 5`, `ack_wait: 60s` (longer for
   workflow-starting handlers), `max_ack_pending: 100`.

5. **DLQ on max_deliver exhaustion.** A poison message terminates
   (`m.term()`) and publishes a single envelope to a dead-letter
   subject `cip.dlq.{originalSubject}`. The DLQ stream
   (`CIP_DLQ_EVENTS`) is its own retention bucket so on-call has a
   replay window. No automatic redrive — manual-only by design.

6. **Bootstrap is idempotent + run once.** `bootstrap-global-streams.ts`
   creates the 5 + 1 streams; on existing-stream errors it's a no-op.
   Run from the platform-install runbook (helm post-install hook or
   one-shot CronJob); not tied to per-tenant provisioning.

7. **Watcher handler stubs preserved.** Slice 59 does NOT implement
   `handleCertProcessed`, `handleEmployeeOnboarded`. Those stay TODO.
   The slice's job is making sure the events would *arrive* if the
   handlers were written.

---

## Stream definitions

```typescript
// packages/shared/src/nats/streams.ts

export interface StreamConfig {
  name:        string;
  subjects:    string[];
  storage:     StorageType;
  retention:   RetentionPolicy;
  max_age:     number;       // nanoseconds
  max_msgs?:   number;
  description: string;
}

export const GLOBAL_STREAMS: readonly StreamConfig[] = [
  {
    name:        'CIP_CERT_EVENTS',
    subjects:    ['cip.*.cert.>'],
    storage:     StorageType.File,
    retention:   RetentionPolicy.Limits,
    max_age:     365 * 24 * 60 * 60 * 1_000_000_000,  // 1 year
    description: 'Cert lifecycle events: uploaded, processed, expired, revoked.',
  },
  {
    name:        'CIP_EMPLOYEE_EVENTS',
    subjects:    ['cip.*.employee.>'],
    storage:     StorageType.File,
    retention:   RetentionPolicy.Limits,
    max_age:     365 * 24 * 60 * 60 * 1_000_000_000,
    description: 'Employee lifecycle: onboarded, identity_changed, disabled.',
  },
  {
    name:        'CIP_COMPLIANCE_EVENTS',
    subjects:    ['cip.*.compliance.>'],
    storage:     StorageType.File,
    retention:   RetentionPolicy.Limits,
    max_age:     365 * 24 * 60 * 60 * 1_000_000_000,
    description: 'Compliance lifecycle: drifted, restored.',
  },
  {
    name:        'CIP_TENANT_EVENTS',
    subjects:    ['cip.*.tenant.>'],
    storage:     StorageType.File,
    retention:   RetentionPolicy.Limits,
    max_age:     90 * 24 * 60 * 60 * 1_000_000_000,    // 90 days — provisioning is short-lived
    description: 'Tenant provisioning lifecycle: provisioned.',
  },
  {
    name:        'CIP_WORKER_EVENTS',
    subjects:    ['cip.*.worker.>'],
    storage:     StorageType.File,
    retention:   RetentionPolicy.Limits,
    max_age:     365 * 24 * 60 * 60 * 1_000_000_000,
    description: 'Worker (legacy alias for employee in some flows): onboarded.',
  },
  {
    name:        'CIP_DLQ_EVENTS',
    subjects:    ['cip.dlq.>'],
    storage:     StorageType.File,
    retention:   RetentionPolicy.Limits,
    max_age:     30 * 24 * 60 * 60 * 1_000_000_000,    // 30-day replay window
    description: 'Dead-letter for messages that exhausted max_deliver.',
  },
] as const;

export async function ensureGlobalStreams(jsm: JetStreamManager): Promise<{ created: string[]; existed: string[] }> {
  // Idempotent: existing streams are a no-op; new streams are created.
  // Returns counts for the bootstrap script's report.
  // ...
}
```

---

## Watcher rebind

Before:
```typescript
const CONSUMERS = [
  { stream: 'CERTS',     name: 'hr-watcher-cert-processed',     filter: CERT_PROCESSED_SUBJECT,     label: 'cert.processed' },
  { stream: 'CERTS',     name: 'hr-watcher-cert-expired',       filter: CERT_EXPIRED_SUBJECT,       label: 'cert.expired' },
  { stream: 'HR_EVENTS', name: 'hr-watcher-employee-onboarded', filter: EMPLOYEE_ONBOARDED_SUBJECT, label: 'employee.onboarded' },
] as const;
```

After:
```typescript
const CONSUMERS = [
  { stream: 'CIP_CERT_EVENTS',     name: 'hr-watcher-cert-processed',     filter: CERT_PROCESSED_SUBJECT,     label: 'cert.processed' },
  { stream: 'CIP_CERT_EVENTS',     name: 'hr-watcher-cert-expired',       filter: CERT_EXPIRED_SUBJECT,       label: 'cert.expired' },
  { stream: 'CIP_EMPLOYEE_EVENTS', name: 'hr-watcher-employee-onboarded', filter: EMPLOYEE_ONBOARDED_SUBJECT, label: 'employee.onboarded' },
] as const;

// Consumer config — every consumer specifies these:
const CONSUMER_CONFIG = {
  ack_policy:        AckPolicy.Explicit,
  deliver_policy:    DeliverPolicy.New,
  max_deliver:       5,
  ack_wait:          60 * 1_000_000_000,       // 60s in ns; bump to 5min for workflow-starting handlers if needed
  max_ack_pending:   100,
} as const;
```

---

## DLQ pattern

```typescript
// packages/shared/src/nats/dlq.ts

export async function wrapMessageHandler<T>(
  msg: JsMsg,
  js:  JetStreamClient,
  handler: (event: T) => Promise<void>,
  opts: { label: string },
): Promise<void> {
  try {
    const event = msg.json<T>();
    await handler(event);
    msg.ack();
  } catch (err) {
    const info = msg.info;
    if (info.redeliveryCount >= /* config max_deliver - 1 */ 4) {
      // Last attempt — terminate + DLQ.
      const dlqSubject = `cip.dlq.${msg.subject}`;
      await js.publish(dlqSubject, msg.data, {
        msgID: `${msg.seq}-${Date.now()}`,   // dedup against re-publish races
      });
      console.error(`[${opts.label}] DLQ-published after ${info.redeliveryCount + 1} attempts:`, err);
      msg.term();
    } else {
      console.warn(`[${opts.label}] handler error (attempt ${info.redeliveryCount + 1}/5):`, err);
      msg.nak();
    }
  }
}
```

Watcher consumers use this wrapper instead of the bare `try / m.ack() / m.nak()` pattern.

---

## Bootstrap script

`packages/platform-core/src/scripts/bootstrap-global-streams.ts` (~50 LOC, runnable
via `pnpm --filter @cip/platform-core run bootstrap-streams`):

- Connects via `getNatsConnection()` + `createJetStreamManager()`.
- Calls `ensureGlobalStreams(jsm)`.
- Logs `created`, `existed` counts.
- Exits 0 on success.

Add to repo `package.json` script and to the helm post-install hook
(or document in `slices/PROMPTS_DEPLOY.md` runbook, whichever is the
existing pattern for one-shot platform bootstrap).

---

## Migration

`scripts/migrate-nats-streams.sh`:

```bash
#!/usr/bin/env bash
# Slice 59 — drop legacy per-tenant streams. Run AFTER bootstrap-streams
# has confirmed the new global streams exist + new code is deployed.
#
# The legacy streams (cip-{tenantId}-{hr|ops|platform|agents}) captured
# nothing in production (subject filter never matched the actual subject
# pattern). Safe to delete.

set -euo pipefail

NATS_URL="${NATS_URL:-nats://nats:4222}"
PATTERN='^cip-[0-9a-f-]{36}-(hr|ops|platform|agents)$'

mapfile -t legacy < <(nats --server "$NATS_URL" stream ls -j | jq -r '.[].config.name' | grep -E "$PATTERN" || true)

if [[ ${#legacy[@]} -eq 0 ]]; then
  echo "no legacy streams found — nothing to do"
  exit 0
fi

echo "found ${#legacy[@]} legacy streams:"
printf '  %s\n' "${legacy[@]}"
read -p "delete? (yes/NO) " confirm
[[ "$confirm" == "yes" ]] || exit 1

for s in "${legacy[@]}"; do
  nats --server "$NATS_URL" stream rm "$s" --force
done
echo "done"
```

---

## Acceptance criteria

1. **`Subjects.certProcessed(t)` published via `js.publish` lands in
   `CIP_CERT_EVENTS`.** Verify by publishing a test event and reading
   from a temporary consumer on the stream. (Pre-59: published events
   never landed in any stream.)

2. **`hr-service` watcher binds successfully on cold start.** No
   "Streams may not exist" retry loop. All three durable consumers
   reach `await consumer.consume()` without error.

3. **A handler that throws gets retried up to 5x then DLQ'd.**
   Inject a deliberate throw in a test handler; observe redelivery
   count climb to 5; verify a single envelope appears on
   `cip.dlq.cip.{tenant}.cert.processed.v1` in `CIP_DLQ_EVENTS`;
   verify the message stops redelivering.

4. **Three publishes promoted to `js.publish` confirm via ack.**
   `publishCertProcessedActivity`, `sendWelcomeNotificationActivity`,
   `provisionCompleteNotifyActivity` each return only after JetStream
   acks the message (no fire-and-forget). Activity-level Temporal
   retry handles transient JetStream errors.

5. **Bootstrap script is idempotent.** Run twice; second run reports
   `created: 0, existed: 6`.

6. **Migration script is safe.** Run on a cluster with no legacy
   streams; reports "nothing to do" and exits 0.

7. **`tenant-provisioning.workflow.ts` no longer creates streams.**
   Provisioning a new tenant does NOT touch JetStream.

8. **`pnpm -r run typecheck` clean.** All test suites pass.

9. **`grep -rn "'CERTS'\|'HR_EVENTS'\|'cip-.*-hr'\|'cip-.*-ops'"
   packages/`** returns zero matches in src/ (matches in
   archive/legacy docs are fine).

10. **Bot progress channel unchanged.** Smoke-test an upload in
    Teams; per-step progress card still updates. (`progress-subjects.ts`
    + `nc.publish` for that path is intentional and stays.)

---

## Test plan additions

- Unit: `wrapMessageHandler` covers success, transient-fail-then-success, max-deliver-exhaustion, malformed JSON.
- Unit: `ensureGlobalStreams` idempotency.
- Integration (skip in CI; manual against a local nats): publish via
  `js.publish` to each domain subject; observe stream message count;
  consume and ack; observe count back to zero.

---

## Forward refs

- **Eval-harness investigation** (post-58E todo): the global event
  log produced by 59 becomes the source for replayable analytics
  ("how many certs hit HITL last quarter"). Without 59, that data
  doesn't exist.
- **Future cross-service reactors** (cert.processed → reminder
  scheduler, employee.onboarded → cert-gap analysis, fraud-detection
  consumers): all unblocked by 59 — handlers can be wired without
  re-doing the substrate.
- **Tenant deletion**: future work needs to walk the streams and
  delete tenant-specific messages. Per-stream pruning by subject
  filter is supported by JetStream (`PurgeOpts.filter`); document
  this as a tenant-deletion sub-step when that slice ships.

---

## Risk + rollout

- **Risk**: existing in-flight workflows that publish via `nc.publish`
  may be mid-execution when 59 deploys. Activity replay on the new
  code path uses `js.publish`; messages from BEFORE deploy are gone
  but those events' handlers are TODO stubs anyway — no observable
  regression.
- **Risk**: bot-progress NATS path is *adjacent* to the changes; a
  test smoke-upload in Teams post-deploy verifies it still streams.
- **Rollout**:
  1. Deploy code (publishes go to js.publish; watcher binds to new
     stream names).
  2. Run `bootstrap-global-streams.ts` once.
  3. Verify watcher consumers active.
  4. Run `migrate-nats-streams.sh` to clean up legacy.
- **Rollback**: revert deploy. The legacy per-tenant streams (if not
  yet migrated) are still there but unused; the new global streams
  are harmless.
