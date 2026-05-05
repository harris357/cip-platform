# Slice 58B — ingest, AV scan, sensitivity, generic features

> **Why this exists:** 58A laid the foundation (service, schema, ClamAV,
> permissions). 58B turns it on: bot uploads now route through
> `@cip/document-service`, files get scanned, sensitivity-tiered, and
> have generic features extracted — all under a `DocumentProcessingWorkflow`
> that streams progress back to Teams as fresh messages.
>
> After 58B alone the workflow halts at `classifying`
> with no doc_type assigned (58C handles that). Doc is observable
> via a new `documents_status` MCP tool. End-to-end testable: upload
> in Teams → see live progress → see scan/sensitivity/features in
> the doc record. Cert-specific behavior unchanged (bot still
> short-circuits to `process_document` for now via a feature flag —
> removed in 58E).

---

## What lights up after 58B

```
Teams upload (+ optional hint text)
    │
    ▼
bot.handleAuthenticatedMessage()
    │  bundle attachments + text
    │  call @cip/document-service MCP (NEW client config: bot now talks to TWO MCP servers)
    ▼
document_process MCP tool on @cip/document-service
    │  insert documents row (state=quarantined)
    │  upload to OVH at {tenantId}/{documentId}/{filename}
    │  start DocumentProcessingWorkflow
    │  return { documentId } immediately
    ▼
DocumentProcessingWorkflow (Temporal, durable):
    ├─ scanForVirusesActivity            (clamav INSTREAM, fail-closed via Temporal retry)
    ├─ extractGenericFeaturesActivity    (L1 features + OCR)
    ├─ computeEmbeddingActivity          (mistral-embed; insert into document_embeddings)
    ├─ computeLayoutFingerprintActivity  (sharp pHash on rendered page-1)
    ├─ scoreSensitivityActivity          (L1 deterministic + L2 regex + L3 LLM rubric)
    └─ TRANSITION → classifying    (58C picks up here)

Each step publishes to NATS subject  cip.bot.progress.{tenantId}.{conversationId}
The bot subscribes per conversation and edits/replaces a "Processing..." card with the latest step.
```

---

## Files in scope

```
packages/document-service/src/
├── modules/                                                         NEW directory
│   └── ingest/
│       ├── workflows/
│       │   ├── document-processing.workflow.ts                      NEW (DocumentProcessingWorkflow)
│       │   └── index.ts                                             NEW
│       ├── activities/
│       │   ├── index.ts                                             NEW
│       │   ├── scan-for-viruses.activity.ts                         NEW (clamav INSTREAM)
│       │   ├── extract-generic-features.activity.ts                 NEW (L1: pdfjs-dist + sharp + libmagic)
│       │   ├── compute-embedding.activity.ts                        NEW (mistral-embed via LiteLLM)
│       │   ├── compute-layout-fingerprint.activity.ts               NEW (sharp pHash)
│       │   ├── score-sensitivity.activity.ts                        NEW (L1 + L2 + L3, max-tier)
│       │   └── publish-progress.activity.ts                         NEW (writes to NATS bot-progress channel)
│       └── mcp-tools/
│           ├── document-process.tool.ts                             NEW (the one entry point)
│           ├── documents-status.tool.ts                             NEW (poll fallback)
│           └── index.ts                                             NEW
├── workers/temporal-worker.ts                                       MOD (register ingest activities + workflow)
└── server.ts                                                        MOD (register MCP tools)

packages/document-service/src/                                       (sensitivity helpers)
├── sensitivity/
│   ├── l1-deterministic.ts                                          NEW (MIME, filename keywords, size, hint)
│   ├── l2-regex.ts                                                  NEW (SSN, credit-card Luhn, DOB, MRN, etc.)
│   ├── l3-llm-rubric.ts                                             NEW (Langfuse-hosted prompt)
│   ├── tier-compose.ts                                              NEW (max-tier reduction)
│   └── tunables.ts                                                  NEW (load thresholds from bot_tunables)

packages/teams-bot/src/                                              MOD
├── mcp/
│   ├── multi-server-client.ts                                       NEW (registry: {hr-service, document-service})
│   ├── tool-discovery.ts                                            MOD (discover from all servers; merge catalogs)
│   └── execute-tool.ts                                              MOD (route by tool name → server)
├── teams-protocol/
│   ├── file-handler.ts                                              MOD (return Buffer + mimeType; doc-service will upload)
│   └── progress-renderer.ts                                         NEW (subscribes NATS, edits/replaces progress card)
├── bot.ts                                                           MOD (file fast-path: call doc-service.document_process(buffer, hint))
└── auth/resolve-context.ts                                          MOD (no change to shape; verify still works against doc-service)

packages/shared/src/
├── nats/
│   └── progress-subjects.ts                                         NEW (subject builder for cip.bot.progress.*)
├── types/
│   └── bot-progress-event.ts                                        NEW (ProgressEvent zod schema)
└── index.ts                                                         MOD (export new helpers)

packages/document-service/helm/templates/secret.yaml                 MOD (add NATS_URL, LITELLM_URL, LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY)
packages/document-service/helm/values.yaml                           MOD (env wiring)

packages/hr-service/src/db/migrations/                               MOD
└── 037_documents_tunables.sql                                       NEW (seeds documents.* tunables in bot_tunables)

# Langfuse-hosted prompts (deployed manually via Langfuse UI before testing):
#   bot.documents.sensitivity_rubric  v1   (L3 sensitivity scoring rubric)
```

---

## Critical structural constraint — workflow is a phase loop, not a linear sequence

The `DocumentProcessingWorkflow` MUST be implemented as a phase loop
(see [SLICE_58F_RECLASSIFICATION.md](./SLICE_58F_RECLASSIFICATION.md)
for the full pattern). 58F's reclassification flow depends on it,
and the same loop shape is what soft-purge cancellation +
restore-and-resume in 58G build on. A linear `await scan(); await
features(); ...` workflow will require a refactor in 58F.

Concretely:

```typescript
// Phase is a workflow-internal concept — finer-grained than documents.lifecycle_state.
// The DB state advances on phase BOUNDARIES (e.g. 'scan' phase keeps the DB state
// at 'scanning'; 'classify' phase advances it to 'classifying'; 'awaiting_module_callback'
// phase keeps the DB state at 'routed' until module callback arrives).
type Phase = 'scan' | 'features' | 'sensitivity' | 'classify' | 'extract'
           | 'subject' | 'route' | 'awaiting_module_callback' | 'archived' | 'failed';

let phase: Phase = input.startingPhase ?? 'scan';      // startingPhase enables 58G restore
const reclassifyPayload = …;                            // signal handler (58F)

while (phase !== 'archived' && phase !== 'failed') {
  if (reclassifyPayload) { phase = 'classify'; reclassifyPayload = undefined; continue; }
  switch (phase) { /* dispatch each phase, transition phase = next on success */ }
}
```

Build the loop scaffold in 58B even though the only signals it
processes (and the only phase that matters until 58F lands) are
the linear next-phase transitions. The pattern is structurally
identical to a linear sequence in the happy-path; the cost is ~30
lines of dispatch code, no behavior change. Get it right now.

## Hard rules

1. **Bot's MCP client now connects to TWO servers.** `tool-discovery`
   and `execute-tool` fan out across both `hr-service` and
   `document-service`. Tool names are global within the bot's view —
   if a name collides, fail loudly at startup; do not silently prefer
   one server.
2. **`document_process` is the ONLY MCP tool an agent calls during
   upload.** All other ingest activities run inside the workflow.
   The bot's file fast-path calls this tool directly without going
   through the planner (same shape as the legacy cert fast-path).
3. **Bytes do not move servers more than once.** The bot streams the
   Teams CDN download body straight into doc-service's
   `document_process` tool which uploads to OVH. The bot does NOT
   upload to OVH (that was the legacy file-handler.ts path —
   replaced).
4. **Sensitivity scoring is L1+L2+L3, final tier = max(L1, L2, L3).**
   If L3 is disabled (tunable) the tier is `max(L1, L2)`. NULL
   sensitivity is invalid post-`scoring`; the workflow asserts.
5. **Progress publishing is best-effort.** A NATS publish failure
   does NOT fail the activity. Activities continue regardless of
   whether progress reaches the bot. The status MCP tool is the
   reliable read path.
6. **No `tenantId` in any MCP tool input.** Always from
   `authInfo.token`. (Non-Negotiable #6.)
7. **Cert behavior preserved during 58B.** Tunable
   `documents.cert_legacy_path = true` keeps the bot's old
   `process_document` (cert) call alive in parallel with
   `document_process`. 58E flips it false and removes legacy.
8. **All `extractGenericFeaturesActivity` output is Zod-parsed
   before return.** (Non-Negotiable #5.)
9. **Workflow ID**: `DocumentProcess-${tenantId}-${documentId}` with
   convention comment. (Non-Negotiable #4.)

---

## Workflow shape

```typescript
// document-processing.workflow.ts
const {
  scanForVirusesActivity,
  extractGenericFeaturesActivity,
  computeEmbeddingActivity,
  computeLayoutFingerprintActivity,
  scoreSensitivityActivity,
  publishProgressActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '60 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['ThreatDetected', 'CorruptDocument'],
  },
});

const longRunningActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',  // L3 LLM rubric occasionally slow
  retry: { maximumAttempts: 3 },
});

export interface DocumentProcessingInput {
  tenantId: string;
  documentId: string;
  conversationId?: string;          // present iff source=teams; bot uses it to subscribe to progress
  uploaderEmployeeId: string;
  uploaderHintText?: string;
}

export async function DocumentProcessingWorkflow(input: DocumentProcessingInput): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `DocumentProcess-${input.tenantId}-${input.documentId}`
  const { tenantId, documentId, conversationId } = input;
  const progress = (step: string, status: 'started'|'completed'|'failed', extra?: Record<string,unknown>) =>
    conversationId ? publishProgressActivity({ tenantId, conversationId, documentId, step, status, ...extra }) : Promise.resolve();

  await progress('scan', 'started');
  const scan = await scanForVirusesActivity({ tenantId, documentId });
  await progress('scan', scan.clean ? 'completed' : 'failed', { threat: scan.threat });
  if (!scan.clean) {
    // scanForVirusesActivity already transitioned doc to scan_failed and recorded audit event
    return;
  }

  await progress('generic_features', 'started');
  const generic = await extractGenericFeaturesActivity({ tenantId, documentId });
  await progress('generic_features', 'completed', { pageCount: generic.pageCount });

  await progress('embedding', 'started');
  await computeEmbeddingActivity({ tenantId, documentId, ocrText: generic.ocrText });
  await progress('embedding', 'completed');

  await progress('fingerprint', 'started');
  await computeLayoutFingerprintActivity({ tenantId, documentId });
  await progress('fingerprint', 'completed');

  await progress('sensitivity', 'started');
  const sens = await longRunningActivities.scoreSensitivityActivity({
    tenantId, documentId,
    ocrText: generic.ocrText,
    fileName: generic.fileName,
    mimeType: generic.mimeType,
    uploaderHintText: input.uploaderHintText,
  });
  await progress('sensitivity', 'completed', { tier: sens.tier });

  // Transition documents.lifecycle_state → 'classifying'.
  // 58C will pick it up via a separate workflow OR a continuation; design choice deferred to 58C.
}
```

---

## Activity contracts

### `scanForVirusesActivity`

```
Input:  { tenantId, documentId }
Output: { clean: boolean, threat?: string, signatureDbAgeSeconds: number }

1. Read documents row → pull s3_bucket, s3_key, sha256 (set on insert by document_process).
2. Stream the S3 object body via INSTREAM to clamd ({CLAMAV_HOST}:3310).
3. clamd returns OK | FOUND <SignatureName> | ERROR.
4. Update documents.lifecycle_state:
     OK    → 'scan_complete'   (intermediate; workflow advances)
     FOUND → 'scan_failed'     (terminal; throw ApplicationFailure('ThreatDetected'))
     ERROR → throw retryable Error (Temporal retries)
5. Insert audit_event(event_type='scanned', payload={result, threat, sha256, signatureDbAgeSeconds}).
6. Capture clamd signature DB age via PING-then-VERSION; persist on documents.av_signature_db_age_seconds.
```

NPM lib: pinned `clamscan@2.4.0` (marked Inactive but functional;
budget for fork). Wrapped behind `src/av/clamav-client.ts` so a
swap is one-file.

### `extractGenericFeaturesActivity` (L1 features + OCR)

```
Input:  { tenantId, documentId }
Output: GenericFeatures (Zod-parsed)
  {
    pageCount, hasTable, hasSignature, hasHandwriting,
    layoutType: 'form'|'prose'|'mixed'|'image_only',
    dominantColors: string[],
    languageHint: string,                 // ISO 639-1; from OCR
    ocrTextLength: number,
    ocrText: string,                      // returned to workflow only; persisted on documents row
    fileName: string,
    mimeType: string,
    imageDimensions?: { w, h },
  }

Implementation:
- pdfjs-dist for PDF page count + text extraction
- sharp for image MIME types (dimensions, dominant colors)
- libmagic via file-type for MIME confirmation
- Tesseract NOT in this slice — use the existing vision-agent for OCR by calling
  a thin shim. Or: use pdfjs-dist text layer for PDFs and skip OCR for image-only
  docs in 58B (mark hasHandwriting=unknown, deferred to 58C extraction strategy).

Decision: 58B uses pdfjs-dist text extraction; image-only OCR happens in 58C
extraction strategy (cert vision-agent pipeline already does this).
```

### `computeEmbeddingActivity`

```
Input:  { tenantId, documentId, ocrText }
Output: { documentId, dim: 1024 }

1. Truncate ocrText to ~30K chars (mistral-embed input cap).
2. Call LiteLLM /embeddings with model=mistral-embed.
3. INSERT INTO document_embeddings (document_id, tenant_id, embedding, embedding_model, computed_at).
4. Audit: embedding_computed.
```

### `computeLayoutFingerprintActivity`

```
Input:  { tenantId, documentId }
Output: { fingerprint: string }

1. Render page 1 to PNG via pdfjs-dist; for image MIMEs use the original.
2. Compute pHash via sharp + a small in-process fn (or a npm pHash lib pinned).
3. UPDATE documents SET layout_fingerprint = $hash.
4. Audit: state_transition (no specific event_type; layout fp is an attribute).
```

### `scoreSensitivityActivity`

```
Input:  { tenantId, documentId, ocrText, fileName, mimeType, uploaderHintText? }
Output: { tier: SensitivityTier, evidence: { l1, l2, l3 } }

1. L1 — l1-deterministic.ts:
   - filename keyword scan (loaded from tunable documents.l1_keywords)
   - MIME blocklist? (no; we accept whatever the bot passes through)
   - hint text scan ("for me" / "private" → +internal)
   - size heuristic
   → returns { tier, hits: [...] }

2. L2 — l2-regex.ts:
   - SSN, ITIN, EIN
   - credit card (Luhn-validated)
   - DOB (multiple formats)
   - phone, email
   - MRN patterns
   - Driver's license / passport patterns
   - banking routing/account
   → returns { tier, matches: [{type, count}] }

3. L3 — l3-llm-rubric.ts (skipped if tunable documents.l3_enabled=false):
   - call LiteLLM with prompt name 'bot.documents.sensitivity_rubric' (Langfuse-hosted)
   - prompt receives: ocrText (truncated), fileName, mimeType, hintText, l1+l2 evidence
   - returns: { tier, reasoning }

4. tier = max(L1.tier, L2.tier, L3.tier, tenant_floor)
   tenant_floor from documents.tier_override_floor (default 'public')

5. UPDATE documents SET sensitivity_tier=$tier, sensitivity_evidence=$evidence.
6. Audit: sensitivity_assigned, payload includes the full evidence blob.
```

---

## Bot progress channel (new sub-component)

### NATS subject pattern

`cip.bot.progress.${tenantId}.${conversationId}` — wildcard subscribe by
tenant (`cip.bot.progress.${tenantId}.>`) on the bot side.

Subject builder in `@cip/shared/src/nats/progress-subjects.ts`:

```typescript
export function progressSubject(tenantId: string, conversationId: string): string {
  // tenantId + conversationId are UUIDs / Teams IDs — already safe for NATS subjects
  return `cip.bot.progress.${tenantId}.${conversationId}`;
}
```

### Event shape

```typescript
// @cip/shared/src/types/bot-progress-event.ts
export const BotProgressEventSchema = z.object({
  documentId: z.string().uuid(),
  conversationId: z.string(),
  step: z.enum(['scan','generic_features','embedding','fingerprint','sensitivity','classify','subject','route']),
  status: z.enum(['started','completed','failed','skipped']),
  message: z.string().optional(),                 // human-readable; bot may display
  detail: z.record(z.unknown()).optional(),       // step-specific (threat name, page count, tier, ...)
  occurredAt: z.string().datetime(),
});
export type BotProgressEvent = z.infer<typeof BotProgressEventSchema>;
```

### Bot subscriber (`progress-renderer.ts`)

On the first attachment fast-path call, the bot:
1. Sends the initial "Processing your upload — `📄 doc.pdf` `#abc123`" card.
2. Captures the conversation reference (`activity.conversation`, `activity.serviceUrl`, `activity.recipient`) for proactive sends.
3. Subscribes to `progressSubject(tenantId, conversationId)` for ~5 minutes (tunable).
4. On each event, sends a fresh follow-up message into the conversation:
   - `🔍 Scanning… ✓ clean`
   - `🔬 Sensitivity tiered: confidential`
   - `📐 4 features extracted`
5. On terminal status (success | failed) OR after 5 min timeout, unsubscribes.
6. Multiple uploads in same conversation: keyed by `documentId` so events render in order.

Why fresh messages instead of in-place card edits: edit-in-place
requires Activity ID tracking and `updateActivity` calls — slice 52
laid groundwork but it's typing-indicator only. Fresh messages are
simpler, cheaper, and survive bot pod restarts. Future polish slice
can collapse to a single edited card.

### Activity publisher (`publish-progress.activity.ts`)

```typescript
export async function publishProgressActivity(input: BotProgressEvent): Promise<void> {
  // best-effort; no throw on failure
  try {
    const nc = await getNATSConnection();   // pooled
    nc.publish(progressSubject(input.tenantId, input.conversationId), JSON.stringify(input));
  } catch (err) {
    // log + swallow; activity returns success
    console.error('[progress] publish failed', err);
  }
}
```

---

## MCP tool: `document_process`

Replaces the cert-only legacy `process_document` (legacy tool stays
alive in 58B gated by `documents.cert_legacy_path`; removed in 58E).

```typescript
server.registerTool(
  'document_process',
  {
    title: 'Process an uploaded document',
    description:
      'Submit an uploaded file for processing. Scope: stores the file in object ' +
      'storage, creates a documents row, kicks off DocumentProcessingWorkflow ' +
      '(scan → features → sensitivity → classify → subject → route). ' +
      'Audience: every employee with `documents.upload`. ' +
      'Output: { documentId } for status tracking via documents_status. ' +
      'Required args: fileBuffer (base64), fileName, mimeType, optional hintText. ' +
      'Use when: the bot has captured a Teams attachment and accompanying user text. ' +
      'The bot calls this directly on file uploads; rarely invoked by an LLM planner.',
    inputSchema: z.object({
      fileBase64: z.string().describe('Base64-encoded file bytes from Teams CDN'),
      fileName: z.string(),
      mimeType: z.string(),
      hintText: z.string().optional().describe("User's accompanying message, e.g. 'this is for me'"),
      sourceMessageId: z.string().optional(),
      conversationId: z.string().optional().describe('Teams conversation id; required for streamed progress'),
    }),
    annotations: {
      requiredPermission: 'documents.upload',
      sideEffectLevel: 'write',
      whenToUse: ['User uploaded a file in Teams; bot needs to start processing'],
      whenNotToUse: [
        'No file was uploaded — there is nothing to process',
        'User wants status of a prior upload — use documents_status',
      ],
      commonNextTools: ['documents_status'],
    },
  },
  async (args, ctx) => {
    const { tenantId, employeeId } = extractAuthContext(ctx.authInfo);
    const documentId = randomUUID();

    // 1. Decode + sha256 + magic-byte check
    const buffer = Buffer.from(args.fileBase64, 'base64');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const detected = await fileTypeFromBuffer(buffer);
    if (detected && detected.mime !== args.mimeType) {
      // claimed != detected MIME — mark as such; sensitivity may still pass
    }

    // 2. Upload to OVH
    const s3Key = `${tenantId}/${documentId}/${args.fileName}`;
    await s3PutObject({ bucket: BUCKET, key: s3Key, body: buffer, contentType: args.mimeType });

    // 3. Insert documents row (state=quarantined)
    await withActorContext(db, actorContextFor(tenantId, employeeId, /*role=*/'uploader'), async (tx) => {
      await tx.insert(documents).values({
        id: documentId, tenantId,
        uploaderEmployeeId: employeeId,
        source: 'teams',
        sourceMessageId: args.sourceMessageId,
        uploaderHintText: args.hintText,
        s3Bucket: BUCKET, s3Key, fileName: args.fileName, mimeType: args.mimeType,
        sizeBytes: buffer.length, sha256,
        lifecycleState: 'quarantined',
      });
      await tx.insert(auditEvents).values({
        tenantId, documentId, actorEmployeeId: employeeId, actorRole: 'uploader',
        eventType: 'uploaded',
        payload: { fileName: args.fileName, mimeType: args.mimeType, sizeBytes: buffer.length, sha256 },
      });
    });

    // 4. Start workflow
    const temporal = await createTemporalClient();
    // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
    const workflowId = `DocumentProcess-${tenantId}-${documentId}`;
    await temporal.workflow.start(DocumentProcessingWorkflow, {
      workflowId,
      taskQueue: process.env['TEMPORAL_TASK_QUEUE_DOCUMENTS'] ?? 'cip-documents-tasks',
      args: [{ tenantId, documentId, conversationId: args.conversationId, uploaderEmployeeId: employeeId, uploaderHintText: args.hintText }],
    });

    return {
      content: [{ type: 'text', text: JSON.stringify({ data: { documentId, workflowId } }) }],
    };
  },
);
```

---

## MCP tool: `documents_status`

Poll fallback when progress channel didn't deliver. Returns
lifecycle state + key fields. Permission `documents.own.read` for
self; admins also covered by `documents.admin.read`.

---

## Tunables seeded in `037_documents_tunables.sql`

```sql
INSERT INTO bot_tunables (key, value, description, scope) VALUES
  ('documents.cert_legacy_path',       'true',  'Keep legacy cert process_document tool alive during 58B', 'global'),
  ('documents.l3_enabled',             'true',  'Run L3 LLM sensitivity rubric (false = L1+L2 only)',      'global'),
  ('documents.tier_override_floor',    'public','Minimum tier any doc in this tenant may receive',         'tenant'),
  ('documents.l1_keywords',            '["salary","ssn","w2","w4","1099","paystub","medical","nda","payroll","confidential","contract","hr-private"]', 'CSV/JSON of filename keyword triggers', 'tenant'),
  ('documents.av_max_file_size_mb',    '25',    'Reject upload if larger than this',                        'tenant'),
  ('documents.progress_subscription_ttl_seconds', '300', 'How long bot subscribes to progress events per upload', 'global')
ON CONFLICT (key, scope) DO NOTHING;
```

---

## Acceptance criteria

1. `pnpm -r run typecheck` passes.
2. `pnpm --filter @cip/document-service test` passes (workflow happy-path mock test, sensitivity unit tests).
3. `pnpm --filter @cip/teams-bot test` passes (multi-MCP-server test, progress-renderer subscribe/render unit test).
4. **End-to-end Teams test path**:
   - Upload a clean PDF in Teams → see "Processing..." card → see scan/features/sensitivity progress messages → see final card "Awaiting classification (58C will pick this up)" with the documentId.
   - Upload an EICAR test file → see scan failure progress message → final "Scan failed: EICAR-STANDARD-ANTIVIRUS-TEST-FILE" message → doc row in `scan_failed`.
   - Upload a benign image → progress completes through sensitivity → doc in `classifying`.
5. `documents_status documentId=<id>` returns the row's current state.
6. Cert legacy path still works for backward compat (tunable set true). Verified by uploading via the old code path; cert workflow runs as before.
7. `cip.bot.progress.${tenantId}.>` NATS subject visible via `nats sub` in cip-infra.
8. Langfuse trace tree shows DocumentProcessingWorkflow with each activity as a span.
9. No reads of `cip_hr` schema from doc-service code (verified by grep).

---

## Library versions (delta from 58A foundation)

Adds these to the doc-service package.json:

| Lib | Version | Why |
|---|---|---|
| `clamscan` | `2.4.0` | INSTREAM client for clamav |
| `pdfjs-dist` | `5.7.284` | PDF text + page render for fingerprint |
| `sharp` | `0.34.5` | Image metadata + pHash + render |
| `file-type` | `22.0.1` | Magic-byte MIME confirmation (ESM-only) |
| `pgvector` | `0.2.1` | Vector type marshaling for embedding insert |
| `nats` | `2.x` (latest stable) | Bot-progress publish |
| `@langfuse/langchain` (modular v5) | latest | L3 sensitivity rubric tracing |

Bot-side (already on these via prior slices):
- `@modelcontextprotocol/sdk` 1.29.x — multi-server-client uses the new `Client` API; verify no breakage in tool-discovery.
- `nats` — new for the bot too if not already on it.

---

## Forward refs

- 58C picks up at `classifying` and adds the LLM classifier + cert extraction strategy.
- 58D adds subject resolution + HITL queue.
- 58E removes the cert legacy path (flips tunable false, deletes the legacy `process_document` tool).
- 58F adds reclassification — uses the workflow's signal pattern.
- 58G adds purge.
