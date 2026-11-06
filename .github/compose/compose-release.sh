#!/usr/bin/env bash
# Compose the latest verified release of every component onto the deploy branch.
#
# A deploy-branch commit is the FindAny/ghfind release tree plus
# components.manifest.json, which pins the exact ghfind-server and ghfind-frontend
# commits. It never contains private code: the private components are only fetched
# to prove the combination assembles, and only the manifest is committed. Pushing
# it with the release bot's token runs CI on the assembled workspace; the
# production deploy workflows deploy that exact commit after CI succeeds.
#
# Env: COMPOSE_TOKEN (read: ghfind-server, ghfind-frontend), PUSH_TOKEN (write:
# ghfind), PIN_GHFIND / PIN_GHFIND_SERVER / PIN_GHFIND_FRONTEND (tag pins),
# FORCE=true, DRY_RUN=true, COMPOSE_TRIGGER (recorded in the manifest).
set -euo pipefail

root="$(git rev-parse --show-toplevel)"; cd "$root"
config=".github/compose/components.json"
branch="$(jq -r .deployBranch "$config")"
manifest_name="$(jq -r .manifestFile "$config")"
work="$(mktemp -d)"
cleanup() { git worktree remove --force "$work/tree" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

private_url() { if [ -n "${COMPOSE_TOKEN:-}" ]; then echo "https://x-access-token:${COMPOSE_TOKEN}@github.com/$1.git"; else echo "https://github.com/$1.git"; fi; }
latest_remote() { git ls-remote --tags --refs "$1" 'rel/v*' | awk '{print $2}' | sed 's#^refs/tags/rel/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true; }

git fetch -q --tags --force origin
public_tag="${PIN_GHFIND:-$(git tag -l 'rel/v*' | sed 's#^rel/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)}"
server_tag="${PIN_GHFIND_SERVER:-$(latest_remote "$(private_url FindAny/ghfind-server)")}"
frontend_tag="${PIN_GHFIND_FRONTEND:-$(latest_remote "$(private_url FindAny/ghfind-frontend)")}"
missing=""
[ -n "$public_tag" ] || missing="$missing ghfind"
[ -n "$server_tag" ] || missing="$missing ghfind-server"
[ -n "$frontend_tag" ] || missing="$missing ghfind-frontend"
if [ -n "$missing" ]; then echo "::notice::compose: no verified vX.Y.Z release yet for:$missing; nothing to deploy"; exit 0; fi
desired="$(jq -cn --arg p "$public_tag" --arg s "$server_tag" --arg f "$frontend_tag" '{"ghfind": $p, "ghfind-server": $s, "ghfind-frontend": $f}')"

parent=""; current="{}"
if git fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null; then
  parent="$(git rev-parse "origin/$branch")"
  current="$(git show "$parent:$manifest_name" 2>/dev/null | jq -c '[.components[] | {key: .name, value: .ref}] | from_entries' || echo '{}')"
fi
echo "compose: deployed $current"
echo "compose: latest   $desired"
if [ "$current" = "$desired" ] && [ "${FORCE:-false}" != "true" ]; then echo "compose: $branch is up to date"; exit 0; fi

public_sha="$(git rev-parse "$public_tag^{commit}")"
git worktree add -q --detach "$work/tree" "$public_sha"
(
  cd "$work/tree"
  .github/compose/assemble.sh --ref "ghfind-server=$server_tag" --ref "ghfind-frontend=$frontend_tag"
  jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg trigger "${COMPOSE_TRIGGER:-manual}" --arg tag "$public_tag" \
    '{format: "ghfind-components-v1", composedAt: $at, trigger: $trigger,
      components: [.components[] | if .name == "ghfind" then .ref = $tag else . end]}' \
    .compose/assembled.json > "$manifest_name"
  git add -f -- "$manifest_name"            # the manifest only; overlays stay out of the commit
  staged="$(git diff --cached --name-only)"
  [ "$staged" = "$manifest_name" ] || { echo "compose: refusing to commit anything but $manifest_name: $staged" >&2; exit 1; }
)
tree="$(git -C "$work/tree" write-tree)"
message="deploy: ghfind $public_tag + ghfind-server $server_tag + ghfind-frontend $frontend_tag"
args=(-p "$public_sha"); [ -n "$parent" ] && args=(-p "$parent" "${args[@]}")
commit="$(GIT_AUTHOR_NAME="ghfind release bot" GIT_AUTHOR_EMAIL="release-bot@ghfind.com" \
  GIT_COMMITTER_NAME="ghfind release bot" GIT_COMMITTER_EMAIL="release-bot@ghfind.com" \
  git commit-tree "$tree" "${args[@]}" -m "$message" -m "$(git -C "$work/tree" show ":$manifest_name")")"
echo "compose: $message -> $commit"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### $message"; echo; echo "Deploy commit: \`$commit\`"; echo; echo "| Component | Release | Commit |"; echo "| --- | --- | --- |"
    git -C "$work/tree" show ":$manifest_name" | jq -r '.components[] | "| \(.repository) | \(.ref) | `\(.sha[0:12])` |"'; } >> "$GITHUB_STEP_SUMMARY"
fi
if [ "${DRY_RUN:-false}" = "true" ]; then echo "compose: dry run; not pushing"; exit 0; fi
[ -n "${PUSH_TOKEN:-}" ] || { echo "compose: PUSH_TOKEN is required (pushes must trigger CI)" >&2; exit 1; }
git push -q "https://x-access-token:${PUSH_TOKEN}@github.com/FindAny/ghfind.git" "$commit:refs/heads/$branch"
echo "compose: pushed $branch"
