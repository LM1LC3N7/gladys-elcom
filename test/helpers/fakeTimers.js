// -----------------------------------------------------------------------------
// Fake timers on a virtual clock: nothing fires by itself; `advance(ms)` moves
// the clock and fires every timer due on the way, in order, WITHOUT awaiting
// what it returns (as Node does), letting pending work settle (a few turns of
// the event loop) between two. A timer that waits for another timer never
// deadlocks the clock.
// -----------------------------------------------------------------------------

const settle = async (turns = 30) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  async function advance(ms) {
    const target = clock.now + ms;
    // A timer that re-arms itself at the same instant would spin forever: a
    // test fails on it instead of hanging.
    let sameInstant = 0;
    let lastAt = null;
    for (let i = 0; ; i += 1) {
      // Thousands of timers in one advance: a timer storm (a mutant re-arming
      // every millisecond), failed rather than spun through.
      if (i > 20_000) {
        throw new Error('fake clock: more than 20000 timers in one advance');
      }
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) {
          next = { id, timer };
        }
      }
      if (!next) {
        break;
      }
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      sameInstant = clock.now === lastAt ? sameInstant + 1 : 0;
      lastAt = clock.now;
      if (sameInstant > 1000) {
        throw new Error('fake clock: more than 1000 timers at the same instant');
      }
      Promise.resolve()
        .then(() => next.timer.fn())
        .catch(() => {});
      await settle();
    }
    clock.now = Math.max(clock.now, target);
  }
  return { clock, timers, pending, advance, settle };
}
