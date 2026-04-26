# Slice 17 — Teams Bot (Generic Gateway)

> **Prerequisite:** Slices 02, 03 complete. Slice 09 MCP server running (or stubs available).
> **Package:** `@cip/teams-bot`
> **Verify:** `pnpm --filter @cip/teams-bot typecheck`

---

## What You Are Building

A lightweight, business-logic-free Teams bot. It handles the O365 protocol, resolves
identity, discovers tools, and delivers messages. It has no knowledge of HR, certificates,
roles, or any specific business process.

```
packages/teams-bot/src/
  index.ts
  bot.ts                          ← CIPTeamsBot — the dispatcher (~150 lines)
  server.ts                       ← Express: /api/messages + POST /proactive
  teams-protocol/
    file-handler.ts               ← CDN download, MIME detection, text/html stripping
    card-renderer.ts              ← wraps Adaptive Card JSON in a Teams attachment
    channel-registry.ts           ← in-memory (tenantId+channelType → conversationRef)
  auth/
    resolve-context.ts            ← JWT → AuthContext via get_employee_capabilities MCP
  mcp/
    client.ts                     ← MCP client singleton
    tool-discovery.ts             ← list_tools + capability filter + TTL cache (5 min)
    tool-executor.ts              ← calls tool, parses McpModuleResponse
  intent/
    router.ts                     ← single LiteLLM call with filtered tool list
```

---

## `bot.ts` — The Full Dispatch Loop

```typescript
export class CIPTeamsBot extends TeamsActivityHandler {
  constructor() {
    super()

    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded ?? []) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(buildWelcomeMessage())
        }
      }
      await next()
    })

    this.onMessage(async (context, next) => {
      const ctx = await resolveAuthContext(context)         // auth/resolve-context
      await updateChannelRegistry(context, ctx.tenantId)   // channel-registry

      const fileAttachments = detectFileAttachments(context) // teams-protocol/file-handler

      if (fileAttachments.length > 0) {
        for (const file of fileAttachments) {
          const key = await downloadToObjectStore(file, ctx)
          const result = await executeTool('process_document', { objectStoreKey: key }, ctx)
          await renderResponse(context, result)
        }
      } else {
        const text = context.activity.text?.trim() ?? ''
        if (!text) { await next(); return }

        const tools = await discoverTools(ctx)             // mcp/tool-discovery
        const selected = await routeIntent(text, tools, ctx) // intent/router

        if (selected) {
          const result = await executeTool(selected.name, selected.args, ctx)
          await renderResponse(context, result)
        } else {
          await context.sendActivity(buildNoToolMessage(tools))
        }
      }
      await next()
    })
  }
}
```

---

## `teams-protocol/file-handler.ts`

Port the battle-tested file detection logic from the PoC. Key rules:

1. Strip `contentType === 'text/html'` attachments — Teams always injects one
2. Detect `application/vnd.microsoft.teams.file.download.info` — download URL is in `attachment.content.downloadUrl`
3. Fallback: check `typeof attachment.content?.downloadUrl === 'string'`
4. `guessContentType(filename)` for MIME detection by extension
5. Download via `fetch(downloadUrl)` — store in object store, return `objectStoreKey`

```typescript
export function detectFileAttachments(context: TurnContext): Attachment[] {
  return (context.activity.attachments ?? [])
    .filter(a => a.contentType !== 'text/html')
    .filter(a =>
      a.contentType === 'application/vnd.microsoft.teams.file.download.info' ||
      a.contentType === 'application/pdf' ||
      (a.contentType ?? '').startsWith('image/') ||
      typeof (a.content as Record<string, unknown> | undefined)?.['downloadUrl'] === 'string'
    )
}

export async function downloadToObjectStore(
  attachment: Attachment,
  ctx: AuthContext,
): Promise<string> {
  // Resolve download URL from Teams CDN attachment content
  const downloadUrl =
    (attachment.content as Record<string, unknown> | undefined)?.['downloadUrl'] as string
  const buffer = await fetch(downloadUrl).then(r => r.arrayBuffer())
  const key = `${ctx.tenantId}/${ctx.employeeId}/${randomUUID()}`
  // Upload to configured object store (env: OBJECT_STORE_BUCKET)
  // Returns the key — passed directly to process_document MCP tool
  throw new Error('not implemented')
  return key
}
```

---

## `teams-protocol/channel-registry.ts`

```typescript
// In-memory store: tenantId+channelType → conversationReference
// Populated by: onMessage checking against get_tenant_channel_config
// Used by: POST /proactive endpoint

interface ChannelEntry {
  ref: ConversationReference
  expiresAt: number   // Date.now() + 24h
}

const registry = new Map<string, ChannelEntry>()

export function registerChannel(tenantId: string, channelType: string, ref: ConversationReference) {
  registry.set(`${tenantId}:${channelType}`, { ref, expiresAt: Date.now() + 86_400_000 })
}

export function getChannelRef(tenantId: string, channelType: string): ConversationReference | null {
  const entry = registry.get(`${tenantId}:${channelType}`)
  if (!entry || Date.now() > entry.expiresAt) return null
  return entry.ref
}

export async function updateChannelRegistry(
  context: TurnContext,
  tenantId: string,
): Promise<void> {
  // 1. Call get_tenant_channel_config MCP tool (result cached 5 min per tenantId)
  // 2. Compare incoming activity channelId / teamId against each entry in channel_config
  // 3. For any match: registerChannel(tenantId, channelType, TurnContext.getConversationReference(context.activity))
  throw new Error('not implemented')
}
```

---

## `auth/resolve-context.ts`

```typescript
export async function resolveAuthContext(context: TurnContext): Promise<AuthContext> {
  // 1. Extract tenantId from Teams activity channelData or JWT
  // 2. Extract aadOid from context.activity.from.aadObjectId
  // 3. Call sync_employee MCP tool — upserts employee record from JWT claims (no direct DB)
  // 4. Call get_employee_capabilities MCP tool → RoleCapabilities
  // 5. Return AuthContext
  throw new Error('not implemented')
}
```

No Redis. No Graph API calls. JWT claims only for identity. No direct DB access — all persistence via MCP tools.

---

## `mcp/tool-discovery.ts`

`McpTool` is the tool descriptor returned by the MCP SDK's `list_tools` response.
Import it from `@modelcontextprotocol/sdk/types.js` as `Tool` and alias locally:

```typescript
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'

// TTL cache: 5 minutes per tenantId
// 1. Call MCP list_tools
// 2. Filter: only tools where annotations.requiredCapability is empty
//    OR ctx.capabilities[tool.annotations.requiredCapability] === true
// 3. Return filtered tool list for LLM

export async function discoverTools(ctx: AuthContext): Promise<McpTool[]> { ... }
```

---

## `intent/router.ts`

Single LiteLLM call. The LLM receives the user message and filtered tool list.
It returns a tool name + arguments, or `null` if nothing applies.

```typescript
export async function routeIntent(
  message: string,
  tools: McpTool[],
  ctx: AuthContext,
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  const client = createLiteLLMClient({ tenantId: ctx.tenantId, virtualKey: ctx.tenantConfig.litellmVirtualKey })
  const response = await client.chat.completions.create({
    model: 'cip-chat',
    messages: [{ role: 'user', content: message }],
    tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    tool_choice: 'auto',
  })
  const call = response.choices[0]?.message.tool_calls?.[0]
  if (!call) return null
  return { name: call.function.name, args: JSON.parse(call.function.arguments) }
}
```

---

## `server.ts` — Proactive Endpoint

```typescript
// POST /proactive
// Body: { tenantId: string, channelType: string, card: object }
// Called by hr-service activities to send proactive messages

app.post('/proactive', async (req, res) => {
  const { tenantId, channelType, card } = req.body
  const ref = getChannelRef(tenantId, channelType)
  if (!ref) { res.status(404).json({ error: 'channel not registered' }); return }

  await adapter.continueConversationAsync(process.env['BOT_APP_ID']!, ref, async (ctx) => {
    await ctx.sendActivity({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
    })
  })
  res.status(204).end()
})
```

---

## `buildWelcomeMessage`

Returns a static plain-text welcome string. At `MembersAdded` time there is no
authenticated user context, so tool discovery cannot run. The message explains the
bot's purpose without listing specific capabilities.

```typescript
export function buildWelcomeMessage(): string {
  return 'Hello! I can help you manage certifications and HR tasks. ' +
    'Send me a message or upload a certificate document to get started.'
}
```

---

## Required Environment Variables

| Variable | Purpose |
|---|---|
| `BOT_APP_ID` | Microsoft App ID for the bot registration |
| `BOT_APP_PASSWORD` | Microsoft App password / client secret |
| `MCP_SERVER_URL` | Base URL of the hr-service MCP server |
| `LITELLM_BASE_URL` | LiteLLM proxy base URL |
| `LITELLM_VIRTUAL_KEY` | Default virtual key (overridden per-tenant via `get_tenant_channel_config`) |
| `OBJECT_STORE_BUCKET` | Target bucket/container for uploaded files |

---

## Hard Rules

1. Bot never imports from `@cip/hr-service` — MCP only
2. No `switch (intent)` — tool selection is entirely the LLM's job
3. No channel IDs, team IDs, or role names hardcoded in the bot
4. `resolveAuthContext` calls `sync_employee` then `get_employee_capabilities` MCP tools — no direct DB
5. `POST /proactive` is the only way the bot sends unsolicited messages

---

## Acceptance Criteria

- [ ] Bot has no imports from `@cip/hr-service`
- [ ] `detectFileAttachments` strips `text/html`, handles Teams CDN download info pattern
- [ ] `channelRegistry` entries expire after 24h
- [ ] `discoverTools` filters tool list by caller's capabilities
- [ ] `routeIntent` makes a single LiteLLM call — no hardcoded intent strings
- [ ] `POST /proactive` endpoint exists and uses stored conversation reference
- [ ] `resolveAuthContext` stubs JWT extraction and calls MCP for capabilities
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes
