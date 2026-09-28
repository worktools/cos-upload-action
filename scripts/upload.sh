#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error title=COS upload::%s\n' "$*" >&2
  exit 2
}

require_value() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || fail "Missing required input: ${name}"
}

require_integer() {
  local name="$1" value="$2" min="$3" max="$4"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "${name} must be an integer from ${min} to ${max}"
  (( 10#$value >= min && 10#$value <= max )) || fail "${name} must be an integer from ${min} to ${max}"
}

validate_inputs() {
  require_value source-dir "${COS_UPLOAD_SOURCE_DIR:-}"
  require_value bucket "${COS_UPLOAD_BUCKET:-}"
  require_value prefix "${COS_UPLOAD_PREFIX:-}"
  require_value region "${COS_UPLOAD_REGION:-}"
  require_value secret-id "${COS_UPLOAD_SECRET_ID:-}"
  require_value secret-key "${COS_UPLOAD_SECRET_KEY:-}"

  [[ -d "$COS_UPLOAD_SOURCE_DIR" ]] || fail "source-dir does not exist or is not a directory: ${COS_UPLOAD_SOURCE_DIR}"
  local source_real cwd_real
  source_real="$(cd "$COS_UPLOAD_SOURCE_DIR" && pwd -P)"
  cwd_real="$(pwd -P)"
  [[ "$source_real" != / && "$source_real" != "$cwd_real" ]] || fail 'source-dir must be a dedicated directory, not / or the checkout root'
  [[ -n "$(find "$source_real" -type f -print -quit)" ]] || fail "source-dir contains no regular files: ${COS_UPLOAD_SOURCE_DIR}"
  COS_UPLOAD_SOURCE_REAL="$source_real"

  [[ "$COS_UPLOAD_BUCKET" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail 'bucket contains invalid characters'
  [[ "$COS_UPLOAD_REGION" =~ ^[a-z][a-z0-9-]*$ ]] || fail 'region contains invalid characters'
  [[ "$COS_UPLOAD_PREFIX" != /* && "$COS_UPLOAD_PREFIX" != *//* && "$COS_UPLOAD_PREFIX" != *..* ]] || fail 'prefix must be relative and must not contain // or ..'
  [[ "$COS_UPLOAD_PREFIX" =~ ^[A-Za-z0-9._/-]+$ ]] || fail 'prefix contains invalid characters'
  COS_UPLOAD_PREFIX="${COS_UPLOAD_PREFIX%/}/"

  COS_UPLOAD_ENDPOINT="${COS_UPLOAD_ENDPOINT:-cos.${COS_UPLOAD_REGION}.myqcloud.com}"
  [[ "$COS_UPLOAD_ENDPOINT" =~ ^cos(-internal)?\.[a-z0-9-]+\.myqcloud\.com$ ]] || fail 'endpoint must be a Tencent COS hostname, without a scheme or path'

  COS_UPLOAD_ROUTINES="${COS_UPLOAD_ROUTINES:-3}"
  COS_UPLOAD_THREAD_NUM="${COS_UPLOAD_THREAD_NUM:-5}"
  COS_UPLOAD_PART_SIZE="${COS_UPLOAD_PART_SIZE:-32}"
  COS_UPLOAD_RETRY_COUNT="${COS_UPLOAD_RETRY_COUNT:-5}"
  COS_UPLOAD_FORBID_OVERWRITE="${COS_UPLOAD_FORBID_OVERWRITE:-false}"
  require_integer routines "$COS_UPLOAD_ROUTINES" 1 32
  require_integer thread-num "$COS_UPLOAD_THREAD_NUM" 1 32
  require_integer part-size "$COS_UPLOAD_PART_SIZE" 1 5120
  require_integer retry-count "$COS_UPLOAD_RETRY_COUNT" 0 100
  [[ "$COS_UPLOAD_FORBID_OVERWRITE" == true || "$COS_UPLOAD_FORBID_OVERWRITE" == false ]] || fail 'forbid-overwrite must be true or false'
}

select_binary() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}/${arch}" in
    Linux/x86_64) COSCLI_ASSET=coscli-v1.0.9-linux-amd64; COSCLI_SHA256=a07de5ba2800147a700ed29036b0c76a4229088cee68e1682d0eae19b638a915 ;;
    Linux/aarch64) COSCLI_ASSET=coscli-v1.0.9-linux-arm64; COSCLI_SHA256=5cac5ca3c093f080d6733f4c698c0bdbebdb7b30a6b50835b85de1727b8b6923 ;;
    Darwin/x86_64) COSCLI_ASSET=coscli-v1.0.9-darwin-amd64; COSCLI_SHA256=49a784987010de548b000ba509df28d600dfde3d530b445edb84bc7900d84c73 ;;
    Darwin/arm64) COSCLI_ASSET=coscli-v1.0.9-darwin-arm64; COSCLI_SHA256=cf99d4546e4f2962739c6d25f6e0e7f0b49c94854e2dae237de38d0e8d27c263 ;;
    *) fail "Unsupported runner architecture: ${os}/${arch}; use Linux/macOS x64 or arm64" ;;
  esac
}

diagnose_failure() {
  local error_dir="$1" codes
  codes="$(grep -RohE 'AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId|NoSuchBucket|RequestTimeTooSkewed|<Code>[A-Za-z0-9]+</Code>' "$error_dir" 2>/dev/null | sort -u | head -20 || true)"
  if [[ -n "$codes" ]]; then
    printf 'COS error codes: %s\n' "$(printf '%s' "$codes" | tr '\n' ' ')" >&2
  fi
  case "$codes" in
    *AccessDenied*) printf 'Hint: check bucket and prefix IAM permissions for upload and multipart operations.\n' >&2 ;;
    *SignatureDoesNotMatch*|*InvalidAccessKeyId*) printf 'Hint: check SecretId, SecretKey, temporary token, and region.\n' >&2 ;;
    *NoSuchBucket*) printf 'Hint: check bucket name (including APPID) and region.\n' >&2 ;;
  esac
  fail 'COSCLI reported failed uploads; no downstream deployment should proceed'
}

main() {
  validate_inputs
  local destination="cos://${COS_UPLOAD_BUCKET}/${COS_UPLOAD_PREFIX}"
  printf 'Source: %s\nDestination: %s\nRegion: %s\n' "$COS_UPLOAD_SOURCE_DIR" "$destination" "$COS_UPLOAD_REGION"
  if [[ "${1:-}" == --validate-only ]]; then
    return 0
  fi

  select_binary
  local temp_dir cli_path actual_sha error_dir
  temp_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/cos-upload.XXXXXX")"
  cli_path="${temp_dir}/coscli"
  error_dir="${temp_dir}/errors"
  curl --fail --location --retry 3 --silent --show-error \
    "https://github.com/tencentyun/coscli/releases/download/v1.0.9/${COSCLI_ASSET}" \
    --output "$cli_path" || fail 'Unable to download COSCLI v1.0.9 from the official release'
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha="$(sha256sum "$cli_path" | cut -d ' ' -f 1)"
  else
    actual_sha="$(shasum -a 256 "$cli_path" | cut -d ' ' -f 1)"
  fi
  [[ "$actual_sha" == "$COSCLI_SHA256" ]] || fail "COSCLI SHA-256 mismatch for ${COSCLI_ASSET}"
  chmod 755 "$cli_path"

  local -a args=(cp "${COS_UPLOAD_SOURCE_REAL}/" "$destination" --recursive --skip-dir \
    --init-skip --disable-log --process-log=false --fail-output-path "$error_dir" \
    --endpoint "$COS_UPLOAD_ENDPOINT" --secret-id "$COS_UPLOAD_SECRET_ID" --secret-key "$COS_UPLOAD_SECRET_KEY" \
    --routines "$COS_UPLOAD_ROUTINES" --thread-num "$COS_UPLOAD_THREAD_NUM" \
    --part-size "$COS_UPLOAD_PART_SIZE" --err-retry-num "$COS_UPLOAD_RETRY_COUNT")
  [[ -z "${COS_UPLOAD_SESSION_TOKEN:-}" ]] || args+=(--token "$COS_UPLOAD_SESSION_TOKEN")
  [[ -z "${COS_UPLOAD_INCLUDE:-}" ]] || args+=(--include "$COS_UPLOAD_INCLUDE")
  [[ -z "${COS_UPLOAD_EXCLUDE:-}" ]] || args+=(--exclude "$COS_UPLOAD_EXCLUDE")
  [[ -z "${COS_UPLOAD_STORAGE_CLASS:-}" ]] || args+=(--storage-class "$COS_UPLOAD_STORAGE_CLASS")
  [[ -z "${COS_UPLOAD_METADATA:-}" ]] || args+=(--meta "$COS_UPLOAD_METADATA")
  [[ "$COS_UPLOAD_FORBID_OVERWRITE" == false ]] || args+=(--forbid-overwrite)

  if ! "$cli_path" "${args[@]}"; then
    diagnose_failure "$error_dir"
  fi
  printf 'COS upload completed: %s\n' "$destination"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'destination=%s\n' "$destination" >> "$GITHUB_OUTPUT"
  fi
}

main "$@"
