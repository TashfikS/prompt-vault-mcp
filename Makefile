.PHONY: help setup dev-backend dev-frontend test test-backend test-frontend typecheck lint ui-guardrails build docker-build docker-up docker-down ci clean

PYTHON := $(shell if [ -x .venv/bin/python ]; then echo .venv/bin/python; else echo python3; fi)
PYTEST := $(shell if [ -x .venv/bin/pytest ]; then echo .venv/bin/pytest; else echo pytest; fi)

help: ## Show all available automation commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## Install Python (.venv) and Node.js (frontend) dependencies
	python3 -m venv .venv
	.venv/bin/pip install --upgrade pip
	.venv/bin/pip install -r backend/requirements.txt
	cd frontend && npm ci

dev-backend: ## Run FastAPI + FastMCP backend server with hot reload on port 8000
	cd backend && ../$(PYTHON) -m uvicorn main:app --reload --host 0.0.0.0 --port 8000

dev-frontend: ## Run Vite React frontend dev server on port 5173
	cd frontend && npm run dev -- --host 0.0.0.0 --port 5173

test-backend: ## Run backend pytest unit & integration suite
	$(PYTEST) backend/tests -v

test-frontend: ## Run frontend unit & diff engine tests
	cd frontend && npm test

typecheck: ## Run TypeScript compiler type check (0 errors required)
	cd frontend && npx tsc -b --noEmit

ui-guardrails: ## Verify AGENTS.md Rule #5 (no native <select>, <datalist>, alert/confirm/prompt)
	@if grep -rnE "<select|<datalist|window\.(alert|confirm|prompt)\(" frontend/src/; then \
		echo "ERROR: Native OS select/datalist or browser dialog found in frontend/src/"; \
		exit 1; \
	fi
	@echo "✔ UI Guardrails passed: 0 native OS dialogs or <select>/<datalist> elements."

lint: ui-guardrails typecheck ## Run backend bytecode syntax check, UI guardrails, and TypeScript check
	$(PYTHON) -m py_compile backend/*.py backend/services/*.py backend/routers/*.py backend/tests/*.py
	@echo "✔ Python bytecode syntax check passed."

build: ## Build production frontend static bundle into frontend/dist
	cd frontend && npm run build

test: ## Run full automated test script (backend + frontend + TypeScript + UI guardrails)
	./run_tests.sh

ci: lint test build ## Run the complete local CI pipeline (lint + guardrails + tests + production build)
	@echo "✔ Full CI pipeline completed with 0 errors!"

docker-build: ## Build multi-stage production Docker image
	docker build -t promptfolders-mcp:latest .

docker-up: ## Start full production stack (App + PostgreSQL 16 + Redis 7) via Docker Compose
	docker compose up --build -d

docker-down: ## Stop Docker Compose stack
	docker compose down

clean: ## Remove build artifacts and temporary test caches
	rm -rf frontend/dist backend/.pytest_cache .pytest_cache backend/__pycache__ backend/tests/__pycache__
