// -----------------------------------------------------------------------------
// The app (src/app.js) against the SDK's fake Gladys, a scripted LINDAS and a
// virtual clock: what is fetched and when (never more often than the source
// changes), the pauses, /data, the delegated pricing, the current price, the
// status and the two buttons.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY,
  HOUR,
  JUNE,
  MINUTE,
  SECOND,
  SEPTEMBER,
  binding,
  contract,
  createMemoryStore,
  intervals,
  operatorRows,
  searchBinding,
  setup,
} from './helpers/world.js';

/** Let `promise` run while the virtual clock moves `ms`, then await it. */
async function run(world, promise, ms = 10 * SECOND) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await world.settle();
  for (let t = 0; t < ms && !settled; t += SECOND) {
    await world.advance(SECOND);
    await world.settle();
  }
  return promise;
}

async function rejects(world, promise, pattern, ms) {
  let error;
  try {
    await run(world, promise, ms);
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'expected a rejection');
  assert.match(error.message, pattern);
}

const price = (world, inputs, from = '2026-06-01T00:00:00Z', count = 4) =>
  world.app.energyPrice({ contract: contract(inputs), intervals: intervals(from, count) });

test('start: the contracts read, this year fetched once, the status gives the price; a day later nothing asked again', async () => {
  const w = await setup();
  await run(w, w.app.start());
  assert.deepEqual(
    w.lindas.requests.map((r) => r.key),
    ['351:2026'],
    'June: never the next year',
  );
  const status = w.gladys.fake.connectionStatus;
  assert.equal(status.connected, true);
  assert.match(
    status.message.en,
    /Contract 1: municipality 351, Energie Wasser Bern, H4 standard 2026: 35\.95 Rp\.\/kWh VAT included, ElCom data of 2026-11-10/,
  );
  assert.match(status.message.fr, /35,95 ct\.\/kWh TVA incluse/);
  let reads = 0;
  const read = w.gladys.getEnergyContracts.bind(w.gladys);
  w.gladys.getEnergyContracts = () => {
    reads += 1;
    return read();
  };
  await w.advance(3 * DAY + MINUTE);
  assert.equal(w.lindas.requests.length, 1, 'a tariff fetched is never asked again');
  assert.equal(reads, 3, 'the contracts read once a day');
  await w.app.stop();
  assert.equal(w.fake.pending.size, 0, 'no timer after stop');
});

test('from 1 September the next year is fetched too, before it never (current price included)', async () => {
  const w = await setup({ start: Date.parse('2026-08-31T21:30:00Z') }); // 23:30 in Zurich
  await run(w, w.app.start());
  assert.deepEqual(
    w.lindas.requests.map((r) => r.key),
    ['351:2026'],
  );
  const now = await run(w, w.app.energyCurrent({ contract: contract({ municipality: 351 }) }));
  assert.equal(now.next_price, null);
  assert.equal(now.valid_until, '2026-12-31T23:00:00.000Z');
  assert.equal(w.lindas.count('351:2027'), 0);
  await w.advance(DAY + MINUTE);
  assert.equal(w.lindas.count('351:2027'), 1, 'asked in September');
  const next = await run(w, w.app.energyCurrent({ contract: contract({ municipality: 351 }) }));
  assert.ok(Math.abs(next.next_price - 0.31 * 1.081) < 1e-12);
  assert.ok(Math.abs(next.price - 0.3326 * 1.081) < 1e-12);
  assert.equal(next.label, 'ewb.Natur.STROM Einfachtarif 2026');
  assert.equal(next.next_label, 'ewb.Natur.STROM Einfachtarif 2027');
  await w.app.stop();
});

test('a municipality without tariff: asked once, again a week later at the soonest, even after a restart', async () => {
  const store = createMemoryStore();
  const w = await setup({ contracts: [contract({ municipality: 9999 })], store });
  await run(w, w.app.start());
  assert.equal(w.lindas.count('9999:2026'), 1);
  assert.match(
    w.gladys.fake.connectionStatus.message.en,
    /ElCom has no 2026 tariff for municipality 9999; asked again after 2026-06-22 10:00/,
  );
  await rejects(w, price(w, { municipality: 9999 }), /no 2026 tariff for municipality 9999/);
  await w.advance(6 * DAY);
  await rejects(w, price(w, { municipality: 9999 }), /no 2026 tariff/);
  assert.equal(w.lindas.count('9999:2026'), 1);
  await w.app.stop();
  assert.ok(store.data.misses['9999:2026'], 'kept in /data');
  // A restart 6 days and 23 hours after the question: still not asked.
  const w2 = await setup({
    contracts: [contract({ municipality: 9999 })],
    store,
    start: JUNE + 6 * DAY + 23 * HOUR,
  });
  await run(w2, w2.app.start());
  await rejects(w2, price(w2, { municipality: 9999 }), /no 2026 tariff/);
  assert.equal(w2.lindas.count('9999:2026'), 0);
  await w2.advance(2 * HOUR);
  w2.lindas.tariffs['9999:2026'] = operatorRows({ operator: 7, operatorName: 'X' });
  const costs = await run(w2, price(w2, { municipality: 9999 }));
  assert.equal(costs.length, 4);
  assert.equal(w2.lindas.count('9999:2026'), 1);
  await w2.app.stop();
});

test('a miss dated in the future in /data (clock set back) waits a week from now, never longer', async () => {
  const store = createMemoryStore({ misses: { '351:2026': JUNE + 30 * DAY }, entries: [] });
  const w = await setup({ store });
  await run(w, w.app.start());
  assert.equal(w.lindas.count('351:2026'), 0);
  assert.ok(
    store.data.misses['351:2026'].at <= JUNE + w.fake.clock.now,
    'kept as asked now, not in the future',
  );
  await w.advance(7 * DAY + MINUTE);
  await run(w, price(w, { municipality: 351 }));
  assert.equal(w.lindas.count('351:2026'), 1);
  await w.app.stop();
});

test('a failure pauses every request: 1 min doubled up to 6 h, Retry-After honoured and capped, reset by a success', async () => {
  const w = await setup({ contracts: [] });
  await run(w, w.app.start());
  let failing = true;
  w.lindas.answer = () => (failing ? new Response('', { status: 500 }) : undefined);
  const gaps = [];
  let last;
  for (let i = 0; i < 11; i += 1) {
    await rejects(w, price(w, { municipality: 351 }), /did not answer; next try after/);
    const at = w.lindas.requests.at(-1);
    if (last !== at) {
      gaps.push(w.fake.clock.now);
      last = at;
    }
    // Every request asked during the pause is refused without being sent.
    const before = w.lindas.requests.length;
    await rejects(w, price(w, { municipality: 351 }), /did not answer/);
    assert.equal(w.lindas.requests.length, before);
    const pause = w.app.pause.due - w.fake.clock.now;
    assert.ok(pause <= 6 * HOUR, `${pause}`);
    await w.advance(pause + 1);
  }
  const diffs = gaps.slice(1).map((t, i) => Math.round((t - gaps[i]) / MINUTE));
  assert.deepEqual(diffs, [1, 2, 4, 8, 16, 32, 64, 128, 256, 360]);
  // Retry-After longer than the backoff, then a huge one capped to 6 h.
  failing = false;
  w.lindas.answer = () => new Response('', { status: 429, headers: { 'retry-after': '7200' } });
  await rejects(w, price(w, { municipality: 351 }), /did not answer/);
  assert.equal(Math.round((w.app.pause.due - w.fake.clock.now) / MINUTE), 360);
  await w.advance(6 * HOUR + 1);
  w.lindas.answer = undefined;
  await run(w, price(w, { municipality: 351 }));
  assert.equal(w.app.failures, 0, 'a success resets the backoff');
  assert.equal(w.app.pause, null);
  w.lindas.answer = () => new Response('', { status: 429, headers: { 'retry-after': '120' } });
  await rejects(w, price(w, { municipality: 352 }), /did not answer/);
  assert.equal(Math.round((w.app.pause.due - w.fake.clock.now) / MINUTE), 2);
  w.lindas.answer = () => new Response('', { status: 429, headers: { 'retry-after': '99999999' } });
  await w.advance(2 * MINUTE + 1);
  await rejects(w, price(w, { municipality: 353 }), /did not answer/);
  assert.equal(Math.round((w.app.pause.due - w.fake.clock.now) / MINUTE), 360);
  await w.app.stop();
});

test('the pause is kept in /data: a restart does not ask sooner; a pause from the future is capped to 6 h', async () => {
  const store = createMemoryStore();
  const w = await setup({ store, contracts: [] });
  await run(w, w.app.start());
  w.lindas.answer = () => new Response('', { status: 503 });
  await rejects(w, price(w, { municipality: 351 }), /did not answer/);
  await w.app.stop();
  assert.ok(store.data.pause.until > JUNE);
  const w2 = await setup({ store, start: JUNE + 30 * SECOND });
  await run(w2, w2.app.start());
  assert.equal(w2.lindas.requests.length, 0, 'still paused after the restart');
  assert.equal(w2.gladys.fake.connectionStatus.connected, false);
  assert.match(
    w2.gladys.fake.connectionStatus.message.en,
    /did not answer; next try after 2026-06-15 10:01/,
  );
  await w2.advance(45 * SECOND);
  await run(w2, price(w2, { municipality: 351 }));
  assert.equal(w2.lindas.requests.length, 1);
  await w2.app.stop();
  const far = createMemoryStore({ pause: { until: JUNE + 400 * DAY, code: 'server' } });
  const w3 = await setup({ store: far });
  await run(w3, w3.app.start());
  assert.ok(w3.app.pause.due - w3.fake.clock.now <= 6 * HOUR);
  await w3.app.stop();
});

test('rows none of which is readable: this municipality waits a week (never "no tariff", never a 0), the others go on', async () => {
  const w = await setup({
    tariffs: {
      '351:2026': [{ operator: { type: 'literal', value: '?' } }],
      '352:2026': operatorRows(),
    },
  });
  await run(w, w.app.start());
  assert.equal(w.app.misses.get('351:2026').kind, 'unreadable');
  assert.equal(w.app.pause, null, 'no pause for every municipality');
  assert.equal(w.gladys.fake.connectionStatus.connected, true);
  assert.match(
    w.gladys.fake.connectionStatus.message.en,
    /answer for municipality 351 in 2026 could not be read/,
  );
  await rejects(w, price(w, { municipality: 351 }), /could not be read/);
  const other = await run(w, price(w, { municipality: 352 }));
  assert.equal(other.length, 4);
  assert.equal(w.lindas.count('351:2026'), 1);
  await w.app.stop();
});

test('one request at a time, two seconds apart; the same tariff asked twice at once is fetched once', async () => {
  const tariffs = {};
  for (const m of [1, 2, 3, 4]) tariffs[`${m}:2026`] = operatorRows({ operator: m });
  const w = await setup({ tariffs, contracts: [] });
  // Each answer takes 3 s: longer than the gap, so only the queue keeps one request at a time.
  w.lindas.answer = () =>
    new Promise((resolve) => w.lindas.timers.setTimeout(() => resolve(undefined), 3 * SECOND));
  await run(w, w.app.start());
  const calls = [1, 2, 3, 4, 1, 2].map((m) => price(w, { municipality: m }));
  const costs = await run(w, Promise.all(calls), 60 * SECOND);
  assert.equal(costs.length, 6);
  assert.deepEqual(
    w.lindas.requests.map((r) => r.key),
    ['1:2026', '2:2026', '3:2026', '4:2026'],
  );
  assert.equal(w.lindas.peak, 1);
  await w.app.stop();
});

test('two requests are two seconds apart at least, even when the answers are instant', async () => {
  const tariffs = {};
  for (const m of [1, 2, 3]) tariffs[`${m}:2026`] = operatorRows({ operator: m });
  const w = await setup({ tariffs, contracts: [] });
  await run(w, w.app.start());
  await run(w, Promise.all([1, 2, 3].map((m) => price(w, { municipality: m }))), 30 * SECOND);
  const at = w.lindas.requests.map((r) => r.at);
  assert.equal(at.length, 3);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] - at[i - 1] >= 2 * SECOND - 1, `${at}`);
  await w.app.stop();
});

test('the pricing answers within its budget even when a request would take longer', async () => {
  const w = await setup({ contracts: [], requestTimeout: 120 * SECOND });
  await run(w, w.app.start());
  w.lindas.answer = () => 'hang';
  const started = w.fake.clock.now;
  await rejects(w, price(w, { municipality: 351 }), /still being fetched/, 60 * SECOND);
  assert.ok(w.fake.clock.now - started <= 26 * SECOND, `${w.fake.clock.now - started}`);
  await w.app.stop();
});

test('the next year is never asked before 1 September, whoever asks', async () => {
  const w = await setup({ start: Date.parse('2026-08-31T21:59:00Z') });
  await run(w, w.app.start());
  const result = await w.app.ensure(351, 2027);
  assert.deepEqual(result, { reason: { code: 'not_yet' } });
  assert.deepEqual(await w.app.ensure(351, 2028), { reason: { code: 'out_of_range' } });
  assert.deepEqual(await w.app.ensure(351, 2010), { reason: { code: 'out_of_range' } });
  assert.equal(w.lindas.count('351:2027'), 0);
  await w.advance(2 * MINUTE);
  const now = await run(w, w.app.ensure(351, 2027));
  assert.ok(now.entry, '1 September 00:01 in Zurich');
  await w.app.stop();
});

test('a silent LINDAS: the request ends at 15 s (a pause), the pricing throws in time, never a hang nor a zero', async () => {
  const w = await setup({ contracts: [] });
  await run(w, w.app.start());
  w.lindas.answer = () => 'hang';
  const started = w.fake.clock.now;
  await rejects(w, price(w, { municipality: 351 }), /did not answer/, 40 * SECOND);
  assert.ok(w.fake.clock.now - started <= 17 * SECOND, `${w.fake.clock.now - started}`);
  assert.equal(w.app.pause.code, 'timeout');
  const current = w.app.energyCurrent({ contract: contract({ municipality: 351 }) });
  const answer = await run(w, current);
  assert.equal(answer.price, null);
  await w.app.stop();
});

test('delegated pricing: two years in one request, operator and inputs checked, components add up', async () => {
  const tariffs = {
    '351:2025': operatorRows({ total: 31.18, meteringrate: null }),
    '351:2026': operatorRows(),
    '4324:2026': [
      ...operatorRows({
        operator: 5,
        operatorName: 'AEW Energie AG',
        total: 25,
        energy: 7,
        gridusage: 13.03,
        charge: 0.6,
      }),
      ...operatorRows({ operator: 87, operatorName: 'Baldingen' }),
    ],
  };
  const w = await setup({ tariffs, contracts: [] });
  await run(w, w.app.start());
  const ack = await run(
    w,
    w.gladys.fake.energyPrice({
      contract: contract({ municipality: 351, vat: 'excluded' }),
      billing_period: { starts_at: '2025-12-01T00:00:00Z', ends_at: '2026-01-01T00:00:00Z' },
      cumulative_before: { day: 0, month: 0, billing_period: 0 },
      intervals: intervals('2025-12-31T22:30:00Z', 2, 2),
    }),
  );
  assert.equal(ack.success, true, JSON.stringify(ack));
  const costs = ack.data.costs;
  assert.equal(costs.length, 2);
  assert.ok(Math.abs(costs[0].cost - 2 * 0.3118) < 1e-12);
  assert.ok(Math.abs(costs[1].cost - 2 * 0.3326) < 1e-12);
  for (const c of costs) {
    const sum = Object.values(c.components).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - c.cost) < 1e-12);
  }
  await rejects(
    w,
    price(w, { municipality: 4324 }),
    /several grid operators in 2026.*5 \(AEW Energie AG\), 87 \(Baldingen\)/,
  );
  const aew = await run(w, price(w, { municipality: 4324, operator: 5 }));
  assert.ok(Math.abs(aew[0].cost - 0.25 * 1.081) < 1e-12);
  await rejects(
    w,
    price(w, { municipality: 4324, operator: 6 }),
    /operator 6 does not serve municipality 4324/,
  );
  await rejects(w, price(w, { municipality: 351, category: 'C7' }), /no C7 tariff/);
  await rejects(w, price(w, { municipality: 'x' }), /municipality number/);
  await rejects(w, price(w, {}), /municipality number \(BFS\) is missing/);
  await rejects(
    w,
    w.app.energyPrice({
      contract: { ...contract({ municipality: 351 }), template_key: 'other' },
      intervals: [],
    }),
    /Unknown template/,
  );
  await rejects(w, price(w, { municipality: 351 }, '2010-06-01T00:00:00Z'), /published from 2011/);
  assert.deepEqual(
    await w.app.energyPrice({ contract: contract({ municipality: 351 }), intervals: [] }),
    [],
  );
  const nack = await run(
    w,
    w.gladys.fake.energyPrice({
      contract: contract({ municipality: 4324 }),
      billing_period: {},
      cumulative_before: {},
      intervals: intervals('2026-06-01T00:00:00Z', 1),
    }),
  );
  assert.equal(nack.success, false, 'a throw is a failure for the core, never a zero cost');
  await w.app.stop();
});

test('the current price: now and from 1 January, unknown is null, invalid inputs too', async () => {
  const w = await setup({ start: SEPTEMBER });
  await run(w, w.app.start());
  const ack = await run(
    w,
    w.gladys.fake.energyCurrent({
      contract: contract({ municipality: 351 }),
      billing_period: {},
      cumulative: {},
      max_power_kw: 1,
    }),
  );
  assert.equal(ack.success, true);
  assert.equal(ack.data.valid_until, '2026-12-31T23:00:00.000Z');
  assert.ok(Math.abs(ack.data.price - 0.3326 * 1.081) < 1e-12);
  assert.ok(Math.abs(ack.data.next_price - 0.31 * 1.081) < 1e-12);
  const bad = await w.app.energyCurrent({ contract: contract({ municipality: 'abc' }) });
  assert.deepEqual(bad, { price: null, valid_until: null, next_price: null });
  await w.app.stop();
});

test('/data unreadable: never written over, read again every 10 s, nothing asked before it is known', async () => {
  const kept = {
    entries: [],
    misses: { '351:2026': JUNE - DAY },
  };
  const store = createMemoryStore(kept);
  store.failLoad = 3;
  const w = await setup({ store });
  await run(w, w.app.start());
  assert.equal(w.app.storeState, 'broken');
  assert.equal(store.saves, 0, 'never written while unreadable');
  // While unreadable, the rules still hold in memory (the miss on disk is not known yet).
  await w.advance(21 * SECOND);
  assert.equal(store.loads, 3);
  await w.advance(10 * SECOND);
  assert.equal(w.app.storeState, 'ok');
  assert.ok(store.saves >= 1, 'written once read');
  assert.ok(store.data.misses['351:2026'], 'what it kept is kept');
  await w.app.stop();
});

test('/data slow: the pricing never waits past its budget, and nothing is asked before /data is read', async () => {
  const store = createMemoryStore({ entries: [] });
  let release;
  store.gate = new Promise((resolve) => (release = resolve));
  const w = await setup({ store, contracts: [] });
  const started = w.app.start();
  const now = await run(
    w,
    w.app.energyCurrent({ contract: contract({ municipality: 351 }) }),
    4 * SECOND,
  );
  assert.equal(now.price, null, 'answered within its budget');
  assert.equal(w.lindas.requests.length, 0, 'nothing asked while /data is being read');
  // Past 5 s, /data counts as unreadable: asked under the rules kept in memory, never written over.
  await run(w, started);
  await w.advance(2 * SECOND);
  assert.equal(w.app.storeState, 'broken');
  await run(w, price(w, { municipality: 351 }));
  assert.equal(w.lindas.requests.length, 1);
  assert.equal(store.saves, 0);
  // The late read lands: merged, then written.
  release();
  await w.settle();
  assert.equal(w.app.storeState, 'ok');
  assert.ok(store.saves >= 1);
  await w.app.stop();
});

test('a tariff kept in /data is used after a restart without any request; a hostile one is dropped', async () => {
  const store = createMemoryStore();
  const w = await setup({ store });
  await run(w, w.app.start());
  await w.app.stop();
  assert.equal(store.data.entries.length, 1);
  const w2 = await setup({ store });
  await run(w2, w2.app.start());
  assert.equal(w2.lindas.requests.length, 0);
  await run(w2, price(w2, { municipality: 351 }));
  await w2.app.stop();
  const good = store.data.entries[0];
  const hostile = createMemoryStore({
    entries: [
      { ...good, rows: [{ ...good.rows[0], total: 1e9 }] },
      { ...good, municipality: '351' },
      { ...good, operators: [] },
      { ...good, rows: [{ ...good.rows[0], operator: 42 }] },
      { ...good, modified: '<script>' },
      { ...good, year: 2027, fetchedAt: JUNE + 400 * DAY },
    ],
  });
  const w3 = await setup({ store: hostile });
  await run(w3, w3.app.start());
  assert.deepEqual([...w3.app.entries.keys()].sort(), ['351:2026', '351:2027']);
  assert.ok(
    w3.app.entries.get('351:2027').fetchedAt <= JUNE + w3.fake.clock.now + 1,
    'future date brought to now',
  );
  assert.equal(w3.lindas.count('351:2026'), 1, 'the hostile ones were dropped, so asked');
  await w3.app.stop();
});

test('the memory is bounded: the least recently used tariffs go first', async () => {
  const tariffs = {};
  for (let m = 1; m <= 45; m += 1) tariffs[`${m}:2026`] = [binding({ operator: m })];
  const w = await setup({ tariffs, contracts: [] });
  await run(w, w.app.start());
  for (let m = 1; m <= 45; m += 1) {
    await run(w, price(w, { municipality: m }));
    await w.advance(SECOND);
  }
  assert.equal(w.app.entries.size, 40);
  assert.ok(!w.app.entries.has('1:2026') && w.app.entries.has('45:2026'));
  await w.app.stop();
});

test('reading the contracts fails in connected: retried 1, 2, 4 min, status said, then the prices', async () => {
  const w = await setup();
  let failures = 3;
  const real = w.gladys.getEnergyContracts.bind(w.gladys);
  let reads = 0;
  w.gladys.getEnergyContracts = async () => {
    reads += 1;
    if (failures > 0) {
      failures -= 1;
      throw new Error('503');
    }
    return real();
  };
  await run(w, w.app.start());
  assert.equal(reads, 1);
  assert.match(w.gladys.fake.connectionStatus.message.en, /could not be read from Gladys/);
  await w.advance(MINUTE);
  assert.equal(reads, 2);
  await w.advance(2 * MINUTE);
  assert.equal(reads, 3);
  await w.advance(4 * MINUTE - SECOND);
  assert.equal(reads, 3);
  await w.advance(SECOND + 5 * SECOND);
  assert.equal(reads, 4);
  assert.match(w.gladys.fake.connectionStatus.message.en, /35\.95 Rp/);
  await w.app.stop();
});

test('the status: one per state, bounded, no contract said, disconnected stops the daily refresh', async () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    contract({ municipality: 351, category: 'H1' }, i + 1),
  );
  const w = await setup({ contracts: many });
  await run(w, w.app.start());
  const sent = w.gladys.fake.connectionStatuses.length;
  await w.app.publishStatus();
  assert.equal(w.gladys.fake.connectionStatuses.length, sent, 'the same status is not sent again');
  const { message } = w.gladys.fake.connectionStatus;
  assert.match(message.en, /\(\+5 more\)/);
  assert.ok(message.en.length <= 900 && message.fr.length <= 900);
  w.app.disconnected();
  assert.equal(w.app.refreshTimer, undefined);
  await w.app.stop();
  const none = await setup({ contracts: [] });
  await run(none, none.app.start());
  assert.match(none.gladys.fake.connectionStatus.message.en, /No energy contract uses/);
  assert.match(none.gladys.fake.connectionStatus.message.fr, /Aucun contrat/);
  await none.app.stop();
});

test('after stop: no request, no timer, a pricing refused', async () => {
  const w = await setup({ contracts: [] });
  await run(w, w.app.start());
  await w.app.stop();
  await rejects(w, price(w, { municipality: 351 }), /stopping/);
  assert.equal(w.lindas.requests.length, 0);
  assert.equal(w.fake.pending.size, 0);
});

test('the button "Find my municipality": checked text, numbers and operators, kept 1 h, paused said', async () => {
  const w = await setup({ contracts: [] });
  await run(w, w.app.start());
  await rejects(w, w.app.findMunicipality({ query: 'B"' }), /2 to 60 letters/);
  await rejects(w, w.app.findMunicipality({}), /2 to 60 letters/);
  w.lindas.search = [
    searchBinding(4258, 'Rheinfelden', 5, 'AEW Energie AG'),
    searchBinding(4324, 'Zurzach', 5, 'AEW Energie AG'),
    searchBinding(4324, 'Zurzach', 87, 'Baldingen'),
    searchBinding(9998, 'Nowhere'),
    { m: { type: 'uri', value: 'https://evil.example/1' }, name: { type: 'literal', value: 'x' } },
  ];
  const ack = await run(w, w.gladys.fake.action('find_municipality', { query: 'rhein' }));
  assert.equal(ack.success, true);
  const text = ack.data.message;
  assert.match(
    text.en,
    /Rheinfelden: municipality number 4258; grid operators 2026: 5 \(AEW Energie AG\)/,
  );
  assert.match(
    text.en,
    /Zurzach: municipality number 4324; grid operators 2026: 5 \(AEW Energie AG\), 87 \(Baldingen\)/,
  );
  assert.match(text.en, /Nowhere: municipality number 9998; no ElCom tariff in 2026/);
  assert.doesNotMatch(text.en, /evil/);
  assert.match(text.fr, /numéro de commune 4258/);
  await run(w, w.app.findMunicipality({ query: 'Rhein ' }));
  assert.equal(w.lindas.count('search'), 1, 'the same search is not asked again within the hour');
  w.lindas.search = [];
  await w.advance(HOUR);
  const none = await run(w, w.app.findMunicipality({ query: 'rhein' }));
  assert.match(none.en, /No Swiss municipality matches/);
  w.lindas.answer = () => new Response('', { status: 502 });
  await rejects(w, w.app.findMunicipality({ query: 'Bern' }), /did not answer/);
  await rejects(w, w.app.findMunicipality({ query: '3011' }), /did not answer/);
  assert.equal(w.lindas.count('search'), 3, 'nothing sent during the pause');
  await w.app.stop();
});

test('the button "Check my contracts": every contract, its price or its problem', async () => {
  const contracts = [
    contract({ municipality: 351 }, 1),
    contract({ municipality: 9999 }, 2),
    contract({ municipality: 'abc' }, 3),
    { ...contract({ municipality: 351 }, 4), template_key: 'someone-else' },
  ];
  const w = await setup({ contracts });
  await run(w, w.app.start());
  const ack = await run(w, w.gladys.fake.action('check_contracts'));
  assert.equal(ack.success, true);
  const lines = ack.data.message.en.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Contract 1: municipality 351, Energie Wasser Bern/);
  assert.match(lines[1], /^Contract 2: ElCom has no 2026 tariff for municipality 9999/);
  assert.match(lines[2], /^Contract 3: The municipality number \(BFS\) must be a whole number/);
  assert.equal(w.lindas.count('9999:2026'), 1, 'the button never asks a miss again');
  w.gladys.getEnergyContracts = async () => {
    throw new Error('down');
  };
  const down = await run(w, w.app.checkContracts());
  assert.match(down.en, /could not be read/);
  await w.app.stop();
});

test('review r1 I1: a "no tariff" row (total 0) is a failure for the core, never a cost of 0', async () => {
  const lausanne = JSON.parse(
    (await import('node:fs')).readFileSync(
      new URL('./fixtures/lausanne-5586-2026.json', import.meta.url),
    ),
  );
  const w = await setup({ tariffs: { '5586:2026': lausanne.results.bindings }, contracts: [] });
  await run(w, w.app.start());
  const ack = await run(
    w,
    w.gladys.fake.energyPrice({
      contract: contract({ municipality: 5586, category: 'C5' }),
      billing_period: {},
      cumulative_before: {},
      intervals: intervals('2026-06-01T00:00:00Z', 4, 30),
    }),
  );
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /publishes no C5 tariff for municipality 5586 in 2026/);
  const h4 = await run(w, price(w, { municipality: 5586, category: 'H4' }));
  assert.ok(h4.every((c) => c.cost > 0));
  // A municipality whose every row is 0: no tariff (asked again in a week), not unreadable.
  w.lindas.tariffs['7:2026'] = [binding({ total: '0.000', energyname: 'Aucun' })];
  await rejects(w, price(w, { municipality: 7 }), /ElCom has no 2026 tariff for municipality 7/);
  assert.equal(w.app.misses.get('7:2026').kind, 'missing');
  await w.app.stop();
});

test('review r1 I2: an operator published later is read again within a week; the cube date reads again a changed year', async () => {
  const start = Date.parse('2026-09-01T06:00:00Z');
  const tariffs = {
    '4324:2026': operatorRows({ operator: 5 }),
    '4324:2027': operatorRows({ operator: 5 }),
  };
  const w = await setup({
    start,
    tariffs,
    contracts: [contract({ municipality: 4324, operator: 87 })],
  });
  await run(w, w.app.start());
  assert.equal(w.lindas.count('4324:2027'), 1);
  assert.match(
    w.gladys.fake.connectionStatus.message.en,
    /operator 87 does not serve municipality 4324 in 2027/,
  );
  // Operator 87 published a few days later.
  w.lindas.tariffs['4324:2027'] = [
    ...operatorRows({ operator: 5 }),
    ...operatorRows({ operator: 87, operatorName: 'Baldingen' }),
  ];
  w.lindas.tariffs['4324:2026'] = w.lindas.tariffs['4324:2027'];
  await w.advance(6 * DAY);
  assert.equal(w.lindas.count('4324:2027'), 1, 'not before a week');
  await w.advance(2 * DAY);
  assert.equal(w.lindas.count('4324:2027'), 2, 'read again after a week');
  assert.match(
    w.gladys.fake.connectionStatus.message.en,
    /municipality 4324, Baldingen, H4 standard 2026/,
  );
  assert.match(
    w.gladys.fake.connectionStatus.message.en,
    /Baldingen, H4 standard 2027/,
    'the next year described from September',
  );
  await w.advance(30 * DAY);
  assert.equal(
    w.lindas.count('4324:2027'),
    2,
    'no problem left: never read again while the data is unchanged',
  );
  // ElCom changes its data: the years in use are read again once.
  w.lindas.cubeModified = '2026-12-01';
  await w.advance(DAY + MINUTE);
  assert.equal(w.lindas.count('4324:2027'), 3);
  assert.equal(w.lindas.count('4324:2026'), 3);
  await w.advance(3 * DAY);
  assert.equal(w.lindas.count('4324:2027'), 3, 'once per change of the data');
  assert.ok(w.lindas.cubes.length <= 45, `${w.lindas.cubes.length} cube questions in 44 days`);
  await w.app.stop();
});

test('review r1 I2: the button reads again what was read (or missing) more than an hour ago', async () => {
  const w = await setup({
    contracts: [contract({ municipality: 351 }), contract({ municipality: 9999 }, 2)],
  });
  await run(w, w.app.start());
  assert.equal(w.lindas.count('351:2026'), 1);
  assert.equal(w.lindas.count('9999:2026'), 1);
  await run(w, w.app.checkContracts());
  assert.equal(w.lindas.count('351:2026'), 1, 'not within the hour');
  await w.advance(HOUR + MINUTE);
  w.lindas.tariffs['9999:2026'] = operatorRows({ operator: 9 });
  const text = await run(w, w.app.checkContracts());
  assert.equal(w.lindas.count('351:2026'), 2);
  assert.equal(w.lindas.count('9999:2026'), 2);
  assert.match(text.en, /Contract 2: municipality 9999/);
  await w.app.stop();
});

test('review r1 M1: the status follows the end of a pause without waiting for the daily refresh', async () => {
  const w = await setup();
  await run(w, w.app.start());
  w.lindas.answer = () => new Response('', { status: 503 });
  await rejects(w, price(w, { municipality: 352 }), /did not answer/);
  assert.equal(w.gladys.fake.connectionStatus.connected, false, 'said when it starts');
  w.lindas.answer = undefined;
  await w.advance(MINUTE + SECOND);
  assert.equal(w.gladys.fake.connectionStatus.connected, true, 'cleared when it ends');
  await w.app.stop();
  assert.equal(w.fake.pending.size, 0);
});

test('review r1 M3/M4: a slow /data is read once at a time; an unreadable one: nothing read but the prices', async () => {
  const store = createMemoryStore({ entries: [] });
  store.gate = new Promise(() => {});
  const w = await setup({ store });
  w.app.start();
  await w.advance(45 * SECOND);
  assert.equal(store.loads, 1, 'never two reads at once');
  await w.app.stop();
  const broken = createMemoryStore({ entries: [] });
  broken.failLoad = 1000;
  const b = await setup({ store: broken });
  await run(b, b.app.start());
  assert.equal(b.lindas.requests.length + b.lindas.cubes.length, 0, 'the refresh reads nothing');
  assert.match(
    b.gladys.fake.connectionStatus.message.en,
    /\/data volume of the integration cannot be read/,
  );
  await rejects(b, b.app.findMunicipality({ query: 'Bern' }), /cannot be read/);
  const costs = await run(b, price(b, { municipality: 351 }));
  assert.equal(costs.length, 4, 'the prices the core asks for still go');
  await b.app.stop();
});

test('review r1 M7: stop() aborts the request in flight, without a pause', async () => {
  const w = await setup({ contracts: [], requestTimeout: 120 * SECOND });
  await run(w, w.app.start());
  let aborted = false;
  w.lindas.answer = (r) => {
    r.init.signal.addEventListener('abort', () => (aborted = true));
    return 'hang';
  };
  const pending = price(w, { municipality: 351 }).catch((e) => e);
  await w.settle();
  assert.equal(w.lindas.inFlight, 1);
  await w.app.stop();
  await w.settle();
  assert.equal(aborted, true);
  assert.equal(w.lindas.inFlight, 0);
  assert.equal(w.app.pause, null);
  assert.match((await pending).message, /stopping|still being fetched/);
});

test('review r1 M9/M10: an orphaned contract is ignored; an input error is said in French too', async () => {
  const w = await setup({
    contracts: [
      { ...contract({ municipality: 777 }, 1), status: 'orphaned' },
      contract({ municipality: 'abc' }, 2),
    ],
  });
  await run(w, w.app.start());
  assert.equal(w.lindas.count('777:2026'), 0);
  const { message } = w.gladys.fake.connectionStatus;
  assert.doesNotMatch(message.en, /777/);
  assert.match(message.fr, /numéro de commune \(OFS\) doit être un nombre entier/);
  await w.app.stop();
});

test('review r1: the cube date is asked once a day even across reconnections; a read again that finds nothing keeps the tariff', async () => {
  const w = await setup();
  await run(w, w.app.start());
  assert.equal(w.lindas.cubes.length, 1);
  w.app.disconnected();
  await run(w, w.app.start());
  await run(w, w.app.start());
  assert.equal(w.lindas.cubes.length, 1, 'not again within the day');
  // The button an hour later: LINDAS answers nothing; the tariff read before is kept.
  await w.advance(HOUR + MINUTE);
  w.lindas.tariffs['351:2026'] = [];
  await run(w, w.app.checkContracts());
  assert.equal(w.lindas.count('351:2026'), 2);
  assert.equal(w.app.misses.has('351:2026'), false, 'a tariff kept is never a miss');
  const costs = await run(w, price(w, { municipality: 351 }));
  assert.ok(costs.every((c) => c.cost > 0));
  await w.advance(10 * MINUTE);
  await run(w, w.app.checkContracts());
  assert.equal(w.lindas.count('351:2026'), 2, 'not again within the hour');
  await w.app.stop();
});

test('review r2 m1: /data readable again republishes the status and does the skipped refresh', async () => {
  const store = createMemoryStore({ entries: [] });
  store.failLoad = 1;
  const w = await setup({ store });
  await run(w, w.app.start());
  assert.match(w.gladys.fake.connectionStatus.message.en, /cannot be read/);
  assert.equal(w.lindas.requests.length, 0);
  await w.advance(10 * SECOND);
  await run(w, Promise.resolve(), 5 * SECOND);
  await w.advance(3 * SECOND);
  assert.equal(w.app.storeState, 'ok');
  assert.equal(w.lindas.count('351:2026'), 1, 'the refresh skipped is done');
  assert.doesNotMatch(w.gladys.fake.connectionStatus.message.en, /cannot be read/);
  assert.match(w.gladys.fake.connectionStatus.message.en, /35\.95 Rp/);
  await w.app.stop();
});

test('review r2 m1: after a pause, the status gives the price read, never "still being fetched"', async () => {
  const w = await setup();
  w.lindas.answer = () => new Response('', { status: 503 });
  await run(w, w.app.start());
  assert.equal(w.gladys.fake.connectionStatus.connected, false);
  w.lindas.answer = undefined;
  await w.advance(MINUTE + SECOND);
  await run(w, price(w, { municipality: 351 }));
  await w.settle();
  const { connected, message } = w.gladys.fake.connectionStatus;
  assert.equal(connected, true);
  assert.match(message.en, /35\.95 Rp/);
  assert.doesNotMatch(message.en, /still being fetched/);
  // A tariff never asked (no read in flight) is "not read yet", not "being fetched".
  w.app.contracts.set('9', { id: '9', inputs: { municipality: 400 } });
  assert.match(w.app.describe(w.app.contracts.get('9'), 2026).en, /not read yet/);
  await w.app.stop();
});

test('review r2 m2: the cube date is kept across a restart (N4)', async () => {
  const store = createMemoryStore();
  const w = await setup({ store });
  await run(w, w.app.start());
  assert.equal(w.lindas.cubes.length, 1);
  await w.app.stop();
  assert.equal(store.data.cube.modified, '2026-11-10');
  const w2 = await setup({ store, start: JUNE + HOUR });
  await run(w2, w2.app.start());
  assert.equal(w2.lindas.cubes.length, 0, 'not asked again within the day');
  await w2.app.stop();
});

test('review r2 m2: the button reads nothing while /data is unreadable (N6); stop() during a pause leaves no timer (N8)', async () => {
  const broken = createMemoryStore({ entries: [] });
  broken.failLoad = 1000;
  const w = await setup({ store: broken });
  await run(w, w.app.start());
  await w.advance(2 * HOUR);
  const text = await run(w, w.app.checkContracts());
  assert.match(text.en, /cannot be read/);
  assert.equal(w.lindas.requests.length + w.lindas.cubes.length, 0);
  await w.app.stop();
  const p = await setup({ contracts: [] });
  await run(p, p.app.start());
  p.lindas.answer = () => new Response('', { status: 503 });
  await rejects(p, price(p, { municipality: 351 }), /did not answer/);
  assert.ok(p.app.pauseTimer !== undefined);
  await p.app.stop();
  assert.equal(p.fake.pending.size, 0, 'the pause timer cleared by stop()');
});

test('review r2 m2: an operator with no-tariff rows only is still listed: "no tariff", not "unknown operator" (N10)', async () => {
  const tariffs = {
    '4229:2021': [
      ...operatorRows({ operator: 229, operatorName: 'Other' }),
      binding({ operator: 95, operatorName: 'Op 95', total: '0.0', energyname: 'KEIN NAME' }),
    ],
  };
  const w = await setup({ tariffs, contracts: [], start: Date.parse('2021-06-01T08:00:00Z') });
  await run(w, w.app.start());
  await rejects(
    w,
    price(w, { municipality: 4229, operator: 95 }, '2021-03-01T00:00:00Z'),
    /publishes no H4 tariff/,
  );
  await w.app.stop();
});

test('review r2 m4: two contracts on one municipality: the one finding nothing still gets its weekly read again', async () => {
  const start = Date.parse('2026-09-01T06:00:00Z');
  const tariffs = {
    '4324:2026': operatorRows({ operator: 5 }),
    '4324:2027': operatorRows({ operator: 5 }),
  };
  const w = await setup({
    start,
    tariffs,
    contracts: [
      contract({ municipality: 4324, operator: 5 }, 1),
      contract({ municipality: 4324, operator: 87 }, 2),
    ],
  });
  await run(w, w.app.start());
  assert.equal(w.lindas.count('4324:2026'), 1);
  await w.advance(8 * DAY);
  assert.equal(w.lindas.count('4324:2026'), 2, 'read again for contract 2');
  await w.app.stop();
});
