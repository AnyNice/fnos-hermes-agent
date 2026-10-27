#!/bin/bash
# Tests for config/bootstrap/sudoers-grant.sh (install_sudoers_grant).
# Covers: root direct write, non-root degradation (pending + repair command),
# skip when complete, rewrite when incomplete, and idempotency.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build
TEST_DIR=$(mktemp -d "$PWD/.build/sudoers-test-XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT

VARDIR="$TEST_DIR/var"
ETC="$TEST_DIR/etc-sudoers.d"
LOG="$TEST_DIR/info.log"
mkdir -p "$VARDIR" "$ETC"

# Test doubles
export TRIM_USERNAME="hermes-agent"
export TRIM_PKGVAR="$VARDIR"
export SUDOERS_FILE="$ETC/hermes-appcenter"
export SUDOERS_PENDING_DIR="$VARDIR/sudoers-pending"
log_msg() { printf '%s\n' "$1" >> "$LOG"; }

. config/bootstrap/sudoers-grant.sh

fail() { echo "FAIL: $*"; exit 1; }

# --- Case A: non-root, no grant yet -> pending file + repair command, no crash
export SUDOERS_GRANT_UID=1000
: > "$LOG"
install_sudoers_grant
[ -f "$SUDOERS_PENDING_DIR/hermes-appcenter" ] || fail "A: pending file not created"
grep -q 'chown' "$SUDOERS_PENDING_DIR/hermes-appcenter" || fail "A: pending content missing chown rule"
grep -q '^hermes-agent ' "$SUDOERS_PENDING_DIR/hermes-appcenter" || fail "A: pending content missing grantee user"
grep -q 'sudoers 写入失败' "$LOG" || fail "A: failure not logged"
grep -q 'visudo -c' "$LOG" || fail "A: repair command not logged"
[ ! -f "$SUDOERS_FILE" ] || fail "A: target file must not appear without root"

# --- Case B: root -> direct write of the target file
export SUDOERS_GRANT_UID=0
rm -rf "$SUDOERS_PENDING_DIR"; : > "$LOG"
install_sudoers_grant
[ -f "$SUDOERS_FILE" ] || fail "B: target sudoers file not created as root"
grep -q '^hermes-agent ALL=(root) NOPASSWD:' "$SUDOERS_FILE" || fail "B: target content wrong"
grep -q 'chown' "$SUDOERS_FILE" || fail "B: target content missing chown"
grep -q 'sudoers 写入成功' "$LOG" || fail "B: success not logged"

# --- Case C: complete grant present -> skip (no rewrite, no pending)
before=$(cat "$SUDOERS_FILE")
rm -rf "$SUDOERS_PENDING_DIR"; : > "$LOG"
install_sudoers_grant
[ "$(cat "$SUDOERS_FILE")" = "$before" ] || fail "C: complete file was modified"
grep -q '已存在且完整' "$LOG" || fail "C: skip not logged"
[ ! -d "$SUDOERS_PENDING_DIR" ] || fail "C: pending dir must not be created on skip"

# --- Case D: incomplete legacy grant (no chown) + root -> rewritten
printf 'hermes-agent ALL=(root) NOPASSWD: /bin/cp, /usr/bin/cp, /usr/bin/sudo -u postgres /usr/bin/psql -d appcenter *\n' > "$SUDOERS_FILE"
: > "$LOG"
install_sudoers_grant
grep -q 'chown' "$SUDOERS_FILE" || fail "D: incomplete legacy file not rewritten with chown"
grep -q 'sudoers 写入成功' "$LOG" || fail "D: rewrite not logged as success"

# --- Case E: idempotency after a successful root write
: > "$LOG"
install_sudoers_grant
grep -q '已存在且完整' "$LOG" || fail "E: second run should skip"

# --- Case F: custom TRIM_USERNAME is used as the grantee
printf 'other ALL=(root) NOPASSWD: /bin/cp\n' > "$SUDOERS_FILE"
export TRIM_USERNAME="hermes-agent"  # file grants a different user -> incomplete for us
: > "$LOG"
export SUDOERS_GRANT_UID=0
install_sudoers_grant
grep -q '^hermes-agent ' "$SUDOERS_FILE" || fail "F: grantee user not (re)written"

echo "PASS: sudoers-grant root/skip/rewrite/pending cases (A-F)"
