# Slice 58D-A — generic person matcher (`MatchPersonWorkflow`)

> **Why this exists:** Multiple HR-adjacent flows need to resolve "who
> is this about?" from free-text hints, NER hits, or extracted fields —
> cert (now), incident reports (future), training enrollment (future),
> reminder workflows. Today this lives inline as
> `match-employee.activity.ts` in cert; replicating it across modules
> would mean repeated drift on canonicalization, scoring, HITL,
> permissions, and audit.
>
> 58D-A lifts person matching to a **shared workflow** with a clean
> contract: candidate text in, `{employeeId, confidence, source}` out.
> HITL is baked in (uploader pickcard → admin queue cascade). All
> resolutions land in a rich training/audit table for evaluation.
>
> **Pure additive infra.** No consumer changes; cert integrates in
> 58D-B. Lives entirely on hr-service — no doc-service edits, no
> cross-DB lookups.

---

## Files in scope

```
packages/hr-service/src/modules/people/                              NEW directory
├── workflows/
│   ├── match-person.workflow.ts                                     NEW (the workflow)
│   └── index.ts                                                     NEW
├── activities/
│   ├── aad-precheck.activity.ts                                     NEW (self-pick fast path)
│   ├── canonicalize-person-hint.activity.ts                         NEW (LLM normalization)
│   ├── load-employee-shortlist.activity.ts                          NEW (pg_trgm similarity)
│   ├── score-candidates.activity.ts                                 NEW
│   ├── notify-person-pickcard.activity.ts                           NEW (uses @cip/shared notifier)
│   ├── persist-person-match-resolution.activity.ts                  NEW (insert + update)
│   └── index.ts                                                     NEW
├── mcp-tools/
│   ├── match-person-list.tool.ts                                    NEW (admin queue listing)
│   ├── match-person-resolve.tool.ts                                 NEW (admin signal forwarder)
│   └── index.ts                                                     NEW
└── db/
    └── queries/person-match-resolutions.ts                          NEW (drizzle queries)

packages/hr-service/src/db/migrations/
├── 042_person_match_resolutions.sql                                 NEW (table + indexes + RLS + pg_trgm extension)
└── 043_match_person_tunables.sql                                    NEW (5 tunables)

packages/hr-service/src/db/schema.ts                                 MOD (drizzle: personMatchResolutions table)
packages/hr-service/src/services/permission-catalog-seed.ts          MOD (add hr.people.match)

# Type contracts shared with future module-workflow callers
packages/shared/src/types/match-person.ts                            NEW (MatchPersonInput, MatchPersonOutput, schemas)
packages/shared/src/index.ts                                         MOD (export MatchPersonInput/Output + schemas)

# Bot invoke handler for the uploader pickcard
packages/teams-bot/src/teams-protocol/invoke-handlers/hr-person-pick.ts   NEW
packages/teams-bot/src/teams-protocol/invoke-router.ts                    MOD (registration; comment update from documents.subject.pick → hr.person.pick)

# Worker registration
packages/hr-service/src/workers/temporal-worker.ts                   MOD (register people module workflow + activities)

# Langfuse-hosted prompt — code-resident FALLBACK only
packages/hr-service/src/modules/people/prompts/canonicalize-fallback.ts   NEW (~30 lines, slice 41 pattern)
```

---

## Hard rules

1. **No static nickname / alias maps.** Names are normalized via LLM
   canonicalization (Langfuse prompt `hr.people.canonicalize`,
   FALLBACK in code per slice 41). Shortlist via Postgres pg_trgm
   `similarity()`. No hand-curated lookup tables. (Memory: no
   hardcoded registries.)

2. **Active-only by default.** `policy.includeInactive=false` is the
   default — terminated/disabled employees are excluded from the
   shortlist. Callers explicitly set `true` for historical lookups
   (e.g., reviewing a cert issued before someone left).

3. **HITL pickcards use `@cip/shared/notifications.notifyTeamsCard`.**
   No new notifier code. The infra-move set this up exactly for this
   case. Cert-specific copy (`bot.documents.subject_hint_parse`-style
   prompts) stays in this module's prompts directory.

4. **Single resolution row per workflow execution.**
   `cip_hr.person_match_resolutions` is updated as the workflow
   progresses; multi-click race is logged in `audit_events`, but the
   table holds the canonical answer. First Temporal `condition()`
   fire wins; later clicks see the workflow already advanced.

5. **Lives entirely on hr-service.** No doc-service edits. The
   matcher consumes only `cip_hr.employees` + `cip_hr.tenants` +
   `bot_tunables` — all on hr-service's DB. Cross-DB problem doesn't
   apply.

6. **Workflow ID pattern**:
   `MatchPerson-${tenantId}-${callerSubmissionId}`. Caller decides
   the entity ID (cert uses `certSubmissionId`, incident would use
   `incidentId`); matcher just embeds it. **Comment** the pattern on
   the line above `startChild()` per CLAUDE.md non-negotiable #4.

7. **AAD pre-check is the first phase.** If the candidate text is
   self-referential ("for me", "this is mine", "my own") **AND**
   `context.uploaderEmployeeId` (AAD object id) maps to an active
   employee in the tenant, return immediately with
   `source='auto_self', confidence=1.0`. No LLM call, no shortlist.
   This is the fast path for the most common case.

8. **Admin pickcard does NOT proactively push.** Admins discover
   pending resolutions by polling `match_person_list` MCP tool; they
   resolve via `match_person_resolve`. No tenant-channel routing
   required for now (deferred until proactive push has a clear
   use-case).

9. **Tunables read at workflow entry, not per-activity.** The
   matcher reads its 5 tunables once via
   `loadDocumentsTunablesActivity`-equivalent (or inline pool query)
   at workflow start. Mid-flight tunable changes are not honoured
   until the next workflow run.

10. **No new types in `@cip/shared/types/`** beyond `match-person.ts`
    itself. Inputs/outputs are one cohesive module.

---

## Workflow shape

```typescript
// packages/shared/src/types/match-person.ts (excerpt)

export const MatchPersonInputSchema = z.object({
  tenantId:       z.string().uuid(),
  candidateText:  z.string().min(0).max(500),

  structuredHints: z.object({
    fullName:        z.string().optional(),
    firstName:       z.string().optional(),
    lastName:        z.string().optional(),
    email:           z.string().email().optional(),
    department:      z.string().optional(),
    externalUserId:  z.string().optional(),     // AAD object id when known
  }).optional(),

  context: z.object({
    source:               z.string(),             // 'cert_holder' | 'incident_subject' | etc.
    callerSubmissionId:   z.string(),             // entity ID; embedded in the workflow ID
    conversationId:       z.string().optional(),  // for HITL pickcard delivery
    uploaderEmployeeId:   z.string().optional(),  // AAD object id; for self-pick + pickcard auth
  }),

  policy: z.object({
    onNoMatch:        z.enum(['fail', 'admin_queue', 'create_stub']).default('fail'),
    onAmbiguous:      z.enum(['uploader_pickcard', 'admin_queue', 'fail']).default('uploader_pickcard'),
    autoThreshold:    z.number().min(0).max(1).optional(),
    includeInactive:  z.boolean().default(false),
  }),
})
export type MatchPersonInput = z.infer<typeof MatchPersonInputSchema>

export const MatchPersonOutputSchema = z.object({
  outcome:     z.enum(['resolved', 'no_resolution']),
  employeeId:  z.string().uuid().optional(),
  confidence:  z.number().min(0).max(1).optional(),
  source:      z.enum(['auto_self', 'auto_unique', 'hitl_uploader', 'hitl_admin']).optional(),
  evidence:    z.record(z.unknown()),    // canonicalization, shortlist, HITL trail
})
export type MatchPersonOutput = z.infer<typeof MatchPersonOutputSchema>
```

Phases inside `MatchPersonWorkflow`:

```
┌──────────────────────────┐
│ 1. Insert resolution row │ outcome='pending'
└────────────┬─────────────┘
             │
┌────────────▼─────────────┐
│ 2. AAD pre-check         │ self-referential + uploader maps to active employee?
└────────────┬─────────────┘ ──── yes ────▶ persist + return source='auto_self'
             │ no
┌────────────▼─────────────┐
│ 3. Canonicalize (LLM)    │ → { firstName?, lastName?, email?, department?, role? }
└────────────┬─────────────┘
             │
┌────────────▼─────────────┐
│ 4. Shortlist (pg_trgm)   │ → top N candidates (default 5)
└────────────┬─────────────┘
             │
┌────────────▼─────────────┐
│ 5. Score candidates      │ pg_trgm sim + structured-hint matches (department, etc.)
└────────────┬─────────────┘
             │
┌────────────▼─────────────┐
│ 6. Decide                │ 1 hit ≥ autoThreshold → auto_unique
└────────────┬─────────────┘ 0 hits → run policy.onNoMatch
             │ N hits or 1 below threshold
             │
┌────────────▼─────────────┐
│ 7. HITL pickcard         │ audience = 'uploader' (default) → 24h TTL
└────────────┬─────────────┘ → cascade to 'admin' → 7d TTL → fail
             │
┌────────────▼─────────────┐
│ 8. Persist + return      │ update row + return MatchPersonOutput
└──────────────────────────┘
```

The workflow body (compact):

```typescript
export async function MatchPersonWorkflow(input: MatchPersonInput): Promise<MatchPersonOutput> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `MatchPerson-${input.tenantId}-${input.context.callerSubmissionId}`
  const tunables = await loadPeopleTunablesActivity({ tenantId: input.tenantId });
  const resolutionId = await persistPersonMatchResolutionActivity({ phase: 'init', input });

  let pickedSignal: PersonPickedSignal | undefined;
  setHandler(personPickedSignal, (s) => { pickedSignal = s; });

  // Phase 2: AAD pre-check
  const selfMatch = await aadPrecheckActivity({
    tenantId:           input.tenantId,
    candidateText:      input.candidateText,
    uploaderEmployeeId: input.context.uploaderEmployeeId,
  });
  if (selfMatch) {
    return persistAndReturn(resolutionId, {
      outcome: 'resolved',
      employeeId: selfMatch.employeeId,
      confidence: 1.0,
      source: 'auto_self',
      evidence: { aadPrecheck: selfMatch },
    });
  }

  // Phase 3-5: canonicalize → shortlist → score
  const canonicalization = await canonicalizePersonHintActivity({
    tenantId:      input.tenantId,
    candidateText: input.candidateText,
    structuredHints: input.structuredHints,
  });
  const shortlist = await loadEmployeeShortlistActivity({
    tenantId:        input.tenantId,
    canonicalized:   canonicalization,
    includeInactive: input.policy.includeInactive,
    max:             tunables.shortlistMax,
  });
  const scored = await scoreCandidatesActivity({ canonicalization, shortlist });

  // Phase 6: decide
  const autoThreshold = input.policy.autoThreshold ?? tunables.autoThreshold;
  if (scored.length === 1 && scored[0].score >= autoThreshold) {
    return persistAndReturn(resolutionId, {
      outcome: 'resolved',
      employeeId: scored[0].employeeId,
      confidence: scored[0].score,
      source: 'auto_unique',
      evidence: { canonicalization, shortlist, scored },
    });
  }
  if (scored.length === 0) {
    if (input.policy.onNoMatch === 'fail') {
      return persistAndReturn(resolutionId, {
        outcome: 'no_resolution',
        evidence: { canonicalization, shortlist: [], reason: 'no_matches' },
      });
    }
    // 'admin_queue' falls through to phase 7 with audience='admin'.
    // 'create_stub' is reserved; throws not-implemented in 58D-A.
  }

  // Phase 7: HITL pickcard with TTL cascade
  const audience = decideAudience(input.policy.onAmbiguous, scored.length);
  await notifyPersonPickcardActivity({
    tenantId:       input.tenantId,
    resolutionId,
    audience,
    candidates:     scored,
    conversationId: input.context.conversationId,
  });

  // Uploader tier (audience='uploader'): wait up to uploaderTtlHours
  if (audience === 'uploader') {
    const got = await condition(() => pickedSignal !== undefined, `${tunables.uploaderTtlHours} hours`);
    if (!got) {
      // Cascade to admin
      await notifyPersonPickcardActivity({ tenantId: input.tenantId, resolutionId, audience: 'admin', candidates: scored });
    }
  }
  // Admin tier: wait up to adminTtlHours; on expiry fail.
  if (pickedSignal === undefined) {
    const got = await condition(() => pickedSignal !== undefined, `${tunables.adminTtlHours} hours`);
    if (!got) {
      return persistAndReturn(resolutionId, {
        outcome: 'no_resolution',
        evidence: { canonicalization, shortlist, scored, reason: 'hitl_ttl_exhausted' },
      });
    }
  }

  return persistAndReturn(resolutionId, {
    outcome: 'resolved',
    employeeId: pickedSignal!.employeeId,
    confidence: scored.find(c => c.employeeId === pickedSignal!.employeeId)?.score ?? 0,
    source: pickedSignal!.actorRole === 'uploader' ? 'hitl_uploader' : 'hitl_admin',
    evidence: { canonicalization, shortlist, scored, hitl: pickedSignal },
  });
}

export const personPickedSignal = defineSignal<[PersonPickedSignal]>('personPicked');
export interface PersonPickedSignal {
  employeeId:  string;
  actorRole:   'uploader' | 'admin';
  actorAad?:   string;
}
```

---

## Activity contracts (compact)

| Activity | Input | Output | Notes |
|---|---|---|---|
| `aadPrecheckActivity` | `{tenantId, candidateText, uploaderEmployeeId?}` | `{employeeId} \| null` | Detects self-referential phrases via small regex set in code; if hit AND uploader maps to active employee, returns the employee. Single SQL lookup. |
| `canonicalizePersonHintActivity` | `{tenantId, candidateText, structuredHints?}` | `{firstName?, lastName?, email?, department?, role?}` | LLM via `cip-classifier` alias (tunable). Langfuse prompt `hr.people.canonicalize`; FALLBACK in code. |
| `loadEmployeeShortlistActivity` | `{tenantId, canonicalized, includeInactive, max}` | `Array<{employeeId, fullName, score, active}>` | pg_trgm `similarity()` over `employees.full_name`; tenant + active filter; orders by score DESC limit `max`. |
| `scoreCandidatesActivity` | `{canonicalization, shortlist}` | `Array<{employeeId, score, breakdown}>` | Combines pg_trgm score with structured-hint matches (department alignment etc.). Pure function — no I/O. |
| `notifyPersonPickcardActivity` | `{tenantId, resolutionId, audience, candidates, conversationId?}` | `void` | Builds adaptive card via `buildFactSetCard`; calls `notifyTeamsCard({ channelType: audience === 'uploader' ? 'uploader-1to1' : 'hr-admin' })`. 404 channel-not-registered is non-fatal. |
| `persistPersonMatchResolutionActivity` | `{phase: 'init' \| 'update' \| 'final', resolutionId?, ...}` | `{resolutionId}` | Idempotent insert/update. Final phase writes `resolved_at + outcome + evidence`. |

---

## Bot invoke handler

`packages/teams-bot/src/teams-protocol/invoke-handlers/hr-person-pick.ts`:

```typescript
import { registerInvokeHandler } from '../invoke-router.js';

registerInvokeHandler({
  verb: 'hr.person.pick',

  // Hard scope: only the uploader can click the uploader pickcard. Reads
  // resolutionId from the card payload, looks up context_meta.uploaderEmployeeId
  // (AAD object id), returns it. Returns undefined for admin pickcards
  // (any user with hr.people.match permission can click).
  authorizedUser: async ({ data }) => {
    const resolutionId = data['resolutionId'] as string;
    const row = await fetchResolution(resolutionId);
    if (row.hitl_audience === 'uploader') {
      return row.context_meta.uploaderEmployeeId as string | undefined;
    }
    return undefined;  // admin pickcard — permission check handled separately
  },

  handle: async ({ data }) => {
    const resolutionId = data['resolutionId'] as string;
    const employeeId   = data['employeeId']   as string;
    const row          = await fetchResolution(resolutionId);

    // For admin pickcard, verify the actor has hr.people.match permission.
    if (row.hitl_audience === 'admin') {
      const ok = await actorHasPermission(/* ... */, 'hr.people.match');
      if (!ok) return wrongUserCard();
    }

    // Signal MatchPersonWorkflow with the picked employee.
    await temporalClient.workflow.getHandle(row.workflow_id).signal('personPicked', {
      employeeId,
      actorRole: row.hitl_audience,
    });
    return resolvedCardReplacement(employeeId);
  },
});
```

---

## Admin polling MCP tools

### `match_person_list`

```
Permission: hr.people.match
Args:       { state?: 'pending_admin' | 'pending_any' | 'all', limit?: number }
Returns:    Array<{
              resolutionId,
              workflowId,
              source,                  // 'cert_holder' | ...
              candidateText,
              canonicalization,
              candidates: [{employeeId, fullName, score}],
              audience,                // 'uploader' | 'admin'
              initiatedAt,
              hitlOfferedAt,
            }>
```

Default `state='pending_admin'` shows only items the admin can act on
(uploader TTL elapsed or `policy.onAmbiguous='admin_queue'`).

### `match_person_resolve`

```
Permission: hr.people.match
Args:       { resolutionId, employeeId }
Effect:     Looks up the workflow_id; signals 'personPicked' with
            { employeeId, actorRole: 'admin', actorAad: <from authInfo> }.
            Idempotent: signal arrives once; subsequent calls receive a
            "this resolution is no longer pending" error.
Audit:      person_match_resolved (actor_role='admin')
```

---

## Permissions

`permission-catalog-seed.ts` adds:

```typescript
{ service: 'hr-service', module: 'people', permission: 'hr.people.match',
  description: 'Resolve ambiguous person-match queue items (cross-module HITL)' },
```

(`module='people'` is a new module value within hr-service. The
catalog's `(service, module, permission)` PK accepts new modules
without migration.)

---

## Tunables

`043_match_person_tunables.sql` seeds against the zero-UUID:

```sql
INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_auto_threshold',     '0.9',
    'Single-match auto-resolve threshold; ≥ this score → auto_unique'),
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_uploader_ttl_hours', '24',
    'Wait this long for uploader pickcard before cascading to admin queue'),
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_admin_ttl_hours',    '168',
    'Admin queue TTL; on expiry the matcher fails with no_resolution'),
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_shortlist_max',      '5',
    'Max candidates returned by pg_trgm shortlist'),
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_canonicalize_model', '"cip-classifier"',
    'LiteLLM alias for the canonicalization step (resolved via @cip/shared resolveAlias)')
ON CONFLICT (tenant_id, key) DO NOTHING;
```

---

## Database

`042_person_match_resolutions.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE cip_hr.person_match_resolutions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  workflow_id              TEXT NOT NULL,
  caller_submission_id     TEXT NOT NULL,
  initiated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at              TIMESTAMPTZ,

  -- Inputs
  source                   TEXT NOT NULL,
  candidate_text           TEXT NOT NULL,
  structured_hints         JSONB,
  context_meta             JSONB NOT NULL,
  policy                   JSONB NOT NULL,

  -- Process
  canonicalization         JSONB,
  shortlist                JSONB,
  scored_candidates        JSONB,
  hitl_offered             BOOLEAN NOT NULL DEFAULT false,
  hitl_offered_at          TIMESTAMPTZ,
  hitl_audience            TEXT,
  hitl_actor_employee_id   UUID,
  hitl_actor_role          TEXT,

  -- Outcome
  resolved_employee_id     UUID,
  resolution_source        TEXT,
  confidence               DOUBLE PRECISION,
  outcome                  TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','resolved','no_resolution','cancelled')),

  evidence                 JSONB,

  CONSTRAINT pmr_resolved_when_terminal
    CHECK (
      (outcome = 'pending'  AND resolved_at IS NULL)
      OR (outcome <> 'pending' AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX pmr_tenant_workflow_idx
  ON cip_hr.person_match_resolutions (tenant_id, workflow_id);
CREATE INDEX pmr_tenant_outcome_idx
  ON cip_hr.person_match_resolutions (tenant_id, outcome)
  WHERE outcome = 'pending';
CREATE INDEX pmr_tenant_initiated_idx
  ON cip_hr.person_match_resolutions (tenant_id, initiated_at DESC);

-- pg_trgm index for fast similarity scoring on the shortlist query.
CREATE INDEX employees_full_name_trgm_idx
  ON cip_hr.employees USING gin (full_name gin_trgm_ops);

-- RLS: tenant-scoped reads. Writes happen via system actor context
-- inside activities; no per-actor INSERT/UPDATE policy needed.
ALTER TABLE cip_hr.person_match_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY pmr_tenant_isolation
  ON cip_hr.person_match_resolutions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

---

## Acceptance criteria

1. **Self-referential happy path.** Hint "this is mine" + uploader maps
   to active employee → AAD pre-check resolves in < 100ms; resolution
   row shows `source='auto_self'`, `confidence=1.0`. No LLM call
   recorded in Langfuse.
2. **Single-match auto-resolve.** Hint "John Smith" with one active
   John Smith → `source='auto_unique'`, score ≥ 0.9. No HITL.
3. **Multi-match uploader pickcard.** Hint "for John" with 3 active
   Johns → uploader receives adaptive card; click resolves with
   `source='hitl_uploader'`, `hitl_actor_employee_id` populated.
4. **Pickcard authorization.** Non-uploader clicks the same card →
   router returns wrong-user replacement; resolution row unchanged.
5. **TTL cascade.** No uploader click for 24h → row's
   `hitl_audience` flips to `'admin'`; `match_person_list` returns it.
6. **Admin resolve.** Admin (with `hr.people.match`) calls
   `match_person_resolve` → row shows `source='hitl_admin'`.
7. **No match + onNoMatch='fail'.** Hint not matching any employee →
   workflow returns `outcome='no_resolution'`, `evidence.reason='no_matches'`.
8. **Admin TTL exhaustion.** No admin click for 7d → workflow returns
   `outcome='no_resolution'`, `evidence.reason='hitl_ttl_exhausted'`.
9. **Permission gate.** User without `hr.people.match` calling
   `match_person_resolve` → 403.
10. **Tenant RLS.** Tenant A cannot see tenant B's resolutions via
    `match_person_list`.

---

## Forward refs

- **58D-B**: cert workflow becomes the matcher's first consumer.
- **58E**: routing dispatch unrelated to this slice; cert Route-A
  rewrite preserves the matcher integration from 58D-B unchanged.
- **Future modules** (incident, training enrollment, reminders) call
  `MatchPersonWorkflow` with their own `source`, `callerSubmissionId`,
  and policy. The matcher itself is generic.
