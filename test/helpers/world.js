// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted LINDAS and a virtual clock
// that moves 1 µs at every read of the monotonic clock (a decision reading it
// twice sees it move).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ElcomApp } from '../../src/app.js';
import { ELCOM_CUBE, ELCOM_NS, MUNICIPALITY_NS } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { createFakeClock } from './fakeTimers.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** 2026-06-15 10:00 Zurich (summer time). */
export const JUNE = Date.parse('2026-06-15T08:00:00Z');
/** 2026-09-15 10:00 Zurich. */
export const SEPTEMBER = Date.parse('2026-09-15T08:00:00Z');
export const TEMPLATE = 'elcom-municipality';

const uri = (value) => ({ type: 'uri', value });
const dec = (value) =>
  value === undefined
    ? undefined
    : {
        type: 'literal',
        datatype: 'http://www.w3.org/2001/XMLSchema#decimal',
        value: String(value),
      };
const lit = (value) => (value === undefined ? undefined : { type: 'literal', value });

/** One SPARQL binding of a tariff row (the real shape of LINDAS). */
export function binding({
  operator = 519,
  operatorName = 'Energie Wasser Bern',
  category = 'H4',
  product = 'standard',
  total = 33.26,
  energy = 13.2,
  gridusage = 13.03,
  charge = 2.65,
  aidfee = 2.3,
  meteringrate = 2.08,
  energyname = 'ewb.Natur.STROM Einfachtarif',
  modified = '2026-11-10',
} = {}) {
  const b = {
    operator: uri(`${ELCOM_NS}operator/${operator}`),
    operatorName: lit(operatorName),
    category: uri(`${ELCOM_NS}category/${category}`),
    product: uri(`${ELCOM_NS}product/${product}`),
    total: dec(total),
    energy: dec(energy),
    gridusage: dec(gridusage),
    charge: dec(charge),
    aidfee: dec(aidfee),
    meteringrate: dec(meteringrate),
    energyname: lit(energyname),
    modified: modified === undefined ? undefined : { type: 'literal', value: modified },
  };
  return Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
}

/** The standard and cheapest rows of every category for one operator. */
export function operatorRows(options = {}) {
  const rows = [];
  for (const category of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'C1', 'C2', 'C3']) {
    rows.push(binding({ ...options, category, product: 'standard' }));
    rows.push(
      binding({
        ...options,
        category,
        product: 'cheapest',
        total: (options.total ?? 33.26) - 0.2,
        energy: (options.energy ?? 13.2) - 0.2,
      }),
    );
  }
  return rows;
}

export const results = (bindings) => ({
  head: { vars: ['operator', 'total'] },
  results: { bindings },
});

/** A municipality found by the search, with an operator. */
export const searchBinding = (id, name, operator, operatorName) => ({
  m: uri(`${MUNICIPALITY_NS}${id}`),
  name: lit(name),
  ...(operator
    ? { operator: uri(`${ELCOM_NS}operator/${operator}`), operatorName: lit(operatorName) }
    : {}),
});

export { ELCOM_CUBE };

/**
 * LINDAS: `tariffs` maps `municipality:year` to an array of bindings (absent:
 * no row). `world.answer(request)` may return a Response, 'hang' (a request
 * that never answers until its signal aborts) or undefined (the default).
 */
export function createLindas(tariffs = {}) {
  const lindas = {
    tariffs,
    requests: [],
    inFlight: 0,
    peak: 0,
    answer: undefined,
    search: [],
    /** The date of the cube (`schema:dateModified`), and the requests asking it. */
    cubeModified: '2026-11-10',
    cubes: [],
  };
  lindas.fetch = async (url, init) => {
    const query = new URLSearchParams(init.body).get('query');
    const tariff = /municipality\/(\d+)> ;\s*:period "(\d{4})"/.exec(query);
    const request = {
      url,
      init,
      query,
      key: tariff
        ? `${tariff[1]}:${tariff[2]}`
        : /SELECT \?modified WHERE/.test(query)
          ? 'cube'
          : 'search',
      at: lindas.clock?.now,
    };
    (request.key === 'cube' ? lindas.cubes : lindas.requests).push(request);
    lindas.inFlight += 1;
    lindas.peak = Math.max(lindas.peak, lindas.inFlight);
    try {
      const custom = lindas.answer?.(request);
      const answer = custom instanceof Promise ? await custom : custom;
      if (answer === 'hang') {
        await new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        });
      }
      if (answer instanceof Response) return answer;
      if (answer instanceof Error) throw answer;
      const bindings =
        request.key === 'cube'
          ? [{ modified: { type: 'literal', value: lindas.cubeModified } }]
          : request.key === 'search'
            ? lindas.search
            : // A tariff row carries the date of the cube, as in LINDAS.
              (lindas.tariffs[request.key] ?? []).map((b) =>
                b?.modified
                  ? { ...b, modified: { type: 'literal', value: lindas.cubeModified } }
                  : b,
              );
      return new Response(JSON.stringify(results(bindings)), {
        status: 200,
        headers: { 'content-type': 'application/sparql-results+json' },
      });
    } finally {
      lindas.inFlight -= 1;
    }
  };
  lindas.count = (key) => lindas.requests.filter((r) => r.key === key).length;
  return lindas;
}

export const contract = (inputs, id = 1) => ({
  id,
  template_key: TEMPLATE,
  template_version: '1',
  pricing_mode: 'delegated',
  inputs,
  currency: 'CHF',
  timezone: 'Europe/Zurich',
  billing_period_start_day: 1,
  status: 'active',
});

/** 30-minute intervals from `from` (ISO), `count` of them, 1 kWh each. */
export function intervals(from, count, kwh = 1) {
  const start = Date.parse(from);
  return Array.from({ length: count }, (_, i) => ({
    starts_at: new Date(start + i * 30 * MINUTE).toISOString(),
    kwh,
    max_power_kw: 2 * kwh,
  }));
}

export async function setup({
  start = JUNE,
  tariffs = { '351:2026': operatorRows(), '351:2027': operatorRows({ total: 31, energy: 10.94 }) },
  contracts = [contract({ municipality: 351 })],
  store = createMemoryStore(),
  lindas = createLindas(tariffs),
  wall,
  requestTimeout = 15 * SECOND,
} = {}) {
  const fake = createFakeClock(0);
  lindas.clock = fake.clock;
  lindas.timers = fake.timers;
  const gladys = createFakeGladys({ selector: 'elcom', energyContracts: contracts });
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map(String).join(' ')}`);
  const app = new ElcomApp({
    gladys,
    version: '0.1.0',
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    now: wall ?? (() => start + fake.clock.now),
    monotonic: () => (fake.clock.now += 0.001),
    timers: fake.timers,
    store,
    fetchImpl: lindas.fetch,
    requestTimeout,
  });
  // The handlers on the fake Gladys, but not the 'connected' one: each test starts the app itself.
  const on = gladys.on.bind(gladys);
  gladys.on = (event, fn) => (event === 'connected' ? gladys : on(event, fn));
  registerHandlers(gladys, app);
  gladys.on = on;
  await gladys.connect();
  return { app, gladys, lindas, store, fake, lines, advance: fake.advance, settle: fake.settle };
}

export { createMemoryStore };
