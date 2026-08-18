#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK="$HERE/e2e/scripts/stack.sh"
TMP_ROOT="$(mktemp -d)"

cleanup() {
  case "$TMP_ROOT" in
    /tmp/*) rm -rf "$TMP_ROOT" ;;
    *) printf 'refusing to remove unexpected temporary path: %s\n' "$TMP_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT

expect_failure() {
  local expected="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    printf 'expected failure, but command succeeded: %s\n' "$*" >&2
    return 1
  fi
  if ! grep -Fq "$expected" <<<"$output"; then
    printf 'failure did not contain %q:\n%s\n' "$expected" "$output" >&2
    return 1
  fi
}

expect_failure "replay bag directory does not exist" \
  env E2E_REPLAY_DATA_DIR="$TMP_ROOT" BAG="myrobot/sample" bash "$STACK" replay-check

mkdir -p "$TMP_ROOT/myrobot/sample"
expect_failure "replay bag has no metadata.yaml" \
  env E2E_REPLAY_DATA_DIR="$TMP_ROOT" BAG="myrobot/sample" bash "$STACK" replay-check

touch "$TMP_ROOT/myrobot/sample/metadata.yaml"
expect_failure "replay bag contains no MCAP file" \
  env E2E_REPLAY_DATA_DIR="$TMP_ROOT" BAG="myrobot/sample" bash "$STACK" replay-check

touch "$TMP_ROOT/myrobot/sample/sample_0.mcap"
output="$({
  E2E_REPLAY_DATA_DIR="$TMP_ROOT" BAG="/data/myrobot/sample" \
    bash "$STACK" replay-check
} 2>&1)"
grep -Fq "replay fixture ready" <<<"$output"
grep -Fq "$TMP_ROOT/myrobot/sample" <<<"$output"

expect_failure "replay bag must resolve under" \
  env E2E_REPLAY_DATA_DIR="$TMP_ROOT" BAG="../outside" bash "$STACK" replay-check

printf 'stack harness fixture checks passed\n'
