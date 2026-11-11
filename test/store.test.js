// -----------------------------------------------------------------------------
// /data (src/store.js): missing, read and unreadable told apart, written
// through a temporary file, one save after the other; and a hostile file read
// back by the app reaches no prototype.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STATE_BYTES, StoreError, createFileStore } from '../src/store.js';
import { createMemoryStore, setup } from './helpers/world.js';

function dir(t) {
  const d = mkdtempSync(join(tmpdir(), 'elcom-store-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('missing = empty; written then read back; one save after the other', async (t) => {
  const file = join(dir(t), 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(await store.load(), {});
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 }), store.save({ a: 3 })]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 3 });
  assert.deepEqual(await store.load(), { a: 3 });
});

test('unreadable is never empty: not JSON, not an object, too large, a directory', async (t) => {
  const d = dir(t);
  const cases = {
    'garbage.json': '{nope',
    'array.json': '[1]',
    'null.json': 'null',
    'big.json': `{"x":"${'a'.repeat(MAX_STATE_BYTES)}"}`,
  };
  for (const [name, content] of Object.entries(cases)) {
    writeFileSync(join(d, name), content);
    await assert.rejects(createFileStore(join(d, name)).load(), StoreError, name);
  }
  await assert.rejects(createFileStore(d).load(), StoreError, 'a directory');
});

test('a hostile /data reaches no prototype and gives no tariff, miss nor pause it should not', async () => {
  const raw = JSON.parse(`{
    "__proto__": { "polluted": true },
    "entries": [{ "__proto__": { "polluted": true }, "municipality": 351, "year": 2026 }, "x", null],
    "misses": { "__proto__": 1, "constructor": 2, "351:2026": "soon", "1:20260": 5, "2:2026": 1e30 },
    "pause": { "until": "never", "code": "x" },
    "failures": 1e9
  }`);
  const w = await setup({ store: createMemoryStore(raw), contracts: [] });
  await w.app.start();
  assert.equal({}.polluted, undefined);
  assert.equal(w.app.entries.size, 0);
  assert.deepEqual(
    [...w.app.misses.keys()],
    ['2:2026'],
    'a miss from the future waits a week from now',
  );
  assert.ok(w.app.misses.get('2:2026').due - w.fake.clock.now <= 7 * 24 * 3600_000);
  assert.equal(w.app.pause, null);
  assert.ok(w.app.failures <= 20);
  await w.app.stop();
});
