/**
 * Standalone checks for the Bing search provider, runnable with the workspace's
 * portable Node (`node test/search.test.mjs`). They exercise the real seam
 * contract against the live Bing endpoint plus the pure parsers offline.
 */
import { apply, parseRss, parseHtml, BingSearchProvider } from '../index.js';

let failures = 0;

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`[${status}] ${label}${detail.length > 0 ? ` :: ${detail}` : ''}`);
}

/** Capture the provider the plugin registers, exactly as the seam would. */
function mount(config) {
  let provider;
  const ctx = {
    web: {
      registerSearchProvider(candidate) {
        provider = candidate;
        return () => {};
      },
    },
  };
  apply(ctx, config);
  return provider;
}

const provider = mount({ market: 'zh-CN', count: 10 });
check('plugin registers a provider with id "bing"', provider?.id === 'bing', String(provider?.id));
check('provider is available without any credential', provider?.available() === true);

const live = await provider.search({ query: 'deepseek harness', maxResults: 5 });
check('live search returns sources', Array.isArray(live.sources) && live.sources.length > 0, `${live.sources.length} sources`);
check('live sources carry https urls', live.sources.every((s) => /^https:\/\//.test(s.url)));
check('live sources carry titles', live.sources.every((s) => typeof s.title === 'string' && s.title.length > 0));
check('live result is not pre-truncated', live.truncated === false);
console.log('   sample:', JSON.stringify(live.sources[0]).slice(0, 220));

const empty = await provider.search({ query: '   ' }).then(
  () => 'resolved',
  (error) => error.code ?? error.name,
);
check('blank query is rejected with a seam code', empty === 'WEB_PROVIDER_ERROR', String(empty));

const rss = parseRss(
  '<rss><channel><item><title>A &amp; B</title><link>https://example.com/a?x=1&amp;y=2</link>' +
    '<description><![CDATA[<b>hi</b> there]]></description><pubDate>Fri, 10 Oct 2026 00:00:00 GMT</pubDate></item>' +
    '<item><title>dup</title><link>https://example.com/a?x=1&amp;y=2</link></item></channel></rss>',
);
check('rss parser decodes entities and urls', rss[0]?.url === 'https://example.com/a?x=1&y=2', rss[0]?.url);
check('rss parser strips markup from snippets', rss[0]?.snippet === 'hi there', rss[0]?.snippet);
check('rss parser dedupes by url', rss.length === 1, String(rss.length));

const html = parseHtml(
  '<ol id="b_results"><li class="b_algo"><h2><a href="https://example.org/page">Example &amp; Co</a></h2>' +
    '<p>Snippet text here.</p></li><li class="b_algo"><h2><a href="https://example.net/two">Two</a></h2></li></ol>',
);
check('html parser extracts anchors', html.length === 2, String(html.length));
check('html parser decodes titles', html[0]?.title === 'Example & Co', html[0]?.title);
check('html parser keeps snippets optional', html[1]?.snippet === undefined);

const failing = new BingSearchProvider(() => ({
  baseURL: 'https://bing.invalid.example/search',
  market: 'zh-CN',
  count: 5,
  timeoutMs: 8000,
  userAgent: 'test',
}));
check('unreachable endpoint is reported as available config', failing.available() === true);
const failure = await failing.search({ query: 'x' }).then(
  () => 'resolved',
  (error) => error.code ?? error.name,
);
check('unreachable endpoint fails with a seam code', failure === 'WEB_PROVIDER_ERROR', String(failure));

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
