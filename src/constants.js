// -----------------------------------------------------------------------------
// Constants: the LINDAS endpoint of the ElCom data, the pacing of the
// requests, the bounds of the answers and of /data, the keys of the manifest.
// -----------------------------------------------------------------------------

/** The public SPARQL endpoint of LINDAS, the linked data service of the Swiss federal administration. */
export const LINDAS_URL = 'https://lindas.admin.ch/query';
/** The named graph of the ElCom electricity tariffs. */
export const ELCOM_GRAPH = 'https://lindas.admin.ch/elcom/electricityprice';
/** The cube (its metadata carries `schema:dateModified`). */
export const ELCOM_CUBE = 'https://energy.ld.admin.ch/elcom/electricityprice';
export const ELCOM_NS = 'https://energy.ld.admin.ch/elcom/electricityprice/';
export const MUNICIPALITY_NS = 'https://ld.admin.ch/municipality/';

export const USER_AGENT_BASE = 'gladys-elcom';
export const REPO_URL = 'https://github.com/LM1LC3N7/gladys-elcom';

/** The first year of the ElCom data. */
export const FIRST_YEAR = 2011;
/** ElCom publishes the tariffs of the next year in early September: never asked before the 1st. */
export const NEXT_YEAR_FROM_MONTH = 9;

/** The consumption profiles of ElCom: households H1-H8, businesses C1-C7. */
export const CATEGORIES = [
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'H7',
  'H8',
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
  'C6',
  'C7',
];
export const PRODUCTS = ['standard', 'cheapest'];
export const VAT_MODES = ['included', 'excluded'];

/**
 * The Swiss standard VAT rate by year (the ElCom tariffs are published
 * without VAT): 8.0 % 2011-2017, 7.7 % 2018-2023, 8.1 % from 2024.
 */
export function vatRate(year) {
  if (year >= 2024) return 0.081;
  if (year >= 2018) return 0.077;
  return 0.08;
}

/** The manifest keys. */
export const TEMPLATE_KEY = 'elcom-municipality';
export const ACTIONS = {
  check: 'check_contracts',
  find: 'find_municipality',
};

// --- Pacing ------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** One request to LINDAS at a time, and at least this long between two starts. */
export const REQUEST_GAP = 2 * SECOND;
/** One request: the whole exchange, body included. */
export const REQUEST_TIMEOUT = 15 * SECOND;
/** A larger answer is cut before it is read whole (a commune has a few hundred rows). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** At most this many rows read from one answer. */
export const MAX_ROWS = 2000;

/** After a failure (network, 429, 5xx, unreadable answer): a pause doubled from 1 min to 6 h. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** No tariff for a municipality and a year: asked again a week later at the soonest. */
export const MISS_RETRY = 7 * DAY;

/** A tariff already read is read again one day later at the soonest, whatever the reason. */
export const REREAD_MIN = DAY;
/**
 * A tariff of this year or the next is read again when ElCom changed its
 * data after it was read (the date of the cube, asked once a day), and, once
 * a week at most, when a contract finds no tariff in it (an operator, a
 * profile or a product missing: a partial publication). The button "Check
 * my contracts" reads them again, once an hour at most.
 */
// 23 h, not 24: the daily refresh never finds it a moment too early and skips a day.
export const CUBE_CHECK = 23 * HOUR;
export const PROBLEM_REREAD = 7 * DAY;
export const BUTTON_REREAD = HOUR;

/** The contracts are read again, and the tariffs they need fetched, once a day. */
export const REFRESH_INTERVAL = DAY;
/** Reading the contracts failed: tried again from 1 min, doubled up to 1 h. */
export const CONTRACTS_RETRY_MIN = MINUTE;
export const CONTRACTS_RETRY_MAX = HOUR;

/** The core waits 30 s for the delegated pricing: every fetch fits in this budget. */
export const PRICE_BUDGET = 25 * SECOND;
/** And 5 s for the current price. */
export const CURRENT_BUDGET = 3 * SECOND;
/** The actions answer under their 30 s timeout. */
export const ACTION_BUDGET = 25 * SECOND;

/** /data unreadable: read again on its own timer. */
export const STORE_RETRY = 10 * SECOND;
/** A first read of /data longer than this: taken as unreadable (read again later). */
export const STORE_LOAD_TIMEOUT = 5 * SECOND;
/** At most this many (municipality, year) tariffs kept, the least recently used dropped first. */
export const MAX_ENTRIES = 40;
/** At most this many "no tariff" marks kept. */
export const MAX_MISSES = 200;

/** The answers of a search kept this long in memory (a new click never asks again sooner). */
export const SEARCH_CACHE = HOUR;
export const MAX_SEARCH_RESULTS = 10;
