# CIP Platform — Deployment Slice Prompts (22–30)

> Self-contained prompts for the deployment slices. Copy a single prompt block
> verbatim into Claude Code to run that slice. The MASTER prompt at the top
> chains slices 22–28 semi-autonomously; slices 29 and 30 are operational and
> require human-in-the-loop.

---

## MASTER — Semi-autonomous chain (Slices 22–28)

```
You are working on the CIP Platform TypeScript monorepo.

Session: DEPLOY MASTER — run code slices 22 through 28 in dependency order.

Slices 29 (First Deploy Runbook) and 30 (Teams App Registration & Sideload)
are NOT in scope for this session — they require live cluster access and Azure
portal actions. Stop after Slice 28 and report status.

Read before starting:
- CLAUDE.md
- slices/CONTEXT_WORKFLOW.md
- slices/CROSS_SLICE_NOTES.md
- slices/PROMPTS_DEPLOY.md   (this file — for the per-slice prompts below)

Execution order (respect dependencies):
1. Slice 22 — Cleanup & Doc Reset
2. Slice 23 — HR Persistence Layer + Migration Runner
3. Slice 26 — Channel Registry on NATS KV   (independent of 23/24/25 — can run after 22)
4. Slice 24 — Cert Vertical Activities      (depends on 23)
5. Slice 25 — Employee Onboarding Activities (depends on 23)
6. Slice 27 — Platform-Core Tenant Provisioning + Wiring Reconciliation (depends on 23)
7. Slice 28 — CI/CD & Image Pipeline (depends on all of the above)

For each slice, in order:
1. Read the slice's prompt block in slices/PROMPTS_DEPLOY.md (sections "## Slice NN — ...")
2. Execute it exactly — obey its "Read before writing" and "Files to modify" lists
3. Run the slice's verify step (typecheck on affected package, then `pnpm -r run typecheck`)
4. If typecheck fails on the slice's package: STOP and surface the failure
5. If typecheck fails on a different package: log a cross-slice note in
   slices/CROSS_SLICE_NOTES.md (do not fix it inline) and continue
6. If new OPEN cross-slice notes were logged in this slice: run the
   PROMPT CROSS-SLICE flow from slices/PROMPTS_ALL.md before the next slice
7. Make a commit with message format: `slice(NN): <one-line summary>`
8. Move to the next slice

Hard stops (surface to user, do not proceed):
- Any of the Seven Non-Negotiables (CLAUDE.md) would be violated
- A slice requires an architectural decision not already recorded
- A slice requires live infra (Postgres, NATS, Temporal, OVH, Azure, Keycloak)
  that is not reachable from this session — record what would have run and stop
- Typecheck fails on the package the slice owns

After all 7 slices complete:
- Run `pnpm -r run typecheck` (must pass)
- Update slices/CONTEXT_WORKFLOW.md slice map: mark 22–28 complete
- Print a summary: which slices ran, which commits were made, any open cross-slice notes
- Note that Slices 29 and 30 are pending and require operator action

Do NOT skip slices. Do NOT reorder. Do NOT batch unrelated fixes into one commit.
```

---

## Slice 22 — Cleanup & Doc Reset

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 22 — Cleanup & Doc Reset
Package: cross-package (deletions + docs only — no logic changes)
Verify: pnpm -r run typecheck

Goal: Remove legacy duplicate code left behind by the modules/* refactor and
refresh stale docs so future readers see post-Slice 21 state.

Read before writing:
- packages/hr-service/src/index.ts
- packages/hr-service/src/workers/temporal-worker.ts
- packages/hr-service/src/workflows/index.ts
- packages/hr-service/src/mcp-server/index.ts
- docs/slice-workflow-status.md
- docs/proposed-implementation-review.md

Files to delete (verify nothing under modules/ imports from these paths first):
- packages/hr-service/src/activities/                  (entire directory)
- packages/hr-service/src/agents/                      (entire directory — module copy is live)
- packages/hr-service/src/mcp-server/tools/            (entire directory — replaced by modules/*/mcp-tools/)
- packages/hr-service/src/workflows/worker-onboarding.workflow.ts

Files to modify:
- packages/hr-service/src/workflows/index.ts           (remove WorkerOnboardingWorkflow export)
- docs/slice-workflow-status.md                        (rewrite to reflect post-21 state OR mark historical)
- docs/proposed-implementation-review.md               (rewrite OR mark historical)

Acceptance:
- No imports anywhere reference deleted paths
- pnpm -r run typecheck passes
- The two docs either describe the current state correctly or carry a clear
  "Historical — describes Slice 08 era; superseded by slices/archive/" notice
  at the top

If a deletion would break an import, STOP and log a cross-slice note rather than
patching speculatively.
```

---

## Slice 23 — HR Persistence Layer + Migration Runner

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 23 — HR Persistence Layer + Migration Runner
Package: @cip/hr-service
Verify: pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Goal: Make all HR DB writes work end-to-end with RLS, and add a migration runner
wired into `make bootstrap`.

Read before writing:
- packages/hr-service/src/db/queries/workers.ts
- packages/hr-service/src/db/queries/certifications.ts
- packages/hr-service/src/db/migrations/001_initial.sql
- packages/hr-service/src/db/rls.ts
- packages/hr-service/src/db/index.ts
- packages/shared/src/types/worker.ts
- packages/shared/src/types/certification.ts
- packages/shared/src/clients/postgres.ts
- Makefile
- scripts/bootstrap.sh

Files to modify:
- packages/hr-service/src/db/queries/workers.ts          (implement upsertWorker)
- packages/hr-service/src/db/queries/certifications.ts   (implement upsertCertification, findExpiredCertifications)

Files to create:
- packages/hr-service/src/db/migrate.ts                  (migration runner — applies any 00N_*.sql in order, idempotent, tracks applied migrations in a `schema_migrations` table)
- packages/hr-service/src/db/migrations/002_schema_migrations.sql  (creates the tracking table)

Files to update:
- packages/hr-service/package.json                       (add a `migrate` script: tsx src/db/migrate.ts)
- scripts/bootstrap.sh                                   (call `pnpm --filter @cip/hr-service run migrate`)

Hard rules:
- All queries take PoolClient (not Pool) — caller wraps in withTenantRLS
- upsertWorker / upsertCertification must use ON CONFLICT … DO UPDATE keyed on
  (tenant_id, id) so the call is idempotent
- The migration runner must set `app.current_tenant_id` only if a migration
  needs it; structural migrations should run as superuser without tenant context
- Stubs are not acceptable — every function must have a working body

Acceptance:
- pnpm --filter @cip/hr-service typecheck passes
- pnpm -r run typecheck passes
- `pnpm --filter @cip/hr-service run migrate` works against a Postgres URL in
  DATABASE_URL_HR (verify by reading the script — do not require live DB)
- scripts/bootstrap.sh invokes the migrate script

Commit: slice(23): hr persistence + migration runner
```

---

## Slice 24 — Cert Vertical Activities

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 24 — Cert Vertical Activities
Package: @cip/hr-service
Verify: pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Goal: Make CertificationProcessingWorkflow run end-to-end against real infra by
implementing the five remaining stub activities.

Read before writing:
- packages/hr-service/src/modules/certifications/workflows/certification-processing.workflow.ts
- packages/hr-service/src/modules/certifications/activities/index.ts
- packages/hr-service/src/modules/certifications/activities/fetch-document.activity.ts
- packages/hr-service/src/modules/certifications/activities/pre-classify-cert.activity.ts
- packages/hr-service/src/modules/certifications/activities/persist-cert.activity.ts
- packages/hr-service/src/modules/certifications/activities/notify-hitl.activity.ts
- packages/hr-service/src/modules/certifications/activities/publish-cert-processed.activity.ts
- packages/hr-service/src/db/queries/certifications.ts                       (Slice 23 output)
- packages/hr-service/src/db/registries.ts
- packages/shared/src/utils/zod-schemas.ts
- packages/shared/src/utils/subject-builder.ts
- packages/shared/src/clients/nats.ts
- packages/hr-service/helm/values.yaml

Files to modify (no new files):
- packages/hr-service/src/modules/certifications/activities/fetch-document.activity.ts
- packages/hr-service/src/modules/certifications/activities/pre-classify-cert.activity.ts
- packages/hr-service/src/modules/certifications/activities/persist-cert.activity.ts
- packages/hr-service/src/modules/certifications/activities/notify-hitl.activity.ts
- packages/hr-service/src/modules/certifications/activities/publish-cert-processed.activity.ts

Implementation requirements:
- fetch-document: download from OVH Object Store (S3 SDK, forcePathStyle=true,
  AWS_ENDPOINT_URL/AWS_REGION/OBJECT_STORE_BUCKET from env), return base64
- pre-classify: deterministic Tier-1 classifier (no LLM) — read filename hints
  and document bytes header to return a certTypeHint string from the registry
- persist-cert: withTenantRLS → upsertCertification (Slice 23) → return certificationId
- notify-hitl: POST to ${TEAMS_BOT_URL}/proactive with body { tenantId, channelType, card }
- publish-cert-processed: getNatsConnection() → publish on Subjects.certValidated(tenantId)
  with a CertificationValidatedEvent payload (Zod-validated before publish)

Hard rules (Seven Non-Negotiables):
- Every Activity result that is domain data must be Zod .parse()'d before return
- Subjects only via Subjects.* / buildSubject()
- tenantId is always present and required
- No @anthropic-ai/sdk imports

Acceptance:
- pnpm --filter @cip/hr-service typecheck passes
- pnpm -r run typecheck passes
- No `throw new Error('not implemented')` remains in modules/certifications/activities/
- Helm values.yaml exposes any new env vars the activities need

Commit: slice(24): cert vertical activities
```

---

## Slice 25 — Employee Onboarding Activities

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 25 — Employee Onboarding Activities
Package: @cip/hr-service
Verify: pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Goal: EmployeeOnboardingWorkflow runs end-to-end — Keycloak user created, role
assigned, welcome notification sent.

Read before writing:
- packages/hr-service/src/modules/employees/workflows/employee-onboarding.workflow.ts
- packages/hr-service/src/modules/employees/activities/index.ts
- packages/hr-service/src/modules/employees/activities/create-keycloak-user.activity.ts
- packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts
- packages/hr-service/src/modules/employees/activities/send-welcome-notification.activity.ts
- packages/hr-service/src/modules/employees/activities/publish-employee-onboarded.activity.ts
- packages/hr-service/src/db/index.ts
- packages/shared/src/types/employee.ts
- packages/shared/src/types/role.ts
- packages/hr-service/helm/values.yaml

Files to modify (no new files):
- create-keycloak-user.activity.ts
- assign-default-role.activity.ts
- send-welcome-notification.activity.ts

Implementation requirements:
- create-keycloak-user:
  - aad_federated path: POST to ${KEYCLOAK_URL}/admin/realms/${realm}/users
    with federatedIdentities=[{identityProvider:'aad', userId:aadOid, userName:email}],
    enabled=true, no credentials. Use a service-account access token.
  - field_employee path: POST same endpoint with credentials=[] (OTP-only),
    requiredActions=['CONFIGURE_TOTP','UPDATE_PASSWORD'].
  - Return the Keycloak user ID from the Location header.
- assign-default-role:
  - Look up role by keycloak_role code in employee_roles table for the tenant
  - Insert into employee_roles join table
  - Default role: 'field_operations' (aad) | 'field_employee' (otp)
- send-welcome-notification:
  - Publish a NATS event Subjects.workerOnboarded(tenantId) — or POST to
    teams-bot proactive endpoint if a channel exists. Pick one and document.

Hard rules:
- Activity outputs must be Zod-validated before return
- tenantId is required on every input
- No direct Anthropic SDK imports

Acceptance:
- typecheck (package + monorepo) passes
- No `throw new Error('not implemented')` in modules/employees/activities/
- Helm values.yaml exposes any new env vars

Commit: slice(25): employee onboarding activities
```

---

## Slice 26 — Channel Registry on NATS KV (resolves CS-018)

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 26 — Channel Registry on NATS KV
Package: @cip/teams-bot (and a bootstrap step in scripts/bootstrap.sh)
Verify: pnpm --filter @cip/teams-bot typecheck && pnpm -r run typecheck

Goal: Replace the in-memory channel registry with a NATS JetStream KV bucket so
proactive HITL messages survive pod restarts. Resolves CS-018.

Decision recorded: backend = NATS JetStream KV. Bucket name: `teams-channel-registry`.
TTL: 24h (matches existing in-memory TTL).

Read before writing:
- packages/teams-bot/src/teams-protocol/channel-registry.ts
- packages/teams-bot/src/bot.ts                              (callers of the registry)
- packages/teams-bot/src/server.ts                           (proactive endpoint)
- packages/shared/src/clients/nats.ts
- packages/teams-bot/helm/values.yaml
- scripts/bootstrap.sh
- slices/CROSS_SLICE_NOTES.md

Files to modify:
- packages/teams-bot/src/teams-protocol/channel-registry.ts  (replace Map with KV)
- packages/teams-bot/helm/values.yaml                        (add CHANNEL_REGISTRY_BUCKET env)
- scripts/bootstrap.sh                                       (create the KV bucket if absent)
- slices/CROSS_SLICE_NOTES.md                                (mark CS-018 RESOLVED with today's date)

Implementation requirements:
- Use nats jetstream KV API: `js.views.kv(bucket, { history: 1, ttl: 24*60*60*1000 })`
- Key format: `${tenantId}.${employeeId}.${channelType}`
- Value: JSON-encoded ConversationReference
- get / put / delete API surface stays identical so callers don't change
- Lazy-connect on first call; reuse the shared NATS connection from
  @cip/shared/clients/nats.ts
- Bootstrap step: `nats kv add teams-channel-registry --ttl=24h` (idempotent)

Hard rules:
- No direct Anthropic SDK imports
- tenantId must be part of every key
- typecheck must remain green

Acceptance:
- typecheck (package + monorepo) passes
- CS-018 marked RESOLVED in CROSS_SLICE_NOTES.md
- helm values.yaml exposes CHANNEL_REGISTRY_BUCKET (default: teams-channel-registry)
- bootstrap.sh creates the bucket idempotently

Commit: slice(26): channel registry on NATS KV — resolves CS-018
```

---

## Slice 27 — Platform-Core Tenant Provisioning + Wiring Reconciliation

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 27 — Platform-Core Tenant Provisioning + Wiring Reconciliation
Package: @cip/platform-core (+ small touches to @cip/hr-service helm/env, NATS watcher)
Verify: pnpm --filter @cip/platform-core typecheck && pnpm -r run typecheck

Goal: TenantProvisioningWorkflow actually provisions a tenant. Reconcile two
known wiring inconsistencies in the same slice.

Read before writing:
- packages/platform-core/src/workflows/tenant-provisioning.workflow.ts
- packages/platform-core/src/activities/index.ts
- packages/platform-core/src/activities/*.activity.ts          (all 7)
- packages/hr-service/src/nats/watcher.ts
- packages/hr-service/src/workers/temporal-worker.ts
- packages/hr-service/helm/values.yaml
- packages/teams-bot/helm/values.yaml
- infra/k8s/litellm-config.yaml
- packages/shared/src/types/tenant.ts

Files to modify:
- packages/platform-core/src/activities/create-keycloak-realm.activity.ts
- packages/platform-core/src/activities/create-temporal-namespace.activity.ts
- packages/platform-core/src/activities/create-nats-streams.activity.ts
- packages/platform-core/src/activities/create-object-store-buckets.activity.ts
- packages/platform-core/src/activities/init-tenant-database.activity.ts
- packages/platform-core/src/activities/issue-litellm-virtual-key.activity.ts
- packages/platform-core/src/activities/provision-complete-notify.activity.ts
- packages/hr-service/src/nats/watcher.ts                      (reconcile namespace usage)
- packages/hr-service/src/workers/temporal-worker.ts           (read namespace from tenant config OR document single-namespace dev pattern)

Implementation requirements:
- create-keycloak-realm: POST /admin/realms (realm name = tenantId), create
  admin user with adminEmail
- create-temporal-namespace: tctl/REST call against Temporal admin to register
  namespace named `${tenantId}.cip` (matches watcher convention)
- create-nats-streams: js.streams.add() — one stream per domain
  (`cip-${tenantId}-hr`, `cip-${tenantId}-ops`, `cip-${tenantId}-platform`,
  `cip-${tenantId}-agents`) subject = `cip.${tenantId}.<domain>.>`
- create-object-store-buckets: S3 createBucket for `cip-${tenantId}-uploads`
- init-tenant-database: connect with admin creds, CREATE SCHEMA IF NOT EXISTS,
  then call the Slice 23 migration runner against this tenant's schema
- issue-litellm-virtual-key: POST to LiteLLM admin /key/generate with
  max_budget=budgetLimitUsd, budget_duration='30d', metadata={tenantId, tier}
- provision-complete-notify: publish Subjects.tenantProvisioned(tenantId)

Reconciliation requirements:
- Temporal namespace: hr-service worker reads namespace from a tenant-config
  source (env for dev, future tenant-config provider for prod). Watcher's
  `${tenantId}.cip` form must match what create-temporal-namespace creates.
- Keycloak realm: helm values for hr-service / teams-bot use
  `${KEYCLOAK_REALM}` interpolation; for dev, KEYCLOAK_REALM stays `cip-dev`
  but the comment explains that prod realm = tenantId. Document explicitly.

Hard rules:
- Every activity output Zod-validated
- Workflow ID pattern enforced
- Idempotency: every activity safe to retry from any step

Acceptance:
- typecheck (package + monorepo) passes
- No `throw new Error('not implemented')` in platform-core/src/activities/
- Watcher namespace string matches create-temporal-namespace output
- Helm values document realm-naming intent

Commit: slice(27): platform-core tenant provisioning + wiring reconciliation
```

---

## Slice 28 — CI/CD & Image Pipeline

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 28 — CI/CD & Image Pipeline
Package: cross-package (CI config + helm values)
Verify: pnpm -r run typecheck

Goal: Automate image build & push to GHCR with commit-SHA tags so deploys are
reproducible. Replace `image.tag: dev` in helm.

Read before writing:
- packages/hr-service/Dockerfile
- packages/platform-core/Dockerfile
- packages/teams-bot/Dockerfile
- packages/hr-service/helm/values.yaml
- packages/platform-core/helm/values.yaml
- packages/teams-bot/helm/values.yaml
- Makefile

Files to create:
- .github/workflows/build-and-push.yaml
  Triggers: push to master + PRs
  Jobs: matrix over [hr-service, platform-core, teams-bot]
  Each job: docker build with --tag ghcr.io/idlevice/<svc>:${{ github.sha }}
  Push only on master push (not on PR)
  Also tag :latest on master

Files to modify:
- packages/hr-service/helm/values.yaml          (image.tag: "" — set per-deploy via helm --set)
- packages/platform-core/helm/values.yaml       (same)
- packages/teams-bot/helm/values.yaml           (same)
- Makefile                                      (update `deploy` target to take TAG=<sha>; default to git rev-parse HEAD)

Files to update:
- README or docs/: add a short "Image promotion" section explaining the tag
  flow (PR builds → master builds → manual `make deploy svc=X TAG=<sha>`)

Acceptance:
- pnpm -r run typecheck passes (no code changes — sanity)
- .github/workflows/build-and-push.yaml lints cleanly (verify with
  `gh workflow view` or YAML lint)
- Makefile `deploy` target requires/uses TAG variable
- Helm values no longer pin `:dev`

Commit: slice(28): ci/cd image pipeline
```

---

## Slice 29 — First Deploy Runbook (OPERATIONAL — human-in-the-loop)

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 29 — First Deploy Runbook
Mode: OPERATIONAL — runs against a live OVH cluster. Requires .envrc populated
with all OVH/AWS/Cloudflare/Keycloak/Temporal/Langfuse credentials. Do not run
this slice unless the operator has confirmed the target environment.

Read before running:
- scripts/verify-readiness.sh
- scripts/bootstrap-infra.sh
- scripts/create-secrets.sh
- scripts/bootstrap.sh
- scripts/smoke-test.sh
- scripts/cycle-test.sh
- Makefile

Execution sequence (stop and surface to operator on any failure):

1. source .envrc
2. bash scripts/verify-readiness.sh
   Expected: every check ✅; if any ❌, STOP and report.
3. make create-secrets
   Verify: kubectl get secret -n cip-app shows hr-service-credentials,
   platform-core-credentials, teams-bot-credentials. cip-infra has
   litellm-credentials.
4. make bootstrap-infra
   Provisions: OVH cluster, node pool, PVCs, DNS, Terraform state bucket,
   infra Helm charts (postgres, nats, keycloak, litellm, langfuse, monitoring,
   ingress-nginx).
   Verify: kubectl get pvc -A shows all 5 PVCs Bound.

5. make configure-dns && make configure-tls
   Verify: cert-manager ClusterIssuer ready; DNS A records resolve to LB IP.

6. make bootstrap
   Runs: NATS streams, Keycloak realm, hr-service migrations,
   LiteLLM virtual key creation, NATS KV bucket creation (Slice 26 step).
   Verify: each step prints success.

7. make start
   Verify: kubectl get pods -A — every cip-app pod Running and Ready.

8. make smoke-test
   Expected: all checks ✅.

9. make cycle-test
   Expected: full start → smoke → stop succeeds.

Output:
- Append a runbook entry to docs/deployment-runbook.md capturing:
  - Date of run
  - Any deviation from the sequence above
  - Final list of secret keys per service (names only, not values)
  - Known follow-ups

Hard stops:
- Any non-zero exit on a script — STOP, capture stderr, report
- Pods not Ready after 5 minutes — STOP, kubectl describe + kubectl logs the failing pod

Do NOT proceed to Slice 30 until this slice is fully green.
Commit: slice(29): first deploy runbook + docs/deployment-runbook.md
```

---

## Slice 30 — Teams App Registration & Sideload (OPERATIONAL — human-in-the-loop)

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 30 — Teams App Registration & Sideload
Mode: OPERATIONAL — requires Azure portal access (Bot Services + AD App
Registrations) and Keycloak admin access. Slice 29 must be complete and
the bot service must be reachable at its ingress host.

Authoritative reference: packages/teams-bot/teams-app/BUILD.md

Read before running:
- packages/teams-bot/teams-app/BUILD.md
- packages/teams-bot/teams-app/appPackage/manifest.json
- packages/teams-bot/teams-app/teamsapp.yml
- packages/teams-bot/teams-app/env/.env.local             (or equivalent)
- packages/teams-bot/helm/values.yaml

Execution sequence (operator performs each step; assistant tracks state):

Part 1 — Azure Bot Registration
- Create Azure Bot resource named `cip-bot-dev` (single-tenant)
- Capture App ID → BOT_APP_ID
- Capture Client Secret → BOT_APP_PASSWORD
- Set Messaging endpoint: https://bot.cip.idlevice.ca/api/messages
- Enable Microsoft Teams channel

Part 2 — Azure AD App Manifest (SSO)
- Application ID URI: api://bot.cip.idlevice.ca/<BOT_APP_ID>
- Add scope: access_as_user (Admins + Users consent)
- Add Authorized client applications:
  - 1fec8e78-bce4-4aaf-ab1b-5451cc387264 (Teams Desktop)
  - 5e3ce6c0-2b1f-4285-8d4b-75ee78787346 (Teams Mobile/Web)

Part 3 — Keycloak Token Exchange
- In Keycloak Admin → realm → Clients → teams-bot
- Enable Token Exchange grant type
- Configure AAD identity provider as a trusted token-exchange source
- Capture KEYCLOAK_CLIENT_SECRET

After Parts 1–3:
- Update teams-bot-credentials secret with BOT_APP_ID, BOT_APP_PASSWORD,
  KEYCLOAK_CLIENT_SECRET (re-run scripts/create-secrets.sh or kubectl patch)
- kubectl rollout restart deployment/teams-bot -n cip-app

Part 4 — Package and Sideload
- Fill BOT_APP_ID in packages/teams-bot/teams-app/env/.env.local
- cd packages/teams-bot/teams-app && teamsapp package --env local
- In Teams: Apps → Manage your apps → Upload custom app → choose
  appPackage/build/appPackage.local.zip
- Install personal scope first

Part 5 — End-to-end verification
1. Send a test message to the bot — verify SSO succeeds and bot replies
2. Upload a certification document — verify hr-service workflow starts
3. Force a low-confidence extraction — verify HITL card lands as a proactive
   message in Teams
4. kubectl rollout restart deployment/teams-bot -n cip-app
5. Re-trigger the HITL flow — verify the channel registry survived restart
   (validates Slice 26)

Output:
- Tick the BUILD.md checklist
- Append to docs/deployment-runbook.md: completion date + any deviations
- Document the production cutover plan if applicable

Hard stops:
- Any of Parts 1–3 fail authentication — STOP, capture error, report
- Bot SSO returns no token — STOP, check KEYCLOAK_CLIENT_SECRET and AAD scope
- Proactive message returns 404 — STOP, channel registry KV bucket is empty
  (validates a real bug, not slice 26 success)

Commit: slice(30): teams app registration + sideload runbook complete
```

---

## How to use this file

- **Run a single slice**: copy that slice's prompt block (between the triple backticks) into a fresh Claude Code session.
- **Run slices 22–28 semi-autonomously**: copy the MASTER prompt at the top into a fresh session. The master orchestrates the chain, runs typecheck after each slice, commits per slice, and stops cleanly before the operational slices.
- **Run slices 29–30**: do not automate. These need a human operator with cluster + Azure access. Open a fresh session per slice and walk through with the prompt.
- **Cross-slice notes** logged during any slice are resolved via `PROMPT CROSS-SLICE` in `slices/PROMPTS_ALL.md` between slices.
