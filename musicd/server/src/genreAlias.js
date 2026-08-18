/**
 * Genre normalisation — folds language variants and common spelling drift
 * into a single canonical English label.
 *
 * Tags in the wild are messy: "Electronique" (French), "Électronique" (with
 * accent), "electronic" (lowercase), "Electronica", "Hip-Hop" vs "Hip Hop"
 * vs "Rap", and so on. Without normalisation the Genres screen ends up with
 * dozens of near-duplicate cards.
 *
 * Strategy: lowercase + strip diacritics + trim, then map through an alias
 * table to a canonical Title-Case label. Anything not in the table keeps its
 * original casing (so we don't accidentally munge unfamiliar genres).
 *
 * The aliases here cover French equivalents the user explicitly asked for
 * plus a small handful of common English spelling variants. It's deliberately
 * conservative — we only fold genres that mean the same thing, never things
 * that are merely related (e.g. House → Electronic would be wrong because
 * users expect those to remain distinct).
 */

// Strip diacritics: NFD then drop combining marks. Works for most Latin scripts.
function fold(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// alias key: folded form → canonical Title-Case display label
// Add new entries lower-case and unaccented.
const ALIAS = {
  // Electronic family — fold French and common variants
  'electronique':   'Electronic',
  'electronica':    'Electronic',
  'electronic':     'Electronic',

  // Rock — fold French
  'rock alternatif': 'Alternative Rock',
  'alternatif':      'Alternative',

  // Classical — French & Italian
  'classique':       'Classical',
  'musique classique':'Classical',

  // Jazz — French keeps the same root, occasional accents
  'jazz':            'Jazz',

  // Pop — same in French
  'pop':             'Pop',

  // Hip-hop variants
  'hip-hop':         'Hip-Hop',
  'hip hop':         'Hip-Hop',
  'rap':             'Hip-Hop',
  'rap francais':    'Hip-Hop',
  'rap français':    'Hip-Hop',

  // Folk / Country — French uses the English word
  'folk':            'Folk',
  'country':         'Country',
  'musique du monde':'World',
  'world music':     'World',
  'world':           'World',

  // Soundtrack / Score
  'bande originale': 'Soundtrack',
  'b.o.':            'Soundtrack',
  'soundtrack':      'Soundtrack',
  'score':           'Soundtrack',

  // Children's / variety
  'enfants':         'Children',
  'jeunesse':        'Children',
  'children':        'Children',
  'kids':            'Children',

  // Reggae — French keeps the same word
  'reggae':          'Reggae',

  // Metal variants — broad fold
  'heavy metal':     'Metal',
  'metal':           'Metal',

  // Blues / soul / funk
  'blues':           'Blues',
  'soul':            'Soul',
  'funk':            'Funk',
  'r&b':             'R&B',
  'rnb':             'R&B',

  // House / techno: kept distinct from Electronic intentionally
  'house':           'House',
  'tech house':      'House',
  'techno':          'Techno',
  'minimal':         'Techno',

  // Spoken word / podcast
  'spoken word':     'Spoken Word',
  'parole':          'Spoken Word',
  'podcast':         'Spoken Word',
};

/**
 * Normalise one raw genre tag to a canonical display label.
 * Returns null/undefined unchanged so callers can filter empties.
 */
function normaliseGenre(raw) {
  if (!raw) return raw;
  const key = fold(raw);
  if (ALIAS[key]) return ALIAS[key];
  // No alias hit — preserve the user's original casing so unfamiliar genres
  // (e.g. "Synthwave", "Vaporwave", regional labels) aren't munged.
  return String(raw).trim();
}

/**
 * Given a canonical genre label (e.g. "Electronic"), return every raw alias
 * key (lower-case, no diacritics) that maps to it. Used by the /albums
 * filter so clicking "Electronic" also surfaces albums tagged "Electronique"
 * or "Electronica".
 *
 * Always includes the canonical itself so if a tag was already stored as
 * "Electronic" it still matches.
 */
function reverseAliases(canonical) {
  if (!canonical) return [];
  const out = new Set();
  out.add(fold(canonical));
  for (const [k, v] of Object.entries(ALIAS)) {
    if (v === canonical) out.add(k);
  }
  return Array.from(out);
}

module.exports = { normaliseGenre, reverseAliases, fold };
