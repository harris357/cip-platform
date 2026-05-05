# Slice 45d — Temporal SDK 1.16 → 1.17 bump

> **Prerequisite:** None.
> **Package:** `@cip/hr-service`, `@cip/platform-core`, `@cip/shared`.
> **Verify:** `pnpm -r run typecheck` passes; existing certification + employee workflows continue to start, signal, and complete after deploy. No replay-incompatible changes (verified by reading the 1.17 changelog before deploy).

---

## Why

Routine dependency hygiene. As of 2026-05-01:

| Package | Installed | Latest |
|---|---|---|
| `@temporalio/worker` | 1.16.1 | **1.17.0** |
| `@temporalio/workflow` | 1.16.1 | **1.17.0** |
| `@temporalio/activity` | 1.16.1 | **1.17.0** |
| `@temporalio/client` | 1.16.1 | **1.17.0** |

The version range in our `package.json`s is `^1.10.0`, so the latest minor is allowed. We're behind only because we haven't reinstalled since 1.17 was published.

This is a separate slice (not folded into other feature work) because:
1. Workflow code is **replay-sensitive**. A minor bump that introduces a new SDK behavior in workflow code can break in-flight workflows that were started under the old version. The change has to land in isolation so any incompatibility is unambiguously traceable.
2. The four `@temporalio/*` packages MUST move together. Touching them inside a feature slice violates single-purpose discipline.
3. The verify step (run an end-to-end workflow before declaring done) is the same regardless of what else is in the slice.

## What this slice IS

1. Bump the four `@temporalio/*` packages to `^1.17.0` in `@cip/hr-service`, `@cip/platform-core`, `@cip/shared`.
2. Run `pnpm install` and `pnpm -r run typecheck`. Fix any breakages — none expected at minor-version cadence, but verify.
3. Read the 1.17 changelog for **workflow-replay-incompatible** changes. If any exist, document the migration in this slice doc and call it out in the deploy commit.
4. Smoke-test against a live tenant: start a `disableEmployeeWorkflow`, wait for it to complete. Same for cert workflow if exercised in the dev tenant.

## What this slice is NOT

- **Not a temporal-server upgrade.** Server version is managed by Temporal Cloud (or whatever's in `infra/k8s/`); this slice only touches client-side TypeScript SDKs.
- **Not a refactor.** Pure version bump. If the changelog requires a small code shim, scope it tightly.
- **Not an opportunity to add new workflows or activities.** Out of scope.

---

## Files in scope

```
packages/hr-service/package.json          (bump 3 packages)
packages/platform-core/package.json       (bump 3 packages)
packages/shared/package.json              (bump 4 packages)
pnpm-lock.yaml                            (regen)

slices/SLICE_45D_TEMPORAL_BUMP.md         this file
```

If the changelog forces code adjustments (unlikely at minor cadence), add the touched files at implementation time.

---

## Hard rules

- **All four packages bumped together.** No partial upgrades.
- **Pre-deploy: read the 1.16 → 1.17 changelog.** Specifically look for workflow-replay incompatibilities. If any are present, the deploy comment lists them and (where possible) the migration steps.
- **Lockfile committed.** `pnpm-lock.yaml` updates land with the package.json bumps.
- **Live workflow smoke test BEFORE declaring done.** Don't trust typecheck alone — workflow code is the kind of thing typecheck doesn't catch.

---

## Verification

**Compile:**
```bash
pnpm install
pnpm -r run typecheck
```

**End-to-end smoke test (against dev tenant):**
1. Start a workflow that exercises both activity execution and signal handling. The disable-employee flow does both.
2. Watch the worker logs for any "task failure" or "version mismatch" warnings.
3. Confirm the workflow completes successfully and the resulting state is correct (employee disabled in `cip_hr.employees`).

**Replay-safety check:**
1. Before bumping, capture the state of any in-flight workflows: `kubectl exec -n cip-app deploy/hr-service -- node -e "console.log(require('@temporalio/client'))"` — or just list active workflows via the Temporal UI.
2. Bump + redeploy.
3. After the new worker is running, verify each previously-in-flight workflow continues making progress (or completes). If any fails with a replay error, the bump introduces an incompatibility and we either pin to 1.16 or follow the migration in the changelog.

---

## Out of scope (deferred)

- Temporal server upgrade (separate operational concern).
- Workflow-code refactors taking advantage of new 1.17 features (out of scope for a bump slice).

---

## Cross-slice notes

- Pure routine. No interaction with the LangGraph slices (45c, 46, 46b, 46c, 48, 49, 51, 52) — different runtime entirely.
- If 1.17 ships in a future minor (1.18+) before this slice is implemented, just retarget — same scope.
