import { z } from 'zod'
import { k8sFetch, getServiceAccountNamespace } from './k8s-api.helper.js'

// Slice 71: per-tenant K8s secret. Replaces bash section 5a.
// Idempotent: tries POST; on 409 (already exists) falls back to PATCH.
// Naming: tenant-aad-<tenantId>. Holds the tenant's KC client secret(s).

const InputSchema = z.object({
  tenantId:        z.string().uuid(),
  // Map of secret keys → values. Bash put KEYCLOAK_CLIENT_SECRET; we
  // accept N keys so AAD federation can stash app secrets too.
  data:            z.record(z.string(), z.string().min(1)),
  namespaceOverride: z.string().optional(),
})
const OutputSchema = z.object({
  name:      z.string(),
  namespace: z.string(),
  created:   z.boolean(),
})
export type CreateK8sSecretInput  = z.infer<typeof InputSchema>
export type CreateK8sSecretOutput = z.infer<typeof OutputSchema>

export async function createK8sSecret(input: unknown): Promise<CreateK8sSecretOutput> {
  const parsed = InputSchema.parse(input)
  const namespace = parsed.namespaceOverride ?? (process.env['CIP_TARGET_NAMESPACE'] ?? await getServiceAccountNamespace())
  const name = `tenant-aad-${parsed.tenantId}`

  const data: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed.data)) {
    data[k] = Buffer.from(v).toString('base64')
  }

  const body = {
    apiVersion: 'v1',
    kind:       'Secret',
    metadata:   { name, namespace },
    type:       'Opaque',
    data,
  }

  // Try POST first.
  const postResp = await k8sFetch({
    method: 'POST',
    path:   `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`,
    body,
  })
  if (postResp.ok) {
    return OutputSchema.parse({ name, namespace, created: true })
  }
  if (postResp.status !== 409) {
    const text = await postResp.text().catch(() => '')
    throw new Error(`createK8sSecret: POST HTTP ${postResp.status} ${text}`)
  }

  // 409 → exists. PATCH the data field with strategic merge.
  const patchResp = await k8sFetch({
    method:  'PATCH',
    path:    `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`,
    body:    { data },
    headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
  })
  if (!patchResp.ok) {
    const text = await patchResp.text().catch(() => '')
    throw new Error(`createK8sSecret: PATCH HTTP ${patchResp.status} ${text}`)
  }
  return OutputSchema.parse({ name, namespace, created: false })
}
