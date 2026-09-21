#!/usr/bin/env bash
# The webhook's understudy.
#
# GitHub delivers a push webhook once and never retries it. Twice in one afternoon the
# delivery did not get through - one timed out during a restart, one could not connect -
# and main sat undeployed until somebody noticed. This runs every few minutes as the
# service user, asks GitHub where main is, and if that is not what is checked out and no
# deploy is already requested, writes the same trigger the webhook would have written.
# deploy.sh then does exactly what it always does: pull, test, restart, or roll back.
set -euo pipefail

APP=/opt/treelogy/app
TRIGGER=/opt/treelogy/state/deploy-requested

cd "$APP"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git ls-remote --quiet origin refs/heads/main | cut -f1)

if [ -z "$REMOTE" ]; then
  echo "deploy-poll: GitHub tidak menjawab"
  exit 0
fi
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi
# A deploy already running, or a trigger written in the last two minutes, is one on its
# way. Ten minutes was too long a courtesy: a deploy takes ten seconds, and three polls
# in a row stood aside for a trigger that had long since been consumed.
if [ "$(systemctl is-active treelogy-deploy.service 2>/dev/null)" = "activating" ]; then
  exit 0
fi
if [ -f "$TRIGGER" ] && [ "$(( $(date +%s) - $(stat -c %Y "$TRIGGER") ))" -lt 120 ]; then
  exit 0
fi

echo "deploy-poll: main di GitHub ${REMOTE:0:8}, terpasang ${LOCAL:0:8} - webhook terlewat, memicu deploy"
mkdir -p "$(dirname "$TRIGGER")"
printf '{"at":"%s","sha":"%s","branch":"main","by":"deploy-poll","message":"webhook terlewat"}' \
  "$(date -u +%FT%TZ)" "$REMOTE" > "$TRIGGER"
