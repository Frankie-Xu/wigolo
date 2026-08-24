import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ZhipuEngine } from '../../../../src/search/engines/zhipu.js';
import { buildEngineWarnings } from '../../../../src/search/core/engine-warnings.js';
import { getEngineHealthSummary } from '../../../../src/search/core/engine-health.js';
import { resetConfig } from '../../../../src/config.js';
import { _resetGeneralEnginesForTest } from '../../../../src/search/core/verticals/general.js';
import type { EngineTelemetry } from '../../../../src/types.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(
  handler: (url: string, init?: RequestInit) => { body: unknown; ok?: boolean; status?: number },
): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const { body, ok = true, status = 200 } = handler(url, init);
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  return { calls, restore: () => spy.mockRestore() };
}

describe('ZhipuEngine', () => {
  beforeEach(() => {
    resetConfig();
    delete process.env.WIGOLO_ZHIPU_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfig();
    delete process.env.WIGOLO_ZHIPU_API_KEY;
  });

  it('has the configured engine name and backend', () => {
    expect(new ZhipuEngine('zhipu-pro', 'search_pro').name).toBe('zhipu-pro');
    expect(new ZhipuEngine('zhipu-sogou', 'search_pro_sogou').name).toBe('zhipu-sogou');
    expect(new ZhipuEngine('zhipu-quark', 'search_pro_quark').name).toBe('zhipu-quark');
  });

  it('throws a needs_key-shaped error when WIGOLO_ZHIPU_API_KEY is unset', async () => {
    const engine = new ZhipuEngine('zhipu-pro', 'search_pro');
    await expect(engine.search('测试')).rejects.toThrow(/WIGOLO_ZHIPU_API_KEY not set/);
  });

  it('maps a successful response to RawSearchResult fields', async () => {
    process.env.WIGOLO_ZHIPU_API_KEY = 'zhipu-test-key';
    resetConfig();

    const body = {
      search_result: [
        {
          title: '财经早资讯',
          content: '对外直接投资575.4亿美元',
          link: 'https://www.sohu.com/a/897879632_121123890',
          media: '搜狐',
          publish_date: '2025-05-23',
        },
      ],
    };

    const { calls, restore } = captureFetch(() => ({ body }));
    try {
      const results = await new ZhipuEngine('zhipu-pro', 'search_pro').search('财经新闻');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        title: '财经早资讯',
        url: 'https://www.sohu.com/a/897879632_121123890',
        snippet: '对外直接投资575.4亿美元',
        engine: 'zhipu-pro',
        relevance_score: 1,
      });
      expect(results[0].published_date).toBe(new Date('2025-05-23').toISOString());

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer zhipu-test-key');
      const payload = JSON.parse(String(calls[0].init?.body));
      expect(payload.search_engine).toBe('search_pro');
      expect(payload.search_intent).toBe(false);
      expect(payload.content_size).toBe('high');
    } finally {
      restore();
    }
  });

  it('sends the sogou and quark backend codes from their engine instances', async () => {
    process.env.WIGOLO_ZHIPU_API_KEY = 'zhipu-test-key';
    resetConfig();

    const { calls, restore } = captureFetch(() => ({ body: { search_result: [] } }));
    try {
      await new ZhipuEngine('zhipu-sogou', 'search_pro_sogou').search('微信');
      await new ZhipuEngine('zhipu-quark', 'search_pro_quark').search('移动');
      const payloads = calls.map((c) => JSON.parse(String(c.init?.body)));
      expect(payloads[0].search_engine).toBe('search_pro_sogou');
      expect(payloads[1].search_engine).toBe('search_pro_quark');
    } finally {
      restore();
    }
  });

  it('truncates search_query to 70 characters', async () => {
    process.env.WIGOLO_ZHIPU_API_KEY = 'zhipu-test-key';
    resetConfig();

    const longQuery = '中'.repeat(100);
    const { calls, restore } = captureFetch(() => ({ body: { search_result: [] } }));
    try {
      await new ZhipuEngine('zhipu-pro', 'search_pro').search(longQuery);
      const payload = JSON.parse(String(calls[0].init?.body));
      expect(payload.search_query).toHaveLength(70);
    } finally {
      restore();
    }
  });

  it('caps count at 50', async () => {
    process.env.WIGOLO_ZHIPU_API_KEY = 'zhipu-test-key';
    resetConfig();

    const { calls, restore } = captureFetch(() => ({ body: { search_result: [] } }));
    try {
      await new ZhipuEngine('zhipu-pro', 'search_pro').search('q', { maxResults: 100 });
      const payload = JSON.parse(String(calls[0].init?.body));
      expect(payload.count).toBe(50);
    } finally {
      restore();
    }
  });

  it('returns an empty array for empty search_result without throwing', async () => {
    process.env.WIGOLO_ZHIPU_API_KEY = 'zhipu-test-key';
    resetConfig();

    captureFetch(() => ({ body: { search_result: [] } }));
    const results = await new ZhipuEngine('zhipu-pro', 'search_pro').search('无结果');
    expect(results).toEqual([]);
  });

  it('skips items missing title or link', async () => {
    process.env.WIGOLO_ZHIPU_API_KEY = 'zhipu-test-key';
    resetConfig();

    captureFetch(() => ({
      body: {
        search_result: [
          { title: 'no url', content: 'x' },
          { link: 'https://example.com/x', content: 'no title' },
          { title: 'ok', link: 'https://example.com/ok', content: 'snippet' },
        ],
      },
    }));
    const results = await new ZhipuEngine('zhipu-pro', 'search_pro').search('q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('ok');
  });

  it('throws with HTTP status when the API returns an error payload', async () => {
    process.env.WIGOLO_ZHIPU_API_KEY = 'zhipu-test-key';
    resetConfig();

    captureFetch(() => ({
      body: { error: { code: '1701', message: 'concurrency limit' } },
      ok: false,
      status: 429,
    }));
    await expect(new ZhipuEngine('zhipu-pro', 'search_pro').search('q')).rejects.toThrow(
      /Zhipu returned 429/,
    );
  });

  it('maps time_range to search_recency_filter', async () => {
    process.env.WIGOLO_ZHIPU_API_KEY = 'zhipu-test-key';
    resetConfig();

    const { calls, restore } = captureFetch(() => ({ body: { search_result: [] } }));
    try {
      await new ZhipuEngine('zhipu-pro', 'search_pro').search('news', { timeRange: 'week' });
      const payload = JSON.parse(String(calls[0].init?.body));
      expect(payload.search_recency_filter).toBe('oneWeek');
    } finally {
      restore();
    }
  });

  it('maps includeDomains[0] to search_domain_filter', async () => {
    process.env.WIGOLO_ZHIPU_API_KEY = 'zhipu-test-key';
    resetConfig();

    const { calls, restore } = captureFetch(() => ({ body: { search_result: [] } }));
    try {
      await new ZhipuEngine('zhipu-pro', 'search_pro').search('site', {
        includeDomains: ['www.sohu.com', 'ignored.example'],
      });
      const payload = JSON.parse(String(calls[0].init?.body));
      expect(payload.search_domain_filter).toBe('www.sohu.com');
    } finally {
      restore();
    }
  });
});

describe('ZhipuEngine warnings and doctor health', () => {
  beforeEach(() => {
    resetConfig();
    _resetGeneralEnginesForTest();
    delete process.env.WIGOLO_ZHIPU_API_KEY;
  });

  afterEach(() => {
    resetConfig();
    _resetGeneralEnginesForTest();
    delete process.env.WIGOLO_ZHIPU_API_KEY;
  });

  it('buildEngineWarnings classifies missing-key failures as needs_key with hint', () => {
    const telemetry: EngineTelemetry[] = [
      {
        name: 'zhipu-pro',
        latency_ms: 1,
        result_count: 0,
        outcome: 'error',
        dedup_kept: 0,
        error: 'WIGOLO_ZHIPU_API_KEY not set — set the env var to enable Zhipu web search',
      },
    ];
    const warnings = buildEngineWarnings(telemetry);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('needs_key');
    expect(warnings[0].hint).toMatch(/WIGOLO_ZHIPU_API_KEY/);
  });

  it('doctor health marks zhipu engines needs-key when the API key is absent', () => {
    const health = getEngineHealthSummary();
    const zhipu = health.filter((e) => e.name.startsWith('zhipu-'));
    expect(zhipu.length).toBe(3);
    for (const entry of zhipu) {
      expect(entry.status).toBe('needs-key');
      expect(entry.hint).toMatch(/WIGOLO_ZHIPU_API_KEY/);
      expect(entry.vertical).toBe('general');
    }
  });
});
