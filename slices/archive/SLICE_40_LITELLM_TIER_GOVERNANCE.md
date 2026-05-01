# Slice 40 — LiteLLM Tier Governance via provision-tenant.sh

> **Prerequisite:** Slice 39A (per-purpose routing foundation) complete.
> **Package:** `scripts/`, `infra/helm/litellm/`
> **Verify:** `bash scripts/provision-tenant.sh --name "Test Co" --admin-email t@t.com --tier trial --tenant-id test-tier-trial` (run against dev cluster, then `curl` LiteLLM `/team/info` to confirm)

---

## Why This Slice Exists

Today, `provision-tenant.sh` issues a LiteLLM virtual key with a hardcoded
`max_budget: 100` and no model access list. Every tenant gets the same
$100/month cap and unrestricted access to every alias defined in LiteLLM
— including `cip-reasoning` (Mistral Large, ~$2/$6 per million tokens).
Three immediate problems:

1. **A trial tenant could rack up real money** by hitting expensive
   models in a runaway loop. No tier-based ceiling.
2. **Operators can't restrict tenants from premium aliases** — the only
   knob is the $100 budget cap, which is too coarse.
3. **The `tenants.tier` column is a façade.** It's set during provision
   (`--tier`) but doesn't translate into any actual policy. Compliance
   asks "what does enterprise tier give a customer?" — the answer is
   nothing today.

LiteLLM has team-level governance built in: `max_budget`, `rpm_limit`,
`tpm_limit`, and a `models` allowlist enforced *server-side* (the proxy
returns 403 before ever calling the provider). Slice 40 wires the
`--tier` flag to that team configuration, so each new tenant lands with
a tier-appropriate policy.

**No code changes** outside the provisioning script. Existing tenants
are untouched (the dev tenant has no tier — opted out by design as the
testbed).

---

## What You Are Building

```
scripts/
  provision-tenant.sh                         ← MOD: tier → team policy

infra/helm/litellm/
  values.yaml                                 ← unchanged (model_list already
                                                 has all 12 aliases)
slices/
  SLICE_40_LITELLM_TIER_GOVERNANCE.md         ← this doc
```

No new files. No app source changes. Pure ops.

---

## Read Before Writing

- `scripts/provision-tenant.sh` (existing flow — section "[6/6] LiteLLM virtual key")
- `infra/helm/litellm/values.yaml` (the 12 aliases this slice's tier policy references)
- `packages/hr-service/src/db/migrations/004_tenants.sql` (tenants.tier column source of truth)
- `packages/shared/src/types/tenant.ts` (TenantTierSchema enum)
- LiteLLM Team Management docs (`/team/new`, `/team/update`, `/team/info`)

Do **not** modify any application code (bot/hr-service/platform-core).
Tier policy lives entirely in LiteLLM team config + the provisioning
script.

---

## Hard Rules (Seven Non-Negotiables)

1. **`tenantId` IS the team_id.** No separate identifier — keeps the
   join from CIP tenants → LiteLLM teams trivial.
2. **Idempotent.** Re-running `provision-tenant.sh` for the same tenant
   updates the team's policy (POST `/team/update`) rather than failing
   with "already exists".
3. **The dev tenant is exempt.** It's seeded by `bootstrap.sh`, not
   `provision-tenant.sh`, and has no `tier` column value. Don't
   retrofit a tier on it; it's the testbed and policy enforcement
   would only get in the way.
4. **Tier → policy mapping lives in the script as a `case` statement.**
   No JSON config file, no DB table, no env vars. Three lines per tier.
   When we have >5 tiers or per-tenant overrides, *then* it can move.
5. **Every tier MUST permit `cip-classifier` + `cip-chat`.** These are
   the bot's baseline — without them the bot can't classify or route
   for this tenant at all.
6. **Failure to set the team policy is FATAL** for the provisioning
   run. Don't continue and issue a key under an unset team — that's
   the runaway-cost scenario this slice exists to prevent.
7. **Print the resolved policy in the summary.** The operator should
   see "Trial tier: $10/mo cap, 100 rpm, models=[cip-classifier, ...]"
   in the script output, not have to query LiteLLM after the fact.

---

## The tier policy

Three tiers, three lines each:

| Tier | `max_budget` ($/30d) | `rpm_limit` | Allowed models |
|---|---|---|---|
| `trial` | 10 | 60 | `cip-classifier`, `cip-chat`, `cip-router-fast`, `cip-lightweight`, `cip-document` |
| `standard` | 200 | 300 | trial + `cip-router-careful`, `cip-vision`, `cip-ocr-document-small`, `cip-ocr-image-small` |
| `enterprise` | 2000 | 1500 | standard + `cip-reasoning`, `cip-ocr-document`, `cip-ocr-image` |

Reasoning:

- **Trial** — enough to run the bot (`cip-classifier` for Stage 1,
  `cip-router-fast` for Stage 2, `cip-chat` as legacy fallback) plus
  text-only matchers (`cip-lightweight`, `cip-document`). No vision,
  no reasoning — those would let a trial tenant burn money on premium
  models. $10/month is a credible cap for sales demos / pilots.
- **Standard** — adds the full cert workflow: HR-admin tool selection
  (`cip-router-careful`), vision OCR (`cip-vision`), and the cheap
  variants of OCR (`*-small`). The dollar cap reflects "plausible
  enterprise customer with 50-200 employees doing routine cert
  uploads."
- **Enterprise** — premium tier, premium models. `cip-reasoning`
  (Mistral Large) for multi-step intents, full-quality OCR
  (`pixtral-large` via `cip-ocr-document`/`-image`). $2000/month is
  a soft cap — operators can revise per-tenant via LiteLLM admin UI.

Tier values are **starting points**, not contracts. Update by editing
the case statement and re-running provision against the affected
tenants. Future slice could move them to a config file if the catalog
grows past 5-6 tiers.

---

## Provisioning script changes

Insert a new step `[6a/7]` (renumber existing `[6/6]` → `[7/7]`)
between the per-tenant K8s secret block and the virtual-key issuance.
The step:

1. Locate LiteLLM service + port-forward (already done in [7/7], just
   move that block up so both [6a] and [7] share the connection).
2. Compute tier policy from `$TIER` via case statement.
3. POST `/team/new` with the policy. If 409 (team exists), POST
   `/team/update` with the same policy.
4. Verify by GET `/team/info?team_id=$TENANT_ID` — assert the team
   exists with the expected `max_budget`.
5. Step `[7/7]` (virtual key) updated to pass `team_id: $TENANT_ID`
   so the key inherits the team's policy. Drop the standalone
   `max_budget: 100` (now governed by the team).

### The case statement

```bash
# ── Tier policy ─────────────────────────────────────────────────────────────
case "$TIER" in
  trial)
    MAX_BUDGET=10
    RPM_LIMIT=60
    MODELS='["cip-classifier","cip-chat","cip-router-fast","cip-lightweight","cip-document"]'
    ;;
  standard)
    MAX_BUDGET=200
    RPM_LIMIT=300
    MODELS='["cip-classifier","cip-chat","cip-router-fast","cip-router-careful","cip-lightweight","cip-document","cip-vision","cip-ocr-document-small","cip-ocr-image-small"]'
    ;;
  enterprise)
    MAX_BUDGET=2000
    RPM_LIMIT=1500
    MODELS='["cip-classifier","cip-chat","cip-router-fast","cip-router-careful","cip-reasoning","cip-lightweight","cip-document","cip-vision","cip-ocr-document","cip-ocr-document-small","cip-ocr-image","cip-ocr-image-small"]'
    ;;
  *)
    echo "ERROR: unknown tier '$TIER'" >&2
    exit 1
    ;;
esac
```

### The team-create / team-update block

```bash
echo "[6a/7] Setting LiteLLM team policy for tier=$TIER..."

TEAM_PAYLOAD=$(jq -n \
  --arg id    "$TENANT_ID" \
  --arg name  "$NAME" \
  --arg dur   "30d" \
  --argjson budget "$MAX_BUDGET" \
  --argjson rpm    "$RPM_LIMIT" \
  --argjson models "$MODELS" \
  '{
    team_id:         $id,
    team_alias:      $name,
    max_budget:      $budget,
    budget_duration: $dur,
    rpm_limit:       $rpm,
    models:          $models,
    metadata:        { tier: "'"$TIER"'" }
  }')

# Try create first; on 409 (already exists), update instead.
NEW_RESP=$(curl -s -w "\n%{http_code}" -X POST http://localhost:14000/team/new \
  -H "Authorization: Bearer $_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "$TEAM_PAYLOAD")
NEW_STATUS=$(echo "$NEW_RESP" | tail -1)
case "$NEW_STATUS" in
  200|201) echo "      Team created." ;;
  400|409)
    # Already exists — update instead.
    UPD_RESP=$(curl -s -w "\n%{http_code}" -X POST http://localhost:14000/team/update \
      -H "Authorization: Bearer $_MASTER_KEY" \
      -H "Content-Type: application/json" \
      -d "$TEAM_PAYLOAD")
    UPD_STATUS=$(echo "$UPD_RESP" | tail -1)
    if [[ "$UPD_STATUS" =~ ^20[0-9]$ ]]; then
      echo "      Team policy updated."
    else
      echo "      ERROR: team update failed: HTTP $UPD_STATUS" >&2
      echo "      Response: $(echo "$UPD_RESP" | head -n -1 | head -c 200)" >&2
      exit 1
    fi
    ;;
  *)
    echo "      ERROR: team create failed: HTTP $NEW_STATUS" >&2
    echo "      Response: $(echo "$NEW_RESP" | head -n -1 | head -c 200)" >&2
    exit 1
    ;;
esac

# Verify via /team/info
INFO=$(curl -s -H "Authorization: Bearer $_MASTER_KEY" \
  "http://localhost:14000/team/info?team_id=$TENANT_ID")
ACTUAL_BUDGET=$(echo "$INFO" | jq -r '.team_info.max_budget // "?"')
[[ "$ACTUAL_BUDGET" == "$MAX_BUDGET" ]] || {
  echo "      WARNING: /team/info reports max_budget=$ACTUAL_BUDGET (expected $MAX_BUDGET)" >&2
}
echo "      Tier policy: budget=\$$MAX_BUDGET/30d, rpm=$RPM_LIMIT, models=$(echo "$MODELS" | jq -r 'length') aliases."
```

### The virtual-key issuance update

Existing block at line 337:

```bash
LL_RESP=$(curl -s -X POST http://localhost:14000/key/generate \
  -H "Authorization: Bearer $_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$TENANT_ID" '{
    key_alias: ("cip-tenant-"+$t),
    metadata: { tenantId: $t },
    max_budget: 100
  }')")
```

Becomes:

```bash
LL_RESP=$(curl -s -X POST http://localhost:14000/key/generate \
  -H "Authorization: Bearer $_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$TENANT_ID" '{
    key_alias: ("cip-tenant-"+$t),
    team_id:   $t,
    metadata:  { tenantId: $t }
  }')")
```

`max_budget: 100` removed — the team now governs the budget. The key
inherits the team's `max_budget`, `rpm_limit`, and `models` allowlist.

### Summary block update

Existing summary prints `Tier: $TIER`. Add the policy detail directly
below:

```
Tier:              $TIER
  max_budget:      \$$MAX_BUDGET / 30 days
  rpm_limit:       $RPM_LIMIT
  allowed models:  $(echo "$MODELS" | jq -r 'join(", ")')
```

Operator sees the policy in the same place they see the secrets.

---

## The dev tenant exemption

`bootstrap.sh` seeds the dev tenant with `tier=NULL` (no tier set).
This slice **does not** add a default. The dev tenant's existing
LiteLLM virtual key was issued without a `team_id`, so it has no team
policy — it can call any alias, no budget cap, no RPM limit. That's
intentional: dev is the testbed, ergo no governance.

If you ever want to test the trial/standard/enterprise policy in dev,
provision a NEW tenant with `provision-tenant.sh --tier trial …` and
test against that. Don't retrofit policy onto the dev tenant.

(Future cleanup slice could attach the dev tenant to a `dev-unlimited`
LiteLLM team for visibility in the admin UI, but it's not policy
enforcement, just bookkeeping.)

---

## Acceptance Criteria

- [ ] `bash scripts/provision-tenant.sh --name "TrialTest" --admin-email
      t@t.com --tier trial --tenant-id <new-uuid>` creates a LiteLLM
      team with `max_budget=10`, `rpm_limit=60`, and 5 allowed models.
      Verifiable via:
      ```
      curl -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
        http://litellm:4000/team/info?team_id=<new-uuid> | jq
      ```
- [ ] Re-running the same command updates the team (no "already
      exists" error). The summary prints "Team policy updated."
- [ ] Provisioning with `--tier enterprise` produces a team with
      `max_budget=2000`, `rpm_limit=1500`, 12 allowed models.
- [ ] The issued virtual key inherits the team's policy. Calling a
      disallowed model with that key returns HTTP 400 from LiteLLM
      with `error.message: "model X not in allowed list"`. Test:
      ```
      curl -H "Authorization: Bearer $TRIAL_KEY" \
        -d '{"model":"cip-reasoning","messages":[{"role":"user","content":"hi"}]}' \
        http://litellm:4000/v1/chat/completions
      ```
- [ ] Calling an allowed model with that key succeeds. Same curl
      with `"model":"cip-classifier"` returns 200.
- [ ] The dev tenant is unaffected — `kubectl get secret hr-service-credentials
      -n cip-app -o jsonpath='{.data.LITELLM_VIRTUAL_KEY}'` still works
      against any alias.
- [ ] An invalid `--tier` value rejects with `"--tier must be ..."`
      (existing behaviour preserved).
- [ ] Summary block shows the resolved policy:
      ```
      Tier:              trial
        max_budget:      $10 / 30 days
        rpm_limit:       60
        allowed models:  cip-classifier, cip-chat, cip-router-fast, cip-lightweight, cip-document
      ```
- [ ] `bash -n scripts/provision-tenant.sh` passes (no shell syntax errors).
- [ ] No app source change. `git diff --stat` should touch only
      `scripts/provision-tenant.sh` and `slices/SLICE_40_*.md`.

---

## Out of Scope

- **Per-tenant policy overrides via DB.** If a customer needs custom
  models or a higher cap than their tier, do it via LiteLLM admin UI
  (`/team/update`). No code change needed; the helper exists.
- **Migrating existing tenants** to tier-based teams. Only new
  provisions get the policy. Operators can run `provision-tenant.sh
  --tenant-id <existing-uuid> --tier <t> ...` to retrofit (idempotent).
- **Reading the policy at request time** in app code. Not needed —
  LiteLLM enforces it server-side. The app just sends `model: cip-X`
  and gets 200 or 400.
- **Per-call cost tracking dashboards.** Already in Langfuse via the
  existing `success_callback`. This slice doesn't add to that.
- **Removing `tenants.tier` from the DB.** Still useful as the source
  of truth for "what tier is this tenant on." Don't remove just because
  enforcement moved to LiteLLM.
- **Tier-aware routing rules.** Could imagine "trial tier routes
  `intent_classify` to the cheapest model regardless of `routing_rules`."
  Don't build that yet — the model allowlist already prevents disasters,
  and tier-aware routing adds complexity.

---

## Cross-Slice Notes

If LiteLLM team management requires `store_model_in_db: true` (which
Slice 39A enabled): confirmed, it does. Both team data and runtime
model definitions live in the same `cip_litellm` database. No
additional config needed.

If `provision-tenant.sh` runs against a fresh cluster where the dev
tenant exists but has no `team_id` on its virtual key: this slice
doesn't touch it. The dev tenant's key continues to work without team
governance.

---

## Commit

```
slice(40): LiteLLM tier governance via provision-tenant.sh

Wires the existing --tier flag (trial|standard|enterprise) to a
LiteLLM team policy: per-tier max_budget, rpm_limit, and model
access allowlist. New tenants get a team created (or updated, if
re-provisioned) with their tier's policy; the virtual key is issued
under that team and inherits the policy.

Trial:      $10/30d, 60 rpm, 5 models  (no vision, no reasoning)
Standard:   $200/30d, 300 rpm, 9 models (+ vision + small OCR)
Enterprise: $2000/30d, 1500 rpm, 12 models (+ reasoning + full OCR)

Dev tenant is exempt — it's seeded by bootstrap.sh and remains the
testbed with no team policy. No app source change.
```
