// -----------------------------------------------------------------------------
// The integration: a `provider` declaring one delegated energy contract
// template. The core sends the 30-minute intervals of a contract; the app
// prices them at the ElCom tariff of the contract's municipality for the
// Zurich calendar year of each interval. index.js only wires the SDK.
//
// The tariffs come from LINDAS (src/lindas.js), one request per municipality
// and year, kept in /data for good: ElCom publishes them once a year. The
// rules that keep the requests rarer than the source changes:
//   - a (municipality, year) already fetched is never asked again;
//   - one with no tariff is asked again a week later at the soonest;
//   - the next year is never asked before 1 September (Zurich);
//   - one request at a time, two seconds apart at least;
//   - any failure (network, timeout, 429, 5xx, unreadable answer) pauses every
//     request from 1 min, doubled up to 6 h (Retry-After honoured), kept in
//     /data.
// These rules hold for every path: the delegated pricing, the current price,
// the daily refresh, the two buttons and a restart.
//
// Two clocks: `now` (wall clock) dates what /data keeps and gives the year of
// the tariffs; `monotonic` paces the requests and ends the pauses, so a wall
// clock set back or forward never hurries them.
// -----------------------------------------------------------------------------

import {
  ACTION_BUDGET,
  BUTTON_REREAD,
  CUBE_CHECK,
  PROBLEM_REREAD,
  REREAD_MIN,
  CATEGORIES,
  CONTRACTS_RETRY_MAX,
  CONTRACTS_RETRY_MIN,
  CURRENT_BUDGET,
  ELCOM_NS,
  FIRST_YEAR,
  MAX_ENTRIES,
  MAX_MISSES,
  MAX_SEARCH_RESULTS,
  MISS_RETRY,
  MUNICIPALITY_NS,
  NEXT_YEAR_FROM_MONTH,
  PAUSE_MAX,
  PAUSE_MIN,
  PRICE_BUDGET,
  PRODUCTS,
  REFRESH_INTERVAL,
  REQUEST_GAP,
  SEARCH_CACHE,
  STORE_LOAD_TIMEOUT,
  STORE_RETRY,
  TEMPLATE_KEY,
} from './constants.js';
import { TEXTS, join, priceText, problemText, reasonText } from './i18n.js';
import { cubeQuery, searchQuery, searchText, select, tariffQuery } from './lindas.js';
import { createFileStore } from './store.js';
import {
  InputError,
  MAX_RAPPEN,
  cleanText,
  intervalCosts,
  parseInputs,
  parseTariffRows,
  pickRow,
  tariffLabel,
  unitPrice,
  yearStart,
  yearsOf,
  zurichDate,
  zurichYear,
} from './tariffs.js';

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const keyOf = (municipality, year) => `${municipality}:${year}`;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** A request not sent (paused, stopped): `code` and, for a pause, `until` (wall clock). */
export class Unavailable extends Error {
  constructor(code, until) {
    super(code);
    this.name = 'Unavailable';
    this.code = code;
    this.until = until;
  }
}

// --- What /data keeps, checked when read back --------------------------------------

const isPart = (n) => n === null || (finite(n) && Math.abs(n) <= 1000);
const isName = (s, max) => s === null || (typeof s === 'string' && s.length <= max);

function validRow(r) {
  return (
    r &&
    Number.isInteger(r.operator) &&
    r.operator > 0 &&
    CATEGORIES.includes(r.category) &&
    PRODUCTS.includes(r.product) &&
    finite(r.total) &&
    r.total > 0 &&
    r.total <= MAX_RAPPEN &&
    ['energy', 'grid', 'charges', 'aid_fee', 'metering'].every((k) => isPart(r[k])) &&
    isName(r.name, 48)
  );
}

/** An entry read back from /data, or null. */
export function validEntry(raw, at) {
  if (!raw || typeof raw !== 'object') return null;
  const { municipality, year, modified, operators, rows, fetchedAt } = raw;
  if (!Number.isInteger(municipality) || municipality < 1 || municipality > 9999) return null;
  if (!Number.isInteger(year) || year < FIRST_YEAR || year > 9999) return null;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2000 || !rows.every(validRow)) {
    return null;
  }
  if (
    !Array.isArray(operators) ||
    operators.length === 0 ||
    operators.length > 200 ||
    !operators.every((o) => o && Number.isInteger(o.id) && o.id > 0 && isName(o.name, 80))
  ) {
    return null;
  }
  if (!rows.every((r) => operators.some((o) => o.id === r.operator))) return null;
  if (
    modified !== null &&
    !(typeof modified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(modified))
  ) {
    return null;
  }
  // A date in the future (a clock set back) is brought to now.
  const fetched = finite(fetchedAt) ? Math.min(fetchedAt, at) : at;
  return {
    municipality,
    year,
    modified,
    operators: operators.map((o) => ({ id: o.id, name: o.name })),
    rows: rows.map((r) => ({ ...r })),
    fetchedAt: fetched,
    usedAt: fetched,
  };
}

export class ElcomApp {
  constructor({
    gladys,
    version = '0.0.0',
    logger = quiet,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    fetchImpl = fetch,
    requestTimeout,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    /** Aborted by stop(): the request in flight ends with it. */
    this.abort = new AbortController();
    this.selectImpl = (query) =>
      select(query, {
        version,
        fetchImpl,
        timeoutMs: requestTimeout,
        timers: this.timers,
        signal: this.abort.signal,
      });

    /** By `municipality:year`: the tariffs fetched. */
    this.entries = new Map();
    /**
     * By `municipality:year`: no tariff then (`kind` 'missing') or an answer
     * none of whose rows could be read ('unreadable'): `{ at (wall), due (monotonic), kind }`.
     */
    this.misses = new Map();
    /** The pause of every request: `{ until (wall), due (monotonic), code }`. */
    this.pause = null;
    /** The date ElCom last changed its data: `{ modified, at (wall), due (monotonic) }`. */
    this.cube = { modified: null, at: undefined, due: undefined };
    this.pauseTimer = undefined;
    /** Failures in a row (the pause doubles); 0 after a success. */
    this.failures = 0;
    /** Monotonic time of the last request sent. */
    this.lastRequestAt = undefined;
    /** One LINDAS request at a time. */
    this.queue = Promise.resolve();
    /** By `municipality:year`: the fetch running. */
    this.inflight = new Map();
    /** The searches of the button: by text, `{ at (monotonic), result }`. */
    this.searches = new Map();

    /** /data: 'pending' (never read), 'ok', 'broken' (unreadable: never written). */
    this.storeState = 'pending';
    this.loading = undefined;
    this.storeTimer = undefined;
    /** A read of /data running: never two at once. */
    this.storeReading = false;

    /** The contracts of the template, by id: `{ id, inputs }`. */
    this.contracts = new Map();
    this.contractsUnread = false;
    this.contractsFailures = 0;

    this.closed = false;
    /** Connected and started: the status may be published. */
    this.started = false;
    this.generation = 0;
    this.refreshTimer = undefined;
    this.lastStatus = undefined;
    /** The sleeps between two requests, woken by stop(). */
    this.sleepers = new Set();
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** Connected to Gladys: read the contracts and fetch what they need, then once a day. */
  start() {
    this.closed = false;
    this.started = true;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.generation += 1;
    this.lastStatus = undefined;
    this.clearRefresh();
    this.loadStore();
    const generation = this.generation;
    return this.refresh(generation);
  }

  /** Disconnected: the daily refresh stops until the next connection. */
  disconnected() {
    this.started = false;
    this.generation += 1;
    this.clearRefresh();
  }

  /** Shutdown: no timer nor request after this; /data written. */
  async stop() {
    this.closed = true;
    this.started = false;
    this.generation += 1;
    this.clearRefresh();
    this.abort.abort();
    if (this.pauseTimer !== undefined) {
      this.timers.clearTimeout(this.pauseTimer);
      this.pauseTimer = undefined;
    }
    if (this.storeTimer !== undefined) {
      this.timers.clearTimeout(this.storeTimer);
      this.storeTimer = undefined;
    }
    for (const wake of this.sleepers) wake();
    this.sleepers.clear();
    await this.persist();
  }

  clearRefresh() {
    if (this.refreshTimer !== undefined) {
      this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  scheduleRefresh(generation, ms) {
    if (generation !== this.generation || this.closed) return;
    this.clearRefresh();
    this.refreshTimer = this.timers.setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh(generation).catch((err) => this.logger.error('Refresh failed', err));
    }, ms);
  }

  // --- /data -------------------------------------------------------------------------

  /** Read /data once (bounded); unreadable: read again on its own timer, never written over. */
  loadStore() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let timer;
      const late = new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve('late'), STORE_LOAD_TIMEOUT);
      });
      this.storeReading = true;
      const read = this.store
        .load()
        .then(
          (data) => ({ data }),
          (err) => ({ err }),
        )
        .finally(() => {
          this.storeReading = false;
        });
      const result = await Promise.race([read, late]);
      this.timers.clearTimeout(timer);
      if (result === 'late' || result.err) {
        this.storeState = 'broken';
        this.logger.warn(
          `/data unreadable (${result === 'late' ? 'too slow' : result.err.message}): kept in memory, read again later`,
        );
        // A late read still lands: it is merged when it does.
        if (result === 'late') {
          read.then((late2) => {
            if (late2.data && this.storeState === 'broken') this.restore(late2.data);
          });
        }
        this.retryStore();
        return;
      }
      this.restore(result.data);
    })();
    return this.loading;
  }

  retryStore() {
    if (this.closed || this.storeTimer !== undefined) return;
    this.storeTimer = this.timers.setTimeout(async () => {
      if (this.storeReading) {
        // The read before is still running: one at a time.
        this.storeTimer = undefined;
        this.retryStore();
        return;
      }
      let data;
      this.storeReading = true;
      try {
        data = await this.store.load();
      } catch (err) {
        this.logger.debug(`/data still unreadable: ${err.message}`);
      } finally {
        this.storeReading = false;
      }
      this.storeTimer = undefined;
      if (this.closed) return;
      if (data && this.storeState === 'broken') {
        this.restore(data);
      } else if (this.storeState === 'broken') {
        this.retryStore();
      }
    }, STORE_RETRY);
  }

  /** Merge what /data keeps with what is in memory, then write the union. */
  restore(data) {
    const at = this.now();
    const mono = this.monotonic();
    for (const raw of Array.isArray(data.entries) ? data.entries.slice(0, MAX_ENTRIES) : []) {
      const entry = validEntry(raw, at);
      if (entry && !this.entries.has(keyOf(entry.municipality, entry.year))) {
        entry.readAt = mono - Math.min(at - entry.fetchedAt, 400 * MISS_RETRY);
        this.entries.set(keyOf(entry.municipality, entry.year), entry);
      }
    }
    const misses = data.misses && typeof data.misses === 'object' ? data.misses : {};
    for (const [key, value] of Object.entries(misses).slice(0, MAX_MISSES)) {
      const when = finite(value) ? value : value?.at;
      const kind = value?.kind === 'unreadable' ? 'unreadable' : 'missing';
      if (!/^\d{1,4}:\d{4}$/.test(key) || !finite(when)) continue;
      const asked = Math.min(when, at);
      const rest = Math.min(MISS_RETRY, asked + MISS_RETRY - at);
      if (rest <= 0) continue;
      const known = this.misses.get(key);
      if (!known || known.at < asked) this.misses.set(key, { at: asked, due: mono + rest, kind });
    }
    const cube = data.cube;
    if (
      cube &&
      typeof cube.modified === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(cube.modified) &&
      finite(cube.at) &&
      !(this.cube.modified && this.cube.modified > cube.modified)
    ) {
      const asked = Math.min(cube.at, at);
      this.cube = {
        modified: cube.modified,
        at: asked,
        due: mono + Math.max(0, Math.min(CUBE_CHECK, asked + CUBE_CHECK - at)),
      };
    }
    const pause = data.pause;
    if (pause && finite(pause.until)) {
      const rest = Math.min(PAUSE_MAX, pause.until - at);
      if (rest > 0 && (!this.pause || this.pause.due < mono + rest)) {
        this.pause = {
          until: at + rest,
          due: mono + rest,
          code: cleanText({ value: pause.code }, 24),
        };
      }
    }
    if (Number.isInteger(data.failures) && data.failures > this.failures) {
      this.failures = Math.min(data.failures, 20);
    }
    const wasBroken = this.storeState === 'broken';
    this.storeState = 'ok';
    this.trim();
    this.persist();
    // /data readable again: the status says so, and what the refresh skipped is done now.
    if (wasBroken && this.started && !this.closed) {
      this.refresh(this.generation).catch((err) => this.logger.error('Refresh failed', err));
    }
  }

  /** Bounds the memory (and /data): the least recently used tariffs and the oldest misses go. */
  trim() {
    if (this.entries.size > MAX_ENTRIES) {
      const order = [...this.entries].sort((a, b) => a[1].usedAt - b[1].usedAt);
      for (const [key] of order.slice(0, this.entries.size - MAX_ENTRIES)) this.entries.delete(key);
    }
    if (this.misses.size > MAX_MISSES) {
      const order = [...this.misses].sort((a, b) => a[1].at - b[1].at);
      for (const [key] of order.slice(0, this.misses.size - MAX_MISSES)) this.misses.delete(key);
    }
  }

  /** Write /data (only once read: an unreadable file is never written over). */
  persist() {
    if (this.storeState !== 'ok') return Promise.resolve();
    const mono = this.monotonic();
    const data = {
      version: 1,
      entries: [...this.entries.values()].map((e) => ({
        municipality: e.municipality,
        year: e.year,
        modified: e.modified,
        operators: e.operators,
        rows: e.rows,
        fetchedAt: e.fetchedAt,
      })),
      misses: Object.fromEntries(
        [...this.misses].map(([key, m]) => [key, { at: m.at, kind: m.kind }]),
      ),
      cube: this.cube.modified ? { modified: this.cube.modified, at: this.cube.at } : null,
      pause:
        this.pause && this.pause.due > mono
          ? { until: this.pause.until, code: this.pause.code }
          : null,
      failures: this.failures,
    };
    return this.store
      .save(data)
      .catch((err) => this.logger.warn(`/data not written: ${err.message}`));
  }

  // --- Requests to LINDAS -------------------------------------------------------------

  pausedAt(mono) {
    return this.pause && this.pause.due > mono ? this.pause : null;
  }

  /** A failure: every request paused, from 1 min doubled up to 6 h, or the Retry-After. */
  startPause(err) {
    this.failures = Math.min(this.failures + 1, 20);
    let ms = Math.min(PAUSE_MAX, PAUSE_MIN * 2 ** (this.failures - 1));
    if (finite(err?.retryAfter)) {
      ms = Math.min(PAUSE_MAX, Math.max(ms, err.retryAfter * 1000));
    }
    const mono = this.monotonic();
    this.pause = {
      until: this.now() + ms,
      due: mono + ms,
      code: String(err?.code ?? 'error').slice(0, 24),
    };
    this.logger.warn(
      `LINDAS: ${err?.message ?? err}; requests paused for ${Math.round(ms / 1000)} s`,
    );
    // The status follows the pause: said when it starts, cleared when it ends.
    if (this.pauseTimer !== undefined) this.timers.clearTimeout(this.pauseTimer);
    this.pauseTimer = this.timers.setTimeout(() => {
      this.pauseTimer = undefined;
      this.publishStatus().catch(() => {});
    }, ms + 1);
    this.publishStatus().catch(() => {});
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const wake = () => {
        this.timers.clearTimeout(id);
        this.sleepers.delete(wake);
        resolve();
      };
      const id = this.timers.setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  /** One SPARQL request, after the ones before it, never during a pause nor after stop(). */
  request(query) {
    const job = this.queue.then(() => this.send(query));
    this.queue = job.catch(() => {});
    return job;
  }

  async send(query) {
    for (;;) {
      if (this.closed) throw new Unavailable('stopped');
      const mono = this.monotonic();
      const paused = this.pausedAt(mono);
      if (paused) throw new Unavailable('paused', paused.until);
      const wait = this.lastRequestAt === undefined ? 0 : this.lastRequestAt + REQUEST_GAP - mono;
      if (wait <= 0) {
        this.lastRequestAt = mono;
        break;
      }
      await this.sleep(wait);
    }
    try {
      const bindings = await this.selectImpl(query);
      this.failures = 0;
      this.pause = null;
      return bindings;
    } catch (err) {
      // Stopped: the request was aborted on purpose, not a failure of LINDAS.
      if (this.closed) throw new Unavailable('stopped');
      this.startPause(err);
      this.persist();
      throw new Unavailable('paused', this.pause.until);
    }
  }

  /** Why the tariffs of `municipality` for `year` may not be asked now, or null. */
  blocked(municipality, year, mono = this.monotonic()) {
    const today = zurichDate(this.now());
    if (year < FIRST_YEAR || year > today.year + 1) return { code: 'out_of_range' };
    if (year === today.year + 1 && today.month < NEXT_YEAR_FROM_MONTH) return { code: 'not_yet' };
    const miss = this.misses.get(keyOf(municipality, year));
    if (miss && miss.due > mono) return { code: miss.kind, until: this.now() + (miss.due - mono) };
    const paused = this.pausedAt(mono);
    if (paused) return { code: 'paused', until: paused.until };
    return null;
  }

  /** Resolves `value`, or `fallback` past `ms` (the work goes on). */
  within(promise, ms, fallback) {
    if (ms === Infinity) return promise;
    return new Promise((resolve, reject) => {
      const id = this.timers.setTimeout(() => resolve(fallback), Math.max(0, ms));
      promise.then(
        (v) => {
          this.timers.clearTimeout(id);
          resolve(v);
        },
        (e) => {
          this.timers.clearTimeout(id);
          reject(e);
        },
      );
    });
  }

  /**
   * The tariffs of a municipality and year: `{ entry }` from memory, else
   * fetched when the rules allow it within `budget` ms, else `{ reason }`.
   */
  async ensure(municipality, year, budget = Infinity) {
    const key = keyOf(municipality, year);
    const started = this.monotonic();
    if (!this.entries.has(key) && this.storeState === 'pending') {
      await this.within(this.loadStore(), budget, undefined);
    }
    const hit = this.entries.get(key);
    if (hit) {
      hit.usedAt = this.now();
      return { entry: hit };
    }
    // /data not read yet: what it keeps (a tariff, a miss, a pause) is unknown,
    // so nothing is asked before it is (or before it is known unreadable).
    if (this.storeState === 'pending') return { reason: { code: 'timeout' } };
    const why = this.blocked(municipality, year);
    if (why) return { reason: why };
    let job = this.inflight.get(key);
    if (!job) {
      job = this.fetchTariffs(municipality, year).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    const left = budget === Infinity ? Infinity : budget - (this.monotonic() - started);
    return this.within(job, left, { reason: { code: 'timeout' } });
  }

  /** Fetch the tariffs of a municipality and year, then republish the status (what it says changed). */
  async fetchTariffs(municipality, year) {
    const result = await this.readTariffs(municipality, year);
    this.publishStatus().catch(() => {});
    return result;
  }

  async readTariffs(municipality, year) {
    const key = keyOf(municipality, year);
    let bindings;
    try {
      bindings = await this.request(tariffQuery(municipality, year));
    } catch (err) {
      if (err instanceof Unavailable) return { reason: { code: err.code, until: err.until } };
      throw err;
    }
    const entry = parseTariffRows(bindings, municipality, year);
    const at = this.now();
    const mono = this.monotonic();
    const known = this.entries.get(key);
    if (entry.rows.length === 0) {
      // Rows, none readable (the format changed): never "no tariff", and only
      // this municipality and year wait, not the others.
      const kind = entry.bad > 0 && entry.empty === 0 ? 'unreadable' : 'missing';
      if (known) {
        // Read again and found nothing usable: what was read before is kept.
        known.fetchedAt = at;
        known.readAt = mono;
        this.persist();
        this.logger.warn(
          `ElCom tariffs ${year} of municipality ${municipality}: read again, ${kind}: kept`,
        );
        return { entry: known };
      }
      this.misses.set(key, { at, due: mono + MISS_RETRY, kind });
      this.trim();
      this.persist();
      this.logger.info(`No ElCom tariff for municipality ${municipality} in ${year} (${kind})`);
      return { reason: { code: kind, until: at + MISS_RETRY } };
    }
    const fresh = {
      municipality,
      year,
      modified: entry.modified,
      operators: entry.operators,
      rows: entry.rows,
      fetchedAt: at,
      usedAt: known?.usedAt ?? at,
      readAt: mono,
    };
    const changed = known && JSON.stringify(known.rows) !== JSON.stringify(fresh.rows);
    this.entries.set(key, fresh);
    this.misses.delete(key);
    this.trim();
    this.persist();
    this.logger.info(
      `ElCom tariffs ${year} of municipality ${municipality}: ${fresh.rows.length} rows, data of ${fresh.modified ?? '?'}${known ? (changed ? ', changed' : ', unchanged') : ''}`,
    );
    return { entry: fresh };
  }

  /**
   * Read a tariff already kept again, when it was read at least `minAge` ms
   * ago (and never sooner than the pause, nor out of the years allowed).
   */
  async reread(municipality, year, minAge, budget = Infinity) {
    const key = keyOf(municipality, year);
    const entry = this.entries.get(key);
    if (!entry || this.storeState !== 'ok') return;
    const mono = this.monotonic();
    if (mono - entry.readAt < minAge) return;
    const today = zurichDate(this.now());
    if (year < today.year - 1 || this.blocked(municipality, year, mono)) return;
    let job = this.inflight.get(key);
    if (!job) {
      job = this.fetchTariffs(municipality, year).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    await this.within(job, budget, undefined);
  }

  /** The date ElCom last changed its data, asked once a day at most. */
  async checkCube() {
    const mono = this.monotonic();
    if (this.storeState !== 'ok' || (this.cube.due !== undefined && this.cube.due > mono)) return;
    if (this.pausedAt(mono)) return;
    let bindings;
    try {
      bindings = await this.request(cubeQuery());
    } catch (err) {
      if (err instanceof Unavailable) return;
      throw err;
    }
    const dates = bindings
      .map((b) => cleanText(b?.modified, 32))
      .filter((d) => d && /^\d{4}-\d{2}-\d{2}/.test(d))
      .map((d) => d.slice(0, 10))
      .sort();
    this.cube = {
      modified: dates.at(-1) ?? this.cube.modified,
      at: this.now(),
      due: this.monotonic() + CUBE_CHECK,
    };
    this.persist();
  }

  /** A tariff of this year or the next read before ElCom last changed its data. */
  outdated(entry) {
    const today = zurichDate(this.now());
    return (
      entry.year >= today.year &&
      Boolean(this.cube.modified) &&
      (entry.modified === null || this.cube.modified > entry.modified)
    );
  }

  /** The years a contract needs now: this one, and the next from September. */
  yearsNow() {
    const today = zurichDate(this.now());
    return today.month >= NEXT_YEAR_FROM_MONTH ? [today.year, today.year + 1] : [today.year];
  }

  // --- Contracts ---------------------------------------------------------------------------

  /** Read the contracts of the template, then fetch what they need for this year (and the next one from September). */
  async refresh(generation) {
    if (generation !== this.generation || this.closed) return;
    let list;
    try {
      list = await this.gladys.getEnergyContracts();
      if (!Array.isArray(list)) throw new Error('not a list');
    } catch (err) {
      if (generation !== this.generation) return;
      this.contractsUnread = true;
      this.contractsFailures += 1;
      const ms = Math.min(
        CONTRACTS_RETRY_MAX,
        CONTRACTS_RETRY_MIN * 2 ** (this.contractsFailures - 1),
      );
      this.logger.warn(
        `Energy contracts not read (${err?.message ?? err}); again in ${Math.round(ms / 1000)} s`,
      );
      await this.publishStatus();
      this.scheduleRefresh(generation, ms);
      return;
    }
    if (generation !== this.generation) return;
    this.contractsUnread = false;
    this.contractsFailures = 0;
    this.contracts = new Map(
      list
        .filter((c) => c && c.template_key === TEMPLATE_KEY && c.status !== 'orphaned')
        .slice(0, 50)
        .map((c) => [String(c.id), { id: String(c.id).slice(0, 40), inputs: c.inputs }]),
    );
    // /data not read (or unreadable): what it keeps is unknown, so nothing is
    // read here; only the pricing the core asks for may read LINDAS.
    await this.loadStore();
    if (generation !== this.generation || this.closed) return;
    if (this.storeState === 'ok' && this.contracts.size > 0) {
      try {
        await this.checkCube();
      } catch (err) {
        this.logger.warn(`ElCom data date not read: ${err?.message ?? err}`);
      }
      // By key: whether one of its contracts finds no tariff in it (a partial
      // publication: read again once a week), whatever the other contracts find.
      const keys = new Map();
      for (const contract of this.contracts.values()) {
        let inputs;
        try {
          inputs = parseInputs(contract.inputs);
        } catch {
          continue;
        }
        for (const year of this.yearsNow()) {
          if (generation !== this.generation || this.closed) return;
          const key = keyOf(inputs.municipality, year);
          try {
            const { entry } = await this.ensure(inputs.municipality, year);
            if (!entry) continue;
            const known = keys.get(key) ?? {
              municipality: inputs.municipality,
              year,
              problem: false,
            };
            known.problem ||= Boolean(pickRow(entry, inputs).problem);
            keys.set(key, known);
          } catch (err) {
            // One municipality never stops the others nor the daily refresh.
            this.logger.warn(
              `Tariffs ${year} of municipality ${inputs.municipality} not read: ${err?.message ?? err}`,
            );
          }
        }
      }
      for (const { municipality, year, problem } of keys.values()) {
        if (generation !== this.generation || this.closed) return;
        const entry = this.entries.get(keyOf(municipality, year));
        if (!entry) continue;
        try {
          // Read again when ElCom changed its data, or (once a week) when a
          // contract finds no tariff in it: a partial publication completed later.
          if (this.outdated(entry)) await this.reread(municipality, year, REREAD_MIN);
          else if (problem) await this.reread(municipality, year, PROBLEM_REREAD);
        } catch (err) {
          this.logger.warn(
            `Tariffs ${year} of municipality ${municipality} not read again: ${err?.message ?? err}`,
          );
        }
      }
    }
    if (generation !== this.generation) return;
    await this.publishStatus();
    this.scheduleRefresh(generation, REFRESH_INTERVAL);
  }

  /** What a contract gives this year: `{ en, fr }`. */
  describe(contract, year) {
    let inputs;
    try {
      inputs = parseInputs(contract.inputs);
    } catch (err) {
      return err.texts ?? { en: err.message, fr: err.message };
    }
    const key = keyOf(inputs.municipality, year);
    const entry = this.entries.get(key);
    if (!entry) {
      const reason =
        this.blocked(inputs.municipality, year) ??
        (this.inflight.has(key) ? { code: 'timeout' } : { code: 'unread' });
      return reasonText(reason, { municipality: inputs.municipality, year });
    }
    const pick = pickRow(entry, inputs);
    if (pick.problem) return problemText(pick, inputs, year);
    const price = unitPrice(pick.row, year, inputs.vat);
    return priceText({ inputs, year, operator: pick.operator, price, modified: entry.modified });
  }

  /** This year, and from September the next one: `{ en, fr }`. */
  describeNow(contract) {
    return join(
      this.yearsNow().map((year) => this.describe(contract, year)),
      ' | ',
    );
  }

  async publishStatus() {
    if (this.closed || !this.started) return;
    const year = zurichYear(this.now());
    const mono = this.monotonic();
    const paused = this.pausedAt(mono);
    const parts = [];
    if (paused) parts.push(reasonText({ code: 'paused', until: paused.until }, { year }));
    if (this.storeState === 'broken') parts.push(TEXTS.storeBroken);
    if (this.contractsUnread) parts.push(TEXTS.contractsUnread);
    const contracts = [...this.contracts.values()];
    if (contracts.length === 0 && !this.contractsUnread) parts.push(TEXTS.noContract);
    for (const [i, contract] of contracts.slice(0, 3).entries()) {
      parts.push(join([TEXTS.contract(i + 1), this.describeNow(contract)], ''));
    }
    if (contracts.length > 3) parts.push(TEXTS.more(contracts.length - 3));
    const message = join(parts, ' · ');
    const connected = !paused;
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.lastStatus = undefined;
      this.logger.warn(`Status not sent: ${err?.message ?? err}`);
    }
  }

  remember(contract) {
    const id = contract?.id;
    if (id === undefined || id === null) return;
    if (this.contracts.size >= 50 && !this.contracts.has(String(id))) return;
    this.contracts.set(String(id), { id: String(id).slice(0, 40), inputs: contract.inputs });
  }

  // --- Delegated pricing -------------------------------------------------------------------

  /** The price of a contract for a year: `{ perKwh, parts, label, row, operator, entry }`; throws why not. */
  async priceOf(inputs, year, budget) {
    if (year < FIRST_YEAR) {
      throw new Error(reasonText({ code: 'out_of_range' }, { year }).en);
    }
    const result = await this.ensure(inputs.municipality, year, budget);
    if (!result.entry) {
      throw new Error(reasonText(result.reason, { municipality: inputs.municipality, year }).en);
    }
    const pick = pickRow(result.entry, inputs);
    if (pick.problem) throw new Error(problemText(pick, inputs, year).en);
    return { ...unitPrice(pick.row, year, inputs.vat), label: tariffLabel(pick.row, year) };
  }

  /** `onEnergyPrice`: one cost per interval, or a throw (the core retries; never a silent zero). */
  async energyPrice({ contract, intervals } = {}) {
    if (contract?.template_key !== undefined && contract.template_key !== TEMPLATE_KEY) {
      throw new Error(`Unknown template ${String(contract.template_key).slice(0, 64)}`);
    }
    if (!Array.isArray(intervals)) throw new Error('No intervals');
    const inputs = parseInputs(contract?.inputs);
    this.remember(contract);
    if (intervals.length === 0) return [];
    const started = this.monotonic();
    const prices = new Map();
    for (const year of yearsOf(intervals)) {
      const left = PRICE_BUDGET - (this.monotonic() - started);
      prices.set(year, await this.priceOf(inputs, year, left));
    }
    return intervalCosts(intervals, prices);
  }

  /** `onEnergyCurrent`: the price now and on 1 January (null when unknown). */
  async energyCurrent({ contract } = {}) {
    let inputs;
    try {
      inputs = parseInputs(contract?.inputs);
    } catch (err) {
      if (err instanceof InputError) {
        return { price: null, valid_until: null, next_price: null };
      }
      throw err;
    }
    this.remember(contract);
    const year = zurichYear(this.now());
    const validUntil = new Date(yearStart(year + 1)).toISOString();
    let current;
    try {
      current = await this.priceOf(inputs, year, CURRENT_BUDGET);
    } catch {
      return { price: null, valid_until: validUntil, next_price: null };
    }
    // The next year only from memory: the current price never waits for it.
    let next = null;
    const entry = this.entries.get(keyOf(inputs.municipality, year + 1));
    if (entry) {
      const pick = pickRow(entry, inputs);
      if (!pick.problem)
        next = {
          ...unitPrice(pick.row, year + 1, inputs.vat),
          label: tariffLabel(pick.row, year + 1),
        };
    }
    return {
      price: current.perKwh,
      valid_until: validUntil,
      next_price: next ? next.perKwh : null,
      label: current.label,
      ...(next ? { next_label: next.label } : {}),
    };
  }

  // --- Buttons -----------------------------------------------------------------------------

  /** "Check my contracts": reads them, fetches this year's tariffs if the rules allow it. */
  async checkContracts() {
    let list;
    try {
      list = await this.gladys.getEnergyContracts();
      if (!Array.isArray(list)) throw new Error('not a list');
    } catch {
      return TEXTS.contractsUnread;
    }
    const contracts = list.filter(
      (c) => c && c.template_key === TEMPLATE_KEY && c.status !== 'orphaned',
    );
    this.contracts = new Map(
      contracts.slice(0, 50).map((c) => [String(c.id), { id: String(c.id), inputs: c.inputs }]),
    );
    this.contractsUnread = false;
    if (contracts.length === 0) return TEXTS.noContract;
    const started = this.monotonic();
    const left = () => ACTION_BUDGET - (this.monotonic() - started);
    const parts = [];
    if (this.storeState === 'pending') await this.within(this.loadStore(), left(), undefined);
    if (this.storeState !== 'ok') parts.push(TEXTS.storeBroken);
    for (const [i, contract] of contracts.slice(0, 10).entries()) {
      try {
        const inputs = parseInputs(contract.inputs);
        for (const year of this.yearsNow()) {
          if (this.storeState !== 'ok') break;
          // The recourse of the user: read again what was read (or found
          // missing) more than an hour ago, under the pause and the gap.
          const key = keyOf(inputs.municipality, year);
          const miss = this.misses.get(key);
          if (miss && this.monotonic() - (miss.due - MISS_RETRY) >= BUTTON_REREAD) {
            this.misses.delete(key);
          }
          const result = await this.ensure(inputs.municipality, year, left());
          if (result.entry) await this.reread(inputs.municipality, year, BUTTON_REREAD, left());
        }
      } catch {
        // Described below.
      }
      parts.push(join([TEXTS.contract(i + 1), this.describeNow(contract)], ''));
    }
    await this.publishStatus();
    return join(parts, '\n');
  }

  /** "Find my municipality": municipality numbers and grid operators matching a name or a postal code. */
  async findMunicipality(fields = {}) {
    const search = searchText(fields.query);
    if (!search) throw new Error(TEXTS.badSearch.en);
    const id = JSON.stringify(search);
    const mono = this.monotonic();
    const cached = this.searches.get(id);
    if (cached && mono - cached.at < SEARCH_CACHE) return cached.result;
    if (this.storeState === 'pending')
      await this.within(this.loadStore(), STORE_LOAD_TIMEOUT, undefined);
    if (this.storeState !== 'ok') throw new Error(TEXTS.storeBroken.en);
    const year = zurichYear(this.now());
    let bindings;
    try {
      bindings = await this.within(
        this.request(searchQuery(search, year, MAX_SEARCH_RESULTS)),
        ACTION_BUDGET,
        'late',
      );
    } catch (err) {
      if (err instanceof Unavailable) {
        throw new Error(reasonText({ code: err.code, until: err.until }, { year }).en, {
          cause: err,
        });
      }
      throw err;
    }
    if (bindings === 'late') throw new Error(TEXTS.searchLate.en);
    const found = new Map();
    for (const b of bindings) {
      const iri = b?.m?.type === 'uri' ? b.m.value : '';
      const match = iri.startsWith(MUNICIPALITY_NS)
        ? /^(\d{1,4})$/.exec(iri.slice(MUNICIPALITY_NS.length))
        : null;
      const name = cleanText(b?.name, 60);
      if (!match || !name) continue;
      const m = found.get(match[1]) ?? { id: Number(match[1]), name, operators: [] };
      const op = b?.operator?.type === 'uri' ? b.operator.value : '';
      const opId = op.startsWith(`${ELCOM_NS}operator/`)
        ? /^(\d{1,9})$/.exec(op.slice(`${ELCOM_NS}operator/`.length))
        : null;
      if (opId && !m.operators.some((o) => o.id === Number(opId[1]))) {
        m.operators.push({ id: Number(opId[1]), name: cleanText(b?.operatorName, 80) });
      }
      found.set(match[1], m);
    }
    const list = [...found.values()].slice(0, MAX_SEARCH_RESULTS);
    const result =
      list.length === 0
        ? TEXTS.noMatch
        : join(
            list.map((m) => TEXTS.match(m, year)),
            '\n',
          );
    this.searches.set(id, { at: this.monotonic(), result });
    if (this.searches.size > 50) this.searches.delete(this.searches.keys().next().value);
    return result;
  }
}
