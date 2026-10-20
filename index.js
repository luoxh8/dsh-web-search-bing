/**
 * Bing search provider for the DeepSeek Harness web capability seam (`ctx.web`).
 *
 * Registers a keyless search provider backed by Bing's public RSS endpoint,
 * with an HTML scrape of the same endpoint as a fallback. The mainland-China
 * host (`cn.bing.com`) is tried first and `www.bing.com` second: this runs on a
 * mainland network where the international host is the less reliable of the
 * two, and the overseas host is still reached when a proxy is in play. No API
 * key, no account, and no DeepSeek credential is ever consulted, so a
 * conversation that selects this provider can never spend DeepSeek credit on a
 * web search.
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
const DEFAULT_FALLBACK_BASE_URL = 'https://cn.bing.com/search';
const DEFAULT_MARKET = 'zh-CN';
const DEFAULT_COUNT = 10;
const DEFAULT_PAGES = 5;
const MAX_PAGES_LIMIT = 10;
const MAX_RESULTS_LIMIT = 50;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** The two transports tried against every candidate host, in this order. */
const TRANSPORTS = ['rss', 'html'];

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

/** The usable, de-duplicated hosts to try, primary first. */
function candidateBaseURLs(options) {
  const urls = [];
  for (const value of [options.baseURL, options.fallbackBaseURL]) {
    if (typeof value === 'string' && value.length > 0 && URL.canParse(value) && !urls.includes(value)) {
      urls.push(value);
    }
  }
  return urls;
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
    return candidateBaseURLs(options).length > 0 && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0;
  }

  /**
   * Search every candidate host with every transport, walking continuation pages
   * until the requested number of sources is reached (or the upstream stops
   * offering more). A host that answers with an empty result set is treated as a
   * failed attempt, not as an empty answer: Bing's RSS endpoint returns a
   * well-formed but item-less document when it throttles, and reporting that as
   * "no results" would hide the failure.
   *
   * Measured 2026-10-21 on a mainland network: Bing's CN endpoint returns only
   * ~8-10 rows per query and ignores `first`/`count`, so a target above that can
   * stay unmet even though every page is fetched. The loop still pays off on
   * networks where pagination is honoured, and it never invents rows.
   */
  async search(request, signal) {
    const options = this.resolveOptions();
    const query = String(request?.query ?? '').trim();
    if (query.length === 0) throw webError('Bing search requires a non-empty query', 'WEB_PROVIDER_ERROR');

    const hosts = candidateBaseURLs(options);
    if (hosts.length === 0) {
      throw webError(
        `Bing search has no usable endpoint (baseURL=${JSON.stringify(options.baseURL)}, fallbackBaseURL=${JSON.stringify(options.fallbackBaseURL)})`,
        'WEB_PROVIDER_ERROR',
      );
    }

    const requested = Number.isInteger(request?.maxResults) && request.maxResults > 0 ? request.maxResults : 0;
    const target = Math.min(Math.max(requested, options.count), MAX_RESULTS_LIMIT);
    const attempts = [];
    let best = [];

    for (const baseURL of hosts) {
      const collected = [];
      const seen = new Set();
      for (const transport of TRANSPORTS) {
        let url = this.#buildUrl(baseURL, options, query, target, transport);
        for (let page = 0; page < options.pages && url !== undefined && collected.length < target; page += 1) {
          try {
            const result = await this.#fetchPage(url, options, transport, signal);
            if (result.sources.length === 0) {
              if (page === 0) attempts.push(`${baseURL} [${transport}]: no results`);
              break;
            }
            let added = 0;
            for (const source of result.sources) {
              if (seen.has(source.url)) continue;
              seen.add(source.url);
              collected.push(source);
              added += 1;
              if (collected.length >= target) break;
            }
            if (added === 0) break;
            url = transport === 'html' ? nextPageUrl(result.body, result.url) : undefined;
          } catch (error) {
            if (error?.code === 'WEB_ABORTED') throw error;
            attempts.push(`${baseURL} [${transport}]: ${error?.message ?? String(error)}`);
            break;
          }
        }
        if (collected.length >= target) break;
      }
      if (collected.length > best.length) best = collected;
      if (best.length >= target) break;
    }

    if (best.length === 0) {
      throw webError(`Bing search returned nothing usable. Attempts -> ${attempts.join(' | ')}`, 'WEB_PROVIDER_ERROR');
    }
    // Nothing was silently dropped: when the upstream simply has fewer rows than
    // asked for, `truncated` stays false and the caller sees the honest count.
    return { sources: best, truncated: false };
  }

  /** Build the first-page URL for one host/transport. */
  #buildUrl(baseURL, options, query, count, transport) {
    const url = new URL(baseURL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    if (options.market.length > 0) url.searchParams.set('mkt', options.market);
    if (transport === 'rss') url.searchParams.set('format', 'rss');
    return url;
  }

  /** One HTTP round-trip: parsed sources plus the raw body, for paging links. */
  async #fetchPage(url, options, transport, signal) {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const label = transport.toUpperCase();

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent': options.userAgent,
          accept:
            transport === 'rss'
              ? 'application/rss+xml, application/xml, text/xml, */*'
              : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: combined,
      });
    } catch (error) {
      throw requestError(`Bing ${label} request to ${url.toString()} failed: ${String(error)}`, error);
    }

    if (!response.ok) {
      throw webError(`Bing ${label} request to ${url.toString()} returned HTTP ${response.status}`, 'WEB_PROVIDER_ERROR');
    }

    let body;
    try {
      body = await response.text();
    } catch (error) {
      throw requestError(`Bing ${label} response body could not be read: ${String(error)}`, error);
    }

    return {
      body,
      url: response.url.length > 0 ? response.url : url.toString(),
      sources: transport === 'rss' ? parseRss(body) : parseHtml(body),
    };
  }
}

/**
 * The next-page URL a Bing result page links to, or undefined when the page has
 * none. Only the page's own href is reliable: it carries the FPIG session token
 * Bing requires, while a hand-built `first=` query is ignored. Pure, so it is
 * unit-testable offline.
 */
function nextPageUrl(body, currentUrl) {
  const current = Number(/[?&]first=(\d+)/.exec(String(currentUrl))?.[1] ?? 1);
  let best;
  for (const match of String(body).matchAll(/href="([^"]*)"/gi)) {
    const href = match[1].replace(/&amp;/g, '&');
    const first = Number(/[?&]first=(\d+)/.exec(href)?.[1]);
    if (!Number.isInteger(first) || first <= current) continue;
    if (best === undefined || first < best.first) best = { first, href };
  }
  if (best === undefined) return undefined;
  try {
    return new URL(best.href, currentUrl).toString();
  } catch {
    return undefined;
  }
}

/** Project one resolved config into the options a single search runs with. */
function resolveOptions(config) {
  const settings = config ?? {};
  const toPositive = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);
  const toString = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback);
  return {
    baseURL: toString(settings.baseURL, DEFAULT_BASE_URL),
    fallbackBaseURL:
      settings.fallbackBaseURL === undefined
        ? DEFAULT_FALLBACK_BASE_URL
        : typeof settings.fallbackBaseURL === 'string'
          ? settings.fallbackBaseURL
          : '',
    market: typeof settings.market === 'string' ? settings.market : DEFAULT_MARKET,
    count: toPositive(settings.count, DEFAULT_COUNT),
    pages: Math.min(toPositive(settings.pages, DEFAULT_PAGES), MAX_PAGES_LIMIT),
    timeoutMs: toPositive(settings.timeoutMs, DEFAULT_TIMEOUT_MS),
    userAgent: toString(settings.userAgent, DEFAULT_USER_AGENT),
  };
}

/** Register the Bing search provider with `ctx.web`. */
export function apply(ctx, config = {}) {
  const snapshot = resolveOptions(config);
  ctx.web.registerSearchProvider(new BingSearchProvider(() => snapshot));
}

export {
  BingSearchProvider,
  parseRss,
  parseHtml,
  nextPageUrl,
  DEFAULT_BASE_URL,
  DEFAULT_FALLBACK_BASE_URL,
  DEFAULT_MARKET,
};
