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

# Mirrors the workflow's `if: dry != 'true'` guard: a dry run must never commit.
dry=false
for a in "$@"; do [ "$a" = "--dry-run" ] && dry=true; done
[ "${DRY:-}" = "1" ] && { dry=true; set -- "$@" --dry-run; }

if [ "$dry" = false ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is not set. Export it, or pass --dry-run to fetch without AI." >&2
  exit 1
fi

# A stale checkout is the one way a local publish can lose work: the aggregator
# reads manifest.json to decide version numbers, so rebasing after the fact
# would produce a manifest built against the wrong base.
branch=$(git rev-parse --abbrev-ref HEAD)
git pull --rebase --autostash origin "$branch"

node scripts/aggregate.mjs --triggered-by local "$@"

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
