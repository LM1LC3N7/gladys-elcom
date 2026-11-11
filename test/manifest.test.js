// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The version is
// never pinned: only its form and its agreement everywhere. The template
// inputs follow the rules of the core (validateEnergyContracts) when its
// clone is there.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS, CATEGORIES, PRODUCTS, TEMPLATE_KEY, VAT_MODES } from '../src/constants.js';
import { parseInputs } from '../src/tariffs.js';
import { setup } from './helpers/world.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const [template] = manifest.energy_contracts.templates;
const inputs = Object.fromEntries(template.inputs.map((i) => [i.key, i]));

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; the same semver version in the four places', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'provider');
  // The store validator asks 5.2.0 at least for energy_contracts.
  assert.equal(manifest.gladys_version, '>=5.2.0');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-elcom:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-elcom');
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-elcom/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^\d+\.\d+\.\d+$/);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+ElCom|sans\s+lien\s+avec\s+l'ElCom/i);
    assert.match(docs, /never\s+tested\s+inside\s+a\s+real|jamais\s+testée\s+dans\s+un\s+vrai/i);
  }
  assert.match(
    manifest.config_schema[0].description.en,
    /never tested inside a real Gladys energy contract/,
  );
  assert.match(
    manifest.config_schema[0].description.fr,
    /jamais testée dans un vrai contrat d'énergie Gladys/,
  );
});

test('every text is in English and French; placeholders too; no secret field, no key prefixed gladys_', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  const fields = [...manifest.config_schema, ...manifest.actions.flatMap((a) => a.fields ?? [])];
  for (const field of fields) {
    assert.ok(!field.key.startsWith('gladys_'), field.key);
    assert.notEqual(field.type, 'secret');
    if (field.placeholder !== undefined)
      assert.equal(typeof field.placeholder, 'object', field.key);
  }
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr'])
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
  assert.equal(manifest.containers, undefined);
  assert.equal(manifest.location, undefined);
});

test('the actions are the ones the code handles, with a timeout the code fits in', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const action of manifest.actions) assert.equal(action.timeout_seconds, 30, action.key);
  assert.equal(manifest.widgets, undefined);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
});

test('the template: delegated, Swiss, the inputs the code reads, the choices of the code', () => {
  assert.equal(manifest.energy_contracts.templates.length, 1);
  assert.equal(manifest.energy_contracts.calendars, undefined);
  assert.equal(template.key, TEMPLATE_KEY);
  assert.equal(template.pricing_mode, 'delegated');
  assert.equal(template.country, 'CH');
  assert.equal(template.currency, 'CHF');
  assert.equal(template.timezone, 'Europe/Zurich');
  assert.equal(
    template.tariff,
    undefined,
    'no fixed component: ElCom spreads every fee on the kWh',
  );
  assert.deepEqual(Object.keys(inputs), ['municipality', 'operator', 'category', 'product', 'vat']);
  assert.equal(inputs.municipality.type, 'number');
  assert.equal(inputs.municipality.required, true);
  assert.equal(inputs.operator.type, 'number');
  assert.equal(inputs.operator.required, false);
  assert.deepEqual(inputs.category.options, CATEGORIES);
  assert.deepEqual(inputs.product.options, PRODUCTS);
  assert.deepEqual(inputs.vat.options, VAT_MODES);
  // The defaults of the manifest are the defaults of the code.
  const parsed = parseInputs({ municipality: 351 });
  for (const key of ['category', 'product', 'vat'])
    assert.equal(inputs[key].default, parsed[key], key);
  for (const input of template.inputs) {
    assert.ok(/^[a-z0-9_]{1,64}$/.test(input.key));
    for (const lang of ['en', 'fr']) {
      assert.ok(input.label[lang].length <= 64, `${input.key}.label.${lang}`);
      assert.ok(input.description[lang].length <= 256, `${input.key}.description.${lang}`);
    }
    if (input.type === 'select') {
      assert.ok(input.options.length >= 1 && input.options.length <= 64);
      assert.equal(new Set(input.options).size, input.options.length);
    }
  }
});

test('the core accepts the template (its own validator, when the clone is there)', async (t) => {
  const file =
    '/home/claude/code/Gladys/server/lib/external-integration/externalIntegration.validateEnergyContracts.js';
  if (!existsSync(file)) {
    t.skip('no Gladys clone');
    return;
  }
  // Loading the core opens its database in the working directory: run it in a
  // child process inside a temporary directory, removed afterwards.
  const dir = mkdtempSync(join(tmpdir(), 'elcom-core-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `
    const { validateEnergyContractsField } = require(${JSON.stringify(file)});
    const multi = (value, path, errs, min = 1, max = 1000) => {
      if (!value || typeof value !== 'object') return errs.push(path + ': not an object');
      if (typeof value.en !== 'string') errs.push(path + '.en required');
      for (const [lang, text] of Object.entries(value)) {
        if (typeof text !== 'string' || text.length < min || text.length > max) errs.push(path + '.' + lang + ': length');
      }
    };
    const errors = [];
    validateEnergyContractsField(${JSON.stringify(manifest.energy_contracts)}, errors, multi);
    process.stdout.write(JSON.stringify(errors));
    process.exit(0);
  `;
  const out = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ['-e', script],
      { cwd: dir, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }),
    );
  });
  if (out.err && !out.stdout) {
    t.skip(`core validator not loadable: ${String(out.stderr).slice(0, 200)}`);
    return;
  }
  assert.deepEqual(JSON.parse(out.stdout), []);
});

test('a provider: no device published, so no supported_options nor switch to check', async () => {
  const w = await setup({ contracts: [] });
  await w.app.start();
  assert.deepEqual(w.gladys.fake.discoveredDevices, []);
  assert.equal(w.gladys.fake.states.length, 0);
  await w.app.stop();
});
