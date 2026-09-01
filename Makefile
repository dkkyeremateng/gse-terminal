# GSE Terminal — build, test, deploy, and operate
#
# Usage:
#   make build              Build Docker image (no push)
#   make push               Build + push to Artifact Registry
#   make push TAG=v1.2      Build + push with explicit tag
#   make deploy             Test, build, push, apply manifests, and roll out to K8s
#   make deploy TAG=v1.2    Deploy with explicit tag
#   make rollout            Wait for both Deployments to finish rolling
#   make k8s-apply          Render manifests with current TAG and apply (no rollout-wait)
#   make k8s-diff           Show what `make k8s-apply` would change vs. the live cluster
#   make k8s-image          Show currently running image SHA on each Deployment
#   make k8s-rollback       Roll both Deployments back one revision
#   make k8s-status         Show pod/service status
#   make dev                Start local Go server
#   make test               Run all Go tests
#   make ui                 Build UI assets only
#   make clean              Remove build artifacts
#
# Image substitution:
#   The committed manifests use `__IMAGE_TAG__` as a placeholder. `make deploy`
#   and CI substitute it with the actual SHA at apply time. Running
#   `kubectl apply -f k8s/app.yaml` directly will fail with ImagePullBackOff,
#   which is intentional — it forces deploys through the pipeline.
#
# Audit annotations:
#   Each Deployment gets `deploy-attempted-at` set before rollout and
#   `deploy-succeeded-at` set after. If the two diverge (or only the first
#   exists), the most recent attempt did not complete cleanly.

# Sequential prerequisite execution. The deploy target chains test → build →
# push → apply → rollout, and parallel make would race them catastrophically.
.NOTPARALLEL:

# ── Configuration ───────────────────────────────────────────────────────
REGISTRY         := us-central1-docker.pkg.dev
PROJECT          := teckdroids
REPO             := gse
IMAGE_NAME       := gse-terminal
TAG              ?= $(shell git rev-parse --short HEAD 2>/dev/null)
IMAGE            := $(REGISTRY)/$(PROJECT)/$(REPO)/$(IMAGE_NAME):$(TAG)
K8S_DIR          := k8s
NAMESPACE        := gse-terminal
APP_DEPLOYMENTS  := gse-app gse-app-spot
ROLLOUT_TIMEOUT  := 300s
EXPECTED_CONTEXT := gke_teckdroids_us-central1_gse-terminal

ifeq ($(TAG),)
$(error TAG is empty — `git rev-parse --short HEAD` returned nothing. Are you in a git repo with at least one commit?)
endif

.PHONY: build push deploy rollout \
        k8s-apply k8s-diff k8s-image k8s-rollback k8s-status k8s-logs k8s-restart k8s-describe \
        dev dev-ui ui go-build test lint clean help \
        guard-clean-tree guard-on-main guard-kubectl-context guard-auth \
        audit-deploy-attempted audit-deploy-succeeded

# ── Docker ──────────────────────────────────────────────────────────────

build: ## Build Docker image locally
	docker build \
		--platform linux/amd64 \
		--tag $(IMAGE) \
		--build-arg BUILDKIT_INLINE_CACHE=1 \
		.
	@echo "Built: $(IMAGE)"

push: build ## Build + push to Artifact Registry
	docker push $(IMAGE)
	@echo "Pushed: $(IMAGE)"

# ── Kubernetes ──────────────────────────────────────────────────────────

deploy: guard-clean-tree guard-on-main guard-kubectl-context guard-auth test build push k8s-apply audit-deploy-attempted rollout audit-deploy-succeeded ## Test, build, push, apply, and roll out

k8s-apply: ## Render manifests with current TAG and apply via kustomize
	@echo "==> Applying manifests with TAG=$(TAG)"
	kubectl kustomize $(K8S_DIR) \
		| sed "s|__IMAGE_TAG__|$(TAG)|g" \
		| kubectl apply -f -

k8s-diff: ## Show what `make k8s-apply` would change vs. the live cluster
	@kubectl kustomize $(K8S_DIR) \
		| sed "s|__IMAGE_TAG__|$(TAG)|g" \
		| kubectl diff -f - || true

k8s-image: ## Show currently running image SHA on each Deployment
	@kubectl get deploy -n $(NAMESPACE) \
		-o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.template.spec.containers[0].image}{"\n"}{end}'

k8s-rollback: ## Roll both Deployments back one revision
	@for d in $(APP_DEPLOYMENTS); do \
		kubectl rollout undo deployment/$$d -n $(NAMESPACE); \
	done
	@$(MAKE) rollout

rollout: ## Wait for both app Deployments to finish rolling
	@for d in $(APP_DEPLOYMENTS); do \
		echo "==> Waiting on rollout: $$d"; \
		kubectl rollout status deployment/$$d -n $(NAMESPACE) --timeout=$(ROLLOUT_TIMEOUT) || exit 1; \
	done
	@echo "Rolled out: $(IMAGE)"

# Stamp "deploy attempted" annotations after apply but before rollout finishes.
# If rollout fails, the attempt is recorded without a corresponding
# `deploy-succeeded-at`, which makes failed deploys visible via
# `kubectl describe deploy`.
audit-deploy-attempted:
	@deployer="$${USER:-$$(git config user.email 2>/dev/null || echo unknown)}"; \
	for d in $(APP_DEPLOYMENTS); do \
		kubectl annotate deployment/$$d -n $(NAMESPACE) \
			deploy-attempted-at="$$(date -u +%FT%TZ)" \
			deploy-status="in-progress" \
			deployer="$$deployer" \
			source-tag="$(TAG)" \
			--overwrite >/dev/null; \
	done

audit-deploy-succeeded:
	@for d in $(APP_DEPLOYMENTS); do \
		kubectl annotate deployment/$$d -n $(NAMESPACE) \
			deploy-succeeded-at="$$(date -u +%FT%TZ)" \
			deploy-status="succeeded" \
			--overwrite >/dev/null; \
	done
	@echo "Annotated: deployer=$${USER:-unknown} tag=$(TAG)"

k8s-status: ## Show pods, services, and deployments
	@echo "==> Pods"
	@kubectl get pods -n $(NAMESPACE) -o wide
	@echo ""
	@echo "==> Services"
	@kubectl get svc -n $(NAMESPACE)
	@echo ""
	@echo "==> Deployments"
	@kubectl get deploy -n $(NAMESPACE)

k8s-logs: ## Tail logs from the gse-app Deployment
	kubectl logs -f deployment/gse-app -n $(NAMESPACE) --tail=100

k8s-restart: ## Restart both app Deployments (rolling)
	@for d in $(APP_DEPLOYMENTS); do \
		kubectl rollout restart deployment/$$d -n $(NAMESPACE); \
	done
	@$(MAKE) rollout

k8s-describe: ## Describe the gse-app Deployment (events, conditions)
	kubectl describe deployment/gse-app -n $(NAMESPACE)

# ── Guards ──────────────────────────────────────────────────────────────

guard-clean-tree:
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Error: working tree is dirty. Commit or stash first."; \
		git status --short; \
		exit 1; \
	fi

guard-on-main:
	@branch=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$branch" != "main" ]; then \
		printf "Not on main (currently on %s). Continue? [y/N] " "$$branch"; \
		read ans; \
		case "$$ans" in y|Y) ;; *) echo "Aborted."; exit 1;; esac; \
	fi

guard-kubectl-context:
	@ctx=$$(kubectl config current-context 2>/dev/null); \
	if [ "$$ctx" != "$(EXPECTED_CONTEXT)" ]; then \
		echo "Error: kubectl context is '$$ctx', expected '$(EXPECTED_CONTEXT)'."; \
		echo "Run: kubectl config use-context $(EXPECTED_CONTEXT)"; \
		echo "Or fetch credentials: gcloud container clusters get-credentials gse-terminal --region=us-central1 --project=teckdroids"; \
		exit 1; \
	fi

guard-auth:
	@kubectl auth can-i get pods -n $(NAMESPACE) >/dev/null 2>&1 \
		|| { echo "Error: kubectl not authenticated to $(EXPECTED_CONTEXT) (or no permissions on namespace $(NAMESPACE))."; exit 1; }
	@gcloud auth print-access-token >/dev/null 2>&1 \
		|| { echo "Error: gcloud not authenticated. Run: gcloud auth login"; exit 1; }

# ── Local development ───────────────────────────────────────────────────

PROD_COMPOSE := -f docker-compose.yaml -f docker-compose.prod.yaml

vm-up: ## Bring up the production stack on a VM (Caddy + TLS)
	docker compose $(PROD_COMPOSE) up -d --build

vm-down: ## Stop the production stack (volumes are preserved)
	docker compose $(PROD_COMPOSE) down

vm-logs: ## Tail the app log
	docker compose $(PROD_COMPOSE) logs -f app

vm-ps: ## Show stack status
	docker compose $(PROD_COMPOSE) ps

vm-config: ## Render the merged production config (validates .env)
	docker compose $(PROD_COMPOSE) config

backup: ## Back up Postgres + QuestDB to ./backups
	./scripts/backup.sh

dev: ui ## Start Go server (reads from ui/dist/)
	APP_ENV=development go run ./cmd/server

dev-ui: ## Start Vite dev server with HMR (use with 'make dev' in another terminal)
	cd ui && npm run dev

ui: ## Build UI assets (Tailwind + Vite)
	cd ui && npm run build

go-build: ## Build Go binary locally
	go build -o server ./cmd/server

# ── Testing ─────────────────────────────────────────────────────────────

test: ## Run all Go tests (with race detector, matching CI)
	go test ./... -race -count=1 -timeout=5m

lint: ## Run go vet
	go vet ./...

# ── Cleanup ─────────────────────────────────────────────────────────────

clean: ## Remove build artifacts
	rm -f server
	rm -rf ui/dist

# ── Help ────────────────────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | \
		sort | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
