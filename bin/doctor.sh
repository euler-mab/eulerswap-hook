#!/usr/bin/env bash
# Preflight check for an Euler-ecosystem repo. Copy into the consuming repo at bin/doctor.sh.
# Run via `make doctor` or `./bin/doctor.sh` directly.

set -u

PASS="\033[32m✓\033[0m"
FAIL="\033[31m✗\033[0m"
WARN="\033[33m!\033[0m"

errors=0

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo -e "  ${PASS} ${name}"
  else
    echo -e "  ${FAIL} ${name}"
    errors=$((errors + 1))
  fi
}

warn() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo -e "  ${PASS} ${name}"
  else
    echo -e "  ${WARN} ${name}  (optional)"
  fi
}

echo "Doctor"
echo

echo "Toolchain"
check "forge installed"              command -v forge
check "git installed"                command -v git
warn  "node installed"               command -v node
warn  "npm installed"                command -v npm

echo
echo "Submodules"
check "submodules initialized"       test -f .gitmodules && [ -z "$(git submodule status | grep '^-' || true)" ]

echo
echo "Environment"
if [ -f .env.example ] && [ ! -f .env ]; then
  echo -e "  ${WARN} .env not found (copy .env.example to .env to start)"
fi

if [ -n "${MAINNET_RPC_URL:-}" ]; then
  echo -e "  ${PASS} MAINNET_RPC_URL set"
else
  echo -e "  ${WARN} MAINNET_RPC_URL not set (needed for fork-test and demo)"
fi

if [ -n "${PRIVATE_KEY:-}" ]; then
  echo -e "  ${WARN} PRIVATE_KEY set (only needed for mainnet broadcasts — avoid leaving exported in your shell)"
else
  echo -e "  ${PASS} PRIVATE_KEY not set (good — only set when broadcasting)"
fi

echo
echo "Build state"
if [ -d contracts ]; then
  check "forge build (contracts/)" sh -c "cd contracts && forge build --offline >/dev/null"
else
  check "forge build" sh -c "forge build --offline >/dev/null"
fi

echo
if [ $errors -eq 0 ]; then
  echo "All required checks passed."
else
  echo "${errors} required check(s) failed."
  exit 1
fi
