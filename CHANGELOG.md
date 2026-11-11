# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-11

### Added

- First version: a delegated energy contract template "Swiss municipality tariff (ElCom)" pricing every half hour
  at the ElCom tariff of the municipality, grid operator, consumption profile and product of the contract, with or
  without VAT, per Zurich calendar year.
- The current price and the price from 1 January for the dashboard.
- Buttons "Find my municipality" (municipality number and grid operators from a name or a postal code) and "Check
  my contracts".
- Tariffs read once per municipality and year from LINDAS and kept in `/data`; the next year from 1 September; a
  missing tariff asked again a week later; any failure pauses the requests from 1 min, doubled up to 6 h.
- Corrections and late publications picked up: the date of the ElCom data asked once a day, a tariff of this
  year or the next read again when it changed, or once a week when a contract finds nothing in it; the button
  "Check my contracts" reads them again (once an hour at most).
- A price of 0 in the ElCom data ("Aucun", "kein Tarif vorhanden") is "no tariff", never a cost of 0.

[Unreleased]: https://github.com/LM1LC3N7/gladys-elcom/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-elcom/releases/tag/v0.1.1
