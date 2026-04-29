# CIP Bot — Teams App Deployment Guide

This is the authoritative checklist for registering and deploying the CIP bot in Microsoft Teams.
Complete the parts in order on first deployment; subsequent redeployments only need Part 4.

---

## Part 1 — Azure Bot Registration (one-time)

1. Go to **Azure Portal → Bot Services → Create → Azure Bot**
2. Bot handle: `cip-bot-dev` (or match your naming convention)
3. Microsoft App ID: create new — select **Single Tenant** and your Azure AD tenant ID
4. Note the **App ID** and **Client Secret** — these become `BOT_APP_ID` and `BOT_APP_PASSWORD`
   in the `teams-bot-credentials` K8s secret
5. Under **Configuration → Messaging endpoint**, set:
   ```
   https://bot.cip.idlevice.ca/api/messages
   ```
6. Under **Channels**, enable **Microsoft Teams**

---

## Part 2 — Azure AD App Manifest (SSO)

The bot's SSO requires the Azure AD app (the same App ID registered above) to expose an API scope.

1. **Azure Portal → App Registrations** → find the bot's App ID
2. **Expose an API** → set Application ID URI to:
   ```
   api://bot.cip.idlevice.ca/<BOT_APP_ID>
   ```
3. Add a scope named `access_as_user` — allow both **Admins** and **Users** to consent
4. Add the following Teams client IDs as **Authorized client applications** for that scope:
   - Teams Desktop: `1fec8e78-bce4-4aaf-ab1b-5451cc387264`
   - Teams Mobile/Web: `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`

The `webApplicationInfo.resource` in `manifest.json` matches this URI:
`api://bot.cip.idlevice.ca/${{BOT_APP_ID}}`

---

## Part 3 — Keycloak Identity Federation (token exchange)

The bot exchanges the Azure AD SSO token for a Keycloak JWT, which is used for all downstream
CIP API calls. Configure the token exchange in Keycloak before the bot handles any requests.

1. In **Keycloak Admin → your realm → Clients → `teams-bot`**
2. Enable the **Token Exchange** grant type
3. Configure the Azure AD identity provider as a trusted token exchange source for this client
4. Set `KEYCLOAK_CLIENT_SECRET` in the `teams-bot-credentials` K8s secret

The bot's auth flow (implemented in `src/auth/sso-handler.ts`):
- Teams delivers the SSO token via the `signin/tokenExchange` invoke
- The bot POSTs the Azure AD token to Keycloak's token exchange endpoint
- Keycloak returns a CIP JWT, which the bot stores in session and passes to MCP tool calls

---

## Part 4 — Package and Sideload

Install the Teams Toolkit CLI if not already installed:

```bash
npm install -g @microsoft/teamsapp-cli
```

Fill in `BOT_APP_ID` in `env/.env.local`, then package:

```bash
cd packages/teams-bot/teams-app
teamsapp package --env local
# Output: appPackage/build/appPackage.local.zip
```

Sideload in Teams:
1. Open **Microsoft Teams**
2. Go to **Apps → Manage your apps → Upload an app → Upload a custom app**
3. Select `appPackage/build/appPackage.local.zip`
4. Install to yourself (personal scope) or to a team/channel as needed

To deploy to the dev cluster, use the `dev` env:

```bash
teamsapp package --env dev
# Output: appPackage/build/appPackage.dev.zip
```

Then upload `appPackage.dev.zip` to the Teams Admin Center or distribute via your tenant app catalog.

---

## Part 5 — K8s Secret Checklist

Before deploying, confirm all required keys exist in the `teams-bot-credentials` secret:

```bash
kubectl get secret teams-bot-credentials -n cip-app -o jsonpath='{.data}' | jq 'keys'
```

Expected keys:

```
BOT_APP_ID
BOT_APP_PASSWORD
KEYCLOAK_CLIENT_SECRET
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

If any key is missing, add it before deploying:

```bash
kubectl create secret generic teams-bot-credentials -n cip-app \
  --from-literal=BOT_APP_ID=<value> \
  --from-literal=BOT_APP_PASSWORD=<value> \
  --from-literal=KEYCLOAK_CLIENT_SECRET=<value> \
  --from-literal=AWS_ACCESS_KEY_ID=<value> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<value> \
  --dry-run=client -o yaml | kubectl apply -f -
```

---

## Part 5b — Channel Bootstrap (CIP Approach)

> **Channel configuration is database-driven, not environment-variable-driven.**
> There are no channel ID env vars in this platform. Do not add any.

The bot self-registers `ConversationReference`s on the first incoming message from each
channel that is configured in the tenant database. No manual seeding or bootstrap script
is required.

### How it works

1. On every incoming message, `channel-registry.ts` calls the `get_tenant_channel_config`
   MCP tool (via the hr-service MCP endpoint)
2. The tool returns the list of channels configured for the message's tenant — each entry
   is a `{ channelId, channelType }` pair (e.g. `{ channelId: "19:...", channelType: "hitl_review" }`)
3. If the incoming Teams channel ID matches a configured entry, the bot registers the
   current `ConversationReference` in its in-memory store, keyed by `(tenantId, channelType)`
4. Proactive messages from hr-service activities (`POST /proactive`) look up the
   `ConversationReference` by tenant and channel type and deliver the message

### To configure a channel for proactive messaging (e.g. HITL review notifications)

1. **Add the bot to the target channel** — install the sideloaded (or catalog) app in
   the Teams team that contains the target channel, then add it to the specific channel

2. **Insert a row in the CIP database** for the tenant and channel:

   ```sql
   -- channelId comes from Teams — see "How to find the Teams channel ID" below
   -- channelType must match what hr-service notify-hitl.activity.ts sends in the POST /proactive body
   INSERT INTO tenant_channel_config (tenant_id, channel_id, channel_type)
   VALUES ('your-tenant-uuid', '19:abc123...@thread.tacv2', 'hitl_review');
   ```

3. **Send one message from a user in that channel** — this triggers the bot to call
   `get_tenant_channel_config`, match the incoming channel ID against the database config,
   and register the `ConversationReference` in its in-memory store

4. The bot logs: `[channel-registry] registered hitl_review for tenant <id>`

5. Proactive messages from hr-service activities (`POST /proactive`) will now reach
   that channel

### How to find the Teams channel ID

Enable debug logging on the bot pod, then send any message from the target channel.
The channel ID appears in the activity payload:

```
context.activity.channelData.channel.id
```

Example value: `19:abc123def456...@thread.tacv2`

---

## Part 6 — Verify

Once sideloaded and the K8s secrets are set:

1. Open **Teams → find the CIP Bot app**
2. Send `hello` — the bot should respond (SSO completes silently on first exchange)
3. Send a PDF — the bot should acknowledge receipt and return a processing confirmation
   from the MCP `process_document` tool
4. Open **Langfuse** — confirm a trace is visible tagged with your tenant ID
5. For proactive messaging: complete Part 5b, then trigger a HITL-producing upload and
   confirm the hr-service activity POSTs to `/proactive` and the message appears in
   the configured channel

### Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Bot does not respond | Messaging endpoint not set or K8s ingress not routing to port 3978 |
| SSO fails with 401 | Azure AD scope `access_as_user` not consented or Teams client IDs not added |
| Token exchange fails | Keycloak token exchange not configured for `teams-bot` client |
| File upload not acknowledged | `supportsFiles: true` missing from manifest (rebuild and resideload) |
| Proactive message not delivered | Channel not registered — check bot logs; verify DB row exists and a user has sent at least one message from the channel |
