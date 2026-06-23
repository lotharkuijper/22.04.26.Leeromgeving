// Embeddings-calls met herhaalpoging bij Azure-snelheidslimieten (HTTP 429).
// Losgekoppeld van server/index.js en volledig via dependency injection zodat de
// retry-/backoff-logica zonder draaiende Express-server getest kan worden
// (server/__tests__/embeddingsRetry.test.js). De productie-aanroep injecteert de
// echte fetch, URL, auth-headers en een sleep-functie.

// Gebruikersgerichte (Nederlandse) melding wanneer de snelheidslimiet ook na
// alle herhaalpogingen blijft. Bewust geen ruwe Azure-tekst.
export const EMBEDDINGS_RATE_LIMIT_MSG =
  'De embeddings-service heeft tijdelijk de snelheidslimiet bereikt. Wacht ongeveer een halve minuut en probeer het opnieuw, of upload minder bestanden tegelijk.';

// Herkent of een mislukte respons een snelheidslimiet is (HTTP 429 of een
// expliciete rate_limit_exceeded-code in de foutbody).
export function isRateLimitStatus(status, errData) {
  if (status === 429) return true;
  const code = errData && errData.error && errData.error.code;
  return code === 'rate_limit_exceeded' || code === '429';
}

// Bepaalt hoeveel milliseconden gewacht moet worden voor de volgende poging.
// Volgorde: 1) Retry-After-header, 2) wachttijd uit de foutmelding
// ("retry after N seconds" / "try again in Ns"), 3) exponentiele backoff als
// vangnet. Begrensd op maxWaitMs en altijd met een kleine marge.
export function parseRetryWaitMs(resp, errData, attempt, { maxWaitMs = 60000 } = {}) {
  let secs = NaN;

  const header =
    resp && resp.headers && typeof resp.headers.get === 'function'
      ? resp.headers.get('retry-after')
      : null;
  if (header != null && header !== '') {
    const n = parseFloat(header);
    if (Number.isFinite(n)) secs = n;
  }

  if (!Number.isFinite(secs)) {
    const raw = errData && errData.error && (errData.error.message || errData.error);
    const text = typeof raw === 'string' ? raw : '';
    const m =
      text.match(/retry after ([\d.]+)\s*seconds?/i) ||
      text.match(/try again in ([\d.]+)\s*s/i) ||
      text.match(/in ([\d.]+)\s*seconds?/i);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) secs = n;
    }
  }

  if (!Number.isFinite(secs) || secs < 0) {
    secs = Math.min(30, 2 ** Math.max(0, attempt));
  }

  const ms = Math.ceil(secs * 1000) + 500; // kleine marge bovenop de gevraagde tijd
  return Math.min(maxWaitMs, Math.max(0, ms));
}

// Voert een embeddings-call uit met herhaalpoging bij 429. `deps`:
//   fetchImpl(url, init) -> Response  (verplicht)
//   url            embeddings-endpoint (verplicht)
//   headers()      -> headers-object voor de call (verplicht)
//   sleep(ms)      -> Promise         (verplicht)
//   maxRetries     aantal extra pogingen na de eerste (default 5)
//   maxWaitMs      bovengrens per wachttijd (default 60000)
//   model          modelnaam in de body (default text-embedding-3-small)
//   log(msg)       optionele logger
// Retourneert het geparste JSON-object ({ data: [...] }). Gooit bij blijvende
// fout een Error met `.status`, `.isRateLimit` en (bij rate limit) `.azureMessage`.
export async function embeddingsRequestWithRetry(input, deps = {}) {
  const {
    fetchImpl,
    url,
    headers,
    sleep,
    maxRetries = 5,
    maxWaitMs = 60000,
    model = 'text-embedding-3-small',
    log = () => {},
  } = deps;

  if (typeof fetchImpl !== 'function') throw new Error('embeddingsRequestWithRetry: fetchImpl ontbreekt');
  if (typeof sleep !== 'function') throw new Error('embeddingsRequestWithRetry: sleep ontbreekt');

  let networkErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let resp;
    try {
      resp = await fetchImpl(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model, input }),
      });
    } catch (err) {
      networkErr = err;
      if (attempt === maxRetries) throw err;
      await sleep(Math.min(maxWaitMs, 2 ** attempt * 1000));
      continue;
    }

    if (resp.ok) {
      const data = await resp.json();
      if (!data || !Array.isArray(data.data)) {
        throw new Error('Onverwacht antwoord van de embeddings-API');
      }
      return data;
    }

    const errData = await resp.json().catch(() => ({}));
    const rateLimited = isRateLimitStatus(resp.status, errData);

    if (!rateLimited || attempt === maxRetries) {
      const baseMsg =
        (errData && errData.error && (errData.error.message || errData.error)) ||
        `Azure embeddings error ${resp.status}`;
      const e = new Error(rateLimited ? EMBEDDINGS_RATE_LIMIT_MSG : String(baseMsg));
      e.status = resp.status;
      e.isRateLimit = rateLimited;
      e.azureMessage = typeof baseMsg === 'string' ? baseMsg : String(baseMsg);
      throw e;
    }

    const waitMs = parseRetryWaitMs(resp, errData, attempt, { maxWaitMs });
    log(`[embeddings] Azure-snelheidslimiet (429) — wacht ${waitMs}ms en probeer opnieuw (poging ${attempt + 1}/${maxRetries}).`);
    await sleep(waitMs);
  }

  throw networkErr || new Error('Embeddings onbereikbaar');
}
