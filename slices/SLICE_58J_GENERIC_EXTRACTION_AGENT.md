# Slice 58J — generic field-extraction agent (vision + text)

> **Why this exists:** Today the cert module owns a LangGraph
> "vision-agent" that does field extraction from a document
> (extract → assess confidence → format-or-flag). The pattern is
> generic — every future module that extracts structured fields
> from documents (training records, contracts, invoices, expense
> receipts, performance reviews, ID cards) wants exactly this
> shape. Cert-specific state (`certType`, `submissionId`) is the
> only coupling.
>
> 58J generalises the agent into a system-wide tool: any module
> registers its `(prompt, output schema, confidence threshold,
> HITL routing)` and gets the agent + LangGraph orchestration for
> free. Cert becomes the first consumer, no behavior change.

---

## Why now (placement in the 58 family)

Best read after **58C-FIX has shipped** — that change moves OCR
text extraction upstream into doc-service, so the agent's
remaining job is purely the LLM call + confidence loop, not the
binary handling. Without 58C-FIX, the agent still mixes
"how do I get bytes/text from a doc" with "how do I extract
fields from text/image". Don't generalise that mess.

Sequence:
- 58C ✓ (classify + per-type strategy framework)
- 58C-FIX (in flight) — MIME-aware text extraction in doc-service
- 58D (subject resolution + HITL admin queue)
- 58E (routing handoff + cert workflow as Route-A consumer)
- **58J (this slice)** — fits anywhere after 58C-FIX; before adding
  a second module's extraction strategy
- 58F / 58G / 58H / 58I — unchanged

The cert workflow rewrite in 58E doesn't depend on 58J; cert
keeps its module-owned vision-agent until 58J generalises it.
58J then thins the cert agent to a 30-line adapter.

---

## What the generic agent looks like

A single LangGraph subgraph + activity wrapper, parametrised over:
- **Input shape** — image bytes (vision path) OR ocrText (text
  path) OR both (vision-augmented text)
- **Prompt** — Langfuse-hosted prompt name (e.g.
  `bot.documents.extract_certificate`,
  `bot.documents.extract_invoice`, ...)
- **Output schema** — Zod schema describing the fields expected
  for THIS doc_type
- **Confidence threshold** — module/doc_type-specific tunable
- **HITL behaviour** — `'flag' | 'block' | 'never'` (cert flags
  for HITL today; an invoice extractor might block on low conf)

The agent itself doesn't know what a cert is. It runs an LLM with
the supplied prompt, parses output against the schema, scores
confidence, and routes to "done" or "needs HITL."

---

## Files in scope

```
packages/shared/src/extraction/agents/                                NEW dir (subpath; not re-exported from index — workflow bundles must NOT pull this code)
├── extraction-agent-state.ts                                         NEW — generic LangGraph annotation parametrised over <TFields>
├── extraction-agent-nodes.ts                                         NEW — extractFields, assessConfidence, formatOutput, flagForHitl
├── extraction-agent-graph.ts                                         NEW — graph builder: buildExtractionAgent(config) → CompiledGraph
├── prompt-templating.ts                                              NEW — fill-in-the-blanks helper (image_url + structured-output JSON contract)
├── confidence-scorer.ts                                              NEW — extracted from existing nodes.ts; reads schema-aware completeness + LLM self-reported confidence
└── index.ts                                                          NEW — exports buildExtractionAgent + types

packages/document-service/src/extraction/strategies/                   (continues from 58C-FIX scope)
└── certificate-strategy.ts                                            (cert strategy stays in hr-service; this doc just notes the contract is unchanged)

packages/hr-service/src/modules/certifications/agents/vision-agent/   MOD — thinned to ~30 LOC adapter
├── index.ts                                                          MOD — instantiates buildExtractionAgent({ prompt, schema, threshold, hitlMode })
├── nodes.ts                                                          DELETED — logic moved to shared
├── state.ts                                                          DELETED — generic annotation in shared replaces it
└── (cert-specific HITL reason copy stays in hr-service strings file)

packages/hr-service/src/modules/certifications/activities/
└── run-vision-agent.activity.ts                                      MOD — replaces direct vision-agent imports with shared agent + cert config
                                                                       (or DELETED if 58E already removed it; check first)

packages/hr-service/src/services/cert-extraction-config.ts             NEW — cert-specific config object passed to buildExtractionAgent
                                                                       (prompt name, output schema, threshold tunable key, hitl mode)

packages/hr-service/src/db/migrations/
└── NNN_cert_extraction_tunables.sql                                   MOD/NEW — extract any cert-specific thresholds into per-doc-type tunables
                                                                       (e.g. cert.{cpr,first_aid,whs}.confidence_threshold)
                                                                       — only if not already covered by lg.cert_text_extraction_min_chars from 58C-FIX
```

---

## Hard rules

1. **Generic agent lives in `@cip/shared/extraction/agents/`** as a
   subpath that's NOT re-exported from `@cip/shared/index.ts`.
   LangGraph + LiteLLM imports pull `node:tls`; workflow bundles
   would break if the index transitively reached this code.
2. **No domain types in the generic agent**. State annotation is
   `<TFields = Record<string, unknown>>`. Agent never knows what
   a cert vs invoice is — it runs the configured prompt + schema.
3. **Confidence scoring is consumer-configurable**, default
   implementation reads schema-aware completeness (% of required
   fields filled) + LLM self-reported confidence. Modules can
   override with their own scorer if needed.
4. **HITL routing is a config option**, not hardcoded. Cert uses
   `'flag'` (record `requiresHitl=true` and continue); a
   contract-extractor might pass `'block'` (refuse to proceed
   without human approval); a low-stakes module passes `'never'`.
5. **Backward-compatible cert behavior**. Cert workflow + HITL
   audit trail unchanged at the system-observable level. Only
   internal code paths shorten.
6. **Single LangGraph subgraph instance per agent config**. Build
   once at module load, reuse across activity invocations.
7. **No new MCP tools**. This is internal infrastructure; the
   per-module extraction-strategy activities (cert,
   training-record, invoice) consume the shared agent and stay
   the public-facing surface.
8. **Activity-side validation**. The strategy activity Zod-parses
   the agent's output before persistence (Non-Negotiable #5);
   the agent itself trusts the configured schema's parse.

---

## Generic agent shape (sketch)

```typescript
// @cip/shared/extraction/agents/index.ts

export interface ExtractionAgentConfig<TFields> {
  /** Langfuse-hosted prompt name. */
  promptName: string;

  /** Zod schema for the extracted fields. */
  outputSchema: z.ZodType<TFields>;

  /** LiteLLM model alias. Default: 'cip-document' for text path,
      'cip-vision' for image path. */
  modelAlias?: string;

  /** Tunable key for the confidence threshold; defaults to a
      per-config constant if the tunable is missing. */
  confidenceThresholdTunable?: string;

  /** What to do when confidence < threshold:
      'flag'  — set requiresHitl=true, continue with low-conf result
      'block' — throw ApplicationFailure('LowConfidence'); the strategy
                activity decides whether to retry, escalate, or fail
      'never' — accept any confidence; never flag. */
  hitlMode: 'flag' | 'block' | 'never';

  /** Optional override of the default confidence scorer. */
  scoreConfidence?: (parsed: TFields, llmReportedConfidence?: number) => number;
}

export interface ExtractionAgentInput {
  tenantId:        string;
  documentId:      string;
  /** At least one of these MUST be non-empty. */
  ocrText?:        string;
  documentBase64?: string;            // for vision path
  /** Optional context from upstream (sensitivity tier, generic
      features) — passed through to the prompt as JSON. */
  context?:        Record<string, unknown>;
}

export interface ExtractionAgentOutput<TFields> {
  fields:                TFields;
  confidence:            number;
  requiresHitl:          boolean;
  evidence: {
    promptVersion:       string;
    modelAlias:          string;
    rawLLMOutput?:       string;       // truncated; for debug/audit
    confidenceBreakdown: Record<string, number>;
  };
}

export function buildExtractionAgent<TFields>(
  config: ExtractionAgentConfig<TFields>,
): (input: ExtractionAgentInput) => Promise<ExtractionAgentOutput<TFields>>;
```

---

## Cert adapter (after 58J)

```typescript
// packages/hr-service/src/services/cert-extraction-config.ts
import { buildExtractionAgent } from '@cip/shared/extraction/agents'
import { CertExtractionFieldsSchema } from '../modules/certifications/types/cert-extraction.js'

export const certExtractionAgent = buildExtractionAgent({
  promptName:                  'bot.documents.extract_certificate',
  outputSchema:                CertExtractionFieldsSchema,
  confidenceThresholdTunable:  'cert.extraction_confidence_threshold',
  hitlMode:                    'flag',
});

// packages/hr-service/src/modules/certifications/activities/extract-cert-features.activity.ts
// AFTER 58J — internal helper becomes:
async function extractWithVisionAgent(input, ctx): Promise<ExtractionOutput> {
  const result = await certExtractionAgent({
    tenantId:       input.tenantId,
    documentId:     input.documentId,
    ocrText:        input.ocrText,
    documentBase64: input.documentBase64,
    context:        { sensitivityTier: input.sensitivityTier, certTypeHint: input.certTypeHint },
  });
  return {
    fields:               result.fields,
    extractionConfidence: result.confidence,
    evidence:             result.evidence,
  };
}
```

The cert vision-agent's existing 150 LOC of LangGraph + node
plumbing collapses to ~30 LOC of config + adapter.

---

## Future consumers (proof-of-design)

The generic agent makes future doc_type extractors trivial:

| Module | Doc type | Prompt | Output schema | HITL mode |
|---|---|---|---|---|
| cert | certificate.cpr / .first_aid / .whs | `bot.documents.extract_certificate` | `CertExtractionFieldsSchema` | flag |
| training | training.module_completion | `bot.documents.extract_training_record` | `TrainingRecordSchema` | flag |
| compliance | compliance.audit_finding | `bot.documents.extract_audit_finding` | `AuditFindingSchema` | block |
| finance | finance.expense_receipt | `bot.documents.extract_receipt` | `ReceiptSchema` | never |
| contracts | contract.* | `bot.documents.extract_contract_clauses` | `ContractClausesSchema` | block |

Each module ships a config + adapter; no new agent, no new
graph, no new orchestration code.

---

## Acceptance criteria

1. `pnpm typecheck` clean across all 6 packages after the move.
2. `pnpm test` in @cip/shared: new tests cover
   `buildExtractionAgent` with a stub schema (no LLM call;
   stubbed-out node) — verifies graph wiring, confidence scoring,
   HITL routing branch logic.
3. `pnpm test` in @cip/hr-service: existing cert-extraction tests
   pass against the thinned adapter.
4. Live deploy: upload a CPR cert PDF in Teams. Cert workflow
   completes with same DB rows / audit trail / HITL routing
   behavior as pre-58J.
5. Live deploy: upload a non-cert PDF; classifier sends to a
   non-cert strategy that doesn't yet exist in 58J — verify it
   doesn't accidentally consume the generic agent (out of scope).

---

## Stop conditions

- The cert agent's existing confidence-scoring logic turns out
  to be cert-specific in subtle ways (e.g. weights certain field
  presences uniquely) that don't generalize cleanly. Stop and
  report — may need to ship a "default scorer" + cert override
  rather than a single shared scorer.
- LangGraph state-shape parametrisation hits a TypeScript
  inference wall that requires loosening to `unknown`. If so:
  stop, report, decide whether to ship a less-typesafe shared
  agent or keep cert's bespoke version.
- 58E rewrites the cert workflow in a way that obsoletes
  `run-vision-agent.activity.ts` entirely. If so, 58J's "thinned
  adapter" lives elsewhere — either inside `extract-cert-features.
  activity.ts` or in a new `cert-extraction-strategy.ts`. Adjust.

---

## Cross-slice notes

- 58C-FIX (in flight) decides whether the agent is even needed
  for text-rich docs. After 58C-FIX, the generic agent runs only
  for image-sparse-text cases. That's still cross-cutting (every
  module that ever sees a scanned doc needs vision OCR) but the
  call volume drops.
- 58D will register at least one new prompt
  (`bot.documents.subject_hint_parse`) but uses a different
  pattern (small structured-output call, not a full LangGraph
  agent). 58D does NOT consume `buildExtractionAgent`. This is
  fine — the generic agent is for FIELD EXTRACTION; subject
  resolution is a different kind of LLM task.
- 58F's reclassification flow re-runs classify+extract on a doc;
  it consumes the same per-module strategy that calls
  `buildExtractionAgent`. Zero new work in 58F to support 58J.
- 58H's per-tenant doc-type CLASSIFIER is separate from this
  agent; classifier picks (module, doc_type), this agent then
  extracts FIELDS for that doc_type.
- 58I's cert template-and-compare consumes the agent's output
  fields. Adding a "validate against template" pre-flight to the
  agent's `flagForHitl` decision could be a 58I tuning, not 58J.
