import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config.js';

const log = createLogger('search');

const API_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const MAX_QUERY_LEN = 70;
const MAX_COUNT = 50;

export type ZhipuBackend = 'search_pro' | 'search_pro_sogou' | 'search_pro_quark';

interface ZhipuSearchResultItem {
  title?: unknown;
  content?: unknown;
  link?: unknown;
  media?: unknown;
  icon?: unknown;
  refer?: unknown;
  publish_date?: unknown;
}

interface ZhipuSearchResponse {
  search_result?: ZhipuSearchResultItem[];
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function normalizedMaxResults(value: number | undefined, fallback = 10): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  return Math.floor(value);
}

function recencyFilter(options: SearchEngineOptions): string | undefined {
  if (options.fromDate || options.toDate) {
    // Zhipu exposes coarse buckets only — pick the tightest bucket that
    // still covers the caller's window.
    if (options.fromDate) {
      const fromMs = Date.parse(options.fromDate);
      if (Number.isFinite(fromMs)) {
        const days = (Date.now() - fromMs) / 86_400_000;
        if (days <= 1) return 'oneDay';
        if (days <= 7) return 'oneWeek';
        if (days <= 31) return 'oneMonth';
        if (days <= 366) return 'oneYear';
      }
    }
    return 'oneYear';
  }
  switch (options.timeRange) {
    case 'day':
      return 'oneDay';
    case 'week':
      return 'oneWeek';
    case 'month':
      return 'oneMonth';
    case 'year':
      return 'oneYear';
    default:
      return undefined;
  }
}

function parsePublishDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function parseLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function domainFilter(options: SearchEngineOptions): string | undefined {
  const domain = options.includeDomains?.[0]?.trim();
  return domain && domain.length > 0 ? domain : undefined;
}

// Zhipu Web Search API — one key, three Chinese search indices (Pro/Sogou/Quark).
// Missing WIGOLO_ZHIPU_API_KEY throws before the network call so engine_warnings
// surfaces needs_key without failing the overall search response.
export class ZhipuEngine implements SearchEngine {
  constructor(
    public readonly name: string,
    private readonly backend: ZhipuBackend,
  ) {}

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const apiKey = getConfig().zhipuApiKey;
    if (!apiKey) {
      throw new Error(
        'WIGOLO_ZHIPU_API_KEY not set — set the env var to enable Zhipu web search',
      );
    }

    const timeoutMs = options.timeoutMs ?? 10000;
    const maxResults = normalizedMaxResults(options.maxResults);
    if (maxResults === 0) return [];

    const trimmed = query.trim();
    if (!trimmed) return [];

    const body: Record<string, unknown> = {
      search_query: trimmed.slice(0, MAX_QUERY_LEN),
      search_engine: this.backend,
      search_intent: false,
      count: Math.min(maxResults, MAX_COUNT),
      content_size: 'high',
    };

    const recency = recencyFilter(options);
    if (recency) body.search_recency_filter = recency;

    const domain = domainFilter(options);
    if (domain) body.search_domain_filter = domain;

    log.debug('zhipu search', { query: trimmed, backend: this.backend, engine: this.name });

    const response = await fetch(API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as ZhipuSearchResponse;

    if (!response.ok) {
      const errMsg = asString(payload.error?.message);
      const errCode = asString(payload.error?.code);
      const detail = errMsg ?? errCode ?? String(response.status);
      throw new Error(`Zhipu returned ${response.status}: ${detail}`);
    }

    return this.parseResults(payload.search_result ?? [], maxResults);
  }

  parseResults(items: ZhipuSearchResultItem[], maxResults: number): RawSearchResult[] {
    const results: RawSearchResult[] = [];

    for (const item of items) {
      if (results.length >= maxResults) break;
      const title = asString(item.title);
      const url = parseLink(asString(item.link));
      if (!title || !url) continue;

      const snippet = asString(item.content) ?? '';
      const published_date = parsePublishDate(asString(item.publish_date));

      results.push({
        title,
        url,
        snippet,
        relevance_score: 0,
        engine: this.name,
        ...(published_date ? { published_date } : {}),
      });
    }

    const total = results.length;
    return results.map((result, i) => ({
      ...result,
      relevance_score: 1 - i / Math.max(total, 1),
    }));
  }
}
