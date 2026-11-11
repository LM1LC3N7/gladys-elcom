# gladys-elcom

[Gladys Assistant](https://gladysassistant.com) external integration that prices an energy contract at the
electricity tariff the Swiss Federal Electricity Commission (ElCom) publishes for each municipality: a delegated
contract template (municipality number, grid operator, consumption profile H1-H8 / C1-C7, product, VAT), fed by the
ElCom open data of LINDAS (`lindas.admin.ch`, SPARQL, no key).

Unofficial, not affiliated with ElCom. Checked against the live ElCom data, never tested inside a real Gladys
energy contract.

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- ElCom publishes yearly averages per consumption profile, without peak / off-peak split: every kWh of a calendar
  year (Europe/Zurich) is priced at that average.
- Each (municipality, year) is read once and kept in `/data`, read again when ElCom changes its data (date of the
  cube, asked daily) or weekly when a contract finds nothing in it; the next year is asked from 1 September; a
  missing tariff is asked again a week later at the soonest; any failure pauses the requests (1 min doubled up to
  6 h).

## Development

```bash
npm install
npm test                 # node --test
npm run lint             # ESLint
npm run format:check     # Prettier
npm run mutants          # mutation check of the guards (memcap node scripts/mutants.mjs)
npm run cover            # regenerate cover.png
```

Licence: Apache-2.0 (see `LICENSE`); third-party notices in `THIRD_PARTY_NOTICES.md`.
