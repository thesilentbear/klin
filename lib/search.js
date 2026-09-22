const UA = () => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Klin/0.1';

async function search(query, { backend = 'ddg', searxngUrl = 'http://127.0.0.1:8888', max = 5 } = {}) {
  if (backend === 'searxng') return searchSearxng(query, { searxngUrl, max });

  // DuckDuckGo first (privacy-first); if it looks bot-blocked, fall back to Bing.
  let out = await searchDuckDuckGo(query, { max });
  if (out.error || !out.results.length) {
    if (/anomal|challenge|bot/i.test(out.error || '')) {
      out = await searchBing(query, { max, fallbackReason: out.error });
    }
  }
  return out;
}

/* ----- DuckDuckGo (html endpoint) ----- */
async function searchDuckDuckGo(query, { max = 5 } = {}) {
  const out = { query, backend: 'duckduckgo', results: [], error: null, stripped: false };
  try {
    const u = new URL('https://html.duckduckgo.com/html/');
    u.searchParams.set('q', query);
    const r = await fetch(u.toString(), {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': UA() },
      redirect: 'follow',
    });
    if (!r.ok) { out.error = 'DDG HTTP ' + r.status; return out; }
    const html = await r.text();

    // bot/anomaly detection
    if (html.length < 25000 || /challenge|anomaly/i.test(html.slice(0, 2000))) {
      out.error = 'anomaly/challenge page';
      return out;
    }

    const parsed = parseDdg(html).slice(0, max);
    if (!parsed.length) { out.error = 'no results extracted'; return out; }
    out.results = await hydrate(parsed);
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

function parseDdg(html) {
  const results = [];
  const blocks = html.split(/<div\s+class="result[^"]*"/);
  for (let n = 1; n < blocks.length; n++) {
    const block = blocks[n];
    const a = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const href = decodeEntities(a[1]);
    let url = href;
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) { try { url = decodeURIComponent(m[1]); } catch { url = m[1]; } }
    const sn = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) ||
               block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/);
    results.push({
      title: decodeEntities(stripTags(a[2])).replace(/\s+/g, ' ').trim(),
      url,
      snippet: sn ? decodeEntities(stripTags(sn[1])).replace(/\s+/g, ' ').trim() : '',
    });
  }
  return results;
}

/* ----- Bing fallback ----- */
async function searchBing(query, { max = 5, fallbackReason = '' } = {}) {
  const out = { query, backend: 'bing', results: [], error: null, stripped: false, fallbackReason };
  try {
    const u = new URL('https://www.bing.com/search');
    u.searchParams.set('q', query);
    const r = await fetch(u.toString(), {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': UA() },
      redirect: 'follow',
    });
    if (!r.ok) { out.error = 'Bing HTTP ' + r.status; return out; }
    const html = await r.text();
    const parsed = parseBing(html).slice(0, max);
    if (!parsed.length) { out.error = 'no results extracted'; return out; }
    out.results = await hydrate(parsed);
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

function parseBing(html) {
  const results = [];
  const re = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  // simpler: split on b_algo boundaries
  const parts = html.split(/<li class="b_algo"/);
  for (let n = 1; n < parts.length; n++) {
    const block = parts[n].split('</li>')[0];
    const a = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(?:<[^>]+>)*([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = decodeEntities(stripTags(a[2])).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const sn = block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || block.match(/class="b_caption"[^>]*>([\s\S]*?)<(?:p|span)\s/);
    results.push({
      title,
      url: a[1],
      snippet: sn ? decodeEntities(stripTags(sn[1])).replace(/\s+/g, ' ').trim() : '',
    });
  }
  return results;
}

/* ----- SearXNG (optional self-hosted backend) ----- */
async function searchSearxng(query, { searxngUrl, max = 5 }) {
  const out = { query, backend: 'searxng', results: [], error: null, stripped: false };
  try {
    const u = new URL(searxngUrl + '/search');
    u.searchParams.set('q', query);
    u.searchParams.set('format', 'json');
    const r = await fetch(u.toString(), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) { out.error = 'SearXNG HTTP ' + r.status; return out; }
    const j = await r.json();
    const list = (j.results || []).slice(0, max).map(res => ({
      title: res.title || '', url: res.url || '', snippet: res.content || '',
    }));
    out.results = await hydrate(list);
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

/* ----- shared ----- */
async function hydrate(list) {
  return await Promise.all(list.map(async (item) => {
    const text = await fetchPageText(item.url).catch(() => '');
    return { ...item, text: text || item.snippet };
  }));
}

async function fetchPageText(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': UA() },
    redirect: 'follow',
  });
  if (!r.ok) return '';
  const html = await r.text();
  return stripHtml(html).slice(0, 20000);
}

function stripHtml(html) {
  return html
    .replace(/(<script[\s\S]*?>[\s\S]*?<\/script>)|(<style[\s\S]*?>[\s\S]*?<\/style>)/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(s) { return String(s).replace(/<[^>]+>/g, ''); }

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
}

module.exports = { search, searchDuckDuckGo, searchBing, searchSearxng };