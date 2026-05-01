# Bot performance debugging runbook

> **Audience:** anyone investigating "the bot feels slow" or a specific user complaint.
> **Last updated:** 2026-05-01 (Slice 48 deployed).
> **Two surfaces, one join key:** SQL on `cip_hr.bot_turn_metrics` filters; Langfuse traces explain. Both keyed by `turnId` from the Teams footer.

---

## At-a-glance: how to debug a slow turn

```
User reports slow turn   ──►  Langfuse trace                    ──►  Fix or escalate
                            (paste turn=<id>)

  ┌─ no specific report ─►  bot_turn_metrics SQL                ──►  Pick a turnId
  │   (last 1h slow turns)                                            │
  │                                                                   ▼
  └─────────────────────────────────────────────────────────────►  Langfuse trace
```

The pattern is always:
1. **Pick a turn** (from a user complaint, or by querying `bot_turn_metrics`).
2. **Open its trace** in Langfuse — the trace tree shows where time went.
3. **Read the per-LLM-call metadata** for cache-hit info, prompt provenance, model alias.
4. **Take action** based on what's slow: prompt size, model choice, tool latency, etc.

---

## Surface 1: `bot_turn_metrics` (Postgres) — filtering layer

Every Teams turn writes one row here, alongside the existing `[turn]` log line. The table is in **`cip_hr` (public schema)**, owned by `cipuser`. Schema:

| Column | Type | Notes |
|---|---|---|
| `turn_id` | TEXT PRIMARY KEY | 8-char hex; matches the Teams footer's `turn=<id>` |
| `tenant_id` | UUID | The CIP tenant |
| `thread_id` | TEXT | Teams conversation ID |
| `employee_id` | TEXT | Caller's employee_id |
| `emitted_at` | TIMESTAMPTZ | When the turn finished |
| `intent` | TEXT | `ask` (clarification) / `direct` (no tools) / `tool` / `unknown` |
| `tools_attempted` | TEXT[] | All tool names the planner emitted |
| `tools_refused` | TEXT[] | Subset that returned a refusal payload |
| `step_count` | INT | Plan-iterations in this turn |
| `triage_confidence` | REAL | 0..1; NULL when triage failed |
| `clarification_fired` | BOOLEAN | Triage routed to respond with a clarifying question |
| `confirmation_fired` | BOOLEAN | Graph suspended at a write-confirm interrupt |
| `resumed` | BOOLEAN | This turn resumed a prior interrupt (Slice 46b) |
| `total_ms` | INT | Wall-clock from request to reply |
| `graph_ms` | INT | LangGraph invoke duration |

### Connect

```bash
kubectl port-forward -n cip-infra svc/postgres-postgresql 15432:5432 &
psql "postgres://cipuser:${PG_USER_PASSWORD}@localhost:15432/cip_hr"
```

(Once the admin MCP tools from Slice 46e land, you can do most of this from inside Teams without psql.)

### Useful queries — copy/paste

**Triage 1 — "what's slow right now?"**

Slowest turns in the last hour:
```sql
SELECT turn_id, intent, step_count, total_ms, graph_ms,
       tools_attempted
  FROM bot_turn_metrics
 WHERE emitted_at > NOW() - INTERVAL '1 hour'
 ORDER BY total_ms DESC
 LIMIT 10;
```

**Triage 2 — "is the bot getting slower?"**

Latency percentiles per hour for the last day:
```sql
SELECT date_trunc('hour', emitted_at)                                     AS hr,
       COUNT(*)                                                            AS n,
       PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY total_ms)::int         AS p50,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_ms)::int         AS p95,
       MAX(total_ms)                                                       AS p100
  FROM bot_turn_metrics
 WHERE emitted_at > NOW() - INTERVAL '24 hours'
 GROUP BY hr
 ORDER BY hr;
```

A spike in p95 with stable p50 = fat tail; check the slowest turns. p50 spike across all turns = systemic — check LiteLLM, Mistral status, or a recent deploy.

**Triage 3 — "which tools are dominating?"**

Tool usage + average graph time:
```sql
SELECT unnest(tools_attempted)        AS tool,
       COUNT(*)                       AS calls,
       AVG(graph_ms)::int             AS avg_graph_ms,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY graph_ms)::int AS p95_graph_ms
  FROM bot_turn_metrics
 WHERE emitted_at > NOW() - INTERVAL '24 hours'
   AND intent = 'tool'
 GROUP BY tool
 ORDER BY calls DESC;
```

A tool with low call count but high p95 = a tail problem worth checking. A tool dominating call count = candidate for optimization (caching, batching, etc.).

**Triage 4 — "is the planner picking wrong tools?"**

Refused-tool rate per day:
```sql
SELECT date_trunc('day', emitted_at) AS day,
       COUNT(*)                       AS turns,
       SUM(CASE WHEN array_length(tools_refused, 1) > 0 THEN 1 ELSE 0 END) AS turns_with_refusal,
       (100.0 * SUM(CASE WHEN array_length(tools_refused, 1) > 0 THEN 1 ELSE 0 END) / COUNT(*))::int AS refusal_pct
  FROM bot_turn_metrics
 WHERE emitted_at > NOW() - INTERVAL '7 days'
 GROUP BY day
 ORDER BY day;
```

Higher than ~5% sustained = planner is picking wrong tools. Look at the actual refusal payloads via `kubectl logs -n cip-app deploy/teams-bot | grep refused`.

**Triage 5 — "is the planner looping?"**

Step-count outliers:
```sql
SELECT turn_id, step_count, total_ms, tools_attempted
  FROM bot_turn_metrics
 WHERE step_count > 2
 ORDER BY step_count DESC, total_ms DESC
 LIMIT 20;
```

`step_count` is the number of `plan` LLM calls. A single turn with stepCount=5 means the planner ran five times, which usually means it's chasing tool failures or the user request is genuinely complex. Open the trace.

**Triage 6 — "are confirms/resumes working?"**

Write-action cycle health:
```sql
SELECT date_trunc('day', emitted_at) AS day,
       SUM(CASE WHEN confirmation_fired THEN 1 ELSE 0 END) AS confirms,
       SUM(CASE WHEN resumed             THEN 1 ELSE 0 END) AS resumes
  FROM bot_turn_metrics
 WHERE emitted_at > NOW() - INTERVAL '7 days'
 GROUP BY day
 ORDER BY day;
```

`resumes` should track `confirms` minus the cancellation rate (~20-30% cancellations is normal). Resumes ≪ confirms = users abandoning the confirm flow; investigate UX.

**Triage 7 — "single-turn deep dive"**

When you have a `turn_id` (from a user complaint or query above):
```sql
SELECT * FROM bot_turn_metrics WHERE turn_id = '592edfbe';
```

Cross-reference: `kubectl logs -n cip-app deploy/teams-bot | grep "turn=592edfbe"` shows the structured `[turn]` log line + any `[llm-cache]` lines + any per-call warnings.

---

## Surface 2: Langfuse trace tree — explanation layer

For any `turn_id`, paste it into Langfuse:

**URL:** `https://cloud.langfuse.com` (production keys live in `teams-bot-credentials`)

In the Langfuse UI, go to **Traces** and search for `<turn_id>`. The trace tree contains:

### Reading the tree

Spans appear in graph-execution order:
```
turn-<id>                                    (root)
├── ingest                                  (~5ms)
├── discover                                (~10-300ms; cache miss = top of range)
├── triage                                  (~500-900ms)
│   └── bot.triage  [generation]            ← cip-classifier nemo call
├── plan                                    (~1500-3000ms — usually the long pole)
│   └── bot.plan   [generation]             ← cip-router-careful mistral-small
├── gateWrite                               (~1ms)
├── execute                                 (~variable; HTTP to MCP server)
│   ├── tool: <name1>                       (parallel — Slice 46c)
│   └── tool: <name2>
├── plan (iter 2)                           ← only if planner loops
│   └── bot.plan
├── execute (iter 2)
└── respond                                 (~1ms)
```

Each `[generation]` span shows:
- **Model alias** (`cip-classifier`, `cip-router-careful`, etc.)
- **Prompt tokens / completion tokens / cached tokens** (cache hit visible as a non-zero `cached_tokens`)
- **Latency** (start to first-token + total)
- **Cost** (Langfuse computes from the model price table)
- **Input / Output** (full prompt + response — useful for "why did it pick that tool?")
- **Metadata**: `purpose`, `prompt_name`, `prompt_version`, `tenantId`, your turnId

Each `tool: <name>` span shows the tool name, input args, output blob.

### Pattern guide — what each shape means

| Trace shape | Likely cause | Action |
|---|---|---|
| `plan` span ≫ everything else | Planner LLM is the long pole | Reduce candidate-tools count (Slice 44 vector retrieval), shorten `bot.plan`, or escalate to a faster model alias per-tenant in `routing_rules` |
| Two `plan` spans, second one slow | Planner re-iterating after a bad tool result | Inspect ToolMessage between them. Refused or empty? Improve the tool description / `whenNotToUse` |
| `discover` first call slow, subsequent fast | Cache warming (5-min TTL per `tenant+employee`) | Normal |
| `discover` consistently slow | Tool-retrieval endpoint slow | Check hr-service `/admin/tool-retrieval` latency |
| `bot.plan` iter 2 has 0 cached tokens | Prompt prefix non-deterministic across iterations | Investigate template — a timestamp / random ID is leaking into the system prompt |
| Generation duration ≫ wall-clock between spans | LiteLLM upstream contention | Check LiteLLM pod logs for queueing + Mistral status |
| `summarize` span on most turns | Threshold too low | Bump `lg.summarize_at` per-tenant in `bot_tunables` |
| `confirm` span present, no `execute` after | User cancelled or didn't reply yes/no | Normal — see `confirmation_fired=true, resumed=false` |
| `confirm` then `execute` in same trace | Resume turn (Slice 46b) | Normal — `resumed=true` in metrics |

### Aggregate views in Langfuse UI

- **Traces tab**: filter by `metadata.tenantId = "<id>"` for tenant-specific debugging.
- **Sessions tab**: groups traces by `langfuseSessionId = threadId`. Lets you watch a multi-turn conversation as a unit.
- **Generations tab**: filter by `purpose=bot.plan` to see ONLY planner calls. Sort by latency to find the worst.
- **Dashboards**: built-in latency histograms, cost-by-day, model-usage breakdowns.

### Cache hits — `[llm-cache]` lines

Slice 46c part 5 logs prompt-cache effectiveness to pod logs. Mistral does prefix-caching automatically; we measure.

```bash
kubectl logs -n cip-app deploy/teams-bot --since=24h | grep '\[llm-cache\]'
```

Sample output:
```
[llm-cache] purpose=bot.triage cached_tokens=614 total_prompt_tokens=796 hit_ratio=0.77
[llm-cache] purpose=bot.plan   cached_tokens=2400 total_prompt_tokens=4708 hit_ratio=0.51
```

What to look for:
- **`bot.triage` ratio < 0.5** sustained → triage prompt template is changing turn-to-turn. Bug.
- **`bot.plan` ratio < 0.3 on iter 2** of the same turn → tool_reference block is non-deterministic across the loop. Check for sort instability or random IDs.
- **No `[llm-cache]` lines at all** → Mistral isn't returning `prompt_tokens_details`. Either the model alias doesn't support caching, or LiteLLM isn't surfacing it. Inspect a generation in Langfuse → `usage` field.

---

## Joining the surfaces — concrete debugging recipes

### Recipe 1: "User says X turn was slow"

```bash
# 1. Get the turn row
psql -c "SELECT * FROM bot_turn_metrics WHERE turn_id = '<id>'"

# 2. Pod logs for that turn
kubectl logs -n cip-app deploy/teams-bot --since=24h | grep '<id>'

# 3. Open trace at https://cloud.langfuse.com/project/.../traces?search=<id>
# 4. Look for the longest span — that's the bottleneck.
# 5. Drill into its child generation. Compare tokens / model / cache hit.
```

### Recipe 2: "What's wrong with this tenant's bot?"

```sql
-- pick the slowest turn for this tenant in the last 24h
SELECT turn_id FROM bot_turn_metrics
 WHERE tenant_id = '<uuid>'
   AND emitted_at > NOW() - INTERVAL '24 hours'
 ORDER BY total_ms DESC LIMIT 1;
```

Then Recipe 1 on that turn.

### Recipe 3: "Tool X seems wrong"

```sql
-- recent calls for this tool, with latency
SELECT turn_id, total_ms, tools_attempted, tools_refused
  FROM bot_turn_metrics
 WHERE 'tool_x' = ANY(tools_attempted)
   AND emitted_at > NOW() - INTERVAL '24 hours'
 ORDER BY emitted_at DESC LIMIT 20;
```

Pick a few turns where it appeared in `tools_refused` AND `tools_attempted` (planner picked it but it returned refusal). Open their traces in Langfuse. Look at the tool's input args + the response — that tells you whether the planner gave it bad args, the tool genuinely failed, or the description is misleading.

### Recipe 4: "Did the latest deploy regress anything?"

```sql
-- compare an hour-window before and after a deploy timestamp
WITH bands AS (
  SELECT
    CASE WHEN emitted_at < TIMESTAMPTZ '2026-05-01 21:00+00' THEN 'before' ELSE 'after' END AS band,
    total_ms, intent
  FROM bot_turn_metrics
  WHERE emitted_at BETWEEN TIMESTAMPTZ '2026-05-01 20:00+00' AND TIMESTAMPTZ '2026-05-01 22:00+00'
)
SELECT band,
       COUNT(*) AS n,
       PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY total_ms)::int AS p50,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_ms)::int AS p95
  FROM bands
 GROUP BY band ORDER BY band;
```

If `after.p50 > before.p50 * 1.2`, latest deploy regressed something. Roll back or open traces.

### Recipe 5: "Are users abandoning confirms?"

```sql
SELECT
  COUNT(*) FILTER (WHERE confirmation_fired) AS confirms_started,
  COUNT(*) FILTER (WHERE resumed)            AS confirms_resumed,
  COUNT(*) FILTER (WHERE resumed AND tools_attempted <> '{}') AS resumed_with_tool_call
FROM bot_turn_metrics
WHERE emitted_at > NOW() - INTERVAL '7 days';
```

`resumed_with_tool_call / confirms_started` = the affirm rate. If it's < 50%, the confirm prompt's wording is unclear or users are second-guessing.

---

## Reference: env vars + URLs

- `LANGFUSE_HOST` (in `teams-bot-credentials`): `https://cloud.langfuse.com`
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`: project keys
- `DATABASE_URL_HR` (in `teams-bot-credentials` and `hr-service-credentials`): the Postgres URL the runner writes to and you query
- Pod logs source of truth: `kubectl logs -n cip-app deploy/teams-bot`

## What to do when something's broken

| Symptom | First action | Doc |
|---|---|---|
| All turns suddenly 4× slower | Check LiteLLM pod logs + Mistral status | this doc |
| One specific tool always slow | Check hr-service pod logs for that tool's handler | `slices/CONTEXT_WORKFLOW.md` |
| Bot says "I changed your name" but nothing happened | Confirm gate skipped — check `bot_tunables` for `lg.authorized_write_verbs` | `slices/SLICE_46_DURABLE_LANGGRAPH_STATE.md` |
| Wrong tool was picked | Open the trace, read `bot.plan` input/output | `slices/LLM_PROVIDER_NOTES.md` |
| `[llm-cache]` lines disappear after a deploy | Check that the prompt template didn't change | `slices/SLICE_46C_CHECKPOINT_HYGIENE.md` |
