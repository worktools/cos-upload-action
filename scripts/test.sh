#!/usr/bin/env bash
set -euo pipefail

action_root="$(cd "$(dirname "$0")/.." && pwd -P)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/cos-upload-test.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/dist"
printf 'test\n' > "$fixture/dist/index.html"

export COS_UPLOAD_SOURCE_DIR="$fixture/dist"
export COS_UPLOAD_BUCKET=example-1250000000
export COS_UPLOAD_PREFIX=worktools/example/pr
export COS_UPLOAD_REGION=ap-shanghai
export COS_UPLOAD_SECRET_ID=example-id
export COS_UPLOAD_SECRET_KEY=example-key

output="$(bash "$action_root/scripts/upload.sh" --validate-only)"
[[ "$output" == *'cos://example-1250000000/worktools/example/pr/'* ]] || { echo 'Expected normalized COS destination'; exit 1; }

expect_failure() {
  local expected="$1" output
  shift
  if output="$(env "$@" bash "$action_root/scripts/upload.sh" --validate-only 2>&1)"; then
    printf 'Expected failure: %s\n' "$expected" >&2
    exit 1
  fi
  [[ "$output" == *"$expected"* ]] || { printf 'Missing error %s in %s\n' "$expected" "$output" >&2; exit 1; }
}

expect_failure 'source-dir does not exist' COS_UPLOAD_SOURCE_DIR="$fixture/missing"
expect_failure 'source-dir must be a dedicated directory' COS_UPLOAD_SOURCE_DIR="$action_root"
expect_failure 'prefix must be relative' COS_UPLOAD_PREFIX=../outside
expect_failure 'Missing required input: secret-key' COS_UPLOAD_SECRET_KEY=
expect_failure 'routines must be an integer' COS_UPLOAD_ROUTINES=zero
expect_failure 'endpoint must be a Tencent COS hostname' COS_UPLOAD_ENDPOINT=https://example.com

printf 'COS upload input validation tests passed\n'
