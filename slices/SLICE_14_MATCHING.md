# Slice 14 — Matching Activities

> **Prerequisite:** Slices 02, 05B, 06 complete.
> **Package:** `@cip/hr-service`
> **Verify:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/modules/certifications/activities/
  match-employee.activity.ts
  match-cert-definition.activity.ts
  nickname-map.ts             ← 90-entry first-name alias table
```

These replace the `throw new Error('not implemented')` stubs registered in Slice 06.

---

## Employee Matching — Three Passes

```typescript
export interface EmployeeMatchResult {
  matched: boolean
  employeeId?: string
  confidence: number
  method: 'exact_email' | 'fuzzy_name' | 'llm_tiebreaker' | 'no_match'
}
```

**Pass 1 — Exact email**
Look up `extraction.extracted.holderEmail` in `employees` table. If found, return `confidence: 1.0, method: 'exact_email'`.

**Pass 2 — Fuzzy name**
Compare `extraction.extracted.holderName` against all employees:
- Normalise both strings: lowercase, trim
- Split into given/surname; check NICKNAME_MAP for first name aliases
- Score: exact surname match (0.5) + exact or alias first name match (0.5)
- If score >= 0.8, return `confidence: score, method: 'fuzzy_name'`

**Pass 3 — LLM tiebreaker**
If multiple candidates score >= 0.5, send them to LiteLLM (`cip-lightweight` alias) with the extracted name and candidate list. LLM selects the best match or returns `no_match`.

```typescript
export async function matchEmployeeActivity(input: {
  tenantId: string
  submissionId: string
  extraction: ExtractionResult
}): Promise<EmployeeMatchResult> {
  const virtualKey = process.env['LITELLM_VIRTUAL_KEY']
  if (!virtualKey) throw new Error('LITELLM_VIRTUAL_KEY env var is required')
  // createLiteLLMClient({ tenantId: input.tenantId, virtualKey }) — used only in Pass 3
  // ... three passes
  // Zod-validate result before returning
  return EmployeeMatchResultSchema.parse(result)
}
```

---

## `nickname-map.ts`

Port from `sample/ernai/packages/orchestration-service/src/matching/personMatch.ts`.
The map contains ~90 entries: `Andy ↔ Andrew`, `Bill ↔ William`, `Bob ↔ Robert`, etc.

```typescript
export const NICKNAME_MAP: Record<string, string[]> = {
  andrew: ['andy', 'drew'],
  william: ['bill', 'billy', 'will', 'willy'],
  robert: ['bob', 'rob', 'bobby', 'robby'],
  // ... full list from PoC
}
```

---

## Cert Definition Matching — Two Passes

```typescript
export interface CertDefMatchResult {
  matched: boolean
  certDefId?: string
  confidence: number
  method: 'word_overlap' | 'llm_selection' | 'no_match'
}
```

**Pass 1 — Word overlap**
Score each `certificate_definition` against `extraction.extracted.certName`:
- Tokenise both strings (lowercase, split on non-alpha)
- Overlap score = `|intersection| / |union|` (Jaccard similarity)
- Also score against `definition.keywords` array
- Take the max score across name + keywords
- If best score >= 0.6, return `confidence: score, method: 'word_overlap'`

**Pass 2 — LLM selection**
If no definition scores >= 0.6, send the full `certificate_definitions` list for the tenant to LiteLLM (`cip-lightweight`). LLM selects the best match or returns `no_match`.

```typescript
export async function matchCertDefinitionActivity(input: {
  tenantId: string
  submissionId: string
  extraction: ExtractionResult
}): Promise<CertDefMatchResult> {
  const virtualKey = process.env['LITELLM_VIRTUAL_KEY']
  if (!virtualKey) throw new Error('LITELLM_VIRTUAL_KEY env var is required')
  // createLiteLLMClient({ tenantId: input.tenantId, virtualKey }) — used only in Pass 2
  // ... two passes
  return CertDefMatchResultSchema.parse(result)
}
```

---

## Zod Schemas (define in this slice)

```typescript
export const EmployeeMatchResultSchema = z.object({
  matched:    z.boolean(),
  employeeId: z.string().uuid().optional(),
  confidence: z.number().min(0).max(1),
  method:     z.enum(['exact_email', 'fuzzy_name', 'llm_tiebreaker', 'no_match']),
})

export const CertDefMatchResultSchema = z.object({
  matched:    z.boolean(),
  certDefId:  z.string().uuid().optional(),
  confidence: z.number().min(0).max(1),
  method:     z.enum(['word_overlap', 'llm_selection', 'no_match']),
})
```

---

## Required Environment Variables

| Variable | Purpose |
|---|---|
| `LITELLM_VIRTUAL_KEY` | Virtual key for LiteLLM proxy — required, no fallback |
| `LITELLM_BASE_URL` | LiteLLM proxy base URL |
| `DATABASE_URL_HR` | HR service Postgres connection string (via `getDb()`) |

---

## Hard Rules

1. Both activities Zod-validate their return value before returning — they are Temporal Activities
2. LLM calls use `cip-lightweight` alias via `createLiteLLMClient()` — never a raw model string
3. `tenantId` never appears in LLM prompts — only anonymised candidate lists
4. DB lookups use `withTenantRLS(db, tenantId, ...)` — never raw queries
5. `LITELLM_VIRTUAL_KEY` is checked at activity start — throw immediately if missing

---

## Acceptance Criteria

- [ ] `matchEmployeeActivity` implements all three passes
- [ ] `matchCertDefinitionActivity` implements both passes
- [ ] `NICKNAME_MAP` ported from PoC (minimum 30 entries)
- [ ] Both return types Zod-validated before returning
- [ ] LLM calls use `cip-lightweight` alias
- [ ] Temporal worker (Slice 06) updated to register both activities
- [ ] `pnpm --filter @cip/hr-service typecheck` passes
