# Makefile — CIP Platform
# Daily commands: make start | make stop | make bootstrap

.DEFAULT_GOAL := help

.PHONY: help start stop bootstrap bootstrap-infra create-secrets status forward logs deploy redeploy redeploy-all ship provision-tenant verify typecheck build lint

# ── Daily cycle ──────────────────────────────────────────────────────────────

start:        ## Morning startup — scale node, wait for infra, bootstrap, deploy all charts
	@pnpm --filter @cip/infra run start

stop:         ## Evening shutdown — destroy Helm releases, scale node to 0
	@pnpm --filter @cip/infra run stop

# ── First time only ──────────────────────────────────────────────────────────

bootstrap-infra: ## One-time: Terraform — OVH cluster, node pool, PVCs, infra Helm charts, K8s secrets
	@bash scripts/bootstrap-infra.sh

bootstrap:    ## Run bootstrap manually (called automatically by 'make start')
	@bash scripts/bootstrap.sh

get-lb-ip:    ## Print the OVH Floating IP assigned to ingress-nginx
	@kubectl get svc -n ingress-nginx ingress-nginx-controller \
		-o jsonpath='{.status.loadBalancer.ingress[0].ip}{"\n"}' 2>/dev/null \
		|| echo "No IP yet — ingress-nginx LoadBalancer may still be provisioning"

configure-dns: ## Create/update Cloudflare A records pointing to the OVH LB IP
	@bash scripts/configure-dns.sh

configure-tls: ## Apply cert-manager ClusterIssuer (Let's Encrypt + Cloudflare DNS-01)
	@bash scripts/configure-tls.sh

dry-run:      ## Validate full provisioning without applying changes
	@bash scripts/dry-run.sh

smoke-test:   ## Post-deployment health check — run after 'make start'
	@bash scripts/smoke-test.sh

cycle-test:   ## Full cycle: start → smoke-test → stop (daily ops verification)
	@bash scripts/cycle-test.sh

cycle-test-reprovision: ## Full cycle with Terraform reprovision (infra charts destroyed and recreated)
	@bash scripts/cycle-test.sh --reprovision

create-secrets: ## Recreate all K8s secrets from .envrc (after cluster recreation)
	@bash scripts/create-secrets.sh

provision-tenant: ## Provision a new CIP tenant. Usage: make provision-tenant ARGS='--name "Acme Inc" --admin-email admin@acme.com [--aad-tenant-id <guid>] [--tier <t>]'
	@[ -n "$(ARGS)" ] || (echo "Error: ARGS= is required. Run: bash scripts/provision-tenant.sh --help"; exit 1)
	@bash scripts/provision-tenant.sh $(ARGS)

# ── Development ──────────────────────────────────────────────────────────────

status:       ## Show pod states, PVC states, node state
	@echo "--- Nodes ---"
	@kubectl get nodes 2>/dev/null || echo "No nodes (cluster stopped)"
	@echo ""
	@echo "--- PVCs (must always exist) ---"
	@kubectl get pvc -A
	@echo ""
	@echo "--- Pods ---"
	@kubectl get pods -A 2>/dev/null || echo "No pods"

forward:      ## Port-forward NATS (4222) and PostgreSQL (5432) for local dev
	@kubectl port-forward -n cip-infra svc/nats 4222:4222 &
	@kubectl port-forward -n cip-infra svc/postgres-postgresql 5432:5432 &
	@echo "Port-forwards open: NATS=4222, PostgreSQL=5432"

logs:         ## Tail logs from a service. Usage: make logs svc=hr-service
	@kubectl logs -f -n cip-app -l app=$(svc) --tail=100

TAG ?= $(shell git rev-parse --short HEAD)
deploy:       ## Deploy a service via helm upgrade (chart + values change). Usage: make deploy svc=hr-service [TAG=<sha>]
	@[ -n "$(svc)" ] || (echo "Error: svc= is required"; exit 1)
	@if [ -d "./packages/$(svc)/helm" ]; then \
		echo "→ Deploying app chart packages/$(svc)/helm with image tag $(TAG)"; \
		helm upgrade --install $(svc) ./packages/$(svc)/helm \
			--namespace cip-app --create-namespace \
			--set image.tag=$(TAG) \
			--atomic --timeout 5m; \
	elif [ -d "./infra/helm/$(svc)" ]; then \
		echo "→ Deploying infra chart infra/helm/$(svc) (image tag ignored)"; \
		helm upgrade --install $(svc) ./infra/helm/$(svc) \
			--namespace cip-app --create-namespace \
			$$( [ -f "./infra/helm/$(svc)-values.yaml" ] && echo "-f ./infra/helm/$(svc)-values.yaml" ) \
			--atomic --timeout 5m; \
	else \
		echo "Error: no chart found at packages/$(svc)/helm or infra/helm/$(svc)"; \
		exit 1; \
	fi
	@echo "Deployed $(svc):$(TAG)"

# Auto-discover internal services that have a Helm chart (used by redeploy-all).
SERVICES := $(shell ls -1 packages/*/helm/Chart.yaml 2>/dev/null | sed 's|packages/||;s|/helm/Chart.yaml||')

redeploy:     ## Pull latest image and restart pods + tail logs. Usage: make redeploy svc=hr-service
	@[ -n "$(svc)" ] || (echo "Error: svc= is required (e.g. make redeploy svc=hr-service)"; exit 1)
	@echo "→ Restarting deploy/$(svc) in cip-app..."
	@kubectl rollout restart -n cip-app deploy/$(svc)
	@kubectl rollout status  -n cip-app deploy/$(svc) --timeout=180s
	@echo ""
	@echo "→ Recent logs (Ctrl-C to stop tailing):"
	@kubectl logs -f -n cip-app deploy/$(svc) --tail=40

redeploy-all: ## Pull latest images and restart all internal services in parallel
	@[ -n "$(SERVICES)" ] || (echo "Error: no helm charts found under packages/*/helm/"; exit 1)
	@echo "→ Services: $(SERVICES)"
	@echo "→ Restarting all in parallel..."
	@for s in $(SERVICES); do \
		echo "  - kubectl rollout restart deploy/$$s"; \
		kubectl rollout restart -n cip-app deploy/$$s; \
	done
	@echo ""
	@echo "→ Waiting for each rollout to complete..."
	@for s in $(SERVICES); do \
		printf "  %-20s " "$$s"; \
		kubectl rollout status -n cip-app deploy/$$s --timeout=180s | tail -1; \
	done
	@echo ""
	@echo "→ All restarted. View logs with:  make logs svc=<name>"

ship:         ## Push HEAD, wait for CI image build, then redeploy + tail logs. Usage: make ship svc=hr-service
	@[ -n "$(svc)" ] || (echo "Error: svc= is required (e.g. make ship svc=teams-bot)"; exit 1)
	@command -v gh >/dev/null 2>&1 || (echo "Error: gh CLI not found — install GitHub CLI or use 'git push && make redeploy svc=$(svc)' manually"; exit 1)
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Error: working tree has uncommitted changes. Commit first, then 'make ship svc=$(svc)'."; \
		git status --short; \
		exit 1; \
	fi
	@SHA=$$(git rev-parse --short HEAD); \
		echo "→ Pushing HEAD ($$SHA) to origin..."; \
		git push
	@echo "→ Waiting for the CI run on this commit to complete..."
	@sleep 5  # give GitHub a moment to register the workflow run
	@gh run watch --exit-status \
		|| (echo "ERROR: CI failed. Fix and 'make ship' again."; exit 1)
	@echo "→ CI succeeded. Redeploying $(svc)..."
	@$(MAKE) redeploy svc=$(svc)

verify:       ## End-to-end health check (kubectl, secrets, S3, Temporal, Langfuse, Cloudflare)
	@bash scripts/verify-readiness.sh

# ── Code quality ─────────────────────────────────────────────────────────────

typecheck:    ## Run TypeScript type checking across all packages
	@pnpm -r run typecheck

build:        ## Build all packages
	@pnpm -r run build

lint:         ## Run ESLint
	@pnpm lint

# ── Help ──────────────────────────────────────────────────────────────────────

help:         ## Show this help message
	@printf '\n  Usage: make <target>\n\n'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@printf '\n'
