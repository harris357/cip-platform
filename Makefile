# Makefile — CIP Platform
# Daily commands: make start | make stop | make bootstrap

.DEFAULT_GOAL := help

.PHONY: help start stop bootstrap bootstrap-infra create-secrets status forward logs deploy redeploy redeploy-all ship provision-tenant verify typecheck build lint extractor-test extractor-coverage extractor-add training-data-add training-data-stats training-data-review training-data-mark-reviewed training-data-export training-data-seed-tenant classifier-train classifier-eval classifier-deploy classifier-status classifier-retrain-now training-data-import-traces training-data-augment-from-docs trace-import-now

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

resources:    ## Capacity, live usage, requests committed, top consumers
	@echo "════════════════ Node capacity ════════════════"
	@kubectl get nodes -o custom-columns='NAME:.metadata.name,CPU:.status.capacity.cpu,MEM:.status.capacity.memory,ALLOC_CPU:.status.allocatable.cpu,ALLOC_MEM:.status.allocatable.memory' 2>/dev/null || echo "No nodes"
	@echo ""
	@echo "════════════════ Live usage (metrics-server) ════════════════"
	@kubectl top nodes 2>/dev/null || echo "metrics-server not ready"
	@echo ""
	@echo "════════════════ Committed requests/limits per node ════════════════"
	@for n in $$(kubectl get nodes -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do \
	  echo "── $$n ──"; \
	  kubectl describe node "$$n" | awk '/Allocated resources:/,/Events:/' | grep -E "cpu|memory" | grep -v "^Events" | head -6; \
	  echo ""; \
	done
	@echo "════════════════ Top 10 memory consumers ════════════════"
	@kubectl top pod -A --sort-by=memory 2>/dev/null | head -11
	@echo ""
	@echo "════════════════ Top 10 CPU consumers ════════════════"
	@kubectl top pod -A --sort-by=cpu 2>/dev/null | head -11

forward:      ## Port-forward NATS (4222) and PostgreSQL (5432) for local dev
	@kubectl port-forward -n cip-infra svc/nats 4222:4222 &
	@kubectl port-forward -n cip-infra svc/postgres-postgresql 5432:5432 &
	@echo "Port-forwards open: NATS=4222, PostgreSQL=5432"

logs:         ## Tail logs from a service. Usage: make logs svc=hr-service
	@kubectl logs -f -n cip-app -l app=$(svc) --tail=100

TAG ?= $(shell git rev-parse --short HEAD)
IMAGE_REPO ?= ghcr.io/harris357

# Slice 56D follow-up: bridge selected workstation env vars into Helm
# `--set` flags so operators can flip deploy-time switches in .envrc
# without also editing values.yaml. Allowlist is intentional — anything
# secret stays in K8s secrets, never crosses this boundary.
HELM_ENV_BRIDGE := CLASSIFIER_PER_TENANT_ENABLED
HELM_SET_FROM_ENV = $(foreach v,$(HELM_ENV_BRIDGE),$(if $($(v)),--set env.$(v)=$($(v))))

deploy:       ## Deploy a service via helm upgrade. Bridges $HELM_ENV_BRIDGE vars from your shell. Usage: make deploy svc=hr-service [TAG=<sha>]
	@[ -n "$(svc)" ] || (echo "Error: svc= is required"; exit 1)
	@if [ -d "./packages/$(svc)/helm" ]; then \
		if [ "$(TAG)" != "latest" ] && command -v gh >/dev/null 2>&1; then \
			echo "→ Checking that a successful CI build exists for commit $(TAG)..."; \
			LONG_SHA=$$(git rev-parse HEAD 2>/dev/null); \
			OK=$$(gh run list --commit "$$LONG_SHA" --workflow=build-and-push.yaml --json conclusion --jq '.[] | select(.conclusion == "success") | .conclusion' 2>/dev/null | head -1); \
			if [ "$$OK" != "success" ]; then \
				echo ""; \
				echo "✗ No successful CI build found for commit $$LONG_SHA"; \
				echo "   (which has short SHA = $(TAG))"; \
				echo ""; \
				echo "  Likely causes:"; \
				echo "    1. The current commit isn't pushed yet:"; \
				echo "       → git push origin master   (then 'gh run watch')"; \
				echo "    2. CI is still running — wait, or:"; \
				echo "       → gh run watch"; \
				echo "    3. CI failed — investigate:"; \
				echo "       → gh run list --workflow=build-and-push.yaml --limit 3"; \
				echo "    4. You want to deploy a different tag than HEAD:"; \
				echo "       → make deploy svc=$(svc) TAG=latest"; \
				echo "       → make deploy svc=$(svc) TAG=<known-good-sha>"; \
				echo ""; \
				exit 1; \
			fi; \
		fi; \
		echo "→ Deploying app chart packages/$(svc)/helm with image tag $(TAG)"; \
		[ -n "$(strip $(HELM_SET_FROM_ENV))" ] && echo "→ Bridging env: $(HELM_SET_FROM_ENV)" || true; \
		helm upgrade --install $(svc) ./packages/$(svc)/helm \
			--namespace cip-app --create-namespace \
			--set image.tag=$(TAG) \
			$(HELM_SET_FROM_ENV) \
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

# ── Intent extraction layer (Slice 55) ──────────────────────────────────────

extractor-test: ## Run unit tests for all per-tool extractors (placeholder until tests land)
	@echo "TODO: pnpm test for src/intent/extractors — tests not yet authored"

extractor-coverage: ## Show which tools have an extractor (vs which only have planner support)
	@bash scripts/extractor-coverage.sh

extractor-add: ## Scaffold a new extractor file. Usage: make extractor-add tool=foo_bar
	@[ -n "$(tool)" ] || (echo "Error: tool=<name> required"; exit 1)
	@bash scripts/extractor-scaffold.sh $(tool)

# ── Training data — works without sklearn (Slice 55) ────────────────────────

training-data-add: ## Interactive: append a row to manual_examples.csv
	@bash scripts/training-data-add.sh

training-data-stats: ## Per-intent example counts across all sources
	@bash scripts/training-data-stats.sh

training-data-review: ## List unreviewed bot_intent_examples (rows from /teach + turn-label)
	@bash scripts/training-data-review.sh

training-data-mark-reviewed: ## Mark example IDs as reviewed. Usage: make training-data-mark-reviewed ids='id1,id2'
	@[ -n "$(ids)" ] || (echo "Error: ids=<comma-list> required"; exit 1)
	@bash scripts/training-data-mark-reviewed.sh "$(ids)"

training-data-export: ## Merge all sources into packages/intent-classifier/training/training_data.csv
	@bash scripts/training-data-export.sh

training-data-seed-tenant: ## Slice 56D: import manual_examples.csv into bot_intent_training_data tagged with a tenant_id (idempotent). Usage: make training-data-seed-tenant tenant=<uuid>
	@[ -n "$(tenant)" ] || (echo "Error: tenant=<uuid> required (e.g. make training-data-seed-tenant tenant=00000000-0000-0000-0000-000000000001)"; exit 1)
	@bash scripts/training-data-seed-tenant.sh "$(tenant)"

training-data-import-traces: ## Slice 56E (workstation): import Langfuse traces. Needs local Python deps + `make forward`. Optional: days=N tenant=<uuid> dry=1
	@cd packages/intent-classifier && python -m training.import_traces \
	  $(if $(days),--days $(days)) \
	  $(if $(tenant),--tenant-id $(tenant)) \
	  $(if $(dry),--dry-run)

training-data-augment-from-docs: ## Slice 56M: LLM-augment training data from user docs. Required: docs=path/ tenant=<uuid>. Optional: dry=1 max=N
	@[ -n "$(docs)" ]   || (echo "Error: docs=path/to/docs/ required"; exit 1)
	@[ -n "$(tenant)" ] || (echo "Error: tenant=<uuid> required"; exit 1)
	@cd packages/intent-classifier && python -m training.augment_from_docs \
	  --docs "$(docs)" --tenant-id "$(tenant)" \
	  $(if $(max),--max-per-chunk $(max)) \
	  $(if $(dry),--dry-run)

trace-import-now: ## Slice 56E (in-cluster): trigger an ad-hoc trace-import Job from the CronJob spec. No workstation deps needed.
	@JOB="trace-import-manual-$$(date +%s)"; \
	kubectl create job --from=cronjob/intent-classifier-trace-import -n cip-app "$$JOB"; \
	echo "Tail logs with: kubectl logs -n cip-app -f job/$$JOB"

# ── Classifier (Slice 56) ───────────────────────────────────────────────────

classifier-train: ## Train sklearn pipeline on training_data.csv → joblib artifact
	@cd packages/intent-classifier && python -m training.train

classifier-eval: ## Held-out eval. Optional: baseline=path/to/old.joblib for regression gate
	@cd packages/intent-classifier && python -m training.eval $(if $(baseline),--baseline $(baseline))

classifier-deploy: ## Build + push intent-classifier image (code changes only — models hot-reload from S3 since 56B)
	@$(MAKE) ship svc=intent-classifier

classifier-status: ## Slice 56B: latest model run, untrained-row count, live /healthz per pod
	@bash scripts/classifier-status.sh

classifier-retrain-now: ## Slice 56C/D: ad-hoc trainer Job. Optional: tenant=<uuid> for per-tenant retrain
	@JOB="trainer-manual-$$(date +%s)"; \
	if [ -n "$(tenant)" ]; then \
	  JOB="trainer-tenant-$$(echo $(tenant) | head -c 8)-$$(date +%s)"; \
	  echo "→ Per-tenant retrain for $(tenant) → job $$JOB"; \
	  kubectl create job --from=cronjob/intent-classifier-trainer -n cip-app "$$JOB" \
	    --dry-run=client -o yaml \
	    | kubectl set env --local -f - --containers='trainer' "TENANT_ID=$(tenant)" -o yaml \
	    | kubectl apply -f -; \
	else \
	  kubectl create job --from=cronjob/intent-classifier-trainer -n cip-app "$$JOB"; \
	fi; \
	echo "Tail logs with: kubectl logs -n cip-app -f job/$$JOB"
