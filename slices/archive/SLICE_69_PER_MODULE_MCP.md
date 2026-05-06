# Slice 69 — Per-module MCP servers + platform-core MCP expansion

> **Why this exists:** Phase 7 of Arc 1, also slice 12 from Q12 of the original migration plan. Today hr-service exposes ONE MCP endpoint at `/mcp` that registers all 6 module tool sets (cert, employee, compliance, people, settings, admin). document-service is the same shape (`/mcp` → ingest + eval). This conflates module boundaries — the bot's tool catalog has to be split downstream by name prefix; multi-agent prep (Arc 2) wants each module addressable as its own agent endpoint.
>
> **What this slice does:**
> - Splits `hr-service /mcp` into 6 per-module endpoints: `/mcp/cert`, `/mcp/employee`, `/mcp/compliance`, `/mcp/people`, `/mcp/settings`, `/mcp/admin`
> - Splits `document-service /mcp` into 2 per-module endpoints: `/mcp/ingest`, `/mcp/eval`
> - Removes legacy `/mcp` endpoints from both services (hard cut)
> - Expands platform-core MCP server (`/mcp/platform`) with `get_my_user` and `get_my_permissions` tools
> - Migrates bot's `resolve-context.ts` to call `get_my_permissions` on **platform-core** (was hr-service `get_employee_permissions`)
> - Deletes hr-service's `get_employee_permissions` tool (hard cut)
> - Updates teams-bot's `multi-server-client.ts` to know module-scoped server names
>
> **Future-proof for Arc 2 multi-agent.** Each module endpoint is now a logical agent boundary. Promoting a module to its own pod becomes a Helm-only change.

---

## Files in scope

```
# ── hr-service: split MCP into per-module endpoints ─────────────────────
packages/hr-service/src/mcp-server/index.ts                                 MOD (replace /mcp with 6 per-module routes; each builds an McpServer with only that module's tools)
packages/hr-service/src/modules/employees/mcp-tools/get-employee-permissions.tool.ts  DELETE (moved to platform-core)
packages/hr-service/src/modules/employees/mcp-tools/index.ts                MOD (drop registerGetEmployeePermissions)

# ── document-service: split MCP ──────────────────────────────────────────
packages/document-service/src/mcp-server/index.ts                            MOD (replace /mcp with /mcp/ingest + /mcp/eval; each registers only its module)

# ── platform-core: MCP expansion ────────────────────────────────────────
packages/platform-core/src/mcp-server/tools/get-my-user.ts                  NEW (~70 LOC — reads caller's User row from cip_platform.users)
packages/platform-core/src/mcp-server/tools/get-my-permissions.ts           NEW (~120 LOC — calls /auth/resolve internally OR queries cip_platform tables directly; returns {permissions, roles})
packages/platform-core/src/mcp-server/index.ts                              MOD (register get_my_user + get_my_permissions alongside existing sync_user)

# ── teams-bot: module-scoped server registry ────────────────────────────
packages/teams-bot/src/mcp/multi-server-client.ts                            MOD (expand ServerName to module-scoped strings; update resolveServers + URL defaults)
packages/teams-bot/src/auth/resolve-context.ts                              MOD (sync_user on platform-core; ensure_employee on hr.employee; get_my_permissions on platform-core)
packages/teams-bot/helm/values.yaml                                          MOD (add per-module URL env vars; remove the old combined HR_SERVICE_MCP_URL / DOCUMENT_SERVICE_MCP_URL)

# ── helm: hr-service + doc-service service ports unchanged ──────────────
# (per-module endpoints share the same Express server; just different paths)
```

~600-800 LOC of net change. No new pods.

---

## Hard rules

1. **Hard cut: legacy `/mcp` endpoints removed from hr-service AND document-service.** No backwards-compat shim. teams-bot is the only known caller and it's updated in-slice.

2. **Each module endpoint registers ONLY that module's tools.** No cross-module leakage. `tools/list` on `/mcp/cert` returns only `cert.*` tools, not `employee.*`.

3. **`get_employee_permissions` moves to platform-core as `get_my_permissions`.** Same response shape (`{permissions, roles}`). hr-service's version is deleted entirely. Bot's resolve-context.ts updated to call platform-core.

4. **`get_my_user` is a new platform-core tool** that returns the caller's User row (id, tenantId, email, fullName, identityType). Foundation for future "user profile" features.

5. **`ServerName` becomes module-scoped** in teams-bot. Format: `<service>.<module>` (e.g., `'hr.cert'`, `'hr.employee'`, `'documents.ingest'`, `'documents.eval'`). `'platform-core'` stays unscoped (it's its own thing).

6. **URL convention:** each module endpoint is `${SERVICE_BASE_URL}/mcp/${module}`. Helm values get one env var per module (`HR_CERT_MCP_URL`, `HR_EMPLOYEE_MCP_URL`, etc.); fall back to deriving from `HR_SERVICE_BASE_URL` + `/mcp/${module}` if not explicitly set.

7. **Tool metadata side-channel stays single per service.** hr-service's `/admin/tool-metadata` continues to return metadata for ALL hr-service tools (across modules). The bot merges by tool name regardless of which module endpoint surfaced the tool — names don't collide because of module-prefix conventions.

8. **No tool renames in this slice.** Tools keep their existing names (e.g., `cert.submit`, `employee.find`). Splitting endpoints doesn't change tool identity.

---

## hr-service per-module endpoint shape

```typescript
// packages/hr-service/src/mcp-server/index.ts (MOD)

interface ModuleSpec {
  path:     string                               // '/mcp/cert'
  register: (s: McpServer) => void               // registerCertificationTools
}

const MODULES: ModuleSpec[] = [
  { path: '/mcp/cert',       register: registerCertificationTools },
  { path: '/mcp/employee',   register: registerEmployeeTools     },
  { path: '/mcp/compliance', register: registerComplianceTools   },
  { path: '/mcp/people',     register: registerPeopleTools       },
  { path: '/mcp/settings',   register: registerSettingsTools     },
  { path: '/mcp/admin',      register: registerAdminTools        },
]

function createModuleServer(register: (s: McpServer) => void): McpServer {
  const s = new McpServer({ name: 'hr-service', version: '1.0.0' })
  register(s)
  return s
}

export async function startMcpServer(): Promise<void> {
  // ... existing seedPermissionCatalog + seedToolEmbeddings ...
  const app = express()
  app.use(express.json())

  for (const mod of MODULES) {
    app.post(mod.path, attachBearerAuth, async (req, res) => {
      const s = createModuleServer(mod.register)
      const transport = new StreamableHTTPServerTransport({})
      await s.connect(transport as any)
      await transport.handleRequest(req, res, req.body)
    })
  }

  // Legacy /mcp removed (slice 69 hard cut).

  const port = parseInt(process.env['MCP_PORT'] ?? '3001', 10)
  await new Promise<void>((resolve) => app.listen(port, () => resolve()))
}
```

document-service follows the same pattern with `[/mcp/ingest, /mcp/eval]`.

---

## platform-core MCP expansion

`packages/platform-core/src/mcp-server/tools/get-my-user.ts`:

```typescript
server.tool(
  'get_my_user',
  'Return the caller\'s User record. Identity-only (no HR fields). ' +
  'Scope: caller; takes no arguments.',
  {},
  { requiredPermission: null, sideEffectLevel: 'read', whenToUse: ['Internal — fetch caller identity'], whenNotToUse: [], commonNextTools: ['get_my_permissions'], outputSchema: { ... } } as any,
  async (_args, context) => {
    const ctx = extractAuthContext(context.authInfo)
    // Look up via user_identity_links → users. Same pattern as ensure_employee.
    const result = await withTenantRLS(getDb(), ctx.tenantId, async (tx) => {
      const linkRow = await tx
        .select({ userId: userIdentityLinks.userId })
        .from(userIdentityLinks)
        .where(and(
          eq(userIdentityLinks.tenantId, ctx.tenantId),
          eq(userIdentityLinks.provider, 'keycloak'),
          eq(userIdentityLinks.subject,  ctx.keycloakSub),
        ))
        .limit(1)
      if (linkRow.length === 0) return null
      const userRow = await tx.select().from(users).where(eq(users.id, linkRow[0]!.userId)).limit(1)
      return userRow[0] ?? null
    })
    if (!result) {
      return jsonResponse({ data: null, error: 'user_not_found', message: 'sync_user must run first' })
    }
    return jsonResponse({ data: { user: result } })
  },
)
```

`packages/platform-core/src/mcp-server/tools/get-my-permissions.ts`:

Replicates hr-service's get_employee_permissions but reads from cip_platform directly. Returns `{permissions, roles}`. Glob expansion uses the same algorithm.

---

## teams-bot multi-server registry

`packages/teams-bot/src/mcp/multi-server-client.ts`:

```typescript
export type ServerName =
  | 'platform-core'
  | 'hr.cert' | 'hr.employee' | 'hr.compliance' | 'hr.people' | 'hr.settings' | 'hr.admin'
  | 'documents.ingest' | 'documents.eval'

function resolveServers(): ServerEntry[] {
  const hrBase   = process.env['HR_SERVICE_BASE_URL']       ?? 'http://hr-service.cip-app.svc.cluster.local:4001'
  const docBase  = process.env['DOCUMENT_SERVICE_BASE_URL'] ?? 'http://document-service.cip-app.svc.cluster.local:3000'
  const platform = process.env['PLATFORM_CORE_MCP_URL']     ?? 'http://platform-core.cip-app.svc.cluster.local:3001/mcp/platform'

  return [
    { name: 'platform-core',     url: platform                },
    { name: 'hr.cert',           url: `${hrBase}/mcp/cert`     },
    { name: 'hr.employee',       url: `${hrBase}/mcp/employee` },
    { name: 'hr.compliance',     url: `${hrBase}/mcp/compliance` },
    { name: 'hr.people',         url: `${hrBase}/mcp/people`   },
    { name: 'hr.settings',       url: `${hrBase}/mcp/settings` },
    { name: 'hr.admin',          url: `${hrBase}/mcp/admin`    },
    { name: 'documents.ingest',  url: `${docBase}/mcp/ingest`  },
    { name: 'documents.eval',    url: `${docBase}/mcp/eval`    },
  ]
}
```

`getMcpClientFor(name, token)` already takes ServerName as input — just more values now.

---

## resolve-context.ts updated

```typescript
// Slice 69:
//   1. platform-core sync_user      — User upsert
//   2. hr.employee ensure_employee  — Employee row check / auto-create
//   3. platform-core get_my_permissions — permission resolution (was hr-service)

const platformClient = await getMcpClientFor('platform-core',  jwt)
const hrEmployeeMcp  = await getMcpClientFor('hr.employee',    jwt)

await platformClient.callTool({ name: 'sync_user', arguments: {} })
const ensureResult = await hrEmployeeMcp.callTool({ name: 'ensure_employee', arguments: {} })
const permsResult  = await platformClient.callTool({ name: 'get_my_permissions', arguments: {} })
```

---

## Acceptance criteria

1. **`pnpm -r run typecheck` clean**.
2. **hr-service `/mcp` returns 404** (legacy gone). Each `/mcp/<module>` returns the module's tools.
3. **document-service `/mcp` returns 404**. `/mcp/ingest` and `/mcp/eval` work.
4. **platform-core `/mcp/platform`** lists `sync_user`, `get_my_user`, `get_my_permissions`.
5. **Bot end-to-end**: send Teams message; resolve-context calls 3 tools across 2 services. Permission map populated.
6. **`get_employee_permissions` removed** from hr-service. `grep -rn 'get_employee_permissions' packages/` returns zero matches.

---

## Implementation status

**Implemented in commit-pending state on 2026-05-06.** Files touched:

**hr-service:**
- `packages/hr-service/src/mcp-server/index.ts` — replaced single `/mcp` with 6 per-module endpoints (`/mcp/cert`, `/mcp/employee`, `/mcp/compliance`, `/mcp/people`, `/mcp/settings`, `/mcp/admin`). Each endpoint registers ONLY that module's tools. Combined server kept internally for the tool-embeddings seed only.
- `packages/hr-service/src/modules/employees/mcp-tools/index.ts` — dropped `registerGetEmployeePermissions` import + call.
- DELETED: `packages/hr-service/src/modules/employees/mcp-tools/get-employee-permissions.tool.ts`.

**document-service:**
- `packages/document-service/src/server.ts` — replaced single `/mcp` with `/mcp/ingest` + `/mcp/routing`. (Eval module placeholder for future slice 60 implementation.)

**platform-core:**
- `packages/platform-core/src/mcp-server/tools/get-my-user.ts` — NEW. Returns caller's User record from cip_platform.users via the canonical KC link.
- `packages/platform-core/src/mcp-server/tools/get-my-permissions.ts` — NEW. Replicates hr-service's get_employee_permissions semantics; queries cip_platform tables directly post-slice-68.
- `packages/platform-core/src/mcp-server/index.ts` — registers both new tools alongside sync_user.

**teams-bot:**
- `packages/teams-bot/src/mcp/multi-server-client.ts` — `ServerName` expanded to module-scoped strings (`hr.cert`, `hr.employee`, `hr.compliance`, `hr.people`, `hr.settings`, `hr.admin`, `documents.ingest`, `documents.routing`, `platform-core`). Per-module env overrides supported.
- `packages/teams-bot/src/mcp/tool-executor.ts` — fallback default flipped from `'hr-service'` to `'hr.employee'`.
- `packages/teams-bot/src/mcp/client.ts` — legacy `getMcpClient(token)` repointed to `'hr.settings'` (its only remaining caller is channel-registry which uses get_tenant_channel_config).
- `packages/teams-bot/src/auth/resolve-context.ts` — three-call provisioning pattern: `platform-core sync_user` → `hr.employee ensure_employee` → `platform-core get_my_permissions`. Permission resolution moved off hr-service.
- `packages/teams-bot/helm/values.yaml` — `HR_SERVICE_BASE_URL` + `DOCUMENT_SERVICE_BASE_URL` replace the single-endpoint URLs; per-module overrides via `HR_<module>_MCP_URL` / `DOCUMENTS_<module>_MCP_URL`.

**Verification:**
- ✅ `pnpm -r run typecheck` clean (all 7 packages)
- ✅ `pnpm -r run build` clean
- ⏳ Runtime: each module endpoint should `tools/list` only its module's tools. Bot's three-call resolve-context pattern needs end-to-end Teams turn for full validation.

## Locked decisions

1. **Module-scoped ServerName** in teams-bot — `<service>.<module>` format.
2. **Hard cut** on legacy `/mcp` endpoints in both hr-service and document-service.
3. **`get_my_permissions` on platform-core** replaces `get_employee_permissions` on hr-service.
4. **`get_my_user`** is the new platform-core tool for caller's identity record.
5. **Per-module endpoints share the same Express server / port** — just different paths. No new pods.

Slice is locked. Proceeding to implementation.
