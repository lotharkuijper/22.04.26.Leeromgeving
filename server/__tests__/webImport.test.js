import { describe, it, expect } from 'vitest';
import {
  decodeHtmlEntities,
  normalizeUrl,
  sameWebEnvironment,
  extractTitle,
  htmlToText,
  parseSitemap,
  extractLinks,
  discoverPages,
  isBlockedHost,
  fetchPage,
} from '../webImport.js';

describe('decodeHtmlEntities', () => {
  it('decodeert named, decimaal en hex entiteiten', () => {
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b');
    expect(decodeHtmlEntities('5 &lt; 10 &gt; 2')).toBe('5 < 10 > 2');
    expect(decodeHtmlEntities('caf&#233;')).toBe('café');
    expect(decodeHtmlEntities('&#x2014;')).toBe('\u2014');
    expect(decodeHtmlEntities('non&nbsp;break')).toBe('non break');
  });
  it('laat onbekende entiteiten ongemoeid', () => {
    expect(decodeHtmlEntities('&unknownentity;')).toBe('&unknownentity;');
  });
});

describe('normalizeUrl', () => {
  it('strip fragment en query, lowercased host, behoudt trailing slash', () => {
    expect(normalizeUrl('https://Example.com/Foo/?x=1#frag')).toBe('https://example.com/Foo/');
  });
  it('behoudt root-slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });
  it('resolveert relatieve hrefs t.o.v. base', () => {
    expect(normalizeUrl('intro.html', 'https://example.com/book/index.html'))
      .toBe('https://example.com/book/intro.html');
    expect(normalizeUrl('../other.html', 'https://example.com/book/sub/page.html'))
      .toBe('https://example.com/book/other.html');
  });
  it('weigert niet-http(s) en ongeldige URLs', () => {
    expect(normalizeUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
});

describe('sameWebEnvironment', () => {
  const base = 'https://shklinkenberg.github.io/Statistical-Inference/';
  it('accepteert pagina onder hetzelfde directory-prefix', () => {
    expect(sameWebEnvironment(base, 'https://shklinkenberg.github.io/Statistical-Inference/intro.html')).toBe(true);
    expect(sameWebEnvironment(base, 'https://shklinkenberg.github.io/Statistical-Inference/ch/01.html')).toBe(true);
  });
  it('werkt ook als base een bestand is', () => {
    const fileBase = 'https://shklinkenberg.github.io/Statistical-Inference/index.html';
    expect(sameWebEnvironment(fileBase, 'https://shklinkenberg.github.io/Statistical-Inference/intro.html')).toBe(true);
  });
  it('weigert andere paden, andere hosts en binaire assets', () => {
    expect(sameWebEnvironment(base, 'https://shklinkenberg.github.io/Other-Book/intro.html')).toBe(false);
    expect(sameWebEnvironment(base, 'https://elders.example.com/Statistical-Inference/intro.html')).toBe(false);
    expect(sameWebEnvironment(base, 'https://shklinkenberg.github.io/Statistical-Inference/img/plot.png')).toBe(false);
    expect(sameWebEnvironment(base, 'https://shklinkenberg.github.io/Statistical-Inference/data.csv')).toBe(false);
  });
});

describe('isBlockedHost', () => {
  it('blokkeert loopback en interne hostnamen', () => {
    expect(isBlockedHost('http://localhost/x')).toBe(true);
    expect(isBlockedHost('http://service.localhost/')).toBe(true);
    expect(isBlockedHost('http://db.internal/')).toBe(true);
    expect(isBlockedHost('http://printer.local/')).toBe(true);
    expect(isBlockedHost('http://127.0.0.1:8080/')).toBe(true);
  });
  it('blokkeert private IPv4-bereiken en link-local', () => {
    expect(isBlockedHost('http://10.0.0.5/')).toBe(true);
    expect(isBlockedHost('http://192.168.1.1/')).toBe(true);
    expect(isBlockedHost('http://172.16.0.9/')).toBe(true);
    expect(isBlockedHost('http://172.31.255.255/')).toBe(true);
    expect(isBlockedHost('http://169.254.169.254/')).toBe(true);
  });
  it('blokkeert IPv6 loopback/unique-local en ongeldige input', () => {
    expect(isBlockedHost('http://[::1]/')).toBe(true);
    expect(isBlockedHost('http://[fc00::1]/')).toBe(true);
    expect(isBlockedHost('http://[fe80::1]/')).toBe(true);
    expect(isBlockedHost('niet-een-url')).toBe(true);
  });
  it('staat publieke hosts toe', () => {
    expect(isBlockedHost('https://shklinkenberg.github.io/Statistical-Inference/')).toBe(false);
    expect(isBlockedHost('https://example.com/')).toBe(false);
    expect(isBlockedHost('http://172.32.0.1/')).toBe(false);
  });
});

describe('extractTitle', () => {
  it('pakt de <title>', () => {
    expect(extractTitle('<html><head><title>Hoofdstuk 1 &amp; 2</title></head></html>')).toBe('Hoofdstuk 1 & 2');
  });
  it('valt terug op de eerste <h1>', () => {
    expect(extractTitle('<body><h1>Inleiding <span>statistiek</span></h1></body>')).toBe('Inleiding statistiek');
  });
  it('geeft lege string zonder titel', () => {
    expect(extractTitle('<body><p>geen titel</p></body>')).toBe('');
  });
});

describe('htmlToText', () => {
  it('verwijdert scripts/styling/nav en behoudt alinea-overgangen', () => {
    const html = `
      <html><head><title>T</title><style>.x{color:red}</style></head>
      <body>
        <nav><a href="/x">menu</a></nav>
        <main>
          <h1>Titel</h1>
          <p>Eerste alinea met <strong>nadruk</strong>.</p>
          <script>console.log('weg')</script>
          <p>Tweede alinea.</p>
        </main>
        <footer>copyright</footer>
      </body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Titel');
    expect(text).toContain('Eerste alinea met nadruk.');
    expect(text).toContain('Tweede alinea.');
    expect(text).not.toContain('menu');
    expect(text).not.toContain('copyright');
    expect(text).not.toContain('console.log');
    // Alinea-scheiding aanwezig.
    expect(text).toMatch(/Eerste alinea[\s\S]*\n[\s\S]*Tweede alinea/);
  });
  it('decodeert entiteiten in de tekst', () => {
    expect(htmlToText('<p>a &amp; b &lt; c</p>')).toContain('a & b < c');
  });
});

describe('parseSitemap', () => {
  it('haalt alle <loc> entries op', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://example.com/a.html</loc></url>
      <url><loc>https://example.com/b.html?x=1&amp;y=2</loc></url>
    </urlset>`;
    expect(parseSitemap(xml)).toEqual([
      'https://example.com/a.html',
      'https://example.com/b.html?x=1&y=2',
    ]);
  });
});

describe('extractLinks', () => {
  it('haalt absolute en relatieve links op, ontdubbeld, zonder anchors/mailto', () => {
    const html = `
      <a href="intro.html">x</a>
      <a href='./intro.html'>dup</a>
      <a href="https://example.com/book/ch1.html">y</a>
      <a href="#section">skip</a>
      <a href="mailto:a@b.com">skip</a>`;
    const links = extractLinks(html, 'https://example.com/book/index.html');
    expect(links).toContain('https://example.com/book/intro.html');
    expect(links).toContain('https://example.com/book/ch1.html');
    expect(links.filter((l) => l.endsWith('intro.html')).length).toBe(1);
    expect(links.some((l) => l.includes('section'))).toBe(false);
  });
});

// Bouwt een fake fetch op basis van een url→{html,contentType,status} map.
function makeFetch(pages) {
  return async (url) => {
    const entry = pages[url] || pages[url.replace(/\/$/, '')] || pages[url + '/'];
    if (!entry) return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
    return {
      ok: entry.status ? entry.status < 400 : true,
      status: entry.status || 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (entry.contentType || 'text/html') : null) },
      text: async () => entry.html || '',
    };
  };
}

// Fake fetch die één redirect-hop simuleert: bij `from` geeft het een 302 met
// Location=`to`; bij elke andere URL een gewone 200 met wat HTML.
function makeRedirectFetch(hops) {
  return async (url) => {
    if (hops[url]) {
      return {
        ok: false,
        status: 302,
        headers: { get: (k) => (k.toLowerCase() === 'location' ? hops[url] : null) },
        text: async () => '',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
      text: async () => '<html><body><p>ok</p></body></html>',
    };
  };
}

describe('fetchPage SSRF-redirect-hardening', () => {
  it('weigert een redirect naar een link-local metadata-adres', async () => {
    const f = makeRedirectFetch({ 'https://example.com/start': 'http://169.254.169.254/latest/meta-data/' });
    const res = await fetchPage('https://example.com/start', f);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/geblokkeerde host/i);
  });
  it('weigert een redirect naar loopback', async () => {
    const f = makeRedirectFetch({ 'https://example.com/start': 'http://127.0.0.1:8080/admin' });
    const res = await fetchPage('https://example.com/start', f);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/geblokkeerde host/i);
  });
  it('weigert een redirect naar een interne hostname', async () => {
    const f = makeRedirectFetch({ 'https://example.com/start': 'http://vault.internal/secret' });
    const res = await fetchPage('https://example.com/start', f);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/geblokkeerde host/i);
  });
  it('volgt een redirect naar een toegestane publieke host', async () => {
    const f = makeRedirectFetch({ 'https://example.com/start': 'https://example.com/eind' });
    const res = await fetchPage('https://example.com/start', f);
    expect(res.ok).toBe(true);
    expect(res.html).toContain('ok');
  });
});

describe('discoverPages', () => {
  it('gebruikt de sitemap wanneer beschikbaar en filtert op de omgeving', async () => {
    const base = 'https://example.com/book/';
    const fetchImpl = makeFetch({
      'https://example.com/book/sitemap.xml': {
        contentType: 'application/xml',
        html: `<urlset>
          <url><loc>https://example.com/book/index.html</loc></url>
          <url><loc>https://example.com/book/ch1.html</loc></url>
          <url><loc>https://example.com/elders/x.html</loc></url>
        </urlset>`,
      },
    });
    const { pages, method } = await discoverPages(base, fetchImpl);
    expect(method).toBe('sitemap');
    const urls = pages.map((p) => p.url);
    expect(urls).toContain('https://example.com/book/index.html');
    expect(urls).toContain('https://example.com/book/ch1.html');
    expect(urls).not.toContain('https://example.com/elders/x.html');
  });

  it('valt terug op een BFS-crawl binnen de omgeving', async () => {
    const base = 'https://example.com/book/';
    const fetchImpl = makeFetch({
      // Geen sitemap → 404 voor beide kandidaten.
      'https://example.com/book/': {
        html: `<html><head><title>Index</title></head><body>
          <a href="ch1.html">1</a>
          <a href="https://example.com/elders/out.html">extern-pad</a>
        </body></html>`,
      },
      'https://example.com/book/ch1.html': {
        html: `<html><head><title>Hoofdstuk 1</title></head><body>
          <a href="ch2.html">2</a><a href="index.html">home</a>
        </body></html>`,
      },
      'https://example.com/book/ch2.html': {
        html: `<html><head><title>Hoofdstuk 2</title></head><body><p>einde</p></body></html>`,
      },
    });
    const { pages, method } = await discoverPages(base, fetchImpl, { maxDepth: 3 });
    expect(method).toBe('crawl');
    const urls = pages.map((p) => p.url).sort();
    expect(urls).toEqual([
      'https://example.com/book/',
      'https://example.com/book/ch1.html',
      'https://example.com/book/ch2.html',
    ]);
    expect(pages.find((p) => p.url.endsWith('ch1.html')).title).toBe('Hoofdstuk 1');
    expect(urls.some((u) => u.includes('elders'))).toBe(false);
  });

  it('respecteert de maxPages-limiet', async () => {
    const base = 'https://example.com/book/';
    const fetchImpl = makeFetch({
      'https://example.com/book/': {
        html: `<a href="a.html">a</a><a href="b.html">b</a><a href="c.html">c</a>`,
      },
      'https://example.com/book/a.html': { html: '<p>a</p>' },
      'https://example.com/book/b.html': { html: '<p>b</p>' },
      'https://example.com/book/c.html': { html: '<p>c</p>' },
    });
    const { pages, warnings } = await discoverPages(base, fetchImpl, { maxPages: 2 });
    expect(pages.length).toBe(2);
    expect(warnings.some((w) => w.includes('Maximaal'))).toBe(true);
  });
});
