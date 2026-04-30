// Slice 37: read a K8s secret value via the bot's mounted ServiceAccount.
//
// Used by the tenant resolver to fetch the per-tenant KC client secret named
// in tenant_identity_providers.secret_ref. Caches per (namespace, secretName)
// for 5 minutes — same TTL as the rest of the tenant context cache.
//
// Auth: in-cluster config picks up the SA token mounted at
// /var/run/secrets/kubernetes.io/serviceaccount/. The bot's ServiceAccount
// (Slice 37 helm chart) has secrets:get scoped to the cip-app namespace.

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
  kc.loadFromCluster();
  _api = kc.makeApiClient(k8s.CoreV1Api);
  return _api;
}

function defaultNamespace(): string {
  return process.env['POD_NAMESPACE'] ?? 'cip-app';
}

export async function readK8sSecretValue(
  secretName: string,
  key: string,
  namespace: string = defaultNamespace(),
): Promise<string | null> {
  const cacheKey = `${namespace}/${secretName}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data[key] ?? null;
  }

  try {
    // v1 API: readNamespacedSecret returns the secret object directly
    // (no .body wrapper as in v0.x).
    const resp = await getApi().readNamespacedSecret({ name: secretName, namespace });
    const raw = (resp as { data?: Record<string, string> }).data ?? {};
    const decoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      decoded[k] = Buffer.from(v, 'base64').toString('utf8');
    }
    cache.set(cacheKey, { data: decoded, expiresAt: Date.now() + TTL_MS });
    return decoded[key] ?? null;
  } catch (err) {
    // 404 = secret doesn't exist; surface as null so the caller can return
    // a typed error. Other errors (RBAC, network) propagate.
    const status = (err as { code?: number; statusCode?: number; response?: { statusCode?: number } });
    const code = status.code ?? status.statusCode ?? status.response?.statusCode;
    if (code === 404) return null;
    throw err;
  }
}

// Test-only helper.
export function _resetK8sSecretCache(): void {
  cache.clear();
}
