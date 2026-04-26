# Makefile — CIP Platform
# Daily commands: make start | make stop | make bootstrap

.DEFAULT_GOAL := help

.PHONY: help start stop bootstrap bootstrap-infra create-secrets status forward logs deploy verify typecheck build lint

# ── Daily cycle ──────────────────────────────────────────────────────────────

start:        ## Morning startup — scale node to 1, deploy all Helm charts
	@pnpm --filter @cip/infra run start

stop:         ## Evening shutdown — destroy Helm releases, scale node to 0
	@pnpm --filter @cip/infra run stop

# ── First time only ──────────────────────────────────────────────────────────

bootstrap-infra: ## One-time: Terraform — OVH cluster, node pool, PVCs, infra Helm charts, K8s secrets
	@bash scripts/bootstrap-infra.sh

bootstrap:    ## One-time: NATS streams, Keycloak realm, DB migrations, LiteLLM virtual key
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

deploy:       ## Build + push + rollout restart. Usage: make deploy svc=hr-service
	@docker build -t ghcr.io/idlevice/$(svc):dev ./packages/$(svc)
	@docker push ghcr.io/idlevice/$(svc):dev
	@kubectl rollout restart deployment/$(svc) -n cip-app

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
