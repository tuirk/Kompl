#!/bin/sh
#
# Kompl v2 — n8n container entrypoint wrapper.
#
# Runs three things in order BEFORE exec'ing `n8n start`:
#   1. n8n import:workflow  (idempotent — overwrites by id on re-run)
#   2. n8n import:credentials (if a /credentials dir is mounted)
#   3. n8n publish:workflow --id=<id> for each workflow listed by
#      `n8n list:workflow` — activates the workflow's webhook triggers.
#
# Why step 3: in n8n 2.x, `import:workflow` DEACTIVATES workflows on
# every re-import with the message "Deactivating workflow X. Remember
# to activate later." The `active: true` field in the exported JSON is
# ignored by import. Without publishing, webhook triggers do not fire
# and our /webhook/ingest endpoint returns 404.
#
# The deprecated `update:workflow --active=true --all` has been replaced
# by per-id `publish:workflow --id=<id>`. Publishing while n8n is NOT
# running writes directly to the SQLite state, so our `exec n8n start`
# after the loop picks up the active workflows cleanly.
#
# Source: docs.n8n.io/hosting/cli-commands/ (verified 2026-04-08).
# Sidecar architecture context: docs/research/2026-04-08-commit-3-architecture.md

set -eu

if [ -d /workflows ]; then
  echo "[auto-import] importing workflows from /workflows"
  n8n import:workflow --separate --input=/workflows || echo "[auto-import] workflow import failed (non-fatal)"
fi

if [ -d /credentials ]; then
  echo "[auto-import] importing credentials from /credentials"
  n8n import:credentials --separate --input=/credentials || echo "[auto-import] credentials import failed (non-fatal)"
fi

# Publish (activate) each workflow. n8n 2.x import deactivates workflows on
# re-import; we re-activate them here so webhook triggers fire on the next
# `n8n start`.
echo "[auto-import] publishing workflows to activate triggers"
n8n list:workflow 2>/dev/null | while IFS='|' read -r wf_id wf_name; do
  if [ -n "$wf_id" ]; then
    echo "[auto-import]   publishing $wf_id ($wf_name)"
    n8n publish:workflow --id="$wf_id" 2>&1 | sed 's/^/[auto-import]     /' || \
      echo "[auto-import]   publish failed for $wf_id (non-fatal)"
  fi
done

echo "[auto-import] starting n8n"
exec n8n start
