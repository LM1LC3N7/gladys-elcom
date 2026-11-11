// -----------------------------------------------------------------------------
// The SDK handlers, registered BEFORE connect() (index.js) and by the tests on
// the SDK's fake Gladys: every one delegates to the app (src/app.js).
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger = app.logger) {
  // Energy contracts: delegated pricing.
  gladys.onEnergyPrice((request) => app.energyPrice(request));
  gladys.onEnergyCurrent((request) => app.energyCurrent(request));

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.check, () => app.checkContracts());
  gladys.onAction(ACTIONS.find, (fields) => app.findMunicipality(fields));

  // Connection lifecycle.
  gladys.on('connected', () => {
    app.start().catch((err) => logger.error('Start failed', err));
  });
  gladys.on('disconnected', () => app.disconnected());
}
