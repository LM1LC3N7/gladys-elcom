// -----------------------------------------------------------------------------
// The texts users read (connection status, buttons, errors of the delegated
// pricing), in English and French. Bounded: a status never grows with the
// number of contracts past STATUS_MAX characters.
// -----------------------------------------------------------------------------

export const STATUS_MAX = 900;

const zurichTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** An instant as `YYYY-MM-DD HH:MM` in Zurich. */
export function when(ms) {
  if (!Number.isFinite(ms)) return '?';
  const p = Object.fromEntries(
    zurichTime.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const both = (en, fr) => ({ en, fr });

/** Rp./kWh with two decimals. */
const rp = (chf) => (chf * 100).toFixed(2);

export function operatorList(operators) {
  return operators
    .slice(0, 6)
    .map((o) => (o.name ? `${o.id} (${o.name})` : String(o.id)))
    .join(', ');
}

/** Why a tariff is not there (a reason of src/app.js). */
export function reasonText(reason, { municipality, year }) {
  switch (reason?.code) {
    case 'out_of_range':
      return both(
        `ElCom has no tariff for ${year} (published from 2011, the next year from September)`,
        `ElCom n'a pas de tarif pour ${year} (publiés depuis 2011, l'année suivante dès septembre)`,
      );
    case 'not_yet':
      return both(
        `the ${year} tariffs are published in September`,
        `les tarifs ${year} sont publiés en septembre`,
      );
    case 'missing':
      return both(
        `ElCom has no ${year} tariff for municipality ${municipality}; asked again after ${when(reason.until)}`,
        `ElCom n'a pas de tarif ${year} pour la commune ${municipality} ; redemandé après le ${when(reason.until)}`,
      );
    case 'unreadable':
      return both(
        `the ElCom answer for municipality ${municipality} in ${year} could not be read; asked again after ${when(reason.until)}`,
        `la réponse ElCom pour la commune ${municipality} en ${year} est illisible ; redemandée après le ${when(reason.until)}`,
      );
    case 'paused':
      return both(
        `the ElCom data (LINDAS) did not answer; next try after ${when(reason.until)}`,
        `les données ElCom (LINDAS) n'ont pas répondu ; nouvel essai après le ${when(reason.until)}`,
      );
    case 'timeout':
      return both(
        `the ${year} tariffs of municipality ${municipality} are still being fetched`,
        `les tarifs ${year} de la commune ${municipality} sont en cours de lecture`,
      );
    case 'unread':
      return both(
        `the ${year} tariffs of municipality ${municipality} are not read yet (asked when Gladys prices it)`,
        `les tarifs ${year} de la commune ${municipality} ne sont pas encore lus (demandés quand Gladys les tarifie)`,
      );
    case 'stopped':
      return both('the integration is stopping', "l'intégration s'arrête");
    default:
      return both('the ElCom data is not available', 'les données ElCom ne sont pas disponibles');
  }
}

/** Why a contract has no tariff in the data of its municipality (src/tariffs.js pickRow). */
export function problemText(pick, inputs, year) {
  const list = operatorList(pick.operators ?? []);
  switch (pick.problem) {
    case 'operator_needed':
      return both(
        `municipality ${inputs.municipality} has several grid operators in ${year}: set the operator number of the contract (${list})`,
        `la commune ${inputs.municipality} a plusieurs gestionnaires de réseau en ${year} : indiquez le numéro du gestionnaire dans le contrat (${list})`,
      );
    case 'operator_unknown':
      return both(
        `operator ${inputs.operator} does not serve municipality ${inputs.municipality} in ${year} (${list})`,
        `le gestionnaire ${inputs.operator} ne dessert pas la commune ${inputs.municipality} en ${year} (${list})`,
      );
    case 'category_missing':
      return both(
        `ElCom publishes no ${inputs.category} tariff for municipality ${inputs.municipality} in ${year}: choose another profile`,
        `l'ElCom ne publie pas de tarif ${inputs.category} pour la commune ${inputs.municipality} en ${year} : choisissez un autre profil`,
      );
    default:
      return both(
        `no "${inputs.product}" product for ${inputs.category} in municipality ${inputs.municipality} in ${year}: choose "standard"`,
        `pas de produit « ${inputs.product} » pour ${inputs.category} dans la commune ${inputs.municipality} en ${year} : choisissez « standard »`,
      );
  }
}

/** One contract with its price of the year. */
export function priceText({ inputs, year, operator, price, modified }) {
  const op = operator.name ?? `operator ${operator.id}`;
  const vat =
    inputs.vat === 'included'
      ? both('VAT included', 'TVA incluse')
      : both('without VAT', 'hors TVA');
  const data = modified
    ? both(`, ElCom data of ${modified}`, `, données ElCom du ${modified}`)
    : both('', '');
  return both(
    `municipality ${inputs.municipality}, ${op}, ${inputs.category} ${inputs.product} ${year}: ${rp(price.perKwh)} Rp./kWh ${vat.en}${data.en}`,
    `commune ${inputs.municipality}, ${op}, ${inputs.category} ${inputs.product} ${year} : ${rp(price.perKwh).replace('.', ',')} ct./kWh ${vat.fr}${data.fr}`,
  );
}

export const TEXTS = {
  noContract: both(
    'No energy contract uses the "Swiss municipality tariff (ElCom)" template yet: create one in the energy settings of Gladys.',
    "Aucun contrat d'énergie n'utilise encore le modèle « Tarif de la commune suisse (ElCom) » : créez-en un dans les réglages d'énergie de Gladys.",
  ),
  contractsUnread: both(
    'The energy contracts could not be read from Gladys; tried again later.',
    "Les contrats d'énergie n'ont pas pu être lus depuis Gladys ; nouvel essai plus tard.",
  ),
  contract: (n) => both(`Contract ${n}: `, `Contrat ${n} : `),
  more: (n) => both(` (+${n} more)`, ` (+${n} autres)`),
  badSearch: both(
    'Type 2 to 60 letters of a municipality name, or a 4-digit postal code.',
    "Tapez de 2 à 60 lettres d'un nom de commune, ou un numéro postal (ex. 1003).",
  ),
  storeBroken: both(
    'The /data volume of the integration cannot be read: ElCom is only asked for the prices Gladys needs until it is readable again.',
    "Le volume /data de l'intégration est illisible : l'ElCom n'est interrogée que pour les prix demandés par Gladys jusqu'à ce qu'il redevienne lisible.",
  ),
  searchLate: both(
    'The search took too long; try again in a minute.',
    'La recherche a pris trop de temps ; réessayez dans une minute.',
  ),
  noMatch: both('No Swiss municipality matches.', 'Aucune commune suisse ne correspond.'),
  match: (m, year) =>
    m.operators.length
      ? both(
          `${m.name}: municipality number ${m.id}; grid operators ${year}: ${operatorList(m.operators)}`,
          `${m.name} : numéro de commune ${m.id} ; gestionnaires ${year} : ${operatorList(m.operators)}`,
        )
      : both(
          `${m.name}: municipality number ${m.id}; no ElCom tariff in ${year} (merged into another municipality? search its postal code)`,
          `${m.name} : numéro de commune ${m.id} ; pas de tarif ElCom en ${year} (fusionnée ? cherchez son numéro postal)`,
        ),
};

/** Join multi-language parts and bound the result. */
export function join(parts, separator = ' ') {
  const out = {};
  for (const lang of ['en', 'fr']) {
    const text = parts.map((p) => p[lang]).join(separator);
    out[lang] = text.length > STATUS_MAX ? `${text.slice(0, STATUS_MAX - 1)}…` : text;
  }
  return out;
}
