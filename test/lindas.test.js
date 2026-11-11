// -----------------------------------------------------------------------------
// The LINDAS client (src/lindas.js): what is sent (POST, our User-Agent,
// `Accept` explicit, no redirect), what each answer means, the bounds on size
// and time, and queries that only ever hold checked values.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LindasError,
  retryAfterSeconds,
  searchQuery,
  searchText,
  select,
  tariffQuery,
} from '../src/lindas.js';
import { createFakeClock } from './helpers/fakeTimers.js';
import { binding, results } from './helpers/world.js';

const ok = (body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/sparql-results+json', ...headers },
  });

async function code(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof LindasError, String(err));
    return [err.code, err.status, err.retryAfter];
  }
  return 'resolved';
}

test('a request: POST form, our User-Agent, SPARQL JSON asked, no redirect followed', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return ok(results([binding()]));
  };
  const { timers, pending } = createFakeClock(0);
  const rows = await select(tariffQuery(351, 2026), { version: '0.1.0', fetchImpl, timers });
  assert.equal(rows.length, 1);
  assert.equal(pending.size, 0, 'the timeout cleared once answered');
  assert.equal(seen.url, 'https://lindas.admin.ch/query');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.headers.accept, 'application/sparql-results+json');
  assert.equal(seen.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(
    seen.init.headers['user-agent'],
    'gladys-elcom/0.1.0 (+https://github.com/LM1LC3N7/gladys-elcom)',
  );
  const query = new URLSearchParams(seen.init.body).get('query');
  assert.match(query, /municipality\/351> ;/);
  assert.match(query, /"2026"\^\^<http:\/\/www.w3.org\/2001\/XMLSchema#gYear>/);
  assert.match(query, /LIMIT 2000/);
});

test('the answers: 429 with Retry-After, 503, 500, 404, not JSON, wrong shape, network', async () => {
  const run = (response) => select('q', { version: '1', fetchImpl: async () => response() });
  assert.deepEqual(
    await code(run(() => new Response('', { status: 429, headers: { 'retry-after': '120' } }))),
    ['rate_limited', 429, 120],
  );
  assert.deepEqual(
    await code(
      run(
        () =>
          new Response('', {
            status: 503,
            headers: {
              'retry-after': 'Wed, 11 Nov 2026 10:10:00 GMT',
              date: 'Wed, 11 Nov 2026 10:00:00 GMT',
            },
          }),
      ),
    ),
    ['server', 503, 600],
  );
  assert.deepEqual(await code(run(() => new Response('', { status: 500 }))), ['server', 500, null]);
  assert.deepEqual(await code(run(() => new Response('', { status: 404 }))), [
    'unreadable',
    404,
    null,
  ]);
  assert.deepEqual(await code(run(() => new Response('', { status: 301 }))), [
    'unreadable',
    301,
    null,
  ]);
  assert.deepEqual(await code(run(() => ok('<html>'))), ['unreadable', 200, null]);
  assert.deepEqual(await code(run(() => ok({ results: { bindings: [] } }))), [
    'unreadable',
    200,
    null,
  ]);
  assert.deepEqual(await code(run(() => ok({ head: { vars: [] }, results: {} }))), [
    'unreadable',
    200,
    null,
  ]);
  assert.deepEqual(
    await code(
      select('q', {
        version: '1',
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    ),
    ['network', null, null],
  );
  assert.deepEqual(await run(() => ok(results([]))), []);
});

test('a too large answer is cut before it is read whole', async () => {
  const declared = new Response('{}', {
    status: 200,
    headers: { 'content-length': String(3 * 1024 * 1024) },
  });
  assert.deepEqual(await code(select('q', { version: '1', fetchImpl: async () => declared })), [
    'too_large',
    200,
    null,
  ]);
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(256 * 1024));
      if (pulled > 100) controller.close();
    },
  });
  assert.deepEqual(
    await code(
      select('q', { version: '1', fetchImpl: async () => new Response(stream, { status: 200 }) }),
    ),
    ['too_large', 200, null],
  );
  assert.ok(pulled <= 10, `${pulled} chunks read`);
});

test('the whole exchange is bounded in time, the body included (timers given)', async () => {
  const { timers, advance, pending } = createFakeClock(0);
  // No answer at all.
  const silent = code(
    select('q', {
      version: '1',
      timers,
      timeoutMs: 15000,
      fetchImpl: (url, init) =>
        new Promise((resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    }),
  );
  await advance(15000);
  assert.deepEqual(await silent, ['timeout', null, null]);
  // Headers, then a body that stalls.
  const stall = code(
    select('q', {
      version: '1',
      timers,
      timeoutMs: 15000,
      fetchImpl: async (url, init) => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"head":'));
            init.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        });
        return new Response(body, { status: 200 });
      },
    }),
  );
  await advance(15000);
  assert.deepEqual(await stall, ['timeout', 200, null]);
  assert.equal(pending.size, 0, 'no timer left');
});

test('Retry-After: seconds, or a date against the Date header only', () => {
  assert.equal(retryAfterSeconds('60', null), 60);
  assert.equal(retryAfterSeconds('', null), null);
  assert.equal(retryAfterSeconds('soon', null), null);
  assert.equal(retryAfterSeconds('Wed, 11 Nov 2026 10:10:00 GMT', null), null);
  assert.equal(
    retryAfterSeconds('Wed, 11 Nov 2026 09:00:00 GMT', 'Wed, 11 Nov 2026 10:00:00 GMT'),
    0,
  );
});

test('queries hold only checked values: integers, and search texts without quote nor backslash', () => {
  for (const [m, y] of [
    ['351', 2026],
    [351.5, 2026],
    [351, '2026'],
    [0, 2026],
    [351, NaN],
  ]) {
    assert.throws(() => tariffQuery(m, y), TypeError);
  }
  assert.deepEqual(searchText(' 3011 '), { postalCode: '3011' });
  assert.deepEqual(searchText('  Le   Mont-sur-Lausanne '), { name: 'le mont-sur-lausanne' });
  assert.deepEqual(searchText("Val-d'Illiez"), { name: "val-d'illiez" });
  assert.deepEqual(searchText('Zürich'), { name: 'zürich' });
  for (const bad of [
    'a',
    'x'.repeat(61),
    'Bern"',
    'Bern\\',
    'Bern"} } DROP',
    'Ber\u0000n',
    12,
    null,
    '<x>',
    'a;b',
  ]) {
    assert.equal(searchText(bad), null, String(bad));
  }
  assert.match(
    searchQuery({ name: 'bern' }, 2026, 10),
    /CONTAINS\(LCASE\(STR\(\?name\)\), "bern"\)/,
  );
  assert.match(searchQuery({ postalCode: '3011' }, 2026, 10), /schema:postalCode "3011"/);
  assert.throws(() => searchQuery({ name: 'Bern"' }, 2026, 10), TypeError);
  assert.throws(
    () => searchQuery({ name: 'BERN' }, 2026, 10),
    TypeError,
    'only the normalized text',
  );
  assert.throws(() => searchQuery({ postalCode: '30' }, 2026, 10), TypeError);
  assert.throws(() => searchQuery({ name: 'bern' }, 2026, 500), TypeError);
});
