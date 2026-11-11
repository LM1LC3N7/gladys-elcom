# TODO

## Decisions

- 2026-11-11: **delegated template, not 20 rules templates.** About 600 grid operators and 2,100 municipalities:
  one template with the municipality number (BFS) as input, the operator when several serve it, the profile, the
  product and the VAT; the price is computed by the integration.
- 2026-11-11: **no peak / off-peak (HT/NT) split.** Checked in the LINDAS cube (dimensions listed on 2026-11-11):
  ElCom publishes per municipality, operator, year, profile and product the yearly average of a kWh and its
  components (energy, grid, charges, aid fee, metering from 2026), no HT/NT price nor time window. `highestrate` /
  `lowestrate` (2027) are the bounds of a dynamic grid tariff, not HT/NT. Every kWh of a calendar year is priced at
  the average; inventing HT/NT windows was refused.
- 2026-11-11: the year of a half hour is its Zurich calendar year (1 January 00:00 CET = 31 December 23:00 UTC),
  whatever the contract timezone: Swiss tariffs change on 1 January.
- 2026-11-11: VAT by year: 8.0 % to 2017, 7.7 % 2018-2023, 8.1 % from 2024 (ElCom figures are without VAT);
  `included` by default. A future rate change needs a new version.
- 2026-11-11: components sent to the core: energy, grid, charges, aid_fee, metering, vat when the published parts add
  up to the total (within 0.011 Rp., the rounding goes into energy); `tariff` + `vat` otherwise. No `fixed`
  component: ElCom spreads the yearly fees on the kWh.
- 2026-11-11: a missing `cheapest` product (Lausanne publishes none; `cheapest` exists since 2018 for about a
  third of the rows) is an error naming `standard`, never a silent fallback. **Question for Louis**: take
  `standard` when the operator publishes a single product?
- 2026-11-11: reading rules: a (municipality, year) read once and kept; the next year from 1 September; a miss
  again after 7 days; one request at a time, 2 s apart; any failure pauses everything from 1 min doubled to 6 h
  (Retry-After honoured, capped); all kept in `/data` (unreadable `/data` never written over, read again every
  10 s, one read at a time).
- 2026-11-12 (review r1 I2): **revalidation.** The `schema:dateModified` of the cube asked once a day (only with
  contracts): a tariff of this year or the next older than it is read again (once per change, a day apart at
  least). A tariff in which a contract finds nothing (operator, profile, product) read again once a week. The
  button "Check my contracts" reads again what was read, or missing, more than an hour ago. A read again that
  finds nothing keeps what was read. Half hours already priced are not repriced (no core path for a delegated
  contract: `requestEnergyRecalculation` only covers calendars).
- 2026-11-12 (review r1 I1): a total of 0 or less is ElCom's "no tariff" ("Aucun", "kein Tarif vorhanden"):
  dropped, the contract gets "no tariff for this profile/product", never a price of 0. Totals above 925 Rp.
  refused (10 CHF/kWh of the core once the VAT is added).
- 2026-11-12 (review r1 M6): an answer none of whose rows is readable waits a week for that municipality and
  year only, never a pause of every request.
- 2026-11-12 (review r1 M4): while `/data` is unreadable, only the pricing the core asks for reads LINDAS (no
  daily refresh, no button, no search).
- 2026-11-12 (review r1 M5): a half hour of 0 kWh or less costs 0 (never a failure of the whole period).
- 2026-11-11: `gladys_version` `>=5.2.0`, not `>=5.1.0`: the store validator asks 5.2.0 for `energy_contracts`
  (`MANIFEST_FIELD_MIN_GLADYS_VERSION`), as gladys-octopus-energy.
- 2026-11-11: type `provider` (no device), categories `energy` only; no `keywords` nor `countries` in the manifest
  (store rule): the country is CH.
- 2026-11-11: version 0.1.0 by hand (package.json, lock, manifest, `docker_image`).
- 2026-11-11: reference visualize-admin/electricity-prices-switzerland (BSD-3-Clause, 5a14e4e of 2026-11-10): read
  for the cube IRIs and dimension names only; no code ported.

## Next

- Watch a real Gladys contract priced end to end (catch-up of a billing period over New Year).
- When ElCom publishes HT/NT prices or windows, a template with time windows.
- Reprice the half hours already priced after a correction, if the core gets a path for delegated contracts.
- Follow municipality mergers (the old number for the years before).
