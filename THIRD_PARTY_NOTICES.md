# Third-party notices

## Code

The code of this integration is original (Apache-2.0, see `LICENSE`). It ports no third-party code.

- The names of the LINDAS cube, graph and dimensions (`https://energy.ld.admin.ch/elcom/electricityprice`,
  `municipality`, `operator`, `period`, `category`, `product`, `total`, `energy`, `gridusage`, `charge`, `aidfee`,
  `meteringrate`…) were read in **electricity-prices-switzerland** (visualize-admin, the official site
  strompreis.elcom.admin.ch), BSD-3-Clause:

  > Copyright 2020 – present, Federal Electricity Commission ElCom
  >
  > Redistribution and use in source and binary forms, with or without modification, are permitted provided that
  > the following conditions are met: 1. Redistributions of source code must retain the above copyright notice,
  > this list of conditions and the following disclaimer. 2. Redistributions in binary form must reproduce the
  > above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other
  > materials provided with the distribution. 3. Neither the name of the copyright holder nor the names of its
  > contributors may be used to endorse or promote products derived from this software without specific prior
  > written permission.
  >
  > THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
  > WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
  > PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY
  > DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
  > PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
  > CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
  > OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
  > DAMAGE.

- The consumption profiles H1-H8 / C1-C7 (yearly kWh, typical consumers) come from the ElCom documentation of the
  same site.
- Runtime dependency: `@gladysassistant/integration-sdk` (Apache-2.0) and its dependency `ws` (MIT).

## Data

Electricity tariffs per grid operator and municipality: **Federal Electricity Commission ElCom**, published as open
data through LINDAS (`lindas.admin.ch`, Swiss Federal Archives), terms of use **Open use**
(`https://ld.admin.ch/vocabulary/TermsOfUse/Open-Use`). Credited in the documentation as "Source: ElCom". This
integration is not affiliated with ElCom nor with the Swiss federal administration.
