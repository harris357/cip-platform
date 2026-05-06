# Slice 71 — Temporal-ize provisioning Phase B (KC clients, K8s secret, AAD, admin role grant)

> **Why this exists:** Final slice of Arc 1. Closes out 57E by porting the rest of `provision-tenant.sh` into Temporal activities. After this slice, `provision-tenant.sh` deletes entirely; `POST /tenants` does the entire provisioning flow end-to-end.
>
> **Phase B activities:**
> - `createKeycloakClients` — confidential clients (teams-bot + hr-service) in the new realm; captures secrets
> - `createK8sSecret` — `tenant-aad-<tenantId>` K8s secret with the captured KC client secret. Uses the platform-core pod's ServiceAccount token (mounted at `/var/run/secrets/kubernetes.io/serviceaccount/`) to POST to the K8s API directly — no @kubernetes/client-node dep needed.
> - `createAadIdpFederation` — conditional. KC IDP instance + OIDC mapper for AAD tenants.
> - `grantKcAdminRealmRole` — KC realm role grant for the admin user (the half of bash 7a that slice 70 deferred).
> - Workflow chain extended; `provision-tenant.sh` deleted.

---

## Files in scope

```
packages/platform-core/src/activities/keycloak-admin-token.helper.ts        NEW (~40 LOC — fetch admin-cli token)
packages/platform-core/src/activities/k8s-api.helper.ts                     NEW (~60 LOC — fetch wrapper using ServiceAccount token)
packages/platform-core/src/activities/create-keycloak-clients.activity.ts   NEW (~120 LOC)
packages/platform-core/src/activities/create-k8s-secret.activity.ts         NEW (~80 LOC)
packages/platform-core/src/activities/create-aad-idp-federation.activity.ts NEW (~150 LOC)
packages/platform-core/src/activities/grant-kc-admin-realm-role.activity.ts NEW (~80 LOC)
packages/platform-core/src/activities/index.ts                              MOD (export new activities)
packages/platform-core/src/workflows/tenant-provisioning.workflow.ts        MOD (chain new activities; updateTenantIdpSecretRef wired in)
packages/platform-core/helm/templates/serviceaccount.yaml                   NEW (~30 LOC — sa + role + binding for secrets:create)
packages/platform-core/helm/templates/deployment.yaml                       MOD (serviceAccountName)
packages/platform-core/helm/values.yaml                                     MOD (serviceAccount.create=true)

scripts/provision-tenant.sh                                                  DELETE
```

---

## Hard rules

1. **All activities idempotent.** KC: GET-before-POST exists check. K8s: PATCH-or-create.
2. **K8s API via ServiceAccount token + REST.** No new dep. Mounted at `/var/run/secrets/kubernetes.io/serviceaccount/{token,ca.crt,namespace}`.
3. **AAD federation conditional** on `aadTenantId` input. Workflow skips if not provided.
4. **Compensating actions**: KC client creation idempotent (skip if exists). K8s secret PATCH-or-create. AAD federation skipped on missing `BOT_APP_ID`/`BOT_APP_PASSWORD` env (logs warning; proceeds — can be backfilled).
5. **provision-tenant.sh deleted entirely**.

---

## Skeleton implementation notes

`createK8sSecret` reads:
- `/var/run/secrets/kubernetes.io/serviceaccount/token` → bearer token
- `/var/run/secrets/kubernetes.io/serviceaccount/namespace` → target namespace
- `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` → for TLS verify (optional in cluster-internal calls)
- POST to `https://kubernetes.default.svc/api/v1/namespaces/${ns}/secrets`
- Body: `{ apiVersion: v1, kind: Secret, metadata: { name }, data: { ... } }` (data values base64-encoded)
- 409 on conflict: PATCH to update instead

`createAadIdpFederation` mirrors bash section 6:
- POST `/admin/realms/{realm}/identity-provider/instances` with the AAD OIDC config
- POST oid-mapper (maps `oid` claim → user attribute)

Workflow chain (final shape):
```
createKeycloakRealm
  → createTemporalNamespace
  → createNatsStreams
  → createObjectStoreBuckets
  → initTenantDatabase
  → createKeycloakClients               (NEW)
  → createK8sSecret                     (NEW)
  → updateTenantIdpSecretRef            (slice 70, now wired)
  → if aadTenantId: createAadIdpFederation (NEW, conditional)
  → issueLiteLLMVirtualKey
  → persistLiteLLMVirtualKey
  → elevateAdminUser                    (slice 70)
  → grantKcAdminRealmRole               (NEW)
  → provisionCompleteNotify
```

---

## Locked decisions

1. **K8s API via ServiceAccount + fetch** (no @kubernetes/client-node dep).
2. **AAD federation conditional** in workflow.
3. **provision-tenant.sh deleted** at the end of this slice.
4. **ServiceAccount + Role + RoleBinding** added to platform-core Helm chart (creates with `secrets:create,patch,get` on cip-app namespace).
