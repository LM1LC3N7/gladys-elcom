# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It is a `provider` (no device) declaring one **delegated energy contract template**: the core sends the
30-minute intervals of a contract, the integration prices them at the electricity tariff the Swiss Federal
Electricity Commission (ElCom) publishes for the municipality, grid operator, consumption profile and product of
the contract, per Zurich calendar year. The tariffs come from LINDAS (`lindas.admin.ch`, SPARQL, open data without
key). Unofficial: not affiliated with ElCom.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/devices.test.js          # one file
node --test --test-name-pattern "plug"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only
src/handlers.js                   the SDK handlers (energy price, current price, buttons, connection)
src/app.js                        ElcomApp: cache, reading rules, pauses, /data, pricing, status, buttons
src/lindas.js                     the SPARQL queries and the one HTTP access (bounded in size and time)
src/tariffs.js                    rows, inputs, the row of a contract, unit price, interval costs, Zurich year (pure)
src/store.js                      /data (missing / read / unreadable told apart)
src/i18n.js                       status and button texts (en/fr)
src/constants.js                  endpoint, pacing, bounds, manifest keys
gladys-assistant-integration.json manifest: provider, actions, energy_contracts template
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys and a scripted LINDAS
scripts/                          cover.png generator, mutation check of the guards (mutants.json)
```

## Rules of this integration

- Never ask LINDAS more often than the source changes: a (municipality, year) once, the next year from
  1 September, a miss after 7 days, one request at a time 2 s apart, any failure pauses everything (1 min doubled
  to 6 h). Every path goes through `ElcomApp.ensure()` / `request()`: never call `select()` elsewhere.
- Never a zero cost for an unknown price: throw, the core retries.
- ElCom publishes no peak / off-peak split: never invent one.
- An unreadable `/data` is never written over.
- Run `memcap node scripts/mutants.mjs` after touching a guard: no mutant may survive.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0; `energy_contracts`: 5.2.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
