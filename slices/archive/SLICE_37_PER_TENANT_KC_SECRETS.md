# Slice 37 — Per-Tenant KC Client Secrets via K8s Secrets + Bot Dynamic Loading

> **Prerequisite:** Slices 35 (tenants tables) and 36 (multi-tenant bot) complete.
> **Package:** `@cip/teams-bot` (and `scripts/provision-tenant.sh`)
> **Verify:** `pnpm --filter @cip/teams-bot typecheck && pnpm -r run typecheck`

---

## Why This Slice Exists

Slice 36 introduced multi-tenant bot routing but pushed per-tenant Keycloak
client secrets into a single env-var JSON map (`KEYCLOAK_CLIENT_SECRETS`).
That has three problems for production:

1. **Operator burden.** Adding a tenant means hand-editing a JSON map inside
   the `teams-bot-credentials` K8s secret. Easy to typo, hard to audit.
2. **Bot restart on every change.** Env vars are read at process startup;
   adding a tenant requires bouncing the bot pod.
3. **Coupling of credential lifecycle and code lifecycle.** Rotating one
   tenant's KC client secret means re-deploying. They should be independent.

The clean shape: `tenant_identity_providers.secret_ref` (already in the
schema, currently nullable + unused) names a per-tenant K8s secret. The bot
fetches it via the K8s API on cache miss, caches it for the same 5-minute
TTL as the rest of the tenant context. Provisioning creates the K8s secret;
rotation updates it; both are visible immediately to running bot pods.

This slice formalises that pattern. The legacy `KEYCLOAK_CLIENT_SECRETS`
JSON map and the `KEYCLOAK_CLIENT_SECRET` single-value env stay as
**dev-only fallbacks** so single-realm dev keeps working.

---

## What You Are Building

```
packages/teams-bot/src/
  auth/
    keycloak-secrets.ts          ← MODIFY: load order = K8s secret → JSON map → fallback env
    k8s-secret-loader.ts         ← NEW: read a specific K8s secret/key by name (cached 5m)
  helm/
    templates/
      service-account.yaml       ← NEW: SA + Role + RoleBinding granting secrets/get on cip-app
                                          (scoped to specific name pattern, NOT all secrets)
    values.yaml                  ← MODIFY: enable the SA, document RBAC

scripts/
  provision-tenant.sh            ← MODIFY: instead of (or in addition to) printing the
                                            client secrets, create a K8s secret named
                                            tenant-aad-<tenantId> containing them, and
                                            UPDATE tenant_identity_providers.secret_ref
                                            to that name.
```

No DB migration. The `tenant_identity_providers.secret_ref` column already
exists (Slice 35) — this slice finally makes it load-bearing.

---

## Read Before Writing

- `packages/teams-bot/src/auth/keycloak-secrets.ts` (current loader)
- `packages/teams-bot/src/auth/tenant-resolver.ts` (how secrets are consumed)
- `packages/teams-bot/helm/templates/deployment.yaml` (where to add SA reference)
- `packages/teams-bot/helm/values.yaml` (env vars — KEYCLOAK_CLIENT_SECRETS today)
- `scripts/provision-tenant.sh` (where the per-tenant secret is created)
- `slices/SLICE_36_MULTI_TENANT_BOT.md` § "Per-realm secrets" (the surface
  this slice replaces)
- `docs/identity-and-auth-architecture.md` § "Configuration reference" (to
  update once this lands)

Do **not** read or modify hr-service. The lookup endpoint already returns
`secret_ref`; bot just starts using it.

---

## Hard Rules (Seven Non-Negotiables)

- `tenantId` flows through unchanged — the secret_ref → K8s secret → KC
  client secret resolution is per-tenant and uses the same TenantContext.
- The K8s secret naming convention is `tenant-aad-<cipTenantId>` (lowercase
  UUID). Document this; provision-tenant.sh enforces it.
- Bot ServiceAccount RBAC must be **scoped to specific resource names**
  (resourceNames in the Role) — NOT cluster-wide secret read access.
- 5-minute in-memory cache TTL on K8s secret reads (matches tenant cache).
- Errors are typed (extend ResolveError enum from Slice 36) so logs say
  `[security] secret_ref_missing`, `[security] k8s_secret_not_found`, etc.
- No `@anthropic-ai/sdk` imports.
- Stubs forbidden — every function ships with a working body.

---

## Resolver flow after this slice

```
resolveTenantContext(aadTenantId):
  ...everything from Slice 36 up to tenant lookup...
  →  data.provider.secretRef  (string, K8s secret name) OR null
  
  IF secretRef is set:
    kcClientSecret = await readK8sSecret(secretRef, 'KEYCLOAK_CLIENT_SECRET')
    IF readK8sSecret throws → return { error: 'k8s_secret_not_found' }
  ELSE:
    kcClientSecret = lookupKcSecret(realm)   // existing fallback path
    IF null → return { error: 'missing_kc_client_secret' }

  ...build TenantContext...
```

Both paths work; production tenants use the secret_ref path; dev tenants
left without secret_ref keep using the env-var fallback. No breaking change
to dev workflow.

---

## `auth/k8s-secret-loader.ts` (NEW)

Use the `@kubernetes/client-node` package (Node-native K8s client). Add as
a dep in `packages/teams-bot/package.json`. The bot already runs with a
ServiceAccount; the loader uses in-cluster config.

```typescript
import * as k8s from '@kubernetes/client-node';

interface CachedSecret {
  data: Record<string, string>;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedSecret>();

let _api: k8s.CoreV1Api | undefined;
function getApi(): k8s.CoreV1Api {
  if (_api) return _api;
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();   // uses pod's mounted ServiceAccount token
  _api = kc.makeApiClient(k8s.CoreV1Api);
  return _api;
}

export async function readK8sSecretValue(
  secretName: string,
  key: string,
  namespace: string = process.env['POD_NAMESPACE'] ?? 'cip-app',
): Promise<string | null> {
  const cacheKey = `${namespace}/${secretName}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data[key] ?? null;
  }
  try {
    const resp = await getApi().readNamespacedSecret(secretName, namespace);
    const data = resp.body.data ?? {};
    const decoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      decoded[k] = Buffer.from(v as string, 'base64').toString('utf8');
    }
    cache.set(cacheKey, { data: decoded, expiresAt: Date.now() + TTL_MS });
    return decoded[key] ?? null;
  } catch (err) {
    // 404 = secret doesn't exist; surface as null so caller can return
    // a typed error. Other errors propagate.
    const status = (err as { response?: { statusCode?: number } }).response?.statusCode;
    if (status === 404) return null;
    throw err;
  }
}

export function _resetK8sSecretCache(): void { cache.clear(); }
```

Add `POD_NAMESPACE` to `helm/values.yaml` env via the downward API:

```yaml
env:
  POD_NAMESPACE:
    valueFrom:
      fieldRef:
        fieldPath: metadata.namespace
```

---

## `auth/keycloak-secrets.ts` (MODIFY)

Add a function that resolves the secret in the new priority order, used
from `tenant-resolver.ts`:

```typescript
import { readK8sSecretValue } from './k8s-secret-loader.js';

export async function resolveKcClientSecret(
  realm: string,
  secretRef: string | null,
): Promise<string | null> {
  // 1. Per-tenant K8s secret (production path)
  if (secretRef) {
    const v = await readK8sSecretValue(secretRef, 'KEYCLOAK_CLIENT_SECRET');
    if (v) return v;
  }
  // 2. KEYCLOAK_CLIENT_SECRETS JSON map env (legacy multi-tenant)
  // 3. KEYCLOAK_CLIENT_SECRET + KEYCLOAK_REALM_FALLBACK (dev single-realm)
  return lookupKcSecret(realm);   // existing function, unchanged
}
```

The existing synchronous `lookupKcSecret(realm)` is kept for the fallback
path (no I/O); the new `resolveKcClientSecret` is async and is what
`tenant-resolver.ts` calls.

---

## `auth/tenant-resolver.ts` (MODIFY)

```typescript
const realm = data.tenant.realm;
const kcClientSecret = await resolveKcClientSecret(realm, data.provider.secretRef);
if (!kcClientSecret) return { error: 'missing_kc_client_secret' };
```

Add to the `ResolveError` union: `'k8s_secret_not_found'`, `'k8s_secret_read_failed'`.

---

## ServiceAccount RBAC (helm template, NEW)

Resource-name-scoped — the bot can read ONLY secrets matching the
`tenant-aad-*` pattern, not arbitrary cluster secrets.

```yaml
{{- if .Values.serviceAccount.create -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Chart.Name }}
  namespace: {{ .Release.Namespace }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ .Chart.Name }}-secret-reader
  namespace: {{ .Release.Namespace }}
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
    # Note: K8s Role does NOT support glob in resourceNames. Two paths:
    # (a) leave resourceNames unset and rely on namespace-scoped Role
    #     (read any secret in cip-app — acceptable since the namespace is
    #     trusted application secrets only)
    # (b) maintain an explicit list and update on tenant onboarding.
    # Default: (a). Document the trade-off in helm comments.
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ .Chart.Name }}-secret-reader
  namespace: {{ .Release.Namespace }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ .Chart.Name }}-secret-reader
subjects:
  - kind: ServiceAccount
    name: {{ .Chart.Name }}
    namespace: {{ .Release.Namespace }}
{{- end -}}
```

And in `deployment.yaml`:
```yaml
spec:
  template:
    spec:
      serviceAccountName: {{ .Chart.Name }}
```

---

## `provision-tenant.sh` modifications

Replace the "print the secret to stdout, operator copy-paste" flow with:

1. After the KC client is created and its secret retrieved, create a K8s
   secret named `tenant-aad-${TENANT_ID}` in `cip-app` with key
   `KEYCLOAK_CLIENT_SECRET=<value>`.
2. UPDATE `tenant_identity_providers.secret_ref = 'tenant-aad-${TENANT_ID}'`
   for the matching row (created by Slice 35's POST /admin/tenants).
3. Print a summary line: `✓ secret stored at: secret/tenant-aad-${TENANT_ID}` —
   no operator-side copy-paste required.

The DB UPDATE goes through `kubectl exec -n cip-infra <postgres-pod>` (same
pattern as bootstrap.sh's tenant seed) since the script doesn't depend on
local psql.

---

## Acceptance Criteria

- [ ] `auth/k8s-secret-loader.ts` exists; reads in-cluster via mounted SA;
      caches per-`(namespace, secretName)` for 5 minutes; returns null on
      404 and throws on other API errors.
- [ ] `resolveKcClientSecret(realm, secretRef)` tries: K8s secret →
      JSON map → fallback env. First success wins.
- [ ] `tenant-resolver.ts` calls `resolveKcClientSecret`; failure paths
      return `'k8s_secret_not_found'` or `'k8s_secret_read_failed'`.
- [ ] Helm chart creates ServiceAccount, namespace-scoped Role with
      `secrets:get`, and RoleBinding. `serviceAccountName` set on the
      Deployment. RBAC scoped to the cip-app namespace only.
- [ ] `POD_NAMESPACE` env wired via downward API.
- [ ] `provision-tenant.sh` writes a K8s secret per tenant and updates
      `tenant_identity_providers.secret_ref` to that name.
- [ ] Existing dev tenant (no `secret_ref`) still works via the
      `KEYCLOAK_CLIENT_SECRET` + `KEYCLOAK_REALM_FALLBACK` path — no
      regression for single-realm dev.
- [ ] Adding a *new* tenant via `provision-tenant.sh` followed by a
      Teams message from that tenant's user works *without restarting
      the bot pod*. Cache picks up the new secret on the next miss.
- [ ] Rotating a tenant's KC client secret in KC + updating its K8s
      secret takes effect within 5 minutes (the cache TTL) without bot
      restart.
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes.
- [ ] `pnpm -r run typecheck` passes.

---

## Out of Scope

- KC client secret rotation automation (a job that periodically rotates
  client secrets and updates the corresponding K8s secrets). Useful but
  separate.
- ExternalSecrets / Vault / sealed-secrets integration. The right answer
  for production is one of these; this slice lays the data shape that
  any of them can consume.
- Removing the `KEYCLOAK_CLIENT_SECRETS` JSON map env. Keep as a
  documented fallback during the migration window — remove in a future
  cleanup slice once all tenants have a secret_ref.
- A read-watch model (K8s informer / watch API) so the bot picks up
  secret changes immediately rather than on cache miss. Worth doing only
  if 5-minute TTL becomes a real operational pain point.

---

## Cross-Slice Notes

If a tenant's `secret_ref` is set but the K8s secret doesn't exist
(operator skipped step 1 of provisioning), the resolver returns
`k8s_secret_not_found`. Worth surfacing this in the verify-readiness
script as a tenant-health check — log a cross-slice note pointing at
`scripts/verify-readiness.sh` so a future ops slice covers it.

If the bot already runs with a different ServiceAccount (some Helm charts
auto-create one), the new SA must replace it cleanly. Audit
`packages/teams-bot/helm/templates/deployment.yaml` for an existing
`serviceAccountName` field; if there's a default SA in use today, this
slice must explicitly set the new one.

---

## Commit

```
slice(37): per-tenant KC client secrets via K8s secrets + bot dynamic loading
```
