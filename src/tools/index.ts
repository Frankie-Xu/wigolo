import { createLogger } from '../logger.js';
import { ingestFiles } from '../indexing/ingester.js';
import { resolveLocalSource, scanLocalFiles } from '../indexing/scanner.js';
import type { IndexInput, IndexOutput } from '../types.js';

const log = createLogger('indexing');

/**
 * Ingest local markdown/text/PDF files into url_cache under `internal://` URLs.
 * Does not touch the network and does not go through SSRF guards.
 */
export async function handleIndex(input: IndexInput): Promise<IndexOutput> {
  const namespace = (input.namespace?.trim() || 'docs').toLowerCase();
  const empty: IndexOutput = {
    indexed: 0,
    skipped: 0,
    failed: 0,
    namespace,
    files: [],
  };

  if (!input.source || !input.source.trim()) {
    return { ...empty, error: 'source is required' };
  }

  const resolved = resolveLocalSource(input.source);
  if (!resolved.ok) {
    return { ...empty, error: resolved.error };
  }

  const ttl =
    input.ttl === undefined || input.ttl === null
      ? 0
      : Number(input.ttl);
  if (!Number.isFinite(ttl) || ttl < 0) {
    return { ...empty, error: 'ttl must be a non-negative number (0 = never expire)' };
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];

  log.info('index request', {
    source: resolved.root,
    namespace,
    glob: input.glob ?? '*.md',
    recursive: input.recursive !== false,
    ttl,
    tagCount: tags.length,
  });

  const scan = scanLocalFiles(resolved.root, {
    glob: input.glob,
    recursive: input.recursive,
  });

  if (scan.files.length === 0) {
    const hint = scan.warnings.length > 0 ? ` (${scan.warnings[0]})` : '';
    return {
      ...empty,
      error: `no matching files under ${input.source}${hint}`,
      files: [],
    };
  }

  const batch = await ingestFiles(scan.files, {
    namespace,
    tags,
    ttlSeconds: ttl,
  }, resolved.root);

  log.info('index complete', {
    indexed: batch.indexed,
    skipped: batch.skipped,
    failed: batch.failed,
    warnings: scan.warnings.length,
  });

  return {
    indexed: batch.indexed,
    skipped: batch.skipped,
    failed: batch.failed,
    namespace,
    files: batch.files,
  };
}
