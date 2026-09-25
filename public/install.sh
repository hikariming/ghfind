#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'ghfind requires Node.js 18+ and npm. Install Node.js, then run this command again.' >&2
  exit 1
fi

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || {
  printf '%s\n' 'ghfind requires Node.js 18 or newer.' >&2
  exit 1
}

npm install --global @hikariming/ghfind

skill_dir="${HOME}/.agents/skills/ghfind-cli"
mkdir -p "$skill_dir"
skill_tmp="$(mktemp "${skill_dir}/SKILL.md.XXXXXX")"
trap 'rm -f "$skill_tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://ghfind.com/skill.md --output "$skill_tmp"
test -s "$skill_tmp"
mv "$skill_tmp" "${skill_dir}/SKILL.md"
trap - EXIT

printf '\n%s\n' 'ghfind CLI and Skill installed.' 'Run `ghfind --help` to get started.'
printf '%s\n' 'Create an API token at https://ghfind.com/integrations to enable scan and roast.'
