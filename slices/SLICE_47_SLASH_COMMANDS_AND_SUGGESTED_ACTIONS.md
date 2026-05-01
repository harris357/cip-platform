# Slice 47 — Role-aware slash commands + suggestedActions

> **Prerequisite:** Slice 45 deployed. Slash commands `/lg on`, `/lg off`, `/lg status`, `/lg help` already work (engine-toggle.ts handler).
> **Package:** `@cip/teams-bot`, plus a Teams app manifest update.
> **Verify:** `pnpm --filter @cip/teams-bot typecheck`; manual smoke per-role in Teams (HR admin sees admin commands in `/help`, baseline employee doesn't).

---

## Why this slice

Today `/lg` commands work but are undocumented in-app. Users learn about them by reading the slice doc or being told. Two upgrades:

1. **`/help`** — role-filtered command list. Replies with a markdown menu of only the commands this caller can actually run.
2. **`suggestedActions`** chips on the welcome message — clickable shortcuts the user can tap. Permission-filtered.
3. **Static manifest commandLists** — populated with the universal commands so they appear in the Teams "..." overflow menu and on `/` autocomplete (where supported).

Admin-only commands stay OUT of the static manifest. Discoverability for those happens only via the role-filtered `/help` and via `suggestedActions` when the caller is permitted.

---

## What this slice IS

- A **slash command registry** in code, replacing the ad-hoc `/lg` handler in `engine-toggle.ts`. Each registry entry: `{ command, description, requires, handler }`.
- `/help` handler that calls `commandsForCaller(ctx)` and renders a markdown list of only what the caller can run.
- `commandsForCaller(ctx)` helper using the same `requiredPermission` / `role:hr` / `null` semantics as the MCP tool annotations and the Slice 43 `tool-permissions.ts` patterns.
- `suggestedActions` block on the welcome message, filtered by the same logic. Up to 6 chips.
- Manifest `commandLists` update: replace today's three placeholder commands with the universal slash set.

## What this slice is NOT

- **Not new domain shortcuts.** No `/admin audit` or `/employee find <email>` commands. The LangGraph + legacy runtimes already handle natural-language equivalents (`/lg on; show recent audit events`). Adding parallel slash paths to domain operations would duplicate routing logic. If we ever add shortcut commands later, they'd reuse the same registry.
- **Not adaptive cards.** Welcome stays as a plain message with `suggestedActions` chips. Adaptive cards are a separate UX investment.

---

## Slash command registry

```ts
// packages/teams-bot/src/slash-commands/registry.ts

import type { BotAuthContext } from '../auth/resolve-context.js';

export interface SlashCommandResult {
  reply: string;
}

export interface SlashCommand {
  /** Exact text the user must type / clicks from suggestedActions. Includes the leading slash. */
  command:     string;
  description: string;
  /**
   * Permission requirement. Same convention as MCP tool annotations:
   *   null         — available to everyone
   *   'role:hr'    — requires the `hr` Keycloak realm role
   *   '<perm>'     — requires that CIP permission code
   */
  requires:    string | 'role:hr' | null;
  /** Handler is invoked with the parsed command + caller context. */
  handler:     (args: {
    ctx:      BotAuthContext;
    threadId: string;
    text:     string;
  }) => Promise<SlashCommandResult>;
}

/**
 * Order matters for `/help` rendering — first universal commands, then
 * role-gated ones. Add new commands here; do not maintain a parallel
 * list in the manifest.
 */
export const REGISTRY: SlashCommand[] = [/* see below */];
```

Initial entries (Slice 47):

```ts
{ command: '/help',       requires: null, description: 'List commands you can use',                       handler: helpHandler },
{ command: '/lg on',      requires: null, description: 'Switch this thread to the LangGraph runtime',     handler: lgOnHandler },
{ command: '/lg off',     requires: null, description: 'Switch this thread back to the legacy runtime',   handler: lgOffHandler },
{ command: '/lg status',  requires: null, description: 'Show which engine is active in this thread',      handler: lgStatusHandler },
```

`/lg help` is dropped — `/help` subsumes it (and is shorter to type). The four `/lg*` handlers move out of `engine-toggle.ts` into individual files in `slash-commands/handlers/`. The `selectEngine` and override-Map state stays in `engine-toggle.ts`.

`commandsForCaller`:

```ts
export function commandsForCaller(ctx: BotAuthContext): SlashCommand[] {
  return REGISTRY.filter(c => isPermitted(c.requires, ctx));
}

function isPermitted(req: SlashCommand['requires'], ctx: BotAuthContext): boolean {
  if (req === null) return true;
  if (req === 'role:hr') return ctx.roles?.includes('hr') ?? false;
  return ctx.permissions[req] === true;
}
```

`/help` handler:

```ts
async function helpHandler({ ctx }: { ctx: BotAuthContext }) {
  const commands = commandsForCaller(ctx);
  const lines = commands.map(c => `- \`${c.command}\` — ${c.description}`);
  return {
    reply: 'Here are the commands you can use:\n\n' + lines.join('\n'),
  };
}
```

---

## Bot.ts dispatch (replaces inline /lg handling)

```ts
// In handleAuthenticatedMessage, before any other processing:
const slash = await dispatchSlashCommand({
  ctx,
  threadId,
  text,
});
if (slash) {
  await context.sendActivity(slash.reply);
  return;
}
```

`dispatchSlashCommand` looks up by exact match (case-insensitive after `text.trim().toLowerCase()`) against `REGISTRY`. If a match is found AND `isPermitted` passes, runs the handler. If the slash command exists but isn't permitted for this caller, replies with `"That command isn't available to you."` rather than silently falling through (so users don't get cryptic LLM responses to typed slashes).

The existing `handleEngineSlashCommand` in `engine-toggle.ts` is replaced by this dispatch. `selectEngine` + the in-process overrides Map remain — only the slash-command parsing moves out.

---

## suggestedActions on welcome

`buildWelcomeMessage()` in `bot.ts` currently returns a plain string. Replace it with an Activity that carries `suggestedActions`:

```ts
function buildWelcomeActivity(ctx: BotAuthContext): Activity {
  const chips = buildWelcomeChips(ctx);   // returns up to 6 actions
  return Activity.fromObject({
    type: 'message',
    text: 'Hello! I can help with certifications and HR tasks. Tap an option below or ask in your own words.',
    suggestedActions: chips.length > 0 ? { actions: chips } : undefined,
  });
}
```

`buildWelcomeChips` selects up to 6 entries based on caller permissions. Order:
1. `/help` (always)
2. Caller-specific natural-language shortcuts based on roles:
   - Everyone: "Show my certifications"
   - cert.list_all: "What's expiring in 30 days"
   - employee.list: "List employees"
   - employee.find: "Look up an employee"
3. `/lg on` (always — useful for testing the new runtime)

The chips are static prompts the user can resend, not slash commands necessarily. Mixing natural-language prompts with slashes is fine — the bot handles both.

---

## Manifest update

Replace the three current placeholder commands with the universal slash set:

```json
"commandLists": [{
  "scopes": ["personal", "groupchat", "team"],
  "commands": [
    { "title": "/help",       "description": "List commands you can use" },
    { "title": "/lg on",      "description": "Use the LangGraph runtime in this thread" },
    { "title": "/lg off",     "description": "Use the legacy runtime in this thread" },
    { "title": "/lg status",  "description": "Show which engine is active" }
  ]
}]
```

The `/help` reply is what surfaces role-specific commands to the user. The static list is the discovery floor.

The Teams app package needs to be repackaged + side-loaded after this change — separate ops step from `make deploy`. Document in slice notes.

---

## Files in scope

```
packages/teams-bot/src/slash-commands/registry.ts                NEW
packages/teams-bot/src/slash-commands/handlers/help.ts           NEW
packages/teams-bot/src/slash-commands/handlers/lg.ts             NEW (replaces inline /lg in engine-toggle.ts)
packages/teams-bot/src/slash-commands/dispatch.ts                NEW (parsing + permission check + handler invoke)
packages/teams-bot/src/slash-commands/welcome-chips.ts           NEW (buildWelcomeChips)
packages/teams-bot/src/intent/engine-toggle.ts                   (drop handleEngineSlashCommand; keep selectEngine + overrides)
packages/teams-bot/src/bot.ts                                    (use dispatchSlashCommand; buildWelcomeActivity instead of buildWelcomeMessage)
packages/teams-bot/teams-app/appPackage/manifest.json            (commandLists update; bump manifest version)
slices/SLICE_47_SLASH_COMMANDS_AND_SUGGESTED_ACTIONS.md          this file
```

---

## Hard rules

- **Single source of truth for slash commands.** REGISTRY in code is canonical. Manifest commandLists mirrors the *universal* subset (admin commands stay out of the manifest).
- **Same permission convention as MCP tools.** `null` / `'role:hr'` / permission code. Don't introduce a third gate type.
- **No silent ignores.** Recognized slash command + insufficient permission → explicit "not available to you" reply. Unrecognized text → fall through to engine.
- **suggestedActions caller-scoped.** No chip surfaces a command the caller can't run.
- **Manifest version bump.** Increment `version` in manifest.json so Teams clients re-fetch.

---

## Verification

**Typecheck:**
```
pnpm --filter @cip/teams-bot typecheck
```

**Smoke (per-role):**

| Caller            | Action                                  | Expected                                                                |
|-------------------|-----------------------------------------|-------------------------------------------------------------------------|
| Any user          | Open the bot                            | Welcome with chips: "Show my certifications", "/help", "/lg on"          |
| HR admin          | `/help`                                 | Reply lists `/help`, `/lg on`, `/lg off`, `/lg status`                  |
| HR admin          | Welcome chips                           | Includes "List employees", "Look up an employee" in addition to baseline |
| Baseline employee | `/help`                                 | Reply lists only universal commands (no admin entries today)            |
| Any user          | `/lg on`                                | Engine flipped; reply confirms                                          |
| Any user          | `/lg help` (legacy alias)               | "Unknown command. Did you mean /help?" or fall-through                  |

**Manifest:** repackage Teams app, side-load, verify `/` autocomplete shows all four universal commands in the chat (mobile/web clients). Desktop shows the same in the "..." overflow menu.

---

## Out of scope

- Domain shortcuts (`/admin audit`, `/employee find <email>`) — would duplicate runtime routing logic. Add to REGISTRY later if user testing shows demand.
- Adaptive card welcome — separate UX investment.
- Persistence of per-thread engine override — Slice 46.
- `/admin help` subcommands — not yet justified.

---

## Cross-slice notes

- Slice 45's `handleEngineSlashCommand` in `engine-toggle.ts` is replaced by the registry-based dispatch. `selectEngine` and the overrides Map stay where they are.
- The Slice 43 description sweep gave us tool-level `requiredPermission`. Slice 47's `commandsForCaller` mirrors that pattern at the slash-command layer — same gate types, parallel implementation.
