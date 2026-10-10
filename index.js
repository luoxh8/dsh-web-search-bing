/**
 * Bing search provider for the DeepSeek Harness web capability seam (`ctx.web`).
 *
 * Registers a keyless search provider backed by Bing's public RSS endpoint
 * (`https://www.bing.com/search?q=...&format=rss`), with an HTML scrape of the
 * same endpoint as a fallback. No API key, no account, no DeepSeek credential
 * is ever consulted, so a conversation that selects it can never spend DeepSeek
 * credit on a web search.
 *
 * Contract implemented (see `@deepseek-ai/dsh-web`):
 *   `{ id, available(), search(request, signal) }`
 *   request  -> `{ query, maxResults? }`
 *   result   -> `{ sources: [{ url, title?, snippet?, publishedAt? }], truncated }`
 *
 * @module dsh-web-search-bing
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-bing';

/** The web seam this provider registers into. */
export const inject = ['web'];

const DEFAULT_BASE_URL = 'https://www.bing.com/search';
const DEFAULT_MARKET = 'zh-CN';
const DEFAULT_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * The seam's own error class, resolved lazily and best-effort: the provider must
 * still load (and still fail correctly) if the host package cannot be imported.
 * Every error this module throws carries a machine-routable `code`.
 */
let WebErrorClass;
void import('@deepseek-ai/dsh-web')
  .then((mod) => {
    WebErrorClass = mod.WebError;
  })
  .catch(() => {});

/** Build a seam-compatible error without depending on the host class being loaded. */
function webError(message, code, cause) {
  if (WebErrorClass !== undefined) {
    return cause === undefined ? new WebErrorClass(message, code) : new WebErrorClass(message, code, { cause });
  }
  const error = new Error(message);
  error.name = 'WebError';
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Decode the XML/HTML entities Bing emits (named and numeric). */
function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity.charCodeAt(0) === 35 /* # */) {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Reduce a raw RSS/HTML fragment to plain, single-spaced text. */
function toText(value) {
  if (value === undefined || value === null) return '';
  return decodeEntities(
    String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read one `<tag>...</tag>` payload out of an RSS item block. */
function tagValue(block, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match === null ? '' : match[1];
}

/** Parse Bing's RSS document into seam sources. */
function parseRss(xml) {
  const sources = [];
  const seen = new Set();
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];
    const url = toText(tagValue(block, 'link'));
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const source = { url };
    const title = toText(tagValue(block, 'title'));
    if (title.length > 0) source.title = title;
    const snippet = toText(tagValue(block, 'description'));
    if (snippet.length > 0) source.snippet = snippet;
    const publishedAt = toText(tagValue(block, 'pubDate'));
    if (publishedAt.length > 0) source.publishedAt = publishedAt;
    sources.push(source);
  }
  return sources;
}

/**
 * Parse the classic Bing result page. Deliberately tolerant: the markup is
 * private and changes, so a miss degrades to "no sources" instead of throwing.
 */
function parseHtml(html) {
  const sources = [];
  const seen = new Set();
  const blocks = html.split(/<li class="?b_algo/i).slice(1);
  for (const block of blocks) {
    const anchor = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (anchor === null) continue;
    const url = decodeEntities(anchor[1]).trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const source = { url };
    const title = toText(anchor[2]);
    if (title.length > 0) source.title = title;
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    if (paragraph !== null) {
      const snippet = toText(paragraph[1]);
      if (snippet.length > 0) source.snippet = snippet;
    }
    sources.push(source);
  }
  return sources;
}

/** Map a fetch rejection to the seam's stable error vocabulary. */
function requestError(message, error) {
  const aborted =
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'AbortSignalTimeoutError');
  if (aborted) return webError(message, 'WEB_ABORTED', error);
  return webError(message, 'WEB_PROVIDER_ERROR', error);
}

/** The Bing-backed search provider. */
class BingSearchProvider {
  id = 'bing';

  /**
   * @param resolveOptions - snapshots the config for one operation, so a live
   *   config change can never mix two settings within a single search.
   */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
  }

  /** Availability is a local check: this provider needs no credential. */
  available() {
    const options = this.resolveOptions();
    return URL.canParse(options.baseURL) && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0;
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    const query = String(request?.query ?? '').trim();
    if (query.length === 0) throw webError('Bing search requires a non-empty query', 'WEB_PROVIDER_ERROR');

    const requested = Number.isInteger(request?.maxResults) && request.maxResults > 0 ? request.maxResults : 0;
    const count = Math.min(Math.max(requested, options.count), 50);

    let rssFailure;
    try {
      const sources = await this.#request(options, query, count, 'rss', signal);
      if (sources.length > 0) return { sources, truncated: false };
      rssFailure = webError('Bing RSS returned no results', 'WEB_PROVIDER_ERROR');
    } catch (error) {
      if (error?.code === 'WEB_ABORTED') throw error;
      rssFailure = error;
    }

    try {
      const sources = await this.#request(options, query, count, 'html', signal);
      return { sources, truncated: false };
    } catch (error) {
      if (error?.code === 'WEB_ABORTED') throw error;
      throw webError(
        `Bing search failed. RSS: ${rssFailure?.message ?? 'unknown error'}; HTML fallback: ${error?.message ?? 'unknown error'}`,
        'WEB_PROVIDER_ERROR',
        error,
      );
    }
  }

  /** One HTTP round-trip against the configured Bing endpoint. */
  async #request(options, query, count, mode, signal) {
    const url = new URL(options.baseURL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    if (options.market.length > 0) url.searchParams.set('mkt', options.market);
    if (mode === 'rss') url.searchParams.set('format', 'rss');

    const timeout = AbortSignal.timeout(options.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent': options.userAgent,
          accept:
            mode === 'rss'
              ? 'application/rss+xml, application/xml, text/xml, */*'
              : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: combined,
      });
    } catch (error) {
      throw requestError(`Bing ${mode.toUpperCase()} request to ${url.toString()} failed: ${String(error)}`, error);
    }

    if (!response.ok) {
      throw webError(
        `Bing ${mode.toUpperCase()} request to ${url.toString()} returned HTTP ${response.status}`,
        'WEB_PROVIDER_ERROR',
      );
    }

    let body;
    try {
      body = await response.text();
    } catch (error) {
      throw requestError(`Bing ${mode.toUpperCase()} response body could not be read: ${String(error)}`, error);
    }

    return mode === 'rss' ? parseRss(body) : parseHtml(body);
  }
}

/** Project one resolved config into the options a single search runs with. */
function resolveOptions(config) {
  const settings = config ?? {};
  const toPositive = (value, fallback) =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return {
    baseURL: typeof settings.baseURL === 'string' && settings.baseURL.length > 0 ? settings.baseURL : DEFAULT_BASE_URL,
    market: typeof settings.market === 'string' ? settings.market : DEFAULT_MARKET,
    count: toPositive(settings.count, DEFAULT_COUNT),
    timeoutMs: toPositive(settings.timeoutMs, DEFAULT_TIMEOUT_MS),
    userAgent:
      typeof settings.userAgent === 'string' && settings.userAgent.length > 0
        ? settings.userAgent
        : DEFAULT_USER_AGENT,
  };
}

/** Register the Bing search provider with `ctx.web`. */
export function apply(ctx, config = {}) {
  const snapshot = resolveOptions(config);
  ctx.web.registerSearchProvider(new BingSearchProvider(() => snapshot));
}

export { BingSearchProvider, parseRss, parseHtml, DEFAULT_BASE_URL, DEFAULT_MARKET };
