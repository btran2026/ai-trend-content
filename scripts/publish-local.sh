#!/usr/bin/env bash
#
# Run the aggregator on this machine and publish the result.
#
# Same script, same output, same commit as the GitHub Actions run — this just
# moves the work to your laptop, which is useful when you want a digest now
# without burning an Actions run, or when you want to watch it happen and stop
# it before it commits.
#
#   ./scripts/publish-local.sh                          # scheduled-shape run
#   ./scripts/publish-local.sh --mode on-demand --query "agent harnesses"
#   ./scripts/publish-local.sh --dry-run                # fetch + rank only, no AI, no commit
#   DRY=1 ./scripts/publish-local.sh                    # same thing
#   NO_PUSH=1 ./scripts/publish-local.sh                # commit locally, don't push
#
# Requires ANTHROPIC_API_KEY in the environment unless dry-running. Set
# AGGREGATOR_MODEL to override the model — a local run bills your own key, so
# claude-sonnet-5 is usually the right call here.
#
set -euo pipefail

cd "$(dirname "$0")/.."

# Load .env if present (gitignored). Lets you set the key once instead of
# prefixing every invocation — and keeps it out of your shell history.
#   printf 'ANTHROPIC_API_KEY=sk-ant-…\nAGGREGATOR_MODEL=claude-sonnet-5\n' > .env
#
# The caller wins. `set -a; . ./.env` would clobber variables the caller passed,
# which silently overrode the model chosen in the Preflight AI News dashboard:
# you picked Opus, .env said sonnet, and sonnet is what ran.
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key=${line%%=*}
    [ "$key" = "$line" ] && continue           # no '=' — not an assignment
    [ -n "${!key:-}" ] && continue             # already set by the caller
    export "${key}=${line#*=}"
  done < .env
fi

# Mirrors the workflow's `if: dry != 'true'` guard: a dry run must never commit.
dry=false
for a in "$@"; do [ "$a" = "--dry-run" ] && dry=true; done
[ "${DRY:-}" = "1" ] && { dry=true; set -- "$@" --dry-run; }

# Two ways to reach the model, and no key is the normal local case: fall back to
# the `claude` CLI and whatever session it is already logged into, which bills
# the subscription instead of API credits. aggregate.mjs picks the same way.
if [ "$dry" = false ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  if command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1; then
    echo "No ANTHROPIC_API_KEY — using the ${CLAUDE_BIN:-claude} CLI session (subscription-billed)."
    echo
  else
    echo "No ANTHROPIC_API_KEY and no '${CLAUDE_BIN:-claude}' on PATH." >&2
    echo "Log in to Claude Code, set a key in .env, or pass --dry-run." >&2
    exit 1
  fi
fi

# A stale checkout is the one way a local publish can lose work: the aggregator
# reads manifest.json to decide version numbers, so rebasing after the fact
# would produce a manifest built against the wrong base.
branch=$(git rev-parse --abbrev-ref HEAD)

# Pages serves `main`. Publishing from anywhere else produces a perfectly valid
# digest that no app will ever read, which is a confusing way to lose an hour.
if [ "$branch" != "main" ]; then
  echo "WARNING: on '$branch', not main. GitHub Pages serves main, so this digest"
  echo "         will not reach the app until the branch is merged."
  echo
fi

git pull --rebase --autostash origin "$branch"

# TRIGGERED_BY lets a caller label the run ("local-dashboard", "local-schedule")
# without passing a second --triggered-by: aggregate.mjs takes the FIRST
# occurrence of a flag, so an appended one would be silently ignored.
node scripts/aggregate.mjs --triggered-by "${TRIGGERED_BY:-local}" "$@"

if [ "$dry" = true ]; then
  echo "Dry run — nothing written, nothing committed."
  exit 0
fi

git add manifest.json digests models
if git diff --cached --quiet; then
  echo "Nothing changed — no digest published this run."
  exit 0
fi

headline=$(node -e "
  const m = require('./manifest.json');
  const d = (m.digests || []).find(x => x.id === m.latestDigestId);
  process.stdout.write((d && d.headline) || 'digest update');
")
git commit -m "Digest: ${headline}" -m "Triggered by local run."

if [ "${NO_PUSH:-}" = "1" ]; then
  echo "Committed. NO_PUSH=1, so it stays local — push when you're happy with it."
  exit 0
fi

git push origin "$branch"
echo "Published. Pages will serve it within a minute or two."
