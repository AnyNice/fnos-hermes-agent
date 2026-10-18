#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build
TEST_DIR=$(mktemp -d "$PWD/.build/install-test-XXXXXX")
HERMES_SRC="$TEST_DIR/source"
VAR_DIR="$TEST_DIR/var"
VENV_DIR="$TEST_DIR/venv"
LOG_FILE="$TEST_DIR/install.log"
UV="$TEST_DIR/uv"
HERMES="$TEST_DIR/hermes"
mkdir -p "$HERMES_SRC" "$VAR_DIR" "$VENV_DIR/bin"
printf 'project\n' > "$HERMES_SRC/pyproject.toml"
printf 'lock\n' > "$HERMES_SRC/uv.lock"
printf 'stamp\n' > "$HERMES_SRC/install-stamp.json"
printf '#!/bin/bash\nexit 0\n' > "$HERMES"
printf '#!/bin/bash\nexit 42\n' > "$UV"
chmod +x "$HERMES" "$UV"
log_msg() { printf '%s\n' "$*" >> "$LOG_FILE"; }
. config/bootstrap/install-hermes.sh

# A leftover executable must not turn a failed dependency sync into success.
if install_hermes_from_source; then
    echo 'FAIL: failed uv install reported success'; exit 1
fi
if [ -f "$VAR_DIR/hermes-install.id" ]; then
    echo 'FAIL: failed install published a receipt'; exit 1
fi
printf '#!/bin/bash\nexit 0\n' > "$UV"
install_hermes_from_source
hermes_dependencies_current
printf 'changed dependency\n' >> "$HERMES_SRC/pyproject.toml"
if hermes_dependencies_current; then
    echo 'FAIL: changed dependencies reused a stale receipt'; exit 1
fi
echo 'PASS: install failures, successful receipts, and stale dependency detection'
