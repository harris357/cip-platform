# Slice 01 — Workspace Root

> **Prerequisite:** Complete `SLICE_00_ORIENTATION.md` first.  
> **Session size:** Small — 8 files, no TypeScript compilation yet.  
> **Verify with:** `pnpm install` (no typecheck yet — no TS files exist)

---

## What You Are Building

The monorepo scaffolding that every other package depends on:

```
cip/
├── package.json            ← workspace root, shared scripts, ESLint
├── pnpm-workspace.yaml     ← declares packages/* as workspaces
├── tsconfig.base.json      ← strict TS config inherited by all packages
├── .eslintrc.js            ← shared lint rules
├── .gitignore
└── .env.example            ← every env var the platform needs
```

---

## Why This Slice First

Without `pnpm-workspace.yaml`, pnpm won't resolve `@cip/*` cross-package imports. Without `tsconfig.base.json`, every package's `extends` path would fail. Without `.env.example`, developers don't know what to fill in `.envrc`.

This slice has zero domain logic — it is pure project scaffolding.

---

## Key Decisions to Understand

### `pnpm-workspace.yaml`
```yaml
packages:
  - 'packages/*'
```
This is the entire file. pnpm discovers `@cip/shared`, `@cip/hr-service`, etc. automatically.

### `tsconfig.base.json` settings that matter
- `"module": "Node16"` and `"moduleResolution": "Node16"` — required for ESM-compatible imports with `.js` extensions in TypeScript
- `"exactOptionalPropertyTypes": true` — catches `| undefined` vs optional property bugs
- `"noUncheckedIndexedAccess": true` — array/record access returns `T | undefined`, not `T`
- `"noImplicitOverride": true` — forces `override` keyword on derived class methods

### `.eslintrc.js` rules to add
The spec does not prescribe ESLint rules explicitly, but you should add:
```js
'no-restricted-imports': ['error', {
  patterns: [{ group: ['@anthropic-ai/*'], message: 'Use createLiteLLMClient() from @cip/shared instead' }]
}]
```
This enforces the LiteLLM-only rule at lint time.

---

## Files to Load in Claude Code Session

Load **only** these into the session. Nothing else.

```
plan.md  (sections 3, 9, 11, 12 only — Dependencies, Config, tsconfig, gitignore)
```

The prompt doc (`PROMPT_01_WORKSPACE_ROOT.md`) has the exact instruction to paste.

---

## Acceptance Criteria

- [ ] `pnpm install` runs without error from repo root
- [ ] `package.json` has `"workspaces"` field pointing to `packages/*`
- [ ] `tsconfig.base.json` has all 7 strict flags listed above
- [ ] `.eslintrc.js` includes the `no-restricted-imports` rule for `@anthropic-ai/*`
- [ ] `.env.example` contains every variable from Section 9 of the spec
- [ ] `.gitignore` excludes `node_modules/`, `dist/`, `.env`, `.envrc`, terraform state files

---

## Common Mistakes to Watch For

- Missing `"type": "module"` in root `package.json` (needed for Node16 module resolution)
- `pnpm-workspace.yaml` including `infra/` as a workspace — it should only be `packages/*`
- `tsconfig.base.json` missing `"outDir"` and `"rootDir"` — each package needs these to resolve correctly
- `.env.example` values that look like real credentials — they should be obviously placeholder (`sk-`, not an actual key)
