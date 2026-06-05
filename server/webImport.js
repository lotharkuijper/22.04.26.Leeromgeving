// RAG-import vanaf een website (Task #234). Dit bestand bevat PURE, testbare
// helpers (URL-normalisatie, same-site-filter, HTML→tekst, sitemap-parsing) en
// een `discoverPages`-functie die een injecteerbare fetch gebruikt zodat de
// crawl zonder netwerk getest kan worden. De Express-endpoints in
// server/index.js gebruiken deze helpers en injecteren de echte `fetch`.

// Veiligheidsgrenzen voor de crawl/import. Bewust conservatief: een docent
// importeert een afgebakende leeromgeving (bv. een Quarto-boek), geen heel web.
export const WEB_IMPORT_LIMITS = {
  MAX_PAGES: 80,
  MAX_DEPTH: 4,
  FETCH_TIMEOUT_MS: 20000,
  MAX_HTML_BYTES: 5 * 1024 * 1024,
  MIN_TEXT_CHARS: 200,
};

// Bestandsextensies die nooit als "webpagina" tellen tijdens discovery.
const NON_PAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|pdf|zip|gz|tar|rar|mp4|webm|mov|mp3|wav|woff2?|ttf|eot|csv|xlsx?|docx?|pptx?)(\?|#|$)/i;

// HTML-blokelementen waarvan het sluiten een alinea-/regelovergang markeert,
// zodat de platte tekst leesbare paragrafen behoudt na het strippen van tags.
const BLOCK_CLOSE_RE = /<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|blockquote|pre|figure|figcaption)\s*>/gi;

// Containers die we volledig verwijderen vóór tekstextractie (navigatie,
// scripts, styling, embeds). Lazy match zodat geneste tags correct sluiten.
const STRIP_BLOCKS = [
  'script', 'style', 'noscript', 'template', 'svg', 'head',
  'nav', 'header', 'footer', 'form', 'iframe', 'aside',
];

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', euro: '\u20ac', laquo: '\u00ab',
  raquo: '\u00bb', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c',
  rdquo: '\u201d', deg: '\u00b0', times: '\u00d7', divide: '\u00f7',
};

// Decodeert de gangbare HTML-entiteiten (named + numeriek decimaal/hex).
export function decodeHtmlEntities(input) {
  return String(input || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

// Normaliseert een URL naar een vergelijkbare, canonieke vorm. Verwijdert de
// fragment (#...) en query (?...), maakt host lowercase en strip een afsluitende
// slash (behalve op de root). Geeft `null` terug bij een ongeldige of
// niet-http(s) URL. `base` laat relatieve hrefs resolven.
export function normalizeUrl(raw, base) {
  if (!raw) return null;
  let u;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.search = '';
  u.hostname = u.hostname.toLowerCase();
  // Trailing slashes blijven bewust behouden: ze onderscheiden een directory
  // (`/boek/`) van een bestand (`/boek`) en zijn nodig om relatieve links
  // correct te resolven tijdens de crawl.
  return u.toString();
}

// Geeft `true` als een IP-literal (IPv4, IPv6 of IPv4-mapped IPv6) naar het
// interne/private netwerk wijst (loopback, RFC1918, link-local, unique-local,
// multicast/reserved). Pure helper; gebruikt voor zowel URL-literals als voor
// IP's die uit DNS-resolutie komen (zie `hostResolvesToBlocked`).
export function isBlockedIp(rawIp) {
  let host = String(rawIp || '').toLowerCase().trim();
  if (!host) return true;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10).
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → val terug op de IPv4-controle.
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const ipv4 = mapped ? mapped[1] : host;
  const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 127 || a === 10) return true;           // 0.x, loopback, 10.x
    if (a === 169 && b === 254) return true;                      // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;             // 172.16–31.x
    if (a === 192 && b === 168) return true;                      // 192.168.x
    if (a >= 224) return true;                                    // multicast/reserved
  }
  return false;
}

// Herkent of een hostnaam in feite een IP-literal is (IPv4 of IPv6). Voor die
// gevallen is DNS-resolutie zinloos en volstaat `isBlockedIp`.
export function isIpLiteral(host) {
  if (!host) return false;
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

// SSRF-bescherming op naamniveau: blokkeert URL's die naar het interne/private
// netwerk wijzen (loopback, RFC1918, link-local, unique-local IPv6,
// .internal/.local en IP-literals). Pure, synchrone helper — geen DNS-resolutie
// (zie `hostResolvesToBlocked` voor de netwerklaag). Geeft `true` als geblokkeerd.
export function isBlockedHost(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (!host) return true;
  // URL.hostname levert IPv6-literals mét vierkante haken; strip ze voor de match.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (isBlockedIp(host)) return true;
  return false;
}

// SSRF-bescherming op netwerklaag: resolved een hostnaam (A/AAAA) en geeft
// `true` als één van de resolved IP's in een geblokkeerde range valt — dit vangt
// de klassieke DNS-rebinding/SSRF-bypass waarbij een publieke hostnaam naar een
// privé-adres wijst. `lookup` is injecteerbaar voor tests; ontbreekt die, dan
// wordt de DNS-controle overgeslagen (de synchrone `isBlockedHost`-checks
// blijven gelden). Bij een resolutiefout of leeg resultaat → `true` (fail-safe).
export async function hostResolvesToBlocked(hostname, lookup) {
  if (!lookup) return false;
  if (isIpLiteral(hostname)) return isBlockedIp(hostname);
  try {
    const ips = await lookup(hostname);
    if (!Array.isArray(ips) || ips.length === 0) return true;
    return ips.some((ip) => isBlockedIp(ip));
  } catch {
    return true;
  }
}

// Bepaalt het "directory"-pad-prefix van een basis-URL (lowercase) zodat we
// kunnen toetsen of een pagina binnen dezelfde omgeving valt:
//  - eindigt het pad op '/'                 → het pad zelf  (`/boek/`)
//  - lijkt het laatste segment een bestand  → tot de laatste slash (`/boek/index.html` → `/boek/`)
//  - anders (extensieloos, bv. `/Boek`)     → het pad + '/' (als directory behandeld)
// Zo werken zowel `.../Statistical-Inference/` als `.../Statistical-Inference`
// en `.../Statistical-Inference/index.html` allemaal als prefix `/statistical-inference/`.
function dirPrefix(pathname) {
  const lower = pathname.toLowerCase();
  if (lower === '' || lower === '/') return '/';
  if (lower.endsWith('/')) return lower;
  const lastSeg = lower.slice(lower.lastIndexOf('/') + 1);
  if (lastSeg.includes('.')) {
    return lower.slice(0, lower.lastIndexOf('/') + 1) || '/';
  }
  return lower + '/';
}

// Hoort `candidateUrl` bij dezelfde webomgeving als `baseUrl`? Vereist dezelfde
// origin (protocol+host+poort) én dat het pad onder het basis-directory-prefix
// valt. Zo blijft de crawl binnen één boek/site en lekt hij niet naar de hele host.
export function sameWebEnvironment(baseUrl, candidateUrl) {
  let base, cand;
  try {
    base = new URL(baseUrl);
    cand = new URL(candidateUrl);
  } catch {
    return false;
  }
  if (base.origin !== cand.origin) return false;
  if (NON_PAGE_EXT_RE.test(cand.pathname)) return false;
  return cand.pathname.toLowerCase().startsWith(dirPrefix(base.pathname));
}

// Haalt de <title> uit een HTML-document. Valt terug op de eerste <h1>.
export function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m && m[1].trim()) return decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim();
  const h1 = String(html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return decodeHtmlEntities(h1[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return '';
}

// Strip een set blok-containers (incl. inhoud) uit HTML.
function stripContainers(html) {
  let out = html;
  for (const tag of STRIP_BLOCKS) {
    const re = new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    out = out.replace(re, ' ');
    // Self-closing of ongesloten varianten (bv. <iframe ... />).
    out = out.replace(new RegExp(`<${tag}[^>]*\\/?>`, 'gi'), ' ');
  }
  return out;
}

// Zet een HTML-document om naar schone, leesbare platte tekst. Verwijdert
// scripts/styling/navigatie/embeds, behoudt alinea-overgangen en decodeert
// entiteiten. Wanneer een <main>/<article> aanwezig is, wordt die als
// inhoudskern gebruikt zodat sidebars en boilerplate wegvallen.
export function htmlToText(html) {
  let src = String(html || '');
  // Comments verwijderen.
  src = src.replace(/<!--[\s\S]*?-->/g, ' ');

  // Indien aanwezig: focus op de hoofdinhoud.
  const mainMatch = src.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || src.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  let body = mainMatch ? mainMatch[1] : src;

  body = stripContainers(body);
  // Blok-einden → newline-marker vóór het strippen van alle tags.
  body = body.replace(BLOCK_CLOSE_RE, '\n');
  body = body.replace(/<br\s*\/?>/gi, '\n');
  // Alle resterende tags verwijderen.
  body = body.replace(/<[^>]+>/g, ' ');
  body = decodeHtmlEntities(body);

  // Witruimte normaliseren: spaties/tabs samenvouwen, regels trimmen, en
  // 3+ lege regels terugbrengen tot een dubbele newline (alinea-scheiding).
  const lines = body
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').replace(/ +([.,;:!?])/g, '$1').trim());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

// Parseert een sitemap.xml (of sitemap-index) en geeft alle <loc>-URL's terug.
export function parseSitemap(xml) {
  const out = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    const url = decodeHtmlEntities(m[1]).trim();
    if (url) out.push(url);
  }
  return out;
}

// Haalt alle href-doelen uit HTML en resolved ze (absoluut + genormaliseerd)
// t.o.v. `pageUrl`. Dubbele en ongeldige links worden weggefilterd.
export function extractLinks(html, pageUrl) {
  const out = new Set();
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const raw = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    const norm = normalizeUrl(raw, pageUrl);
    if (norm) out.add(norm);
  }
  return [...out];
}

// Eén pagina ophalen met timeout + groottebegrenzing. Retourneert
// { ok, status, html, contentType }. Gooit niet; fouten komen als ok:false terug.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function hostnameOf(rawUrl) {
  try {
    let h = new URL(rawUrl).hostname.toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    return h;
  } catch {
    return '';
  }
}

export async function fetchPage(url, fetchImpl, {
  timeoutMs = WEB_IMPORT_LIMITS.FETCH_TIMEOUT_MS,
  maxBytes = WEB_IMPORT_LIMITS.MAX_HTML_BYTES,
  scope = null,
  lookup = null,
} = {}) {
  if (isBlockedHost(url)) {
    return { ok: false, status: 0, html: '', contentType: '', finalUrl: url, error: 'geblokkeerde host (intern netwerk)' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // SSRF-hardening: volg redirects HANDMATIG (`redirect: 'manual'`) zodat elke
    // hop opnieuw wordt gevalideerd. Met `redirect: 'follow'` zou een toegestane
    // publieke URL kunnen doorverwijzen naar een intern adres (bijv.
    // 169.254.169.254 of loopback) zonder dat wij dat zien. Per hop checken we:
    //   1. isBlockedHost (naam/IP-literal),
    //   2. hostResolvesToBlocked (DNS A/AAAA → privé-IP, indien `lookup` gegeven),
    //   3. scope (sameWebEnvironment, indien `scope` gegeven) — voor redirecthops.
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (isBlockedHost(current)) {
        return { ok: false, status: 0, html: '', contentType: '', finalUrl: current, error: 'geblokkeerde host (intern netwerk)' };
      }
      if (await hostResolvesToBlocked(hostnameOf(current), lookup)) {
        return { ok: false, status: 0, html: '', contentType: '', finalUrl: current, error: 'host resolvet naar geblokkeerd adres (intern netwerk)' };
      }
      const resp = await fetchImpl(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'LEAP-VU-RAG-Import/1.0 (+educational)' },
      });
      const status = resp.status;
      if (REDIRECT_STATUSES.has(status)) {
        const location = resp.headers?.get?.('location');
        if (!location) return { ok: false, status, html: '', contentType: '', finalUrl: current, error: 'redirect zonder Location' };
        const next = normalizeUrl(location, current);
        if (!next) return { ok: false, status, html: '', contentType: '', finalUrl: current, error: 'ongeldige redirect-URL' };
        if (scope && !sameWebEnvironment(scope, next)) {
          return { ok: false, status, html: '', contentType: '', finalUrl: next, error: 'redirect buiten de toegestane webomgeving (scope)' };
        }
        current = next;
        continue;
      }
      const contentType = (resp.headers?.get?.('content-type') || '').toLowerCase();
      if (!resp.ok) return { ok: false, status, html: '', contentType, finalUrl: current };
      const text = await resp.text();
      const html = text.length > maxBytes ? text.slice(0, maxBytes) : text;
      return { ok: true, status, html, contentType, finalUrl: current };
    }
    return { ok: false, status: 0, html: '', contentType: '', finalUrl: current, error: 'te veel redirects' };
  } catch (err) {
    return { ok: false, status: 0, html: '', contentType: '', finalUrl: url, error: err?.message || 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

function isHtmlResponse(contentType) {
  return !contentType || contentType.includes('text/html') || contentType.includes('application/xhtml');
}

// Ontdekt welke pagina's bij de webomgeving van `baseUrl` horen. Probeert eerst
// een sitemap.xml; valt anders terug op een breadth-first crawl over interne
// links binnen dezelfde omgeving. `fetchImpl` is injecteerbaar voor tests.
// Retourneert { pages: [{url,title}], method, warnings }.
export async function discoverPages(baseUrl, fetchImpl, opts = {}) {
  const maxPages = opts.maxPages ?? WEB_IMPORT_LIMITS.MAX_PAGES;
  const maxDepth = opts.maxDepth ?? WEB_IMPORT_LIMITS.MAX_DEPTH;
  const lookup = opts.lookup ?? null;
  const warnings = [];

  const start = normalizeUrl(baseUrl);
  if (!start) {
    return { pages: [], method: 'none', warnings: ['Ongeldige URL'] };
  }

  // 1) Sitemap-pad: probeer de sitemap binnen de omgeving en op host-root.
  const sitemapCandidates = [];
  try {
    sitemapCandidates.push(new URL('sitemap.xml', start.endsWith('/') ? start : start + '/').toString());
    sitemapCandidates.push(new URL('/sitemap.xml', start).toString());
  } catch { /* ignore */ }

  const seenSitemap = new Set();
  for (const sm of sitemapCandidates) {
    if (seenSitemap.has(sm)) continue;
    seenSitemap.add(sm);
    const res = await fetchPage(sm, fetchImpl, { lookup });
    if (!res.ok || !/<urlset|<sitemapindex|<loc>/i.test(res.html)) continue;
    const locs = parseSitemap(res.html)
      .map((u) => normalizeUrl(u))
      .filter((u) => u && sameWebEnvironment(start, u));
    const unique = [...new Set(locs)];
    if (unique.length > 0) {
      const limited = unique.slice(0, maxPages);
      if (unique.length > maxPages) warnings.push(`Sitemap bevat ${unique.length} pagina's; beperkt tot ${maxPages}.`);
      // Titels ophalen blijft achterwege bij de sitemap-route (sneller); de
      // import vult de titel alsnog uit de pagina-<title>.
      return {
        pages: limited.map((u) => ({ url: u, title: '' })),
        method: 'sitemap',
        warnings,
      };
    }
  }

  // 2) BFS-crawl over interne links.
  const visited = new Set();
  const pages = [];
  const queue = [{ url: start, depth: 0 }];
  while (queue.length > 0 && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const res = await fetchPage(url, fetchImpl, { lookup });
    if (!res.ok) {
      warnings.push(`Kon pagina niet ophalen (${res.status || 'netwerkfout'}): ${url}`);
      continue;
    }
    if (!isHtmlResponse(res.contentType)) continue;

    pages.push({ url, title: extractTitle(res.html) });

    if (depth < maxDepth) {
      for (const link of extractLinks(res.html, url)) {
        if (!visited.has(link) && sameWebEnvironment(start, link)) {
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }

  if (pages.length >= maxPages) {
    warnings.push(`Maximaal aantal pagina's (${maxPages}) bereikt; mogelijk niet de hele site.`);
  }

  return { pages, method: 'crawl', warnings };
}
