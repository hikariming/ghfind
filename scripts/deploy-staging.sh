#!/usr/bin/env bash
# Deploy the staging Go backend stack to Railway: rabbitmq, mock libsql db,
# mocks (Upstash REST mock + schema provisioning), api and worker. Idempotent
# for the service inventory: services that already exist are reused.
#
# Usage:
#   GHFIND_STAGING_PROJECT=ghfind-staging \
#   GHFIND_STAGING_LLM_KEY=... \
#   GHFIND_STAGING_GITHUB_TOKEN=... \   # single PAT or comma-separated pool
#   GHFIND_STAGING_SITE_URL=https://staging.ghfind.com \
#   GHFIND_STAGING_MOSOO_TOKEN=... \    # optional; Mosoo Public Thread API token
#   GHFIND_STAGING_MOSOO_AGENT_ID=... \ # optional; Mosoo project analysis Agent id
#   GHFIND_STAGING_MOSOO_USER_ID=... \  # optional; defaults to "ghfind"
#   ./scripts/deploy-staging.sh
#
# Production-store mode: set GHFIND_STAGING_TURSO_URL / GHFIND_STAGING_TURSO_TOKEN
# and GHFIND_STAGING_UPSTASH_URL / GHFIND_STAGING_UPSTASH_TOKEN to point the API
# and worker at the real Turso/Upstash instead of the in-project mocks; the
# libsql and mocks services are then skipped entirely.
#
# Requires: railway CLI >= 5.30, logged in (railway whoami).
# Secrets are passed via environment, never written to files.
# Without the two Mosoo variables the project analysis worker stays deployed
# but analyses fail fast with mosoo_unauthenticated/mosoo_not_ready.

set -euo pipefail

PROJECT="${GHFIND_STAGING_PROJECT:-ghfind-staging}"
LIBSQL_IMAGE="ghcr.io/tursodatabase/libsql-server:latest"
RABBIT_IMAGE="rabbitmq:3.13-management-alpine"
LLM_KEY="${GHFIND_STAGING_LLM_KEY:-}"
GITHUB_TOKEN_VALUE="${GHFIND_STAGING_GITHUB_TOKEN:-}"

railway() { command railway "$@"; }

ensure_project() {
  if ! railway project list --json 2>/dev/null | grep -q "\"name\": \"$PROJECT\""; then
    echo "==> Creating project $PROJECT"
    railway init --name "$PROJECT"
  fi
  if ! railway status --json 2>/dev/null | grep -q "\"project\": \"$PROJECT\""; then
    echo "==> Linking project $PROJECT"
    railway link --project "$PROJECT"
  fi
}

service_exists() {
  local name="$1"
  railway service list --json 2>/dev/null | python3 -c "
import json, sys
try:
    services = json.load(sys.stdin)
except Exception:
    sys.exit(1)
names = [s.get('name') or s.get('serviceName') for s in services] if isinstance(services, list) else []
sys.exit(0 if '$name' in names else 1)
"
}

ensure_service() {
  local name="$1"
  local image="${2:-}"
  if ! service_exists "$name"; then
    echo "==> Creating service $name"
    if [ -n "$image" ]; then
      railway add --service "$name" --image "$image"
    else
      railway add --service "$name"
    fi
  fi
}

set_variables() {
  local service="$1"
  shift
  local args=()
  for entry in "$@"; do
    case "$entry" in
      *=) : ;; # skip empty values (CLI rejects them)
      *) args+=("$entry") ;;
    esac
  done
  echo "==> Variables for $service"
  railway variable set --service "$service" "${args[@]}"
}

deploy_service() {
  local service="$1"
  local message="$2"
  echo "==> Deploying $service"
  # The source upload times out while Railway is still building the
  # redeploy triggered by the variable changes above; back off long enough
  # for the build slot to free up. Attempts are idempotent — a new
  # deployment just supersedes the stale one.
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if railway up --service "$service" --detach -m "$message"; then
      return 0
    fi
    echo "==> Upload $service attempt $attempt failed; retrying in 45s"
    sleep 45
  done
  echo "==> Upload $service failed after 4 attempts"
  return 1
}

service_var() {
  railway variables --service "$1" --json 2>/dev/null | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('$2') or '')
except Exception:
    print('')
"
}

ensure_domain() {
  local service="$1"
  local port="$2"
  if [ -n "$(service_var "$service" RAILWAY_PUBLIC_DOMAIN)" ]; then
    echo "==> Domain for $service already exists, skipping"
    return
  fi
  echo "==> Creating domain for $service (port $port)"
  railway domain --service "$service" --port "$port" >/dev/null
}

latest_deployment_status() {
  railway deployment list --service "$1" --json 2>/dev/null | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin)[0].get('status') or '')
except Exception:
    print('')
"
}

wait_deployed() {
  local service="$1"
  local deadline=$((SECONDS + 600))
  printf "==> Waiting for %s deploy" "$service"
  while [ $SECONDS -lt $deadline ]; do
    case "$(latest_deployment_status "$service")" in
      SUCCESS) echo " SUCCESS"; return 0 ;;
      FAILED|CRASHED) echo " FAILED"; return 1 ;;
    esac
    printf "."
    sleep 15
  done
  echo " TIMEOUT"
  return 1
}

wait_ready() {
  local label="$1"
  local url="$2"
  local deadline=$((SECONDS + 300))
  printf "==> Waiting for %s readiness" "$label"
  while [ $SECONDS -lt $deadline ]; do
    if [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url")" = "200" ]; then
      echo " READY"
      return 0
    fi
    printf "."
    sleep 10
  done
  echo " TIMEOUT"
  return 1
}

main() {
  ensure_project

  ensure_service ghfind-rabbitmq "$RABBIT_IMAGE"
  ensure_service ghfind-api
  ensure_service ghfind-worker

  # Production-store mode: real Turso/Upstash instead of in-project mocks.
  # The libsql and mocks services are only provisioned in mock mode.
  local store_turso_url="http://\${{ghfind-libsql.RAILWAY_PRIVATE_DOMAIN}}:8080"
  local store_turso_token=""
  local store_upstash_url="http://\${{ghfind-mocks.RAILWAY_PRIVATE_DOMAIN}}:8080"
  local store_upstash_token="staging-mock-token"
  if [ -n "${GHFIND_STAGING_TURSO_URL:-}" ] && [ -n "${GHFIND_STAGING_UPSTASH_URL:-}" ]; then
    echo "==> Production-store mode: real Turso/Upstash"
    store_turso_url="${GHFIND_STAGING_TURSO_URL}"
    store_turso_token="${GHFIND_STAGING_TURSO_TOKEN:-}"
    store_upstash_url="${GHFIND_STAGING_UPSTASH_URL}"
    store_upstash_token="${GHFIND_STAGING_UPSTASH_TOKEN:-}"
  else
    ensure_service ghfind-libsql "$LIBSQL_IMAGE"
    ensure_service ghfind-mocks
    set_variables ghfind-mocks \
      "GHFIND_ROLE=mocks" \
      "TURSO_DATABASE_URL=http://\${{ghfind-libsql.RAILWAY_PRIVATE_DOMAIN}}:8080"
  fi

  set_variables ghfind-rabbitmq \
    "RABBITMQ_DEFAULT_USER=ghfind" \
    "RABBITMQ_DEFAULT_PASS=staging-ghfind-local-only" \
    "RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=-rabbitmq_management_agent disable_metrics_collector false"

  echo "==> Volumes"
  # The CLI scopes volume add to the linked service; `|| true` keeps the free
  # trial plan (no volumes) non-fatal. Volumes make the broker message store
  # and the mock DB survive restarts on paid plans.
  (railway service ghfind-rabbitmq && railway volume add --mount-path /var/lib/rabbitmq) 2>/dev/null || true
  if [ -z "${GHFIND_STAGING_TURSO_URL:-}" ]; then
    (railway service ghfind-libsql && railway volume add --mount-path /data) 2>/dev/null || true
  fi

  # API and worker share the backend secrets; OAuth stays disabled on staging.
  # Mocks listens on the Railway-injected PORT (8080); never override PORT on
  # it. API/worker must point Upstash at that same injected port.
  # PUBLIC_SITE_URL must equal the staging frontend origin so canonical
  # profile URLs and the deployment-smoke origin check line up.
  local shared=(
    "RABBITMQ_URL=amqp://ghfind:staging-ghfind-local-only@\${{ghfind-rabbitmq.RAILWAY_PRIVATE_DOMAIN}}:5672"
    "TURSO_DATABASE_URL=${store_turso_url}"
    "TURSO_AUTH_TOKEN=${store_turso_token}"
    "UPSTASH_REDIS_REST_URL=${store_upstash_url}"
    "UPSTASH_REDIS_REST_TOKEN=${store_upstash_token}"
    "GHFIND_OAUTH_ENABLED=0"
    "PUBLIC_SITE_URL=${GHFIND_STAGING_SITE_URL:-https://staging.ghfind.com}"
  )
  # Mosoo credentials are optional on staging: empty values are skipped by
  # set_variables, and the worker reports the standard Mosoo error codes.
  local mosoo=(
    "MOSOO_API_BASE=${GHFIND_STAGING_MOSOO_API_BASE:-https://try.mosoo.ai/api/v1}"
    "MOSOO_API_TOKEN=${GHFIND_STAGING_MOSOO_TOKEN:-}"
    "MOSOO_PROJECT_AGENT_ID=${GHFIND_STAGING_MOSOO_AGENT_ID:-}"
    "MOSOO_PROJECT_USER_ID=${GHFIND_STAGING_MOSOO_USER_ID:-ghfind}"
  )
  set_variables ghfind-api "${shared[@]}" "${mosoo[@]}" \
    "GHFIND_ROLE=api" \
    "ADMIN_SECRET=staging-admin-secret" \
    "GITHUB_ROAST_CLI_API_KEY=staging-cli-key" \
    "PROJECT_ANALYSIS_RECONCILE_SECRET=staging-reconcile-secret" \
    "LLM_API_KEY=${LLM_KEY}" \
    "LLM_BASE_URL=https://api.stepfun.com/v1" \
    "LLM_MODEL=step-3.7-flash"
  set_variables ghfind-worker "${shared[@]}" "${mosoo[@]}" \
    "GHFIND_ROLE=worker" \
    "GITHUB_TOKEN=${GITHUB_TOKEN_VALUE}"

  echo "==> Deploying stack"
  deploy_service ghfind-api "staging api"
  deploy_service ghfind-worker "staging worker"
  if [ -z "${GHFIND_STAGING_TURSO_URL:-}" ]; then
    deploy_service ghfind-mocks "staging mocks"
  fi

  ensure_domain ghfind-api 8080
  ensure_domain ghfind-worker 9090
  ensure_domain ghfind-rabbitmq 15672

  wait_deployed ghfind-api
  wait_deployed ghfind-worker
  if [ -z "${GHFIND_STAGING_TURSO_URL:-}" ]; then
    wait_deployed ghfind-mocks
  fi

  local api_domain worker_domain rabbit_domain
  api_domain="$(service_var ghfind-api RAILWAY_PUBLIC_DOMAIN)"
  worker_domain="$(service_var ghfind-worker RAILWAY_PUBLIC_DOMAIN)"
  rabbit_domain="$(service_var ghfind-rabbitmq RAILWAY_PUBLIC_DOMAIN)"

  wait_ready "api" "https://${api_domain}/readyz"
  wait_ready "worker" "https://${worker_domain}/readyz"

  cat <<EOF
==> Staging backend is live.

  API:      https://${api_domain}
  Worker:   https://${worker_domain}
  RabbitMQ: https://${rabbit_domain} (management, ghfind / staging-ghfind-local-only)

Smoke the stack:

  export SMOKE_BASE_URL=https://${api_domain} \\
    SMOKE_BACKEND_BASE_URL=https://${api_domain} \\
    SMOKE_WORKER_METRICS_BASE_URL=https://${worker_domain} \\
    SMOKE_MACHINE_API_KEY=staging-cli-key SMOKE_ALLOW_HTTP=1 \\
    SMOKE_RABBITMQ_MANAGEMENT_URL=https://${rabbit_domain} \\
    SMOKE_RABBITMQ_MANAGEMENT_USER=ghfind \\
    SMOKE_RABBITMQ_MANAGEMENT_PASSWORD=staging-ghfind-local-only \\
    SMOKE_SCAN_USERNAME=hikariming
  pnpm smoke:backend:async && pnpm smoke:backend:resilience

Frontend (Vercel): set these on the frontend project and redeploy:
  GHFIND_BACKEND_ORIGIN=https://${api_domain}
  PUBLIC_SITE_URL=${GHFIND_STAGING_SITE_URL:-https://staging.ghfind.com}
  NEXT_PUBLIC_SITE_URL=${GHFIND_STAGING_SITE_URL:-https://staging.ghfind.com}
Then run pnpm smoke:deployment (see docs/releases/deployment-smoke.md).
EOF
}

main "$@"
