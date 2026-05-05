# Slice 58D-B — cert workflow consumes `MatchPersonWorkflow`

> **Drift reconciliation (2026-05-05) — read before implementing.**
> The original 58D-B draft assumed cert workflow input fields that don't
> exist today. Post-pass against current code (`certification-processing.workflow.ts`,
> `match-employee.activity.ts`, schema):
>
> - `CertificationProcessingWorkflowInput` is `{ tenantId, submissionId, employeeId, objectStoreKey }`. The `employeeId` field is the **uploader** (set by the bot's `process_document` MCP call). No `uploaderHintText` or `conversationId` field exists today. **Don't expand the input shape in 58D-B** — that's 58E's job (Route-A rewrite). Pass available fields only.
> - The extracted-features field is `extraction.extractedFields.holderName` (and `.holderEmail`), NOT `extractedFeatures.holderName`. Update the candidate-text expression accordingly.
> - **Use `input.employeeId` (the uploader) as `context.uploaderEmployeeId`** in the matcher input. AAD pre-check works for self-uploads via this path. The bot has the uploader's AAD object id; we just thread it through.
> - **Uploader pickcard is degraded in 58D-B**: `conversationId` is undefined (no thread on cert workflow input). The matcher's pickcard activity passes conversationId optionally, and the bot's proactive endpoint resolves channels by `channelType`, so this is a non-fatal degradation — uploader-1to1 cards may still deliver via the bot's existing channel registry. If they don't, the 24h TTL cascades to admin tier (matches the post-Q4 default `onNoMatch='admin_queue'` behavior).
> - **`nickname-map.ts` (106 LOC of hand-curated static aliases at `packages/hr-service/src/modules/certifications/activities/nickname-map.ts`) becomes dead code** when match-employee.activity.ts becomes a shim. Per the no-static-nickname-maps rule (memory: `feedback_no_hardcoded_registries.md`), DELETE this file in 58D-B. It is the only consumer of itself outside the activity being replaced.
> - **`rejectCertSubmissionActivity` does not exist.** Add a small new activity at `packages/hr-service/src/modules/certifications/activities/reject-cert-submission.activity.ts` (~30 LOC) that updates `cert_submissions.submission_status = 'failed'` (the existing CHECK enum allows it) and writes an audit row. Wire it through `activities/index.ts`.
> - **Behavior-equivalent HITL gate**: today's `employeeMatch.confidence < 0.7` becomes `personResult.confidence < 0.7` (when `outcome === 'resolved'`). The HITL gate stays in cert (low-confidence cert-DATA HITL); subject ambiguity is owned by the matcher and never reaches this gate.
>
> Hard rule #4 of this slice still says "no deletes" — that rule was about preserving `match-employee.activity.ts` itself for Temporal worker continuity. `nickname-map.ts` is a private helper of that activity; deleting it is part of replacing the activity's logic, not a separate clean-up. Keep `match-employee.activity.ts` as the shim; delete `nickname-map.ts`.


> **Why this exists:** 58D-A added a generic person matcher as
> reusable infra. 58D-B is its first consumer: replaces cert's
> existing `match-employee.activity.ts` subject-resolution path with
> a child-workflow call to `MatchPersonWorkflow`.
>
> Behavior-equivalent refactor inside the **current** (pre-Route-A)
> cert workflow. The workflow's external contract (the `process_document`
> MCP tool surface) doesn't change — bot still kicks off cert workflow
> the same way until 58E reshapes that.
>
> 58E later rewrites cert as a Route-A consumer; the matcher
> integration carries forward unchanged.

---

## Files in scope

```
packages/hr-service/src/modules/certifications/                                  MOD
├── activities/
│   ├── match-employee.activity.ts                                              MOD (becomes thin shim that starts MatchPersonWorkflow as child workflow; keeps its export name for Temporal worker continuity)
│   └── (no other activity changes)
└── workflows/certification-processing.workflow.ts                              MOD (calls MatchPersonWorkflow as child; replaces inline employee-match logic)
```

That's it. Three-file slice.

---

## Hard rules

1. **Behavior equivalence on the happy path.** A cert with a clear
   single match resolves the same `employee_id` as before. Verified
   by the existing cert integration tests, which must keep passing
   without modification.

2. **No new HITL surfaces in cert.** All ambiguity HITL is delegated
   to the matcher (uploader pickcard or admin queue from 58D-A).
   Cert's existing `notify-hitl.activity.ts` (the post-infra-move
   thin adapter) continues to handle **cert-DATA HITL** only —
   low-confidence cert extraction or low-confidence
   `matchCertDefinition`. Subject ambiguity never reaches that path.

3. **Cert policy choices**: `onNoMatch: 'fail'`,
   `onAmbiguous: 'uploader_pickcard'`. Defaults from
   `MatchPersonInputSchema` cover the common case; cert sets them
   explicitly for clarity.

4. **No deletes in 58D-B.** `match-employee.activity.ts` becomes a
   thin shim that calls the matcher; activity name is preserved so
   existing Temporal worker registration is unchanged. (Slice 58E
   may remove the activity entirely as part of the Route-A rewrite —
   not 58D-B's call.)

5. **No prompts changed.** The Langfuse prompt
   `bot.documents.subject_hint_parse` (if it exists from earlier
   drafts) is **not** used here — it was a doc-service-side artifact
   from the superseded SLICE_58D draft. Canonicalization happens
   inside the matcher via `hr.people.canonicalize` (58D-A).

6. **No tunable changes.** Matcher tunables live under `hr.person_match_*`
   (58D-A). Cert-side cert-data HITL thresholds (`0.85`, `0.7` in the
   existing workflow) are unchanged.

---

## Diff: cert workflow change

### Before (current code, slightly simplified)

```typescript
// certification-processing.workflow.ts (today)
const employeeMatch = await matchEmployee({
  tenantId,
  certSubmissionId,
  extractedFeatures,
  uploaderHintText: input.uploaderHintText,
});

if (employeeMatch.candidates.length > 1) {
  // existing in-cert ambiguity HITL — pickcard, signal wait, etc.
}
const subjectEmployeeId = employeeMatch.employeeId;
```

### After (58D-B)

```typescript
import { startChild } from '@temporalio/workflow';
import type { MatchPersonInput, MatchPersonOutput } from '@cip/shared';
import type { MatchPersonWorkflow } from '@cip/shared';

// Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
// workflowId: `MatchPerson-${tenantId}-${certSubmissionId}`
const matchHandle = await startChild<typeof MatchPersonWorkflow>('MatchPersonWorkflow', {
  args: [{
    tenantId,
    candidateText: extractedFeatures.holderName ?? input.uploaderHintText ?? '',
    structuredHints: extractedFeatures.holderName
      ? { fullName: extractedFeatures.holderName }
      : undefined,
    context: {
      source:               'cert_holder',
      callerSubmissionId:   certSubmissionId,
      ...(input.conversationId     !== undefined && { conversationId: input.conversationId }),
      ...(input.uploaderEmployeeId !== undefined && { uploaderEmployeeId: input.uploaderEmployeeId }),
    },
    policy: {
      onNoMatch:    'fail',
      onAmbiguous:  'uploader_pickcard',
    },
  } satisfies MatchPersonInput],
  workflowId: `MatchPerson-${tenantId}-${certSubmissionId}`,
  taskQueue:  'cip-hr-tasks',
});

const personResult: MatchPersonOutput = await matchHandle.result();
if (personResult.outcome === 'no_resolution') {
  // Matcher couldn't resolve and policy was 'fail'. Cert workflow
  // surfaces this as a non-retryable failure; the cert submission
  // row is marked rejected and the existing audit trail records why.
  await rejectCertSubmissionActivity({
    tenantId, certSubmissionId,
    reason: personResult.evidence.reason ?? 'subject_unresolved',
  });
  throw ApplicationFailure.create({ type: 'SubjectUnresolved', nonRetryable: true });
}
const subjectEmployeeId = personResult.employeeId!;
```

### `match-employee.activity.ts` becomes

```typescript
// Slice 58D-B: this activity is now a thin shim that starts the
// shared MatchPersonWorkflow as a child workflow. Kept as an
// activity rather than inlining startChild() everywhere so existing
// callers (cert integration tests, in-flight Temporal histories
// replaying) continue to work without surprise.
//
// Slice 58E may remove this activity entirely once cert is rewritten
// as a Route-A consumer with subject resolution inlined into the
// workflow body. Until then, this file stays.

export async function matchEmployeeActivity(input: MatchEmployeeInput): Promise<MatchEmployeeOutput> {
  // Forward to MatchPersonWorkflow with cert-side policy. The activity
  // returns the same shape as before for backwards compat with callers.
  // Note: starting a child workflow from an activity uses the Temporal
  // Client (cross-process), not workflow.startChild(). This is the same
  // pattern as runExtractionStrategyActivity in doc-service (58C).
  const client = await createTemporalClient();
  const handle = await client.workflow.start('MatchPersonWorkflow', {
    args: [{ /* ... */ }],
    workflowId: `MatchPerson-${input.tenantId}-${input.certSubmissionId}`,
    taskQueue:  'cip-hr-tasks',
  });
  const result = await handle.result() as MatchPersonOutput;
  return adaptMatchPersonResult(result);
}
```

> **Note**: the activity-shim path is only used by callers that aren't
> themselves Temporal workflows (e.g., MCP tools, scripts). The cert
> workflow itself uses `startChild()` directly per the workflow snippet
> above. Inside-workflow `startChild()` is preferred — it gives Temporal
> first-class parent/child semantics (cancellation propagation, etc.)
> that the activity-spawn path lacks.

---

## Acceptance criteria

1. **Existing cert integration tests pass unchanged.** No observable
   behavior change at the cert workflow's external boundary (input
   shape, output shape, audit events).

2. **Manual smoke — single-match cert.** Upload a CPR cert PDF in
   Teams with hint "this is for John Smith" (one active John Smith
   in tenant) → cert created in `cip_hr.certifications` with John
   Smith's `employee_id` exactly as before. Resolution row exists in
   `cip_hr.person_match_resolutions` with
   `caller_submission_id = certSubmissionId`,
   `source = 'auto_unique'`.

3. **Manual smoke — multi-match cert.** Upload with hint "for John"
   when 3 Johns exist → uploader gets pickcard; click resolves; cert
   workflow advances and persists with the picked employee. Total
   workflow duration < 1 minute including click.

4. **Manual smoke — no-match cert.** Upload with hint
   "for someone who doesn't exist" → matcher returns `no_resolution`;
   cert workflow throws `SubjectUnresolved`; cert submission row
   marked rejected. Bot conversation receives an error message.

5. **Self-pick fast path.** Upload with hint "this is my CPR card"
   → AAD pre-check resolves uploader as subject in < 100ms; cert
   created. No Langfuse trace from the matcher's canonicalization
   step (skipped).

6. **`match_person_list` from 58D-A** shows pending resolutions for
   any cert that hits the multi-match path before the user clicks.

7. **Cert-DATA HITL still works.** A cert with low extraction
   confidence (< 0.85) still goes through cert's existing
   `notify-hitl.activity.ts` path and parks on `hitlDecision` —
   verified by deliberately injecting a low-confidence value.

---

## Forward refs

- **58E** rewrites cert as a Route-A consumer accepting
  `ProcessDocumentInput` from doc-service. The matcher integration
  from this slice is preserved verbatim — only inputs/outputs change
  (no `subjectEmployeeId` in input; `signalDocumentServiceCallback`
  in output).
- **58F** (reclassification): if a cert is reclassified post-completion
  to a different module, `MatchPersonWorkflow` may need to be
  re-invoked under the new module's policy. Out of 58D-B scope.
