// -----------------------------------------------------------------------------
// LINDAS, the linked data service of the Swiss federal administration, where
// ElCom publishes the electricity tariffs of every municipality (open data, no
// key). One SPARQL request per municipality and year, sent as a form POST
// with the User-Agent of the integration and `Accept` asking for the SPARQL
// JSON results explicitly. The answer is cut past MAX_BODY_BYTES and the whole
// exchange past REQUEST_TIMEOUT.
//
// What an answer means:
//   - 200 + SPARQL JSON results          -> the rows (possibly none);
//   - 429                                -> 'rate_limited' (+ Retry-After);
//   - 5xx, network, timeout              -> 'server' / 'network' / 'timeout';
//   - too large, not JSON, other status  -> 'too_large' / 'unreadable'.
// Every failure pauses the requests (src/app.js). The queries only ever hold
// integers checked here and search texts restricted to letters, digits and a
// few signs (no quote, no backslash): nothing can break out of a literal.
// -----------------------------------------------------------------------------

import {
  ELCOM_CUBE,
  ELCOM_GRAPH,
  ELCOM_NS,
  LINDAS_URL,
  MAX_BODY_BYTES,
  MAX_ROWS,
  MUNICIPALITY_NS,
  REPO_URL,
  REQUEST_TIMEOUT,
  USER_AGENT_BASE,
} from './constants.js';

export class LindasError extends Error {
  /**
   * @param {string} code
   * @param {{ status?: number | null, retryAfter?: number | null }} [details]
   */
  constructor(code, { status = null, retryAfter = null } = {}) {
    super(status ? `${code} (HTTP ${status})` : code);
    this.name = 'LindasError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

const PREFIXES = `PREFIX schema: <http://schema.org/>
PREFIX : <${ELCOM_NS}dimension/>`;

/** The tariffs of one municipality (BFS number) for one year, every operator, category and product. */
export function tariffQuery(municipality, year) {
  if (!isInt(municipality, 1, 99999) || !isInt(year, 1900, 9999)) {
    throw new TypeError('tariffQuery: municipality and year must be integers');
  }
  return `${PREFIXES}
SELECT ?operator ?operatorName ?category ?product ?total ?energy ?gridusage ?charge ?aidfee ?meteringrate ?energyname ?modified WHERE {
  GRAPH <${ELCOM_GRAPH}> {
    ?obs :municipality <${MUNICIPALITY_NS}${municipality}> ;
      :period "${year}"^^<http://www.w3.org/2001/XMLSchema#gYear> ;
      :operator ?operator ; :category ?category ; :product ?product ; :total ?total .
    OPTIONAL { ?obs :energy ?energy }
    OPTIONAL { ?obs :gridusage ?gridusage }
    OPTIONAL { ?obs :charge ?charge }
    OPTIONAL { ?obs :aidfee ?aidfee }
    OPTIONAL { ?obs :meteringrate ?meteringrate }
    OPTIONAL { ?obs :energyname ?energyname }
    OPTIONAL { ?operator schema:name ?operatorName }
    OPTIONAL { <${ELCOM_CUBE}> schema:dateModified ?modified }
  }
} LIMIT ${MAX_ROWS}`;
}

/** The date ElCom last changed its data (`schema:dateModified` of the cube). */
export function cubeQuery() {
  return `${PREFIXES}
SELECT ?modified WHERE { GRAPH <${ELCOM_GRAPH}> { <${ELCOM_CUBE}> schema:dateModified ?modified } } LIMIT 5`;
}

/** A search text: 4 digits (a postal code) or 2-60 letters, digits, spaces and - ' . ( ) /. */
export function searchText(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (/^\d{4}$/.test(text)) return { postalCode: text };
  if (text.length < 2 || text.length > 60) return null;
  if (!/^[\p{L}\p{M}0-9 .'’()/-]+$/u.test(text)) return null;
  return { name: text.toLowerCase() };
}

/** The municipalities matching a search, with the operators of `year` (none when it has no tariff then). */
export function searchQuery(search, year, limit) {
  if (!isInt(year, 1900, 9999) || !isInt(limit, 1, 50)) {
    throw new TypeError('searchQuery: year and limit must be integers');
  }
  let match;
  if (search?.postalCode && /^\d{4}$/.test(search.postalCode)) {
    match = `GRAPH <${ELCOM_GRAPH}> { [] schema:areaServed ?m ; schema:postalCode "${search.postalCode}" }
      ?m a <https://schema.ld.admin.ch/Municipality> ; schema:name ?name .`;
  } else if (typeof search?.name === 'string' && searchText(search.name)?.name === search.name) {
    match = `?m a <https://schema.ld.admin.ch/Municipality> ; schema:name ?name .
      FILTER(CONTAINS(LCASE(STR(?name)), "${search.name}"))`;
  } else {
    throw new TypeError('searchQuery: invalid search');
  }
  return `${PREFIXES}
SELECT ?m ?name ?operator ?operatorName WHERE {
  { SELECT DISTINCT ?m ?name WHERE { ${match} } ORDER BY ?name LIMIT ${limit} }
  OPTIONAL {
    GRAPH <${ELCOM_GRAPH}> {
      ?obs :municipality ?m ; :period "${year}"^^<http://www.w3.org/2001/XMLSchema#gYear> ;
        :operator ?operator ; :category <${ELCOM_NS}category/H4> ; :product <${ELCOM_NS}product/standard> .
      OPTIONAL { ?operator schema:name ?operatorName }
    }
  }
} LIMIT ${limit * 20}`;
}

/**
 * Seconds to wait from a Retry-After header: a number of seconds, or a date
 * compared to the Date header of the same answer (never to the local clock).
 * Null when unreadable. Taken from gladys-national-rail.
 */
export function retryAfterSeconds(header, dateHeader) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const text = header.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text);
  const at = Date.parse(text);
  const now = Date.parse(dateHeader ?? '');
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** The body as text, cut (and refused) past `max` bytes, before reading it all. */
async function boundedText(response, max) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new LindasError('too_large', { status: response.status });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new LindasError('too_large', { status: response.status });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const realTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/**
 * Send one SPARQL SELECT; resolves the bindings (`[{ var: { type, value } }]`).
 * The whole exchange, body included, is aborted past `timeoutMs` (on the
 * timers given: the tests drive them).
 * @param {string} query
 * @param {{ version: string, fetchImpl?: typeof fetch, timeoutMs?: number, url?: string, timers?: object }} options
 */
export async function select(
  query,
  {
    version,
    fetchImpl = fetch,
    timeoutMs = REQUEST_TIMEOUT,
    url = LINDAS_URL,
    timers = realTimers,
    signal,
  },
) {
  const controller = new AbortController();
  let timedOut = false;
  const id = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // The app stopping aborts the request in flight too.
  const stop = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', stop);
  try {
    return await exchange(query, {
      version,
      fetchImpl,
      url,
      signal: controller.signal,
      timedOut: () => timedOut,
    });
  } finally {
    timers.clearTimeout(id);
    signal?.removeEventListener('abort', stop);
  }
}

async function exchange(query, { version, fetchImpl, url, signal, timedOut }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/sparql-results+json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': `${USER_AGENT_BASE}/${version} (+${REPO_URL})`,
      },
      body: new URLSearchParams({ query }).toString(),
      redirect: 'error',
      signal,
    });
  } catch {
    throw new LindasError(timedOut() ? 'timeout' : 'network');
  }
  const { status } = response;
  let text;
  try {
    text = await boundedText(response, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof LindasError) throw err;
    throw new LindasError(timedOut() ? 'timeout' : 'network', { status });
  }
  if (status === 429) {
    throw new LindasError('rate_limited', {
      status,
      retryAfter: retryAfterSeconds(
        response.headers.get('retry-after'),
        response.headers.get('date'),
      ),
    });
  }
  if (status === 503) {
    // A maintenance may say when to come back too.
    throw new LindasError('server', {
      status,
      retryAfter: retryAfterSeconds(
        response.headers.get('retry-after'),
        response.headers.get('date'),
      ),
    });
  }
  if (status >= 500) throw new LindasError('server', { status });
  if (status !== 200) throw new LindasError('unreadable', { status });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LindasError('unreadable', { status });
  }
  const bindings = json?.results?.bindings;
  if (!Array.isArray(bindings) || !Array.isArray(json?.head?.vars)) {
    throw new LindasError('unreadable', { status });
  }
  return bindings.slice(0, MAX_ROWS);
}
