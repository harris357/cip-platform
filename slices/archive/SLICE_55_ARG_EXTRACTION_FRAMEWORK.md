# Slice 55 — Per-tool argument extraction framework + grammar router

> **Prerequisite:** Slice 48 deployed (`bot_turn_metrics` for telemetry). Tool-annotation hotfix `11c67ce` deployed (so each tool's input schema reaches the bot reliably).
> **Package:** `@cip/teams-bot`, `@cip/hr-service` (one migration: `bot_intent_examples` table for the `/teach` slash command), Makefile additions.
> **Verify:** Typing `/disable jdoe@acme.com` (or "off-board jdoe@acme.com") with Slice 55 deployed routes via the grammar router → email regex extracts → DB lookup confirms → `gateWrite` → `confirm` → execute. Pod log shows ZERO LLM calls. `bot_turn_metrics` row carries `extraction_path='deterministic'`, `used_llm_planner=false`. Per-tenant kill switch `lg.grammar_router_enabled = false` reverts a tenant byte-for-byte.

---

## Why this slice exists

The full planner LLM (`cip-router-careful`, mistral-small) runs on every non-chitchat turn at ~1.5–3s + ~4500 prompt tokens. For templated requests like "/disable bob@acme.com", "show my certs", "list staff in engineering" — the planner's "which tool + which args" decision is fully deterministic and wasted compute.

This slice ships **two things needed to skip the planner on templated requests**:

1. **Per-tool extractor framework** — a TypeScript interface + registry so each tool can declare a function that takes user text + auth context + DB and returns either complete args, missing required args, or ambiguous candidates.

2. **Grammar router** — a deterministic regex-based fast-path that maps templated phrasings (slash commands, common verb-object patterns) directly to a tool + extractor. Runs as a graph node BEFORE triage.

This slice is also the **prerequisite for Slice 56** (sklearn intent router): the classifier picks the tool, the extractor fills the args. Without a working extraction framework, the sklearn classifier's "skip LLM entirely" path doesn't exist — it would always fall through to a narrow LLM call for arg extraction.

Shipping the framework first means:
- Templated traffic gets the speed/cost win immediately, no ML required.
- Slice 56 layers cleanly on top — the classifier replaces the regex grammar router as the matcher; extractors are reused unchanged.
- We accumulate real-world `(text → tool → args)` training data from Phase 1 of Slice 56's shadow mode WITHOUT having shipped the classifier yet.

## What this slice IS

1. **`Extractor` interface** — `extract(text, ctx, deps) → { args | missing | ambiguous }` + a registry keyed by tool name.

2. **Auth-derived helpers** — `useCallerId(ctx)`, `useCallerEmail(ctx)`, `useCallerEmployee(ctx, pool)`. For self-scoped queries ("MY certs", "my pending approvals").

3. **DB-resolution helpers** — `resolveEmployeeByNameOrEmail(text, ctx, pool) → { id, label } | { ambiguous: [...] } | null`, `resolveRoleByCode(code, ctx, pool)`, `resolveDepartment(text, ctx, pool)`. The shared building blocks every extractor uses.

4. **Concrete extractors** for the top 8-10 high-volume tools. Initial sweep: `employee_disable`, `employee_get`, `employee_list`, `view_certs`, `submit_cert` (clarify-path), `assign_role`, `revoke_role`, `permission_holders`, `role_get`, `role_members`. Each ~30-60 minutes.

5. **Grammar router** — a regex-pattern → `(toolName, hint)` map. Patterns cover slash-style commands and common templated phrasings ("off-board <X>", "show <Y>'s certs", "list staff in <Z>"). Patterns are short, readable, and per-tool (not a giant single regex).

6. **Disambiguation card builder** — when an extractor returns `ambiguous: [{id, label, hint}, ...]`, render an adaptive card with N buttons. Tap → `messageBack` resumes execution with the picked id. Reuses the Slice 53 invoke router pattern.

7. **Templated clarification** — when an extractor returns `missing`, send a per-intent template ("Who would you like to off-board?"). Zero-LLM.

8. **New graph node `grammarRoute`** placed BEFORE `triage`. Routing decision in `routeAfterGrammarRoute`:
   ```
   no grammar match                           → triage (existing path)
   grammar matched + extraction complete      → execute
   grammar matched + extraction ambiguous     → respond (disambiguation card)
   grammar matched + extraction missing       → respond (templated clarification)
   ```

9. **Telemetry additions** — `bot_turn_metrics` columns: `grammar_matched` (boolean), `grammar_pattern` (which pattern fired), `extraction_path`, `extracted_args_raw`, `resolved_args`, `extraction_outcome`.

10. **Low-effort training-data entry**:
    - **CSV file in repo**: `packages/intent-classifier/training/manual_examples.csv` — committed, reviewed via PR.
    - **`/teach` admin slash command**: type a labelled example from inside Teams; writes to `bot_intent_examples` table.
    - **"Add to training set" action on `/turn` cards**: tap a button on any /turn output to append that turn as a labelled example.

11. **Make commands** for everything operators need to do without remembering shell incantations.

## What this slice is NOT

- **Not the sklearn classifier.** That's Slice 56. This slice ships extractors + a regex grammar router as the matcher.
- **Not a full NER system.** Extractors are per-tool, hand-written. They handle the templated cases. Free-form references fall through to the existing planner.
- **Not a closed-loop training pipeline.** The training-data entry paths land here; the model that consumes them ships in Slice 56.
- **Not a replacement for the planner.** The planner stays; only templated patterns get the fast path. Anything that doesn't match falls through unchanged.
- **Not multi-tenant per-extractor.** v1 has one global extractor registry. Per-tenant variants would be a follow-up if traffic patterns diverge.

---

## Component 1 — `Extractor` interface

```ts
// packages/teams-bot/src/intent/extractors/types.ts

export interface ExtractionDeps {
  pool:    pg.Pool;       // for DB resolution
  // (more here as needed — Langfuse client, etc.)
}

export type ExtractionResult =
  | { kind: 'complete';    args:  Record<string, unknown> }
  | { kind: 'ambiguous';   candidates: Array<{ id: string; label: string; hint?: string }>;
                            argName: string }   // which arg is ambiguous
  | { kind: 'missing';     missing: string[] }
  | { kind: 'no_match' };                       // extractor didn't find anything to extract

export interface Extractor {
  toolName: string;
  /**
   * Returns:
   *   - `complete`: args are ready, execute the tool
   *   - `ambiguous`: DB resolution returned >1 match; render disambiguation card
   *   - `missing`: required args not extracted; render templated clarification
   *   - `no_match`: not even a partial match — fall through to planner
   */
  extract: (
    text: string,
    ctx:  BotAuthContext,
    deps: ExtractionDeps,
  ) => Promise<ExtractionResult>;
}
```

## Component 2 — Auth-derived helpers

```ts
// packages/teams-bot/src/intent/extractors/auth-helpers.ts

/** "MY certs", "my profile", "what can I do" — caller's own employee_id. */
export function useCallerId(ctx: BotAuthContext): string {
  return ctx.employeeId;
}

/** Lookup the caller's employee row in case the extractor needs more than just the id. */
export async function useCallerEmployee(
  ctx: BotAuthContext, pool: pg.Pool,
): Promise<{ id: string; email: string; full_name: string; department: string | null } | null> {
  const r = await pool.query(
    `SELECT id, email, full_name, department FROM employees
      WHERE id = $1 AND tenant_id = $2 AND disabled_at IS NULL LIMIT 1`,
    [ctx.employeeId, ctx.tenantId],
  );
  return r.rows[0] ?? null;
}

/** Detect "my", "I", "me", "myself" → caller-scoped query. */
export function isSelfScoped(text: string): boolean {
  return /\b(my|I|me|myself)\b/i.test(text);
}
```

## Component 3 — DB-resolution helpers

```ts
// packages/teams-bot/src/intent/extractors/db-helpers.ts

/**
 * Try email match first (deterministic), then ILIKE on full_name.
 * Returns:
 *   - { id, label } if exactly 1 active match
 *   - { ambiguous: [...] } if >1 match (top 5)
 *   - null if no match
 */
export async function resolveEmployeeByNameOrEmail(
  text: string, ctx: BotAuthContext, pool: pg.Pool,
): Promise<{ id: string; label: string } | { ambiguous: Array<{id:string;label:string;hint?:string}> } | null> {
  const email = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  if (email) {
    const r = await pool.query(
      `SELECT id, full_name FROM employees
        WHERE email = $1 AND tenant_id = $2 AND disabled_at IS NULL LIMIT 5`,
      [email.toLowerCase(), ctx.tenantId],
    );
    if (r.rows.length === 1) return { id: r.rows[0].id, label: r.rows[0].full_name };
    if (r.rows.length > 1)
      return { ambiguous: r.rows.map(row => ({ id: row.id, label: row.full_name, hint: email })) };
  }

  // Quoted name OR Capitalized-Word(s) following a verb
  const quoted = text.match(/"([^"]+)"|'([^']+)'/);
  const verbName = text.match(
    /(?:off-?board|disable|deactivate|terminate|fire|enable|view|show|find|lookup|details? for|assign|revoke|grant)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  );
  const candidate = (quoted?.[1] ?? quoted?.[2] ?? verbName?.[1] ?? '').trim();
  if (candidate) {
    const r = await pool.query(
      `SELECT id, full_name, email, department FROM employees
        WHERE tenant_id = $1 AND full_name ILIKE $2 AND disabled_at IS NULL LIMIT 5`,
      [ctx.tenantId, `%${candidate}%`],
    );
    if (r.rows.length === 1) return { id: r.rows[0].id, label: r.rows[0].full_name };
    if (r.rows.length > 1)
      return { ambiguous: r.rows.map(row => ({
        id: row.id, label: row.full_name,
        hint: row.department ? `${row.department} · ${row.email}` : row.email,
      })) };
  }

  return null;
}

export async function resolveRoleByCode(
  code: string, ctx: BotAuthContext, pool: pg.Pool,
): Promise<{ id: string; label: string } | null> { /* ... */ }

export async function resolveDepartment(
  text: string, ctx: BotAuthContext, pool: pg.Pool,
): Promise<string | null> { /* match against known departments list */ }
```

## Component 4 — Concrete extractors (sketch for one)

```ts
// packages/teams-bot/src/intent/extractors/employee-disable.ts

export const employeeDisableExtractor: Extractor = {
  toolName: 'employee_disable',
  async extract(text, ctx, { pool }) {
    const reason = extractReason(text);  // optional arg
    const resolved = await resolveEmployeeByNameOrEmail(text, ctx, pool);

    if (!resolved) return { kind: 'missing', missing: ['employeeId'] };
    if ('ambiguous' in resolved) {
      return { kind: 'ambiguous', argName: 'employeeId', candidates: resolved.ambiguous };
    }
    return {
      kind: 'complete',
      args: { employeeId: resolved.id, ...(reason ? { reason } : {}) },
    };
  },
};

function extractReason(text: string): string | undefined {
  const m = text.match(/(?:reason|because|due to|for)\s+["']?([^"']+)["']?$/i);
  return m?.[1]?.trim();
}
```

```ts
// packages/teams-bot/src/intent/extractors/view-certs.ts

export const viewCertsExtractor: Extractor = {
  toolName: 'view_certs',
  async extract(text, ctx, { pool }) {
    if (isSelfScoped(text) || !text.match(/[A-Z][a-z]+/)) {
      // "show my certs" / "what certs" → caller's own
      return { kind: 'complete', args: { employeeId: useCallerId(ctx) } };
    }
    const resolved = await resolveEmployeeByNameOrEmail(text, ctx, pool);
    if (!resolved) return { kind: 'missing', missing: ['employeeId'] };
    if ('ambiguous' in resolved)
      return { kind: 'ambiguous', argName: 'employeeId', candidates: resolved.ambiguous };
    return { kind: 'complete', args: { employeeId: resolved.id } };
  },
};
```

```ts
// packages/teams-bot/src/intent/extractors/index.ts

export const EXTRACTORS: Record<string, Extractor> = {
  employee_disable:    employeeDisableExtractor,
  employee_get:        employeeGetExtractor,
  employee_list:       employeeListExtractor,
  view_certs:          viewCertsExtractor,
  submit_cert:         submitCertExtractor,
  assign_role:         assignRoleExtractor,
  revoke_role:         revokeRoleExtractor,
  permission_holders:  permissionHoldersExtractor,
  role_get:            roleGetExtractor,
  role_members:        roleMembersExtractor,
};
```

## Component 5 — Grammar router

A short, declarative pattern → tool map. NOT a giant regex; one pattern per tool, ordered by specificity (slash commands first, then verb-object phrases).

```ts
// packages/teams-bot/src/intent/grammar/patterns.ts

export interface GrammarPattern {
  pattern:  RegExp;
  toolName: string;
  /** Optional — extra hint for the extractor (e.g., a fixed arg). */
  hint?:    Record<string, unknown>;
  /** Human-readable name for telemetry. */
  name:     string;
}

export const GRAMMAR_PATTERNS: GrammarPattern[] = [
  // Slash-style — exact verb + identifier
  { name: 'slash_disable',   pattern: /^\/disable\s+(\S+)/i,         toolName: 'employee_disable' },
  { name: 'slash_certs',     pattern: /^\/certs(\s|$)/i,             toolName: 'view_certs' },
  { name: 'slash_staff',     pattern: /^\/(staff|employees)(\s|$)/i, toolName: 'employee_list' },

  // Verb-object phrasings
  { name: 'verb_disable',    pattern: /\b(off-?board|disable|deactivate|terminate|fire)\s+/i, toolName: 'employee_disable' },
  { name: 'verb_view_certs', pattern: /\b(show|view|see|list|get)\s+(my\s+)?certs?/i,         toolName: 'view_certs' },
  { name: 'verb_list_staff', pattern: /\b(list|show|find|who('|s)?\s+in)\s+.{0,30}(staff|employees|team|department)/i, toolName: 'employee_list' },
  { name: 'verb_assign',     pattern: /\b(assign|grant)\s+.+\s+(role|to)\s+/i,                toolName: 'assign_role' },
  { name: 'verb_revoke',     pattern: /\b(revoke|remove)\s+(.+\s+)?role/i,                   toolName: 'revoke_role' },
  { name: 'verb_holders',    pattern: /\bwho\s+(has|holds)\s+(the\s+)?[a-z._]+/i,            toolName: 'permission_holders' },
  // ...
];

/** Returns the first matching pattern, or null. Patterns ordered by specificity. */
export function matchGrammar(text: string): { pattern: GrammarPattern } | null {
  for (const p of GRAMMAR_PATTERNS) {
    if (p.pattern.test(text)) return { pattern: p };
  }
  return null;
}
```

## Component 6 — Graph integration

State adds:
```ts
// state.ts — additions
extractionResult: Annotation<ExtractionResult | null>({ reducer: (_p, n) => n, default: () => null }),
grammarMatch:     Annotation<{ name: string; toolName: string } | null>({ reducer: (_p, n) => n, default: () => null }),
```

New node:
```ts
// nodes/grammar-route.ts (sketch)
export function makeGrammarRouteNode(ctx: BotAuthContext, pool: pg.Pool) {
  return async function grammarRouteNode(state: State): Promise<Partial<State>> {
    if (!await isEnabled(state.tenantId)) return { grammarMatch: null, extractionResult: null };
    const match = matchGrammar(state.latestUserText);
    if (!match) return { grammarMatch: null, extractionResult: { kind: 'no_match' } };
    const extractor = EXTRACTORS[match.pattern.toolName];
    if (!extractor) return { grammarMatch: null, extractionResult: { kind: 'no_match' } };
    const result = await extractor.extract(state.latestUserText, ctx, { pool });
    return {
      grammarMatch: { name: match.pattern.name, toolName: match.pattern.toolName },
      extractionResult: result,
    };
  };
}
```

Graph wiring:
```ts
// graph.ts — additions
.addNode('grammarRoute', makeGrammarRouteNode(ctx, pool))
.addEdge('ingest', 'grammarRoute')
.addConditionalEdges('grammarRoute', routeAfterGrammar, {
  fallthrough:  'triage',     // existing path; grammar didn't match or no extractor
  execute:      'execute',    // synthesized AIMessage(tool_calls) for execute to consume
  disambiguate: 'respond',    // disambiguation card
  clarify:      'respond',    // templated clarification
})
```

```ts
// routeAfterGrammar
async function routeAfterGrammar(state: State): Promise<'fallthrough' | 'execute' | 'disambiguate' | 'clarify'> {
  const r = state.extractionResult;
  if (!r || r.kind === 'no_match') return 'fallthrough';
  if (r.kind === 'complete') {
    // Synthesize an AIMessage with the tool_calls so execute node can consume it.
    // (Done in the grammarRouteNode return above — omitted from sketch for clarity.)
    return 'execute';
  }
  if (r.kind === 'ambiguous') return 'disambiguate';
  if (r.kind === 'missing')   return 'clarify';
  return 'fallthrough';
}
```

The `respond` node consumes `extractionResult` to render the appropriate card or template.

## Component 7 — Disambiguation card

Reuses Slice 53's invoke router. New verb: `intent.disambiguate`. Card payload carries `{ resumeToolName, partialArgs, argName }`. Tap a button → bot's invoke handler merges `{ argName: pickedId }` into `partialArgs` → routes to `gateWrite` → `confirm`/`execute`.

```ts
// intent/disambiguation-card.ts — builder
export function buildDisambiguationCard(args: {
  prompt:       string;                 // "Which employee did you mean?"
  candidates:   Array<{id:string;label:string;hint?:string}>;
  resumeToolName: string;
  partialArgs:  Record<string, unknown>;
  argName:      string;
}): AdaptiveCard;
```

## Component 8 — Templated clarification

```ts
// intent/clarification-templates.ts
export const CLARIFICATION_BY_TOOL: Record<string, (missing: string[]) => string> = {
  employee_disable: (m) => `Who would you like to off-board? Reply with their name or email.`,
  view_certs:       (m) => `Whose certifications? Type your name for yours, or someone else's name for theirs.`,
  assign_role:      (m) => `Which role would you like to assign? Reply with the role code (e.g. \`hr_standard\`).`,
  // ...
};
```

## Component 9 — Telemetry

```sql
-- migration NNN_grammar_router_metrics.sql
ALTER TABLE bot_turn_metrics
  ADD COLUMN IF NOT EXISTS grammar_matched     BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS grammar_pattern     TEXT,
  ADD COLUMN IF NOT EXISTS extraction_outcome  TEXT,    -- complete | ambiguous | missing | no_match | null
  ADD COLUMN IF NOT EXISTS extraction_tool     TEXT;    -- which tool the extractor handled
```

Win-rate query post-deploy:
```sql
SELECT grammar_pattern, COUNT(*) AS hits,
       AVG(total_ms)::int AS avg_ms,
       SUM(CASE WHEN used_llm_planner = false THEN 1 ELSE 0 END) AS llm_skipped,
       SUM(CASE WHEN extraction_outcome = 'complete' THEN 1 ELSE 0 END) AS executed_directly
FROM bot_turn_metrics
WHERE emitted_at > NOW() - INTERVAL '24 hours' AND grammar_matched
GROUP BY grammar_pattern ORDER BY hits DESC;
```

## Component 10 — Low-effort training-data entry

Three paths, all writing to the same eventual `training_data.csv` consumed by Slice 56:

### (a) CSV file in repo (committed, PR-reviewed)

```
packages/intent-classifier/training/manual_examples.csv
```

Schema: `text,intent,tool,next_action,source,added_by,added_at,notes`

```csv
text,intent,tool,next_action,source,added_by,added_at,notes
"off-board the new contractor",disable_employee,employee_disable,clarify,manual,harris,2026-05-02,"contractor → ambiguous; clarify path expected"
"show me my expiring certs",view_certs,certifications_list,call_tool,manual,harris,2026-05-02,
```

Devs append rows. Mining client docs? Append in bulk. Reviewed via PR.

### (b) `/teach` admin slash command

Admin types in Teams:
```
/teach intent=disable_employee tool=employee_disable next_action=call_tool text="off-board the contractor I told you about"
```

Bot writes a row to `bot_intent_examples` table:

```sql
-- migration NNN_bot_intent_examples.sql
CREATE TABLE IF NOT EXISTS bot_intent_examples (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  added_by     TEXT NOT NULL,                    -- employee_id
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  text         TEXT NOT NULL,
  intent       TEXT NOT NULL,
  tool         TEXT,
  next_action  TEXT NOT NULL,                    -- call_tool | clarify | answer_directly | unknown
  source       TEXT NOT NULL DEFAULT 'teach',    -- teach | turn_label | trace_export | manual_csv
  source_turn_id TEXT,                            -- if added via /turn → "Add to training set"
  notes        TEXT,
  reviewed     BOOLEAN NOT NULL DEFAULT false,   -- gate before merging into training_data.csv
  CHECK (next_action IN ('call_tool', 'clarify', 'answer_directly', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_bot_intent_examples_tenant_unreviewed
  ON bot_intent_examples (tenant_id, reviewed) WHERE NOT reviewed;
```

Slash command gated on `bot.metrics.read` (same admin perm as `/turn`).

### (c) "Add to training set" action on `/turn` cards

The `/turn <id>` card renderer already exists (Slice 46e). Add a new `Action.Submit` button: "📚 Add to training set" with a small follow-up adaptive card containing intent + tool dropdowns prefilled from the turn's `tools_attempted`. Tap → writes a row to `bot_intent_examples` with `source='turn_label', source_turn_id=<id>`. One-click promotion of real production turns into labelled examples.

### Merge → `training_data.csv`

```bash
make training-data-export      # bot_intent_examples (reviewed=true) + manual_examples.csv → training_data.csv
```

Slice 56's training pipeline consumes that file.

---

## Component 11 — Make commands

All in the existing `Makefile` (additions):

```makefile
# ── Intent extraction layer (Slice 55) ──────────────────────────────────────

extractor-test:        ## Run unit tests for all per-tool extractors
	@pnpm --filter @cip/teams-bot test -- src/intent/extractors

extractor-coverage:    ## Show which tools have an extractor (vs which only have planner support)
	@bash scripts/extractor-coverage.sh

extractor-add:         ## Scaffold a new extractor file. Usage: make extractor-add tool=foo_bar
	@[ -n "$(tool)" ] || (echo "Error: tool=<name> required"; exit 1)
	@bash scripts/extractor-scaffold.sh $(tool)

# ── Training data (Slice 55 + Slice 56) ─────────────────────────────────────

training-data-add:     ## Interactive: append a row to manual_examples.csv
	@bash scripts/training-data-add.sh

training-data-stats:   ## Per-intent example counts across all sources
	@bash scripts/training-data-stats.sh

training-data-review:  ## List unreviewed bot_intent_examples (rows from /teach + turn-label)
	@bash scripts/training-data-review.sh

training-data-mark-reviewed: ## Mark example IDs as reviewed. Usage: make training-data-mark-reviewed ids='id1,id2'
	@[ -n "$(ids)" ] || (echo "Error: ids=<comma-list> required"; exit 1)
	@bash scripts/training-data-mark-reviewed.sh $(ids)

training-data-export:  ## Merge manual + reviewed bot_intent_examples + Langfuse traces → training_data.csv
	@bash scripts/training-data-export.sh

# ── Classifier (Slice 56) — stubs in 55, implemented in 56 ──────────────────

classifier-train:      ## (Slice 56) Train sklearn pipeline on training_data.csv
	@echo "Not implemented yet — ships with Slice 56"

classifier-eval:       ## (Slice 56) Held-out eval against current production artifact
	@echo "Not implemented yet — ships with Slice 56"

classifier-deploy:     ## (Slice 56) Push artifact to S3 + restart classifier pods
	@echo "Not implemented yet — ships with Slice 56"
```

Stubs for the Slice-56 commands are intentional — the Make UI is consistent from day 1; the implementations land with 56.

### Each script briefly

```bash
# scripts/extractor-coverage.sh
# Read packages/teams-bot/src/intent/extractors/index.ts → list registered tools.
# Read live MCP tool list (via /admin/tool-metadata) → list ALL tools.
# Show table: tool | has_extractor | last_seen_in_metrics | call_count_30d
# Helps prioritize which extractor to write next.

# scripts/extractor-scaffold.sh <tool>
# Creates packages/teams-bot/src/intent/extractors/<tool>.ts with a
# template Extractor implementation, plus a test stub.

# scripts/training-data-add.sh
# Interactive prompt (read -r) for: text, intent, tool, next_action, notes.
# Validates intent + next_action against allowed enum. Appends to manual_examples.csv.

# scripts/training-data-stats.sh
# Reads manual_examples.csv + queries bot_intent_examples + turn-label entries.
# Prints per-intent example counts (target: ≥200 per intent for sklearn).

# scripts/training-data-review.sh
# Queries bot_intent_examples WHERE reviewed=false. Pretty-prints for human review.

# scripts/training-data-mark-reviewed.sh <ids>
# UPDATE bot_intent_examples SET reviewed=true WHERE id IN (...).

# scripts/training-data-export.sh
# Reads manual_examples.csv + reviewed bot_intent_examples + Langfuse traces (recent
# auto-labelable turns: tool_executed AND correction_in_next_turn=false).
# Joins → packages/intent-classifier/training/training_data.csv.
```

## Tunables

```sql
INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.grammar_router_enabled', 'true',
   'Per-tenant kill switch for the grammar router + extractor framework.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.extractor_db_timeout_ms', '500',
   'Hard timeout for DB-resolution helpers. Exceeded → fall through to planner.')
ON CONFLICT (tenant_id, key) DO NOTHING;
```

---

## Files in scope

```
packages/teams-bot/src/intent/extractors/                          NEW
├── types.ts                                                        NEW (Extractor interface)
├── auth-helpers.ts                                                 NEW
├── db-helpers.ts                                                   NEW
├── employee-disable.ts                                             NEW
├── employee-get.ts                                                 NEW
├── employee-list.ts                                                NEW
├── view-certs.ts                                                   NEW
├── submit-cert.ts                                                  NEW
├── assign-role.ts                                                  NEW
├── revoke-role.ts                                                  NEW
├── permission-holders.ts                                           NEW
├── role-get.ts                                                     NEW
├── role-members.ts                                                 NEW
├── index.ts                                                        NEW (registry)
└── *.test.ts                                                       NEW (unit tests per extractor)

packages/teams-bot/src/intent/grammar/                              NEW
├── patterns.ts                                                     NEW (GRAMMAR_PATTERNS)
└── matcher.ts                                                      NEW (matchGrammar)

packages/teams-bot/src/intent/disambiguation-card.ts                NEW
packages/teams-bot/src/intent/clarification-templates.ts            NEW

packages/teams-bot/src/langgraph/nodes/grammar-route.ts             NEW
packages/teams-bot/src/langgraph/state.ts                           (+ extractionResult, grammarMatch fields)
packages/teams-bot/src/langgraph/graph.ts                           (+ grammarRoute node + edges)
packages/teams-bot/src/langgraph/nodes/respond.ts                   (consume extractionResult for cards/clarification)
packages/teams-bot/src/langgraph/runner.ts                          (write new metrics columns)
packages/teams-bot/src/langgraph/util/turn-metrics.ts               (extend TurnMetric type)

packages/teams-bot/src/slash-commands/handlers/teach.ts             NEW (/teach command)
packages/teams-bot/src/slash-commands/registry.ts                   (+ /teach entry)

packages/hr-service/src/db/migrations/NNN_grammar_router_metrics.sql NEW
packages/hr-service/src/db/migrations/NNN_bot_intent_examples.sql    NEW
packages/hr-service/src/db/migrations/NNN_grammar_router_tunables.sql NEW

packages/hr-service/src/modules/admin/mcp-tools/teach.tool.ts       NEW (server-side handler for /teach)
packages/hr-service/src/db/queries/bot-intent-examples.ts           NEW

packages/intent-classifier/training/                                NEW (placeholder dir; Slice 56 builds it out)
└── manual_examples.csv                                             NEW (empty, with header row)

scripts/extractor-coverage.sh                                       NEW
scripts/extractor-scaffold.sh                                       NEW
scripts/training-data-add.sh                                        NEW
scripts/training-data-stats.sh                                      NEW
scripts/training-data-review.sh                                     NEW
scripts/training-data-mark-reviewed.sh                              NEW
scripts/training-data-export.sh                                     NEW

Makefile                                                            (+ 9 new targets)

slices/SLICE_55_ARG_EXTRACTION_FRAMEWORK.md                         this file
```

---

## Hard rules

- **No turn fails because of extraction or grammar matching.** Any throw inside an extractor → log + return `kind: 'no_match'` → fall through to planner.
- **Tenant scoping in every DB query.** Every `pool.query` in extractors and DB helpers MUST filter by `ctx.tenantId`.
- **DB timeout protection.** Each helper has a 500ms hard timeout (tunable). Exceeded → fall through. Don't make extraction the bottleneck.
- **Server-side `assertPermission` is the security gate.** Even if grammar matches a write tool, the bot's `gateWrite` runs as today + `assertPermission` runs server-side. Grammar match doesn't bypass the confirm gate for write tools.
- **Self-scoped queries don't bypass auth.** `useCallerId` returns `ctx.employeeId` — same id the planner would use.
- **Templated clarification + disambiguation log explicitly.** `extraction_outcome IN ('clarify', 'ambiguous')`, `used_llm_planner=false`. Lets us measure the LLM-skip rate.
- **One extractor per tool, no fan-out.** If a user message could match multiple grammar patterns, the FIRST one wins (specificity-ordered). Multi-tool turns fall through to the planner.
- **Manual examples land in committed CSV.** `bot_intent_examples` is for the `/teach` and turn-label paths. The CSV is for bulk imports + doc mining.
- **`/teach` requires `bot.metrics.read`.** Same admin gate as `/turn` and `/metrics`.

---

## Verification

**Unit tests per extractor:**
```bash
make extractor-test
# pass for: empty input, valid email, valid quoted name, ambiguous DB return,
# self-scoped pattern, missing arg, no-match
```

**Coverage report:**
```bash
make extractor-coverage
# Should show all 10 high-volume tools with has_extractor=true after this slice.
```

**Live grammar match:**
```bash
# Send "/disable jdoe@acme.com" via Teams.
# Expect:
# - bot logs: [grammar-route] matched=slash_disable extracted=complete
# - turn footer shows latency < 500ms (no LLM call)
# - bot_turn_metrics row: grammar_matched=true, grammar_pattern='slash_disable',
#   extraction_outcome='complete', used_llm_planner=false
```

**Disambiguation:**
```bash
# Send "off-board Sarah" with multiple Sarahs in DB.
# Expect: adaptive card with N buttons; tap one → execute fires.
# bot_turn_metrics: extraction_outcome='ambiguous'.
```

**Clarification:**
```bash
# Send "off-board" (no name).
# Expect: templated "Who would you like to off-board?" reply.
# bot_turn_metrics: extraction_outcome='missing'.
```

**Training-data entry:**
```bash
# /teach intent=disable_employee tool=employee_disable next_action=call_tool text="contractor cleanup"
# Expect: bot replies "Added (id=...). Pending review."
# psql: SELECT * FROM bot_intent_examples WHERE id='...' shows reviewed=false.
make training-data-review
# Lists the new entry.
make training-data-mark-reviewed ids='<id>'
make training-data-stats
# Shows the new example counted under disable_employee intent.
```

**Make commands smoke:**
```bash
make extractor-coverage              # tabular output, no errors
make training-data-stats             # per-intent counts
make training-data-add               # interactive — exercise the prompt
make training-data-export            # produces packages/intent-classifier/training/training_data.csv
```

**Failure modes:**
```bash
# Stop hr-service Postgres (extractor's DB query times out).
# Send "/disable bob@acme.com" → grammar matches → extractor times out (500ms) →
# returns kind='no_match' → graph falls through to planner. User sees NORMAL
# planner-driven reply. bot_turn_metrics: grammar_matched=true,
# extraction_outcome='no_match'. Pod log warns about the timeout.

# Set lg.grammar_router_enabled=false for one tenant.
# Their turns skip the grammarRoute node entirely (no-op return).
# bot_turn_metrics: grammar_matched=false on all their turns.
```

---

## Phased rollout

This slice is small enough to ship in one go. But for safety:

1. **Day 1**: deploy code with `lg.grammar_router_enabled = false` (default). Migrations applied. Make commands available. CSV file initialized. Validate against shadow traffic by manually toggling `enabled = true` for the dev tenant only.

2. **Day 3**: dev tenant enabled for ~48h. Inspect `bot_turn_metrics` — what fraction of turns matched grammar? What was the extraction-complete rate? Any unexpected fallthroughs?

3. **Day 5**: enable for the canary production tenant. Watch for `extraction_outcome='no_match'` rates — if high, the patterns need broadening.

4. **Day 7**: enable globally (default flips to true, per-tenant overrides remain).

---

## Out of scope (deferred to Slice 56)

- The sklearn classifier itself (uses the extractors shipped here)
- ML model artifact lifecycle (S3 push, version tracking)
- Auto-retraining cron + eval gate
- LLM-as-labeling-assistant
- Per-tenant model variants
- The `correction_in_next_turn` analyzer (Slice 56 introduces this for training data quality; v1 of /teach + manual CSV doesn't need it)

---

## Cross-slice notes

- Reuses the Slice 53 invoke router for the disambiguation card's `Action.Submit` payloads.
- Builds on Slice 48's `bot_turn_metrics`. Adds columns; doesn't break existing schema.
- The `/teach` slash command and `bot.metrics.read` permission piggyback on Slice 46e's admin tools framework.
- Slice 56's `classify` graph node will run in PARALLEL with `grammarRoute` (or as a fallback when grammar misses) — NOT replace it. Grammar handles the obvious cases for free; sklearn handles the medium-confidence cases.
- The extractor framework is a clean place to add per-tool entity normalization later — could grow into a "tool helpers" module the rest of the codebase uses.
