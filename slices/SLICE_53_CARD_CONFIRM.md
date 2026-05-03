# Slice 53 — Card-driven write-action confirm + invoke router

> **Prerequisite:** Slice 46 deployed (PostgresSaver — the card click can arrive after a pod restart, so the suspended graph must be durable). Slice 46b deployed (`interrupt()` confirm — this slice changes the rendering of the suspension, not the suspension mechanism itself). Slice 47 (slash registry) helpful but not required — invoke routing is independent.
> **Package:** `@cip/teams-bot`. One migration in `@cip/hr-service` for the new tunables.
> **Verify:** "disable Jane Smith" → an Adaptive Card arrives with the proposed action, target, and `[Confirm] [Cancel]` buttons → click [Confirm] → the disable tool fires → the card is replaced in place with a success state. Same with [Cancel] → the card is replaced with "Cancelled."; no tool call. Per-tenant fallback `lg.confirm_render_mode = 'text'` reverts to the Slice 46b behaviour byte-for-byte.

---

## Why this slice exists

The Slice 46b confirm UX is text. The bot says "About to: Disable Jane Smith. Reply yes/no." and then matches the user's next message against `lg.affirmation_patterns` / `lg.cancellation_patterns`. Three real problems:

1. **Context bleed.** "yes" typed while the user is mid-thought on a different topic still resolves the suspended interrupt. The pattern matcher can't tell the user is replying to something else.
2. **No structured target.** A long write — "assign hr_standard role to Jane Smith" — renders as a single line. The user can't see the before/after, the entity id, or the tool args until *after* it runs.
3. **Pattern brittleness.** The tunables list keeps growing as we discover new affirmations ("do it", "send it", "ship it", "pull the trigger"). Cards short-circuit the whole problem with two buttons.

A card replaces all three: explicit click, structured payload, no NLP at the gate. `Action.Execute` arrives as an `adaptiveCard/action` invoke whose `value.action.data` carries the verdict — no message text, no pattern match.

This slice also lays the **invoke-router** infrastructure that any future Universal Action flow (cert submission dialog, employee detail card, role-assignment confirm) will reuse. Today there is no invoke-action handler in the bot; only `signin/*` is overridden in `onInvokeActivity`. After this slice, `adaptiveCard/action` is wired through a verb-dispatched router that future cards can extend by registering a handler.

## What this slice IS

1. **Confirm card builder** at [`packages/teams-bot/src/teams-protocol/cards/confirm.ts`](../packages/teams-bot/src/teams-protocol/cards/confirm.ts). Pure function:
   ```ts
   export function buildConfirmCard(payload: ConfirmInterruptPayload): IAdaptiveCard {
     // Returns an Adaptive Card v1.5 with:
     //   - TextBlock heading "Confirm action"
     //   - FactSet for tool name + each arg (truncated per lg.confirm_card_max_arg_chars)
     //   - TextBlock body for payload.summary
     //   - ActionSet with two Action.Execute buttons:
     //       verb='confirmWriteAction', data={turnId, threadId, decision:'confirm', proposedAt}
     //       verb='confirmWriteAction', data={turnId, threadId, decision:'cancel',  proposedAt}
     //   - entities: AIGeneratedContent disclosure
   }
   ```
   `Action.Execute` (not `Action.Submit`) so the click carries verified `from.aadObjectId` and so we can return an updated card body in the invoke response.

2. **`interrupt()` payload becomes structured** in [`confirm.ts`](../packages/teams-bot/src/langgraph/nodes/confirm.ts):
   ```ts
   const decision = interrupt({
     kind:       'write_confirm',
     summary:    state.proposedWriteCall.summary,    // unchanged from 46b
     toolName:   state.proposedWriteCall.toolName,
     toolArgs:   state.proposedWriteCall.toolArgs,
     turnId:     state.turnId,                       // NEW — stamped into the card data
     proposedAt: Date.now(),                         // NEW — anti-replay guard, see Hard rules
   });
   ```
   The decision arrives as either a string (text-mode user reply, Slice 46b path) OR a structured `{decision: 'confirm' | 'cancel'}` (card-click path). `classify-confirm-reply.ts` accepts both.

3. **Runner branches on `lg.confirm_render_mode`** in [`runner.ts`](../packages/teams-bot/src/langgraph/runner.ts) when it detects an active interrupt:
   - `'card'` (default): build the confirm card from the interrupt payload, send via `sendActivity`. Stash the card's activity id on the suspended state's metadata so the invoke handler can `updateActivity` later.
   - `'text'`: existing 46b path — send `payload.summary + " Reply yes/no."` as plain text.
   The interrupt payload itself is the same in both modes; only the rendering differs.

4. **Invoke router** at [`packages/teams-bot/src/teams-protocol/invoke-router.ts`](../packages/teams-bot/src/teams-protocol/invoke-router.ts):
   ```ts
   // Verb-dispatched. New handlers register against the verb namespace
   // they own (confirm-gate uses 'confirmWriteAction'; future flows
   // pick their own).
   export interface InvokeHandler {
     verb: string;
     handle(ctx: InvokeContext): Promise<InvokeResult>;
   }
   export function registerInvokeHandler(h: InvokeHandler): void;
   export async function dispatchInvoke(context: TurnContext): Promise<InvokeResult | null>;
   ```
   Returns `null` if no handler matches → bot falls back to the existing `super.onInvokeActivity` path. Nothing else routes through this in 53.

5. **Confirm-action handler** registered against verb `confirmWriteAction`. Validates the click then resumes the graph:
   - Verify `data.turnId` and `data.threadId` are present and match.
   - Verify `Date.now() - data.proposedAt < lg.confirm_card_ttl_seconds * 1000` (default 600 = 10 min).
   - Verify the clicker (`activity.from.aadObjectId`) matches the original turn's caller — read from the suspended checkpoint's `state.values.employeeAadId`. Reject otherwise.
   - Verify the graph at this `thread_id` is *actually* suspended at a `confirm` interrupt. If not (e.g., the user already replied "yes" via text and the graph completed) — return a "Already handled" card.
   - Resume with `Command({resume: {decision: data.decision}})`.
   - Build the result card (success / cancel / refusal) and return it as the `AdaptiveCardInvokeResponse` body so Teams replaces the original card in place.
   - Send the resulting AIMessage as a follow-up `sendActivity` (same as today's runner does after a normal turn).

6. **`bot.ts` wires the router.** `onInvokeActivity` in [`bot.ts`](../packages/teams-bot/src/bot.ts) routes `adaptiveCard/action` through `dispatchInvoke()` first; falls through to `super.onInvokeActivity(context)` for `signin/*` and anything unhandled. Existing `signin/failure` short-circuit stays as-is.

7. **Two new tunables** seeded by a migration:
   | Key | Default | Purpose |
   |---|---|---|
   | `lg.confirm_render_mode` | `"card"` | One of `"card"` \| `"text"`. Per-tenant kill switch back to 46b behaviour. |
   | `lg.confirm_card_ttl_seconds` | `600` | Max age of a confirm card before clicks are rejected. Anti-replay guard. |
   | `lg.confirm_card_max_arg_chars` | `300` | Per-arg truncation cap inside the FactSet body. |

## What this slice is NOT

- **Not a new card flow.** This is the confirm gate, period. Cert submission, employee detail, and role-assignment cards are deferred to Slice 54+. The invoke router scaffolding is laid in this slice but only one verb (`confirmWriteAction`) registers against it.
- **Not a Dialog (Task Module).** No `task/fetch` / `task/submit` plumbing. The confirm card is sent inline; clicks come back as `adaptiveCard/action`, not `task/submit`. Dialog work is Slice 54.
- **Not a state-shape change.** `state.proposedWriteCall` (renamed in Slice 46b) is unchanged. The `interrupt()` payload grows two scalar fields but those are *payload* (carried in the suspended task's interrupts array), not state-graph schema.
- **Not a behaviour change at the gate level.** `gateWriteAction` still decides whether a confirm is needed; `lg.authorized_write_verbs` still bypasses the gate. Only the *rendering* of the confirm changes.
- **Not a removal of pattern-based affirm/cancel.** Text mode is preserved because (a) it's the safe fallback if Teams ever fails to render the card, and (b) some clients (mobile-web, certain federated environments) historically render `Action.Execute` poorly — operators want a per-tenant lever.
- **Not Action.Refresh.** The confirm card doesn't auto-refresh. It's TTL'd to 10 min via `lg.confirm_card_ttl_seconds` and stale clicks are rejected with an explanatory card.

---

## Card payload shape (sent to Teams)

```jsonc
{
  "type": "AdaptiveCard",
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "version": "1.5",
  "body": [
    { "type": "TextBlock", "text": "Confirm action", "size": "Large", "weight": "Bolder", "wrap": true },
    { "type": "TextBlock", "text": "<payload.summary>", "wrap": true, "spacing": "Small" },
    {
      "type": "FactSet",
      "facts": [
        { "title": "Tool",   "value": "<payload.toolName>" },
        { "title": "<arg1>", "value": "<truncated arg1 value>" }
        // ...one Fact per arg, truncated to lg.confirm_card_max_arg_chars
      ]
    }
  ],
  "actions": [
    {
      "type": "Action.Execute",
      "verb": "confirmWriteAction",
      "title": "Confirm",
      "style": "positive",
      "data": { "turnId": "<8-hex>", "threadId": "<conv-id>", "decision": "confirm", "proposedAt": 1714752000000 }
    },
    {
      "type": "Action.Execute",
      "verb": "confirmWriteAction",
      "title": "Cancel",
      "style": "destructive",
      "data": { "turnId": "<8-hex>", "threadId": "<conv-id>", "decision": "cancel", "proposedAt": 1714752000000 }
    }
  ],
  "entities": [
    { "type": "https://schema.org/Message", "@type": "Message", "additionalType": ["AIGeneratedContent"] }
  ]
}
```

The result card returned in the `AdaptiveCardInvokeResponse` body has the same skeleton with the actions removed and the heading replaced by `"✓ Confirmed"` / `"✕ Cancelled"` / `"⚠ Already handled"`.

---

## Invoke handler dispatch

```ts
// packages/teams-bot/src/bot.ts (sketch — onInvokeActivity)
protected override async onInvokeActivity(
  context: TurnContext,
): Promise<{ status: number; body?: unknown }> {
  if (context.activity.name === 'signin/failure') {
    // existing handler, unchanged
    return { status: 200 };
  }
  if (context.activity.name === 'adaptiveCard/action') {
    const result = await dispatchInvoke(context);
    if (result) return { status: result.statusCode, body: result.body };
    // No verb matched → fall through to default
  }
  return super.onInvokeActivity(context);
}
```

```ts
// packages/teams-bot/src/teams-protocol/invoke-router.ts (sketch)
const handlers = new Map<string, InvokeHandler>();
export function registerInvokeHandler(h: InvokeHandler) {
  if (handlers.has(h.verb)) throw new Error(`duplicate invoke verb: ${h.verb}`);
  handlers.set(h.verb, h);
}
export async function dispatchInvoke(context: TurnContext): Promise<InvokeResult | null> {
  const verb = (context.activity.value as { action?: { verb?: string } } | undefined)?.action?.verb;
  if (!verb) return null;
  const h = handlers.get(verb);
  if (!h) return null;
  return h.handle({ context });
}
```

---

## Files in scope

```
packages/teams-bot/src/teams-protocol/cards/confirm.ts                 NEW    (buildConfirmCard + buildResultCard)
packages/teams-bot/src/teams-protocol/invoke-router.ts                 NEW    (registry + dispatch)
packages/teams-bot/src/teams-protocol/invoke-handlers/confirm-write.ts NEW    (verb=confirmWriteAction handler)
packages/teams-bot/src/langgraph/nodes/confirm.ts                      MODIFY (interrupt payload + structured-decision branch)
packages/teams-bot/src/langgraph/util/classify-confirm-reply.ts        MODIFY (accept string | { decision } union)
packages/teams-bot/src/langgraph/runner.ts                             MODIFY (read render-mode tunable; send card or text)
packages/teams-bot/src/bot.ts                                          MODIFY (route adaptiveCard/action through dispatchInvoke)
packages/teams-bot/src/index.ts                                        MODIFY (registerInvokeHandler at boot)

packages/hr-service/src/db/migrations/<NNN>_lg_confirm_render_mode.sql NEW   (seed three tunable keys)

slices/SLICE_53_CARD_CONFIRM.md                                        this file
```

No new state field on `StateAnnotation`. No new MCP tool. No manifest change.

---

## Hard rules

- **No new failure mode at the gate.** If `Action.Execute` fails to deliver in Teams (rare; mobile-web glitches), the user can still type "yes"/"no" and the text-mode classifier resolves the same suspension. Both paths feed the same `interrupt()` resume.
- **Idempotency on duplicate clicks.** Teams retries `Action.Execute` after 10 s if it doesn't see a 200. The handler MUST check the graph's suspension state before resuming — if the graph already advanced past `confirm`, return the "Already handled" result card with `statusCode: 200` so Teams stops retrying. Don't crash, don't double-execute.
- **Authorisation on click, not just on initial planner pass.** The handler re-fetches the user's permissions (cached) and asserts the proposed tool's `requiredPermission`. Server-side `assertPermission` in the tool handler still fires regardless — this is UX hardening on top of the existing security gate.
- **Verified user identity.** `Action.Execute` carries `from.aadObjectId` validated by the Bot Framework signature. The handler MUST verify it matches the turn's original user (read from the suspended checkpoint). Reject mismatches with a refusal card so a different user in a shared chat can't approve someone else's action.
- **No `tenantId` in card data.** The card's `data` payload carries only `turnId`, `threadId`, `decision`, `proposedAt`. Tenant resolution flows from `authInfo.token` per the Seven Non-Negotiables (rule 6).
- **TTL'd cards.** `proposedAt` is checked against `lg.confirm_card_ttl_seconds`. A click on a stale card returns a card explaining the action expired; no resume.
- **No magic numbers.** Three tunables seeded; runner and handler read all of them through the existing `getTunable<T>()` helper.
- **No `Action.Submit`.** New cards always use `Action.Execute` (Universal Action). The footer card from Slice 46e (`messageBack`) stays as-is — out of scope.
- **Stubs forbidden.** Per Seven Non-Negotiables. The handler ships with a working body; no `throw new Error('not implemented')` placeholders.
- **Card rendering is pure.** `buildConfirmCard` takes the interrupt payload and returns JSON; no I/O. Same for `buildResultCard`.

---

## Verification

**Card-mode confirm path:**
1. Send "disable Jane Smith".
2. An Adaptive Card arrives titled "Confirm action" with `Tool: disable_employee`, the args (entity id, name) in a FactSet, and two buttons.
3. Click [Confirm].
4. Teams shows the card replaced with "✓ Confirmed" + the result line.
5. hr-service audit log shows the disable executed once.

**Card-mode cancel path:**
1. Send "disable Jane Smith".
2. Click [Cancel].
3. Card is replaced with "✕ Cancelled."; no tool fired (verify hr-service audit).

**Pod-restart resilience:**
1. Send "disable Jane Smith". Card arrives.
2. `kubectl rollout restart -n cip-app deploy/teams-bot`. Wait for new pod to be ready.
3. Click [Confirm]. The new pod reads the suspended graph from PostgresSaver, resumes, executes the disable, replaces the card. Same result as without restart.

**TTL-rejection path:**
1. Set `lg.confirm_card_ttl_seconds = 5` for the test tenant.
2. Send "disable Jane Smith". Wait 6 s.
3. Click [Confirm]. Card is replaced with an "Action expired — please ask again" card. No tool fired.

**Wrong-user click rejection (channel/group only — N/A in 1:1):**
1. In a group chat, user A sends "disable Jane Smith". Card arrives.
2. User B clicks [Confirm].
3. Card is replaced with "Only the user who proposed this action can confirm it." No tool fired. The original user A can still click and proceed normally.

**Idempotency on duplicate click:**
1. Send "disable Jane Smith". Click [Confirm].
2. Within 10 s, the underlying transport retries the invoke (simulate by replaying the same `Action.Execute` invoke through the `/api/messages` endpoint).
3. Second invoke returns the "Already handled" card with `statusCode: 200`. Tool fired exactly once.

**Text-mode fallback:**
1. Set `lg.confirm_render_mode = 'text'` for the test tenant.
2. Send "disable Jane Smith".
3. Bot replies with text "About to: …. Reply yes/no." (Slice 46b behaviour, no card).
4. Reply "yes". Tool fires. Same outcome as Slice 46b.

**Mixed-mode interleave (text-mode user replies "yes" while a card-mode prior turn is still suspended for them in another thread):**
1. Card sent in thread A. Card sent in thread B (different thread, same user).
2. User clicks [Confirm] in B. Resumes only B. A remains suspended until clicked or expired.
3. Verify A's checkpoint is still suspended; B's tool fired.

**Re-plan path (preserved from Slice 46b):**
1. Send "disable Jane Smith". Card arrives.
2. Instead of clicking, type "actually disable Bob Smith".
3. The text message is treated as a fresh turn (the suspended graph remains; runner ingests the new HumanMessage and re-plans). New confirm card for Bob arrives. Old Jane card stays interactive until TTL — but clicking it now will hit the "graph not suspended at confirm anymore" branch and return "Already handled". (This is acceptable — the user already moved on.)

---

## Out of scope (deferred)

- Cert-submission dialog via `task/fetch` / `task/submit` — Slice 54.
- Employee-detail card with `[Disable] [Reassign role] [View certs]` action panel — Slice 54+.
- `Action.Refresh` for stale data — separate slice when the first refresh-worthy card lands (`/metrics` is a candidate).
- Citations entity on AI replies — separate slice; doesn't depend on this one.
- Replacing the Slice 46e `/turn` footer card's `messageBack` action with `Action.Execute` — non-load-bearing churn; the footer works fine.
- Migrating the welcome card and footer card to `@microsoft/teams.cards` builder helpers — the package is part of the Teams AI Library SDK we deliberately don't depend on; raw IAdaptiveCard JSON is the contract.

---

## Cross-slice notes

- This slice depends on Slice 46 + 46b. With MemorySaver (pre-46) the suspended graph dies on pod restart and the click handler's "is the graph still suspended?" check never sees a valid suspension. With the hand-rolled `pendingWriteCall` reducer (pre-46b) there's no `interrupt()` to feed `Command({resume})` into.
- The invoke router is intentionally minimal in this slice. Future verb registrations (cert-submit, employee-detail) will live in their own slice docs and call `registerInvokeHandler({ verb, handle })` from the same boot path. The router's only contract is "verb-dispatched, returns null on miss."
- Slice 48's Langfuse callback already captures `__interrupt__` spans. Card-click resumes flow through the same `graph.invoke(..., command)` path, so the trace tree is unchanged — same `runName: 'turn-<id>'`, same metadata, same span hierarchy. No telemetry work needed in this slice.
- Slice 49's `extractMemory` runs after `respond` regardless of whether the AIMessage came from a card click or a text reply — no interaction.
- Slice 52's typing-indicator refresh runs during `graph.invoke` execution. A confirm-card resume is `graph.invoke(..., command)` — same code path, so the typing indicator behaves identically to a normal turn from the runner's perspective.
- The `lg.affirmation_patterns` and `lg.cancellation_patterns` tunables remain seeded and consulted by `classifyConfirmReply()` for the text-mode fallback. They are not removed in this slice.
