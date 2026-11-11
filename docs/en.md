# ElCom Swiss electricity tariffs

Prices your electricity consumption in Gladys at the tariff the Federal Electricity Commission (ElCom) publishes
for your Swiss municipality: energy, grid usage, municipal charges, the federal grid surcharge and metering, in
CHF, with or without VAT. The data is the ElCom open data served by LINDAS, the linked data service of the Swiss
federal administration: no account, no key.

Unofficial integration, not affiliated with ElCom nor with the Swiss federal administration. Checked against the
live ElCom data (Bern, Lausanne, a municipality with five grid operators), never tested inside a real Gladys
energy contract.

## What ElCom publishes, and what it does not

For each municipality, grid operator, year and consumption profile, ElCom publishes the **yearly average price of
a kWh** (Rp./kWh, without VAT) for a standard product and for the cheapest product of the operator. It publishes
**no peak / off-peak (HT/NT) split and no time windows**: a double tariff shows only as its average over the
profile. The integration therefore prices every kWh of a calendar year (Europe/Zurich time) at that average. The
yearly fees (metering, basic fees) are already spread on the kWh by ElCom; nothing is added on top.

The consumption profiles (ElCom categories):

| Profile | Typical consumer                                      |
| ------- | ----------------------------------------------------- |
| H1      | 2-room flat, 1,600 kWh/year                           |
| H2      | 4-room flat, 2,500 kWh/year                           |
| H3      | 4-room flat with electric boiler, 4,500 kWh/year      |
| H4      | 5-room flat, 4,500 kWh/year (default)                 |
| H5      | 5-room house, 7,500 kWh/year                          |
| H6      | 5-room house with electric heating, 25,000 kWh/year   |
| H7      | 5-room house with heat pump, 13,000 kWh/year          |
| H8      | Large, highly electrified condominium, 7,500 kWh/year |
| C1-C7   | Businesses, from under 8 kW to 1,630 kW               |

## Setting up

1. Install the integration: nothing to configure.
2. In the integration page, click **Find my municipality**, type its name (or a 4-digit postal code): the button
   gives its municipality number (BFS) and the grid operators that serve it this year.
3. In the energy settings of Gladys, create a contract on your electricity meter with the template **Swiss
   municipality tariff (ElCom)** and fill in:
   - **Municipality number (BFS)**, e.g. 351 for Bern;
   - **Grid operator number**, only when several operators serve the municipality (empty otherwise);
   - **Consumption profile** (H4 by default), **Product** (`standard` or `cheapest`) and **VAT** (`included`
     adds the Swiss standard rate of the year: 8.1 % since 2024, 7.7 % from 2018 to 2023, 8.0 % before).
4. Click **Check my contracts**: it shows the price of the year of each contract, or what is missing.

The connection status of the integration sums up the contracts (price of the year, date of the ElCom data) or the
problem to fix (several operators and none chosen, an operator that does not serve the municipality, a profile or
a product the operator does not have, a municipality ElCom has no tariff for).

## How often the data is read

ElCom publishes the tariffs once a year (the next year in early September). The integration keeps what it read in
its `/data` volume and:

- reads the tariffs of a municipality for a year **once** and keeps them (40 municipality-years at most, the least
  recently used dropped first);
- asks for the next year from 1 September only;
- when ElCom has no tariff for a municipality and a year, asks again a week later at the soonest;
- sends one request at a time, two seconds apart at least, with its own User-Agent;
- after a failure (no answer, timeout, rate limit, server error, unreadable answer), pauses every request for
  1 minute, doubled at each new failure up to 6 hours (a `Retry-After` from the server is honoured, within 6 hours);
- keeps these dates across a restart.

A correction ElCom makes after the integration read a year is therefore not picked up.

## Pricing and Gladys

The template is "delegated": Gladys sends the half hours of a billing period, the integration answers one cost per
half hour (with its components). When the tariff of a year is not available (not published yet, municipality
unknown, LINDAS paused), the integration answers an error: Gladys stores no cost for these half hours (never a
zero) and asks again at its next run. The current price shown on the dashboard is the price of this year; from
September, the price from 1 January is shown too once read.

## Limits

- No peak / off-peak split (see above); a dynamic tariff is priced at its published average.
- Municipality numbers change when municipalities merge: a year before the merger has its tariffs under the old
  number. A contract spanning the change gets an error for the years the number does not exist.
- A price above 10 CHF/kWh in the data is ignored (the bound of Gladys).

## Data and credits

Source: Federal Electricity Commission ElCom, electricity tariffs per grid operator and municipality, served by
LINDAS (`lindas.admin.ch`), terms of use "Open use". See also the official site
[strompreis.elcom.admin.ch](https://www.strompreis.elcom.admin.ch/).
