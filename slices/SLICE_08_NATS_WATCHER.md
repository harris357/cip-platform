# Slice 08 — NATS Watcher

> **Prerequisite:** Slices 02, 05B, 06 complete.
> **Package:** `@cip/hr-service`
> **Verify:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/nats/
  watcher.ts    ← ambient watcher — subscribes to NATS, reacts to domain events
```

---

## Subscriptions

| Event | Subject | Action |
|---|---|---|
| `CertProcessedEvent` | `cip.*.cert.processed.v1` | Check expiry; schedule reminder if < 90 days |
| `CertExpiredEvent` | `cip.*.cert.expired.v1` | Trigger compliance drift check |
| `EmployeeOnboardedEvent` | `cip.*.employee.onboarded.v1` | Check initial cert requirements |

The `*` wildcard covers all tenants. Filter by `event.tenantId` in the handler — one watcher instance serves all tenants.

---

## Pattern

```typescript
import { getNatsConnection, Subjects } from '@cip/shared'
import type { CertProcessedEvent, CertExpiredEvent, EmployeeOnboardedEvent } from '@cip/shared'

export async function startAmbientWatcher(): Promise<void> {
  const nc = await getNatsConnection()
  const js = nc.jetstream()

  const sub = await js.subscribe(Subjects.allTenants('cert.processed.v1'))
  for await (const msg of sub) {
    const event = JSON.parse(msg.string()) as CertProcessedEvent
    await handleCertProcessed(event)
    msg.ack()
  }
}
```

`startAmbientWatcher()` is called from `packages/hr-service/src/index.ts` alongside the Temporal worker.

---

## Proactive Notifications

Handlers that need to notify a user via Teams call the bot's proactive endpoint:

```typescript
// POST to process.env['BOT_URL'] + '/proactive'
// Body: { tenantId: string, channelType: string, card: object }
// card is the Adaptive Card JSON — build it here, the bot only delivers it

await fetch(`${process.env['BOT_URL']}/proactive`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tenantId, channelType: 'hr_notifications', card }),
})
```

`BOT_URL` — base URL of the teams-bot service (e.g. `http://teams-bot:3000`). Required env var.

---

## Hard Rules

1. No raw NATS subject strings — use `Subjects.*` helpers from `@cip/shared`
2. Every handler acks the message after processing
3. `EmployeeOnboardedEvent` is the correct type — `WorkerOnboardedEvent` is a deprecated alias; do not use it in new code
4. Each handler is a separate named function — no inline anonymous logic in the subscription loop
5. Never import from `@cip/teams-bot` — communicate only via `POST BOT_URL/proactive`

---

## Acceptance Criteria

- [ ] Three subscriptions: cert.processed, cert.expired, employee.onboarded
- [ ] Each uses a `Subjects.*` helper — no raw strings
- [ ] Each message is acked after its handler completes
- [ ] `startAmbientWatcher()` exported and called from `index.ts`
- [ ] `pnpm --filter @cip/hr-service typecheck` passes
