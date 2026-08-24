#!/usr/bin/env bash
# Issue #225 — push + open PR (requires `workflow` scope on gh token)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Refreshing gh token with workflow scope (interactive)…"
gh auth refresh -h github.com -s workflow

echo "→ Pushing feat/index-tool-225 to fork…"
git push -u fork feat/index-tool-225:feat/index-tool-225

echo "→ Creating PR against KnockOutEZ/wigolo…"
gh pr create --repo KnockOutEZ/wigolo \
  --head Frankie-Xu:feat/index-tool-225 \
  --title "feat: add index tool — ingest local docs into unified search cache (#225)" \
  --body "$(cat <<'EOF'
## Summary
- Adds `index` MCP tool and `wigolo index` CLI to ingest local markdown/text/PDF files into `url_cache` under `internal://` URLs, reusing existing FTS5 + sqlite-vec hybrid search.
- Extends `cache` with `source` (web/internal) and `namespace` filters; `fetch` serves `internal://` documents from cache without HTTP/SSRF.
- Includes migration 011 (`namespace`, `tags` columns), hash-based incremental re-index, optional `--watch` fs.watch mode, and integration tests.

## Test plan
- [ ] `PATH=".tools/node-v22.18.0-darwin-arm64/bin:$PATH" npm rebuild better-sqlite3 && ./node_modules/.bin/vitest run tests/unit/indexing tests/integration/index-ingest-search.test.ts tests/unit/cache/store-source-filter.test.ts tests/unit/tools/fetch-internal.test.ts tests/unit/server/schema-registration.test.ts`
- [ ] `wigolo index --source ./docs --namespace docs --glob "*.md"`
- [ ] `wigolo cache --query "architecture" --source internal --json`
- [ ] `wigolo fetch --url "internal://docs/readme.md" --json`

Closes #225
EOF
)"
