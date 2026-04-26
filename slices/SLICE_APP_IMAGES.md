# Slice — App Service Images & CI Pipeline

> **Prerequisite:** `make bootstrap-infra` and `make bootstrap` complete. Cluster running with litellm healthy.
> **Session size:** Medium — Dockerfiles exist, need registry wiring + CI + helm fix + restore to start.ts.
> **Verify with:** `make start` deploys all 5 charts with real pods Running.

---

## What You Are Building

Wire the three application services (hr-service, platform-core, teams-bot) so they can actually run in the cluster:

1. Replace `ghcr.io/YOUR_ORG/...` placeholders with real image references
2. Create a GitHub Actions workflow that builds and pushes images on every push to `master`
3. Restore hr-service, platform-core, teams-bot to `start.ts` and `stop.ts`
4. Verify each service starts and passes a basic health check

---

## Files to Create or Modify

```
.github/
└── workflows/
    └── build-images.yml          ← NEW: build + push all three images to ghcr.io

packages/hr-service/helm/
└── values.yaml                   ← MODIFY: replace YOUR_ORG with real GitHub org

packages/platform-core/helm/
└── values.yaml                   ← MODIFY: replace YOUR_ORG with real GitHub org

packages/teams-bot/helm/
└── values.yaml                   ← MODIFY: replace YOUR_ORG with real GitHub org

packages/infra/src/start.ts       ← MODIFY: restore hr-service, platform-core, teams-bot
packages/infra/src/stop.ts        ← MODIFY: restore hr-service, platform-core, teams-bot
```

---

## Read Before Writing

- `packages/hr-service/Dockerfile` — existing multi-stage build, node:22-alpine, exposes 3000
- `packages/platform-core/Dockerfile` — same pattern
- `packages/teams-bot/Dockerfile` — same pattern
- `packages/hr-service/helm/values.yaml` — `image.repository: ghcr.io/YOUR_ORG/hr-service`
- `packages/infra/src/start.ts` — APP_CHARTS array, hr-service/platform-core/teams-bot are commented out

---

## GitHub Registry Setup (one-time, before running the workflow)

The images publish to `ghcr.io/<github-org>/<service>:dev`.

1. In GitHub repo settings → Actions → General → set "Workflow permissions" to **Read and write**
2. No separate token needed — the workflow uses `GITHUB_TOKEN` which has `packages: write` permission

---

## GitHub Actions Workflow

Build all three images in parallel on push to `master`. Tag with both `dev` (rolling) and the git SHA (pinnable).

Key points:
- Trigger: `push` to `master`, paths `packages/hr-service/**`, `packages/platform-core/**`, `packages/teams-bot/**`
- Registry: `ghcr.io`, login with `GITHUB_TOKEN`
- Build context: each service's package directory (`./packages/<svc>`)
- Tags: `ghcr.io/<org>/<svc>:dev` and `ghcr.io/<org>/<svc>:<sha>`
- Use `docker/build-push-action` with `cache-from: type=gha` for fast rebuilds

---

## Helm Values — Image Reference

Replace `YOUR_ORG` in all three `values.yaml` files with the real GitHub org (e.g. `idlevice`):

```yaml
# Before
image:
  repository: ghcr.io/YOUR_ORG/hr-service
  tag: dev

# After
image:
  repository: ghcr.io/idlevice/hr-service
  tag: dev
```

Also update `pullPolicy` to `Always` for the `dev` tag (so rollout restarts pick up new pushes):

```yaml
image:
  pullPolicy: Always
```

---

## Restore start.ts and stop.ts

In `packages/infra/src/start.ts`, restore the three commented-out services to `APP_CHARTS`:

```typescript
const APP_CHARTS: HelmRelease[] = [
  { name: 'litellm',       chart: './infra/helm/litellm',          namespace: 'cip-app', values: './infra/helm/litellm-values.yaml' },
  ...(LANGFUSE_SELF_HOSTED ? [{ name: 'langfuse', chart: 'langfuse/langfuse', namespace: 'cip-observe', values: './infra/helm/langfuse-self-hosted-values.yaml' }] : []),
  { name: 'hr-service',    chart: './packages/hr-service/helm',    namespace: 'cip-app' },
  { name: 'platform-core', chart: './packages/platform-core/helm', namespace: 'cip-app' },
  { name: 'teams-bot',     chart: './packages/teams-bot/helm',     namespace: 'cip-app' },
];
```

In `packages/infra/src/stop.ts`, restore to `APP_RELEASES` (reverse order):

```typescript
const APP_RELEASES: HelmRelease[] = [
  { name: 'teams-bot',     namespace: 'cip-app' },
  { name: 'platform-core', namespace: 'cip-app' },
  { name: 'hr-service',    namespace: 'cip-app' },
  ...(LANGFUSE_SELF_HOSTED ? [{ name: 'langfuse', namespace: 'cip-observe' }] : []),
  { name: 'litellm',       namespace: 'cip-app' },
];
```

---

## Makefile — deploy target

Update the placeholder `YOUR_ORG` in the existing `deploy` target:

```makefile
deploy:       ## Build + push + rollout restart. Usage: make deploy svc=hr-service
	@docker build -t ghcr.io/idlevice/$(svc):dev ./packages/$(svc)
	@docker push ghcr.io/idlevice/$(svc):dev
	@kubectl rollout restart deployment/$(svc) -n cip-app
```

---

## Acceptance Criteria

- [ ] `build-images.yml` workflow exists and triggers on push to `master`
- [ ] All three `values.yaml` files reference `ghcr.io/<real-org>/<svc>:dev`
- [ ] `make start` deploys all 5 charts without `InvalidImageName` errors
- [ ] `kubectl get pods -n cip-app` shows all 5 pods `Running` (or `CrashLoopBackOff` is an app bug, not an image bug)
- [ ] `packages/infra/src/start.ts` typechecks: `pnpm --filter @cip/infra typecheck`

---

## Hard Rules for This Slice

1. Do not change any Dockerfile — they already work
2. `pullPolicy: Always` only on `dev` tag; if pinning to a SHA tag use `IfNotPresent`
3. The `GITHUB_TOKEN` secret is automatic — do not add a PAT or `CR_PAT` secret
4. Do not modify `create-secrets.sh` — secrets for each service are already defined there
5. After restoring services to `start.ts`, run typecheck before finishing
