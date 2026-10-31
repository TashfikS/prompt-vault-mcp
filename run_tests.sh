#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo " Running PromptFolders Automated Test & Verification Suite"
echo "=========================================================="

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Backend Python Bytecode & Syntax Check
echo ""
echo "[1/5] Verifying Backend Python Syntax..."
cd "$ROOT_DIR"
if [ -x "$ROOT_DIR/.venv/bin/pytest" ] && "$ROOT_DIR/.venv/bin/python" --version >/dev/null 2>&1; then
    PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
    PYTEST_CMD=("$ROOT_DIR/.venv/bin/pytest")
else
    PYTHON_BIN="python3"
    export PYTHONPATH="$ROOT_DIR/.venv/lib/python3.15/site-packages:$ROOT_DIR/backend:${PYTHONPATH:-}"
    PYTEST_CMD=("python3" "-m" "pytest")
fi
"$PYTHON_BIN" -m py_compile backend/*.py backend/services/*.py backend/routers/*.py backend/tests/*.py

# 2. Backend Pytest Suite
echo ""
echo "[2/5] Running Backend RBAC, Cache, Feedback & MCP Unit + Integration Tests..."
cd "$ROOT_DIR/backend"
"${PYTEST_CMD[@]}" -v

# 3. Frontend UI Guardrails (AGENTS.md Rule #5)
echo ""
echo "[3/5] Checking Frontend UI Guardrails (No native <select>, <datalist>, alert/confirm/prompt)..."
cd "$ROOT_DIR"
if grep -rnE "<select|<datalist|window\.(alert|confirm|prompt)\(" frontend/src/; then
    echo "ERROR: Native OS select/datalist or browser dialog found in frontend/src/ (violates AGENTS.md Rule #5)"
    exit 1
fi
echo "✔ Zero native OS widgets or dialogs detected."

# 4. Frontend Unit Tests (Node native test runner)
echo ""
echo "[4/5] Running Frontend Unit & Diff Engine Tests..."
cd "$ROOT_DIR/frontend"
npm test

# 5. TypeScript Compiler Check
echo ""
echo "[5/5] Running TypeScript Type Check (npx tsc -b --noEmit)..."
npx tsc -b --noEmit

echo ""
echo "=========================================================="
echo " ALL 5 VERIFICATION STAGES PASSED SUCCESSFULLY! (100%)"
echo "=========================================================="
