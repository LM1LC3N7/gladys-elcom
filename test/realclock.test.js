// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, setTimeout) and a real local
// HTTP server playing LINDAS: the contracts are read at 0, a day and two days,
// the tariff of the year is asked once and the date of the data once a day, the timers never pile
// up and none is left after stop. Time sped up: a day lasts about 0.4 s.
// Everything is stopped in t.after, so a failure never leaves a timer alive.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ElcomApp } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { JUNE, contract, operatorRows, results } from './helpers/world.js';

const DAY = 24 * 3600_000;
const SPEED = 200_000;

test('real clock: contracts read every day, the tariff asked once, timers bounded', async (t) => {
  const asked = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      asked.push(new URLSearchParams(body).get('query').includes('municipality/351>'));
      res.writeHead(200, { 'content-type': 'application/sparql-results+json' });
      res.end(JSON.stringify(results(operatorRows())));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const live = new Set();
  let timersSet = 0;
  let peakLive = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      const id = setTimeout(
        () => {
          live.delete(id);
          fn();
        },
        Math.max(0, ms) / SPEED,
      );
      live.add(id);
      peakLive = Math.max(peakLive, live.size);
      return id;
    },
    clearTimeout(id) {
      live.delete(id);
      clearTimeout(id);
    },
  };
  t.after(() => {
    for (const id of live) clearTimeout(id);
  });
  const t0 = performance.now();
  const gladys = createFakeGladys({
    selector: 'elcom',
    energyContracts: [contract({ municipality: 351 })],
  });
  const quiet = () => {};
  const app = new ElcomApp({
    gladys,
    version: '0.1.0',
    now: () => JUNE + (performance.now() - t0) * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    fetchImpl: (url, init) => fetch(`http://127.0.0.1:${port}/query`, init),
    requestTimeout: 15_000 * SPEED,
  });
  t.after(() => app.stop());
  const decided = [];
  const refresh = app.refresh.bind(app);
  app.refresh = (...args) => {
    decided.push(performance.now() * SPEED);
    return refresh(...args);
  };
  await gladys.connect();
  const started = performance.now() * SPEED;
  await app.start();
  const end = started + 2.5 * DAY;
  const deadline = performance.now() + 10_000;
  while (performance.now() * SPEED < end && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await app.stop();
  const at = decided.map((d) => Math.round((d - started) / 3600_000));
  assert.equal(decided.length, 3, `refreshes at ${at} h`);
  for (let i = 1; i < decided.length; i += 1) {
    const gap = decided[i] - decided[i - 1];
    assert.ok(gap >= 0.9 * DAY, `never sooner than a day: ${at} h`);
    assert.ok(gap < 1.5 * DAY, `on time: ${at} h`);
  }
  assert.equal(asked.filter(Boolean).length, 1, 'the tariff of the year asked once');
  assert.equal(asked.filter((x) => !x).length, 3, 'the date of the ElCom data asked once a day');
  assert.ok(peakLive <= 4, `${peakLive} timers alive at once`);
  assert.equal(live.size, 0, `${live.size} timers left after stop`);
  assert.ok(timersSet <= 20, `${timersSet} timers set`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
