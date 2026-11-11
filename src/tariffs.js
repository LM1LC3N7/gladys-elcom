// -----------------------------------------------------------------------------
// The ElCom tariffs (pure): the rows of one municipality and year read from
// LINDAS, the contract inputs, the tariff a contract applies, the cost of the
// 30-minute intervals the core sends.
//
// What ElCom publishes is, per municipality, operator, year, consumption
// profile (H1-H8, C1-C7) and product (standard / cheapest), the AVERAGE price
// of a kWh over the year for that profile, in Rp./kWh without VAT, split into
// energy, grid usage, municipal charges, the federal grid surcharge and (from
// 2026) metering. No peak / off-peak split, no time window: every kWh of a
// calendar year (Europe/Zurich) is priced at that average.
// -----------------------------------------------------------------------------

import { CATEGORIES, ELCOM_NS, FIRST_YEAR, PRODUCTS, VAT_MODES, vatRate } from './constants.js';

/** A contract input refused: `message` in English, `texts` in English and French. */
export class InputError extends Error {
  constructor(en, fr = en) {
    super(en);
    this.texts = { en, fr };
    this.name = 'InputError';
  }
}

/** A strict decimal literal (never '' nor 'NaN'), or null. */
export function decimal(binding) {
  const text = binding?.value;
  if (typeof text !== 'string' || !/^-?\d{1,6}(\.\d{1,9})?$/.test(text.trim())) return null;
  return Number(text.trim());
}

/** A short source text: no control character, bounded. */
export function cleanText(binding, max = 64) {
  const text = binding?.value;
  if (typeof text !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

const suffix = (binding, prefix, pattern) => {
  const iri = binding?.type === 'uri' ? binding.value : null;
  if (typeof iri !== 'string' || !iri.startsWith(prefix)) return null;
  const rest = iri.slice(prefix.length);
  return pattern.test(rest) ? rest : null;
};

/**
 * A price in Rp./kWh: above 0 (ElCom writes 0 for "no tariff" for a profile or
 * a product, named "Aucun", "kein Tarif vorhanden"...) and at most 925 (10 CHF
 * per kWh, the bound of the core, once the VAT is added).
 */
export const MAX_RAPPEN = 925;
const rappen = (n) => (n !== null && n > 0 && n <= MAX_RAPPEN ? n : null);
/** A component may be negative (a discount), never beyond ±1000. */
const part = (n) => (n !== null && Math.abs(n) <= 1000 ? n : null);

/**
 * The tariffs of one municipality and year from the SPARQL bindings:
 * `{ municipality, year, modified, operators: [{ id, name }], rows, empty, bad }`.
 * A row with a total of 0 or less is "no tariff" for its profile and product:
 * dropped, counted in `empty`, its operator still listed. A row without a
 * readable operator, category, product or total is dropped and counted in `bad`.
 */
export function parseTariffRows(bindings, municipality, year) {
  const rows = [];
  const operators = new Map();
  let modified = null;
  const seen = new Set();
  let empty = 0;
  let bad = 0;
  for (const b of Array.isArray(bindings) ? bindings : []) {
    if (!b || typeof b !== 'object') {
      bad += 1;
      continue;
    }
    const operator = suffix(b.operator, `${ELCOM_NS}operator/`, /^\d{1,9}$/);
    const category = suffix(b.category, `${ELCOM_NS}category/`, /^[HC]\d$/);
    const product = suffix(b.product, `${ELCOM_NS}product/`, /^[a-z]{1,16}$/);
    const value = decimal(b.total);
    const total = rappen(value);
    if (!operator || !CATEGORIES.includes(category) || !PRODUCTS.includes(product)) {
      bad += 1;
      continue;
    }
    if (total === null) {
      if (value !== null && value <= 0) {
        // No tariff for this profile and product: never a price of 0.
        empty += 1;
        const id = Number(operator);
        if (!operators.get(id)) operators.set(id, cleanText(b.operatorName, 80));
      } else {
        bad += 1;
      }
      continue;
    }
    const key = `${operator}|${category}|${product}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const date = cleanText(b.modified, 32);
    if (date && /^\d{4}-\d{2}-\d{2}/.test(date) && (!modified || date > modified)) {
      modified = date.slice(0, 10);
    }
    const id = Number(operator);
    if (!operators.has(id)) operators.set(id, cleanText(b.operatorName, 80));
    else if (!operators.get(id)) operators.set(id, cleanText(b.operatorName, 80));
    rows.push({
      operator: id,
      category,
      product,
      total,
      energy: part(decimal(b.energy)),
      grid: part(decimal(b.gridusage)),
      charges: part(decimal(b.charge)),
      aid_fee: part(decimal(b.aidfee)),
      metering: part(decimal(b.meteringrate)),
      name: cleanText(b.energyname, 48),
    });
  }
  return {
    municipality,
    year,
    modified,
    operators: [...operators].map(([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id),
    rows,
    empty,
    bad,
  };
}

// --- Time (Europe/Zurich) --------------------------------------------------------

const zurich = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

/** The local date in Zurich of an instant: `{ year, month, day }`. */
export function zurichDate(ms) {
  const parts = Object.fromEntries(
    zurich.formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * The instant a calendar year starts in Zurich: January is always on CET
 * (UTC+1), so 1 January 00:00 local is 31 December 23:00 UTC.
 */
export function yearStart(year) {
  return Date.UTC(year, 0, 1) - 60 * 60 * 1000;
}

/** The Zurich calendar year of an instant (exact: the year changes in winter time). */
export function zurichYear(ms) {
  return new Date(ms + 60 * 60 * 1000).getUTCFullYear();
}

// --- Contract inputs --------------------------------------------------------------

/** An integer input: a number or a string of digits; '' / null / undefined = absent. */
function integerInput(value, [en, fr], { required, min, max }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new InputError(`The ${en} is missing`, `Le ${fr} manque`);
    return null;
  }
  const n = typeof value === 'string' && /^\s*\d{1,9}\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new InputError(
      `The ${en} must be a whole number from ${min} to ${max}`,
      `Le ${fr} doit être un nombre entier de ${min} à ${max}`,
    );
  }
  return n;
}

/**
 * The inputs of a contract: `{ municipality, operator, category, product, vat }`.
 * An operator 0 means "the only one of the municipality". Throws an InputError.
 */
export function parseInputs(inputs) {
  const raw = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs : {};
  const municipality = integerInput(
    raw.municipality,
    ['municipality number (BFS)', 'numéro de commune (OFS)'],
    {
      required: true,
      min: 1,
      max: 9999,
    },
  );
  const operator =
    integerInput(raw.operator, ['grid operator number', 'numéro du gestionnaire de réseau'], {
      required: false,
      min: 0,
      max: 999999,
    }) || null;
  const pick = (value, list, fallback, [en, fr]) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (!list.includes(value)) {
      throw new InputError(
        `The ${en} must be one of ${list.join(', ')}`,
        `Le choix « ${fr} » doit être l'un de ${list.join(', ')}`,
      );
    }
    return value;
  };
  return {
    municipality,
    operator,
    category: pick(raw.category, CATEGORIES, 'H4', ['category', 'profil']),
    product: pick(raw.product, PRODUCTS, 'standard', ['product', 'produit']),
    vat: pick(raw.vat, VAT_MODES, 'included', ['VAT choice', 'TVA']),
  };
}

// --- The tariff of a contract ----------------------------------------------------------

/**
 * The row of a contract in the tariffs of its municipality and year:
 * `{ row, operator }`, or `{ problem, operators? }` with problem in
 * 'operator_needed' (several operators, none chosen), 'operator_unknown',
 * 'category_missing', 'product_missing'.
 */
export function pickRow(entry, inputs) {
  const operators = entry.operators;
  let operator;
  if (inputs.operator) {
    operator = operators.find((o) => o.id === inputs.operator);
    if (!operator) return { problem: 'operator_unknown', operators };
  } else if (operators.length === 1) {
    [operator] = operators;
  } else {
    return { problem: 'operator_needed', operators };
  }
  const ofOperator = entry.rows.filter((r) => r.operator === operator.id);
  const ofCategory = ofOperator.filter((r) => r.category === inputs.category);
  if (ofCategory.length === 0) return { problem: 'category_missing', operators };
  const row = ofCategory.find((r) => r.product === inputs.product);
  if (!row) return { problem: 'product_missing', operators };
  return { row, operator };
}

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * The price of a kWh in CHF: `{ perKwh, parts }`, `parts` the components per
 * kWh (energy, grid, charges, aid_fee, metering, vat) adding up to perKwh, or
 * `{ tariff, vat }` when the published components do not add up to the total.
 */
export function unitPrice(row, year, vatMode) {
  const excl = row.total / 100;
  const vat = vatMode === 'included' ? round(excl * vatRate(year), 9) : 0;
  const keys = ['energy', 'grid', 'charges', 'aid_fee', 'metering'];
  const known = keys.filter((k) => row[k] !== null);
  const sum = known.reduce((s, k) => s + row[k], 0);
  let parts;
  if (
    ['energy', 'grid', 'charges', 'aid_fee'].every((k) => row[k] !== null) &&
    Math.abs(sum - row.total) <= 0.011
  ) {
    parts = Object.fromEntries(known.map((k) => [k, row[k] / 100]));
    // The rounding of the source goes into the energy, so the parts add up exactly.
    parts.energy += excl - known.reduce((s, k) => s + parts[k], 0);
  } else {
    parts = { tariff: excl };
  }
  if (vat) parts.vat = vat;
  return { perKwh: excl + vat, parts };
}

/** The label of a tariff (≤ 64 characters). */
export function tariffLabel(row, year) {
  return `${row.name ?? `ElCom ${row.category}`} ${year}`.slice(0, 64);
}

/**
 * The costs of the 30-minute intervals: `prices` maps a year to
 * `{ perKwh, parts, label }`. An interval of a year without a price throws:
 * the core then stores no cost (never a silent zero) and asks again later.
 * A consumption of 0 or less (a meter reset) costs 0: one odd interval never
 * blocks the pricing of the whole period.
 */
export function intervalCosts(intervals, prices) {
  return intervals.map(({ starts_at, kwh }) => {
    const t = Date.parse(starts_at);
    if (!Number.isFinite(t) || typeof kwh !== 'number' || !Number.isFinite(kwh)) {
      throw new Error(`Invalid interval ${String(starts_at).slice(0, 40)}`);
    }
    const year = zurichYear(t);
    const price = prices.get(year);
    if (!price) throw new Error(`No ElCom tariff for ${year}`);
    const used = Math.max(0, kwh);
    const components = Object.fromEntries(
      Object.entries(price.parts).map(([k, v]) => [k, used * v]),
    );
    const cost = Object.values(components).reduce((s, v) => s + v, 0);
    return { starts_at, cost: Math.max(0, cost), components, label: price.label };
  });
}

/** The years of the intervals (Zurich calendar years). */
export function yearsOf(intervals) {
  const years = new Set();
  for (const { starts_at } of intervals) {
    const t = Date.parse(starts_at);
    if (!Number.isFinite(t)) throw new Error(`Invalid interval ${String(starts_at).slice(0, 40)}`);
    years.add(zurichYear(t));
  }
  return [...years].sort((a, b) => a - b);
}

export { FIRST_YEAR };
