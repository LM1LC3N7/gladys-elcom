// -----------------------------------------------------------------------------
// The ElCom tariffs (src/tariffs.js): the rows read from LINDAS (a real answer
// recorded on 2026-11-11 for Bern), the contract inputs, the row of a
// contract, the price of a kWh, the costs of the intervals, the Zurich year.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vatRate } from '../src/constants.js';
import {
  InputError,
  decimal,
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
} from '../src/tariffs.js';
import { binding, intervals, operatorRows } from './helpers/world.js';

const bern = JSON.parse(readFileSync(new URL('./fixtures/bern-351-2026.json', import.meta.url)));

test('a real LINDAS answer (Bern 2026): one operator, 28 rows, the date of the data', () => {
  const entry = parseTariffRows(bern.results.bindings, 351, 2026);
  assert.deepEqual(entry.operators, [{ id: 519, name: 'Energie Wasser Bern' }]);
  assert.equal(entry.rows.length, 28);
  assert.equal(entry.modified, '2026-11-10');
  const h4 = entry.rows.find((r) => r.category === 'H4' && r.product === 'standard');
  assert.equal(h4.total, 33.26);
  assert.equal(h4.metering, 2.08);
  assert.equal(h4.name, 'ewb.Natur.STROM Einfachtarif');
  const { row } = pickRow(entry, parseInputs({ municipality: 351 }));
  assert.equal(row, h4);
  const price = unitPrice(row, 2026, 'excluded');
  assert.ok(Math.abs(price.perKwh - 0.3326) < 1e-12);
  const sum = Object.values(price.parts).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - price.perKwh) < 1e-12, 'the parts add up');
});

test('rows: unreadable ones dropped, duplicates kept once, numbers strict', () => {
  const rows = [
    binding(),
    binding(), // duplicate
    binding({ category: 'H9' }),
    binding({ product: 'luxury' }),
    binding({ category: 'H5', total: '' }),
    binding({ category: 'H6', total: 'NaN' }),
    binding({ category: 'H7', total: -1 }),
    binding({ category: 'H8', total: 1000.5 }),
    binding({ category: 'C1', meteringrate: '' }),
    { operator: { type: 'literal', value: 'x' } },
    null,
    binding({ category: 'C2', energyname: 'A\u0000B\nC', operatorName: null, operator: 77 }),
  ];
  const entry = parseTariffRows(rows, 351, 2026);
  assert.deepEqual(
    entry.rows.map((r) => r.category),
    ['H4', 'C1', 'C2'],
  );
  assert.equal(entry.rows[1].metering, null);
  assert.equal(entry.rows[2].name, 'A B C');
  assert.deepEqual(entry.operators, [
    { id: 77, name: null },
    { id: 519, name: 'Energie Wasser Bern' },
  ]);
  assert.equal(decimal({ value: '12.5' }), 12.5);
  for (const v of ['', ' ', '1e3', '0x10', 'Infinity', '1.2.3', null]) {
    assert.equal(decimal({ value: v }), null, String(v));
  }
  assert.equal(parseTariffRows('nope', 1, 2026).rows.length, 0);
});

test('a prototype key in an answer pollutes nothing', () => {
  const evil = JSON.parse(
    '[{"__proto__": {"polluted": 1}, "operator": {"type":"uri","value":"x"}}, {"constructor": {"prototype": {"polluted": 1}}}]',
  );
  parseTariffRows(evil, 1, 2026);
  assert.equal({}.polluted, undefined);
});

test('inputs: required municipality, strict integers, choices from the lists, defaults', () => {
  assert.deepEqual(parseInputs({ municipality: 351 }), {
    municipality: 351,
    operator: null,
    category: 'H4',
    product: 'standard',
    vat: 'included',
  });
  assert.deepEqual(
    parseInputs({
      municipality: '4324',
      operator: '87',
      category: 'H7',
      product: 'cheapest',
      vat: 'excluded',
    }),
    { municipality: 4324, operator: 87, category: 'H7', product: 'cheapest', vat: 'excluded' },
  );
  assert.equal(parseInputs({ municipality: 1, operator: 0 }).operator, null);
  assert.equal(parseInputs({ municipality: 1, operator: '' }).operator, null);
  for (const bad of [
    {},
    null,
    { municipality: '' },
    { municipality: 0 },
    { municipality: 10000 },
    { municipality: 3.5 },
    { municipality: '35a' },
    { municipality: '-3' },
    { municipality: 351, operator: 2.5 },
    { municipality: 351, operator: -1 },
    { municipality: 351, category: 'H9' },
    { municipality: 351, product: 'premium' },
    { municipality: 351, vat: 'yes' },
  ]) {
    assert.throws(() => parseInputs(bad), InputError, JSON.stringify(bad));
  }
});

test('the row of a contract: one operator by itself, several need a choice', () => {
  const one = parseTariffRows(operatorRows(), 351, 2026);
  assert.equal(pickRow(one, parseInputs({ municipality: 351 })).operator.id, 519);
  assert.equal(pickRow(one, parseInputs({ municipality: 351, operator: 519 })).operator.id, 519);
  assert.equal(
    pickRow(one, parseInputs({ municipality: 351, operator: 5 })).problem,
    'operator_unknown',
  );
  assert.equal(
    pickRow(one, parseInputs({ municipality: 351, category: 'C7' })).problem,
    'category_missing',
  );
  const two = parseTariffRows(
    [...operatorRows(), ...operatorRows({ operator: 5, operatorName: 'AEW', total: 25 })],
    4324,
    2026,
  );
  const needed = pickRow(two, parseInputs({ municipality: 4324 }));
  assert.equal(needed.problem, 'operator_needed');
  assert.deepEqual(
    needed.operators.map((o) => o.id),
    [5, 519],
  );
  assert.equal(pickRow(two, parseInputs({ municipality: 4324, operator: 5 })).row.total, 25);
  const standardOnly = parseTariffRows([binding()], 5586, 2026);
  assert.equal(
    pickRow(standardOnly, parseInputs({ municipality: 5586, product: 'cheapest' })).problem,
    'product_missing',
  );
});

test('the price of a kWh: CHF, the VAT of the year, parts that add up', () => {
  const row = parseTariffRows([binding()], 351, 2026).rows[0];
  const incl = unitPrice(row, 2026, 'included');
  assert.ok(Math.abs(incl.perKwh - 0.3326 * 1.081) < 1e-12);
  assert.ok(Math.abs(incl.parts.vat - 0.3326 * 0.081) < 1e-12);
  assert.deepEqual(Object.keys(incl.parts), [
    'energy',
    'grid',
    'charges',
    'aid_fee',
    'metering',
    'vat',
  ]);
  const sum = Object.values(incl.parts).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - incl.perKwh) < 1e-12);
  assert.equal(vatRate(2017), 0.08);
  assert.equal(vatRate(2018), 0.077);
  assert.equal(vatRate(2023), 0.077);
  assert.equal(vatRate(2024), 0.081);
  assert.ok(Math.abs(unitPrice(row, 2020, 'included').parts.vat - 0.3326 * 0.077) < 1e-12);
  // Components that do not add up to the total: the total only, never a made-up split.
  const odd = parseTariffRows([binding({ total: 40 })], 351, 2026).rows[0];
  assert.deepEqual(Object.keys(unitPrice(odd, 2026, 'excluded').parts), ['tariff']);
  assert.equal(unitPrice(odd, 2026, 'excluded').perKwh, 0.4);
  // A missing component: the total only.
  const gap = parseTariffRows([binding({ gridusage: '' })], 351, 2026).rows[0];
  assert.deepEqual(Object.keys(unitPrice(gap, 2026, 'excluded').parts), ['tariff']);
  // Before 2026, no metering component: the four others add up.
  const old = parseTariffRows([binding({ total: 31.18, meteringrate: null })], 351, 2025).rows[0];
  assert.deepEqual(Object.keys(unitPrice(old, 2025, 'excluded').parts), [
    'energy',
    'grid',
    'charges',
    'aid_fee',
  ]);
  assert.equal(tariffLabel(row, 2026), 'ewb.Natur.STROM Einfachtarif 2026');
  assert.equal(tariffLabel({ ...row, name: null }, 2026), 'ElCom H4 2026');
  assert.ok(tariffLabel({ ...row, name: 'x'.repeat(80) }, 2026).length <= 64);
});

test('the Zurich year: changes at local midnight, the same as Intl every hour around each New Year', () => {
  assert.equal(zurichYear(Date.parse('2026-12-31T22:59:59.999Z')), 2026);
  assert.equal(zurichYear(Date.parse('2026-12-31T23:00:00Z')), 2027);
  assert.equal(yearStart(2027), Date.parse('2026-12-31T23:00:00Z'));
  const fmt = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Zurich', year: 'numeric' });
  for (let year = 2011; year <= 2035; year += 1) {
    for (let h = -30; h <= 30; h += 0.5) {
      const t = Date.UTC(year, 0, 1) + h * 3600_000;
      assert.equal(zurichYear(t), Number(fmt.format(t)), new Date(t).toISOString());
    }
  }
  assert.deepEqual(zurichDate(Date.parse('2026-08-31T22:00:00Z')), {
    year: 2026,
    month: 9,
    day: 1,
  });
  assert.deepEqual(zurichDate(Date.parse('2026-08-31T21:59:00Z')), {
    year: 2026,
    month: 8,
    day: 31,
  });
});

test('costs: one per interval, the price of its year, the clock changes priced, no gap', () => {
  const prices = new Map([
    [2025, { perKwh: 0.3, parts: { tariff: 0.3 }, label: 'A 2025' }],
    [2026, { perKwh: 0.4, parts: { energy: 0.1, grid: 0.3 }, label: 'A 2026' }],
  ]);
  // New Year: 22:30 UTC is still 2025 in Zurich, 23:00 UTC is 2026.
  const newYear = intervals('2025-12-31T22:30:00Z', 2, 2);
  const costs = intervalCosts(newYear, prices);
  assert.deepEqual(
    costs.map((c) => [c.starts_at, c.cost, c.label]),
    [
      ['2025-12-31T22:30:00.000Z', 0.6, 'A 2025'],
      ['2025-12-31T23:00:00.000Z', 0.8, 'A 2026'],
    ],
  );
  assert.deepEqual(costs[1].components, { energy: 0.2, grid: 0.6 });
  assert.deepEqual(yearsOf(newYear), [2025, 2026]);
  // The two clock changes of 2026 (46 and 50 half hours on the local day).
  for (const [from, count] of [
    ['2026-03-28T23:00:00Z', 46],
    ['2026-10-24T22:00:00Z', 50],
  ]) {
    const day = intervals(from, count);
    const out = intervalCosts(day, prices);
    assert.equal(out.length, count);
    assert.ok(out.every((c) => c.cost === 0.4));
  }
  assert.throws(
    () => intervalCosts(intervals('2024-06-01T00:00:00Z', 1), prices),
    /No ElCom tariff for 2024/,
  );
  assert.throws(() => intervalCosts([{ starts_at: 'nope', kwh: 1 }], prices), /Invalid interval/);
  const reset = intervalCosts([{ starts_at: '2026-01-05T00:00:00Z', kwh: -1 }], prices)[0];
  assert.equal(reset.cost, 0);
  assert.ok(
    Object.values(reset.components).every((v) => v === 0),
    'no negative component',
  );
  assert.throws(
    () => intervalCosts([{ starts_at: '2026-01-05T00:00:00Z', kwh: NaN }], prices),
    /Invalid/,
  );
  assert.equal(intervalCosts([{ starts_at: '2026-01-05T00:00:00Z', kwh: 0 }], prices)[0].cost, 0);
});

test('a total of 0 is "no tariff", never a price: the real Lausanne C5/C6 2026 and a whole operator in 2021', () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
  const lausanne = parseTariffRows(read('lausanne-5586-2026.json').results.bindings, 5586, 2026);
  assert.equal(lausanne.empty, 2);
  assert.equal(lausanne.bad, 0);
  assert.ok(!lausanne.rows.some((r) => r.total <= 0));
  assert.equal(
    pickRow(lausanne, parseInputs({ municipality: 5586, category: 'C5' })).problem,
    'category_missing',
  );
  assert.equal(
    pickRow(lausanne, parseInputs({ municipality: 5586, category: 'C6' })).problem,
    'category_missing',
  );
  assert.ok(pickRow(lausanne, parseInputs({ municipality: 5586, category: 'H4' })).row.total > 0);
  // 2021, commune 4229: the standard product of every profile but one is "KEIN NAME", 0.
  const old = parseTariffRows(read('commune-4229-2021.json').results.bindings, 4229, 2021);
  assert.ok(old.empty >= 14);
  const h4 = pickRow(old, parseInputs({ municipality: 4229, category: 'H4' }));
  assert.ok(h4.problem, 'no price of 0 for H4 standard');
  assert.ok(
    old.operators.some((o) => o.id === 95),
    'the operator without tariff is still listed',
  );
  // Every row at 0: no tariff at all (not an unreadable answer).
  const none = parseTariffRows(
    [binding({ total: '0.000' }), binding({ category: 'H1', total: '0' })],
    1,
    2026,
  );
  assert.deepEqual([none.rows.length, none.empty, none.bad], [0, 2, 0]);
  // The bound of the core, VAT included: 925 Rp. at most.
  assert.equal(parseTariffRows([binding({ total: 925 })], 1, 2026).rows.length, 1);
  assert.equal(parseTariffRows([binding({ total: 925.5 })], 1, 2026).rows.length, 0);
});

test('an input refused is said in English and French', () => {
  try {
    parseInputs({ municipality: 'x' });
    assert.fail('no throw');
  } catch (err) {
    assert.ok(err instanceof InputError);
    assert.match(err.texts.en, /municipality number \(BFS\) must be a whole number/);
    assert.match(err.texts.fr, /numéro de commune \(OFS\) doit être un nombre entier/);
  }
});
