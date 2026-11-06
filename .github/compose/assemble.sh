#!/usr/bin/env bash
# Assemble the ghfind workspace: a FindAny/ghfind checkout (the root) plus the
# private components listed in .github/compose/components.json.
#
#   .github/compose/assemble.sh                          # latest verified release of each component
#   .github/compose/assemble.sh --channel main           # component default branches
#   .github/compose/assemble.sh --ref ghfind-frontend=v1.4.0   # pin a tag, branch or commit
#   .github/compose/assemble.sh --dir ghfind-server=../ghfind-server   # use a local checkout
#   .github/compose/assemble.sh --clean ...              # undo a previous local assembly first
#   .github/compose/assemble.sh --require-manifest       # deploy-branch commits only (exact pins)
#
# On a deploy-branch commit (components.manifest.json present) the components are
# fetched at the exact commits the manifest pins. "Verified release" means the
# highest vX.Y.Z whose rel/vX.Y.Z marker exists (pushed by each repo's release
# workflow after CI passes). Private repos are fetched with COMPOSE_TOKEN (a GitHub
# App installation token) when set, otherwise with your own git credentials.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
config="$root/.github/compose/components.json"
manifest="$root/$(jq -r .manifestFile "$config")"
state="$root/.compose"
channel="release"; clean=0; require_manifest=0
declare -A refs=() dirs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) refs["${2%%=*}"]="${2#*=}"; shift 2 ;;
    --dir) dirs["${2%%=*}"]="${2#*=}"; shift 2 ;;
    --channel) channel="$2"; shift 2 ;;
    --clean) clean=1; shift ;;
    --require-manifest) require_manifest=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "assemble: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -f "$state/paths.txt" ]; then
  if [ "$clean" = 1 ]; then
    while IFS= read -r rel; do rm -rf "${root:?}/$rel"; done < "$state/paths.txt"
    git -C "$root" checkout -q -- $(cat "$state/replaced.txt" 2>/dev/null) 2>/dev/null || true
    rm -rf "$state"
  else
    echo "assemble: already assembled ($(jq -r '[.components[] | "\(.name)@\(.ref)"] | join(", ")' "$state/assembled.json" 2>/dev/null)); pass --clean to redo"
    exit 0
  fi
fi

pinned="{}"
if [ -f "$manifest" ]; then
  pinned="$(jq -c '[.components[] | {key: .name, value: .sha}] | from_entries' "$manifest")"
  echo "assemble: deploy commit; using the commits pinned by $(basename "$manifest")"
elif [ "$require_manifest" = 1 ]; then
  echo "assemble: $(basename "$manifest") missing; production workflows only run on composed deploy-branch commits" >&2
  exit 1
fi

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$state"; : > "$state/paths.txt"; : > "$state/replaced.txt"
exclude="$(git -C "$root" rev-parse --git-path info/exclude)"; case "$exclude" in /*) ;; *) exclude="$root/$exclude" ;; esac
mkdir -p "$(dirname "$exclude")"
literal() { printf '/%s' "$(printf '%s' "$1" | sed 's/[][*?!\\]/\\&/g')"; }
add_exclude() { local p; p="$(literal "$1")"; grep -qxF "$p" "$exclude" 2>/dev/null || printf '%s\n' "$p" >> "$exclude"; }
add_exclude ".compose/"

url_for() { # repository
  if [ -n "${COMPOSE_TOKEN:-}" ]; then echo "https://x-access-token:${COMPOSE_TOKEN}@github.com/$1.git"; else echo "https://github.com/$1.git"; fi
}
latest_release() { # url
  git ls-remote --tags --refs "$1" 'rel/v*' | awk '{print $2}' | sed 's#^refs/tags/rel/##' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true
}
fetch() { # url ref dest
  mkdir -p "$3"; git -C "$3" init -q
  git -C "$3" fetch -q --depth 1 "$1" "$2"
  git -C "$3" checkout -q --detach FETCH_HEAD
}
tracked_in_root() { git -C "$root" ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }

resolved="[]"
for i in $(seq 0 $(($(jq '.components | length' "$config") - 1))); do
  c="$(jq -c ".components[$i]" "$config")"
  name="$(jq -r .name <<<"$c")"; repo="$(jq -r .repository <<<"$c")"
  src="${dirs[$name]:-}"
  if [ -n "$src" ]; then
    src="$(cd "$src" && pwd)"; ref="local"; sha="$(git -C "$src" rev-parse HEAD 2>/dev/null || echo unknown)"
  else
    url="$(url_for "$repo")"
    ref="$(jq -r --arg n "$name" '.[$n] // ""' <<<"$pinned")"
    [ -n "$ref" ] || ref="${refs[$name]:-}"
    if [ -z "$ref" ] && [ "$channel" = release ]; then ref="$(latest_release "$url")"; fi
    if [ -z "$ref" ]; then
      ref="main"; [ "$channel" = release ] && echo "::warning::assemble: $repo has no verified release yet; using main"
    fi
    src="$work/$name"; fetch "$url" "$ref" "$src"; sha="$(git -C "$src" rev-parse HEAD)"
  fi

  if [ "$(jq -r .include <<<"$c")" = all ]; then
    mapfile -t files < <(git -C "$src" ls-files | grep -v -E "^($(jq -r '.exclude | map(gsub("[.]"; "\\.")) | join("|")' <<<"$c"))" || true)
  else
    files=()
    while IFS= read -r p; do
      p="${p%/}"; [ -e "$src/$p" ] || continue
      if [ -d "$src/$p" ]; then mapfile -t -O "${#files[@]}" files < <(git -C "$src" ls-files -- ":(literal)$p" 2>/dev/null || (cd "$src" && find "$p" -type f)); else files+=("$p"); fi
    done < <(jq -r '.paths[]' <<<"$c")
  fi
  mapfile -t replaces < <(jq -r '.replaces // [] | .[]' <<<"$c")
  for f in "${files[@]}"; do
    if [ -e "$root/$f" ] || tracked_in_root "$f"; then
      if printf '%s\n' "${replaces[@]}" | grep -qxF "$f"; then echo "$f" >> "$state/replaced.txt"
      else echo "assemble: $name contains $f, which the workspace root already has (not in replaces)" >&2; exit 1; fi
    fi
  done
  (cd "$src" && tar -cf - -- "${files[@]}") | (cd "$root" && tar -xf -)
  for f in "${files[@]}"; do
    top="${f%%/*}"
    if ! grep -qxF "$f" "$state/replaced.txt"; then
      if [ "$top" = "$f" ]; then entry="$f"; elif tracked_in_root "$top" || git -C "$root" ls-files -- "$top" | grep -q .; then entry="$f"; else entry="$top"; fi
      grep -qxF "$entry" "$state/paths.txt" || { echo "$entry" >> "$state/paths.txt"; add_exclude "$entry"; }
    fi
  done
  echo "assemble: $name @ $ref ($sha) — ${#files[@]} files"
  resolved="$(jq -c --arg n "$name" --arg r "$repo" --arg ref "$ref" --arg s "$sha" '. + [{name: $n, repository: $r, ref: $ref, sha: $s}]' <<<"$resolved")"
done

root_ref="$(jq -r '.components[] | select(.name == "ghfind") | .ref' "$manifest" 2>/dev/null || true)"
[ -n "$root_ref" ] || root_ref="$(git -C "$root" describe --tags --exact-match 2>/dev/null || git -C "$root" rev-parse --abbrev-ref HEAD)"
jq -n --arg channel "$([ "$pinned" = "{}" ] && echo "$channel" || echo manifest)" --arg ref "$root_ref" --arg sha "$(git -C "$root" rev-parse HEAD)" --argjson c "$resolved" \
  '{channel: $channel, components: ([{name: "ghfind", repository: "FindAny/ghfind", ref: $ref, sha: $sha}] + $c)}' > "$state/assembled.json"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  jq -r '"### Assembled workspace (\(.channel))\n\n| Component | Ref | Commit |\n| --- | --- | --- |", (.components[] | "| \(.repository) | \(.ref) | `\(.sha[0:12])` |")' \
    "$state/assembled.json" >> "$GITHUB_STEP_SUMMARY"
fi
