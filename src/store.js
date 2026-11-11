// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// tariffs already fetched (with the date ElCom last changed its data), the
// municipalities and years ElCom had no tariff for and when that was asked,
// and the pause after a failure of LINDAS, so that a restart never asks again
// sooner than these rules. A small JSON file, written through a temporary
// file and a rename, one save after the other.
//
// `load()` tells three cases apart: the file is missing (an empty state),
// read (its content), or unreadable (it throws: the caller never takes it for
// an empty state, and never writes over it). Taken from gladys-national-rail.
// -----------------------------------------------------------------------------

import { readFile, rename, stat, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/elcom-state.json';
/** A larger file is not ours: unreadable. */
export const MAX_STATE_BYTES = 2 * 1024 * 1024;

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
  }
}

export function createFileStore(file = DEFAULT_STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  };
  return {
    async load() {
      let info;
      try {
        info = await stat(file);
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return {};
        }
        throw new StoreError(`stat: ${err?.code ?? 'error'}`);
      }
      if (info.size > MAX_STATE_BYTES) {
        throw new StoreError('too large');
      }
      let data;
      try {
        data = JSON.parse(await readFile(file, 'utf8'));
      } catch (err) {
        throw new StoreError(`read: ${err?.code ?? 'not JSON'}`);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new StoreError('not an object');
      }
      return data;
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/**
 * The same in memory (tests): `failLoad` makes the next loads throw,
 * `failSave` the saves, `gate` (a promise) holds the loads until it settles.
 */
export function createMemoryStore(initial) {
  let data = initial === undefined ? undefined : structuredClone(initial);
  const store = {
    failLoad: 0,
    failSave: false,
    gate: null,
    saves: 0,
    loads: 0,
    async load() {
      store.loads += 1;
      if (store.gate) {
        await store.gate;
      }
      if (store.failLoad > 0) {
        store.failLoad -= 1;
        throw new StoreError('unreadable (test)');
      }
      return data === undefined ? {} : structuredClone(data);
    },
    async save(next) {
      store.saves += 1;
      if (store.failSave) {
        throw new StoreError('unwritable (test)');
      }
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
  return store;
}
