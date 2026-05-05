# Slice 58D — subject resolution + HITL admin queue (SUPERSEDED 2026-05-05)

> **⚠️ This slice has been superseded.** The original design put
> subject resolution in **doc-service**, which forced a cross-DB
> lookup against `cip_hr.employees` and embedded employee-matching
> logic in a generic document pipeline.
>
> Replaced by:
>
> - [SLICE_58D-A_MATCH_PERSON_WORKFLOW.md](./SLICE_58D-A_MATCH_PERSON_WORKFLOW.md) —
>   reusable `MatchPersonWorkflow` on hr-service (workflow + table +
>   tunables + bot pickcard + admin polling tools + permission)
> - [SLICE_58D-B_CERT_SUBJECT_RESOLUTION.md](./SLICE_58D-B_CERT_SUBJECT_RESOLUTION.md) —
>   cert workflow becomes the matcher's first consumer (small refactor)
>
> 58E (routing + cert Route-A + adjuncts) integrates with the
> matcher via the cert workflow, not via doc-service.
>
> **Why the change:**
> 1. By the time we know to resolve a person, classify has already
>    decided `module='certificate'` — we know it's HR. Resolution
>    naturally belongs in the HR module workflow, not before.
> 2. Person matching is needed by future modules (incident,
>    training, reminders) — it earns its own reusable workflow.
> 3. The DB-split between doc-service (`DATABASE_URL_DOCS`) and
>    hr-service (`DATABASE_URL_HR`) means doc-service can't query
>    `cip_hr.employees` natively. Moving resolution to hr-service
>    sidesteps the cross-DB problem entirely.
>
> The text below is preserved for reference / commit history. **Do
> not implement from this doc.**

---



> **Why this exists:** 58C leaves docs at `awaiting_subject` —
> classified, extracted, but with no answer to "who is this
> document ABOUT?" 58D resolves that by combining the user's
> hint text, named-entity matches in extracted features, and (when
> they conflict or fail) a HITL pick-list back to the uploader. If
> nothing resolves, doc lands in admin HITL queue with tools for
> admins to set the subject manually.
>
> After 58D: doc has `subject_employee_id` populated and reaches
> `awaiting_routing`. No orphans (per locked decision). Or the
> workflow is paused on `hitl_admin_queue` waiting for human input.

---

## Files in scope

```
packages/document-service/src/modules/ingest/                        (continues)
├── workflows/document-processing.workflow.ts                        MOD (add subject phase + HITL signal)
├── activities/
│   ├── parse-uploader-hint.activity.ts                              NEW (extract subject candidates from hint)
│   ├── extract-subjects-from-content.activity.ts                    NEW (NER over OCR + extracted_features)
│   ├── resolve-subject.activity.ts                                  NEW (combine hint + content; pick or list)
│   ├── notify-subject-hitl.activity.ts                              NEW (push pickcard to uploader OR admin queue card)
│   └── index.ts                                                     MOD

packages/document-service/src/modules/hitl/                          NEW directory
├── mcp-tools/
│   ├── documents-hitl-list.tool.ts                                  NEW (list HITL queue docs)
│   ├── documents-hitl-resolve-subject.tool.ts                       NEW (admin sets subject)
│   ├── documents-hitl-route-to-module.tool.ts                       NEW (admin manually routes; placeholder for 58E flow)
│   ├── documents-hitl-reject.tool.ts                                NEW (admin rejects → state=failed)
│   └── index.ts                                                     NEW
└── cards/
    ├── subject-picklist.card.ts                                     NEW (uploader-facing card)
    └── admin-queue-item.card.ts                                     NEW (admin tool list item rendering)

packages/document-service/src/workflows/index.ts                     MOD (export subject signal types)

packages/teams-bot/src/intent/                                       MOD (existing dir)
└── document-subject-pickcard-handler.ts                             NEW (handles uploader's pick-list click)

packages/hr-service/src/db/queries/employees.ts                      MOD (add fuzzyEmployeeNameMatch helper if not present)
```

---

## Hard rules

1. **No orphans.** A doc never reaches `awaiting_routing` without a
   `subject_employee_id`. If neither hint nor content yields a
   match, HITL is the only path forward.
2. **Content wins on conflict.** If `parse-uploader-hint` returns
   "John Smith" and `extract-subjects-from-content` finds "Jane Doe"
   on the cert, prefer Jane. If both return matches and they
   conflict, fire HITL pick-list to the uploader (NOT admin queue).
3. **Single match high-confidence = auto-resolve.** Threshold tunable
   `documents.subject_resolution_auto_threshold = 0.9`.
4. **Multiple matches OR ambiguity → uploader pick-list first.**
   Admin queue is fallback if uploader doesn't respond within
   `documents.subject_pickcard_ttl_hours = 24`.
5. **No name matching by raw substring.** Use the existing fuzzy
   match helper (or add one in `hr-service/src/db/queries/employees.ts`).
6. **All hitl tools require `documents.admin.read` or
   `documents.admin.route` (route tool gates harder).**
7. **Pick-list responses come back via the bot's adaptive-card
   invoke-router** (slice 53 pattern). New verb:
   `documents.subject.pick`. Card payload includes documentId +
   chosen employeeId.

---

## Workflow additions

```typescript
// document-processing.workflow.ts, after 58C's extract step:

const subjectSignal = defineSignal<[SubjectResolutionSignal]>('subjectResolution');
let signaled: SubjectResolutionSignal | undefined;
setHandler(subjectSignal, (s) => { signaled = s; });

await progress('subject', 'started');
const { hintMatches, contentMatches, conflict } = await resolveSubjectActivity({
  tenantId, documentId,
  uploaderHintText: input.uploaderHintText,
  extractedFeatures: extracted.fields,
  ocrText: generic.ocrText,
});

let subjectId: string | undefined;
if (!conflict && hintMatches.length === 1 && hintMatches[0].confidence >= AUTO_THRESHOLD) {
  subjectId = hintMatches[0].employeeId;
} else if (!conflict && contentMatches.length === 1 && contentMatches[0].confidence >= AUTO_THRESHOLD) {
  subjectId = contentMatches[0].employeeId;
}

if (!subjectId) {
  // ambiguous or conflict — push pickcard to uploader
  await notifySubjectHitlActivity({
    tenantId, documentId, uploaderEmployeeId: input.uploaderEmployeeId,
    candidates: dedupCandidates([...hintMatches, ...contentMatches]),
    reason: conflict ? 'hint_content_conflict' : 'multi_match',
    conversationId: input.conversationId,
  });
  await transitionStateActivity({ tenantId, documentId, to: 'hitl_admin_queue', preHitlState: 'awaiting_subject' });

  // Wait up to subject_pickcard_ttl_hours for a signal
  const resolved = await condition(() => signaled !== undefined, '24 hours');
  if (resolved && signaled.action === 'set_subject') {
    subjectId = signaled.employeeId;
  } else {
    // TTL expired — admin queue takes over; continue blocking on signal indefinitely
    await condition(() => signaled !== undefined);
    if (signaled!.action === 'set_subject') subjectId = signaled!.employeeId;
    else if (signaled!.action === 'reject') {
      await transitionStateActivity({ tenantId, documentId, to: 'failed', reason: 'admin_rejected' });
      return;
    }
  }
}

await progress('subject', 'completed', { subjectEmployeeId: subjectId });
await persistSubjectActivity({ tenantId, documentId, subjectEmployeeId: subjectId });

// Transition → 'awaiting_routing' for 58E.
```

---

## Activity contracts (compact)

### `parseUploaderHintActivity`

Input `{ tenantId, hintText }` → Output `Array<{ employeeId, confidence, evidence }>`

- Run a small LLM extraction (Langfuse prompt
  `bot.documents.subject_hint_parse v1`) returning intended
  subjects: `{ name?, email?, employeeIdRef?, selfReferential? }`.
- For each candidate, fuzzy-match against
  `cip_hr.employees WHERE tenant_id=$1`.
- Self-referential phrases ("for me", "my own") → uploader is the
  single high-confidence candidate (1.0).

### `extractSubjectsFromContentActivity`

Input `{ tenantId, ocrText, extractedFeatures }` → Output candidates list

- NER pass: prefer fields already in `extracted_features`
  (e.g. cert holder name) over raw OCR scanning.
- Fuzzy-match against employees.
- Confidence weighted by field origin (extracted_features.holder_name
  beats raw OCR mention).

### `resolveSubjectActivity`

Combines the two above. Detects conflict when:
- both lists have ≥1 high-conf match AND
- top hint match's employeeId ≠ top content match's employeeId

Returns `{ hintMatches, contentMatches, conflict: boolean }`.

### `notifySubjectHitlActivity`

- Sends an adaptive card to the uploader's Teams conversation:
  "Who is this document for?" with up to 5 candidates as
  `Action.Submit` buttons (verb=`documents.subject.pick`,
  data=`{documentId, employeeId}`) plus a "Send to admin" button
  (verb=`documents.subject.escalate`).
- Inserts admin-queue audit entry so admins can also act on it via
  HITL tools immediately.

### Bot handler (`document-subject-pickcard-handler.ts`)

On `documents.subject.pick` invoke:
1. Validate the actor matches the doc's `uploader_employee_id`
   (via documents-status read).
2. Send a signal to the workflow:
   `temporal.workflow.signal('DocumentProcess-...', 'subjectResolution', { action: 'set_subject', employeeId })`.

---

## HITL admin tools

### `documents_hitl_list`

```
Permission: documents.admin.read
Args:       { state?: 'all'|'awaiting_subject'|'awaiting_routing'|'classifying', limit?: number }
Returns:    Array<{ documentId, lifecycleState, preHitlState, fileName, uploader, sensitivityTier,
                    classification?: {module, docType, confidence}, candidateSubjects?: [...] }>
```

Renders a list of cards via the existing card-renderer pattern.

### `documents_hitl_resolve_subject`

```
Permission: documents.admin.route
Args:       { documentId, employeeId }
Effect:     temporal.signal('DocumentProcess-{tenantId}-{documentId}', 'subjectResolution', { action: 'set_subject', employeeId })
Audit:      subject_resolved (actor=admin)
```

### `documents_hitl_route_to_module`

```
Permission: documents.admin.route
Args:       { documentId, module, docType }
Effect:     For docs stuck at awaiting_routing OR with no routing rule:
            - Update documents.module / doc_type
            - signal('routingResolution', { action: 'route', module, docType })
            (58E adds the workflow handler for this signal.)
```

### `documents_hitl_reject`

```
Permission: documents.admin.route
Args:       { documentId, reason }
Effect:     signal('subjectResolution', { action: 'reject' })  OR  ('routingResolution', { action: 'reject' })
            depending on which state the doc is in.
            Workflow transitions to 'failed'.
```

---

## Acceptance criteria

1. Upload a CPR cert PDF in Teams + hint "this is my CPR card" → uploader is auto-resolved as subject (self-referential, confidence 1.0). Doc reaches `awaiting_routing`.
2. Upload a CPR cert PDF + hint "this is for John Smith" where exactly one John Smith exists → John resolved automatically.
3. Upload a CPR cert PDF + hint "for John" where 3 Johns exist → uploader receives a pick-list adaptive card. Click → workflow advances. Verify subject set in DB.
4. Upload a cert where the printed holder name conflicts with the hint → pick-list shown including BOTH matches, with a small "📋 hint vs content conflict" tag.
5. Admin lists `documents_hitl_list` → sees the doc; calls `documents_hitl_resolve_subject` → workflow advances.
6. Pick-list card not clicked for 24h → audit shows admin queue takeover; admin tool can still resolve.
7. Langfuse trace shows the subject_hint_parse prompt + the auto-resolution decision evidence.

---

## Forward refs

- 58E adds the routing step that 58D pushes docs into.
- 58F's reclassify flow uses the same `subjectResolution` signal pattern to re-trigger when reclassifying changes the appropriate subject.
