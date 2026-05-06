import { readFile } from 'node:fs/promises'

// Slice 71: minimal Kubernetes API client. Uses the pod's ServiceAccount
// token mounted at /var/run/secrets/kubernetes.io/serviceaccount/. Avoids
// the @kubernetes/client-node dep entirely. cluster-internal calls only.

const SA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount'

interface K8sCreds {
  token:     string
  namespace: string
  apiBase:   string
}

let cached: K8sCreds | null = null

async function loadCreds(): Promise<K8sCreds> {
  if (cached) return cached
  const [token, namespace] = await Promise.all([
    readFile(`${SA_PATH}/token`, 'utf-8'),
    readFile(`${SA_PATH}/namespace`, 'utf-8'),
  ])
  // KUBERNETES_SERVICE_HOST + PORT are injected by kubelet into every pod.
  // Fallback to in-cluster default for local dev sanity.
  const host = process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc'
  const port = process.env['KUBERNETES_SERVICE_PORT_HTTPS'] ?? process.env['KUBERNETES_SERVICE_PORT'] ?? '443'
  cached = {
    token:     token.trim(),
    namespace: namespace.trim(),
    apiBase:   `https://${host}:${port}`,
  }
  return cached
}

export interface K8sFetchOptions {
  method:  'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path:    string
  body?:   unknown
  headers?: Record<string, string>
}

export async function k8sFetch(opts: K8sFetchOptions): Promise<Response> {
  const creds = await loadCreds()
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${creds.token}`,
    'Content-Type':  opts.headers?.['Content-Type'] ?? 'application/json',
    'Accept':        'application/json',
    ...(opts.headers ?? {}),
  }
  return fetch(`${creds.apiBase}${opts.path}`, {
    method:  opts.method,
    headers,
    ...(opts.body !== undefined
      ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }
      : {}),
  })
}

export async function getServiceAccountNamespace(): Promise<string> {
  const creds = await loadCreds()
  return creds.namespace
}

/** Reset the cached creds. Test-only. */
export function _resetK8sCache(): void {
  cached = null
}
