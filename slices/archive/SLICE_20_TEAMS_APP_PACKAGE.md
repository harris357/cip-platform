# Slice 20 — Teams App Package (Manifest + Deployment Guide)

> **Prerequisite:** Slice 18 complete (SSO auth flow implemented).
> **Package:** `packages/teams-bot/teams-app/` — config and JSON only, no TypeScript.
> **Verify:** Validate `manifest.json` is valid JSON; no typecheck needed.

---

## What You Are Building

Without a Teams App package, the bot cannot be installed in Microsoft Teams.
The Azure Bot Framework receives traffic at `bot.dev.cip.idlevice.ca/api/messages`
only if Teams knows about the bot — which requires a manifest registered via the
Teams App Catalog or sideloaded by an admin.

This slice creates the complete `teams-app/` directory inside `packages/teams-bot/`:
- `manifest.json` — tells Teams which bot ID to route to, which scopes to use, that
  file uploads are supported, and how to perform SSO against the CIP Azure AD app
- `teamsapp.yml` — Teams Toolkit packaging workflow
- `env/` — per-environment variables used to fill manifest placeholders
- `BUILD.md` — step-by-step guide: Azure Bot registration → manifest packaging → sideload

This is a **config-only slice**. No TypeScript is written or modified.

---

## Read Before Writing

- `packages/teams-bot/helm/values.yaml` (for `ingress.host` = `bot.dev.cip.idlevice.ca`)
- `sample/ernai/teams-app/appPackage/manifest.json` (structural reference — manifest format only)
- `sample/ernai/teams-app/teamsapp.yml` (structural reference — packaging format only)
- `sample/ernai/teams-app/BUILD.md` (read to understand what to EXCLUDE — see hard rules below)

Do NOT modify any TypeScript files.

---

## What NOT to Port from the Sample

The sample's `BUILD.md` contains a section called **"Health & Safety HITL Bootstrap"** that
references `HR_TEAM_ID`, `HR_CHANNEL_ID`, and a `ConversationReference` bootstrap triggered
by `installationUpdate` events. **None of this applies to the CIP platform.**

The sample hardcoded HR channel IDs as env vars and used a Redis-backed `ConversationReference`
store seeded by `installationUpdate`. That was a single-tenant, single-channel hack.

The CIP platform does this differently:
- Channel configuration is stored in the **hr-service database** (the `tenant_settings` table),
  not in env vars
- The `get_tenant_channel_config` MCP tool returns the list of configured channels for a tenant
  (each entry is a `{ channelId, channelType }` pair — e.g. `{ channelId: "19:...", channelType: "hitl_review" }`)
- On every incoming message, `channel-registry.ts` calls `get_tenant_channel_config` and compares
  the incoming Teams channel ID against the config — if it matches, the `ConversationReference`
  is self-registered in the in-memory registry
- No `HR_TEAM_ID`, no `HR_CHANNEL_ID`, no `installationUpdate` handler — the registry populates
  itself from the database-backed config on the first message from each configured channel

The BUILD.md written in this slice must explain the CIP approach in its channel bootstrap section,
not the sample's approach.

---

## Directory Structure to Create

```
packages/teams-bot/teams-app/
  teamsapp.yml
  BUILD.md
  env/
    .env.local
    .env.dev
  appPackage/
    manifest.json
    icons/
      color.png       ← placeholder 192x192 PNG (any image, correct dimensions)
      outline.png     ← placeholder 32x32 PNG transparent (any image, correct dimensions)
```

Icons are required for manifest validation. For now, copy the icons from the sample:
`sample/ernai/teams-app/appPackage/icons/color.png` → `appPackage/icons/color.png`
`sample/ernai/teams-app/appPackage/icons/outline.png` → `appPackage/icons/outline.png`

---

## `appPackage/manifest.json`

Key differences from the sample POC manifest:
- **Multi-tenant** — no `channelAuthTenant`; `webApplicationInfo.resource` uses
  `api://` scheme pointing at the bot domain
- **SSO enabled** — `webApplicationInfo` section is required for Teams SSO to work
- **`supportsFiles: true`** — mandatory for certificate uploads
- **Placeholder variables** use `${{VAR_NAME}}` format (Teams Toolkit convention)

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "${{BOT_APP_ID}}",
  "developer": {
    "name": "IdleVice",
    "websiteUrl": "https://${{BOT_DOMAIN}}",
    "privacyUrl": "https://${{BOT_DOMAIN}}/privacy",
    "termsOfUseUrl": "https://${{BOT_DOMAIN}}/terms"
  },
  "icons": {
    "color": "icons/color.png",
    "outline": "icons/outline.png"
  },
  "name": {
    "short": "CIP Bot",
    "full": "CIP — Construction Intelligence Platform"
  },
  "description": {
    "short": "Manage worker certifications and compliance",
    "full": "Upload and track health and safety certifications, check compliance status, and manage worker onboarding — all from Microsoft Teams."
  },
  "accentColor": "#1b4f72",
  "bots": [
    {
      "botId": "${{BOT_APP_ID}}",
      "scopes": ["personal", "groupchat", "team"],
      "supportsFiles": true,
      "isNotificationOnly": false,
      "commandLists": [
        {
          "scopes": ["personal", "groupchat", "team"],
          "commands": [
            {
              "title": "help",
              "description": "Show what I can do"
            },
            {
              "title": "my certifications",
              "description": "List your current certifications and expiry dates"
            },
            {
              "title": "compliance status",
              "description": "Check compliance status for a worker or site"
            }
          ]
        }
      ]
    }
  ],
  "staticTabs": [],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": [
    "${{BOT_DOMAIN}}"
  ],
  "webApplicationInfo": {
    "id": "${{BOT_APP_ID}}",
    "resource": "api://${{BOT_DOMAIN}}/${{BOT_APP_ID}}"
  }
}
```

---

## `env/.env.local` — Local / Dev Environment

```
# Local dev / sideload values
# Teams Toolkit substitutes ${{VAR}} placeholders in manifest.json using these values.
BOT_APP_ID=<paste Azure Bot app ID here>
BOT_DOMAIN=bot.dev.cip.idlevice.ca
```

## `env/.env.dev`

```
# Dev cluster (same as .env.local for now — separate when you have a staging slot)
BOT_APP_ID=<paste Azure Bot app ID here>
BOT_DOMAIN=bot.dev.cip.idlevice.ca
```

---

## `teamsapp.yml`

```yaml
# Teams Toolkit packaging config.
# Run: teamsapp package --env local
# Output: appPackage/build/appPackage.local.zip

version: 1.0.0

environmentFolderPath: ./env

provision:
  - uses: teamsApp/validateManifest
    with:
      manifestPath: ./appPackage/manifest.json

  - uses: teamsApp/zipAppPackage
    with:
      manifestPath: ./appPackage/manifest.json
      outputZipPath: ./appPackage/build/appPackage.${{TEAMSFX_ENV}}.zip
      outputFolder: ./appPackage/build

  - uses: teamsApp/validateAppPackage
    with:
      appPackagePath: ./appPackage/build/appPackage.${{TEAMSFX_ENV}}.zip
```

---

## `BUILD.md` — Step-by-Step Deployment Guide

This document must be created in `packages/teams-bot/teams-app/BUILD.md`.
It is the authoritative checklist for registering and deploying the bot.

Write it to cover:

### Part 1 — Azure Bot Registration (one-time)

1. Go to Azure Portal → Bot Services → Create → Azure Bot
2. Bot handle: `cip-bot-dev` (or match your naming convention)
3. Microsoft App ID: create new (Single Tenant → your Azure AD tenant ID)
4. Note the **App ID** and **Client Secret** — these become `BOT_APP_ID` and `BOT_APP_PASSWORD`
   in the `teams-bot-credentials` K8s secret
5. Under **Configuration → Messaging endpoint**, set:
   `https://bot.dev.cip.idlevice.ca/api/messages`
6. Under **Channels**, enable **Microsoft Teams**

### Part 2 — Azure AD App Manifest (SSO)

The bot's SSO requires the Azure AD app (same App ID as the bot) to expose an API scope:

1. Azure Portal → App Registrations → find the bot's App ID
2. **Expose an API** → set Application ID URI to:
   `api://bot.dev.cip.idlevice.ca/<BOT_APP_ID>`
3. Add a scope named `access_as_user` — allow both Admins and Users to consent
4. Add the Teams Desktop (`1fec8e78-bce4-4aaf-ab1b-5451cc387264`) and
   Teams Mobile/Web (`5e3ce6c0-2b1f-4285-8d4b-75ee78787346`) client IDs as
   **Authorized client applications** for that scope

### Part 3 — Keycloak Identity Federation (token exchange)

The bot exchanges the Azure AD token for a Keycloak JWT:

1. In Keycloak admin → your realm → Clients → `teams-bot`
2. Enable **Token Exchange** grant type
3. Configure the Azure AD IDP as a trusted token exchange source
4. Set `KEYCLOAK_CLIENT_SECRET` in the `teams-bot-credentials` K8s secret

### Part 4 — Package and Sideload

```bash
# Install Teams Toolkit CLI
npm install -g @microsoft/teamsapp-cli

# Fill in BOT_APP_ID in env/.env.local, then package
cd packages/teams-bot/teams-app
teamsapp package --env local

# The zip is at: appPackage/build/appPackage.local.zip
# In Teams: Apps → Manage your apps → Upload an app → Upload a custom app
# → select appPackage.local.zip
```

### Part 5 — K8s Secret Checklist

Confirm these keys exist in the `teams-bot-credentials` secret before deploying:

```bash
kubectl get secret teams-bot-credentials -n cip-app -o jsonpath='{.data}' | jq 'keys'
# Expected: BOT_APP_ID, BOT_APP_PASSWORD, KEYCLOAK_CLIENT_SECRET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

### Part 5b — Channel Bootstrap (CIP Approach)

> **Do not configure HR_TEAM_ID or HR_CHANNEL_ID env vars.** Those are POC concepts that do
> not exist in this platform. Channel registration is database-driven, not env-var-driven.

The bot self-registers channels on the first message received from each configured channel.
The configuration lives in the database, not in the bot's environment.

**To configure a channel for proactive messaging (e.g. HITL notifications):**

1. Add the bot to the target Teams channel (install the sideloaded app in that channel/team)
2. In the CIP database (`tenant_settings` for the relevant tenant), insert a row that maps the
   Teams channel ID to a channel type:
   ```sql
   -- channelId comes from Teams (visible in bot logs on first message from the channel)
   -- channelType must match what hr-service notify-hitl.activity.ts sends in the POST /proactive body
   INSERT INTO tenant_channel_config (tenant_id, channel_id, channel_type)
   VALUES ('your-tenant-uuid', '19:abc123...@thread.tacv2', 'hitl_review');
   ```
3. Send one message from a user in that channel — this triggers the bot to call
   `get_tenant_channel_config`, match the incoming channel ID against the config, and
   register the `ConversationReference` in its in-memory store
4. The bot logs: `[channel-registry] registered hitl_review for tenant <id>` (or equivalent)
5. Proactive messages from hr-service activities (`POST /proactive`) will now reach that channel

**How to find the Teams channel ID:**
- Enable debug logging on the bot pod
- Send any message from the target channel
- The channel ID appears in the activity: `context.activity.channelData.channel.id`

### Part 6 — Verify

Once sideloaded:
1. Open Teams → find the CIP Bot app
2. Send "hello" — bot should respond (SSO completes silently on first exchange, then replies)
3. Send a PDF — bot should acknowledge receipt and return a processing confirmation from the MCP `process_document` tool
4. Check Langfuse — you should see a trace tagged with your tenant ID
5. For proactive messaging: follow Part 5b above, then trigger a HITL-producing upload and confirm the hr-service activity POSTs to `/proactive` and the message appears in the configured channel

---

## Hard Rules

1. `BUILD.md` must NOT mention `HR_TEAM_ID`, `HR_CHANNEL_ID`, or `installationUpdate` bootstrap
2. `BUILD.md` channel bootstrap section must describe the MCP `get_tenant_channel_config` approach
3. No env vars for channel configuration — channels are configured in the database only
4. `BOT_DOMAIN` in manifest and env files must exactly match `ingress.host` in `helm/values.yaml`
5. Do NOT modify any TypeScript or Helm files in this slice — config and documentation only

---

## Acceptance Criteria

- [ ] `packages/teams-bot/teams-app/appPackage/manifest.json` is valid JSON
- [ ] `manifest.json` has `"supportsFiles": true`
- [ ] `manifest.json` has `webApplicationInfo` with `api://` resource URI
- [ ] `manifest.json` uses `${{BOT_APP_ID}}` and `${{BOT_DOMAIN}}` placeholders
- [ ] `env/.env.local` and `env/.env.dev` exist with correct variable names
- [ ] `teamsapp.yml` exists and references the correct manifest path
- [ ] Icons exist at `appPackage/icons/color.png` (192x192) and `outline.png` (32x32)
- [ ] `BUILD.md` covers all six parts: Azure Bot, Azure AD SSO, Keycloak, packaging, channel bootstrap (CIP approach), verification
- [ ] `BUILD.md` has zero references to `HR_TEAM_ID`, `HR_CHANNEL_ID`, or `installationUpdate` bootstrap
- [ ] `BUILD.md` channel bootstrap section explains the database-config → `get_tenant_channel_config` → self-registration flow
- [ ] No TypeScript files were modified in this slice
